// 意見回饋提示頁的「複製回報資訊」：遊戲中與標題畫面都能複製到剪貼簿（Chromium 授權 clipboard-read／write 後讀回），
// 內容含章節、地圖、存檔字串，且不含雲端權杖與轉移碼；剪貼簿失敗時改顯示唯讀的 textarea 讓玩家手動複製。
// 桌機用鍵盤、手機全程觸控。
import { test, expect, game, TEST_URL, makeSave, seedSaves } from './helpers.js';
import { MOCK_API } from './cloud-mock.js';

// 本機頁面預設不開放雲端；指向假 API 位址才會把雲端資訊當成「已啟用」（測試全程不應送出任何雲端請求）
const CLOUD_URL = `${TEST_URL}&api=${encodeURIComponent(MOCK_API)}`;
/** 記錄送往假 API 的請求（應為 0）。 */
const watchCloud = (page) => {
  const reqs = [];
  page.on('request', (r) => { if (r.url().startsWith(MOCK_API)) reqs.push(r.url()); });
  return reqs;
};

const COPIED = '已複製，請貼到討論區的回報表單裡';
const FAILED = '無法自動複製，請在下方框內全選文字後手動複製';
const PRIVACY = '回報資訊會包含你的角色名字與遊戲進度';
const MARKER = '---- 存檔內容（請勿修改）----';

// 假的雲端秘密（格式合法：雲端資訊會被當成「已啟用」）
const TOKEN = 'FAKEtokenFAKEtokenFAKEtokenFAKEtokenFAKE123';
const CODE = 'QWER-TYUP';
const NEW_CODE = 'HJKM-NBVC';
const PLAYER_ID = 'pid-FAKE-0123456789abcdef';
const SECRETS = [TOKEN, CODE, CODE.replace('-', ''), NEW_CODE, NEW_CODE.replace('-', ''), PLAYER_ID];

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const sl = (page, fn, arg) => page.evaluate(fn, arg);

async function shot(page, testInfo, name) {
  const file = `${name}-${testInfo.project.name}.png`;
  await page.screenshot({ path: testInfo.outputPath(file) });
  if (process.env.FEEDBACK_SHOT_DIR) await page.screenshot({ path: `${process.env.FEEDBACK_SHOT_DIR}/${file}` });
}

/** 頁面載入前放好雲端資訊（含假權杖、轉移碼、player_id）與通關待送紀錄（空的，不會送請求）。 */
async function seedCloudSecrets(page) {
  await page.addInitScript(({ token, code, playerId }) => {
    if (sessionStorage.getItem('__sl_cloud_seeded')) return;
    sessionStorage.setItem('__sl_cloud_seeded', '1');
    localStorage.setItem('steel-labyrinth:cloud', JSON.stringify({
      player_id: playerId, token, transfer_code: code, pending_transfer_code: null,
      slots: {}, auto_upload: false, local_saved_at: {},
    }));
    localStorage.setItem('steel-labyrinth:cloud-clear-queue', JSON.stringify({ player_id: playerId, records: {} }));
  }, { token: TOKEN, code: CODE, playerId: PLAYER_ID });
}

/** 剪貼簿寫入一律失敗（權限被拒）；記下呼叫次數。 */
async function breakClipboard(page) {
  await page.addInitScript(() => {
    window.__clipCalls = 0;
    const deny = () => { window.__clipCalls += 1; return Promise.reject(new DOMException('denied', 'NotAllowedError')); };
    try { navigator.clipboard.writeText = deny; } catch { /* 沒有 clipboard 時本來就會失敗 */ }
  });
}

const expectNoSecrets = (text) => {
  for (const s of SECRETS) expect(text, `回報不能含有 ${s}`).not.toContain(s);
  expect(text).not.toContain('steel-labyrinth:cloud');
  expect(text).not.toContain('token');
  expect(text).not.toContain('transfer_code');
  expect(text).not.toContain('player_id');
};

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

