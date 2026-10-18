// M5 畫面層：晉升（演出、隊伍選單的晉升進度、硬喝、材料不足）、交換、結局畫面、借聲／換影的地圖互動、HUD 階位名稱。
// 用 tests/fixtures/m5 的測試資料（?data= 測試掛勾）；正式第四章～終章建置進 web/data 之前不依賴正式內容。
import { test, expect, game, seedSaves } from './helpers.js';
import { dreamUi } from './dream-ui.js';
import { useM5Fixture, makeSaveV4, dreamSave, M5_URL, M5_DATA, shot, waitPromotionFx, dismissPromotionFx } from './m5-fixture.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const hud = (page) => page.evaluate(() => window.__SL.hud());
const menu = (page) => page.evaluate(() => window.__SL.menu());

async function start(page, testInfo, slots) {
  const touch = isTouch(testInfo);
  await useM5Fixture(page);
  await seedSaves(page, slots);
  await page.goto(M5_URL);
  const g = game(page, { touch, data: M5_DATA });
  const u = dreamUi(page, g, touch);
  await u.loadFromTitle(1);
  return { g, u, touch };
}

/** 選對話選項（可見選項索引）：手機點按鈕，桌機方向鍵＋Enter。 */
async function choose(g, touch, i) {
  if (touch) { await g.tapChoice(i); return; }
  for (let j = 0; j < i; j++) await g.key('ArrowDown');
  await g.key('Enter');
}

/** 選單按鈕都在畫面內、高度至少 44px。 */
function expectTappable(items) {
  for (const it of items) {
    expect(it.h, `「${it.label}」高度`).toBeGreaterThanOrEqual(44);
    expect(it.x - it.w / 2).toBeGreaterThanOrEqual(0);
    expect(it.x + it.w / 2).toBeLessThanOrEqual(360);
    expect(it.y - it.h / 2).toBeGreaterThanOrEqual(0);
    expect(it.y + it.h / 2).toBeLessThanOrEqual(640);
  }
}

test.describe('M5 晉升', () => {
  test('隊伍選單的晉升進度 → 喝下靈劑的演出 → 新階位、能力、HUD 階位名稱', async ({ page }, testInfo) => {
    const { g, touch } = await start(page, testInfo, { 1: makeSaveV4({ items: { echo_moss: 2, choir_wax: 1 }, resonance: { a: 9, b: 3 } }) });
    let h = await hud(page);
    expect(h.rank).toBe('讀痕者');
    expect(h.resonance).toBe('共鳴 12/12');

    // 選單 → 隊伍 → 晉升進度
    await g.act('menu');
    await g.waitScene('Menu');
    await g.pickMenu('隊伍');
    await g.pickMenu('晉升進度');
    let m = await menu(page);
    expect(m.page).toBe('promotion');
    expect(m.note).toContain('目前：讀痕者（階 9）');
    expect(m.note).toContain('下一階：借聲者（階 8）');
    expect(m.note).toContain('・回聲苔　2／2　已備齊');
    expect(m.note).toContain('・唱詩蠟　1／1　已備齊');
    expect(m.note).toMatch(/共鳴　12／12/);
    expect(m.note).toMatch(/可以喝下靈劑/);
    expectTappable(m.items);
    await g.pickMenu('返回');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'party');
    await g.key('Escape');
    await g.key('Escape');
    await g.waitScene('Map');

    // 喝下：演出（畫面暗下、鏡面、新階位名稱、獲得的能力）
    await g.useOn('obj_fx5_mirror');
    await g.advanceToChoice();
    await choose(g, touch, 0); // 喝下靈劑：演出出現時對話框暫停
    const fx = await waitPromotionFx(page);
    expect(fx).toMatchObject({ forced: false, name: '借聲者', rank: 8, title: '晉升' });
    expect(fx.lines).toContain('獲得探索能力【借聲】');
    expect(fx.lines).toContain('新技能：借來的聲音');
    expect(fx.mirror).toBe(true);
    expect(fx.dim).toBeGreaterThanOrEqual(0.7);
    if (touch) await shot(page, testInfo, 'm5-promotion');
    // 演出期間不能移動、對話不前進
    expect((await page.evaluate(() => window.__SL.dialogue()))).not.toBeNull();
    await dismissPromotionFx(page, g, touch);
    const rest = await g.finishDialogue();
    expect(rest).toContain('(旁白)：鏡面恢復了平靜。');
    const s = await g.st();
    expect(s.lineage).toEqual({ id: 'trace', rank: 8 });
    expect(s.items).toEqual({});
    expect(s.resonance).toEqual({});
    expect(s.promotions).toEqual([{ lineage: 'trace', rank: 8, forced: false, chapter: 'fx_ch4' }]);
    h = await hud(page);
    expect(h.rank).toBe('借聲者');
    expect(h.resonance).toBe('共鳴 0/8');
  });

  test('硬喝（共鳴不足）：不同的演出與崩解提示', async ({ page }, testInfo) => {
    const { g, touch } = await start(page, testInfo, { 1: makeSaveV4({ items: { echo_moss: 2, choir_wax: 1 }, resonance: { a: 2 }, collapse: 12 }) });
    await g.act('menu');
    await g.waitScene('Menu');
    await g.pickMenu('隊伍');
    await g.pickMenu('晉升進度');
    expect((await menu(page)).note).toMatch(/硬喝會讓崩解 \+40/);
    await g.key('Escape');
    await g.key('Escape');
    await g.key('Escape');
    await g.waitScene('Map');
    await g.useOn('obj_fx5_mirror');
    await g.advanceToChoice();
    await choose(g, touch, 0);
    const fx = await waitPromotionFx(page);
    expect(fx).toMatchObject({ forced: true, title: '強行晉升', name: '借聲者', collapseGain: 40 });
    expect(fx.warning).toMatch(/共鳴不足/);
    expect(fx.lines).toContain('崩解 +40（目前 52／100）');
    expect(fx.cracks).toBeGreaterThan(0);
    if (touch) await shot(page, testInfo, 'm5-promotion-forced');
    await dismissPromotionFx(page, g, touch);
    await g.finishDialogue();
    const s = await g.st();
    expect(s.collapse).toBe(52);
    expect(s.promotions[0].forced).toBe(true);
    expect((await hud(page)).collapse).toBe('崩解 52/100');
  });

  test('材料不足：顯示原因與缺少的材料，不晉升', async ({ page }, testInfo) => {
    const { g } = await start(page, testInfo, { 1: makeSaveV4({ items: { echo_moss: 1 } }) });
    await g.useOn('obj_fx5_mirror');
    const t = await g.finishDialogue([0]);
    // 喝下的選項 → 鏡面恢復平靜（原對話）→ promote_failed 的說明
    expect(t.join('\n')).toMatch(/材料不足/);
    expect(t.join('\n')).toMatch(/回聲苔 1／2/);
    expect(t.join('\n')).toMatch(/唱詩蠟 0／1/);
    expect(await hud(page).then((x) => x.promotion)).toBeFalsy();
    const s = await g.st();
    expect(s.lineage).toEqual({ id: 'trace', rank: 9 });
    expect(s.items).toEqual({ echo_moss: 1 });
    expect(s.pending).toBeNull();
  });
});

