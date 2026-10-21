// 意見回饋按鈕：標題畫面與遊戲中選單各一個；提示頁可取消、可前往（開新分頁到 GitHub 討論區）；
// 新分頁被瀏覽器擋下時顯示手動前往的網址。桌機用鍵盤、手機全程觸控。
import { test, expect, game, TEST_URL, makeSave, seedSaves } from './helpers.js';

const FEEDBACK_URL = 'https://github.com/teds-lin/steel-labyrinth/discussions';
const BODY = '即將在新分頁開啟 GitHub 討論區。你可以在那裡回報問題、提出建議，或分享遊玩心得。（發文需要 GitHub 帳號）';
const BLOCKED = '瀏覽器擋下了新分頁，請手動前往：github.com/teds-lin/steel-labyrinth/discussions';
const PRIVACY = '回報資訊會包含你的角色名字與遊戲進度';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const sl = (page, fn, arg) => page.evaluate(fn, arg);
/** 提示文字去掉顯示用排版（不換行空白、換行）後比對原文。 */
const plain = (s) => String(s).replace(/\u00a0/g, ' ').replace(/\n/g, '');

/** 截圖：有設定 FEEDBACK_SHOT_DIR 時另存一份到那裡（給人工檢查版面）。 */
async function shot(page, testInfo, name) {
  const file = `${name}-${testInfo.project.name}.png`;
  await page.screenshot({ path: testInfo.outputPath(file) });
  if (process.env.FEEDBACK_SHOT_DIR) await page.screenshot({ path: `${process.env.FEEDBACK_SHOT_DIR}/${file}` });
}

/** 新分頁不連到 GitHub：攔截後回一個空白頁。 */
async function stubGithub(context) {
  await context.route('https://github.com/**', (r) => r.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>discussions</title><p>stub</p>',
  }));
}

/** 按鈕都在畫面內、高度至少 44 CSS px、彼此不重疊；畫布不超出視窗、沒有橫向捲軸。 */
async function expectLayout(page, g, items, { maxBottom = 640 } = {}) {
  const box = await page.locator('canvas').boundingBox();
  const vp = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
  const scale = box.width / 360;
  const sorted = [...items].sort((a, b) => a.y - b.y);
  sorted.forEach((it, i) => {
    expect(it.h * scale, `「${it.label}」高度`).toBeGreaterThanOrEqual(44);
    expect(it.x - it.w / 2, `「${it.label}」左緣`).toBeGreaterThanOrEqual(0);
    expect(it.x + it.w / 2, `「${it.label}」右緣`).toBeLessThanOrEqual(360);
    expect(it.y - it.h / 2, `「${it.label}」上緣`).toBeGreaterThanOrEqual(0);
    expect(it.y + it.h / 2, `「${it.label}」下緣`).toBeLessThanOrEqual(maxBottom);
    if (i > 0) expect(sorted[i - 1].y + sorted[i - 1].h / 2, `「${it.label}」與上一個重疊`).toBeLessThanOrEqual(it.y - it.h / 2);
  });
  await g.noHScroll();
}

/** 標題畫面：選某個按鈕（桌機方向鍵＋Enter，手機點）。 */
async function titlePick(page, g, touch, label) {
  await page.waitForFunction((l) => (window.__SL.title()?.items ?? []).some((it) => it.label === l && it.enabled), label, { timeout: 8_000 });
  if (touch) {
    const it = (await sl(page, () => window.__SL.title())).items.find((x) => x.label === label);
    await g.tap(it.x, it.y);
    return;
  }
  for (let i = 0; i < 8; i++) {
    const items = (await sl(page, () => window.__SL.title())).items;
    if (items.find((x) => x.focused)?.label === label) { await g.key('Enter'); return; }
    await g.key('ArrowDown');
  }
  throw new Error(`標題選單裡移不到「${label}」`);
}

/** 等提示頁出現並檢查內容。 */
async function expectPrompt(page, origin) {
  await page.waitForFunction(() => window.__SL.feedback()?.open === true, null, { timeout: 5_000 });
  const fb = await sl(page, () => window.__SL.feedback());
  expect(fb).toMatchObject({ open: true, blocked: false, origin });
  const m = await sl(page, () => window.__SL.menu());
  expect(m.page).toBe('feedback');
  expect(m.title).toBe('意見回饋');
  expect(plain(m.note)).toBe(BODY);
  expect(m.items.map((x) => x.label)).toEqual(['複製回報資訊', '前往討論區', '取消']);
  expect(m.items[0].focused).toBe(true);
  expect(fb.privacy).toBe(PRIVACY);
  return m;
}

/** 選「前往討論區」並等新分頁；回傳新分頁（已關閉，焦點回到遊戲頁）。 */
async function goAndCatchTab(page, g, context) {
  const [tab] = await Promise.all([
    context.waitForEvent('page', { timeout: 8_000 }),
    g.pickMenu('前往討論區'),
  ]);
  await tab.waitForURL(FEEDBACK_URL, { timeout: 8_000 });
  const url = tab.url();
  const opener = await tab.evaluate(() => window.opener === null);
  await tab.close();
  await page.bringToFront();
  return { url, openerCut: opener };
}

