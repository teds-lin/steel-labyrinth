// 畫面層 M5（第一部完結）的純函式：把引擎的晉升、交換、結局結果整理成要顯示的文字。
// 不碰 Phaser，可以在 node 測試（tests/ui/m5-view.test.js）。規則一律交給 core，這裡只負責排版文字。
import { promotionStatus, resonanceTotal } from '../core/promotion.js';
import { availableTrades } from '../core/trade.js';
import { endingsOf } from '../core/ending.js';
import { END } from '../core/dialogue.js';
import { fill } from '../core/name.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const findById = (list, id) => arr(list).find((x) => isObj(x) && x.id === id);
const itemName = (data, id) => findById(data?.items, id)?.name ?? id;
const countOf = (state, id) => {
  const n = isObj(state?.items) && Object.hasOwn(state.items, id) ? state.items[id] : 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
};
const rankDef = (data, lineageId, rank) => arr(findById(data?.lineages, lineageId)?.ranks).find((r) => isObj(r) && r.rank === rank) ?? null;

/**
 * 探索標籤的顯示名稱（HUD、晉升演出、解鎖提示）：資料提供（lineages 的 rank.field_labels，例如 { "voice": "借聲" }），
 * 沒有提供就照標籤 id 顯示。
 */
export function fieldTagLabel(tag, data) {
  for (const lin of arr(data?.lineages)) {
    for (const r of arr(lin?.ranks)) {
      const labels = isObj(r?.field_labels) ? r.field_labels : null;
      if (labels && Object.hasOwn(labels, tag) && typeof labels[tag] === 'string' && labels[tag] !== '') return labels[tag];
    }
  }
  return String(tag);
}

// ---------- 晉升 ----------

/**
 * 選單「隊伍 → 晉升進度」：目前階位、下一階、材料 有／需要、共鳴 有／需要，以及排好的文字 lines。
 */
export function promotionProgress(state, data) {
  const lin = isObj(state?.lineage) ? state.lineage : null;
  const curDef = lin ? rankDef(data, lin.id, lin.rank) : null;
  const current = curDef ? { name: curDef.name, rank: lin.rank } : null;
  if (!current) {
    return { current: null, next: null, materials: [], resonance: { have: resonanceTotal(state), need: 0, ok: true }, canPromote: false, forced: false, lines: ['還沒有喝下任何靈劑。'] };
  }
  const st = promotionStatus(state, data);
  const head = `目前：${current.name}（階 ${current.rank}）`;
  if (!st.next) {
    return { current, next: null, materials: [], resonance: { have: st.resonance.have, need: 0, ok: true }, canPromote: false, forced: false, lines: [head, '', '目前沒有可以晉升的下一階。'] };
  }
  const materials = st.materials.map((m) => ({ name: m.name, have: m.have, need: m.need, ok: m.have >= m.need }));
  const resonance = { have: st.resonance.have, need: st.resonance.need, ok: st.resonance.have >= st.resonance.need };
  const lines = [head, `下一階：${st.next.name}（階 ${st.next.rank}）`, '', '材料'];
  for (const m of materials) lines.push(`・${m.name}　${m.have}／${m.need}　${m.ok ? '已備齊' : `還缺 ${m.need - m.have}`}`);
  if (materials.length === 0) lines.push('・不需要材料');
  lines.push('', `共鳴　${resonance.have}／${resonance.need}　${resonance.ok ? '已足夠' : `還差 ${resonance.need - resonance.have}`}`);
  if (st.canPromote && st.forced) lines.push(`材料已備齊，但共鳴不足：現在硬喝會讓崩解 +${st.forcedCollapse}。`);
  else if (st.canPromote) lines.push('材料與共鳴都已足夠，可以喝下靈劑。');
  else lines.push('材料還沒備齊。');
  return { current, next: { name: st.next.name, rank: st.next.rank }, materials, resonance, canPromote: st.canPromote, forced: st.forced, lines };
}

/**
 * 喝下靈劑的演出：對話前後的 state 之間，pending 新增了 { type:'promoted' } 時回傳要演出的內容，否則 null。
 * { forced, lineage, rank, name, abilities:[標籤名稱], skills:[技能名稱], collapseGain, collapse, title, lines, warning }
 */
export function promotionFxView(before, after, data) {
  if (!isObj(before) || !isObj(after)) return null;
  // M5 整合：引擎晉升成功時在 pending 寫入 { type:'promoted', lineage, rank, forced }；只看這一步新增的那幾筆
  const fresh = arr(after.pending).slice(arr(before.pending).length).filter((x) => isObj(x) && x.type === 'promoted');
  const p = fresh[fresh.length - 1];
  if (!p) return null;
  const def = rankDef(data, p.lineage, p.rank);
  const name = typeof def?.name === 'string' ? def.name : `階 ${p.rank}`;
  const abilities = arr(def?.field).map((t) => fieldTagLabel(t, data));
  const skills = arr(def?.skills).map((id) => findById(data?.skills, id)?.name ?? id);
  const collapse = Number.isInteger(after.collapse) ? after.collapse : 0;
  const collapseGain = Math.max(0, collapse - (Number.isInteger(before.collapse) ? before.collapse : 0));
  const forced = p.forced === true;
  const lines = [
    ...abilities.map((a) => `獲得探索能力【${a}】`),
    ...skills.map((s) => `新技能：${s}`),
  ];
  if (forced) lines.push(`崩解 +${collapseGain}（目前 ${collapse}／100）`);
  return {
    forced, lineage: p.lineage, rank: p.rank, name, abilities, skills, collapseGain, collapse,
    title: forced ? '強行晉升' : '晉升',
    lines,
    warning: forced ? '共鳴不足，靈劑在體內翻攪……你的輪廓有一瞬間碎成了霧。' : null,
  };
}

