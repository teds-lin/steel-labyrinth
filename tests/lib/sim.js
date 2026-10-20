// 內容測試與平衡測試共用的「模擬遊玩」工具：用真實資料＋ core 引擎走地圖、播對話、打戰鬥。
// 座標與 id 一律從載入的資料動態查，不寫死，地圖改版時仍有效。
// 戰鬥怎麼打由呼叫端決定（建構時傳 battle 解析器），所以內容測試與平衡測試可以用不同的策略。
import { newGame } from '../../web/src/core/state.js';
import { step, canMove, enterMap, DIRS, onceFlag } from '../../web/src/core/grid.js';
import { facingTarget, echo, investigate } from '../../web/src/core/interact.js';
import { startDialogue } from '../../web/src/core/dialogue.js';
import { takePending } from '../../web/src/core/effects.js';
import { evalCondition } from '../../web/src/core/conditions.js';
import { enterDream, wakeUp, isDreamMap, dreamChoiceDialogue } from '../../web/src/core/dream.js';
import { resolveEnding } from '../../web/src/core/ending.js';

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
    this.chats = []; // open_chat 開啟過的夢客 id（模擬器不真的聊天）
    this.wakes = []; // 每次醒來 wakeUp 的 { relocated }
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

  /**
   * 把一段對話跑到結束（picker 可覆寫選項策略），再處理對話留下的 pending（battle／goto／enter_dream／wake／open_chat）。
   * dlgId 也可以是執行時產生的對話物件（例如引擎的「入夢」選項，同畫面層）。
   */
  play(dlgId, picker = (cur) => this.pick(cur), maxSteps = 500) {
    if (dlgId === null || dlgId === undefined) return 0;
    const dlg = typeof dlgId === 'object' ? dlgId : this.dialogues.get(dlgId);
    if (!dlg) throw new Error(`找不到對話「${dlgId}」`);
    if (typeof dlgId === 'object') dlgId = dlg.id;
    this.dialoguesPlayed.push(dlgId);
    const r = startDialogue(dlg, this.state, this.data); // M5：can_promote／promote 需要 data
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
      else if (p.type === 'enter_dream') this.enterDream(p.map, p.spawn);
      else if (p.type === 'wake') this.wake(p.dialogue);
      else if (p.type === 'open_chat') this.chats.push(p.guest);
      else if (p.type === 'promoted') this.promotedFx = [...(this.promotedFx ?? []), p]; // 畫面的晉升演出（模擬器只記錄）
      else if (p.type === 'open_trade') this.trades = [...(this.trades ?? []), p.guest];
      else if (p.type === 'promote_failed') this.promoteFailed = [...(this.promoteFailed ?? []), p];
      else if (p.type === 'resolve_ending') this.resolveEnding();
      else throw new Error(`未知的 pending「${p.type}」`);
    }
  }

  /** 結局判定（同 MapScene.doResolveEnding）：寫入 state.ending，再播該結局的對話。 */
  resolveEnding() {
    const r = resolveEnding(this.state, this.data);
    this.state = r.state;
    this.endings = [...(this.endings ?? []), r.ending.id];
    this.play(r.ending.dialogue);
  }

  goto(map, spawn, dialogue) {
    const r = enterMap(this.state, this.data, map, spawn);
    this.state = r.state;
    this.play(r.dialogue);
    this.play(dialogue);
  }

  /** 入夢（同 MapScene.doEnterDream）：記住現實位置、移到夢境地圖；第一次進入時播 on_enter。 */
  enterDream(map, spawn) {
    const r = enterDream(this.state, this.data, map, spawn);
    this.state = r.state;
    this.play(r.dialogue);
  }

  /** 醒來（同 MapScene.doWake）：回到 dream_return，再播 wake 帶的對話。 */
  wake(dialogue) {
    const r = wakeUp(this.state, this.data);
    this.state = r.state;
    this.wakes.push({ relocated: r.relocated });
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

  /** 章節結束畫面的「繼續」：最後完成的章節若有 end_screen.continue，就進入下一章（同 ChapterEndScene：章節改成 manifest 的下一章）。 */
  continueChapter() {
    const last = this.state.chapter_done.at(-1);
    const story = this.data.story.find((s) => s.id === last);
    const cont = story?.end_screen?.continue;
    if (!cont) throw new Error(`章節「${last}」的 end_screen 沒有 continue`);
    const chapters = this.data.manifest?.chapters ?? [];
    const i = chapters.indexOf(last);
    if (i >= 0 && i + 1 < chapters.length) this.state = { ...this.state, chapter: chapters[i + 1] };
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
    // 鐘塔之夢（同 MapScene.runDialogues）：look 之後問「入夢」（look 本身已經入夢時不問）；沒有 look 的夢客直接開聊天
    if (r.dream && !isDreamMap(this.map)) this.play(dreamChoiceDialogue(r.dream));
    if (r.guest && r.dialogues.length === 0) this.chats.push(r.guest);
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
    const cands = this.activeTriggers().filter((x) => x.id.startsWith(triggerIdPrefix));
    const t = cands.find((x) => this.path(x.x, x.y)) ?? cands[0]; // M5：同名一排觸發點時挑走得到的
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

/**
 * 第三章：開場（問馬洛）→ 沙發躺下（第一次入夢，鐘塔與夢客見面、拿到代號）→ 十二點的椅子休息 → 南邊的門醒來
 * → 白天：艾妲 → 馬洛（說實話、出發）→ 第三章完。不打仗。
 * redream：醒來後先從沙發再入夢一次（引擎的「入夢」選項）、休息、再醒來，才去找馬洛。
 */
export function playChapter3(sim, { redream = false } = {}) {
  sim.choiceRules = ['躺下'];
  sim.investigate('obj_ch3_sofa'); // dlg_ch3_sofa → enter_dream → 鐘塔（第一次播 dlg_dream_arrive）
  sim.choiceRules = [];
  sim.investigate('obj_chair_twelve');
  sim.choiceRules = ['推開門'];
  sim.investigate('obj_tower_door'); // wake → 回到沙發旁
  if (redream) {
    sim.choiceRules = [];
    sim.investigate('obj_ch3_sofa'); // look（again）→ 引擎的入夢選項（第 0 個＝入夢）
    sim.investigate('obj_chair_twelve');
    sim.choiceRules = ['醒來'];
    sim.investigate('obj_tower_door');
  }
  sim.choiceRules = ['鐘聲'];
  sim.investigate('obj_ch3_ada');
  sim.choiceRules = ['說實話', '走吧'];
  sim.investigate('obj_ch3_marlo_day');
  sim.choiceRules = [];
  return sim;
}

// ───────────── M5：第四章～終章 ─────────────
// 路線改寫自關卡設計師的驗證腳本（scratchpad m5-ch45/play.mjs），並補上第六、七章與終章。
// 選項規則用「每條只用一次」：規則依序比對，用過就不再用；沒有規則命中時，優先選「沒事／離開」這類結束對話的選項，否則第 0 個。

const BYE = ['沒事', '「我知道了', '再待一會兒'];

/** 在 fn 執行期間，選項依 rules（每條只用一次）決定；結束後恢復原本的選擇方式。 */
export function withChoices(sim, rules, fn) {
  const used = new Set();
  const saved = sim.pick;
  sim.pick = (cur) => {
    for (const r of rules) {
      if (used.has(r)) continue;
      const hit = cur.choices.find((c) => c.text.includes(r));
      if (hit) { used.add(r); sim.usedRules.add(r); return hit.index; }
    }
    const bye = cur.choices.find((c) => BYE.some((t) => c.text.includes(t)));
    return bye ? bye.index : 0;
  };
  try { return fn(); } finally { sim.pick = saved; }
}

/** 往 toMap 的出口踏一步（出口還鎖著時會播 blocked 對話）。 */
function bumpExit(sim, toMap) {
  for (const e of (sim.map.exits ?? []).filter((x) => x.to === toMap)) {
    for (const [dir, d] of Object.entries(DIRS)) {
      const sx = e.x - d.dx;
      const sy = e.y - d.dy;
      const onExit = (sim.map.exits ?? []).some((x) => x.x === sx && x.y === sy);
      if (!onExit && canMove(sim.map, sim.state, sx, sy, sim.data) && sim.path(sx, sy)) return bump(sim, sx, sy, dir);
    }
  }
  throw new Error(`走不到通往 ${toMap} 的出口`);
}

/** 走到 (x,y) 再往 dir 踏一步（踩出口或觸發點）。 */
function bump(sim, x, y, dir) {
  sim.walkTo(x, y);
  const r = step(sim.map, sim.state, dir, sim.data);
  sim.state = r.state;
  sim.handleEvent(r.event);
}

/**
 * 第四章。forced：只走必經線索（推理先答錯一次），共鳴不足 → 硬喝晉升階 8；否則選擇性線索全拿、穩穩喝下。
 * dream：晚上入夢一次（鐘塔、夢客、交換清單）。
 */
export function playChapter4(sim, { forced = false, dream = true } = {}) {
  withChoices(sim, ['前往上城'], () => sim.investigate('obj_ch4_door'));
  sim.investigate('obj_ch4_peter');
  if (!forced) {
    sim.investigate('obj_ch4_daisy'); sim.echoOn('obj_ch4_daisy');
    sim.investigate('obj_ch4_hobbs'); sim.echoOn('obj_ch4_hobbs'); sim.investigate('obj_ch4_hobbs');
  }
  sim.investigate('obj_ch4_well');
  if (!forced) sim.echoOn('obj_ch4_well');
  withChoices(sim, ['盯著詩班長'], () => sim.travelTo('chapel_hall'));
  sim.echoOn('obj_ch4_hymnal');
  sim.investigate('obj_ch4_hooks');
  if (!forced) { sim.investigate('obj_ch4_usher'); sim.echoOn('obj_ch4_usher'); sim.investigate('obj_ch4_usher'); }
  sim.travelTo('uptown');
  withChoices(sim, forced ? ['回家睡覺', '被記下名字'] : ['被記下名字'], () => bump(sim, 1, 7, 'left'));
  if (dream) {
    withChoices(sim, ['躺下'], () => sim.investigate('obj_ch4_sofa'));
    if (sim.state.location.map !== 'clocktower_ch4') throw new Error('第四章沒有入夢');
    sim.investigate('obj_ch4_chair_twelve');
    withChoices(sim, ['上城的禮拜堂', '靜默聖歌會'], () => sim.investigate('obj_ch4_guest_nine'));
    withChoices(sim, ['沒有聲音的歌', '學別人說話'], () => sim.investigate('obj_ch4_guest_three'));
    withChoices(sim, ['醒來'], () => sim.investigate('obj_ch4_tower_door'));
  }
  withChoices(sim, ['喝下'], () => sim.investigate('obj_ch4_cabinet'));
  if (sim.state.lineage?.rank !== 8) throw new Error('第四章沒有晉升到階 8');
  withChoices(sim, ['前往上城（夜）'], () => sim.investigate('obj_ch4_door'));
  sim.stepOnTrigger('trg_ch4_night');
  sim.stepOnTrigger('trg_ch4_alley');
  sim.travelTo('chapel_cloister');
  sim.investigate('obj_ch4_side_door');
  sim.stepOnTrigger('trg_ch4_cloister_1');
  sim.echoOn('obj_ch4_organ');
  sim.stepOnTrigger('trg_ch4_cloister_2');
  sim.investigate('obj_ch4_bench');
  sim.travelTo('chapel_loft');
  sim.investigate('obj_ch4_loft_door');
  sim.investigate('obj_ch4_matilda');
  sim.echoOn('obj_ch4_roster');
  withChoices(sim, ['開打'], () => sim.investigate('obj_ch4_matilda'));
  if (!sim.state.chapter_done.includes('chapter4')) throw new Error('第四章沒有走完');
  return sim;
}

/** 第五章：老賀伯入隊 → 水道入口 → 主渠（推理、閘門、三場）→ 鐵籠（艾妲離隊）→ 蓄水池 → 沉閘 Boss → 出海口。 */
export function playChapter5(sim, { forced = false, promise = true } = {}) {
  withChoices(sim, ['下去吧'], () => sim.investigate('obj_ch5_door'));
  sim.investigate('obj_ch5_supply');
  sim.stepOnTrigger('trg_ch5_entry');
  sim.investigate('obj_ch5_shed_stove');
  sim.travelTo('sewer_canal');
  sim.echoOn('obj_ch5_tally');
  sim.stepOnTrigger('trg_ch5_canal_1');
  withChoices(sim, forced ? ['往上城', '港口方向'] : ['港口方向'], () => sim.investigate('obj_ch5_fork'));
  sim.investigate('obj_ch5_rack');
  sim.investigate('obj_ch5_sluice');
  sim.stepOnTrigger('trg_ch5_canal_2');
  sim.stepOnTrigger('trg_ch5_canal_3');
  sim.investigate('obj_ch5_shaft');
  sim.investigate('obj_ch5_cage');
  withChoices(sim, [promise ? '我會回來' : '我們繼續'], () => sim.echoOn('obj_ch5_cage'));
  sim.travelTo('sewer_cistern');
  sim.investigate('obj_ch5_stone'); // 回復點 2 就在蓄水池入口旁：兩人隊一進來就先休息
  if (!forced) { sim.investigate('obj_ch5_kirby'); sim.echoOn('obj_ch5_kirby'); sim.investigate('obj_ch5_kirby'); sim.echoOn('obj_ch5_bell'); }
  sim.stepOnTrigger('trg_ch5_cistern_1');
  sim.investigate('obj_ch5_checkpoint');
  sim.investigate('obj_ch5_cache');
  sim.stepOnTrigger('trg_ch5_cistern_2');
  sim.travelTo('sewer_depths');
  sim.investigate('obj_ch5_wax');
  sim.echoOn('obj_ch5_mechanism');
  sim.investigate('obj_ch5_lamp');
  withChoices(sim, ['讓開'], () => sim.investigate('obj_ch5_oswald'));
  sim.travelTo('sewer_outfall');
  if (!sim.state.chapter_done.includes('chapter5')) throw new Error('第五章沒有走完');
  return sim;
}

/**
 * 第六章。statement：'trust'（照實寫、站在隊長這邊 → inspector_convinced）、'report'（簽下陳述 → marlo_reported）、
 * 'cover'（替隊長說謊，崩解 +5）、'refuse'（不簽）。owen：碼頭支線 'tell'／'borrow'（借卡爾的聲音，崩解 +4）／null（不去）。
 * letter：'read'／'unread'。trust：鐘下的對話是否「站在你這邊」。dream：深夜入夢一次。forced：只走必經線索。
 */
export function playChapter6(sim, { statement = 'trust', owen = 'tell', letter = 'read', trust = statement === 'trust', dream = true, forced = false } = {}) {
  if (!forced) {
    sim.investigate('obj_ch6_inspector'); sim.echoOn('obj_ch6_inspector'); sim.investigate('obj_ch6_inspector');
    sim.investigate('obj_ch6_herb_day'); sim.echoOn('obj_ch6_herb_day'); sim.investigate('obj_ch6_herb_day');
  }
  if (owen) {
    withChoices(sim, ['先去碼頭'], () => sim.investigate('obj_ch6_door'));
    sim.investigate('obj_ch6_owen');
    sim.echoOn('obj_ch6_owen');
    withChoices(sim, [owen === 'borrow' ? '借卡爾的聲音' : '把你看見的'], () => sim.investigate('obj_ch6_owen'));
    sim.travelTo('hallway_ch6');
  } else {
    withChoices(sim, ['回鐵橋街'], () => sim.investigate('obj_ch6_door'));
  }
  sim.travelTo('attic_ch6');
  withChoices(sim, ['借它的聲音'], () => sim.investigate('obj_ch6_mirror'));
  if (dream) {
    withChoices(sim, [], () => sim.investigate('obj_ch6_bed')); // 引擎的入夢選項：第 0 個＝入夢
    if (sim.state.location.map !== 'clocktower_ch6') throw new Error('第六章沒有入夢');
    sim.investigate('obj_ch6_chair_twelve');
    withChoices(sim, ['醒來'], () => sim.investigate('obj_ch6_tower_door'));
  }
  withChoices(sim, ['走吧'], () => sim.investigate('obj_ch6_herb_attic'));
  sim.echoOn('obj_ch6_ashtray');
  withChoices(sim, [letter === 'read' ? '讀。' : '不讀'], () => sim.echoOn('obj_ch6_drawer'));
  withChoices(sim, ['鐘匠巷'], () => sim.investigate('obj_ch6_herb_night'));
  if (sim.state.location.map !== 'clockmaker_lane') throw new Error('第六章推理後沒有到鐘匠巷');
  sim.stepOnTrigger('trg_ch6_lane1');
  sim.investigate('obj_ch6_lane_box');
  if (!forced) sim.echoOn('obj_ch6_clock');
  const talk = letter === 'read' ? '我讀了你的信' : '我沒讀那封信';
  const stance = trust ? '我站在你這邊' : '我得想一想';
  const st = { trust: '我照實寫', report: '簽下陳述', cover: '一直在辦公室', refuse: '說不清楚' }[statement];
  withChoices(sim, ['一起上', talk, stance, st], () => sim.investigate('obj_ch6_marlo_lane'));
  if (!sim.state.chapter_done.includes('chapter6')) throw new Error('第六章沒有走完');
  return sim;
}

/**
 * 第七章：出發 → 碼頭（夜閘、兩場、脫隊者、推理）→ 沉堤（日誌、一場、落海）→ 鐘塔晉升階 7 → 醒來 → 燈塔（一場、鐵柵、回復點）
 * → 祭司 → 潮兆。heed：回應潮水（崩解 +20、heeded_tide，打較弱的版本）。forced：只走必經線索。
 */
export function playChapter7(sim, { heed = false, forced = false } = {}) {
  withChoices(sim, ['出發'], () => sim.investigate('obj_ch7_door'));
  if (sim.state.location.map !== 'harbor_night') throw new Error('第七章沒有出發到碼頭');
  sim.investigate('obj_ch7_gate');
  sim.stepOnTrigger('trg_ch7_harbor1');
  sim.stepOnTrigger('trg_ch7_harbor2');
  if (!forced) { sim.investigate('obj_ch7_deserter'); sim.echoOn('obj_ch7_deserter'); sim.investigate('obj_ch7_deserter'); }
  // 推理：往沉堤的出口還沒解開（requires ch7_deduced）時，踩上去會播 blocked＝dlg_ch7_deduce，答對後 goto 沉堤
  withChoices(sim, ['沉堤'], () => bumpExit(sim, 'breakwater'));
  if (sim.state.location.map !== 'breakwater') throw new Error('第七章推理後沒有到沉堤');
  if (!forced) sim.echoOn('obj_ch7_keeper_log');
  sim.stepOnTrigger('trg_ch7_bw');
  sim.stepOnTrigger('trg_ch7_drown');
  if (sim.state.location.map !== 'clocktower_ch7') throw new Error('第七章沒有落海入夢');
  withChoices(sim, ['喝下'], () => sim.investigate('obj_ch7_chair_twelve'));
  withChoices(sim, ['抓住那隻手'], () => sim.investigate('obj_ch7_tower_door'));
  sim.investigate('obj_ch7_outer_grille');
  sim.travelTo('lighthouse');
  sim.stepOnTrigger('trg_ch7_lh1');
  sim.echoOn('obj_ch7_coat');
  sim.investigate('obj_ch7_inner_grille');
  sim.investigate('obj_ch7_landing');
  sim.travelTo('lighthouse_top');
  withChoices(sim, ['鐘不會停', heed ? '回應它' : '摀住耳朵'], () => sim.investigate('obj_ch7_priest'));
  if (!sim.state.chapter_done.includes('chapter7')) throw new Error('第七章沒有走完');
  return sim;
}

/** 終章：end_screen.continue 帶入開場對話 → resolve_ending → 結局對話（chapter_end: finale）。回傳結局 id。 */
export function playFinale(sim) {
  sim.continueChapter();
  if (!sim.state.chapter_done.includes('finale')) throw new Error('終章沒有走完');
  return sim.state.ending;
}
