// 隊伍上限的靜態檢查（規格補充 2 第 10 條＋規格補充 3 第 3 條＋M5 補充）：依劇情順序追蹤「可能的隊伍狀態」。
//
// 模型（保守：只會多報、不會漏報，除了下面列出的兩個假設）：
// - 世界（world）＝{ 隊伍成員, 追蹤中的旗標, 本章已播過的對話 }。從新遊戲（只有主角、旗標全空）開始。
// - 章節依 manifest.chapters 的順序處理。每一章：
//   1. 上一章結束（chapter_end）時的每個世界，先跑上一章 end_screen.continue 的對話（這一章的開場）。
//   2. 本章的「自由入口對話」（地圖物件、觸發點、出口等引用到的，或沒有被任何接續引用的）可以以任意順序、
//      任意次數播放：對每個世界反覆套用，直到不再出現新的世界（不動點）。
//   3. 對話內部逐條路徑模擬：節點 effects → branches（依序比對）／choices（條件不是「一定不成立」的都可以選）；
//      對話結束後依序處理接續：battle（on_win.effects＋on_win.dialogue；可逃跑的遭遇也可能沒有接續）、
//      goto.dialogue、wake.dialogue、resolve_ending（每個結局對話）。接續的對話只從接續進入，所以順序是確定的。
//   4. 本章的世界在 chapter_end 那一刻記為「章末世界」，交給下一章。
// - 條件三值求值：追蹤中的旗標（只由對話／遭遇／道具效果 set_flag、clear_flag 設定的旗標，
//   而且被含 join／leave 的對話讀取）與 in_party 可以確定真假；其他條件一律「不確定」，兩條路都走。
// 假設（與規格補充 3 的既有假設相同性質）：
//   A. 前一章的入隊／離隊對話不會在之後的章節重播（以旗標守門）。
//   B. 本章含 join／leave 的自由入口對話（連同它的接續），在本章結束前至少播過一次（入隊、離隊都是主線節拍）。
//      章末世界只採計滿足 B 的世界；如果一個都沒有（例如本章沒有 chapter_end），改用本章所有可能的世界。
// 回傳最大的超員隊伍（成員 id 陣列，不含主角），沒有超員回 null。
import { HERO_ID, MAX_PARTY } from './stats.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v !== '';
const arr = (v) => (Array.isArray(v) ? v : []);
const MAX_WORLDS = 20000;

/** 對話的所有效果（節點與選項）。 */
const dialogueEffects = (dlg) => arr(dlg?.nodes).flatMap((n) => (isObj(n) ? [...arr(n.effects), ...arr(n.choices).flatMap((c) => (isObj(c) ? arr(c.effects) : []))] : [])).filter(isObj);

/** 條件裡 flag／not_flag 讀到的旗標。 */
function readFlags(cond, out) {
  if (!isObj(cond)) return;
  for (const [k, v] of Object.entries(cond)) {
    if ((k === 'flag' || k === 'not_flag') && isStr(v)) out.add(v);
    else if ((k === 'all' || k === 'any') && Array.isArray(v)) v.forEach((c) => readFlags(c, out));
    else if (k === 'not') readFlags(v, out);
  }
}

/** 物件裡所有字串值（地圖引用到哪些對話、遭遇）。 */
function collectStrings(v, out) {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => collectStrings(x, out));
}

