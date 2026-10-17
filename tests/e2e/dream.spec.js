// M4 鐘塔之夢（客戶端）：入夢與醒來、夢境地圖、夢境中存檔／讀檔、夢客自由交談（模擬 API）、Turnstile、未啟用雲端。
// 資料：tests/fixtures/dream（?data= 測試掛勾＋page.route）。Turnstile：tests/e2e/fake-turnstile.js（不連外網）。
// 手機（mobile 專案）全程用 tap 操作：調查／選單按鈕、對話選項、輸入框、送出、離開、再試一次。
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { expect, game, makeSave, seedSaves } from './helpers.js';
import { dreamUi, makeSaveV3 } from './dream-ui.js';
import { createMockCloud, MOCK_API } from './cloud-mock.js';
import { installFakeTurnstile, FAKE_TS_TOKEN } from './fake-turnstile.js';
import { useDreamFixture, useDataDir, DREAM_FIXTURE_PREFIX, DATA_DIR_PREFIX } from './dream-fixture.js';

/** 錯誤蒐集：忽略瀏覽器對模擬 API 非 2xx／中斷自動印的「Failed to load resource」（同 cloud.spec.js）。 */
const test = base.extend({
  page: async ({ page }, use) => {
    await installFakeTurnstile(page);
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

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const URL_LOCAL = `./?test=1&data=${DREAM_FIXTURE_PREFIX}`;
const URL_CLOUD = `${URL_LOCAL}&api=${encodeURIComponent(MOCK_API)}`;
const ATTIC_SPOT = { map: 'attic', x: 3, y: 2, dir: 'up' }; // 面向測試用的入夢物件（3,1）
const TOWER_SPOT = { map: 'fx_tower', x: 5, y: 3, dir: 'right' }; // 面向測試夢客（6,3）
const QUOTA_NOTE = '今天的交談次數已經用完了，明天再來吧。';
const isPost = (re) => ({ method, path }) => method === 'POST' && re.test(path);

async function shot(page, testInfo, name) {
  await page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`) });
  if (process.env.SL_SHOT_DIR) await page.screenshot({ path: join(process.env.SL_SHOT_DIR, `${name}-${testInfo.project.name}.png`) });
}

async function seedCloud(page, info) {
  await page.addInitScript((v) => {
    if (sessionStorage.getItem('__sl_cloud_seeded')) return;
    sessionStorage.setItem('__sl_cloud_seeded', '1');
    localStorage.setItem('steel-labyrinth:cloud', v);
  }, JSON.stringify(info));
}

test.describe('M4 鐘塔之夢（客戶端）', () => {
  test('入夢 → 夢境地圖 → 夢境中存檔 → 讀檔仍在夢境（dream_return 正確）→ 未啟用雲端時 not_open → 醒來回到原位', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await useDreamFixture(page);
    await seedSaves(page, { 1: makeSave({ location: ATTIC_SPOT }) });
    await page.goto(URL_LOCAL);
    const g = game(page, { touch, data: DREAM_FIXTURE_PREFIX });
    const u = dreamUi(page, g, touch);
    await u.loadFromTitle(1);
    expect((await page.evaluate(() => window.__SL.hud())).dream).toBeNull();

    // 調查：look 之後多一個「入夢」選項
    const t = await u.investigate([0]);
    expect(t).toEqual(['(旁白)：一個軟軟的枕頭。', '? 一陣倦意湧上來。遠處好像有鐘聲。 -> 入夢']);
    await u.waitMap('fx_tower');
    // 夢境 on_enter
    await g.waitDialogue();
    expect((await g.dlg()).text).toBe('鐘聲停了。你站在霧裡。');
    await g.finishDialogue();
    let s = await g.st();
    expect(s.location).toEqual({ map: 'fx_tower', x: 4, y: 3, dir: 'up' });
    expect(s.dream_return).toEqual(ATTIC_SPOT);
    const hud = await page.evaluate(() => window.__SL.hud());
    expect(hud.dream).toBe('夢境中');
    expect(hud.map).toBe('測試用・夢中鐘塔');
    const mv = await page.evaluate(() => window.__SL.map());
    expect(mv.dream).toMatchObject({ clock: true, tinted: true });
    expect(mv.dream.fog).toBeGreaterThan(0);
    await g.sleep(200);
    if (touch) await shot(page, testInfo, 'dream-map');

    // 夢境中存檔（選單照常可用）
    await g.act('menu');
    await g.waitScene('Menu');
    await g.pickMenu('存檔');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'save');
    await g.pickMenu('存檔 2');
    await page.waitForFunction(() => /已存檔到存檔 2/.test(window.__SL.menu()?.note ?? ''));
    const raw = JSON.parse(await page.evaluate(() => localStorage.getItem('steel-labyrinth:save:2')));
    expect(raw.location.map).toBe('fx_tower');
    expect(raw.dream_return).toEqual(ATTIC_SPOT);

    // 回標題再讀檔：仍在夢境、dream_return 不變
    await g.pickMenu('返回');
    await g.pickMenu('回標題');
    await g.pickMenu('回標題');
    await u.loadFromTitle(2);
    s = await g.st();
    expect(s.location.map).toBe('fx_tower');
    expect(s.dream_return).toEqual(ATTIC_SPOT);
    expect((await page.evaluate(() => window.__SL.hud())).dream).toBe('夢境中');
    expect((await page.evaluate(() => window.__SL.map())).dream).not.toBeNull();

    // 未啟用雲端：選「自由交談」改播 not_open 預寫台詞＋說明，不開聊天畫面
    await g.faceObject('obj_fx_guest');
    const t2 = await u.investigate([0]);
    expect(t2).toEqual([
      '? 要聊聊嗎？ -> 自由交談',
      '測試夢客：（啟用雲端存檔後，可以和夢客自由交談。）',
      '(旁白)：（在「選單 → 雲端存檔」啟用雲端存檔後，就可以和夢客自由交談。）',
    ]);
    expect(await g.scene()).toBe('Map');

    // 醒來：回到原位（不是 spawn），清除 dream_return，播 wake 帶的對話
    await g.faceObject('obj_fx_door');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitMap('attic');
    await g.waitDialogue();
    expect((await g.dlg()).text).toBe('你醒了過來。');
    await g.finishDialogue();
    s = await g.st();
    expect(s.location).toEqual(ATTIC_SPOT);
    expect(s.dream_return).toBeNull();
    expect((await page.evaluate(() => window.__SL.hud())).dream).toBeNull();
    expect((await page.evaluate(() => window.__SL.map())).dream).toBeNull();
    // 現實的入夢物件可以再次入夢
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([1]); // 留在現實
    expect((await g.st()).location).toEqual(ATTIC_SPOT);
  });

  test('自由交談（模擬 API）：Turnstile → 通行證 → ai／scripted 回覆、錯誤時預寫台詞、通行證失效重新驗證 → 額度用完 → 離開、醒來', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    const player = mock.seedPlayer();
    await seedCloud(page, player);
    await useDreamFixture(page);
    await seedSaves(page, { 1: makeSaveV3({ location: TOWER_SPOT, dream_return: ATTIC_SPOT, flags: { 'enter:attic': true, 'enter:fx_tower': true } }) });
    await page.goto(URL_CLOUD);
    const g = game(page, { touch, data: DREAM_FIXTURE_PREFIX });
    const u = dreamUi(page, g, touch);
    await u.loadFromTitle(1);
    mock.dream.quota = 3;

    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitChat();
    expect(await g.scene()).toBe('DreamChat');
    let c = await u.chat();
    expect(c.name).toBe('測試夢客');
    expect(c.messages[0]).toEqual({ role: 'guest', text: '你來了。這裡是測試用的夢。', source: 'greeting' });
    await u.waitReady();
    // 人機驗證：action dream_pass、本機用官方測試 sitekey；通行證只在記憶體
    const tsLog = await page.evaluate(() => window.__FAKE_TS_LOG);
    expect(tsLog).toEqual([{ sitekey: '1x00000000000000000000AA', action: 'dream_pass' }]);
    expect(mock.calls(/^\/api\/dream\/pass$/, 'POST').map((x) => x.body)).toEqual([{ turnstile_token: FAKE_TS_TOKEN }]);
    c = await u.chat();
    expect(c.remaining).toBe('今日剩餘 3 句'); // 通行證回應的 remaining_today 立即顯示（不再是「—」）
    expect(c.count).toBe('剩 120 字');

    // ai 回覆
    let last = await u.say('你是誰？');
    expect(last).toEqual({ role: 'guest', text: '「你是誰？」……我聽見了。', source: 'ai' });
    c = await u.chat();
    expect(c.remaining).toBe('今日剩餘 2 句');
    let req = mock.calls(/^\/api\/dream\/chat$/, 'POST').at(-1).body;
    expect(req).toMatchObject({ guest: 'lamp', chapter: 'prologue', input: '你是誰？', history: [] });
    expect(req.pass).toMatch(/^pass-/);

    // scripted（伺服器端的預寫台詞）：不同樣式
    mock.queueReply({ reply: '……我好像說錯話了，當我沒說。', source: 'scripted', reason: 'filtered' });
    last = await u.say('說說鐘塔');
    expect(last).toEqual({ role: 'guest', text: '……我好像說錯話了，當我沒說。', source: 'scripted' });
    c = await u.chat();
    expect(c.shown.at(-1).cls).toContain('sl-msg-scripted');
    expect(c.shown.at(-3).cls).not.toContain('sl-msg-scripted');
    // history：只送玩家的話與 AI 回覆（預寫台詞、開場白不送）
    req = mock.calls(/^\/api\/dream\/chat$/, 'POST').at(-1).body;
    expect(req.history).toEqual([{ role: 'player', text: '你是誰？' }, { role: 'guest', text: '「你是誰？」……我聽見了。' }]);

    // 錯誤 → 該夢客的 fallback 預寫台詞，不中斷
    for (const action of [{ status: 500, body: { error: 'internal' } }, { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '30' } }, 'abort']) {
      mock.fail(isPost(/^\/api\/dream\/chat$/), action);
      last = await u.say('還在嗎？');
      expect(last).toEqual({ role: 'guest', text: '霧太濃了，我聽不清楚。', source: 'scripted' });
      expect((await u.chat()).inputEnabled).toBe(true);
    }

    // 通行證失效（401 pass_invalid）→ 重新驗證後自動重送同一句
    mock.revokePasses();
    last = await u.say('通行證過期了嗎？');
    expect(last).toEqual({ role: 'guest', text: '「通行證過期了嗎？」……我聽見了。', source: 'ai' });
    expect(mock.calls(/^\/api\/dream\/pass$/, 'POST').length).toBe(2);
    expect((await u.chat()).messages.filter((m) => m.text === '通行證過期了嗎？').length).toBe(1);

    // 字數上限：最多 120 字
    if (!touch) {
      await page.locator('.sl-chat-input').fill('霧'.repeat(130));
      await page.locator('.sl-chat-input').dispatchEvent('input');
      expect(await page.locator('.sl-chat-input').inputValue()).toBe('霧'.repeat(120));
      expect((await u.chat()).count).toBe('剩 0 字');
      await page.locator('.sl-chat-input').fill('');
      await page.locator('.sl-chat-input').dispatchEvent('input');
    }

    // 第 3 句 AI 回覆後額度歸零 → 不能再送
    last = await u.say('最後一句');
    expect(last.source).toBe('ai');
    c = await u.chat();
    expect(c.remaining).toBe('今日剩餘 0 句');
    expect(c.locked).toBe(true);
    expect(c.inputEnabled).toBe(false);
    expect(c.status).toBe(QUOTA_NOTE);
    expect(c.buttons.send.enabled).toBe(false);
    if (touch) await shot(page, testInfo, 'dream-chat');
    // 紀錄只用 textContent：送出含 HTML 的字串時照字面顯示
    // （已鎖住，改看先前的訊息都是純文字節點）
    const html = await page.evaluate(() => [...document.querySelectorAll('.sl-chat-log *')].some((el) => ['IMG', 'SCRIPT', 'A', 'B'].includes(el.tagName)));
    expect(html).toBe(false);
    // 通行證不寫進 localStorage
    const ls = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(ls).not.toContain('pass-');

    // 離開 → 回到地圖；醒來回到原位
    await u.tapButton('leave');
    await g.waitScene('Map');
    expect(await page.evaluate(() => window.__SL.chat())).toBeNull();
    await g.faceObject('obj_fx_door');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitMap('attic');
    await g.waitDialogue();
    await g.finishDialogue();
    expect((await g.st()).location).toEqual(ATTIC_SPOT);
    expect((await g.st()).dream_return).toBeNull();

    // 再入夢、再開聊天：紀錄還在（記憶體）、通行證還有效（不再驗證）
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitMap('fx_tower');
    await g.faceObject('obj_fx_guest');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitChat();
    c = await u.chat();
    expect(c.verify.visible).toBe(false);
    expect(c.messages.length).toBeGreaterThan(5);
    expect(mock.calls(/^\/api\/dream\/pass$/, 'POST').length).toBe(2);
  });

  test('含 HTML 的訊息照字面顯示（textContent，不解析）', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    await seedCloud(page, mock.seedPlayer());
    await useDreamFixture(page);
    await seedSaves(page, { 1: makeSaveV3({ location: TOWER_SPOT, dream_return: ATTIC_SPOT, flags: { 'enter:fx_tower': true } }) });
    await page.goto(URL_CLOUD);
    const g = game(page, { touch, data: DREAM_FIXTURE_PREFIX });
    const u = dreamUi(page, g, touch);
    await u.loadFromTitle(1);
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitChat();
    await u.waitReady();
    mock.queueReply({ reply: '<img src=x onerror="window.__pwned=1"><b>粗體</b>' });
    const last = await u.say('<script>window.__pwned=2</script>');
    expect(last.text).toBe('<img src=x onerror="window.__pwned=1"><b>粗體</b>');
    const c = await u.chat();
    expect(c.shown.at(-2).text).toBe('<script>window.__pwned=2</script>');
    expect(c.shown.at(-1).text).toBe('<img src=x onerror="window.__pwned=1"><b>粗體</b>');
    expect(await page.evaluate(() => window.__pwned ?? null)).toBeNull();
    expect(await page.evaluate(() => document.querySelectorAll('.sl-chat-log img, .sl-chat-log b, .sl-chat-log script').length)).toBe(0);
  });

  test('Turnstile 失敗：聊天畫面顯示提示與「再試一次」，不能送出；伺服器 403 也一樣；再試成功後可以交談', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    await seedCloud(page, mock.seedPlayer());
    await useDreamFixture(page);
    await page.addInitScript(() => { window.__FAKE_TS_MODE = 'fail'; });
    await seedSaves(page, { 1: makeSaveV3({ location: TOWER_SPOT, dream_return: ATTIC_SPOT, flags: { 'enter:fx_tower': true } }) });
    await page.goto(URL_CLOUD);
    const g = game(page, { touch, data: DREAM_FIXTURE_PREFIX });
    const u = dreamUi(page, g, touch);
    await u.loadFromTitle(1);
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitChat();
    await page.waitForFunction(() => window.__SL.chat()?.verify.error !== null, null, { timeout: 8_000 });
    let c = await u.chat();
    expect(c.verify).toMatchObject({ visible: true, error: '人機驗證失敗，請再試一次', retry: true });
    expect(c.inputEnabled).toBe(false);
    expect(mock.calls(/^\/api\/dream\/pass$/).length).toBe(0);
    if (touch) await shot(page, testInfo, 'dream-turnstile-failed');

    // 小工具通過、但伺服器驗證失敗（403 turnstile_failed）
    await page.evaluate(() => { window.__FAKE_TS_MODE = 'hang'; });
    await u.tapButton('retry');
    await page.waitForFunction(() => window.__SL.chat()?.verify.error === null && window.__SL.chat()?.verify.visible, null, { timeout: 5_000 });
    if (touch) await shot(page, testInfo, 'dream-turnstile');
    await page.evaluate(() => { window.__FAKE_TS_MODE = 'pass'; });
    mock.fail(isPost(/^\/api\/dream\/pass$/), { status: 403, body: { error: 'turnstile_failed', message: '人機驗證失敗，請再試一次' } });
    await u.tapButton('leave');
    await g.waitScene('Map');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitChat();
    await page.waitForFunction(() => window.__SL.chat()?.verify.error !== null, null, { timeout: 8_000 });
    expect((await u.chat()).verify.error).toBe('人機驗證失敗，請再試一次');

    // 再試一次 → 成功
    await u.tapButton('retry');
    await u.waitReady();
    c = await u.chat();
    expect(c.verify.visible).toBe(false);
    const last = await u.say('你好');
    expect(last.source).toBe('ai');
  });

  test('啟用雲端存檔前要先過 Turnstile（action create_player）；失敗時顯示提示，再試一次成功', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    await page.addInitScript(() => { window.__FAKE_TS_MODE = 'fail'; });
    await seedSaves(page, { 1: makeSave() });
    await page.goto(`./?test=1&api=${encodeURIComponent(MOCK_API)}`);
    const g = game(page, { touch });
    const u = dreamUi(page, g, touch);
    await u.loadFromTitle(1);
    await g.act('menu');
    await g.waitScene('Menu');
    await g.pickMenu('雲端存檔');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'intro');
    const pick = async (id) => {
      await page.waitForFunction((x) => (window.__SL.menu()?.items ?? []).some((it) => it.id === x && it.enabled), id, { timeout: 8_000 });
      const it = (await page.evaluate(() => window.__SL.menu())).items.find((x) => x.id === id);
      await g.pointAt(it.x, it.y);
    };
    await pick('enable');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'verify' && window.__SL.menu()?.cloud?.error, null, { timeout: 8_000 });
    expect((await page.evaluate(() => window.__SL.menu())).cloud.error).toBe('人機驗證失敗，請再試一次');
    expect(mock.calls(/^\/api\/player$/).length).toBe(0);
    if (touch) await shot(page, testInfo, 'cloud-turnstile-failed');
    await page.evaluate(() => { window.__FAKE_TS_MODE = 'pass'; });
    await pick('verify-retry');
    await page.waitForFunction(() => window.__SL.menu()?.cloud?.page === 'cloud', null, { timeout: 10_000 });
    expect(await page.evaluate(() => window.__FAKE_TS_LOG.map((x) => x.action))).toEqual(['create_player', 'create_player']);
    expect(mock.calls(/^\/api\/player$/, 'POST').map((x) => x.body.turnstile_token)).toEqual([FAKE_TS_TOKEN]);
  });

  // 真的 Turnstile（官方測試 sitekey，需要連外網）：SL_REAL_TURNSTILE=1 時才跑。
  test('真的 Turnstile 腳本＋官方測試 sitekey：取得 token 換通行證', async ({ page }, testInfo) => {
    test.skip(process.env.SL_REAL_TURNSTILE !== '1', '需要連外網：SL_REAL_TURNSTILE=1 才跑');
    await page.unroute('https://challenges.cloudflare.com/turnstile/**');
    const touch = isTouch(testInfo);
    const mock = createMockCloud();
    await mock.attach(page);
    await seedCloud(page, mock.seedPlayer());
    await useDreamFixture(page);
    await seedSaves(page, { 1: makeSaveV3({ location: TOWER_SPOT, dream_return: ATTIC_SPOT, flags: { 'enter:fx_tower': true } }) });
    // 真的 Turnstile 回的是 Cloudflare 的 dummy token：讓模擬 API 接受任何 token
    mock.fail(isPost(/^\/api\/dream\/pass$/), { status: 200, body: { pass: 'pass-real', expires_at: Math.floor(Date.now() / 1000) + 1800 } });
    await page.goto(URL_CLOUD);
    const g = game(page, { touch, data: DREAM_FIXTURE_PREFIX });
    const u = dreamUi(page, g, touch);
    await u.loadFromTitle(1);
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitChat();
    await page.waitForFunction(() => window.__SL.chat()?.inputEnabled === true || window.__SL.chat()?.verify.error, null, { timeout: 30_000 });
    if (touch) await shot(page, testInfo, 'dream-turnstile-real');
    expect((await u.chat()).verify.error).toBeNull();
    const body = mock.calls(/^\/api\/dream\/pass$/, 'POST')[0].body;
    expect(typeof body.turnstile_token).toBe('string');
    expect(body.turnstile_token.length).toBeGreaterThan(10);
  });

  // 真的第三章資料：第三章已開放時用 web/data；也可以用 SL_CH3_DATA=<資料夾> 指定另一份建置輸出。
  test('第三章資料：辦公室沙發入夢 → 鐘塔 → 夢客（未啟用雲端）→ 醒來 → 再次從沙發入夢（資料提供的入夢文字）→ 醒來', async ({ page }, testInfo) => {
    const webData = fileURLToPath(new URL('../../web/data', import.meta.url));
    const released = JSON.parse(readFileSync(join(webData, 'manifest.json'), 'utf8')).chapters.includes('chapter3');
    const dir = process.env.SL_CH3_DATA ?? (released ? webData : null);
    test.skip(!dir, '需要第三章資料：SL_CH3_DATA=<建置輸出資料夾>');
    const sofa = JSON.parse(readFileSync(join(dir, 'maps', 'office_ch3.json'), 'utf8')).objects.find((o) => o.id === 'obj_ch3_sofa');
    const touch = isTouch(testInfo);
    await useDataDir(page, dir);
    const spot = { map: 'office_ch3', x: 9, y: 2, dir: 'down' };
    await seedSaves(page, { 1: makeSave({ location: spot, chapter: 'chapter3', chapter_done: ['prologue', 'chapter1', 'chapter2'], flags: { 'enter:office_ch3': true } }) });
    await page.goto(`./?test=1&data=${DATA_DIR_PREFIX}`);
    const g = game(page, { touch, data: DATA_DIR_PREFIX });
    const u = dreamUi(page, g, touch);
    await u.loadFromTitle(1);
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]); // 躺下睡覺 → enter_dream
    await u.waitMap('clocktower');
    await g.waitDialogue();
    await g.finishDialogue(Array(20).fill(0));
    expect((await g.st()).dream_return).toEqual(spot);
    expect((await page.evaluate(() => window.__SL.hud())).dream).toBe('夢境中');
    expect((await page.evaluate(() => window.__SL.art())).missingTextures).toEqual([]);
    if (touch) await shot(page, testInfo, 'ch3-clocktower');
    await g.faceObject('obj_guest_three');
    const t = await u.investigate([0]);
    expect(t.some((x) => x.startsWith('三點：') && /雲端存檔/.test(x))).toBe(true);
    await g.faceObject('obj_tower_door');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitMap('office_ch3');
    expect((await g.st()).location).toEqual(spot);
    expect((await g.st()).dream_return).toBeNull();

    // 再次調查沙發：look（again）之後，引擎問「入夢」，文字取自沙發的 dream.prompt／yes
    await g.faceObject('obj_ch3_sofa');
    const again = await u.investigate([0]);
    expect(again.at(-1)).toBe(`? ${sofa.dream.prompt} -> ${sofa.dream.yes}`);
    await u.waitMap('clocktower');
    expect((await g.st()).dream_return).toEqual(spot);
    await g.faceObject('obj_tower_door');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]); // 醒來
    await u.waitMap('office_ch3');
    expect((await g.st()).location).toEqual(spot);
  });
});
