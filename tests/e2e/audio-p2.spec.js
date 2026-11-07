// M6 P2：探索與戰鬥事件音效（?test=1 NullBackend：__SL.audio().lastSfx 記錄實際送出播放的 cue）。
// 事件鍵 → cue 的對應在 web/audio/catalog.json 的 events；預期序列由同一份資料＋純函式（web/src/audio/events.js）算出。
import { readFileSync } from 'node:fs';
import { test, expect, game, TEST_URL, seedSaves, makeSave } from './helpers.js';
import { battleEventKey } from '../../web/src/audio/events.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const CATALOG = readJson('../../web/audio/catalog.json');
const SKILLS = readJson('../../web/data/skills.json');
const EXPLORE = new Set(['map_investigate', 'map_echo', 'map_door', 'item_get', 'ui_save']);
const BATTLE = new Set(Object.entries(CATALOG.events).filter(([k]) => k.startsWith('battle.')).map(([, v]) => v).filter(Boolean));
const sfx = async (page) => (await page.evaluate(() => window.__SL.audio())).lastSfx;
/** lastSfx 最多保留 200 筆（director.js 的 LAST_MAX）；滿了之後 slice(n) 永遠是空的，「不該響」的斷言會白白通過，所以取起點時先確認還沒滿。 */
const LAST_MAX = 200;
const mark = async (page) => {
  const n = (await sfx(page)).length;
  expect(n, 'lastSfx 快滿了，slice(n) 會看不到新增的音').toBeLessThan(LAST_MAX - 20);
  return n;
};
/** 每個播放要求與結果（played／gap＝同一個 cue 40 ms 內重複被略過／burst＝同時發聲上限）。 */
const requests = async (page) => (await page.evaluate(() => window.__SL.audio())).requests;
/** 從第 n 筆之後、只看某一類的 cue。 */
const since = async (page, n, kinds) => (await sfx(page)).slice(n).filter((x) => kinds.has(x));
/** 從第 n 筆要求之後、戰鬥 cue 的要求（含被節流略過的）。 */
const battleRequests = async (page, n) => (await requests(page)).slice(n).filter((r) => BATTLE.has(r.id));
const BURST_MAX = 3; // 同 web/src/audio/director.js
const BURST_MS = 30;
/**
 * 沒播出的要求是否都有正當理由（依 requests[].t 重算，與畫面更新率無關）：
 * - gap（同 cue 40 ms 內重複）：放行。
 * - burst（同時發聲上限）：只能是一般音效（catalog 沒有 burst 欄位），而且前 30 ms 內真的已有 3 個非 exempt 的音播出（t 已四捨五入，容 1 ms）。
 * 用全部的要求重算（priority 也佔額度，exempt 不算）。
 */
function unjustifiedDrops(all) {
  const played = [];
  const bad = [];
  for (const r of all) {
    const c = CATALOG.cues[r.id];
    if (r.result === 'burst') {
      const n = played.filter((t) => r.t - t < BURST_MS + 1).length;
      if (c?.burst !== undefined || n < BURST_MAX) bad.push(r);
    } else if (r.result === 'played') {
      if (c?.burst !== 'exempt') played.push(r.t);
    } else if (r.result !== 'gap') bad.push(r);
  }
  return bad;
}
/**
 * TEST_MODE 下每個會出聲的戰鬥事件之後都有一次 delayedCall（下一個影格才處理下一個事件），所以相鄰的戰鬥音效一定落在不同影格
 * （requests[].f＝送出時 Phaser 的 game.loop.frame）。整回合的音效被擠在同一影格送出（例如 playLog 少了 await）時，
 * 上面的重算會把 burst 當成合理、毫秒也可能被同步繪圖拉開，只有影格編號抓得到。與畫面更新率無關。
 */
function sameFrameBattleCues(req) {
  return req.filter((r, i) => i > 0 && r.f !== null && r.f === req[i - 1].f);
}

