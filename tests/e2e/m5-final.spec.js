// M5 正式資料：讀第七章最終戰前的存檔（燈室、面向潮汐祭司）→ 打贏祭司 → 摀住耳朵、打贏潮兆 → 第七章結束畫面「繼續」
// → 終章開場 → 結局判定 → 結局畫面顯示結局名稱。戰鬥種子用遊戲自己的 simulate 找（數值調整後不必改測試）。
import { readFileSync } from 'node:fs';
import { test, expect, game, TEST_URL, seedSaves } from './helpers.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const readData = (rel) => JSON.parse(readFileSync(new URL(`../../web/data/${rel}`, import.meta.url), 'utf8'));
const FINALE = readData('story/finale.json');
const CH7 = readData('story/chapter7.json');

/**
 * 策略（自成一體：同一份原始碼也拿到頁面裡給 simulate 找種子用）。
 * 崩解 ≥ 40 艾妲鎮魂；有人生命 < 35% 用繃帶；其他人攻擊生命比例最低的敵人。
 */
function finalPolicy(view) {
  const lowest = (list) => list.reduce((a, u) => (a === null || u.hp / u.maxHp < a.hp / a.maxHp ? u : a), null);
  const usable = (id) => view.commands.skills.find((s) => s.id === id && s.usable);
  const party = view.units.filter((u) => u.side === 'party' && u.alive);
  const hurt = lowest(party.filter((u) => u.hp / u.maxHp < 0.35));
  if (hurt && view.commands.items.some((i) => i.id === 'bandage')) return { item: 'bandage', target: hurt.uid };
  if (view.collapse >= 40 && usable('requiem')) return { skill: 'requiem', target: view.actor.uid };
  const target = lowest(view.units.filter((u) => u.side === 'enemy' && u.alive)).uid;
  return { skill: 'attack', target };
}

/** 從目前 state 找一個 enc 會打贏的種子，放進網址（battleSeed() 每場戰鬥都重讀）。 */
async function useSeedFor(page, enc) {
  const seed = await page.evaluate(async ({ enc, src }) => {
    const { simulate } = await import('./src/core/battle/engine.js');
    const { session } = await import('./src/session.js');
    const pol = new Function(`return (${src});`)();
    const state = window.__SL.getState();
    const toCmd = (c) => (c.item ? { type: 'item', item: c.item, target: c.target } : { type: 'skill', skill: c.skill, target: c.target });
    for (let seed = 1; seed <= 600; seed++) {
      const r = simulate(enc, state, session.data, seed, (b, cmds) => toCmd(pol({
        actor: { uid: cmds.actor },
        units: b.units.map((u) => ({ uid: u.uid, side: u.side, alive: u.alive, hp: u.hp, maxHp: u.stats.hp })),
        collapse: b.collapse,
        commands: cmds,
      })));
      if (r.outcome === 'victory') return seed;
    }
    return null;
  }, { enc, src: finalPolicy.toString() });
  expect(seed, `找不到 ${enc} 會贏的種子`).not.toBeNull();
  await page.evaluate((n) => history.replaceState(null, '', `${location.pathname}?test=1&seed=${n}`), seed);
}

/** 第七章最終戰前的 v4 存檔：舊燈塔燈室、面向潮汐祭司；照實陳述的路線（主角＋艾妲，馬洛之後趕到）。 */
function finalSave() {
  const enter = ['office_ch7', 'harbor_night', 'breakwater', 'clocktower_ch7', 'lighthouse', 'lighthouse_top'];
  return {
    schema_version: 4,
    player: { name: '艾琳' },
    lineage: { id: 'trace', rank: 7 },
    location: { map: 'lighthouse_top', x: 6, y: 3, dir: 'up' },
    flags: {
      ...Object.fromEntries(enter.map((m) => [`enter:${m}`, true])),
      dream_unlocked: true, marlo_trusted: true, inspector_convinced: true, owen_spoke: true, ch6_mirror_heard: true,
      ch7_started: true, ch7_foreman: true, ch7_gate_open: true, ch7_procession: true, ch7_harbor1_done: true, ch7_harbor2_done: true,
      ch7_deduced: true, ch7_breakwater_done: true, ch7_drowned: true, ch7_promoted: true, ch7_chair_done: true, ch7_woke: true,
      ch7_outer_open: true, ch7_lh1_done: true, ch7_got_lantern_key: true, ch7_inner_open: true, ch7_rest_landing: true,
    },
    items: { sedative_incense: 2, tonic: 1, revolver: 1 },
    echo: { charges: 0 },
    collapse: 20,
    resonance: {},
    chapter: 'chapter7',
    chapter_done: ['prologue', 'chapter1', 'chapter2', 'chapter3', 'chapter4', 'chapter5', 'chapter6'],
    playtime_s: 7200,
    party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }],
    ammo: 0,
    pending: null,
    dream_return: null,
    promotions: [
      { lineage: 'trace', rank: 8, forced: false, chapter: 'chapter4' },
      { lineage: 'trace', rank: 7, forced: false, chapter: 'chapter7' },
    ],
    ending: null,
  };
}

