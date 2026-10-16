// 內容測試與平衡測試共用的「模擬遊玩」工具：用真實資料＋ core 引擎走地圖、播對話、打戰鬥。
// 座標與 id 一律從載入的資料動態查，不寫死，地圖改版時仍有效。
// 戰鬥怎麼打由呼叫端決定（建構時傳 battle 解析器），所以內容測試與平衡測試可以用不同的策略。
import { newGame } from '../../web/src/core/state.js';
import { step, canMove, enterMap, DIRS, onceFlag } from '../../web/src/core/grid.js';
import { facingTarget, echo, investigate } from '../../web/src/core/interact.js';
import { startDialogue } from '../../web/src/core/dialogue.js';
import { takePending } from '../../web/src/core/effects.js';
import { evalCondition } from '../../web/src/core/conditions.js';

export const DEFAULT_NAME = '測試員';

export class Sim {
  /**
   * data：loadBundle 的 bundle。
   * battle(encId, state, sim) → { state, outcome, next }（finishBattle 的回傳格式）。
   *   解析器自己負責「重新挑戰」：回傳的 next 不可以是 retry。沒給時遇到戰鬥就丟錯。
   * state：直接指定起始狀態（例如讀入的存檔）；不給時建立新遊戲。
   */
  constructor(data, { name = DEFAULT_NAME, charges, choiceRules = [], battle, state } = {}) {
    this.data = data;
    this.dialogues = new Map(data.story.flatMap((s) => s.dialogues).map((d) => [d.id, d]));
    this.state = state ?? newGame({ name, manifest: data.manifest, maps: data.maps });
    if (charges !== undefined) this.state = { ...this.state, echo: { charges } };
    this.choiceRules = choiceRules;
    this.battleResolver = battle ?? null;
    this.usedRules = new Set();
    this.log = []; // 實際播放過的節點 { dialogue, speaker, text, choices }
    this.messages = []; // 引擎回傳的提示訊息
    this.dialoguesPlayed = [];
    this.battles = []; // { encounter, outcome }
  }

  mapOf(id) { return this.data.maps.find((m) => m.id === id); }
  get map() { return this.mapOf(this.state.location.map); }

  pick(cur) {
    for (const rule of this.choiceRules) {
      const hit = cur.choices.find((c) => c.text.includes(rule));
      if (hit) { this.usedRules.add(rule); return hit.index; }
    }
    return 0;
  }

  /** 把一段對話跑到結束（picker 可覆寫選項策略），再處理對話留下的 pending（battle／goto）。 */
  play(dlgId, picker = (cur) => this.pick(cur), maxSteps = 500) {
    if (dlgId === null || dlgId === undefined) return 0;
    const dlg = this.dialogues.get(dlgId);
    if (!dlg) throw new Error(`找不到對話「${dlgId}」`);
    this.dialoguesPlayed.push(dlgId);
    const r = startDialogue(dlg, this.state);
    let n = 0;
    while (!r.done) {
      if (++n > maxSteps) throw new Error(`對話 ${dlgId} 超過 ${maxSteps} 步仍未結束`);
      const cur = r.current();
      this.log.push({ dialogue: dlgId, speaker: cur.speaker, text: cur.text, choices: cur.choices?.map((c) => c.text) ?? null });
      if (cur.choices) r.choose(picker(cur)); else r.advance();
    }
    this.state = r.state;
    this.runPending();
    return n;
  }

  /** 只播對話、不處理 pending（「所有對話都能跑完」這類逐段檢查用）。 */
  playOnly(dlgId, picker, maxSteps) {
    const saved = this.runPending;
    this.runPending = () => { this.state = takePending(this.state).state; };
    try { return this.play(dlgId, picker, maxSteps); } finally { this.runPending = saved; }
  }

  runPending() {
    const { state, pending } = takePending(this.state);
    this.state = state;
    for (const p of pending) {
      if (p.type === 'battle') this.fight(p.encounter);
      else if (p.type === 'goto') this.goto(p.map, p.spawn, p.dialogue);
      else throw new Error(`未知的 pending「${p.type}」`);
    }
  }

  goto(map, spawn, dialogue) {
    const r = enterMap(this.state, this.data, map, spawn);
    this.state = r.state;
    this.play(r.dialogue);
    this.play(dialogue);
  }

