// M3 雲端存檔（客戶端）：以 page.route 模擬 API（tests/e2e/cloud-mock.js，照 docs/API.md 的回應格式）。
// 手機（mobile 專案，375×667）全程用 tap 操作雲端選單與轉移碼輸入；桌機用滑鼠點。
import { join } from 'node:path';
import { test as base } from '@playwright/test';
import { expect, game, makeSave, seedSaves } from './helpers.js';
import { createMockCloud, MOCK_API } from './cloud-mock.js';

/**
 * 同 helpers.js 的錯誤蒐集 fixture，但忽略瀏覽器對「模擬 API 回非 2xx／連線失敗」自動印的
 * 「Failed to load resource」（那是瀏覽器的網路紀錄，不是遊戲程式的錯誤；本檔正是在測這些錯誤情況）。
 * 只忽略 URL 是模擬 API 的那幾筆，其他 console error 與 pageerror 照樣讓測試失敗。
 */
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('console', (m) => {
      if (m.type() !== 'error' || /GL Driver Message/.test(m.text())) return;
      if (/^Failed to load resource/.test(m.text()) && (m.location()?.url ?? '').startsWith(MOCK_API)) return;
      errors.push(`[console.error] ${m.text()} @ ${m.location()?.url ?? ''}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await use(page);
    expect(errors, '測試過程中不應有 console error 或 pageerror').toEqual([]);
  },
});

const CLOUD_URL = `./?test=1&api=${encodeURIComponent(MOCK_API)}`;
const CLOUD_KEY = 'steel-labyrinth:cloud';
const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const UNAVAILABLE = '雲端暫時無法使用，稍後再試';
const RELINK = '此裝置的雲端連結已失效，請重新用轉移碼接續';

/** 頁面載入前寫入雲端資訊（只寫一次）。 */
async function seedCloud(page, info) {
  await page.addInitScript(([k, v]) => {
    if (sessionStorage.getItem('__sl_cloud_seeded')) return;
    sessionStorage.setItem('__sl_cloud_seeded', '1');
    localStorage.setItem(k, v);
  }, [CLOUD_KEY, JSON.stringify(info)]);
}

async function shot(page, testInfo, name) {
  await page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`) });
  if (process.env.SL_SHOT_DIR) await page.screenshot({ path: join(process.env.SL_SHOT_DIR, `${name}-${testInfo.project.name}.png`) });
}

/** 雲端相關操作：依 id 點選單項目（手機 tap、桌機滑鼠）、等雲端頁面。 */
function cloudUi(page, g) {
  const menu = () => page.evaluate(() => window.__SL.menu());
  const state = () => page.evaluate(() => window.__SL.cloud());
  const waitCloud = (p, timeout = 10_000) =>
    page.waitForFunction((x) => window.__SL.menu()?.cloud?.page === x, p, { timeout });
  async function pick(id) {
    await page.waitForFunction((x) => (window.__SL.menu()?.items ?? []).some((it) => it.id === x && it.enabled), id, { timeout: 8_000 });
    const it = (await menu()).items.find((x) => x.id === id);
    await g.pointAt(it.x, it.y);
  }
  async function titlePick(label) {
    await g.waitScene('Title', 15_000);
    await page.waitForFunction((l) => (window.__SL.title()?.items ?? []).some((it) => it.label === l && it.enabled), label, { timeout: 8_000 });
    await g.sleep(200);
    const it = (await page.evaluate(() => window.__SL.title())).items.find((x) => x.label === label);
    await g.pointAt(it.x, it.y);
  }
  async function loadFromTitle(slot) {
    await titlePick('繼續');
    await g.waitScene('Menu');
    await g.pickMenu(`存檔 ${slot}`);
    await g.waitScene('Map');
    await g.sleep(150);
  }
  async function openCloudMenu() {
    await g.act('menu');
    await g.waitScene('Menu');
    await g.pickMenu('雲端存檔');
  }
  /** 遊戲中：（主選單 → 存檔）→ 第 slot 格（已有資料時確認覆蓋）。 */
  async function saveTo(slot, occupied) {
    // 已經在存檔頁（上一次存檔後停在這裡）時直接選格子；在主選單時先進「存檔」
    if ((await menu())?.page === 'main') await g.pickMenu('存檔');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save');
    await g.pickMenu(`存檔 ${slot}`);
    if (occupied) {
      await page.waitForFunction(() => window.__SL.menu()?.page === 'confirm');
      await g.pickMenu('覆蓋');
    }
  }
  async function typeCode(p, text, touch) {
    const box = p.locator('.sl-code-input');
    await box.waitFor();
    if (touch) {
      await box.tap();
      await p.keyboard.press('Control+A');
      await p.keyboard.press('Backspace');
      await p.keyboard.type(text);
    } else {
      await box.fill(text);
    }
  }
  const localSlot = (slot) => page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, `steel-labyrinth:save:${slot}`);
  return { menu, state, waitCloud, pick, titlePick, loadFromTitle, openCloudMenu, saveTo, typeCode, localSlot };
}