async function loadSlot(g) {
  await g.waitScene('Title', 15_000);
  await g.sleep(300);
  await g.key('ArrowDown');
  await g.key('Enter');
  await g.waitScene('Menu');
  await g.sleep(100);
  await g.key('Enter');
}

test.describe('M5 最終戰與結局（正式資料）', () => {
  test('第七章最終戰前的存檔 → 打贏祭司與潮兆 → 終章 → 結局畫面顯示結局名稱', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: finalSave() });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await loadSlot(g);
    await g.waitScene('Map');
    expect((await g.st()).location.map).toBe('lighthouse_top');

    // 祭司戰
    await useSeedFor(page, 'enc_ch7_priest');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]); // 「鐘不會停。」
    await g.waitScene('Battle');
    let r = await g.fightBattle(finalPolicy, { maxTurns: 400 });
    expect(r.last.result.outcome).toBe('victory');

    // 祭司倒下 → 馬洛趕到 → 潮兆說話：在選項前找潮兆戰的種子，選「摀住耳朵，看著它。」
    await g.waitDialogue();
    const d = await g.advanceToChoice();
    expect(d.choices.some((c) => c.includes('摀住耳朵'))).toBe(true);
    expect((await g.st()).party.map((m) => m.id)).toEqual(['hero', 'ada', 'marlo']);
    await useSeedFor(page, 'enc_ch7_omen');
    await g.finishDialogue([d.choices.findIndex((c) => c.includes('摀住耳朵'))]);
    await g.waitScene('Battle');
    expect((await g.bt()).encounter).toBe('enc_ch7_omen');
    r = await g.fightBattle(finalPolicy, { maxTurns: 600 });
    expect(r.last.result.outcome).toBe('victory');

    // 勝利對話（崩解快照）→ 第七章結束畫面 →「繼續」進終章
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('ChapterEnd');
    await page.waitForFunction(() => (window.__SL.debug().chapterEnd?.items ?? []).length > 0);
    let ce = (await page.evaluate(() => window.__SL.debug())).chapterEnd;
    expect(ce.title).toBe(CH7.end_screen.title);
    const s7 = await g.st();
    expect(s7.chapter_done).toContain('chapter7');
    expect(s7.flags.ch7_omen_done).toBe(true);
    await g.pickChapterEnd('繼續');
    await g.waitDialogue();
    await g.finishDialogue(); // 終章開場 → resolve_ending → 結局對話

    // 結局畫面：結局名稱、第一部完、致謝（資料提供）
    await g.waitScene('ChapterEnd');
    await page.waitForFunction(() => window.__SL.debug().chapterEnd?.ending);
    ce = (await page.evaluate(() => window.__SL.debug())).chapterEnd;
    const s = await g.st();
    const ending = FINALE.endings.find((e) => e.id === s.ending);
    expect(ending, `state.ending＝${s.ending}`).toBeTruthy();
    // 照實陳述＋站在隊長這邊：崩解 ≤ 40 → 燈火未熄，否則黎明之前（沒有回應潮水，不會是霧中行者）
    expect(s.ending).toBe(s.flags.final_calm ? 'lamp_kept' : 'dawn');
    expect(ce.ending).toMatchObject({ id: ending.id, title: ending.title, partTitle: FINALE.end_screen.title });
    expect(ce.title).toBe(FINALE.end_screen.title);
    expect(ce.credits).toEqual(FINALE.end_screen.credits.map((l) => l.replaceAll('{name}', '艾琳')));
    expect(s.chapter_done).toContain('finale');
    if (touch) await page.screenshot({ path: testInfo.outputPath('m5-final-ending-mobile.png') });
  });
});