test.describe('M5 交換', () => {
  test('夢客的交換清單：持有數、材料不足灰掉並說明、確認後交換、once 做完不再列出', async ({ page }, testInfo) => {
    const { g, u, touch } = await start(page, testInfo, { 1: dreamSave({ items: { sedative_incense: 3 } }) });
    await g.faceObject('obj_fx5_nine');
    await u.investigate([0]); // 交換
    await g.waitScene('Menu');
    let m = await menu(page);
    expect(m.page).toBe('trade');
    expect(m.title).toBe('與九點交換');
    const rowOf = (mm, label) => mm.items.find((it) => it.label === label);
    expect(m.items.map((it) => it.label)).toEqual(['兩包鎮靜香換一份回聲苔', '回聲苔換唱詩蠟（只此一次）', '離開']);
    expect(rowOf(m, '兩包鎮靜香換一份回聲苔')).toMatchObject({ enabled: true, sub: '給出：鎮靜香×2（持有 3）\n得到：回聲苔×1（持有 0）' });
    expect(rowOf(m, '回聲苔換唱詩蠟（只此一次）').enabled).toBe(false);
    expect(rowOf(m, '回聲苔換唱詩蠟（只此一次）').sub).toBe('材料不足｜給出：回聲苔×1（持有 0）\n得到：唱詩蠟×1（持有 0）');
    // 副標沒有被截斷，縮放後仍放得下按鈕
    for (const it of m.items) if (it.sub) expect(it.subWidth).toBeLessThanOrEqual(it.room);
    expectTappable(m.items);
    if (touch) await shot(page, testInfo, 'm5-trade');

    await g.pickMenu('兩包鎮靜香換一份回聲苔');
    m = await menu(page);
    expect(m.page).toBe('trade_confirm');
    expect(m.note).toContain('給出：鎮靜香 ×2（持有 3 → 1）');
    expect(m.note).toContain('得到：回聲苔 ×1（持有 0 → 1）');
    expectTappable(m.items);
    await g.pickMenu('交換');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'trade');
    m = await menu(page);
    expect(m.note).toBe('交換完成：得到 回聲苔 ×1');
    expect((await g.st()).items).toEqual({ sedative_incense: 1, echo_moss: 1 });
    expect(rowOf(m, '兩包鎮靜香換一份回聲苔').enabled).toBe(false);
    expect(rowOf(m, '回聲苔換唱詩蠟（只此一次）').enabled).toBe(true);

    // 取消不會交換
    await g.pickMenu('回聲苔換唱詩蠟');
    await g.pickMenu('取消');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'trade');
    expect((await g.st()).items.echo_moss).toBe(1);

    await g.pickMenu('回聲苔換唱詩蠟');
    await g.pickMenu('交換');
    await page.waitForFunction(() => /唱詩蠟/.test(window.__SL.menu()?.note ?? ''));
    m = await menu(page);
    expect(m.items.map((it) => it.label)).toEqual(['兩包鎮靜香換一份回聲苔', '離開']);
    let s = await g.st();
    expect(s.items).toEqual({ sedative_incense: 1, choir_wax: 1 });
    expect(s.flags['trade:nine:fx5_wax']).toBe(true);

    await g.pickMenu('離開');
    await g.waitScene('Map');
    // 回到地圖後可以照常操作；再開一次交換，once 的仍不在
    await g.faceObject('obj_fx5_nine');
    await u.investigate([0]);
    await g.waitScene('Menu');
    expect((await menu(page)).items.map((it) => it.label)).toEqual(['兩包鎮靜香換一份回聲苔', '離開']);
    await g.key('Escape');
    await g.waitScene('Map');
    await g.faceObject('obj_fx5_wake');
    await u.investigate([0]);
    await u.waitMap('fx_room');
    s = await g.st();
    expect(s.dream_return).toBeNull();
  });

  test('夢客讀目前章節：終章換成終章的交換表與預寫台詞（guestFor）', async ({ page }, testInfo) => {
    const { g, u } = await start(page, testInfo, { 1: dreamSave({ chapter: 'fx_finale', chapter_done: ['fx_ch4'], items: { shade_ink: 1 } }) });
    await g.faceObject('obj_fx5_nine');
    const t = await u.investigate([1]); // 自由交談（未啟用雲端 → not_open 預寫台詞）
    expect(t).toContain('九點：（測試・終章）九點只剩最後一樣東西可以換。');
    await u.investigate([0]); // 交換
    await g.waitScene('Menu');
    expect((await menu(page)).items.map((it) => it.label)).toEqual(['影墨換兩包鎮靜香', '離開']);
  });
});

