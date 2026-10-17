// E2E 共用工具：錯誤蒐集 fixture、遊戲操作（鍵盤／觸控）、依地圖資料自動尋路。
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installFakeTurnstile } from './fake-turnstile.js';

/** 遊戲資料的 manifest（新遊戲的殘響次數等以它為準，不在測試寫死）。 */
export const MANIFEST = JSON.parse(readFileSync(new URL('../../web/data/manifest.json', import.meta.url), 'utf8'));
export const START_ECHO = MANIFEST.start?.echo_charges ?? 0;

export { expect };

/** 戰鬥第一層的技能（資料的 menu: "root"）；每次重讀，資料重建後不會用到舊值。 */
export function rootSkillIds() {
  const skills = JSON.parse(readFileSync(new URL('../../web/data/skills.json', import.meta.url), 'utf8'));
  return new Set(skills.filter((x) => x.menu === 'root').map((x) => x.id));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const TEST_URL = './?test=1';

/** 每個測試都自動蒐集 console error 與 pageerror，測試結束時必須為空（忽略 GL Driver Message）。 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await installFakeTurnstile(page); // 不連外網：Turnstile 一律用假的（cloud-live 另外處理）
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !/GL Driver Message/.test(m.text())) errors.push(`[console.error] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await use(page);
    expect(errors, '測試過程中不應有 console error 或 pageerror').toEqual([]);
  },
});

// 觸控按鈕在 360x640 邏輯畫面中的中心座標（見 UIScene.buildPanel）
const PAD = { up: [92, 498], down: [92, 606], left: [38, 552], right: [146, 552] };
const ACTION_BTN = { investigate: [276, 498], echo: [276, 552], menu: [276, 606] };
const ARROW = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const DELTA = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
/** 對話框內文字區（點這裡＝下一句；不是選項按鈕的位置）。 */
const DIALOGUE_TAP = [180, 560];
const ACTION_KEY = { investigate: 'Space', echo: 'KeyE', menu: 'Escape' };

/** 合法的序章存檔（預設在閣樓起點）；override 會淺層合併。 */
export function makeSave(override = {}) {
  return {
    schema_version: 1,
    player: { name: '艾琳' },
    lineage: null,
    location: { map: 'attic', x: 2, y: 3, dir: 'down' },
    flags: { 'enter:attic': true },
    items: {},
    echo: { charges: START_ECHO },
    collapse: 0,
    resonance: {},
    chapter: 'prologue',
    chapter_done: [],
    playtime_s: 10,
    ...override,
  };
}

/** 在頁面載入前寫入存檔槽：slots = { 1: 物件或原始字串, ... }。只在第一次載入時寫入。 */
export async function seedSaves(page, slots) {
  const entries = Object.entries(slots).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
  await page.addInitScript((list) => {
    if (sessionStorage.getItem('__sl_seeded')) return;
    sessionStorage.setItem('__sl_seeded', '1');
    for (const [k, v] of list) localStorage.setItem(`steel-labyrinth:save:${k}`, v);
  }, entries);
}

/** data：?data= 測試掛勾的資料位置（例如 '__fixture/dream/'）；尋路讀的地圖資料也從那裡讀。 */
export function game(page, { touch = false, data = 'data/' } = {}) {
  const st = () => page.evaluate(() => window.__SL.getState());
  const scene = () => page.evaluate(() => window.__SL.currentScene());
  const dlg = () => page.evaluate(() => window.__SL.dialogue());
  const key = async (k) => { await page.keyboard.press(k); await sleep(60); };

  const waitScene = (s, timeout = 10_000) =>
    page.waitForFunction((n) => window.__SL?.currentScene() === n, s, { timeout });
  const waitDialogue = (timeout = 5_000) =>
    page.waitForFunction(() => window.__SL.dialogue() !== null, null, { timeout });

  async function tap(lx, ly) {
    const box = await page.locator('canvas').boundingBox();
    await page.touchscreen.tap(box.x + (lx * box.width) / 360, box.y + (ly * box.height) / 640);
    await sleep(60);
  }
  /** 指標點擊邏輯座標：手機用觸控，桌機用滑鼠。 */
  async function pointAt(lx, ly) {
    if (touch) { await tap(lx, ly); return; }
    const box = await page.locator('canvas').boundingBox();
    await page.mouse.click(box.x + (lx * box.width) / 360, box.y + (ly * box.height) / 640);
    await sleep(60);
  }
  /** 等選項按鈕出現後，點第 i 個（可見選項索引）的中心。 */
  async function tapChoice(i) {
    await page.waitForFunction(() => (window.__SL.choiceRects?.() ?? []).length > 0, null, { timeout: 3_000 });
    const rects = await page.evaluate(() => window.__SL.choiceRects());
    const r = rects[i];
    if (!r) throw new Error(`沒有第 ${i} 個選項：${JSON.stringify(rects)}`);
    await pointAt(r.x + r.w / 2, r.y + r.h / 2);
  }
  /** 推進對話直到出現選項節點（不選）。 */
  async function advanceToChoice() {
    let guard = 0;
    for (;;) {
      if (++guard > 100) throw new Error('等不到選項');
      const d = await dlg();
      if (d === null) throw new Error('對話在出現選項前就結束了');
      if (d.choices) return d;
      if (touch) await tap(...DIALOGUE_TAP); else await key('Space');
      await sleep(40);
    }
  }
  /** 方向輸入：手機用觸控十字鍵，桌機用鍵盤。 */
  const press = (dir) => (touch ? tap(...PAD[dir]) : key(ARROW[dir]));
  /** 調查／殘響／選單：手機點按鈕，桌機按鍵。 */
  const act = (name) => (touch ? tap(...ACTION_BTN[name]) : key(ACTION_KEY[name]));

  const fetchJson = (path) => page.evaluate((p) => fetch(p).then((r) => r.json()), path);
  const mapCache = new Map();
  let tilesCache = null;
  async function mapData(id) {
    if (!mapCache.has(id)) mapCache.set(id, await fetchJson(`${data}maps/${id}.json`));
    return mapCache.get(id);
  }
  async function solidTiles() {
    if (!tilesCache) {
      const t = await fetchJson(`${data}tiles.json`);
      const list = Array.isArray(t) ? t : t.tiles;
      tilesCache = new Set(list.filter((x) => x.solid === true).map((x) => x.id));
    }
    return tilesCache;
  }

  /** 播完目前對話；picks 是遇到選項時依序要選的「可見選項索引」。回傳對話逐句紀錄。 */
  async function finishDialogue(picks = []) {
    const transcript = [];
    const queue = [...picks];
    let guard = 0;
    while ((await dlg()) !== null) {
      if (++guard > 300) throw new Error('對話跑不完');
      const d = await dlg();
      if (d.choices) {
        const i = queue.shift();
        if (i === undefined) throw new Error(`出現未預期的選項：${JSON.stringify(d)}`);
        transcript.push(`? ${d.text} -> ${d.choices[i]}`);
        if (touch) {
          // 手機：直接點選項按鈕（不可用鍵盤代替，否則會蓋掉「選項點不到」這類問題）
          await tapChoice(i);
        } else {
          for (let j = 0; j < i; j++) await key('ArrowDown');
          await key('Enter');
        }
      } else {
        transcript.push(`${d.speaker ?? '(旁白)'}：${d.text}`);
        if (touch) await tap(...DIALOGUE_TAP); else await key('Space');
      }
      await sleep(40);
    }
    await sleep(150);
    return transcript;
  }

  /** 從標題開新遊戲到進入地圖（開場對話已開始播放）。 */
  async function newGame(name = '艾琳') {
    await waitScene('Title', 15_000);
    await sleep(300);
    await key('Enter');
    await waitScene('Name');
    await page.fill('.sl-name-input', name);
    await page.press('.sl-name-input', 'Enter');
    await waitScene('Map');
    await waitDialogue();
  }

  /** 走一步並等位置（或地圖）改變。 */
  async function stepDir(dir) {
    const b = (await st()).location;
    await press(dir);
    try {
      await page.waitForFunction(
        ([m, x, y]) => { const l = window.__SL.getState().location; return l.map !== m || l.x !== x || l.y !== y; },
        [b.map, b.x, b.y], { timeout: 3_000 });
    } catch {
      throw new Error(`移動失敗：${dir} 從 ${JSON.stringify(b)}，現在 ${JSON.stringify((await st()).location)}`);
    }
    await sleep(220); // 等補間動畫
  }

  /** 把座標轉成可走判斷：地形不擋、沒有擋路物件、且（除非是目標）不是出口／觸發點。 */
  async function buildWalkable(s, target) {
    const map = await mapData(s.location.map);
    const solid = await solidTiles();
    const H = map.tiles.length;
    const W = Array.from(map.tiles[0]).length;
    const blocking = new Set(
      (map.objects ?? [])
        .filter((o) => o.solid === true && !(o.lock && s.flags[o.lock.flag] === true))
        .map((o) => `${o.x},${o.y}`));
    const special = new Set([...(map.exits ?? []), ...(map.triggers ?? [])].map((e) => `${e.x},${e.y}`));
    const ok = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const id = map.legend[Array.from(map.tiles[y])[x]];
      if (!id || solid.has(id)) return false;
      if (blocking.has(`${x},${y}`)) return false;
      if (target && x === target.x && y === target.y) return true;
      return !special.has(`${x},${y}`);
    };
    return { map, ok };
  }

  /** BFS：回傳從 from 到 goals 之一的方向序列；找不到回 null。 */
  function bfs(from, goals, ok) {
    const goalSet = new Set(goals.map((g) => `${g.x},${g.y}`));
    const seen = new Map([[`${from.x},${from.y}`, null]]);
    const q = [[from.x, from.y]];
    while (q.length) {
      const [x, y] = q.shift();
      if (goalSet.has(`${x},${y}`)) {
        const path = [];
        let k = `${x},${y}`;
        while (seen.get(k)) { const { prev, dir } = seen.get(k); path.unshift(dir); k = prev; }
        return path;
      }
      for (const [dir, [dx, dy]] of Object.entries(DELTA)) {
        const nx = x + dx; const ny = y + dy; const k = `${nx},${ny}`;
        if (seen.has(k) || !ok(nx, ny)) continue;
        seen.set(k, { prev: `${x},${y}`, dir });
        q.push([nx, ny]);
      }
    }
    return null;
  }

  /** 走到 (x, y)（同一張地圖內）。目標可以是出口或觸發點格。 */
  async function goTo(x, y) {
    const s = await st();
    const { ok } = await buildWalkable(s, { x, y });
    const path = bfs(s.location, [{ x, y }], ok);
    if (path === null) throw new Error(`找不到從 ${JSON.stringify(s.location)} 到 (${x},${y}) 的路`);
    for (const d of path) await stepDir(d);
  }

  /** 走到某物件旁邊並面向它（用「撞牆轉向」）。 */
  async function faceObject(id) {
    const s = await st();
    const map = await mapData(s.location.map);
    const obj = map.objects.find((o) => o.id === id);
    if (!obj) throw new Error(`地圖 ${map.id} 沒有物件 ${id}`);
    const { ok } = await buildWalkable(s, null);
    const sides = Object.entries(DELTA).map(([dir, [dx, dy]]) => ({ x: obj.x - dx, y: obj.y - dy, face: dir }))
      .filter((c) => ok(c.x, c.y));
    let best = null;
    for (const c of sides) {
      const p = bfs(s.location, [c], ok);
      if (p && (best === null || p.length < best.path.length)) best = { path: p, c };
    }
    if (!best) throw new Error(`走不到物件 ${id} 旁邊`);
    for (const d of best.path) await stepDir(d);
    if ((await st()).location.dir !== best.c.face) {
      await press(best.c.face); // 撞到物件只會轉向
      await page.waitForFunction((d) => window.__SL.getState().location.dir === d, best.c.face, { timeout: 2_000 });
      await sleep(120);
    }
    return obj;
  }

  /** 面向物件並調查（look）或使用殘響（echo），等到對話開始。 */
  async function useOn(id, kind = 'investigate') {
    await faceObject(id);
    await act(kind);
    await waitDialogue();
  }

  /** 走進某地圖的出口格（依 to 目的地挑第一個），等地圖切換。 */
  async function takeExit(to) {
    const s = await st();
    const map = await mapData(s.location.map);
    const exits = map.exits.filter((e) => e.to === to);
    if (!exits.length) throw new Error(`地圖 ${map.id} 沒有通往 ${to} 的出口`);
    // 走到某個出口的相鄰格，再往出口方向走一步（同一目的地可能有多個出口格，挑最近、走得到的）
    const { ok } = await buildWalkable(s, null);
    let best = null;
    for (const ex of exits) {
      for (const [dir, [dx, dy]] of Object.entries(DELTA)) {
        const c = { x: ex.x - dx, y: ex.y - dy, dir };
        const here = c.x === s.location.x && c.y === s.location.y;
        if (!ok(c.x, c.y) && !here) continue;
        const p = here ? [] : bfs(s.location, [c], ok);
        if (p && (best === null || p.length < best.path.length)) best = { path: p, c };
      }
    }
    if (!best) throw new Error(`走不到出口 ${to}`);
    for (const d of best.path) await stepDir(d);
    const from = (await st()).location.map;
    await press(best.c.dir);
    await page.waitForFunction((m) => window.__SL.getState().location.map !== m, from, { timeout: 4_000 });
    await sleep(200);
  }

  /**
   * 選單（Menu 場景）選某個標籤開頭的項目：桌機用方向鍵移到它再按 Enter，手機直接點。
   * 選單項目的順序會隨資料改變（例如有隊伍時多出「隊伍」），所以一律用標籤找，不寫死位置。
   */
  async function pickMenu(label) {
    await page.waitForFunction((l) => (window.__SL.menu()?.items ?? []).some((it) => it.label.startsWith(l) && it.enabled), label, { timeout: 5_000 });
    if (touch) {
      const it = (await page.evaluate(() => window.__SL.menu().items)).find((x) => x.label.startsWith(label));
      await tap(it.x, it.y);
      return;
    }
    for (let i = 0; i < 12; i++) {
      const items = (await page.evaluate(() => window.__SL.menu().items));
      if (items.find((x) => x.focused)?.label.startsWith(label)) { await key('Enter'); return; }
      await key('ArrowDown');
    }
    throw new Error(`選單裡移不到「${label}」`);
  }

  /** 章節結束畫面：等按鈕出現後選某個標籤（桌機用方向鍵＋Enter，手機直接點）。 */
  async function pickChapterEnd(label) {
    await page.waitForFunction((l) => (window.__SL.debug().chapterEnd?.items ?? []).some((it) => it.label === l), label, { timeout: 8_000 });
    if (touch) {
      const it = (await page.evaluate(() => window.__SL.debug().chapterEnd.items)).find((x) => x.label === label);
      await tap(it.x + it.w / 2, it.y + it.h / 2);
      return;
    }
    for (let i = 0; i < 6; i++) {
      const items = await page.evaluate(() => window.__SL.debug().chapterEnd.items);
      if (items.find((x) => x.focused)?.label === label) { await key('Enter'); return; }
      await key('ArrowDown');
    }
    throw new Error(`章節結束畫面移不到「${label}」`);
  }

  // ---------- 戰鬥 ----------
  const bt = () => page.evaluate(() => window.__SL.battle());

  /**
   * 等到戰鬥需要玩家輸入（選單出現）或戰鬥畫面結束。過程中出現的階段對話（DialogueBox）直接播完。
   * 回傳 __SL.battle()；已離開戰鬥畫面時回 null。
   */
  async function battleWait(timeout = 20_000) {
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > timeout) throw new Error(`戰鬥一直沒有等到輸入：${JSON.stringify(await bt())?.slice(0, 400)}`);
      if ((await scene()) !== 'Battle') return null;
      if (await dlg()) { await finishDialogue(); continue; }
      const b = await bt();
      if (b && b.menu && b.mode !== 'busy') return b;
      await sleep(30);
    }
  }

  /** 戰鬥選單：選標籤符合的按鈕（手機點、桌機用左右鍵移過去再按 Enter）。 */
  async function battleButton(match) {
    const ok = (bb) => (typeof match === 'function' ? match(bb) : bb.label === match);
    const b = await battleWait();
    if (!b) throw new Error('已經不在戰鬥畫面');
    const i = b.menu.buttons.findIndex(ok);
    if (i < 0) throw new Error(`戰鬥選單沒有「${String(match)}」：${JSON.stringify(b.menu.buttons.map((x) => x.label))}`);
    const before = JSON.stringify([b.mode, b.menu.title, b.menu.buttons.map((x) => x.label), b.log.length]);
    if (touch) {
      const r = b.menu.buttons[i];
      await tap(r.x + r.w / 2, r.y + r.h / 2);
    } else {
      const n = b.menu.buttons.length;
      const steps = (i - b.menu.index + n) % n;
      for (let k = 0; k < steps; k++) await key('ArrowRight');
      await key('Enter');
    }
    // 等畫面反應（換頁或開始播放）
    await page.waitForFunction((bf) => {
      const x = window.__SL.battle();
      if (!x) return true;
      return JSON.stringify([x.mode, x.menu?.title ?? null, (x.menu?.buttons ?? []).map((y) => y.label), x.log.length]) !== bf || x.mode === 'busy';
    }, before, { timeout: 5_000 });
  }

  /** 選目標：手機點敵人立繪（我方用指令區的目標按鈕），桌機用左右鍵移動游標再按 Enter。 */
  async function battleTarget(uid) {
    const b = await battleWait();
    if (b.mode !== 'target') throw new Error(`不在選目標模式：${b.mode}`);
    const unit = b.units.find((u) => u.uid === uid);
    if (touch) {
      if (unit.side === 'enemy' && unit.rect) {
        await tap(unit.rect.x + unit.rect.w / 2, unit.rect.y + unit.rect.h / 2);
      } else {
        const r = b.menu.buttons.find((x) => x.uid === uid);
        await tap(r.x + r.w / 2, r.y + r.h / 2);
      }
    } else {
      for (let k = 0; k < 8; k++) {
        const x = await bt();
        if (x.cursor === uid) break;
        await key('ArrowRight');
      }
      if ((await bt()).cursor !== uid) throw new Error(`游標移不到 ${uid}`);
      await key('Enter');
    }
    await page.waitForFunction(() => window.__SL.battle()?.mode !== 'target', null, { timeout: 5_000 });
  }

  /**
   * 下一個指令：{ skill, target? }／{ item, target? }／{ flee:true }。
   * menu: root 的技能（攻擊／開槍／防禦）在根選單；其他技能在「技能」，道具在「道具」。
   */
  async function battleCommand(cmd) {
    const b = await battleWait();
    if (b.mode !== 'root') throw new Error(`不在根選單：${b.mode}`);
    const c = b.commands;
    if (cmd.flee) { await battleButton('逃跑'); return; }
    let needTarget = false;
    if (cmd.skill) {
      const s = c.skills.find((x) => x.id === cmd.skill);
      if (!s) throw new Error(`行動者沒有技能 ${cmd.skill}`);
      needTarget = s.target === 'enemy' || s.target === 'ally';
      if (rootSkillIds().has(s.id)) {
        await battleButton(s.name);
      } else {
        await battleButton('技能');
        await battleButton(s.name);
      }
    } else if (cmd.item) {
      const it = c.items.find((x) => x.id === cmd.item);
      if (!it) throw new Error(`沒有道具 ${cmd.item}`);
      needTarget = it.target === 'enemy' || it.target === 'ally';
      await battleButton('道具');
      await battleButton((x) => x.label.startsWith(it.name));
    }
    if (needTarget) await battleTarget(cmd.target);
  }

  /**
   * 打完一場戰鬥：policy(battle) → 指令。結果畫面出現時按「繼續」回地圖（或 Game Over 時停下）。
   * 回傳 { first（第一個輸入點的摘要）, last（結束時的摘要）, turns }。
   */
  async function fightBattle(policy, { maxTurns = 200 } = {}) {
    let first = null;
    let last = null;
    for (let turn = 0; turn < maxTurns; turn++) {
      const b = await battleWait(30_000);
      if (!b) return { first, last, turns: turn, scene: await scene() };
      if (!first) first = b;
      last = b;
      if (b.mode === 'result') {
        await battleButton('繼續');
        await page.waitForFunction(() => window.__SL.currentScene() !== 'Battle', null, { timeout: 8_000 });
        return { first, last, turns: turn, scene: await scene() };
      }
      if (b.mode !== 'root') {
        // 子選單開著（例如上一輪操作被打斷）：先回根選單
        await battleButton('返回');
        continue;
      }
      await battleCommand(policy(b));
    }
    throw new Error('戰鬥回合數超過上限');
  }

  async function noHScroll() {
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bw: document.body.scrollWidth }));
    expect(r.sw, `documentElement.scrollWidth ${r.sw} 應 <= innerWidth ${r.iw}`).toBeLessThanOrEqual(r.iw);
    expect(r.bw, `body.scrollWidth ${r.bw} 應 <= innerWidth ${r.iw}`).toBeLessThanOrEqual(r.iw);
  }

  return {
    st, scene, dlg, key, sleep, tap, pointAt, tapChoice, advanceToChoice, press, act, waitScene, waitDialogue, finishDialogue, newGame,
    stepDir, goTo, faceObject, useOn, takeExit, mapData, noHScroll, pickMenu, pickChapterEnd,
    bt, battleWait, battleButton, battleTarget, battleCommand, fightBattle,
  };
}
