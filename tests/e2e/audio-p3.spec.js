// M6 P3：背景音樂與環境音的場景切換（?test=1 NullBackend：__SL.audio() 的 bgm／amb／battle／paused／music 記錄 director 的選曲）。
// 選曲規則是 web/src/audio/pick.js（單元測試）；這裡驗證實際遊玩時各畫面有接到、順序正確。
import { readFileSync } from 'node:fs';
import { test, expect, game, TEST_URL, seedSaves, makeSave } from './helpers.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const MAPS = Object.fromEntries(['attic', 'warehouse'].map((id) => [id, readJson(`../../web/data/maps/${id}.json`)]));
const audio = (page) => page.evaluate(() => window.__SL.audio());
const waitMusic = (page, want, timeout = 5_000) => page.waitForFunction((w) => {
  const a = window.__SL.audio();
  return Object.entries(w).every(([k, v]) => JSON.stringify(a[k]) === JSON.stringify(v));
}, want, { timeout });
const lastMusic = async (page, n) => (await audio(page)).music.slice(-n).map((m) => [m.bgm, m.amb, m.battle]);

/** 同 audio-p2.spec.js：用遊戲自己的 simulate 找結果在 want 裡的種子，放進網址。 */
async function useSeedFor(page, enc, want, policySrc) {
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
  }, { enc, src: policySrc, want });
  expect(seed, `找不到 ${enc} 結果為 ${want} 的種子`).not.toBeNull();
  await page.evaluate((s) => history.replaceState(null, '', `${location.pathname}?test=1&seed=${s}`), seed);
}
const fleePolicy = () => ({ flee: true });
const guardPolicy = () => ({ skill: 'guard' });

/** 第二章 Boss 前的存檔（同 audio-p2.spec.js）。 */
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

test.describe('M6 P3 背景音樂與環境音', () => {
  test('標題（解鎖後才播主題曲）→ 新遊戲閣樓 → 地圖上開戰 → 逃跑回地圖：地圖曲暫停後接回；入夢換夢境曲、醒來回原曲', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    // 還沒有手勢：只記下想播的，不播
    expect(await audio(page)).toMatchObject({ unlocked: false, bgm: null, amb: null, music: [] });
    await g.newGame('艾琳');
    // 進入取名畫面前就有手勢了：標題主題曲（取名畫面延續同一首，不重播）
    expect((await audio(page)).music[0]).toMatchObject({ bgm: 'bgm_theme', amb: null, battle: false });
    await g.finishDialogue();
    // 閣樓：資料指定隔窗雨聲；bgm 沒寫，用預設的城市曲
    expect(Object.hasOwn(MAPS.attic, 'bgm')).toBe(false);
    await waitMusic(page, { bgm: 'bgm_city', amb: MAPS.attic.amb, battle: false });
    expect((await audio(page)).music.filter((m) => m.bgm === 'bgm_theme')).toHaveLength(1);

    // 在地圖上開一場可以逃跑的戰鬥（找一個「逃跑成功」的種子），用遊戲自己的開戰流程
    await useSeedFor(page, 'enc_dock_1', ['fled'], fleePolicy.toString());
    await page.evaluate(async () => {
      const { game: phaser } = await window.__slImport('./src/main.js');
      phaser.scene.getScene('Map').doBattle('enc_dock_1');
    });
    await g.waitScene('Battle');
    // 戰鬥：一般戰鬥曲；地圖曲暫停並記住；環境音沿用（後端壓低）
    await waitMusic(page, { bgm: 'bgm_battle', amb: MAPS.attic.amb, battle: true });
    expect((await audio(page)).paused).toMatchObject({ id: 'bgm_city' });
    const r = await g.fightBattle(fleePolicy);
    expect(r.scene).toBe('Map');
    await waitMusic(page, { bgm: 'bgm_city', amb: MAPS.attic.amb, battle: false, paused: null });
    expect(await lastMusic(page, 3)).toEqual([
      ['bgm_city', MAPS.attic.amb, false], ['bgm_battle', MAPS.attic.amb, true], ['bgm_city', MAPS.attic.amb, false],
    ]);

    // 地圖改變（入夢）：夢境地圖沒寫 bgm／amb → 目錄的夢境預設；回到閣樓 → 原曲
    await page.evaluate(async () => {
      const { session } = await window.__slImport('./src/session.js');
      const d = session.data.maps.find((m) => m.dream === true);
      window.__slBack = session.state.location;
      session.setState({ ...session.state, location: { ...session.state.location, map: d.id } });
    });
    await waitMusic(page, { bgm: 'bgm_dream', amb: 'amb_clock' });
    await page.evaluate(async () => {
      const { session } = await window.__slImport('./src/session.js');
      session.setState({ ...session.state, location: window.__slBack });
    });
    await waitMusic(page, { bgm: 'bgm_city', amb: MAPS.attic.amb });

    // 選單開關不換曲
    const before = (await audio(page)).music.length;
    await g.act('menu');
    await g.waitScene('Menu');
    await g.key('Escape');
    await g.waitScene('Map');
    await g.sleep(200);
    expect((await audio(page)).music).toHaveLength(before);
  });

  test('Boss 戰：Boss 曲；沒有背景音樂的地圖（倉庫）不暫停任何曲子；戰敗 → Game Over 安靜 → 重新挑戰 Boss 曲從頭', async ({ page }, testInfo) => {
    test.skip(isTouch(testInfo), '選曲與輸入方式無關，只跑 desktop（觸控的戰鬥流程在 battle.spec.js）');
    test.setTimeout(240_000);
    await seedSaves(page, { 1: bossSave() });
    const g = game(page);
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await g.key('ArrowDown');
    await g.key('Enter');
    await g.waitScene('Menu');
    await g.pickMenu('存檔 1');
    await g.waitScene('Map');
    await waitMusic(page, { bgm: MAPS.warehouse.bgm, amb: MAPS.warehouse.amb, battle: false });
    expect(MAPS.warehouse.bgm).toBeNull();
    await useSeedFor(page, 'enc_boss', ['defeat'], guardPolicy.toString());
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    await waitMusic(page, { bgm: 'bgm_boss', amb: MAPS.warehouse.amb, battle: true, paused: null });
    for (let turn = 0; turn < 200; turn++) {
      const b = await g.battleWait(30_000);
      if (!b) break;
      if (b.mode !== 'root') { await g.battleButton('返回'); continue; }
      await g.battleCommand(guardPolicy());
    }
    await g.waitScene('GameOver');
    await waitMusic(page, { bgm: null, amb: null, battle: false, paused: null });
    const go = await page.evaluate(() => window.__SL.gameOver());
    const retry = go.items.find((x) => x.label === '重新挑戰');
    await g.pointAt(retry.x + retry.w / 2, retry.y + retry.h / 2);
    await g.waitScene('Battle');
    await waitMusic(page, { bgm: 'bgm_boss', battle: true });
    expect(await lastMusic(page, 3)).toEqual([['bgm_boss', MAPS.warehouse.amb, true], [null, null, false], ['bgm_boss', null, true]]);
  });
});
