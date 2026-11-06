// 主模組載入／連結失敗時的提示（index.html 裡非 module 的小腳本）：
// 事故是 LINE 內建瀏覽器拿到快取的舊 config.js 配新 main.js → 模組連結失敗 → Phaser 沒建立 → 只剩全黑的 body。
// 失敗時要在畫面中央顯示「載入失敗，請重新整理」與「重新整理」按鈕；慢網路正常載入時不得誤報。
// 這些測試會故意製造 404／SyntaxError，所以不用 helpers.js 的 test（它要求整個測試沒有 console error）。
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FAIL_TEXT = '載入失敗，請重新整理';
const SLOW_TEXT = '仍在載入…如果一直沒有畫面，請重新整理';
const RELOAD_TEXT = '重新整理';
const OLD_TEXT = '瀏覽器版本太舊，請更新後再試';

const status = (page) => page.locator('#load-status');
const watchState = (page) => page.evaluate(() => window.__slBootWatch?.state ?? null);
/** 失敗原因：script-error（本站 script 下載失敗）／runtime-error（本站 .js 丟錯，含模組連結失敗）／no-boot（load 後仍未啟動的保險）。 */
const watchReason = (page) => page.evaluate(() => window.__slBootWatch?.reason ?? null);
const sceneOf = (page) => page.evaluate(() => window.__SL?.currentScene?.() ?? null);