/** pending 的 promote_failed → 執行時產生的對話（說明原因與缺少的材料）。 */
export function promoteFailedDialogue(p, data) {
  const target = rankDef(data, p?.lineage, p?.rank);
  const name = typeof target?.name === 'string' ? target.name : '這一階';
  let reason;
  if (p?.promote_failed === 'materials') {
    const miss = arr(p.missing).map((m) => `${itemName(data, m.item)} ${m.have}／${m.need}`).join('、');
    reason = `靈劑的材料不足，喝不下去。\n還缺：${miss || '（不明）'}`;
  } else if (p?.promote_failed === 'rank') {
    reason = `以你現在的階位，還喝不了「${name}」的靈劑。`;
  } else {
    reason = `這瓶靈劑和你走的途徑不合（譜系不同），喝不下去。`;
  }
  return {
    id: '__promote_failed', start: 'n1',
    nodes: [
      { id: 'n1', speaker: null, text: '靈劑在瓶裡翻騰，卻沒有回應你。', next: 'n2' },
      { id: 'n2', speaker: null, text: reason, next: END },
    ],
  };
}

// ---------- 交換 ----------

const lineText = (l, data, state, withHave) => `${l.name ?? itemName(data, l.item)}×${l.count}${withHave ? `（持有 ${countOf(state, l.item)}）` : ''}`;

/**
 * 交換清單的每一列（選單按鈕）：{ id, label, sub, enabled, once }。
 * sub 兩行：「給出：名稱×數量（持有 n）」「得到：名稱×數量（持有 n）」；付不起時第一行以「材料不足｜」開頭。
 */
export function tradeRows(guestId, state, data) {
  return availableTrades(guestId, state, data).map((t) => {
    const give = `給出：${t.give.map((g) => lineText(g, data, state, true)).join('、')}`;
    const get = `得到：${t.get.map((g) => lineText(g, data, state, true)).join('、')}`;
    return {
      id: t.id, label: t.label ?? t.id, once: t.once, enabled: t.affordable,
      sub: `${t.affordable ? '' : '材料不足｜'}${give}\n${get}`,
    };
  });
}

/** 確認頁：{ id, label, give, get, lines }（持有數的變化）。找不到（已做過、未開放）回 null。 */
export function tradeConfirm(guestId, tradeId, state, data) {
  const t = availableTrades(guestId, state, data).find((x) => x.id === tradeId);
  if (!t) return null;
  const lines = [
    ...t.give.map((g) => `給出：${g.name} ×${g.count}（持有 ${g.have} → ${Math.max(0, g.have - g.count)}）`),
    ...t.get.map((g) => { const h = countOf(state, g.item); return `得到：${g.name} ×${g.count}（持有 ${h} → ${h + g.count}）`; }),
  ];
  if (t.once) lines.push('這個交換只能做一次。');
  return { id: t.id, label: t.label ?? t.id, give: t.give, get: t.get, once: t.once, affordable: t.affordable, lines };
}

export const tradeDoneText = (c) => `交換完成：得到 ${arr(c?.get).map((g) => `${g.name} ×${g.count}`).join('、')}`;

// ---------- 結局 ----------

/**
 * 結局畫面：該章有 endings、而且 state.ending 是其中之一時回傳
 * { id, title（結局名稱）, partTitle（end_screen.title）, subtitle, credits:[…]（end_screen.credits，{name} 代入；沒有就空陣列） }；否則 null（一般章節結束畫面）。
 */
export function endingScreen(chapterId, state, data) {
  const id = state?.ending;
  if (typeof id !== 'string') return null;
  const e = endingsOf(chapterId, data).find((x) => x.id === id);
  if (!e) return null;
  const story = findById(data?.story, chapterId);
  const es = isObj(story?.end_screen) ? story.end_screen : {};
  return {
    id: e.id,
    title: typeof e.title === 'string' ? e.title : e.id,
    partTitle: typeof es.title === 'string' ? es.title : `${story?.title ?? chapterId}　完`,
    subtitle: typeof es.subtitle === 'string' ? es.subtitle : '',
    credits: arr(es.credits).filter((x) => typeof x === 'string').map((line) => fill(line, state)), // end_screen.credits（選填）
  };
}

/**
 * 讀檔後要進哪個畫面：存檔停在已完成的章節結尾，而且（有下一章 continue，或是已判定結局的終章）時回章節結束畫面；
 * 其他情況回地圖。回傳 { scene:'ChapterEnd', chapter } 或 { scene:'Map' }。
 */
export function resumeScene(state, data) {
  const ch = state?.chapter;
  const done = arr(state?.chapter_done);
  if (typeof ch === 'string' && done.includes(ch)) {
    const story = findById(data?.story, ch);
    if (isObj(story?.end_screen?.continue) || endingScreen(ch, state, data)) return { scene: 'ChapterEnd', chapter: ch };
  }
  return { scene: 'Map' };
}