/** 提示頁上的按鈕、提示文字、備援文字框都在面板內（y 70～570、x 16～344）、按鈕至少 44 CSS px、彼此不重疊。 */
async function expectPromptLayout(page, g) {
  const box = await page.locator('canvas').boundingBox();
  const scale = box.width / 360;
  const m = await sl(page, () => window.__SL.menu());
  const fb = await sl(page, () => window.__SL.feedback());
  const rects = m.items.map((it) => ({ label: it.label, top: it.y - it.h / 2, bottom: it.y + it.h / 2, left: it.x - it.w / 2, right: it.x + it.w / 2 }));
  for (const it of m.items) expect(it.h * scale, `「${it.label}」高度`).toBeGreaterThanOrEqual(44);
  for (const extra of [fb.privacyRect, fb.statusRect, fb.fallback]) {
    if (!extra) continue;
    rects.push({ label: extra.label ?? 'extra', top: extra.y - extra.h / 2, bottom: extra.y + extra.h / 2, left: extra.x - extra.w / 2, right: extra.x + extra.w / 2 });
  }
  const sorted = rects.sort((a, b) => a.top - b.top);
  sorted.forEach((r, i) => {
    expect(r.left, `${r.label} 左緣`).toBeGreaterThanOrEqual(16);
    expect(r.right, `${r.label} 右緣`).toBeLessThanOrEqual(344);
    expect(r.top, `${r.label} 上緣`).toBeGreaterThanOrEqual(70);
    expect(r.bottom, `${r.label} 下緣`).toBeLessThanOrEqual(570);
    if (i > 0) expect(sorted[i - 1].bottom, `${r.label} 與 ${sorted[i - 1].label} 重疊`).toBeLessThanOrEqual(r.top + 0.5);
  });
  await g.noHScroll();
}

/**
 * 截圖裡透明（alpha < 255）的像素數：畫面上每個像素都應該被畫布或頁面背景蓋住。
 * （可捲動的文字框若背景完全不透明，手機模擬時會讓畫布上的說明文字區域變透明，見 index.html 的 .sl-report-text）
 */
async function transparentPixels(page) {
  const png = await page.screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) n += 1;
    return n;
  }, png.toString('base64'));
}

const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

