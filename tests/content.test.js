// 內容測試：用真實的序章資料（web/data/）＋ core 引擎模擬遊玩，證明序章可以通關。
// 座標與 id 一律從載入的資料動態查，不寫死，地圖改版時仍有效。
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../tools/lib/bundle.mjs';
import { newGame } from '../web/src/core/state.js';
import { step, canMove, enterMap, isUnlocked, DIRS } from '../web/src/core/grid.js';
import { facingTarget, look, echo, tryUnlock, NO_CHARGE_MESSAGE } from '../web/src/core/interact.js';
import { startDialogue } from '../web/src/core/dialogue.js';

const DATA_DIR = fileURLToPath(new URL('../web/data/', import.meta.url));
const NAME = '測試員';

// ───────────── 資料查詢 ─────────────
let data;
let dialogues; // id -> dialogue
beforeAll(() => {
  const { bundle, errors } = loadBundle(DATA_DIR);
  expect(errors).toEqual([]);
  data = bundle;
  dialogues = new Map(data.story.flatMap((s) => s.dialogues).map((d) => [d.id, d]));
});

const mapOf = (id) => data.maps.find((m) => m.id === id);
const allObjects = () => data.maps.flatMap((m) => (m.objects ?? []).map((o) => ({ map: m, obj: o })));
const dialogueHasEffect = (dlg, pred) => dlg.nodes.some((n) => [...(n.effects ?? []), ...(n.choices ?? []).flatMap((c) => c.effects ?? [])].some(pred));

// ───────────── 模擬器 ─────────────
// choiceRules：選項節點遇到時，依序找第一條「文字包含 rule」的可見選項；找不到就選第 0 個。
class Sim {
  constructor({ name = NAME, charges, choiceRules = [] } = {}) {
    this.state = newGame({ name, manifest: data.manifest, maps: data.maps });
    if (charges !== undefined) this.state = { ...this.state, echo: { charges } };
    this.choiceRules = choiceRules;
    this.usedRules = new Set();
    this.log = []; // 實際播放過的節點 { dialogue, speaker, text, choices }
    this.messages = []; // 引擎回傳的提示訊息
    this.dialoguesPlayed = [];
  }

  get map() { return mapOf(this.state.location.map); }

  pick(cur) {
    for (const rule of this.choiceRules) {
      const hit = cur.choices.find((c) => c.text.includes(rule));
      if (hit) { this.usedRules.add(rule); return hit.index; }
    }
    return 0;
  }

  /** 把一段對話跑到結束；picker 可覆寫選項策略。 */
  play(dlgId, picker = (cur) => this.pick(cur), maxSteps = 500) {
    if (dlgId === null || dlgId === undefined) return;
    const dlg = dialogues.get(dlgId);
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
    return n;
  }

  /** 開場對話（manifest.start.dialogue）。 */
  start() { this.play(data.manifest.start.dialogue); return this; }

  handleEvent(ev) {
    if (!ev) return;
    if (ev.type === 'exit') {
      const r = enterMap(this.state, data, ev.to, ev.spawn);
      this.state = r.state;
      this.play(r.dialogue);
    } else if (ev.type === 'trigger') {
      this.play(ev.dialogue);
    } else if (ev.type === 'blocked') {
      this.play(ev.dialogue);
    }
  }