export function partyOverflow(bundle) {
  const stories = arr(bundle.story).filter((s) => isObj(s) && isStr(s.id));
  const dialogues = new Map();
  const fileOf = new Map();
  for (const s of stories) for (const d of arr(s.dialogues)) if (isObj(d) && isStr(d.id) && !dialogues.has(d.id)) { dialogues.set(d.id, d); fileOf.set(d.id, s.id); }
  const encounters = new Map(arr(bundle.encounters).filter((e) => isObj(e) && isStr(e.id)).map((e) => [e.id, e]));
  const endingDialogues = stories.flatMap((s) => arr(s.endings)).map((e) => e?.dialogue).filter(isStr);

  // 只有 join 對象（不含主角）＋主角不超過上限時，不可能超員
  const members = new Set();
  const noteJoins = (effects) => { for (const e of arr(effects)) if (isObj(e) && isStr(e.join_party) && e.join_party !== HERO_ID) members.add(e.join_party); };
  for (const d of dialogues.values()) noteJoins(dialogueEffects(d));
  for (const e of encounters.values()) noteJoins(e.on_win?.effects);
  for (const it of arr(bundle.items)) noteJoins(it?.field_effects);
  if (members.size + 1 <= MAX_PARTY) return null;

  // ---- 單元：對話 d:<id>、遭遇 e:<id>（on_win）、道具 i:<id>（field_effects） ----
  const units = new Map();
  const chainOf = (effects) => {
    const out = [];
    for (const e of arr(effects)) {
      if (!isObj(e)) continue;
      if (isStr(e.battle)) out.push(`e:${e.battle}`);
      if (isObj(e.goto) && isStr(e.goto.dialogue)) out.push(`d:${e.goto.dialogue}`);
      if (isObj(e.wake) && isStr(e.wake.dialogue)) out.push(`d:${e.wake.dialogue}`);
      if (e.resolve_ending === true) out.push(...endingDialogues.map((x) => `d:${x}`));
    }
    return out;
  };
  for (const [id, d] of dialogues) units.set(`d:${id}`, { effects: dialogueEffects(d), next: chainOf(dialogueEffects(d)) });
  for (const [id, e] of encounters) {
    const effects = arr(e.on_win?.effects).filter(isObj);
    units.set(`e:${id}`, { effects, next: [...chainOf(effects), ...(isStr(e.on_win?.dialogue) ? [`d:${e.on_win.dialogue}`] : [])] });
  }
  for (const it of arr(bundle.items)) if (isObj(it) && isStr(it.id) && Array.isArray(it.field_effects)) units.set(`i:${it.id}`, { effects: it.field_effects.filter(isObj), next: chainOf(it.field_effects) });

  const closure = new Map();
  const closureOf = (u) => {
    if (closure.has(u)) return closure.get(u);
    const seen = new Set();
    const stack = [u];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x) || !units.has(x)) continue;
      seen.add(x);
      stack.push(...units.get(x).next);
    }
    closure.set(u, seen);
    return seen;
  };
  const hasParty = (u) => units.get(u)?.effects.some((e) => isStr(e.join_party) || isStr(e.leave_party));

  // 追蹤的旗標：含 join／leave 的對話讀到的旗標，排除引擎暗中設定的（lock 旗標、含冒號的 enter:／trade:／一次性觸發點）
  const lockFlags = new Set();
  for (const m of arr(bundle.maps)) for (const o of arr(m?.objects)) if (isStr(o?.lock?.flag)) lockFlags.add(o.lock.flag);
  const tracked = new Set();
  for (const [id, d] of dialogues) {
    if (!hasParty(`d:${id}`)) continue;
    for (const n of arr(d.nodes)) {
      for (const b of arr(n?.branches)) readFlags(b?.if, tracked);
      for (const c of arr(n?.choices)) readFlags(c?.if, tracked);
    }
  }
  for (const f of [...tracked]) if (f.includes(':') || lockFlags.has(f)) tracked.delete(f);
  const writesTracked = (u) => units.get(u)?.effects.some((e) => (isStr(e.set_flag) && tracked.has(e.set_flag)) || (isStr(e.clear_flag) && tracked.has(e.clear_flag)));
  const endsChapter = (u) => units.get(u)?.effects.some((e) => isStr(e.chapter_end));
  const relevant = (u) => [...closureOf(u)].some((x) => hasParty(x) || writesTracked(x) || endsChapter(x));
  const partyRelevant = (u) => [...closureOf(u)].some(hasParty);

  // 自由入口：地圖引用到的，或沒有被任何接續（goto／wake／on_win／結局／continue／manifest.start）引用的對話
  const mapRefs = new Set();
  collectStrings(arr(bundle.maps), mapRefs);
  const chained = new Set();
  for (const u of units.values()) for (const x of u.next) chained.add(x);
  for (const s of stories) if (isStr(s.end_screen?.continue?.dialogue)) chained.add(`d:${s.end_screen.continue.dialogue}`);
  for (const x of endingDialogues) chained.add(`d:${x}`);
  const startDlg = bundle.manifest?.start?.dialogue;
  if (isStr(startDlg)) chained.add(`d:${startDlg}`);
  const isFree = (u) => mapRefs.has(u.slice(2)) || !chained.has(u);
  // 每章都可能發生的：地圖直接引用的遭遇、道具
  const globalFree = [...units.keys()].filter((u) => ((u.startsWith('e:') && mapRefs.has(u.slice(2))) || u.startsWith('i:')) && relevant(u));

  // ---- 世界 ----
  const keyOf = (w) => `${w.party.join(',')}|${w.flags.join(',')}|${w.mask}`;
  const mk = (party, flags, mask) => ({ party: [...party].sort(), flags: [...flags].sort(), mask });
  let worst = null;
  const notePeak = (party) => {
    if (party.length + 1 > MAX_PARTY && (!worst || party.length > worst.length)) worst = [...party].sort();
  };

  /** 三值條件：true／false／null（不確定）。 */
  const ev = (c, w) => {
    if (!isObj(c)) return null;
    const keys = Object.keys(c);
    if (keys.length !== 1) return null;
    const [k] = keys;
    const v = c[k];
    switch (k) {
      case 'flag': return tracked.has(v) ? w.flags.includes(v) : null;
      case 'not_flag': return tracked.has(v) ? !w.flags.includes(v) : null;
      case 'in_party': return v === HERO_ID ? true : w.party.includes(v);
      case 'all': { const r = arr(v).map((x) => ev(x, w)); return r.includes(false) ? false : r.every((x) => x === true) ? true : null; }
      case 'any': { const r = arr(v).map((x) => ev(x, w)); return r.includes(true) ? true : r.every((x) => x === false) ? false : null; }
      case 'not': { const r = ev(v, w); return r === null ? null : !r; }
      default: return null;
    }
  };

  /** 套用效果：回傳 { w, pend（新增的接續）, ended }。 */
  const apply = (effects, w) => {
    const party = new Set(w.party);
    const flags = new Set(w.flags);
    const pend = [];
    let ended = false;
    for (const e of arr(effects)) {
      if (!isObj(e)) continue;
      if (isStr(e.join_party) && e.join_party !== HERO_ID) { party.add(e.join_party); notePeak([...party]); }
      if (isStr(e.leave_party)) party.delete(e.leave_party);
      if (isStr(e.set_flag) && tracked.has(e.set_flag)) flags.add(e.set_flag);
      if (isStr(e.clear_flag) && tracked.has(e.clear_flag)) flags.delete(e.clear_flag);
      if (isStr(e.chapter_end)) ended = true;
      pend.push(...chainOf([e]));
    }
    return { w: mk(party, flags, w.mask), pend, ended };
  };

  /**
   * 從世界 w 執行單元 u（含所有接續）。回傳 { ends: 世界[], exits: 世界[] }。
   * 狀態：{ at: 'u:<單元>' | 'v:<對話>:<頂點>', w, queue（之後要接續的單元）, ended }。
   */
  const run = (u, w0) => {
    const ends = new Map();
    const exits = new Map();
    const seen = new Set();
    const stack = [{ at: `u:${u}`, w: w0, queue: [], ended: false }];
    const finish = (st) => {
      if (st.ended) { exits.set(keyOf(st.w), st.w); return; }
      if (st.queue.length) { stack.push({ at: `u:${st.queue[0]}`, w: st.w, queue: st.queue.slice(1), ended: false }); return; }
      ends.set(keyOf(st.w), st.w);
    };
    while (stack.length) {
      const st = stack.pop();
      const sk = `${st.at}|${keyOf(st.w)}|${st.queue.join(',')}|${st.ended}`;
      if (seen.has(sk)) continue;
      seen.add(sk);
      if (seen.size > MAX_WORLDS * 10) throw new Error('隊伍上限檢查：狀態太多');
      if (st.at.startsWith('u:')) {
        const id = st.at.slice(2);
        if (id.startsWith('d:')) {
          const d = dialogues.get(id.slice(2));
          if (!d || !isStr(d.start)) { finish(st); continue; }
          stack.push({ ...st, at: `v:${d.id}:n:${d.start}` });
        } else if (id.startsWith('e:')) {
          const enc = encounters.get(id.slice(2));
          if (!enc) { finish(st); continue; }
          // 可逃跑：也可能沒有接續
          if (enc.can_flee === true) finish(st);
          const r = apply(enc.on_win?.effects, st.w);
          const more = [...r.pend, ...(isStr(enc.on_win?.dialogue) ? [`d:${enc.on_win.dialogue}`] : [])];
          finish({ ...st, w: r.w, queue: [...more, ...st.queue], ended: st.ended || r.ended });
        } else {
          const it = arr(bundle.items).find((x) => x?.id === id.slice(2));
          const r = apply(it?.field_effects, st.w);
          finish({ ...st, w: r.w, queue: [...r.pend, ...st.queue], ended: st.ended || r.ended });
        }
        continue;
      }
      // 對話頂點 v:<dlg>:n:<node> 或 v:<dlg>:c:<node>:<i>
      const [, dlgId, kind, nodeId, ci] = /^v:(.+?):(n|c):([^:]+)(?::(\d+))?$/.exec(st.at) ?? [];
      const d = dialogues.get(dlgId);
      const node = arr(d?.nodes).find((n) => isObj(n) && n.id === nodeId);
      if (!node) { finish(st); continue; }
      const goNext = (next, s) => {
        if (next === 'END' || !isStr(next)) finish(s);
        else stack.push({ ...s, at: `v:${dlgId}:n:${next}` });
      };
      if (kind === 'c') {
        const c = arr(node.choices)[Number(ci)];
        const r = apply(c?.effects, st.w);
        goNext(c?.next, { ...st, w: r.w, queue: [...r.pend, ...st.queue], ended: st.ended || r.ended });
        continue;
      }
      const r = apply(node.effects, st.w);
      const s = { ...st, w: r.w, queue: [...r.pend, ...st.queue], ended: st.ended || r.ended };
      if (Array.isArray(node.choices) && node.choices.length) {
        node.choices.forEach((c, i) => {
          if (isObj(c) && (c.if === undefined || ev(c.if, s.w) !== false)) stack.push({ ...s, at: `v:${dlgId}:c:${nodeId}:${i}` });
        });
        continue;
      }
      let fallthrough = true;
      for (const b of arr(node.branches)) {
        if (!isObj(b)) continue;
        const t = ev(b.if, s.w);
        if (t === false) continue;
        goNext(b.next, s);
        if (t === true) { fallthrough = false; break; }
      }
      if (fallthrough) goNext(node.next, s);
    }
    return { ends: [...ends.values()], exits: [...exits.values()] };
  };

  // ---- 章節 ----
  const order = Array.isArray(bundle.manifest?.chapters) ? bundle.manifest.chapters.filter((c) => stories.some((s) => s.id === c)) : [];
  for (const s of stories) if (!order.includes(s.id)) order.push(s.id);

  let carry = [mk([], [], 0)];
  let opening = isStr(startDlg) ? `d:${startDlg}` : null;
  for (const ch of order) {
    const free = [...units.keys()].filter((u) => u.startsWith('d:') && fileOf.get(u.slice(2)) === ch && isFree(u) && relevant(u));
    const required = free.filter(partyRelevant);
    const bit = new Map(required.map((u, i) => [u, 2 ** i]));
    const full = 2 ** required.length - 1;
    const all = new Map();
    const exits = new Map();
    const queue = [];
    const add = (w) => { const k = keyOf(w); if (!all.has(k)) { all.set(k, w); queue.push(w); } };
    const addExit = (w) => { if ((w.mask & full) === full) { const x = mk(w.party, w.flags, 0); exits.set(keyOf(x), x); } };
    for (const w of carry) {
      const start = mk(w.party, w.flags, 0);
      if (opening) { const r = run(opening, start); r.ends.forEach(add); r.exits.forEach(addExit); } else add(start);
    }
    while (queue.length) {
      if (all.size > MAX_WORLDS) throw new Error('隊伍上限檢查：可能的隊伍狀態太多');
      const w = queue.shift();
      for (const u of [...free, ...globalFree]) {
        const r = run(u, { ...w, mask: w.mask | (bit.get(u) ?? 0) });
        r.ends.forEach(add);
        r.exits.forEach(addExit);
      }
    }
    carry = exits.size ? [...exits.values()] : [...all.values()].map((w) => mk(w.party, w.flags, 0));
    const story = stories.find((s) => s.id === ch);
    opening = isStr(story?.end_screen?.continue?.dialogue) ? `d:${story.end_screen.continue.dialogue}` : null;
  }
  return worst;
}