  fight(encId) {
    if (!this.battleResolver) throw new Error(`遇到戰鬥「${encId}」，但沒有提供 battle 解析器`);
    const r = this.battleResolver(encId, this.state, this);
    if (r.next?.type === 'retry') throw new Error(`戰鬥「${encId}」的解析器回傳了 retry（${r.outcome}）`);
    this.battles.push({ encounter: encId, outcome: r.outcome });
    this.state = r.state;
    if (r.next?.type === 'dialogue') this.play(r.next.dialogue);
  }

  /** 開場對話（manifest.start.dialogue）。 */
  start() { this.play(this.data.manifest.start.dialogue); return this; }

  /** 章節結束畫面的「繼續」：最後完成的章節若有 end_screen.continue，就進入下一章。 */
  continueChapter() {
    const last = this.state.chapter_done.at(-1);
    const story = this.data.story.find((s) => s.id === last);
    const cont = story?.end_screen?.continue;
    if (!cont) throw new Error(`章節「${last}」的 end_screen 沒有 continue`);
    this.goto(cont.map, cont.spawn, cont.dialogue);
    return this;
  }

  handleEvent(ev) {
    if (!ev) return;
    if (ev.type === 'exit') {
      const r = enterMap(this.state, this.data, ev.to, ev.spawn);
      this.state = r.state;
      this.play(r.dialogue);
    } else if (ev.type === 'trigger') {
      this.play(ev.dialogue);
      if (ev.battle) this.fight(ev.battle);
    } else if (ev.type === 'blocked') {
      this.play(ev.dialogue);
    }
  }

  /** 目前會觸發的觸發點（條件成立、一次性的還沒用過）。 */
  activeTriggers(map = this.map) {
    return (map.triggers ?? []).filter((t) => !(t.once === true && this.state.flags?.[onceFlag(map.id, t.id)] === true)
      && (t.if === undefined || evalCondition(t.if, this.state)));
  }

  /** 在目前地圖上 BFS 找到 (gx,gy) 的方向序列。非目標的出口與「會觸發的」觸發點不走（避免誤觸）。 */
  path(gx, gy) {
    const map = this.map;
    const { x: sx, y: sy } = this.state.location;
    const special = new Set([...(map.exits ?? []), ...this.activeTriggers(map)].map((t) => `${t.x},${t.y}`));
    const prev = new Map([[`${sx},${sy}`, null]]);
    const queue = [[sx, sy]];
    while (queue.length) {
      const [x, y] = queue.shift();
      if (x === gx && y === gy) {
        const dirs = [];
        for (let k = `${x},${y}`; prev.get(k); k = prev.get(k).from) dirs.unshift(prev.get(k).dir);
        return dirs;
      }
      if (special.has(`${x},${y}`) && !(x === sx && y === sy)) continue;
      for (const [dir, d] of Object.entries(DIRS)) {
        const nx = x + d.dx;
        const ny = y + d.dy;
        const key = `${nx},${ny}`;
        if (prev.has(key) || !canMove(map, this.state, nx, ny, this.data)) continue;
        if (special.has(key) && !(nx === gx && ny === gy)) continue;
        prev.set(key, { from: `${x},${y}`, dir });
        queue.push([nx, ny]);
      }
    }
    return null;
  }

  /** 逐格走到 (gx,gy)；途中遇到出口就 enterMap、遇到觸發點就把對話（與戰鬥）跑完。回傳事件陣列。 */
  walkTo(gx, gy) {
    const dirs = this.path(gx, gy);
    if (!dirs) throw new Error(`地圖 ${this.state.location.map} 找不到從 (${this.state.location.x},${this.state.location.y}) 到 (${gx},${gy}) 的路`);
    const events = [];
    for (const dir of dirs) {
      const r = step(this.map, this.state, dir, this.data);
      this.state = r.state;
      if (!r.moved) throw new Error(`走不過去：${JSON.stringify(r.event)}`);
      if (r.event) events.push(r.event);
      const mapBefore = this.state.location.map;
      this.handleEvent(r.event);
      if (this.state.location.map !== mapBefore) break; // 換地圖了，舊路徑作廢
    }
    return events;
  }