  /** 在目前地圖上 BFS 找到 (gx,gy) 的方向序列。非目標的出口與觸發點不走（避免誤觸）。 */
  path(gx, gy) {
    const map = this.map;
    const { x: sx, y: sy } = this.state.location;
    const special = new Set([...(map.exits ?? []), ...(map.triggers ?? [])].map((t) => `${t.x},${t.y}`));
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
        if (prev.has(key) || !canMove(map, this.state, nx, ny, data)) continue;
        if (special.has(key) && !(nx === gx && ny === gy)) continue;
        prev.set(key, { from: `${x},${y}`, dir });
        queue.push([nx, ny]);
      }
    }
    return null;
  }

  /** 逐格走到 (gx,gy)；途中遇到出口就 enterMap、遇到觸發點就把對話跑完。回傳事件陣列。 */
  walkTo(gx, gy) {
    const dirs = this.path(gx, gy);
    if (!dirs) throw new Error(`地圖 ${this.state.location.map} 找不到從 (${this.state.location.x},${this.state.location.y}) 到 (${gx},${gy}) 的路`);
    const events = [];
    for (const dir of dirs) {
      const r = step(this.map, this.state, dir, data);
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
      if (!canMove(this.map, this.state, sx, sy, data)) continue;
      const p = this.path(sx, sy);
      if (p && (!best || p.length < best.p.length)) best = { p, sx, sy, dir };
    }
    if (!best) throw new Error(`走不到物件「${objId}」旁邊`);
    this.walkTo(best.sx, best.sy);
    this.state = { ...this.state, location: { ...this.state.location, dir: best.dir } };
    const t = facingTarget(this.map, this.state, data);
    if (t?.id !== objId) throw new Error(`面向的是「${t?.id}」而不是「${objId}」`);
    return obj;
  }

  /** 【調查】：lock 物件未解開時走 tryUnlock（自動選法），否則播 look 對話。 */
  investigate(objId) {
    const obj = this.faceObject(objId);
    if (obj.lock && !isUnlocked(obj, this.state)) {
      const r = tryUnlock(obj, this.state, data);
      this.state = r.state;
      this.play(r.dialogue);
      return r;
    }
    const r = look(obj, this.state);
    this.play(r.dialogue);
    return r;
  }

  /** 【殘響】。 */
  echoOn(objId) {
    const obj = this.faceObject(objId);
    const r = echo(obj, this.state, data);
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
      for (const e of mapOf(m).exits ?? []) {
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
}

// ───────────── 從資料找出關鍵物件 ─────────────
function findKeyLayout() {
  const doorEntry = allObjects().find(({ obj }) => obj.lock);
  expect(doorEntry, '資料裡必須有 lock 物件').toBeTruthy();
  const keyId = doorEntry.obj.lock.fallback.replace(/^item:/, '');
  // 提供鑰匙的對話：給 keyId 的對話中，被某物件當 look 的那段（不是 lock 的 on_tag）
  const keyDialogues = [...dialogues.values()].filter((d) => dialogueHasEffect(d, (e) => e.give_item === keyId)).map((d) => d.id);
  const drawerEntry = allObjects().find(({ obj }) => keyDialogues.includes(obj.look));
  expect(drawerEntry, '必須有物件的 look 對話會給鑰匙').toBeTruthy();
  const endingMap = data.maps.find((m) => (m.triggers ?? []).some((t) => dialogueHasEffect(dialogues.get(t.dialogue), (e) => e.chapter_end)));
  expect(endingMap, '必須有觸發 chapter_end 的觸發點').toBeTruthy();
  const endingTrigger = endingMap.triggers.find((t) => dialogueHasEffect(dialogues.get(t.dialogue), (e) => e.chapter_end));
  const chapterId = [...dialogues.get(endingTrigger.dialogue).nodes.flatMap((n) => n.effects ?? [])].find((e) => e.chapter_end).chapter_end;
  return { door: doorEntry.obj, doorMap: doorEntry.map, keyId, drawer: drawerEntry.obj, drawerMap: drawerEntry.map, endingMap, endingTrigger, chapterId };
}

/** 從街道（結尾所在地圖）的觸發點走完結尾。 */
function finishChapter(sim, L) {
  sim.travelTo(L.endingMap.id);
  if (sim.state.chapter_done.length === 0) sim.walkTo(L.endingTrigger.x, L.endingTrigger.y);
}

// ───────────── 測試 ─────────────
describe('序章內容：用真實資料模擬遊玩', () => {
  it('資料載入無誤，且開局能播完開場對話', () => {
    const sim = new Sim().start();
    expect(sim.dialoguesPlayed).toEqual([data.manifest.start.dialogue]);
    expect(sim.state.location.map).toBe(data.manifest.start.map);
  });

  it('1. 完全不用殘響也能通關：找鑰匙 → 開門 → 下樓 → 房東 → 街道結尾', () => {
    const L = findKeyLayout();
    const sim = new Sim({ charges: 0 }).start();
    expect(sim.state.echo.charges).toBe(0);

    // 門還打不開（沒鑰匙也沒殘響）
    const locked = sim.investigate(L.door.id);
    expect(locked.unlocked).toBe(false);
    expect(sim.state.flags[L.door.lock.flag]).toBeUndefined();

    // 找鑰匙
    sim.choiceRules = ['撬'];
    sim.investigate(L.drawer.id);
    expect(sim.state.items[L.keyId]).toBe(1);

    // 開門
    const opened = sim.investigate(L.door.id);
    expect(opened.unlocked).toBe(true);
    expect(opened.via).toBe('item');
    expect(sim.state.flags[L.door.lock.flag]).toBe(true);

    // 下樓、處理房東、到街道結尾
    sim.choiceRules = [];
    finishChapter(sim, L);
    expect(sim.state.chapter_done).toContain(L.chapterId);
    expect(sim.state.location.map).toBe(L.endingMap.id);
    expect(sim.state.echo.charges).toBe(0);
    expect(sim.state.collapse).toBe(0);
    expect(sim.state.resonance.lie_exposed ?? 0).toBe(0);
    expect(sim.dialoguesPlayed).toContain(L.endingTrigger.dialogue);
  });

  it('2. 用殘響的路線：殘響開門、對房東說謊後看穿，通關且崩解／次數／共鳴正確', () => {
    const L = findKeyLayout();
    const sim = new Sim({ choiceRules: ['說謊', '看穿'] }).start();
    const start = sim.state.echo.charges;
    expect(start).toBe(3);

    // 殘響開門（同時順便拿到鑰匙）
    const r = sim.echoOn(L.door.id);
    expect(r.unlocked).toBe(true);
    expect(r.via).toBe('tag');
    expect(sim.state.flags[L.door.lock.flag]).toBe(true);
    expect(sim.state.items[L.keyId]).toBe(1);
    expect(sim.state.echo.charges).toBe(start - 1);
    expect(sim.state.collapse).toBe(5);

    finishChapter(sim, L);

    expect(sim.usedRules.has('看穿')).toBe(true);
    expect(sim.state.resonance.lie_exposed).toBe(1);
    expect(sim.state.flags.lie_exposed).toBe(true);
    expect(sim.state.echo.charges).toBe(start - 2);
    expect(sim.state.collapse).toBe(10);
    expect(sim.state.chapter_done).toContain(L.chapterId);
  });

  it('3. 重複調查抽屜不會拿到第二把鑰匙，也不會被殘響開門重複給鑰匙', () => {
    const L = findKeyLayout();
    const sim = new Sim({ choiceRules: ['撬'] }).start();
    for (let i = 0; i < 4; i++) {
      sim.investigate(L.drawer.id);
      expect(sim.state.items[L.keyId]).toBe(1);
    }
    // 有鑰匙之後再用殘響開門：也不會多一把
    sim.echoOn(L.door.id);
    expect(sim.state.items[L.keyId]).toBe(1);
    // 先用殘響拿鑰匙，再調查抽屜：同樣只有一把
    const sim2 = new Sim({ choiceRules: ['撬'] }).start();
    sim2.echoOn(L.door.id);
    sim2.investigate(L.drawer.id);
    expect(sim2.state.items[L.keyId]).toBe(1);
  });

  it('4. 殘響最多 3 次，用完再殘響回傳提示訊息、次數不為負', () => {
    const entry = allObjects().find(({ obj }) => typeof obj.echo === 'string' && !obj.lock);
    expect(entry, '需要一個有 echo 對話的一般物件').toBeTruthy();
    const sim = new Sim().start();
    expect(sim.state.echo.charges).toBe(3);
    for (let i = 1; i <= 3; i++) {
      const r = sim.echoOn(entry.obj.id);
      expect(r.message).toBeUndefined();
      expect(sim.state.echo.charges).toBe(3 - i);
      expect(sim.state.collapse).toBe(5 * i);
    }
    const r = sim.echoOn(entry.obj.id);
    expect(r.message).toBe(NO_CHARGE_MESSAGE);
    expect(r.dialogue).toBeNull();
    expect(sim.state.echo.charges).toBe(0);
    expect(sim.state.collapse).toBe(15);
    expect(sim.messages).toEqual([NO_CHARGE_MESSAGE]);
    // 再多按幾次也不會變負
    sim.echoOn(entry.obj.id);
    expect(sim.state.echo.charges).toBe(0);
  });

  it('5. 名字代入：自訂名字時，所有播放過的對話文字不殘留 {name}', () => {
    const L = findKeyLayout();
    // 兩條完整路線（鑰匙線＋殘響線）
    const keyRun = new Sim({ name: NAME, charges: 0, choiceRules: ['撬'] }).start();
    keyRun.investigate(L.drawer.id);
    keyRun.investigate(L.door.id);
    keyRun.choiceRules = [];
    finishChapter(keyRun, L);

    const echoRun = new Sim({ name: NAME, choiceRules: ['說謊', '看穿'] }).start();
    echoRun.echoOn(L.door.id);
    finishChapter(echoRun, L);

    // 另外把每一段對話都播一遍（選第 0 個）
    const all = new Sim({ name: NAME, charges: 5 });
    for (const id of dialogues.keys()) all.play(id, () => 0);

    for (const sim of [keyRun, echoRun, all]) {
      expect(sim.log.length).toBeGreaterThan(0);
      for (const l of sim.log) {
        const fields = [l.speaker ?? '', l.text ?? '', ...(l.choices ?? [])];
        for (const f of fields) {
          expect(f, `${l.dialogue}：${f}`).not.toContain('{name}');
          expect(f, `${l.dialogue}：${f}`).not.toMatch(/\{[^}]*\}/);
        }
      }
      expect(sim.log.some((l) => (l.text ?? '').includes(NAME) || (l.speaker ?? '').includes(NAME))).toBe(true);
    }
  });

  describe('6. 所有對話都能從頭跑到結束（200 步內、不丟錯）', () => {
    const strategies = {
      '每個選項節點都選第 0 個': () => 0,
      '每個選項節點都選最後一個': (cur) => cur.choices.length - 1,
    };
    for (const [label, picker] of Object.entries(strategies)) {
      it(label, () => {
        expect(dialogues.size).toBeGreaterThan(0);
        for (const id of dialogues.keys()) {
          const sim = new Sim({ charges: 5 });
          let steps;
          expect(() => { steps = sim.play(id, picker, 200); }, `對話 ${id}`).not.toThrow();
          expect(steps, `對話 ${id}`).toBeLessThanOrEqual(200);
        }
      });
    }
  });
});
