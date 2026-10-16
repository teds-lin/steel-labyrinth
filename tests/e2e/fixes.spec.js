// M1 對抗審查修正輪（畫面層）的迴歸測試：每一項對應審查報告的一個問題。
import { test, expect, game, TEST_URL, makeSave, seedSaves } from './helpers.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const sl = (page, fn, arg) => page.evaluate(fn, arg);

/** 從標題「繼續」打開讀取選單。 */
async function openLoadFromTitle(g) {
  await g.waitScene('Title', 15_000);
  await g.sleep(300);
  await g.key('ArrowDown');
  await g.key('Enter');
  await g.waitScene('Menu');
  await g.sleep(100);
}

test.describe('M1 修正', () => {
  test('#1 對話選項可以用滑鼠／觸控點選；點對話框其他地方不會誤選；一次輸入只選一次', async ({ page }, testInfo) => {
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await g.newGame('艾琳');
    await g.finishDialogue();

    await g.useOn('obj_drawer');
    const ask = await g.advanceToChoice();
    expect(ask.choices.length).toBe(2);
    await page.screenshot({ path: testInfo.outputPath(`choices-${testInfo.project.name}.png`) });

    // 點對話框內文字區：不是選項，不能選、也不能前進
    await g.pointAt(180, 560);
    await g.sleep(150);
    expect(await g.dlg()).toEqual(ask);

    // 點第一個選項「把底板撬起來」：只會前進到它的下一句（pry），不會連跳兩句
    await g.tapChoice(0);
    await page.waitForFunction((t) => window.__SL.dialogue()?.text !== t, ask.text, { timeout: 3_000 });
    const d = await g.dlg();
    expect(d.text).toContain('夾層裡躺著一把黃銅鑰匙');
    expect((await g.st()).items.attic_key).toBe(1);

    // 鍵盤仍可用：剩下的對話用鍵盤推進
    await g.key('Space');
    await g.sleep(100);
    expect((await g.dlg())?.text ?? '').toContain('昨天的我');
    await g.key('Space');
    await g.sleep(150);
    expect(await g.dlg()).toBeNull();
  });

  test('#2 HUD 對異常數值不丟錯，殘響最多畫 10 個點', async ({ page }) => {
    await page.goto(TEST_URL);
    await game(page).waitScene('Title', 15_000);
    const r = await sl(page, async () => {
      const m = await import('./src/ui/hud.js');
      const cases = [
        { charges: NaN }, { charges: -3 }, { charges: 1e9 }, { charges: 2.5 }, { charges: '7' }, { charges: undefined },
        { charges: 50, free: false, max: 3 }, { charges: 0, free: false, max: 3 }, { charges: 0, free: true, max: 3 },
      ];
      const echo = cases.map((c) => m.echoHud(c));
      const collapse = [NaN, -10, 250, 33.7, undefined, '40'].map((c) => m.collapseHud(c));
      return { echo, collapse };
    });
    for (const e of r.echo) {
      expect(typeof e.text).toBe('string');
      expect([...e.text].filter((ch) => ch === '●' || ch === '○').length).toBeLessThanOrEqual(10);
    }
    expect(r.echo[2].text).toContain('99'); // 1e9 → 上限 99，用數字顯示
    expect(r.echo[6].text).toMatch(/50/);
    expect(r.echo[6].filled).toBe(10);
    expect(r.echo[7].filled).toBe(0);
    expect(r.echo[8].text).toContain('∞');
    for (const c of r.collapse) {
      expect(c.value).toBeGreaterThanOrEqual(0);
      expect(c.value).toBeLessThanOrEqual(100);
      expect(Number.isInteger(c.value)).toBe(true);
    }
  });

  test('#2b 讀取殘響 50 次的存檔：HUD 畫 10 個點加數字', async ({ page }) => {
    await seedSaves(page, { 1: makeSave({ echo: { charges: 50 } }) });
    const g = game(page);
    await page.goto(TEST_URL);
    await openLoadFromTitle(g);
    await g.key('Enter');
    await g.waitScene('Map');
    await g.sleep(200);
    const hud = await sl(page, () => window.__SL.hud());
    expect(hud.echoFilled).toBe(10);
    expect(hud.echo).toContain('50');
  });

  test('#3 讀檔位置異常：移到起點並提示；語意不合法的存檔顯示原因、不能讀', async ({ page }) => {
    await seedSaves(page, {
      1: makeSave({ location: { map: 'attic', x: 999, y: -4, dir: 'down' } }),
      2: makeSave({ lineage: { id: 'no_such_lineage', rank: 9 } }),
    });
    const g = game(page);
    await page.goto(TEST_URL);
    await openLoadFromTitle(g);

    const menu = await sl(page, () => window.__SL.menu());
    expect(menu.items[1].label).toBe('存檔 2　已損壞');
    expect(menu.items[1].enabled).toBe(false);
    expect(menu.items[1].sub.length).toBeGreaterThan(0);

    await g.key('Enter'); // 游標在第一個可用的槽：存檔 1
    await g.waitScene('Map');
    await g.sleep(150);
    const s = await g.st();
    expect(s.location).toMatchObject({ map: 'attic', x: 2, y: 3 });
    const hud = await sl(page, () => window.__SL.hud());
    expect(hud.toast).toBeTruthy();
    // 讀檔後仍可移動
    await g.stepDir('right');
  });

  test('#4 有損壞或版本較新的存檔時「繼續」可用，選單標示且不能讀取', async ({ page }) => {
    await seedSaves(page, {
      1: '{這不是 JSON',
      2: JSON.stringify({ ...makeSave(), schema_version: 99 }),
    });
    const g = game(page);
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    const title = await sl(page, () => window.__SL.title());
    expect(title.items.find((i) => i.label === '繼續').enabled).toBe(true);

    await openLoadFromTitle(g);
    const menu = await sl(page, () => window.__SL.menu());
    expect(menu.items[0]).toMatchObject({ label: '存檔 1　已損壞', enabled: false });
    expect(menu.items[1]).toMatchObject({ label: '存檔 2　版本較新，請更新遊戲', enabled: false });
    expect(menu.items[2]).toMatchObject({ label: '存檔 3　（空）', enabled: false });
    // 唯一可用的是「返回」：Enter 回到標題
    await g.key('Enter');
    await g.waitScene('Title');
  });

  test('#4b 完全沒有存檔時「繼續」停用', async ({ page }) => {
    const g = game(page);
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    const title = await sl(page, () => window.__SL.title());
    expect(title.items.find((i) => i.label === '繼續')).toMatchObject({ enabled: false, sub: '目前沒有存檔' });
  });

  test('#5 名字太寬時名牌與存檔槽副標以「…」截斷', async ({ page }) => {
    // 每個字元＝子音＋很多個 spacing mark，算一個 grapheme，但畫出來很寬
    const wide = Array.from({ length: 8 }, () => `क${'ा'.repeat(12)}`).join('');
    await seedSaves(page, { 1: makeSave({ player: { name: wide } }) });
    const g = game(page);
    await page.goto(TEST_URL);
    await openLoadFromTitle(g);
    const menu = await sl(page, () => window.__SL.menu());
    expect(menu.items[0].sub).toContain('…');
    expect(menu.items[0].sub).toContain('遊戲時間');
    expect(menu.items[0].subWidth).toBeLessThanOrEqual(menu.items[0].room);

    await g.key('Enter');
    await g.waitScene('Map');
    // 撞牆後對自己說話：用調查鏡子觸發主角台詞不穩定，直接檢查名牌排版函式
    const plate = await sl(page, () => window.__SL.nameplate(window.__SL.getState().player.name));
    expect(plate.text.endsWith('…')).toBe(true);
    expect(plate.width).toBeLessThanOrEqual(plate.max);
    const short = await sl(page, () => window.__SL.nameplate('艾琳'));
    expect(short.text).toBe('艾琳');
  });

  test('#6 選單在最上層並壓暗 HUD／觸控區，關閉後恢復', async ({ page }, testInfo) => {
    await seedSaves(page, { 1: makeSave() });
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await openLoadFromTitle(g);
    await g.key('Enter');
    await g.waitScene('Map');
    await g.sleep(150);

    await g.act('menu');
    await g.waitScene('Menu');
    await g.sleep(100);
    let dbg = await sl(page, () => window.__SL.debug());
    expect(dbg.sceneOrder.at(-1)).toBe('Menu');
    expect(dbg.sceneOrder.indexOf('UI')).toBeLessThan(dbg.sceneOrder.indexOf('Menu'));
    const menu = await sl(page, () => window.__SL.menu());
    expect(menu.dimmed).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`menu-${testInfo.project.name}.png`) });

    // 用指標點「返回遊戲」
    const back = menu.items.find((i) => i.label === '返回遊戲');
    await g.pointAt(back.x, back.y);
    await g.waitScene('Map');
    await g.sleep(100);
    dbg = await sl(page, () => window.__SL.debug());
    expect(dbg.sceneOrder).not.toContain('Menu');
    expect(dbg.sceneOrder.indexOf('UI')).toBeGreaterThan(dbg.sceneOrder.indexOf('Map'));
  });

  test('#7 反覆讀檔與回標題，resume 監聽器不累積', async ({ page }) => {
    await seedSaves(page, { 1: makeSave() });
    const g = game(page);
    await page.goto(TEST_URL);
    await openLoadFromTitle(g);
    await g.key('Enter');
    await g.waitScene('Map');
    await g.sleep(150);
    const first = (await sl(page, () => window.__SL.debug())).listeners;

    for (let i = 0; i < 4; i++) {
      // 遊戲中選單 → 讀取 → 存檔 1
      await g.key('Escape');
      await g.waitScene('Menu');
      await g.sleep(80);
      await g.key('ArrowDown');
      await g.key('Enter');
      await g.sleep(80);
      await g.key('Enter');
      await g.waitScene('Map');
      await g.sleep(150);
    }
    const afterLoads = (await sl(page, () => window.__SL.debug())).listeners;
    expect(afterLoads.Map).toEqual(first.Map);
    expect(afterLoads.Map.resume).toBeLessThanOrEqual(1);

    for (let i = 0; i < 4; i++) {
      // 選單 → 回標題 → 確認 → 繼續 → 存檔 1
      await g.key('Escape');
      await g.waitScene('Menu');
      await g.sleep(80);
      await g.key('ArrowDown');
      await g.key('ArrowDown');
      await g.key('Enter');
      await g.sleep(80);
      await g.key('ArrowUp');
      await g.key('Enter');
      await openLoadFromTitle(g);
      await g.key('Enter');
      await g.waitScene('Map');
      await g.sleep(150);
    }
    const afterTitles = (await sl(page, () => window.__SL.debug())).listeners;
    expect(afterTitles.Title.resume).toBeLessThanOrEqual(1);
    expect(afterTitles.Map).toEqual(first.Map);
  });

  test('#8 章節結束畫面讀 story 的 end_screen；HUD 依 echoAvailable；光暈讀 tile 的 glow', async ({ page }, testInfo) => {
    await seedSaves(page, {
      1: makeSave({ location: { map: 'street', x: 6, y: 2, dir: 'down' }, flags: { 'enter:attic': true, 'enter:hallway': true, 'enter:street': true, door_open: true, talked_landlady: true } }),
      2: makeSave({ lineage: { id: 'trace', rank: 9 }, echo: { charges: 0 } }),
      3: makeSave({ echo: { charges: 0 } }),
    });
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    const story = await sl(page, () => fetch('data/story/prologue.json').then((r) => r.json()));
    const tiles = await sl(page, () => fetch('data/tiles.json').then((r) => r.json()));
    const glowIds = new Set(tiles.filter((t) => t.glow === true).map((t) => t.id));

    // 存檔 3：殘響 0、沒有譜系 → 0 個實心點
    await openLoadFromTitle(g);
    await g.key('ArrowDown');
    await g.key('ArrowDown');
    await g.key('Enter');
    await g.waitScene('Map');
    await g.sleep(150);
    let hud = await sl(page, () => window.__SL.hud());
    expect(hud.echoFilled).toBe(0);
    expect(hud.echo).not.toContain('∞');
    // 光暈數量＝地圖上 glow 地形的格數
    const attic = await g.mapData('attic');
    const expectGlow = attic.tiles.reduce((n, row) => n + [...row].filter((ch) => glowIds.has(attic.legend[ch])).length, 0);
    expect((await sl(page, () => window.__SL.debug())).glows).toBe(expectGlow);

    // 存檔 2：譜系提供 trace → 免費回溯
    await g.key('Escape');
    await g.waitScene('Menu');
    await g.key('ArrowDown');
    await g.key('Enter');
    await g.sleep(80);
    await g.key('ArrowDown');
    await g.key('Enter');
    await g.waitScene('Map');
    await g.sleep(150);
    hud = await sl(page, () => window.__SL.hud());
    expect(hud.echo).toContain('∞');

    // 存檔 1：街上一步之遙 → 結局 → 章節結束畫面
    await g.key('Escape');
    await g.waitScene('Menu');
    await g.key('ArrowDown');
    await g.key('Enter');
    await g.sleep(80);
    await g.key('Enter');
    await g.waitScene('Map');
    await g.sleep(150);
    await g.stepDir('down');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await g.waitScene('ChapterEnd');
    await g.sleep(1200);
    const dbg = await sl(page, () => window.__SL.debug());
    expect(dbg.chapterEnd.title).toBe(story.end_screen?.title ?? `${story.title ?? story.id}　完`);
    expect(dbg.chapterEnd.subtitle).toBe(story.end_screen?.subtitle ?? '');
  });

  test('#9 靜態伺服器：壞 URL 回 400 且不當機；不能讀到 web/ 以外的檔案', async ({ request }) => {
    test.skip(!!process.env.E2E_BASE_URL, '測的是本機 tools/serve.mjs，線上版本不適用');
    const bad = await request.get('/%E0%A4%A');
    expect(bad.status()).toBe(400);
    const bad2 = await request.get('/src/%');
    expect(bad2.status()).toBe(400);
    for (const p of ['/..%2fpackage.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/src/..%2f..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fpackage.json']) {
      const r = await request.get(p);
      expect(r.status(), p).not.toBe(200);
    }
    const ok = await request.get('/');
    expect(ok.status()).toBe(200);
    const js = await request.get('/src/main.js');
    expect(js.status()).toBe(200);
  });

  test.describe('橫向手機', () => {
    test.use({ viewport: { width: 667, height: 375 } });
    test('#11 橫向且高度 < 500 時標題顯示「建議直向遊玩」', async ({ page }) => {
      const g = game(page);
      await page.goto(TEST_URL);
      await g.waitScene('Title', 15_000);
      expect((await sl(page, () => window.__SL.title())).landscapeHint).toBe(true);
    });
  });

  test('#11b 直向時不顯示橫向提示', async ({ page }) => {
    const g = game(page);
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    expect((await sl(page, () => window.__SL.title())).landscapeHint).toBe(false);
  });
});