/** 依戰鬥 log 算出預期的 cue 序列（同一份對應表與純函式）。 */
function expectedBattleCues(b) {
  const side = Object.fromEntries(b.units.map((u) => [u.uid, u.side]));
  const ctx = { sideOf: (uid) => side[uid] ?? null, skillOf: (id) => SKILLS.find((s) => s.id === id) ?? null };
  return b.log.map((ev) => battleEventKey(ev, ctx)).filter(Boolean).map((k) => CATALOG.events[k]).filter(Boolean);
}

test.describe('M6 P2 探索音效', () => {
  test('調查、取得道具、開鎖、換地圖：依序要求播放對應音效；對空地調查或殘響不響', async ({ page }, testInfo) => {
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await g.newGame('艾琳');
    await g.finishDialogue();
    let n = await mark(page);

    // 對空地：殘響與調查都不響
    await g.stepDir('right');
    await g.act('echo');
    await g.act('investigate');
    await g.sleep(250);
    expect(await since(page, n, EXPLORE)).toEqual([]);

    // 沒有鑰匙調查門：只有調查音（門沒開）
    n = await mark(page);
    await g.useOn('obj_door');
    await g.finishDialogue();
    expect(await since(page, n, EXPLORE)).toEqual(['map_investigate']);

    // 五斗櫃撬出鑰匙：調查音，接著取得道具
    n = await mark(page);
    await g.useOn('obj_drawer');
    await g.finishDialogue([0]);
    expect((await g.st()).items.attic_key).toBe(1);
    expect(await since(page, n, EXPLORE)).toEqual(['map_investigate', 'item_get']);

    // 帶著鑰匙調查門：同一下就開鎖，只響開鎖（門）音，調查音讓位（不疊兩聲）
    n = await mark(page);
    await g.useOn('obj_door');
    await g.finishDialogue();
    expect((await g.st()).flags.door_open).toBe(true);
    expect(await since(page, n, EXPLORE)).toEqual(['map_door']);

    // 走出門到走廊：換地圖音
    n = await mark(page);
    await g.takeExit('hallway');
    expect(await since(page, n, EXPLORE)).toEqual(['map_door']);
  });

  test('殘響：對有殘響的物件使用時響（藥瓶），殘響開門也響開鎖音', async ({ page }, testInfo) => {
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await g.newGame('艾琳');
    await g.finishDialogue();
    let n = await mark(page);
    await g.useOn('obj_vial', 'echo');
    await g.finishDialogue();
    expect(await since(page, n, EXPLORE)).toEqual(['map_echo']);
    n = await mark(page);
    await g.useOn('obj_door', 'echo');
    await g.finishDialogue();
    // 殘響開鎖比照調查開鎖：只響門聲（殘響音讓位），同時取得鑰匙
    expect(await since(page, n, EXPLORE)).toEqual(['map_door', 'item_get']);
  });

  test('存檔成功：ui_save；遊戲中讀取另一個存檔（道具較多、地圖不同）不響', async ({ page }, testInfo) => {
    await seedSaves(page, { 1: makeSave(), 3: bossSave() });
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await g.key('ArrowDown');
    await g.key('Enter');
    await g.waitScene('Menu');
    let n = await mark(page);
    await g.pickMenu('存檔 1');
    await g.waitScene('Map');
    expect(await since(page, n, EXPLORE)).toEqual([]);
    await g.act('menu');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await g.pickMenu('存檔');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save');
    n = await mark(page);
    await g.pickMenu('存檔 2');
    await page.waitForFunction(() => /已存檔到存檔 2/.test(window.__SL.menu()?.note ?? ''), null, { timeout: 5_000 });
    expect(await since(page, n, EXPLORE)).toEqual(['ui_save']);
    // 遊戲中讀取存檔 3（倉庫、帶著好幾樣道具）：不是換地圖，也不是取得道具
    await g.pickMenu('返回');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await g.pickMenu('讀取');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'load');
    n = await mark(page);
    await g.pickMenu('存檔 3');
    await g.waitScene('Map');
    await page.waitForFunction(() => window.__SL.getState()?.location.map === 'warehouse');
    await g.sleep(300);
    expect(await since(page, n, EXPLORE)).toEqual([]);
  });

  test('畫面上的「調查」「殘響」按鈕不播確認音（交給事件音，與鍵盤一致）', async ({ page }, testInfo) => {
    test.skip(!isTouch(testInfo), '觸控按鈕：手機版測');
    const g = game(page, { touch: true });
    await page.goto(TEST_URL);
    await g.newGame('艾琳');
    await g.finishDialogue();
    await g.stepDir('right');
    let n = await mark(page);
    await g.act('investigate'); // 面前沒有東西
    await g.act('echo');
    await g.sleep(250);
    expect((await sfx(page)).slice(n)).toEqual([]);
    await g.faceObject('obj_door');
    n = await mark(page);
    await g.act('investigate');
    await g.waitDialogue();
    expect((await sfx(page)).slice(n)).toEqual(['map_investigate']);
    await g.finishDialogue();
  });
});