test.describe('複製回報資訊', () => {
  test('遊戲中選單 → 意見回饋 → 複製：剪貼簿含章節、地圖、存檔字串，不含權杖與轉移碼', async ({ page, context }, testInfo) => {
    const touch = isTouch(testInfo);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await seedCloudSecrets(page);
    await seedSaves(page, { 1: makeSave({ player: { name: '霧港測試' }, playtime_s: 3725 }) });
    const cloudReqs = watchCloud(page);
    const g = game(page, { touch });
    await page.goto(CLOUD_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await titlePick(page, g, touch, '繼續');
    await g.waitScene('Menu');
    await g.pickMenu('存檔 1');
    await g.waitScene('Map');
    await g.sleep(200);
    // 讀檔後記住最近一次讀取的槽位（標題畫面的回報會附上這一格）
    expect(await sl(page, () => localStorage.getItem('steel-labyrinth:report-last-slot'))).toBe('1');
    expect((await sl(page, () => window.__SL.cloud())).enabled).toBe(true);
    const st = await g.st();

    await g.act('menu');
    await g.waitScene('Menu');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await g.pickMenu('意見回饋');
    await page.waitForFunction(() => window.__SL.feedback()?.open === true);
    const m = await sl(page, () => window.__SL.menu());
    expect(m.items.map((x) => x.label)).toEqual(['複製回報資訊', '前往討論區', '取消']);
    expect((await sl(page, () => window.__SL.feedback())).privacy).toBe(PRIVACY);
    await expectPromptLayout(page, g);
    await shot(page, testInfo, 'report-prompt');

    await g.pickMenu('複製回報資訊');
    await page.waitForFunction(() => window.__SL.feedback()?.copy === 'copied', null, { timeout: 5_000 });
    const fb = await sl(page, () => window.__SL.feedback());
    expect(fb.status).toBe(COPIED);
    expect(fb.fallback).toBeNull();
    await expectPromptLayout(page, g);
    await shot(page, testInfo, 'report-copied');

    const text = await readClipboard(page);
    const lines = text.split('\n');
    expect(lines[0]).toBe('【鋼鐵迷都 回報資訊】');
    expect(lines[1]).toMatch(/^遊戲版本：20\d{2}\.\d{2}\.\d{2}(\.\d+)?（存檔格式 v\d+）$/);
    expect(lines[2]).toMatch(/^時間：\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines[3]).toMatch(/^裝置：.+／Chrome \d+；畫面 \d+×\d+$/);
    expect(text).toContain(`章節：序章（prologue）`);
    expect(text).toMatch(new RegExp(`地圖：[^（]+（${st.location.map}）　位置：\\(${st.location.x}, ${st.location.y}\\)`));
    expect(text).toContain('隊伍：霧港測試 ');
    expect(text).toContain('遊戲時間 01:02:');
    expect(text).toContain('雲端存檔：已啟用（不含任何權杖或轉移碼）');
    const at = lines.indexOf(MARKER);
    expect(at).toBeGreaterThan(0);
    const save = JSON.parse(lines[at + 1]);
    expect(save.player.name).toBe('霧港測試');
    expect(save.location).toEqual(st.location);
    expect(save.chapter).toBe(st.chapter);
    expectNoSecrets(text);

    // 取消回到選單主頁、遊戲狀態不變
    await g.pickMenu('取消');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    expect(await sl(page, () => window.__SL.feedback())).toBeNull();
    expect({ ...(await g.st()), playtime_s: 0 }).toEqual({ ...st, playtime_s: 0 });
    expect(cloudReqs).toEqual([]);
  });

  test('標題畫面也能複製：不在遊戲中的版本，附上唯一的存檔，不含權杖與轉移碼', async ({ page, context }, testInfo) => {
    const touch = isTouch(testInfo);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await seedCloudSecrets(page);
    const raw = JSON.stringify(makeSave({ player: { name: '標題測試' } }));
    await seedSaves(page, { 2: raw });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await titlePick(page, g, touch, '意見回饋');
    await g.waitScene('Menu');
    await page.waitForFunction(() => window.__SL.feedback()?.open === true);

    await g.pickMenu('複製回報資訊');
    await page.waitForFunction(() => window.__SL.feedback()?.copy === 'copied', null, { timeout: 5_000 });
    expect((await sl(page, () => window.__SL.feedback())).status).toBe(COPIED);
    const text = await readClipboard(page);
    const lines = text.split('\n');
    expect(lines[0]).toBe('【鋼鐵迷都 回報資訊】');
    expect(lines[4]).toBe('目前不在遊戲中');
    expect(lines[5]).toBe('附上的存檔：存檔 2（唯一的存檔）');
    expect(lines[6]).toBe(MARKER);
    expect(lines[7]).toBe(raw);
    expect(text).not.toContain('章節：');
    expect(text).not.toContain('雲端存檔：');
    expectNoSecrets(text);

    await g.pickMenu('取消');
    await g.waitScene('Title');
    expect(await sl(page, () => window.__SL.feedback())).toBeNull();
  });

  test('剪貼簿失敗（權限被拒）：顯示唯讀 textarea 讓玩家手動複製，取消後移除', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await breakClipboard(page);
    await seedCloudSecrets(page);
    await seedSaves(page, { 1: makeSave(), 3: makeSave({ player: { name: '第三格' } }) });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await titlePick(page, g, touch, '意見回饋');
    await g.waitScene('Menu');
    await page.waitForFunction(() => window.__SL.feedback()?.open === true);

    await g.pickMenu('複製回報資訊');
    await page.waitForFunction(() => window.__SL.feedback()?.copy === 'fallback', null, { timeout: 5_000 });
    expect(await sl(page, () => window.__clipCalls)).toBe(1);
    const fb = await sl(page, () => window.__SL.feedback());
    expect(fb.status).toBe(FAILED);
    expect(fb.fallback).toMatchObject({ tag: 'TEXTAREA', readOnly: true });
    const ta = page.locator('textarea.sl-report-text');
    await expect(ta).toHaveCount(1);
    const value = await ta.inputValue();
    expect(value.split('\n')[0]).toBe('【鋼鐵迷都 回報資訊】');
    expect(value).toContain('目前不在遊戲中');
    // 兩格存檔、沒有最近一次讀取的紀錄：不附存檔
    expect(value).toContain('沒有附上存檔（找不到最近一次讀取或存檔的槽位）');
    expectNoSecrets(value);
    // 純文字（不經 HTML）：textarea 裡沒有子元素
    expect(await ta.evaluate((el) => el.children.length)).toBe(0);
    await expectPromptLayout(page, g);
    await g.sleep(150);
    expect(await transparentPixels(page), '畫面不應出現透明（沒畫到）的區域').toBe(0);
    await shot(page, testInfo, 'report-fallback');

    // 點文字框會全選（方便手動複製）；文字框真的在最上層、點得到
    const bb = await ta.boundingBox();
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 })).toBe('TEXTAREA');
    if (touch) await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    else await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForFunction(() => {
      const el = document.querySelector('textarea.sl-report-text');
      return el && document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length;
    }, null, { timeout: 3_000 });
    expect(await ta.inputValue()).toBe(value); // 唯讀：內容不會被改

    // 取消（桌機：文字框裡按 Esc；手機：點「取消」）→ 回到標題、文字框移除
    if (touch) await g.pickMenu('取消');
    else await page.keyboard.press('Escape');
    await g.waitScene('Title');
    await expect(page.locator('textarea.sl-report-text')).toHaveCount(0);
    expect(await sl(page, () => window.__SL.feedback())).toBeNull();
  });
});