  /** 走到物件旁並面向它（物件本身是 solid，站在四鄰中最近且走得到的格子）。 */
  faceObject(objId) {
    const obj = (this.map.objects ?? []).find((o) => o.id === objId);
    if (!obj) throw new Error(`地圖 ${this.map.id} 沒有物件「${objId}」`);
    let best = null;
    for (const [dir, d] of Object.entries(DIRS)) {
      const sx = obj.x - d.dx; // 站的位置；面向 dir 就會看到物件
      const sy = obj.y - d.dy;
      if (!canMove(this.map, this.state, sx, sy, this.data)) continue;
      const p = this.path(sx, sy);
      if (p && (!best || p.length < best.p.length)) best = { p, sx, sy, dir };
    }
    if (!best) throw new Error(`走不到物件「${objId}」旁邊`);
    this.walkTo(best.sx, best.sy);
    this.state = { ...this.state, location: { ...this.state.location, dir: best.dir } };
    const t = facingTarget(this.map, this.state, this.data);
    if (t?.id !== objId) throw new Error(`面向的是「${t?.id}」而不是「${objId}」`);
    return obj;
  }

  /** 【調查】：core 的 investigate 決定要依序播哪些對話（look 先播；鎖著時再試免費解法）；物件有 battle 時播完再開戰。 */
  investigate(objId) {
    const obj = this.faceObject(objId);
    const r = investigate(obj, this.state, this.data);
    this.state = r.state;
    for (const id of r.dialogues) this.play(id);
    if (r.battle) this.fight(r.battle);
    return r;
  }

  /** 某段對話在 log 裡播出的文字。 */
  textsOf(dlgId) { return this.log.filter((l) => l.dialogue === dlgId).map((l) => l.text); }

  /** 【殘響】／【回溯】。 */
  echoOn(objId) {
    const obj = this.faceObject(objId);
    const r = echo(obj, this.state, this.data);
    this.state = r.state;
    if (r.message) this.messages.push(r.message);
    this.play(r.dialogue);
    return r;
  }

  /** 地圖圖：從目前地圖到 targetMap 要依序走的出口（BFS，忽略 requires）。 */
  routeTo(targetMap) {
    const from = this.state.location.map;
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const m = queue.shift();
      if (m === targetMap) break;
      for (const e of this.mapOf(m).exits ?? []) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, { from: m, exit: e });
        queue.push(e.to);
      }
    }
    if (!prev.has(targetMap)) throw new Error(`地圖 ${from} 到 ${targetMap} 沒有出口相連`);
    const hops = [];
    for (let m = targetMap; prev.get(m); m = prev.get(m).from) hops.unshift({ map: prev.get(m).from, exit: prev.get(m).exit });
    return hops;
  }

  /** 沿出口走到 targetMap（每一段出口若有多個格子，挑走得到的）。 */
  travelTo(targetMap) {
    for (const hop of this.routeTo(targetMap)) {
      if (this.state.location.map !== hop.map) throw new Error(`預期在 ${hop.map}，實際在 ${this.state.location.map}`);
      const cands = (this.map.exits ?? []).filter((e) => e.to === hop.exit.to);
      const ok = cands.find((e) => this.path(e.x, e.y));
      if (!ok) throw new Error(`地圖 ${hop.map} 走不到通往 ${hop.exit.to} 的出口`);
      this.walkTo(ok.x, ok.y);
      if (this.state.location.map !== hop.exit.to) throw new Error(`出口被擋住，沒能進入 ${hop.exit.to}（flags=${JSON.stringify(this.state.flags)}）`);
    }
    return this;
  }

  /** 走到某個（目前會觸發的）觸發點上。 */
  stepOnTrigger(triggerIdPrefix) {
    const t = this.activeTriggers().find((x) => x.id.startsWith(triggerIdPrefix));
    if (!t) throw new Error(`地圖 ${this.map.id} 沒有會觸發的「${triggerIdPrefix}*」觸發點`);
    this.walkTo(t.x, t.y);
    return this;
  }
}

// ───────────── 劇情路線（從資料查關鍵物件，照劇情順序走） ─────────────

const hasEffect = (dlg, pred) => dlg.nodes.some((n) => [...(n.effects ?? []), ...(n.choices ?? []).flatMap((c) => c.effects ?? [])].some(pred));