test.describe('M5 結局', () => {
  test('resolve_ending → 結局對話 → 結局畫面（結局名稱、第一部完、致謝）→ 存檔讀回仍是結局畫面 → 回標題', async ({ page }, testInfo) => {
    const { g, u, touch } = await start(page, testInfo, { 1: makeSaveV4({ chapter: 'fx_finale', chapter_done: ['fx_ch4'], collapse: 75, location: { map: 'fx_room', x: 5, y: 5, dir: 'right' } }) });
    await g.faceObject('obj_fx5_altar');
    const t = await u.investigate([0, 0]);
    expect(t).toContain('(旁白)：（測試）你走進霧裡，沒有回頭。');
    await g.waitScene('ChapterEnd');
    await page.waitForFunction(() => (window.__SL.debug().chapterEnd?.items ?? []).length > 0);
    const ce = (await page.evaluate(() => window.__SL.debug())).chapterEnd;
    expect(ce.ending).toMatchObject({ id: 'fx_fog', title: '霧中行者', partTitle: '第一部　霧中鐘聲　完' });
    expect(ce.title).toBe('第一部　霧中鐘聲　完');
    expect(ce.credits[0]).toBe('致謝');
    expect(ce.credits.join('')).toContain('艾琳');
    expect(ce.continue).toBeNull();
    expect(ce.items.map((x) => x.label)).toEqual(['存檔', '回標題']);
    for (const it of ce.items) expect(it.h).toBeGreaterThanOrEqual(44);
    expect(ce.clearReport).toBeNull(); // 未啟用雲端：不回報
    let s = await g.st();
    expect(s.ending).toBe('fx_fog');
    expect(s.chapter_done).toContain('fx_finale');
    if (touch) await shot(page, testInfo, 'm5-ending');

    // 存檔 → 回標題 → 讀回：直接顯示結局畫面
    await g.pickChapterEnd('存檔');
    await g.waitScene('Menu');
    await g.pickMenu('存檔 2');
    await page.waitForFunction(() => /已存檔到存檔 2/.test(window.__SL.menu()?.note ?? ''), null, { timeout: 5_000 });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('steel-labyrinth:save:2')));
    expect(saved.ending).toBe('fx_fog');
    await g.key('Escape');
    await g.waitScene('ChapterEnd');
    await g.pickChapterEnd('回標題');
    await g.waitScene('Title');
    await u.titlePick('繼續');
    await g.waitScene('Menu');
    await g.pickMenu('存檔 2');
    await g.waitScene('ChapterEnd');
    await page.waitForFunction(() => (window.__SL.debug().chapterEnd?.items ?? []).length > 0);
    const again = (await page.evaluate(() => window.__SL.debug())).chapterEnd;
    expect(again.ending.title).toBe('霧中行者');
    s = await g.st();
    expect(s.ending).toBe('fx_fog');
    await g.pickChapterEnd('回標題');
    await g.waitScene('Title');
  });

  test('結局依條件判定：崩解低＋旗標 → 燈火未熄；都不成立 → 黎明之前', async ({ page }, testInfo) => {
    const { g, u } = await start(page, testInfo, {
      1: makeSaveV4({ chapter: 'fx_finale', chapter_done: ['fx_ch4'], collapse: 10, flags: { fx5_trusted: true }, location: { map: 'fx_room', x: 5, y: 5, dir: 'right' } }),
    });
    await g.faceObject('obj_fx5_altar');
    await u.investigate([0, 0]);
    await g.waitScene('ChapterEnd');
    await page.waitForFunction(() => window.__SL.debug().chapterEnd?.ending);
    expect((await page.evaluate(() => window.__SL.debug())).chapterEnd.ending.title).toBe('燈火未熄');
  });
});