/** 第二章 Boss 前的存檔（同 battle.spec.js 的 bossSave）。 */
function bossSave() {
  return {
    ...makeSave(), schema_version: 2, lineage: { id: 'trace', rank: 9 }, location: { map: 'warehouse', x: 7, y: 3, dir: 'up' },
    flags: {
      'enter:office': true, 'enter:training': true, 'enter:dock': true, 'enter:warehouse': true, drank_potion: true, sparred: true,
      fog1_done: true, fog2_done: true, fog3_done: true, boss_warned: true, ch2_deduced: true, wh_door_open: true,
    },
    items: { revolver: 1, bandage: 2, sedative_incense: 1, warehouse_key: 1 }, echo: { charges: 0 }, collapse: 10,
    resonance: { clue_found: 3, deduction_correct: 1 }, chapter: 'chapter2', chapter_done: ['prologue', 'chapter1'],
    party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }], ammo: 12, pending: null,
  };
}

/** 同 battle.spec.js 的 basicPolicy（自成一體：原始碼也送進頁面給 simulate 找種子）。 */
function basicPolicy(view) {
  const lowest = (list) => list.reduce((a, u) => (a === null || u.hp / u.maxHp < a.hp / a.maxHp ? u : a), null);
  const usable = (id) => view.commands.skills.find((s) => s.id === id && s.usable);
  const party = view.units.filter((u) => u.side === 'party' && u.alive);
  const hurt = lowest(party.filter((u) => u.hp / u.maxHp < 0.35));
  if (hurt && view.commands.items.some((i) => i.id === 'bandage')) return { item: 'bandage', target: hurt.uid };
  if (view.collapse >= 60 && usable('requiem')) return { skill: 'requiem', target: view.actor.uid };
  const target = lowest(view.units.filter((u) => u.side === 'enemy' && u.alive)).uid;
  if (usable('shoot')) return { skill: 'shoot', target };
  return { skill: 'attack', target };
}
function guardPolicy() { return { skill: 'guard' }; }

/** 用遊戲自己的 simulate 找一個結果在 want 裡的種子，放進網址（同 battle.spec.js）。 */
async function useSeedFor(page, enc, want, policy) {
  const seed = await page.evaluate(async ({ enc, src, want }) => {
    const { simulate } = await window.__slImport('./src/core/battle/engine.js');
    const { session } = await window.__slImport('./src/session.js');
    const pol = new Function(`return (${src});`)();
    const state = window.__SL.getState();
    const toCmd = (c) => (c.flee ? { type: 'flee' } : c.item ? { type: 'item', item: c.item, target: c.target } : { type: 'skill', skill: c.skill, target: c.target });
    for (let seed = 1; seed <= 400; seed++) {
      const r = simulate(enc, state, session.data, seed, (b, cmds) => toCmd(pol({
        actor: { uid: cmds.actor },
        units: b.units.map((u) => ({ uid: u.uid, side: u.side, alive: u.alive, hp: u.hp, maxHp: u.stats.hp })),
        collapse: b.collapse,
        commands: cmds,
      })));
      if (want.includes(r.outcome)) return seed;
    }
    return null;
  }, { enc, src: policy.toString(), want });
  expect(seed, `找不到 ${enc} 結果為 ${want} 的種子`).not.toBeNull();
  await page.evaluate((s) => history.replaceState(null, '', `${location.pathname}?test=1&seed=${s}`), seed);
}