/** 序章的關鍵物件（門、鑰匙抽屜、結尾觸發點）。 */
export function prologueLayout(data) {
  const dialogues = new Map(data.story.flatMap((s) => s.dialogues).map((d) => [d.id, d]));
  const allObjects = data.maps.flatMap((m) => (m.objects ?? []).map((o) => ({ map: m, obj: o })));
  const doorEntry = allObjects.find(({ obj }) => obj.lock && obj.lock.fallback === 'item:attic_key') ?? allObjects.find(({ obj }) => obj.lock);
  const keyId = doorEntry.obj.lock.fallback.replace(/^item:/, '');
  const keyDialogues = [...dialogues.values()].filter((d) => hasEffect(d, (e) => e.give_item === keyId)).map((d) => d.id);
  const drawerEntry = allObjects.find(({ obj }) => keyDialogues.includes(obj.look));
  const endsPrologue = (t) => hasEffect(dialogues.get(t.dialogue), (e) => e.chapter_end === 'prologue');
  const endingMap = data.maps.find((m) => (m.triggers ?? []).some(endsPrologue));
  const endingTrigger = endingMap?.triggers.find(endsPrologue);
  return { door: doorEntry?.obj, doorMap: doorEntry?.map, keyId, drawer: drawerEntry?.obj, drawerMap: drawerEntry?.map, endingMap, endingTrigger, chapterId: 'prologue' };
}

/**
 * 序章：route 'key'＝不用殘響（撬抽屜拿鑰匙開門、房東照實說）；'echo'＝殘響開門、對房東說謊後看穿（崩解 +10）。
 */
export function playPrologue(sim, route = 'key') {
  const L = prologueLayout(sim.data);
  sim.start();
  if (route === 'echo') {
    sim.choiceRules = ['說謊', '看穿'];
    sim.echoOn(L.door.id);
  } else {
    sim.choiceRules = ['撬'];
    sim.investigate(L.drawer.id);
    sim.investigate(L.door.id);
    sim.choiceRules = [];
  }
  sim.travelTo(L.endingMap.id);
  if (!sim.state.chapter_done.includes('prologue')) sim.walkTo(L.endingTrigger.x, L.endingTrigger.y);
  sim.choiceRules = [];
  return sim;
}

/** 第一章：喝下靈劑 → 地下練習室與馬洛對練（教學戰）→ 補給、艾妲入隊 → 第一章完。 */
export function playChapter1(sim) {
  sim.choiceRules = ['喝下'];
  sim.investigate('obj_cabinet');
  sim.choiceRules = [];
  sim.travelTo('training');
  sim.investigate('obj_marlo_train'); // 對練 → dlg_spar_after → goto 辦公室 → dlg_ch1_supply（補給、入隊、章末）
  return sim;
}

/**
 * 第二章：打聽（工頭、妻子）→ 小屋的補給箱 → 過橋遭遇霧行者（enc_dock_1）→ 拖痕 → 霧影（enc_dock_2）→ 柱子記號
 * → 向馬洛推理 → 倉庫門 → 倉庫：貨箱 → 霧行者（enc_warehouse）→ 休息（回滿）→ Boss → 第二章完。
 * wife：'truth'（說實話）或 'lie'（隱瞞，崩解 +3）。
 * 線索都用【回溯】（喝下靈劑後免費）。碼頭小屋的爐子在過橋前，之後不回頭（保守：碼頭兩場之間不回復）。
 */
export function playChapter2(sim, { wife = 'truth' } = {}) {
  sim.investigate('obj_foreman');
  sim.choiceRules = [wife === 'lie' ? '隱瞞' : '說實話'];
  sim.investigate('obj_wife');
  sim.choiceRules = [];
  sim.investigate('obj_shed_box');
  sim.echoOn('obj_glove');
  sim.stepOnTrigger('trg_fog1'); // 過橋就會遇到
  sim.echoOn('obj_drag');
  sim.investigate('obj_fog_shadow');
  sim.echoOn('obj_pillar');
  sim.choiceRules = ['東邊的倉庫'];
  sim.investigate('obj_marlo_dock');
  sim.choiceRules = [];
  sim.echoOn('obj_wh_door');
  sim.travelTo('warehouse');
  sim.investigate('obj_wh_crate');
  sim.stepOnTrigger('trg_fog3');
  sim.investigate('obj_rest');
  sim.stepOnTrigger('trg_boss_warn');
  sim.investigate('obj_hauler');
  return sim;
}
