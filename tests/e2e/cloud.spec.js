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
    // 修訂 2 A：新權杖與新轉移碼由客戶端產生後送出
    const tbody = mock.calls(/\/api\/transfer$/).at(-1).body;
    expect(tbody).toMatchObject({ code, new_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), new_transfer_code: expect.stringMatching(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/) });
    await uB.pick('cloud1');
    await uB.waitCloud('transfer-target');
    await uB.pick('to2'); // 本機第 2 格是空的：不用確認
    await uB.waitCloud('transfer-done');
    expect((await uB.localSlot(2)).player.name).toBe('雲端艾琳');
    const stB = await b.page.evaluate(() => window.__SL.cloud());
    expect(stB.enabled).toBe(true);
    expect(stB.transferCode).not.toBe(code); // 用過就換新碼
    expect(stB.transferCode).toBe(tbody.new_transfer_code);
    expect(await b.page.evaluate((k) => JSON.parse(localStorage.getItem(k)).token, CLOUD_KEY)).toBe(tbody.new_token);
    expect(await b.page.evaluate(() => localStorage.getItem('steel-labyrinth:cloud-pending'))).toBeNull();
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
    // 修訂 2 C：所有 POST／PUT 都帶 application/json
    for (const c of mock.log.filter((l) => l.method === 'POST' || l.method === 'PUT')) {
      expect(c.headers['content-type'], `${c.method} ${c.path}`).toMatch(/^application\/json/);
    }

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

    // 429：顯示需要等待的時間（修訂 2 G：1 分鐘以上顯示「約 N 分鐘」）
    await u.saveTo(3, false);
    await u.waitCloud('ask-upload');
    mock.fail(({ method }) => method === 'PUT', { status: 429, headers: { 'Retry-After': '120' }, body: { error: 'rate_limited', message: '太頻繁' } });
    await u.pick('ask-upload');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && /分鐘/.test(window.__SL.menu()?.note ?? ''));
    expect(await noteOf()).toBe('已存檔到存檔 3。\n雲端暫時無法使用，請等約 2 分鐘後再試');
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
    await seedCloud(page, { player_id: 'p-old', token: 'r'.repeat(43), transfer_code: 'ABCD-EFGH' }); // 格式正確但已作廢
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

// ---------------------------------------------------------------------------
// 修訂 2（M3 第一輪對抗審查的客戶端修正）
const PENDING_KEY = 'steel-labyrinth:cloud-pending';
const lsGet = (p, k) => p.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), k);
const isPost = (re) => ({ method, path }) => method === 'POST' && re.test(path);