/** 另一個 browser context（另一台裝置），沿用目前專案的視窗與觸控設定；console error 一樣要為空。 */
async function otherDevice(browser, testInfo) {
  const u = testInfo.project.use;
  const ctx = await browser.newContext({
    viewport: u.viewport, hasTouch: u.hasTouch, isMobile: u.isMobile, deviceScaleFactor: u.deviceScaleFactor,
    baseURL: u.baseURL ?? 'http://localhost:8091/',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' || /GL Driver Message/.test(m.text())) return;
    if (/^Failed to load resource/.test(m.text()) && (m.location()?.url ?? '').startsWith(MOCK_API)) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

test.describe('M3 雲端存檔（客戶端，模擬 API）', () => {
  test('啟用雲端 → 上傳 → 查看轉移碼；另一台裝置用轉移碼接續 → 下載 → 讀取並移動；原裝置連結失效', async ({ page, browser }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    await seedSaves(page, { 1: makeSave({ player: { name: '雲端艾琳' }, playtime_s: 321 }) });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    expect((await u.state())).toMatchObject({ enabled: false, apiBase: MOCK_API });
    await u.loadFromTitle(1);

    // 啟用
    await u.openCloudMenu();
    await u.waitCloud('intro');
    await u.pick('enable');
    await u.waitCloud('cloud');
    let m = await u.menu();
    expect(m.cloud.status).toBe('已啟用雲端存檔');
    expect(m.cloud.slots[0].local).toMatchObject({ empty: false, name: '雲端艾琳', playtime_s: 321 });
    expect(m.cloud.slots[0].cloud).toEqual({ slot: 1, empty: true });
    expect(m.items.find((x) => x.id === 'down1').enabled).toBe(false);
    for (const it of m.items) {
      expect(it.h, `${it.id} 高度`).toBeGreaterThanOrEqual(44);
      expect(it.x - it.w / 2).toBeGreaterThanOrEqual(16);
      expect(it.x + it.w / 2).toBeLessThanOrEqual(344);
      expect(it.y + it.h / 2).toBeLessThanOrEqual(570);
    }
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), CLOUD_KEY);
    expect(stored.token).toBe(mock.players[0].token);

    // 上傳（新建：If-None-Match: *）
    await u.pick('up1');
    await u.waitCloud('cloud');
    m = await u.menu();
    expect(m.cloud.status).toBe('已上傳存檔 1');
    expect(m.cloud.slots[0].cloud).toMatchObject({ empty: false, version: 1, summary: { name: '雲端艾琳', map: 'attic', playtime_s: 321 } });
    const put = mock.calls(/\/api\/save\/1$/, 'PUT')[0];
    expect(put.headers['if-none-match']).toBe('*');
    expect(put.headers.authorization).toBe(`Bearer ${mock.players[0].token}`);
    expect((await u.state()).slots).toEqual({ 1: { version: 1, updated_at: expect.any(Number) } });
    await shot(page, testInfo, 'cloud-menu');

    // 查看轉移碼
    await u.pick('code');
    await u.waitCloud('code');
    m = await u.menu();
    const code = m.cloud.code;
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(code).toBe(mock.players[0].transfer_code ?? mock.players[0].code);
    expect(m.cloud.warning).toBe('轉移碼等同密碼，請勿分享');
    const st = await u.state();
    expect(st.transferCode).toBe(code);
    expect(JSON.stringify(st)).not.toContain(mock.players[0].token); // __SL.cloud 不暴露權杖

    // 另一台裝置
    const b = await otherDevice(browser, testInfo);
    await mock.attach(b.page);
    const gB = game(b.page, { touch });
    const uB = cloudUi(b.page, gB);
    await b.page.goto(CLOUD_URL);
    await gB.waitScene('Title', 15_000);
    expect((await b.page.evaluate(() => window.__SL.title())).items.find((x) => x.label === '繼續').enabled).toBe(false);
    await uB.titlePick('用轉移碼接續');
    await uB.waitCloud('transfer-input');
    // 格式不對：不送請求
    await uB.typeCode(b.page, 'abc', touch);
    await uB.pick('transfer-go');
    await b.page.waitForFunction(() => !!window.__SL.menu()?.cloud?.error);
    expect((await uB.menu()).cloud.error).toContain('8 個英文字母或數字');
    expect(mock.calls(/\/api\/transfer$/).length).toBe(0);
    // 格式對但不存在：伺服器 404
    await uB.typeCode(b.page, 'zzzz-zzzz', touch);
    await uB.pick('transfer-go');
    await b.page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'transfer-input' && /不正確/.test(window.__SL.menu()?.cloud?.error ?? ''));
    // 正確的碼（小寫、空白代替連字號）
    await uB.typeCode(b.page, code.toLowerCase().replace('-', ' '), touch);
    await shot(b.page, testInfo, 'transfer-input');
    await uB.pick('transfer-go');
    await uB.waitCloud('transfer-slots');
    const slots = (await uB.menu()).cloud.slots;
    expect(slots[0]).toMatchObject({ slot: 1, empty: false, summary: { name: '雲端艾琳' } });
    expect(mock.calls(/\/api\/transfer$/).at(-1).body).toEqual({ code });
    await uB.pick('cloud1');
    await uB.waitCloud('transfer-target');
    await uB.pick('to2'); // 本機第 2 格是空的：不用確認
    await uB.waitCloud('transfer-done');
    expect((await uB.localSlot(2)).player.name).toBe('雲端艾琳');
    const stB = await b.page.evaluate(() => window.__SL.cloud());
    expect(stB.enabled).toBe(true);
    expect(stB.transferCode).not.toBe(code); // 用過就換新碼
    await uB.pick('play');
    await gB.waitScene('Map');
    let sB = await gB.st();
    expect(sB.player.name).toBe('雲端艾琳');
    expect(sB.playtime_s).toBeGreaterThanOrEqual(321);
    await gB.stepDir('right');
    sB = await gB.st();
    expect(sB.location).toMatchObject({ map: 'attic', x: 3, y: 3 });
    expect(b.errors).toEqual([]);
    await b.ctx.close();

    // 原裝置：權杖已被轉移作廢 → 提示並清除本機雲端資訊
    await u.pick('back');
    await u.waitCloud('relink');
    expect((await u.menu()).note).toBe(RELINK);
    expect((await u.state()).enabled).toBe(false);
    expect(await page.evaluate((k) => localStorage.getItem(k), CLOUD_KEY)).toBeNull();
    await u.pick('relink-ok');
    await u.waitCloud('intro');
  });

  test('409 衝突：取消／用本機的（覆蓋雲端）／用雲端的；current 為 null 時顯示雲端已是空的', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const cloudSave = JSON.stringify(makeSave({ player: { name: '別台' }, playtime_s: 900, location: { map: 'attic', x: 5, y: 3, dir: 'down' } }));
    const p = mock.seedPlayer({ saves: { 1: { version: 3, data: cloudSave } } });
    await seedCloud(page, { ...p, slots: { 1: { version: 2, updated_at: 1_760_000_000 } } });
    await seedSaves(page, { 1: makeSave({ player: { name: '本機' }, playtime_s: 50 }) });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('cloud');

    // 衝突 → 取消
    await u.pick('up1');
    await u.waitCloud('conflict');
    let c = (await u.menu()).cloud.conflict;
    expect(c).toMatchObject({ slot: 1, cloudVersion: 3, cloud: { empty: false, name: '別台', playtime_s: 900, map: 'attic' }, local: { name: '本機', playtime_s: 50 } });
    expect(mock.calls(/\/api\/save\/1$/, 'PUT')[0].headers['if-match']).toBe('"2"');
    const labels = (await u.menu()).items.map((x) => x.label);
    expect(labels).toEqual(['用雲端的', '用本機的（覆蓋雲端）', '取消']);
    await shot(page, testInfo, 'cloud-conflict');
    await u.pick('cancel');
    await u.waitCloud('cloud');
    expect((await u.menu()).cloud.status).toBe('已取消，雲端與本機都沒有變更');
    expect(mock.players[0].saves[1].version).toBe(3);
    expect((await u.localSlot(1)).player.name).toBe('本機');

    // 衝突 → 用本機的（以衝突時的雲端版本 3 為 If-Match）
    await u.pick('up1');
    await u.waitCloud('conflict');
    await u.pick('use-local');
    await u.waitCloud('cloud');
    expect((await u.menu()).cloud.status).toBe('已用本機的存檔 1 覆蓋雲端');
    expect(mock.calls(/\/api\/save\/1$/, 'PUT').at(-1).headers['if-match']).toBe('"3"');
    expect(mock.players[0].saves[1].version).toBe(4);
    expect(JSON.parse(mock.players[0].saves[1].data).player.name).toBe('本機');
    expect((await u.state()).slots[1].version).toBe(4);

    // 別台裝置又寫了一次 → 衝突 → 用雲端的（下載覆蓋本機）
    const v = mock.serverWrite(p.token, 1, JSON.stringify(makeSave({ player: { name: '第三台' }, playtime_s: 1200 })));
    expect(v).toBe(5);
    await u.pick('up1');
    await u.waitCloud('conflict');
    c = (await u.menu()).cloud.conflict;
    expect(c.cloud.name).toBe('第三台');
    await u.pick('use-cloud');
    await u.waitCloud('cloud');
    expect((await u.menu()).cloud.status).toBe('已下載到存檔 1');
    expect((await u.localSlot(1)).player.name).toBe('第三台');
    expect((await u.state()).slots[1].version).toBe(5);

    // current 為 null（衝突後槽又被刪除，API.md 補充 3）
    mock.fail(({ method, path }) => method === 'PUT' && path === '/api/save/1',
      { status: 409, body: { error: 'conflict', message: '版本不符', current: null } });
    await u.pick('up1');
    await u.waitCloud('conflict');
    const m = await u.menu();
    expect(m.cloud.conflict.cloud).toEqual({ empty: true });
    expect(m.items.find((x) => x.id === 'use-cloud').enabled).toBe(false);
    await u.pick('cancel');
    await u.waitCloud('cloud');
  });

  test('下載會覆蓋本機槽時先確認；雲端摘要欄位為 null 時顯示「—」', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer({ saves: { 1: { version: 7, data: JSON.stringify(makeSave({ player: { name: '雲端版' } })) } } });
    await seedCloud(page, p);
    await seedSaves(page, { 1: makeSave({ player: { name: '本機版' } }) });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('cloud');
    await u.pick('down1');
    await u.waitCloud('confirm-download');
    expect((await u.menu()).note).toBe('下載會覆蓋本機的存檔 1，確定嗎？');
    await u.pick('cancel');
    await u.waitCloud('cloud');
    expect((await u.localSlot(1)).player.name).toBe('本機版');
    await u.pick('down1');
    await u.waitCloud('confirm-download');
    await u.pick('confirm-download');
    await u.waitCloud('cloud');
    expect((await u.menu()).cloud.status).toBe('已下載到存檔 1');
    expect((await u.localSlot(1)).player.name).toBe('雲端版');
    expect((await u.state()).slots[1].version).toBe(7); // 版本以伺服器為準，不假設從 1 開始

    // summary 欄位為 null（版本較新的存檔，API.md 補充 4）
    mock.fail(({ method, path }) => method === 'GET' && path === '/api/saves', {
      status: 200,
      body: { slots: [{ slot: 1, version: 8, updated_at: 1_760_000_000, summary: { name: null, map: null, chapter: null, playtime_s: null, schema_version: 3 } }, { slot: 2, empty: true }, { slot: 3, empty: true }] },
    });
    await u.pick('settings');
    await u.waitCloud('settings');
    await u.pick('back');
    await u.waitCloud('cloud');
    const cs = (await u.menu()).cloud.slots[0].cloud;
    expect(cs.summary).toEqual({ name: null, map: null, chapter: null, playtime_s: null });
  });

  test('手動存檔後詢問上傳；網路錯誤／429／逾時時本機存讀檔照常；可勾「以後自動上傳」', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer();
    await seedCloud(page, p);
    await seedSaves(page, { 1: makeSave({ player: { name: '存檔測試' } }) });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    const noteOf = async () => (await u.menu()).note;
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await g.act('menu');
    await g.waitScene('Menu');

    // 網路錯誤
    await u.saveTo(2, false);
    await u.waitCloud('ask-upload');
    expect((await u.menu()).note).toBe('已存檔到存檔 2。\n也要上傳到雲端嗎？');
    mock.fail(({ method }) => method === 'PUT', 'abort');
    await u.pick('ask-upload');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && /雲端/.test(window.__SL.menu()?.note ?? ''));
    expect(await noteOf()).toBe(`已存檔到存檔 2。\n${UNAVAILABLE}`);
    expect((await u.localSlot(2)).player.name).toBe('存檔測試');

    // 429：顯示需要等待的秒數
    await u.saveTo(3, false);
    await u.waitCloud('ask-upload');
    mock.fail(({ method }) => method === 'PUT', { status: 429, headers: { 'Retry-After': '120' }, body: { error: 'rate_limited', message: '太頻繁' } });
    await u.pick('ask-upload');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && /秒/.test(window.__SL.menu()?.note ?? ''));
    expect(await noteOf()).toBe('已存檔到存檔 3。\n雲端暫時無法使用，請等 120 秒後再試');
    expect(await u.localSlot(3)).not.toBeNull();

    // 「不用」：不上傳
    await u.saveTo(2, true);
    await u.waitCloud('ask-upload');
    const puts = mock.calls(/\/api\/save\//, 'PUT').length;
    await u.pick('ask-skip');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save');
    expect(await noteOf()).toBe('已存檔到存檔 2');
    expect(mock.calls(/\/api\/save\//, 'PUT').length).toBe(puts);

    // 勾「以後自動上傳」再上傳
    await u.saveTo(3, true);
    await u.waitCloud('ask-upload');
    await u.pick('ask-auto');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.autoUpload === true);
    expect((await u.menu()).items.find((x) => x.id === 'ask-auto').label).toBe('以後自動上傳：是');
    await u.pick('ask-upload');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && /並已上傳/.test(window.__SL.menu()?.note ?? ''));
    expect(await noteOf()).toBe('已存檔到存檔 3，並已上傳到雲端');
    expect((await u.state()).autoUpload).toBe(true);
    expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), CLOUD_KEY)).auto_upload).toBe(true);

    // 之後存檔自動上傳（不再詢問）；這次伺服器不回應 → 5 秒逾時，本機照樣存好
    mock.fail(({ method }) => method === 'PUT', 'hang');
    const t0 = Date.now();
    await u.saveTo(2, true);
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && /雲端/.test(window.__SL.menu()?.note ?? ''), null, { timeout: 12_000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4_500);
    expect(await noteOf()).toBe(`已存檔到存檔 2。\n${UNAVAILABLE}`);
    expect((await u.state()).lastError).toMatchObject({ op: 'upload', kind: 'timeout' });

    // 讀檔照常
    await g.key('Escape');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await g.pickMenu('讀取');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'load');
    await g.pickMenu('存檔 2');
    await g.waitScene('Map');
    expect((await g.st()).player.name).toBe('存檔測試');
  });

  test('401：雲端選單提示連結失效並清除本機雲端資訊；啟用失敗、列表失敗都只顯示暫時無法使用', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    await seedCloud(page, { player_id: 'p-old', token: 'revoked-token', transfer_code: 'ABCD-EFGH' });
    await seedSaves(page, { 1: makeSave() });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('relink');
    expect((await u.menu()).note).toBe(RELINK);
    expect(await page.evaluate((k) => localStorage.getItem(k), CLOUD_KEY)).toBeNull();
    await u.pick('relink-ok');
    await u.waitCloud('intro');

    // 啟用時網路錯誤
    mock.fail(({ path }) => path === '/api/player', 'abort');
    await u.pick('enable');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'intro' && !!window.__SL.menu()?.cloud?.status);
    expect((await u.menu()).cloud.status).toBe(UNAVAILABLE);
    expect((await u.state()).enabled).toBe(false);

    // 啟用成功，但列表 503 → 總覽照樣顯示本機，雲端欄「無法取得」，下載停用
    mock.fail(({ path }) => path === '/api/saves', { status: 503, body: { error: 'internal', message: 'x' } });
    await u.pick('enable');
    await u.waitCloud('cloud');
    const m = await u.menu();
    expect(m.cloud.slots[0].cloud).toBeNull();
    expect(m.cloud.status).toBe('已啟用雲端存檔');
    expect(m.items.find((x) => x.id === 'down1').enabled).toBe(false);
    expect(m.items.find((x) => x.id === 'up1').enabled).toBe(true);

    // 停用此裝置的雲端（先確認）
    await u.pick('settings');
    await u.waitCloud('settings');
    await u.pick('disable');
    await u.waitCloud('confirm-disable');
    expect((await u.menu()).note).toContain('目前的轉移碼：');
    await u.pick('cancel');
    await u.waitCloud('settings');
    expect((await u.state()).enabled).toBe(true);
    await u.pick('disable');
    await u.waitCloud('confirm-disable');
    await u.pick('confirm-disable');
    await u.waitCloud('intro');
    expect((await u.menu()).cloud.status).toBe('已停用此裝置的雲端');
    expect((await u.state()).enabled).toBe(false);
    expect(mock.calls(/\/api\/save\//, 'DELETE').length).toBe(0); // 只清本機資訊
  });

  test('重新產生轉移碼：先確認，舊碼失效', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer();
    await seedCloud(page, p);
    await seedSaves(page, { 1: makeSave() });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('cloud');
    await u.pick('code');
    await u.waitCloud('code');
    expect((await u.menu()).cloud.code).toBe(p.transfer_code);
    await u.pick('rotate');
    await u.waitCloud('confirm-rotate');
    await u.pick('confirm-rotate');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'code' && !!window.__SL.menu()?.cloud?.status);
    const m = await u.menu();
    expect(m.cloud.status).toBe('已產生新的轉移碼');
    expect(m.cloud.code).not.toBe(p.transfer_code);
    expect(m.cloud.code).toBe(mock.players[0].code);
  });

  test('章節完成：已啟用雲端時自動回報 /api/clear；失敗只記 console', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer();
    await seedCloud(page, p);
    const nearEnd = makeSave({
      location: { map: 'street', x: 6, y: 2, dir: 'down' }, playtime_s: 77, collapse: 3,
      flags: { 'enter:attic': true, 'enter:hallway': true, 'enter:street': true, door_open: true, talked_landlady: true },
    });
    await seedSaves(page, { 1: nearEnd });
    // 手機專案：伺服器 500 → 只記 console.warn（fixture 確認沒有 console.error）
    if (touch) mock.fail(({ path }) => path === '/api/clear', { status: 500 });
    const warns = [];
    page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await g.stepDir('down');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await g.waitScene('ChapterEnd');
    await page.waitForFunction(() => ['ok', 'failed'].includes(window.__SL.debug().chapterEnd?.clearReport?.status));
    const calls = mock.calls(/\/api\/clear$/, 'POST');
    expect(calls.length).toBe(1);
    expect(calls[0].body).toMatchObject({ chapter: 'prologue', ending: null, collapse: 3 });
    expect(calls[0].body.play_seconds).toBeGreaterThanOrEqual(77);
    const rep = (await page.evaluate(() => window.__SL.debug())).chapterEnd.clearReport;
    expect(rep.status).toBe(touch ? 'failed' : 'ok');
    if (touch) expect(warns.some((w) => w.includes('通關紀錄回報失敗'))).toBe(true);
    // 章節結束畫面照常可以操作
    await g.pickChapterEnd('存檔');
    await g.waitScene('Menu');
  });

  test('未啟用雲端：章節完成不回報、存檔後不詢問上傳', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    await seedSaves(page, { 1: makeSave() });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await g.act('menu');
    await g.waitScene('Menu');
    await u.saveTo(2, false);
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && window.__SL.menu()?.note === '已存檔到存檔 2');
    expect(mock.log.length).toBe(0);
  });
});