async function bossBattle(page, testInfo, want, policy) {
  test.setTimeout(240_000);
  await seedSaves(page, { 1: bossSave() });
  const g = game(page, { touch: isTouch(testInfo) });
  await page.goto(TEST_URL);
  await g.waitScene('Title', 15_000);
  await g.sleep(300);
  await g.key('ArrowDown');
  await g.key('Enter');
  await g.waitScene('Menu');
  await g.pickMenu('存檔 1');
  await g.waitScene('Map');
  await useSeedFor(page, 'enc_boss', [want], policy);
  await g.act('investigate');
  await g.waitDialogue();
  await g.finishDialogue();
  await g.waitScene('Battle');
  const n = await mark(page);
  const rn = (await requests(page)).length;
  // 打到結果畫面為止（先不按「繼續」）。Boss 戰輸了不顯示結果畫面、直接進 Game Over：這時回傳最後看到的戰鬥摘要
  let b = null;
  for (let turn = 0; turn < 200; turn++) {
    const x = await g.battleWait(30_000);
    if (!x) break;
    b = x;
    if (b.mode === 'result') break;
    if (b.mode !== 'root') { await g.battleButton('返回'); continue; }
    await g.battleCommand(policy(b));
  }
  return { g, b, got: await since(page, n, BATTLE), req: await battleRequests(page, rn), all: (await requests(page)).slice(rn), scene: await g.scene() };
}

test.describe('M6 P2 戰鬥音效', () => {
  test('一場戰鬥從開始到勝利：要求播放的序列與依 log 推出的預期序列完全相等，只容許同 cue 40 ms 內重複被略過，最後是勝利短樂句', async ({ page }, testInfo) => {
    const { b, got, req, all } = await bossBattle(page, testInfo, 'victory', basicPolicy);
    expect(b.mode).toBe('result');
    const want = expectedBattleCues(b);
    expect(want.at(-1)).toBe('jingle_victory');
    // 要求的序列與依 log 推出的預期序列完全相等；沒播出的都要有正當理由（unjustifiedDrops），相鄰戰鬥音效不能在同一影格（sameFrameBattleCues）
    expect(req.map((r) => r.id)).toEqual(want);
    expect(unjustifiedDrops(all)).toEqual([]);
    expect(sameFrameBattleCues(req)).toEqual([]);
    expect(req.every((r) => Number.isInteger(r.f))).toBe(true);
    expect(got).toEqual(req.filter((r) => r.result === 'played').map((r) => r.id));
    expect(got.at(-1)).toBe('jingle_victory');
  });

  test('戰敗：預期序列是要求序列的前綴，最後是戰敗短樂句；重新挑戰不響探索音', async ({ page }, testInfo) => {
    const { g, b, got, req, all, scene } = await bossBattle(page, testInfo, 'defeat', guardPolicy);
    expect(scene).toBe('GameOver');
    // 最後一次輸入時的 log 推得出的預期序列，必須是要求序列的前綴（之後的事件 log 已隨場景結束）
    const before = expectedBattleCues(b);
    expect(req.slice(0, before.length).map((r) => r.id)).toEqual(before);
    expect(unjustifiedDrops(all)).toEqual([]);
    expect(sameFrameBattleCues(req)).toEqual([]);
    expect(req.every((r) => Number.isInteger(r.f))).toBe(true);
    expect(got.at(-1)).toBe('jingle_defeat');
    expect(got.filter((x) => x === 'jingle_defeat')).toHaveLength(1);
    expect(got).not.toContain('jingle_victory');
    // 「重新挑戰」回到戰前狀態：先把目前的道具清掉（模擬戰鬥中用掉），重新挑戰時道具數量變回來不是「取得道具」，也不是換地圖
    await page.evaluate(async () => {
      const { session } = await window.__slImport('./src/session.js');
      session.setState({ ...session.state, items: {} });
    });
    const n = await mark(page);
    const go = await page.evaluate(() => window.__SL.gameOver());
    const retry = go.items.find((x) => x.label === '重新挑戰');
    await g.pointAt(retry.x + retry.w / 2, retry.y + retry.h / 2);
    await g.waitScene('Battle');
    await g.battleWait();
    expect(await since(page, n, EXPLORE)).toEqual([]);
  });
});