test.describe('M3 雲端存檔：修訂 2（秘密由客戶端產生、雜湊判定、上傳前驗證、未開放）', () => {
  test('A：轉移回應延遲 5.1 秒 → 逾時後用新權杖確認，最終接續成功；舊裝置失效、新裝置可用', async ({ page, browser }, testInfo) => {
    test.setTimeout(150_000);
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer({ saves: { 1: { version: 3, data: JSON.stringify(makeSave({ player: { name: '舊裝置' }, playtime_s: 400 })) } } });
    await seedCloud(page, p);
    await seedSaves(page, { 1: makeSave({ player: { name: '舊裝置' } }) });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);

    const b = await otherDevice(browser, testInfo);
    await mock.attach(b.page);
    const gB = game(b.page, { touch });
    const uB = cloudUi(b.page, gB);
    await b.page.goto(CLOUD_URL);
    await uB.titlePick('用轉移碼接續');
    await uB.waitCloud('transfer-input');
    await uB.typeCode(b.page, p.transfer_code, touch);
    mock.fail(isPost(/^\/api\/transfer$/), { delay: 5100 }); // 伺服器做完了，但回應比 5 秒逾時晚到
    const t0 = Date.now();
    await uB.pick('transfer-go');
    await uB.waitCloud('transfer-slots', 20_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5_000);
    const sent = mock.calls(/^\/api\/transfer$/, 'POST')[0];
    expect(sent.fault).toEqual({ delay: 5100 });
    // 逾時後用 new_token 呼叫 GET /api/saves 確認成功
    expect(mock.calls(/^\/api\/saves$/, 'GET').some((c) => c.headers.authorization === `Bearer ${sent.body.new_token}`)).toBe(true);
    const infoB = await lsGet(b.page, CLOUD_KEY);
    expect(infoB.token).toBe(sent.body.new_token);
    expect(infoB.token).toBe(mock.players[0].token);
    expect(infoB.transfer_code).toBe(sent.body.new_transfer_code);
    expect(await lsGet(b.page, PENDING_KEY)).toBeNull();
    expect((await uB.menu()).cloud.slots[0]).toMatchObject({ slot: 1, empty: false, summary: { name: '舊裝置' } });
    await shot(b.page, testInfo, 'rev2-transfer-timeout-recovered');
    // 新裝置可用：下載 → 開始遊玩
    await uB.pick('cloud1');
    await uB.waitCloud('transfer-target');
    await uB.pick('to1');
    await uB.waitCloud('transfer-done');
    await uB.pick('play');
    await gB.waitScene('Map');
    expect((await gB.st()).player.name).toBe('舊裝置');
    expect(b.errors).toEqual([]);
    await b.ctx.close();
    // 舊裝置失效
    await u.openCloudMenu();
    await u.waitCloud('relink');
    expect((await u.state()).enabled).toBe(false);
  });

  test('A：轉移送出後馬上重新整理 → 重新載入時用待確認區的新權杖恢復成已接續', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer();
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.titlePick('用轉移碼接續');
    await u.waitCloud('transfer-input');
    await u.typeCode(page, p.transfer_code, touch);
    mock.fail(isPost(/^\/api\/transfer$/), { delay: 3000 });
    await u.pick('transfer-go');
    await expect.poll(() => mock.calls(/^\/api\/transfer$/, 'POST').length).toBe(1);
    // 秘密在送出前已經寫進待確認區
    const sent = mock.calls(/^\/api\/transfer$/, 'POST')[0].body;
    expect(await lsGet(page, PENDING_KEY)).toMatchObject({ op: 'transfer', new_token: sent.new_token, new_transfer_code: sent.new_transfer_code });
    await page.reload();
    await g.waitScene('Title', 15_000);
    await page.waitForFunction(() => window.__SL.cloud().enabled === true, null, { timeout: 10_000 });
    expect((await lsGet(page, CLOUD_KEY)).token).toBe(mock.players[0].token);
    expect((await u.state()).transferCode).toBe(sent.new_transfer_code);
    expect(await lsGet(page, PENDING_KEY)).toBeNull();
  });

  test('A：建立玩家逾時 → 再按啟用用同一組秘密重送，不會多建帳號', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    await seedSaves(page, { 1: makeSave() });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('intro');
    mock.fail(isPost(/^\/api\/player$/), { delay: 5100 });
    await u.pick('enable');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'intro' && !!window.__SL.menu()?.cloud?.status, null, { timeout: 15_000 });
    expect((await u.menu()).cloud.status).toBe(UNAVAILABLE);
    expect(mock.players.length).toBe(1); // 伺服器其實建好了
    await u.pick('enable');
    await u.waitCloud('cloud');
    expect((await u.menu()).cloud.status).toBe('已啟用雲端存檔');
    const bodies = mock.calls(/^\/api\/player$/, 'POST').map((c) => c.body);
    expect(bodies.length).toBe(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(mock.players.length).toBe(1);
    expect((await lsGet(page, CLOUD_KEY)).token).toBe(mock.players[0].token);
  });

  test('B：上傳回應延遲 5.1 秒 → 再上傳不出現衝突畫面（雲端總覽與存檔後上傳兩種路徑）', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer();
    await seedCloud(page, p);
    await seedSaves(page, { 1: makeSave({ player: { name: '逾時上傳' } }) });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    const putSlot = (n) => ({ method, path }) => method === 'PUT' && path === `/api/save/${n}`;
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);

    // (1) 存檔後詢問上傳：PUT 回應晚 5.1 秒 → 逾時；伺服器其實寫進去了
    await g.act('menu');
    await g.waitScene('Menu');
    await u.saveTo(2, false);
    await u.waitCloud('ask-upload');
    mock.fail(putSlot(2), { delay: 5100 });
    await u.pick('ask-upload');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && /雲端/.test(window.__SL.menu()?.note ?? ''), null, { timeout: 15_000 });
    expect((await u.menu()).note).toBe(`已存檔到存檔 2。\n${UNAVAILABLE}`);
    expect(mock.players[0].saves[2].version).toBe(1);
    expect((await u.state()).slots[2].pending_sha256).toMatch(/^[0-9a-f]{64}$/); // 送出前記下的內容雜湊
    // 再存一次同一格並上傳：先刷新列表（雜湊相符 → 採用版本 1），不出現衝突
    await u.saveTo(2, true);
    await u.waitCloud('ask-upload');
    await u.pick('ask-upload');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && /並已上傳/.test(window.__SL.menu()?.note ?? ''), null, { timeout: 12_000 });
    expect((await u.menu()).note).toBe('已存檔到存檔 2，並已上傳到雲端');
    const lastGets = mock.log.filter((l) => l.method === 'GET' && l.path === '/api/saves');
    expect(lastGets.length).toBeGreaterThanOrEqual(1);
    expect((await u.state()).slots[2].version).toBeGreaterThanOrEqual(1);
    expect((await u.state()).slots[2].pending_sha256).toBeUndefined();

    // (2) 雲端總覽：上傳逾時 → 總覽重新讀取時以雜湊認出已寫入 → 再上傳也不衝突
    await g.key('Escape');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await g.pickMenu('雲端存檔');
    await u.waitCloud('cloud');
    mock.fail(putSlot(1), { delay: 5100 });
    await u.pick('up1');
    await page.waitForFunction((x) => window.__SL.menu()?.cloud?.page === 'cloud' && window.__SL.menu()?.cloud?.status === x, UNAVAILABLE, { timeout: 15_000 });
    await shot(page, testInfo, 'rev2-upload-timeout');
    expect(mock.players[0].saves[1].version).toBe(1);
    expect((await u.state()).slots[1]).toEqual({ version: 1, updated_at: expect.any(Number) });
    await u.pick('up1');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'cloud' && /已上傳/.test(window.__SL.menu()?.cloud?.status ?? ''), null, { timeout: 12_000 });
    expect((await u.menu()).cloud.status).toBe('已上傳存檔 1');
    expect(mock.calls(/\/api\/save\/1$/, 'PUT').at(-1).headers['if-match']).toBe('"1"');
    expect(mock.log.some((l) => l.method === 'PUT' && l.fault === undefined && l.headers['if-none-match'] === '*' && l.path === '/api/save/1')).toBe(false);
  });

  test('B：上傳中途重新整理 → 之後再上傳（內容也變了）不出現衝突畫面', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer({ saves: { 1: { version: 4, data: JSON.stringify(makeSave({ player: { name: '雲端舊版' } })) } } });
    await seedCloud(page, { ...p, slots: { 1: { version: 4, updated_at: 1_760_000_000 } } });
    await seedSaves(page, { 1: makeSave({ player: { name: '重新整理' }, playtime_s: 10 }) });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('cloud');
    mock.fail(({ method, path }) => method === 'PUT' && path === '/api/save/1', { delay: 3000 });
    await u.pick('up1');
    await expect.poll(() => mock.calls(/\/api\/save\/1$/, 'PUT').length).toBe(1);
    await page.reload(); // 回應還沒到就重新整理
    await expect.poll(() => mock.players[0].saves[1].version).toBe(5);
    // 本機存檔又變了（再玩一下存檔）
    await page.evaluate(() => {
      const k = 'steel-labyrinth:save:1';
      const o = JSON.parse(localStorage.getItem(k));
      o.playtime_s = 999;
      localStorage.setItem(k, JSON.stringify(o));
    });
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('cloud');
    await u.pick('up1');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'cloud' && /已上傳/.test(window.__SL.menu()?.cloud?.status ?? ''), null, { timeout: 12_000 });
    expect((await u.menu()).cloud.status).toBe('已上傳存檔 1');
    const puts = mock.calls(/\/api\/save\/1$/, 'PUT');
    expect(puts.at(-1).headers['if-match']).toBe('"5"');
    expect(mock.players[0].saves[1].version).toBe(6);
    expect(JSON.parse(mock.players[0].saves[1].data).playtime_s).toBeGreaterThanOrEqual(999);
  });

  test('A：重新產生轉移碼逾時 → 標示「新轉移碼尚未確認」，重試用同一個碼；重新整理後自動重送', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
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
    mock.fail(isPost(/^\/api\/transfer\/rotate$/), { delay: 5100 });
    await u.pick('rotate');
    await u.waitCloud('confirm-rotate');
    await u.pick('confirm-rotate');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'code' && !!window.__SL.menu()?.cloud?.status, null, { timeout: 15_000 });
    let v = (await u.menu()).cloud;
    expect(v).toMatchObject({ confirmed: false, warning: '新轉移碼尚未確認', previousCode: p.transfer_code, status: UNAVAILABLE });
    const newCode = v.pendingCode;
    expect(v.code).toBe(newCode);
    expect(newCode).not.toBe(p.transfer_code);
    expect(mock.players[0].code).toBe(newCode); // 伺服器已經換成這個碼（顯示的不是死碼）
    expect((await u.state()).transferCode).toBe(p.transfer_code);
    await shot(page, testInfo, 'rev2-rotate-unconfirmed');
    await u.pick('rotate-retry');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'code' && window.__SL.menu()?.cloud?.status === '已產生新的轉移碼', null, { timeout: 12_000 });
    v = (await u.menu()).cloud;
    expect(v).toMatchObject({ confirmed: true, code: newCode, pendingCode: null, warning: '轉移碼等同密碼，請勿分享' });
    expect(mock.calls(/^\/api\/transfer\/rotate$/, 'POST').map((c) => c.body)).toEqual([{ new_transfer_code: newCode }, { new_transfer_code: newCode }]);

    // 網路斷掉 → 尚未確認 → 重新整理後開機時自動用同一個碼重送
    mock.fail(isPost(/^\/api\/transfer\/rotate$/), 'abort');
    await u.pick('rotate');
    await u.waitCloud('confirm-rotate');
    await u.pick('confirm-rotate');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'code' && !!window.__SL.menu()?.cloud?.status, null, { timeout: 12_000 });
    const third = (await u.menu()).cloud.pendingCode;
    expect(third).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    await page.reload();
    await page.waitForFunction((c) => window.__SL.cloud().transferCode === c && window.__SL.cloud().pendingTransferCode === null, third, { timeout: 10_000 });
    expect(mock.players[0].code).toBe(third);
  });

  test('B：語意壞掉的本機存檔不能上傳：按鈕停用並顯示原因', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer();
    await seedCloud(page, p);
    await seedSaves(page, {
      1: makeSave(),
      2: makeSave({ player: { name: '壞檔' }, location: { map: 'nowhere', x: 99, y: 99, dir: 'down' } }),
    });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('cloud');
    const m = await u.menu();
    expect(m.items.find((x) => x.id === 'up1').enabled).toBe(true);
    expect(m.items.find((x) => x.id === 'up2').enabled).toBe(false);
    expect(m.cloud.slots[1].local).toMatchObject({ empty: false, broken: true, uploadable: false });
    expect(m.cloud.slots[1].local.reason).toContain('nowhere');
    expect(m.cloud.status).toBe('存檔 2 無法上傳：存檔所在的地圖「nowhere」不存在');
    await shot(page, testInfo, 'rev2-upload-disabled-reason');
    expect(mock.calls(/\/api\/save\//, 'PUT').length).toBe(0);
  });

  test('修訂 3：超過 16 KB 的本機存檔不能上傳並說明；伺服器 413 也有友善說明', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const p = mock.seedPlayer();
    await seedCloud(page, p);
    const flags = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`flag_${i}_長長的旗標名稱`, true]));
    await seedSaves(page, { 1: makeSave(), 3: makeSave({ flags: { ...makeSave().flags, ...flags } }) });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('cloud');
    let m = await u.menu();
    expect(m.items.find((x) => x.id === 'up3').enabled).toBe(false);
    expect(m.cloud.status).toMatch(/^存檔 3 無法上傳：存檔大小 \d+\.\d KB，超過雲端上限 16 KB$/);
    await shot(page, testInfo, 'rev3-upload-too-large');
    // 伺服器端仍回 413（例如上限調低）→ 友善說明
    mock.fail(({ method }) => method === 'PUT', { status: 413, body: { error: 'too_large', message: 'x' } });
    await u.pick('up1');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'cloud' && /16 KB/.test(window.__SL.menu()?.cloud?.status ?? ''));
    m = await u.menu();
    expect(m.cloud.status).toBe('存檔太大，超過雲端每格 16 KB 的上限，無法上傳');
  });

  test('G：沒有 API 位址＝雲端存檔尚未開放（選單與標題都顯示），不送任何雲端請求', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const external = [];
    page.on('request', (r) => { if (!/^https?:\/\/(localhost:8091|fonts\.(googleapis|gstatic)\.com)\//.test(r.url())) external.push(r.url()); });
    // 即使本機留著雲端資訊，也視為未啟用
    await seedCloud(page, { player_id: 'p-x', token: 'x'.repeat(43), transfer_code: 'ABCD-EFGH' });
    await seedSaves(page, { 1: makeSave() });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto('./?test=1');
    expect(await u.state()).toMatchObject({ apiBase: '', configured: false, enabled: false });
    await u.titlePick('用轉移碼接續');
    await u.waitCloud('closed');
    expect((await u.menu()).note).toBe('雲端存檔尚未開放');
    await shot(page, testInfo, 'rev2-cloud-not-open');
    await u.pick('back');
    await g.waitScene('Title', 10_000);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('closed');
    await u.pick('back');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await u.saveTo(2, false);
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && window.__SL.menu()?.note === '已存檔到存檔 2'); // 不詢問上傳
    expect(external).toEqual([]);
  });

  test('G：401 後在遊戲內選單用轉移碼接續（碼含零寬字元也可以）；未啟用時總覽也能用轉移碼接續', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const target = mock.seedPlayer({ saves: { 1: { version: 2, data: JSON.stringify(makeSave({ player: { name: '接續目標' } })) } } });
    await seedCloud(page, { player_id: 'p-old', token: 'r'.repeat(43), transfer_code: 'ABCD-EFGH' });
    await seedSaves(page, { 1: makeSave() });
    const g = game(page, { touch });
    const u = cloudUi(page, g);
    await page.goto(CLOUD_URL);
    await u.loadFromTitle(1);
    await u.openCloudMenu();
    await u.waitCloud('relink');
    expect((await u.menu()).items.map((x) => x.id)).toEqual(['relink-transfer', 'relink-ok']);
    await u.pick('relink-transfer');
    await u.waitCloud('transfer-input');
    const zw = `${target.transfer_code.slice(0, 2)}​${target.transfer_code.slice(2)}﻿`;
    await u.typeCode(page, zw, touch);
    await u.pick('transfer-go');
    await u.waitCloud('transfer-slots');
    expect(mock.calls(/^\/api\/transfer$/, 'POST')[0].body.code).toBe(target.transfer_code);
    await u.pick('done');
    await u.waitCloud('cloud'); // 遊戲中進來的：完成後回雲端總覽
    expect((await u.menu()).cloud.slots[0].cloud).toMatchObject({ empty: false, summary: { name: '接續目標' } });
    // 停用 → 總覽（未啟用）也有「用轉移碼接續」；返回回到總覽
    await u.pick('settings');
    await u.waitCloud('settings');
    await u.pick('disable');
    await u.waitCloud('confirm-disable');
    await u.pick('confirm-disable');
    await u.waitCloud('intro');
    await u.pick('transfer');
    await u.waitCloud('transfer-input');
    await u.pick('transfer-back');
    await u.waitCloud('intro');
  });
});
