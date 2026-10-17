// M3 雲端存檔整合 E2E：接「真的」本機 Worker（wrangler dev --local，D1 為獨立 persist 目錄）。
// 執行：npm run e2e:cloud（playwright.cloud.config.js 會啟動靜態伺服器 8091 與 Worker 8788）。
// 桌機用滑鼠／鍵盤，手機（375×667）用 tap；每個情境各跑一次。
import { test as base, expect } from '@playwright/test';
import { game, makeSave, seedSaves } from './helpers.js';

const API = 'http://localhost:8788';
const DEAD_API = 'http://localhost:8799'; // 沒人聽的埠
const CLOUD_KEY = 'steel-labyrinth:cloud';
const UNAVAILABLE = '雲端暫時無法使用，稍後再試';
const RELINK = '此裝置的雲端連結已失效，請重新用轉移碼接續';
const urlFor = (api) => `./?test=1&api=${encodeURIComponent(api)}`;
const isTouch = (ti) => ti.project.name === 'mobile';

/** 瀏覽器對 API 回非 2xx／連線失敗自動印的「Failed to load resource」不算遊戲錯誤；其他 error 一律要為空。 */
const isNoise = (m) => /GL Driver Message/.test(m.text())
  || (/^Failed to load resource/.test(m.text()) && /^http:\/\/localhost:(8788|8799)\//.test(m.location()?.url ?? ''));

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !isNoise(m)) errors.push(`[console.error] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await use(page);
    expect(errors, '測試過程中不應有 console error 或 pageerror').toEqual([]);
  },
});

/** 另一台裝置（獨立 browser context），沿用目前專案的視窗與觸控設定。 */
async function otherDevice(browser, testInfo) {
  const u = testInfo.project.use;
  const ctx = await browser.newContext({
    viewport: u.viewport, hasTouch: u.hasTouch, isMobile: u.isMobile, deviceScaleFactor: u.deviceScaleFactor, baseURL: u.baseURL,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !isNoise(m)) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

function ui(page, touch) {
  const g = game(page, { touch });
  const menu = () => page.evaluate(() => window.__SL.menu());
  const state = () => page.evaluate(() => window.__SL.cloud());
  const waitCloud = (p, timeout = 10_000) => page.waitForFunction((x) => window.__SL.menu()?.cloud?.page === x, p, { timeout });
  async function pick(id) {
    await page.waitForFunction((x) => (window.__SL.menu()?.items ?? []).some((it) => it.id === x && it.enabled), id, { timeout: 8_000 });
    const it = (await menu()).items.find((x) => x.id === id);
    await g.pointAt(it.x, it.y);
  }
  async function titlePick(label) {
    await g.waitScene('Title', 15_000);
    await page.waitForFunction((l) => (window.__SL.title()?.items ?? []).some((it) => it.label === l && it.enabled), label, { timeout: 8_000 });
    await g.sleep(250);
    const it = (await page.evaluate(() => window.__SL.title())).items.find((x) => x.label === label);
    await g.pointAt(it.x, it.y);
  }
  /** 標題 → 新遊戲（點選）→ 輸入名字 → 地圖，播完開場對話。 */
  async function newGame(name) {
    await titlePick('新遊戲');
    await g.waitScene('Name');
    await page.fill('.sl-name-input', name);
    await page.press('.sl-name-input', 'Enter');
    await g.waitScene('Map');
    await g.waitDialogue();
    await g.finishDialogue();
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
  async function saveTo(slot, occupied) {
    if ((await menu())?.page === 'main') await g.pickMenu('存檔');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save');
    await g.pickMenu(`存檔 ${slot}`);
    if (occupied) {
      await page.waitForFunction(() => window.__SL.menu()?.page === 'confirm');
      await g.pickMenu('覆蓋');
    }
  }
  async function typeCode(p, text) {
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
  const localSlot = (slot) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), `steel-labyrinth:save:${slot}`);
  const cloudInfo = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), CLOUD_KEY);
  return { g, menu, state, waitCloud, pick, titlePick, newGame, loadFromTitle, openCloudMenu, saveTo, typeCode, localSlot, cloudInfo };
}

/** 直接對 Worker 發請求（模擬「別台裝置」或查看伺服器狀態，不經過遊戲畫面）。 */
const apiCall = (request, method, path, { token, headers = {}, data } = {}) =>
  request.fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(data !== undefined ? { data } : {}),
  });

test.describe('M3 雲端存檔（整合，真的本機 Worker）', () => {
  test('新遊戲 → 存檔 → 啟用雲端 → 上傳 → 轉移碼；裝置 B 接續後位置一致、可移動；裝置 A 再上傳收到 401', async ({ page, browser, request }, testInfo) => {
    const touch = isTouch(testInfo);
    const A = ui(page, touch);
    await page.goto(urlFor(API));
    await A.newGame('整合艾琳');
    const before = await A.g.st();
    await A.g.stepDir('right');
    const posA = (await A.g.st()).location;
    expect(posA).not.toEqual(before.location);

    // 存檔 1，再啟用雲端 → 上傳
    await A.g.act('menu');
    await A.g.waitScene('Menu');
    await A.saveTo(1, false);
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && /已存檔/.test(window.__SL.menu()?.note ?? ''));
    await A.g.key('Escape');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await A.g.pickMenu('雲端存檔');
    await A.waitCloud('intro');
    await A.pick('enable');
    await A.waitCloud('cloud');
    let m = await A.menu();
    expect(m.cloud.status).toBe('已啟用雲端存檔');
    expect(m.cloud.slots[0].local).toMatchObject({ empty: false, name: '整合艾琳' });
    expect(m.cloud.slots[0].cloud).toEqual({ slot: 1, empty: true });
    await A.pick('up1');
    await A.waitCloud('cloud');
    m = await A.menu();
    expect(m.cloud.status).toBe('已上傳存檔 1');
    expect(m.cloud.slots[0].cloud).toMatchObject({ empty: false, version: 1, summary: { name: '整合艾琳', map: posA.map } });
    const tokenA = (await A.cloudInfo()).token;
    expect(tokenA).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 伺服器端獨立確認
    const listed = await (await apiCall(request, 'GET', '/api/saves', { token: tokenA })).json();
    expect(listed.slots[0]).toMatchObject({ slot: 1, version: 1, summary: { name: '整合艾琳' } });

    // 查看轉移碼
    await A.pick('code');
    await A.waitCloud('code');
    const code = (await A.menu()).cloud.code;
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(JSON.stringify(await A.state())).not.toContain(tokenA);

    // 裝置 B：標題「用轉移碼接續」
    const b = await otherDevice(browser, testInfo);
    const B = ui(b.page, touch);
    await b.page.goto(urlFor(API));
    await B.g.waitScene('Title', 15_000);
    await B.titlePick('用轉移碼接續');
    await B.waitCloud('transfer-input');
    await B.typeCode(b.page, 'zzzz-zzzz'); // 真實伺服器的 404
    await B.pick('transfer-go');
    await b.page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'transfer-input' && /不正確/.test(window.__SL.menu()?.cloud?.error ?? ''));
    await B.typeCode(b.page, code.toLowerCase().replace('-', ' '));
    await B.pick('transfer-go');
    await B.waitCloud('transfer-slots');
    expect((await B.menu()).cloud.slots[0]).toMatchObject({ slot: 1, empty: false, summary: { name: '整合艾琳' } });
    await B.pick('cloud1');
    await B.waitCloud('transfer-target');
    await B.pick('to1');
    await B.waitCloud('transfer-done');
    const savedB = await B.localSlot(1);
    expect(savedB.player.name).toBe('整合艾琳');
    expect(savedB.location).toMatchObject({ map: posA.map, x: posA.x, y: posA.y });
    const infoB = await B.cloudInfo();
    expect(infoB.token).not.toBe(tokenA);
    await B.pick('play');
    await B.g.waitScene('Map');
    const sB = await B.g.st();
    expect(sB.player.name).toBe('整合艾琳');
    expect(sB.location).toMatchObject({ map: posA.map, x: posA.x, y: posA.y });
    await B.g.stepDir('right');
    expect((await B.g.st()).location.x).toBe(posA.x + 1);
    expect(b.errors).toEqual([]);
    await b.ctx.close();

    // 裝置 A：舊權杖已被作廢；再上傳 → 401 失效提示、清除本機雲端資訊
    expect((await apiCall(request, 'GET', '/api/saves', { token: tokenA })).status()).toBe(401);
    await A.pick('back'); // 離開轉移碼頁會重新讀取雲端列表 → 401
    await A.waitCloud('relink');
    expect((await A.menu()).note).toBe(RELINK);
    expect(await A.cloudInfo()).toBeNull();
    expect((await A.state()).enabled).toBe(false);
  });

  test('真實 409 衝突：取消、用本機的（覆蓋雲端）、用雲端的；轉移回來後再上傳', async ({ page, browser, request }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: makeSave({ player: { name: '本機版' }, playtime_s: 50 }) });
    const A = ui(page, touch);
    await page.goto(urlFor(API));
    await A.loadFromTitle(1);
    await A.openCloudMenu();
    await A.waitCloud('intro');
    await A.pick('enable');
    await A.waitCloud('cloud');
    await A.pick('up1');
    await A.waitCloud('cloud');
    expect((await A.menu()).cloud.status).toBe('已上傳存檔 1');
    const tokenA = (await A.cloudInfo()).token;

    // 「別台裝置」（同一個玩家的權杖）寫入新版本 2：A 手上的版本落後
    const other = JSON.stringify(makeSave({ player: { name: '別台' }, playtime_s: 900, location: { map: 'attic', x: 5, y: 3, dir: 'down' } }));
    const w = await apiCall(request, 'PUT', '/api/save/1', { token: tokenA, headers: { 'If-Match': '"1"' }, data: { data: other } });
    expect(w.status()).toBe(200);
    expect((await w.json()).version).toBe(2);

    // 真實 409 → 三個選項 → 取消
    await A.pick('up1');
    await A.waitCloud('conflict');
    const c = (await A.menu()).cloud.conflict;
    expect(c).toMatchObject({ slot: 1, cloudVersion: 2, cloud: { empty: false, name: '別台', playtime_s: 900 }, local: { name: '本機版', playtime_s: 50 } });
    expect((await A.menu()).items.map((x) => x.label)).toEqual(['用雲端的', '用本機的（覆蓋雲端）', '取消']);
    await A.pick('cancel');
    await A.waitCloud('cloud');
    expect((await A.menu()).cloud.status).toBe('已取消，雲端與本機都沒有變更');
    expect((await A.localSlot(1)).player.name).toBe('本機版');
    expect((await (await apiCall(request, 'GET', '/api/save/1', { token: tokenA })).json()).version).toBe(2);

    // 用本機的（以衝突回報的版本 2 當 If-Match）→ 雲端變成版本 3
    await A.pick('up1');
    await A.waitCloud('conflict');
    await A.pick('use-local');
    await A.waitCloud('cloud');
    expect((await A.menu()).cloud.status).toBe('已用本機的存檔 1 覆蓋雲端');
    const cur = await (await apiCall(request, 'GET', '/api/save/1', { token: tokenA })).json();
    expect(cur.version).toBe(3);
    expect(JSON.parse(cur.data).player.name).toBe('本機版');
    expect((await A.state()).slots[1].version).toBe(3);

    // 再被別台寫入 → 衝突 → 用雲端的（下載覆蓋本機）
    const third = JSON.stringify(makeSave({ player: { name: '第三台' }, playtime_s: 1200 }));
    expect((await apiCall(request, 'PUT', '/api/save/1', { token: tokenA, headers: { 'If-Match': '3' }, data: { data: third } })).status()).toBe(200);
    await A.pick('up1');
    await A.waitCloud('conflict');
    expect((await A.menu()).cloud.conflict.cloud.name).toBe('第三台');
    await A.pick('use-cloud');
    await A.waitCloud('cloud');
    expect((await A.menu()).cloud.status).toBe('已下載到存檔 1');
    expect((await A.localSlot(1)).player.name).toBe('第三台');
    expect((await A.state()).slots[1].version).toBe(4);

    // 兩台裝置輪流：A 看轉移碼 → B 轉移（A 作廢）→ B 看新碼 → A 轉移回來（B 作廢），A 能再上傳
    await A.pick('code');
    await A.waitCloud('code');
    const codeA = (await A.menu()).cloud.code;
    const b = await otherDevice(browser, testInfo);
    const B = ui(b.page, touch);
    await b.page.goto(urlFor(API));
    await B.titlePick('用轉移碼接續');
    await B.waitCloud('transfer-input');
    await B.typeCode(b.page, codeA);
    await B.pick('transfer-go');
    await B.waitCloud('transfer-slots');
    await B.pick('cloud1');
    await B.waitCloud('transfer-target');
    await B.pick('to1');
    await B.waitCloud('transfer-done');
    await B.pick('play');
    await B.g.waitScene('Map');
    await B.g.act('menu');
    await B.g.waitScene('Menu');
    await B.g.pickMenu('雲端存檔');
    await B.waitCloud('cloud');
    await B.pick('code');
    await B.waitCloud('code');
    const codeB = (await B.menu()).cloud.code;
    expect(codeB).not.toBe(codeA);
    expect((await apiCall(request, 'GET', '/api/saves', { token: tokenA })).status()).toBe(401); // A 已作廢
    expect(b.errors).toEqual([]);

    // A（本機槽 1 是「第三台」）轉移回來
    await A.pick('back');
    await A.waitCloud('relink');
    await A.pick('relink-ok');
    await A.waitCloud('intro');
    await A.g.key('Escape');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await A.g.key('Escape');
    await A.g.waitScene('Map');
    await b.ctx.close();
    // 回標題用轉移碼（網頁重新載入即回標題；本機存檔仍在）
    await page.goto(urlFor(API));
    await A.titlePick('用轉移碼接續');
    await A.waitCloud('transfer-input');
    await A.typeCode(page, codeB);
    await A.pick('transfer-go');
    await A.waitCloud('transfer-slots');
    await A.pick('cloud1');
    await A.waitCloud('transfer-target');
    await A.pick('to1'); // 覆蓋本機槽 1：先確認
    await page.waitForFunction(() => /transfer-confirm|confirm/.test(window.__SL.menu()?.cloud?.page ?? ''), null, { timeout: 5_000 }).catch(() => {});
    const pg = (await A.menu()).cloud.page;
    if (pg !== 'transfer-done') {
      const confirmItem = (await A.menu()).items.find((x) => /confirm|overwrite/.test(x.id));
      await A.pick(confirmItem.id);
    }
    await A.waitCloud('transfer-done');
    expect((await A.state()).enabled).toBe(true);
    expect((await apiCall(request, 'GET', '/api/saves', { token: (await A.cloudInfo()).token })).status()).toBe(200);
  });

  test('修訂 2 A：真的 Worker 的轉移回應延遲 5.1 秒 → 用新權杖確認後接續成功；舊權杖 401、新權杖 200', async ({ page, browser, request }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: makeSave({ player: { name: '延遲轉移' } }) });
    const A = ui(page, touch);
    await page.goto(urlFor(API));
    await A.loadFromTitle(1);
    await A.openCloudMenu();
    await A.waitCloud('intro');
    await A.pick('enable');
    await A.waitCloud('cloud');
    await A.pick('up1');
    await A.waitCloud('cloud');
    const tokenA = (await A.cloudInfo()).token;
    await A.pick('code');
    await A.waitCloud('code');
    const code = (await A.menu()).cloud.code;

    const b = await otherDevice(browser, testInfo);
    // 轉移請求照常送到 Worker（伺服器做完），但回應晚 5.1 秒才交給頁面
    await b.page.route(`${API}/api/transfer`, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const res = await route.fetch();
      await new Promise((r) => setTimeout(r, 5100));
      try { await route.fulfill({ response: res }); } catch { /* 頁面已經放棄這個請求 */ }
    });
    const B = ui(b.page, touch);
    await b.page.goto(urlFor(API));
    await B.titlePick('用轉移碼接續');
    await B.waitCloud('transfer-input');
    await B.typeCode(b.page, code);
    await B.pick('transfer-go');
    await B.waitCloud('transfer-slots', 20_000);
    expect((await B.menu()).cloud.slots[0]).toMatchObject({ slot: 1, empty: false, summary: { name: '延遲轉移' } });
    const infoB = await B.cloudInfo();
    expect(infoB.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await b.page.evaluate(() => localStorage.getItem('steel-labyrinth:cloud-pending'))).toBeNull();
    expect((await apiCall(request, 'GET', '/api/saves', { token: tokenA })).status()).toBe(401);
    expect((await apiCall(request, 'GET', '/api/saves', { token: infoB.token })).status()).toBe(200);
    expect(b.errors).toEqual([]);
    await b.ctx.close();
  });

  test('章節完成通關回報：GET /api/stats 看得到該章人數', async ({ page, request }, testInfo) => {
    const touch = isTouch(testInfo);
    const nearEnd = makeSave({
      location: { map: 'street', x: 6, y: 2, dir: 'down' }, playtime_s: 77, collapse: 3,
      flags: { 'enter:attic': true, 'enter:hallway': true, 'enter:street': true, door_open: true, talked_landlady: true },
    });
    await seedSaves(page, { 1: nearEnd });
    const A = ui(page, touch);
    await page.goto(urlFor(API));
    await A.loadFromTitle(1);
    await A.openCloudMenu();
    await A.waitCloud('intro');
    await A.pick('enable');
    await A.waitCloud('cloud');
    await A.pick('back');
    await A.g.waitScene('Menu');
    await A.g.key('Escape');
    await A.g.waitScene('Map');
    await A.g.stepDir('down');
    await A.g.waitDialogue();
    await A.g.finishDialogue([0]);
    await A.g.waitScene('ChapterEnd');
    await page.waitForFunction(() => ['ok', 'failed'].includes(window.__SL.debug().chapterEnd?.clearReport?.status));
    expect((await page.evaluate(() => window.__SL.debug())).chapterEnd.clearReport.status).toBe('ok');
    const res = await apiCall(request, 'GET', '/api/stats');
    expect(res.status()).toBe(200);
    const stats = await res.json();
    const row = stats.chapters.find((x) => x.chapter === 'prologue');
    expect(row, JSON.stringify(stats)).toBeTruthy();
    expect(row.players).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(stats)).not.toContain((await A.cloudInfo()).player_id);
  });

  test('Worker 沒人聽（?api= 指到空埠）：本機存讀檔照常，雲端操作只顯示「雲端暫時無法使用」', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: makeSave({ player: { name: '離線艾琳' } }) });
    await page.addInitScript(([k, v]) => {
      if (sessionStorage.getItem('__sl_cloud_seeded')) return;
      sessionStorage.setItem('__sl_cloud_seeded', '1');
      localStorage.setItem(k, v);
    }, [CLOUD_KEY, JSON.stringify({ player_id: 'p-offline', token: 'x'.repeat(43), transfer_code: 'ABCD-EFGH' })]);
    const A = ui(page, touch);
    await page.goto(urlFor(DEAD_API));
    expect(await A.state()).toMatchObject({ apiBase: DEAD_API });
    await A.loadFromTitle(1);
    // 存到槽 2，詢問上傳 → 失敗只顯示暫時無法使用；本機照存
    await A.g.act('menu');
    await A.g.waitScene('Menu');
    await A.saveTo(2, false);
    await A.waitCloud('ask-upload');
    await A.pick('ask-upload');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save' && /雲端/.test(window.__SL.menu()?.note ?? ''));
    expect((await A.menu()).note).toBe(`已存檔到存檔 2。\n${UNAVAILABLE}`);
    expect((await A.localSlot(2)).player.name).toBe('離線艾琳');
    // 讀檔照常
    await A.g.key('Escape');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await A.g.pickMenu('讀取');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'load');
    await A.g.pickMenu('存檔 2');
    await A.g.waitScene('Map');
    expect((await A.g.st()).player.name).toBe('離線艾琳');
    // 雲端選單：列表取不到，不崩潰、不清除本機雲端資訊
    await A.openCloudMenu();
    await A.waitCloud('cloud');
    expect((await A.menu()).cloud.slots[0].cloud).toBeNull();
    expect((await A.cloudInfo())).not.toBeNull();
  });

  test('未啟用雲端、Worker 沒人聽：啟用失敗只顯示「雲端暫時無法使用」', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: makeSave() });
    const A = ui(page, touch);
    await page.goto(urlFor(DEAD_API));
    await A.loadFromTitle(1);
    await A.openCloudMenu();
    await A.waitCloud('intro');
    await A.pick('enable');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'intro' && !!window.__SL.menu()?.cloud?.status, null, { timeout: 12_000 });
    expect((await A.menu()).cloud.status).toBe(UNAVAILABLE);
    expect((await A.state()).enabled).toBe(false);
  });
});