test.describe('意見回饋', () => {
  test('標題畫面：開啟提示 → 取消回到標題 → 再開 → 前往討論區開新分頁', async ({ page, context }, testInfo) => {
    const touch = isTouch(testInfo);
    await stubGithub(context);
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);

    const title = await sl(page, () => window.__SL.title());
    expect(title.items.map((x) => x.label)).toEqual(['新遊戲', '繼續', '用轉移碼接續', '意見回饋']);
    expect(title.items.find((x) => x.label === '意見回饋').enabled).toBe(true);
    // 標題按鈕不能壓到下方的操作說明（HEIGHT - 52 附近）
    await expectLayout(page, g, title.items, { maxBottom: 578 });
    await shot(page, testInfo, 'feedback-title');
    expect(await sl(page, () => window.__SL.feedback())).toBeNull();

    // 第一次：開啟 → 取消（桌機用 Esc，手機點「取消」）
    await titlePick(page, g, touch, '意見回饋');
    await g.waitScene('Menu');
    const m = await expectPrompt(page, 'Title');
    await expectLayout(page, g, m.items, { maxBottom: 570 });
    await shot(page, testInfo, 'feedback-prompt');
    if (touch) {
      await g.pickMenu('取消');
    } else {
      // 上下鍵可以在兩個按鈕間移動
      await g.key('ArrowDown');
      expect((await sl(page, () => window.__SL.menu())).items[1].focused).toBe(true);
      await g.key('ArrowDown');
      expect((await sl(page, () => window.__SL.menu())).items[2].focused).toBe(true);
      await g.key('ArrowUp');
      await g.key('ArrowUp');
      expect((await sl(page, () => window.__SL.menu())).items[0].focused).toBe(true);
      await g.key('Escape');
    }
    await g.waitScene('Title');
    expect(await sl(page, () => window.__SL.feedback())).toBeNull();
    expect(await sl(page, () => window.__SL.menu())).toBeNull();

    // 第二次：開啟 → 前往討論區 → 新分頁網址正確，回到標題
    await titlePick(page, g, touch, '意見回饋');
    await g.waitScene('Menu');
    await expectPrompt(page, 'Title');
    const tab = await goAndCatchTab(page, g, context);
    expect(tab.url).toBe(FEEDBACK_URL);
    expect(tab.openerCut).toBe(true);
    await g.waitScene('Title');
    expect(await sl(page, () => window.__SL.feedback())).toBeNull();

    // 標題選單仍可正常使用：開始新遊戲
    await titlePick(page, g, touch, '新遊戲');
    await g.waitScene('Name');
  });

  test('遊戲中選單：開啟提示 → 取消回到選單 → 再開 → 前往；回到遊戲後狀態不變、仍可移動', async ({ page, context }, testInfo) => {
    const touch = isTouch(testInfo);
    await stubGithub(context);
    await seedSaves(page, { 1: makeSave() });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await titlePick(page, g, touch, '繼續');
    await g.waitScene('Menu');
    await g.pickMenu('存檔 1');
    await g.waitScene('Map');
    await g.sleep(200);
    const strip = (s) => ({ ...s, playtime_s: 0 });
    const before = strip(await g.st());

    await g.act('menu');
    await g.waitScene('Menu');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    const main = await sl(page, () => window.__SL.menu());
    const labels = main.items.map((x) => x.label);
    expect(labels).toContain('意見回饋');
    expect(labels.indexOf('意見回饋')).toBe(labels.indexOf('回標題') - 1);
    expect(labels.at(-1)).toBe('返回遊戲');
    await expectLayout(page, g, main.items, { maxBottom: 570 });
    await shot(page, testInfo, 'feedback-menu');

    // 第一次：開啟 → 取消（桌機方向鍵＋Enter，手機點）→ 回到選單主頁
    await g.pickMenu('意見回饋');
    await expectPrompt(page, 'Menu');
    await g.pickMenu('取消');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    expect(await sl(page, () => window.__SL.feedback())).toBeNull();

    // 桌機：Esc 也能取消（回到選單主頁，不是直接關掉選單）
    if (!touch) {
      await g.pickMenu('意見回饋');
      await expectPrompt(page, 'Menu');
      await g.key('Escape');
      await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    }

    // 第二次：開啟 → 前往討論區
    await g.pickMenu('意見回饋');
    await expectPrompt(page, 'Menu');
    const tab = await goAndCatchTab(page, g, context);
    expect(tab.url).toBe(FEEDBACK_URL);
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    expect(await sl(page, () => window.__SL.feedback())).toBeNull();
    // 選單還開著：地圖仍暫停，方向輸入不會移動角色
    expect(await g.scene()).toBe('Menu');
    if (!touch) await g.key('ArrowRight');
    await g.sleep(200);
    expect(strip(await g.st())).toEqual(before);

    // 回到遊戲：狀態不變、仍可移動
    await g.pickMenu('返回遊戲');
    await g.waitScene('Map');
    await g.sleep(150);
    expect(strip(await g.st())).toEqual(before);
    await g.stepDir('right');
    expect((await g.st()).location.x).toBe(before.location.x + 1);
  });

  test('新分頁被瀏覽器擋下：顯示手動前往的網址，取消後回到原畫面', async ({ page, context }, testInfo) => {
    const touch = isTouch(testInfo);
    await stubGithub(context);
    await page.addInitScript(() => {
      window.__openCalls = [];
      window.open = (...args) => { window.__openCalls.push(args); return null; };
    });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);

    await titlePick(page, g, touch, '意見回饋');
    await g.waitScene('Menu');
    await expectPrompt(page, 'Title');
    await g.pickMenu('前往討論區');
    await page.waitForFunction(() => window.__SL.feedback()?.blocked === true, null, { timeout: 5_000 });
    const m = await sl(page, () => window.__SL.menu());
    expect(plain(m.note)).toBe(BLOCKED);
    expect(m.items.map((x) => x.label)).toEqual(['複製回報資訊', '前往討論區', '取消']);
    const calls = await sl(page, () => window.__openCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(FEEDBACK_URL);
    expect(calls[0][1]).toBe('_blank');
    expect(context.pages()).toHaveLength(1);
    await shot(page, testInfo, 'feedback-blocked');

    await g.pickMenu('取消');
    await g.waitScene('Title');
    expect(await sl(page, () => window.__SL.feedback())).toBeNull();
  });
});