test.describe('M5 新能力的地圖互動', () => {
  test('借聲（調查）與換影（殘響鍵）自動選可用的免費標籤：提示與動畫；沒有標籤時照舊上鎖', async ({ page }, testInfo) => {
    const { g, u } = await start(page, testInfo, { 1: makeSaveV4({ lineage: { id: 'trace', rank: 8 } }) });
    expect((await hud(page)).rank).toBe('借聲者');
    // 階 8：換影門還打不開
    await g.faceObject('obj_fx5_shadow_door');
    await g.act('echo');
    await page.waitForFunction(() => window.__SL.hud()?.toast === '沒有殘留痕跡');
    // 借聲門：調查 → 借聲
    await g.faceObject('obj_fx5_voice_door');
    await g.act('investigate');
    await page.waitForFunction(() => window.__SL.map()?.tagFx?.tag === 'voice');
    const fx = (await page.evaluate(() => window.__SL.map())).tagFx;
    expect(fx).toMatchObject({ tag: 'voice', label: '借聲', target: 'obj_fx5_voice_door' });
    expect(fx.toast).toBe('【借聲】發動');
    await g.waitDialogue();
    const t = await g.finishDialogue();
    expect(t).toContain('(旁白)：你借來守門人的聲音說出暗號，門應聲而開。');
    expect((await g.st()).flags.fx5_voice_open).toBe(true);
    void u;
  });

  test('階 7：換影門用殘響鍵以 shadow 解開（不扣殘響、不加崩解）', async ({ page }, testInfo) => {
    const { g } = await start(page, testInfo, { 1: makeSaveV4({ lineage: { id: 'trace', rank: 7 }, promotions: [{ lineage: 'trace', rank: 8, forced: false, chapter: 'fx_ch4' }, { lineage: 'trace', rank: 7, forced: false, chapter: 'fx_ch4' }] }) });
    expect((await hud(page)).rank).toBe('換影者');
    await g.faceObject('obj_fx5_shadow_door');
    await g.act('echo');
    await page.waitForFunction(() => window.__SL.map()?.tagFx?.tag === 'shadow');
    expect((await page.evaluate(() => window.__SL.map())).tagFx).toMatchObject({ label: '換影', toast: '【換影】發動' });
    await g.waitDialogue();
    const t = await g.finishDialogue();
    expect(t).toContain('(旁白)：你和門後的影子換了位置，從裡面拉開了門閂。');
    const s = await g.st();
    expect(s.flags.fx5_shadow_open).toBe(true);
    expect(s.collapse).toBe(0);
  });

  test('fixture 的 sprite／tile 都有專屬貼圖（沒有退回預設圖）', async ({ page }) => {
    await useM5Fixture(page);
    await page.goto(M5_URL);
    await game(page, { data: M5_DATA }).waitScene('Title', 15_000);
    const art = await page.evaluate(() => window.__SL.art());
    expect([...art.sprites, ...art.tiles, ...art.bgs]).toEqual([]);
    expect(art.missingTextures).toEqual([]);
  });
});