async function expectFailure(page, reason) {
  await expect(status(page)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#load-status-msg')).toHaveText(FAIL_TEXT);
  const btn = page.getByRole('button', { name: RELOAD_TEXT });
  await expect(btn).toBeVisible();
  const box = await btn.boundingBox();
  expect(box.width, '觸控目標寬度 ≥ 44px').toBeGreaterThanOrEqual(44);
  expect(box.height, '觸控目標高度 ≥ 44px').toBeGreaterThanOrEqual(44);
  // 在畫面中央附近
  const vp = page.viewportSize();
  expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(vp.width * 0.25);
  expect(await watchState(page)).toBe('failed');
  // 確認是哪一條路徑觸發的：error 監聽壞掉時，404／舊 config 會改由 load 後的保險（no-boot）觸發，這裡就會變紅
  expect(await watchReason(page)).toBe(reason);
}

test.describe('載入失敗提示', () => {
  test('正常載入：不顯示任何提示（即使慢載入提示的門檻設得很短）', async ({ page }) => {
    await page.goto('./?test=1&bootslow=1500');
    await expect.poll(() => sceneOf(page), { timeout: 15_000 }).toBe('Title');
    expect(await watchState(page)).toBe('ok');
    await page.waitForTimeout(2500); // 超過慢載入門檻，也超過 load 事件後的寬限
    await expect(status(page)).toBeHidden();
    expect(await watchState(page)).toBe('ok');
    expect(await watchReason(page)).toBeNull();
  });

  test('相依模組回 404：顯示載入失敗與重新整理按鈕；按下後帶時間戳重新載入，載入成功後網址的時間戳會被拿掉', async ({ page }) => {
    await page.route('**/src/session.js*', (r) => r.fulfill({ status: 404, body: 'not found' }));
    await page.goto('./?test=1');
    await expectFailure(page, 'script-error');
    expect(await page.evaluate(() => typeof window.__SL)).toBe('undefined'); // 遊戲確實沒有啟動

    await page.unroute('**/src/session.js*');
    const nav = page.waitForRequest((req) => req.isNavigationRequest() && /[?&]_r=\d+/.test(req.url()));
    await page.getByRole('button', { name: RELOAD_TEXT }).click();
    const req = await nav;
    expect(new URL(req.url()).searchParams.get('test')).toBe('1'); // 原本的參數保留
    await expect.poll(() => sceneOf(page), { timeout: 15_000 }).toBe('Title');
    await expect(status(page)).toBeHidden();
    expect(page.url()).not.toMatch(/[?&]_r=/);
    expect(new URL(page.url()).searchParams.get('test')).toBe('1');
  });

  test('舊版 config.js（缺少 main.js 要的 export）：模組連結失敗 → 顯示載入失敗', async ({ page }) => {
    const src = readFileSync(new URL('../../web/src/config.js', import.meta.url), 'utf8');
    const old = src.replace(/export const TEST_REAL_AUDIO\b/, 'const TEST_REAL_AUDIO_OLD');
    expect(old).not.toBe(src);
    await page.route('**/src/config.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: old }));
    await page.goto('./?test=1');
    await expectFailure(page, 'runtime-error');
  });

  test('main.js 本身 404：顯示載入失敗', async ({ page }) => {
    await page.route('**/src/main.js*', (r) => r.fulfill({ status: 404, body: 'not found' }));
    await page.goto('./?test=1');
    await expectFailure(page, 'script-error');
  });

  test('Phaser（vendor/phaser.min.js）404：顯示載入失敗', async ({ page }) => {
    await page.route('**/vendor/phaser.min.js*', (r) => r.fulfill({ status: 404, body: 'not found' }));
    await page.goto('./?test=1');
    await expectFailure(page, 'script-error');
  });

  test('沒有任何錯誤事件、但 main.js 從未回報啟動（例如瀏覽器沒把連結錯誤送到 window）：load 後判定失敗', async ({ page }) => {
    await page.route('**/src/main.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: 'export {};\n' }));
    await page.goto('./?test=1');
    expect(await watchState(page)).toBe('loading'); // load 剛發生，還在寬限期內
    await expectFailure(page, 'no-boot');
  });

  test('不支援 module 的舊瀏覽器：nomodule 腳本顯示「瀏覽器版本太舊」、沒有重新整理按鈕，之後也不會改報載入失敗', async ({ page }) => {
    // 模擬舊瀏覽器：nomodule 腳本照常執行、type="module" 的 script 完全不執行
    const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
    const old = html.replace(/<script nomodule>/, '<script>').replace(/<script type="module"/g, '<script type="text/x-old-browser"');
    expect(old).not.toBe(html);
    // 只攔頁面本身：本機是 /，線上是 /steel-labyrinth/（子目錄），所以比對「以 / 或 /index.html 結尾」
    await page.route((url) => url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'), (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: old }));
    await page.goto('./?test=1&bootslow=500');
    await expect(status(page)).toBeVisible();
    await expect(page.locator('#load-status-msg')).toHaveText(OLD_TEXT);
    await expect(page.getByRole('button', { name: RELOAD_TEXT })).toBeHidden();
    expect(await watchState(page)).toBe('unsupported');
    await page.waitForTimeout(3000); // 超過慢載入門檻與 load 後的寬限
    await expect(page.locator('#load-status-msg')).toHaveText(OLD_TEXT);
    expect(await watchState(page)).toBe('unsupported');
  });

  test('新瀏覽器：nomodule 腳本不執行，「瀏覽器版本太舊」不會出現', async ({ page }) => {
    await page.goto('./?test=1');
    await expect.poll(() => sceneOf(page), { timeout: 15_000 }).toBe('Title');
    expect(await page.evaluate(() => window.__slNoModule ?? null)).toBeNull();
    await expect(page.getByText(OLD_TEXT)).toHaveCount(0);
  });

  test('慢網路：超過門檻只顯示溫和的「仍在載入」，不報失敗；載入完成後提示自動消失', async ({ page }) => {
    await page.route('**/src/main.js*', async (r) => {
      await new Promise((res) => setTimeout(res, 3000));
      await r.continue();
    });
    await page.goto('./?test=1&bootslow=800', { waitUntil: 'commit' }); // 預設會等 load 事件（也就等到慢的 main.js 載完）
    await expect(status(page)).toBeVisible({ timeout: 2500 });
    await expect(page.locator('#load-status-msg')).toHaveText(SLOW_TEXT);
    await expect(page.getByRole('button', { name: RELOAD_TEXT })).toBeVisible();
    expect(await watchState(page)).toBe('slow');
    await expect.poll(() => sceneOf(page), { timeout: 15_000 }).toBe('Title');
    await expect(status(page)).toBeHidden();
    expect(await watchState(page)).toBe('ok');
  });

  test('bootslow 只在 ?test=1 生效：正式模式下慢 3 秒也不會提早顯示提示', async ({ page }) => {
    await page.route('**/src/main.js*', async (r) => {
      await new Promise((res) => setTimeout(res, 3000));
      await r.continue();
    });
    await page.goto('./?bootslow=300', { waitUntil: 'commit' });
    await page.waitForTimeout(1500);
    await expect(status(page)).toBeHidden();
    expect(await watchState(page)).toBe('loading');
    await expect.poll(() => watchState(page), { timeout: 15_000 }).toBe('ok');
    await expect(status(page)).toBeHidden();
  });
});
