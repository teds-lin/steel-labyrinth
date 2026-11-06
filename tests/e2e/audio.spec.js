// M6 P1 聲音：設定畫面（標題／遊戲選單兩個入口）、M 鍵靜音、設定保存、UI 音效要求、測試模式不抓音檔。
// ?test=1 一律用 NullBackend：不建立 AudioContext、不出聲，只記錄「要求播放了什麼」（__SL.audio()）。
import { test, expect, game, TEST_URL, seedSaves, makeSave } from './helpers.js';
import { createMockCloud, MOCK_API } from './cloud-mock.js';
import { dreamUi, makeSaveV3 } from './dream-ui.js';
import { useDreamFixture, DREAM_FIXTURE_PREFIX } from './dream-fixture.js';
import { useM5Fixture, makeSaveV4, M5_URL, M5_DATA } from './m5-fixture.js';

/** 兩個矩形（左上角＋寬高）是否相交。 */
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** toastRect 是中心座標 → 左上角。 */
const toastBox = (r) => ({ x: r.x - r.w / 2, y: r.y - r.h / 2, w: r.w, h: r.h });

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const sl = (page, fn) => page.evaluate(fn);
const audio = (page) => sl(page, () => window.__SL.audio());
const DEFAULTS = { v: 1, mute: false, bgm: 2, amb: 2, sfx: 3, typing: true };
const AUDIO_FILE = /\.(ogg|m4a|mp3|wav|flac|aac|opus)(\?|$)/i;

/** 記錄所有音檔請求（測試模式必須是 0）。 */
function watchAudioRequests(page) {
  const urls = [];
  page.on('request', (r) => { if (AUDIO_FILE.test(r.url())) urls.push(r.url()); });
  return urls;
}

/** 按鈕不重疊、不超出畫面與面板；scale（畫布 CSS 寬／360）有給時，按鈕高度至少 44 CSS px（觸控目標）。 */
function expectLayout(items, maxBottom, scale = null) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  sorted.forEach((it, i) => {
    if (scale !== null) expect(it.h * scale, `「${it.label}」高度`).toBeGreaterThanOrEqual(44);
    expect(it.x - it.w / 2, `「${it.label}」左緣`).toBeGreaterThanOrEqual(0);
    expect(it.x + it.w / 2, `「${it.label}」右緣`).toBeLessThanOrEqual(360);
    expect(it.y + it.h / 2, `「${it.label}」下緣`).toBeLessThanOrEqual(maxBottom);
    if (i > 0) expect(sorted[i - 1].y + sorted[i - 1].h / 2, `「${it.label}」與上一個重疊`).toBeLessThanOrEqual(it.y - it.h / 2);
  });
}

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

const canvasScale = async (page) => (await page.locator('canvas').boundingBox()).width / 360;

const settingsPage = (page) => page.waitForFunction(() => window.__SL.menu()?.page === 'settings', null, { timeout: 5_000 });

/** 設定頁：把焦點移到某列（桌機方向鍵）。 */
async function focusRow(page, g, id) {
  for (let i = 0; i < 8; i++) {
    const m = await sl(page, () => window.__SL.menu());
    if (m.items.find((x) => x.focused)?.id === id) return;
    await g.key('ArrowDown');
  }
  throw new Error(`設定頁移不到「${id}」`);
}

/** 設定頁：點某列的 ◀ 或 ▶（觸控／滑鼠）。 */
async function tapArrow(page, g, row, dir) {
  const a = (await sl(page, () => window.__SL.menu())).arrows.find((x) => x.row === row && x.dir === dir);
  if (!a) throw new Error(`找不到 ${row} 的 ${dir}`);
  await g.pointAt(a.x, a.y);
}

test.describe('M6 聲音', () => {
  test('測試模式：NullBackend、不抓任何音檔、預設設定（50%／50%／75%、打字音開）', async ({ page }) => {
    const reqs = watchAudioRequests(page);
    const g = game(page);
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    const a0 = await audio(page);
    expect(a0).toMatchObject({ backend: 'null', unlocked: false, settings: DEFAULTS, lastSfx: [] });
    await page.waitForFunction(() => window.__SL.audio().catalog === true, null, { timeout: 5_000 });
    // 第一次手勢之後才解鎖；解鎖後也不抓音檔
    await g.key('ArrowDown');
    await page.waitForFunction(() => window.__SL.audio().unlocked === true, null, { timeout: 3_000 });
    expect((await audio(page)).lastSfx).toEqual(['ui_move']);
    await g.sleep(500);
    expect(reqs).toEqual([]);
  });

  test('標題：5 顆按鈕不重疊；設定頁可開啟、調整、重新整理後保留', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const reqs = watchAudioRequests(page);
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    const title = await sl(page, () => window.__SL.title());
    expect(title.items.map((x) => x.label)).toEqual(['新遊戲', '繼續', '用轉移碼接續', '設定', '意見回饋']);
    expectLayout(title.items, 578, await canvasScale(page));
    expect(title.hintWidth, '操作說明不超出畫面').toBeLessThanOrEqual(352);

    await titlePick(page, g, touch, '設定');
    await g.waitScene('Menu');
    await settingsPage(page);
    let m = await sl(page, () => window.__SL.menu());
    expect(m.title).toBe('設定');
    expect(m.items.map((x) => x.id)).toEqual(['bgm', 'amb', 'sfx', 'mute', 'typing', 'back']);
    expect(m.items[0].label).toBe('音樂　■■□□　50%');
    expect(m.items[2].label).toBe('音效　■■■□　75%');
    expect(m.items[3].label).toBe('全部靜音：關');
    expect(m.items[4].label).toBe('對話打字音：開');
    // 觸控裝置只說「點 ◀ ▶ 或點整列調整」；桌機才提左右鍵與 M 鍵
    if (touch) expect(m.note).toBe('點 ◀ ▶ 或點整列調整');
    else expect(m.note).toContain('M 鍵');
    expectLayout(m.items, 570, await canvasScale(page));
    expect(m.arrows.map((a) => `${a.row}${a.dir}`)).toEqual(['bgm-', 'bgm+', 'amb-', 'amb+', 'sfx-', 'sfx+']);
    for (const a of m.arrows) {
      const row = m.items.find((x) => x.id === a.row);
      expect(a.x - a.w / 2, '箭頭在列的右邊').toBeGreaterThanOrEqual(row.x + row.w / 2);
      expect(a.x + a.w / 2).toBeLessThanOrEqual(344);
    }

    if (touch) {
      await tapArrow(page, g, 'bgm', '+'); // 音樂 3
      await tapArrow(page, g, 'amb', '-'); // 環境音 1
      await tapArrow(page, g, 'amb', '-'); // 環境音 0
      await g.pickMenu('全部靜音');
      await page.waitForFunction(() => window.__SL.audio().settings.mute === true);
      await g.pickMenu('對話打字音');
    } else {
      await g.key('ArrowRight'); // 音樂 3
      await focusRow(page, g, 'amb');
      await g.key('ArrowLeft');
      await g.key('ArrowLeft'); // 環境音 0
      await focusRow(page, g, 'mute');
      await g.key('Enter');
      await page.waitForFunction(() => window.__SL.audio().settings.mute === true);
      await focusRow(page, g, 'typing');
      await g.key('ArrowLeft');
    }
    const want = { v: 1, mute: true, bgm: 3, amb: 0, sfx: 3, typing: false };
    await page.waitForFunction((w) => JSON.stringify(window.__SL.audio().settings) === JSON.stringify(w), want, { timeout: 3_000 });
    m = await sl(page, () => window.__SL.menu());
    // 全部靜音中：三條音量列變暗並標「（靜音中）」
    expect(m.items.map((x) => x.label).slice(0, 5)).toEqual(['音樂　■■■□　75%（靜音中）', '環境音　□□□□　關（靜音中）', '音效　■■■□　75%（靜音中）', '全部靜音：開', '對話打字音：關']);
    expect(m.items.slice(0, 5).map((x) => x.dimmed)).toEqual([true, true, true, false, false]);
    expect((await audio(page)).saved).toBe(true);

    // 返回標題（觸控點「返回」，桌機 Esc）
    if (touch) await g.pickMenu('返回'); else await g.key('Escape');
    await g.waitScene('Title');

    // 重新整理後設定仍在
    await page.reload();
    await g.waitScene('Title', 15_000);
    expect((await audio(page)).settings).toEqual(want);
    expect(reqs).toEqual([]);
  });

  test('遊戲選單：9 項（含設定）高度 44、觸控目標至少 44 CSS px、不超出面板；設定頁返回選單主頁，遊戲狀態不變', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
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
    expect(labels).toEqual(['存檔', '讀取', '雲端存檔', '道具', '隊伍', '設定', '意見回饋', '回標題', '返回遊戲']);
    for (const it of main.items) expect(it.h).toBe(44);
    expectLayout(main.items, 570, await canvasScale(page));

    await g.pickMenu('設定');
    await settingsPage(page);
    const m = await sl(page, () => window.__SL.menu());
    expect(m.items.at(-1).label).toBe('返回');
    if (touch) await g.pickMenu('返回'); else await g.key('Escape');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await g.pickMenu('返回遊戲');
    await g.waitScene('Map');
    expect(strip(await g.st())).toEqual(before);
  });

  test('M 鍵：標題與地圖都能切換靜音並顯示短提示；地圖上 M 不再開選單；輸入框裡打 M 不觸發', async ({ page }, testInfo) => {
    test.skip(isTouch(testInfo), '手機沒有實體鍵盤：靜音在設定頁切換');
    const g = game(page);
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await g.key('KeyM');
    let a = await audio(page);
    expect(a.settings.mute).toBe(true);
    expect(a.hint).toBe('已靜音');
    // 標題：提示在副標與按鈕之間，不蓋住按鈕
    const t0 = (await sl(page, () => window.__SL.title())).items[0];
    expect(a.toastRect.y + a.toastRect.h / 2).toBeLessThanOrEqual(t0.y - t0.h / 2);
    expect(a.toast).toBe('已靜音');
    await g.key('KeyM');
    a = await audio(page);
    expect(a.settings.mute).toBe(false);
    expect(a.toast).toBe('已開啟聲音');

    // 名字輸入框裡打 M 是輸入文字，不切換靜音
    await g.key('Enter');
    await g.waitScene('Name');
    await page.fill('.sl-name-input', '');
    await page.type('.sl-name-input', 'Mm');
    expect((await audio(page)).settings.mute).toBe(false);
    await page.fill('.sl-name-input', '艾琳');
    await page.press('.sl-name-input', 'Enter');
    await g.waitScene('Map');
    await g.waitDialogue();
    await g.finishDialogue();

    // 地圖上：M 切換靜音，不開選單；第一次提醒選單改用 Esc
    await g.key('KeyM');
    a = await audio(page);
    expect(a.settings.mute).toBe(true);
    expect(a.toast).toBe('已靜音（選單請按 Esc）');
    // 提示不蓋住頂部 HUD（0～62），也在地圖視窗內（操作區從 470 開始）
    expect(a.toastRect.y - a.toastRect.h / 2, '提示上緣在 HUD 下方').toBeGreaterThanOrEqual(62);
    expect(a.toastRect.y + a.toastRect.h / 2, '提示下緣在操作區上方').toBeLessThanOrEqual(470);
    await g.sleep(200);
    expect(await g.scene()).toBe('Map');
    // Esc 仍然開選單
    await g.key('Escape');
    await g.waitScene('Menu');
    // 選單裡也可以按 M；提示在面板（70～570）下方
    await g.key('KeyM');
    a = await audio(page);
    expect(a.settings.mute).toBe(false);
    expect(a.toast).toBe('已開啟聲音');
    expect(a.toastRect.y - a.toastRect.h / 2).toBeGreaterThanOrEqual(570);
    expect(await g.scene()).toBe('Menu');
    // 回到地圖再按：只顯示「已靜音」
    await g.key('Escape');
    await g.waitScene('Map');
    await g.key('KeyM');
    expect((await audio(page)).toast).toBe('已靜音');
  });

  test('UI 音效：選單移動、確認、取消會要求播放；靜音時不播', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    const last = async () => (await audio(page)).lastSfx;

    if (touch) {
      await titlePick(page, g, touch, '設定'); // 點擊＝解鎖＋確認
      await g.waitScene('Menu');
      await settingsPage(page);
      expect(await last()).toEqual(['ui_confirm']);
      await tapArrow(page, g, 'sfx', '-');
      expect((await last()).at(-1)).toBe('ui_move');
      await g.pickMenu('返回');
      await g.waitScene('Title');
      expect((await last()).at(-1)).toBe('ui_cancel');
      // 靜音後點擊不播
      await titlePick(page, g, touch, '設定');
      await settingsPage(page);
      await g.pickMenu('全部靜音');
      await page.waitForFunction(() => window.__SL.audio().settings.mute === true);
      const n = (await last()).length;
      await g.pickMenu('返回');
      await g.waitScene('Title');
      expect(await last()).toHaveLength(n);
      return;
    }

    // NullBackend 的語意：第一次手勢在 capture 階段就解鎖，所以同一下的移動音會被記錄（只記錄、不出聲）。
    // 真實後端第一下時音效還沒下載，這一聲不會真的響（見 audio-real.spec.js）。
    await g.key('ArrowDown');
    expect(await last(), 'NullBackend：第一次手勢同一下的移動音已記錄').toEqual(['ui_move']);
    await g.key('ArrowUp');
    expect(await last()).toEqual(['ui_move', 'ui_move']);
    await titlePick(page, g, false, '設定');
    await g.waitScene('Menu');
    await settingsPage(page);
    expect((await last()).at(-1)).toBe('ui_confirm');
    await g.key('ArrowRight'); // 調整音量：試聽一聲
    expect((await last()).at(-1)).toBe('ui_move');
    await g.key('Escape');
    await g.waitScene('Title');
    expect((await last()).at(-1)).toBe('ui_cancel');

    await g.key('KeyM'); // 靜音
    const n = (await last()).length;
    await g.key('ArrowDown');
    await g.key('ArrowUp');
    expect(await last()).toHaveLength(n);
  });

  test('瀏覽器封鎖儲存空間：設定頁有提示、仍可調整（只存在記憶體）、選單不超出面板、沒有 console error', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    expect((await audio(page)).settings).toEqual(DEFAULTS);
    await titlePick(page, g, touch, '設定');
    await settingsPage(page);
    const m = await sl(page, () => window.__SL.menu());
    expect(m.note).toContain('瀏覽器封鎖了儲存空間');
    expectLayout(m.items, 570);
    await g.pickMenu('全部靜音');
    await page.waitForFunction(() => window.__SL.audio().settings.mute === true);
    expect((await audio(page)).saved).toBe(false);
    if (touch) await g.pickMenu('返回'); else await g.key('Escape');
    await g.waitScene('Title');

    // 遊戲選單（9 項＋封鎖提示）也不能超出面板
    await titlePick(page, g, touch, '新遊戲');
    await g.waitScene('Name');
    await page.press('.sl-name-input', 'Enter');
    await g.waitScene('Map');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.act('menu');
    await g.waitScene('Menu');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    const main = await sl(page, () => window.__SL.menu());
    expect(main.items).toHaveLength(9);
    expectLayout(main.items, 570, await canvasScale(page));
    // 封鎖提示改放在停用的「存檔」副標（9 項＋兩行說明放不進面板）
    expect(main.note).toBe('');
    expect(main.items[0]).toMatchObject({ label: '存檔', enabled: false });
    expect(main.items[0].sub).toContain('瀏覽器封鎖了儲存空間');
  });
});

/** 第二章 Boss 前的存檔（同 battle.spec.js 的 bossSave）：倉庫裡、面向沉默的搬運工。 */
function bossSave() {
  return {
    ...makeSave(),
    schema_version: 2,
    lineage: { id: 'trace', rank: 9 },
    location: { map: 'warehouse', x: 7, y: 3, dir: 'up' },
    flags: {
      'enter:office': true, 'enter:training': true, 'enter:dock': true, 'enter:warehouse': true, drank_potion: true, sparred: true,
      fog1_done: true, fog2_done: true, fog3_done: true, boss_warned: true, ch2_deduced: true, wh_door_open: true,
    },
    items: { revolver: 1, bandage: 2, sedative_incense: 1, warehouse_key: 1 },
    echo: { charges: 0 },
    collapse: 10,
    resonance: { clue_found: 3, deduction_correct: 1 },
    chapter: 'chapter2',
    chapter_done: ['prologue', 'chapter1'],
    party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }],
    ammo: 12,
    pending: null,
  };
}

const lastSfx = async (page) => (await audio(page)).lastSfx;
const focusedId = async (page) => (await sl(page, () => window.__SL.menu())).items.find((x) => x.focused)?.id ?? null;
const focusedLabel = async (page) => (await sl(page, () => window.__SL.menu())).items.find((x) => x.focused)?.label ?? null;

test.describe('M6 聲音（審查修正 Round 1）', () => {
  test('設定頁：三欄對齊；點 ◀ ▶ 焦點移到該列；到頂或到底再按播 ui_error；開關列先切換再播確認音', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await titlePick(page, g, touch, '設定');
    await settingsPage(page);
    let m = await sl(page, () => window.__SL.menu());
    // B-11：名稱、方塊、數值三欄的 x 在三列都相同
    expect(m.settingsCols.map((c) => c.row)).toEqual(['bgm', 'amb', 'sfx']);
    for (const k of ['nameX', 'barX', 'valueX']) expect(new Set(m.settingsCols.map((c) => c[k])).size, k).toBe(1);
    expect(m.settingsCols[0].nameX).toBeLessThan(m.settingsCols[0].barX);
    expect(m.settingsCols[0].barX).toBeLessThan(m.settingsCols[0].valueX);

    // B-5：點「音效」的 ◀，焦點移到「音效」
    await tapArrow(page, g, 'sfx', '-');
    expect(await focusedId(page)).toBe('sfx');
    expect((await audio(page)).settings.sfx).toBe(2);
    expect((await lastSfx(page)).at(-1)).toBe('ui_move');

    // B-4：音樂調到滿格後再按 ▶ → 不變、播 ui_error；調到 0 再按 ◀ → 不變、播 ui_error
    await tapArrow(page, g, 'bgm', '+');
    await tapArrow(page, g, 'bgm', '+');
    expect((await audio(page)).settings.bgm).toBe(4);
    await tapArrow(page, g, 'bgm', '+');
    expect((await audio(page)).settings.bgm).toBe(4);
    expect((await lastSfx(page)).at(-1)).toBe('ui_error');
    for (let i = 0; i < 4; i++) await tapArrow(page, g, 'bgm', '-');
    expect((await audio(page)).settings.bgm).toBe(0);
    const n0 = (await lastSfx(page)).length;
    await tapArrow(page, g, 'bgm', '-');
    expect((await audio(page)).settings.bgm).toBe(0);
    expect(await lastSfx(page)).toHaveLength(n0 + 1);
    expect((await lastSfx(page)).at(-1)).toBe('ui_error');
    if (!touch) {
      await g.key('ArrowLeft'); // 鍵盤也一樣（焦點在音樂列）
      expect((await lastSfx(page)).at(-1)).toBe('ui_error');
    }

    // B-3：開啟全部靜音 → 先切換再播確認音，所以這一下不響；取消靜音 → 響確認音
    if (!touch) await focusRow(page, g, 'mute'); // 先移好焦點（移動音不算在這一下）
    const n1 = (await lastSfx(page)).length;
    await g.pickMenu('全部靜音');
    await page.waitForFunction(() => window.__SL.audio().settings.mute === true);
    await g.sleep(100);
    expect(await lastSfx(page)).toHaveLength(n1);
    m = await sl(page, () => window.__SL.menu());
    expect(m.items.slice(0, 3).every((x) => x.dimmed && x.label.endsWith('（靜音中）'))).toBe(true);
    await g.pickMenu('全部靜音');
    await page.waitForFunction(() => window.__SL.audio().settings.mute === false);
    await g.sleep(100);
    expect((await lastSfx(page)).at(-1)).toBe('ui_confirm');
    m = await sl(page, () => window.__SL.menu());
    expect(m.items.slice(0, 3).some((x) => x.dimmed)).toBe(false);
  });

  test('B-1：點停用的按鈕播 ui_error（標題沒有存檔時的「繼續」）', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    const it = (await sl(page, () => window.__SL.title())).items.find((x) => x.label === '繼續');
    expect(it.enabled).toBe(false);
    await g.pointAt(it.x, it.y);
    expect((await lastSfx(page)).at(-1)).toBe('ui_error');
    expect(await g.scene()).toBe('Title');
  });

  test('B-6：從設定頁與意見回饋回到遊戲選單時，焦點回到原本的項目', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
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
    await g.act('menu');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    await g.pickMenu('設定');
    await settingsPage(page);
    await g.pickMenu('返回');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    expect(await focusedLabel(page)).toBe('設定');
    await g.pickMenu('意見回饋');
    await page.waitForFunction(() => window.__SL.feedback()?.open === true);
    await g.pickMenu('取消');
    await page.waitForFunction(() => window.__SL.menu()?.page === 'main');
    expect(await focusedLabel(page)).toBe('意見回饋');
  });

  test('B-2／B-7：戰鬥直接點敵人立繪選目標播 ui_confirm；M 鍵提示不蓋住行動順序列', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: bossSave() });
    const g = game(page, { touch });
    await page.goto(`${TEST_URL}&seed=3`);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await titlePick(page, g, touch, '繼續');
    await g.waitScene('Menu');
    await g.pickMenu('存檔 1');
    await g.waitScene('Map');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    let b = await g.battleWait();
    const attack = b.commands.skills.find((x) => x.id === 'attack');
    await g.battleButton(attack.name);
    b = await g.battleWait();
    expect(b.mode).toBe('target');
    const enemy = b.units.find((u) => u.side === 'enemy' && u.alive && u.rect);
    const n = (await lastSfx(page)).length;
    await g.pointAt(enemy.rect.x + enemy.rect.w / 2, enemy.rect.y + enemy.rect.h / 2);
    await page.waitForFunction(() => window.__SL.battle()?.mode !== 'target', null, { timeout: 5_000 });
    const l = await lastSfx(page);
    expect(l.length).toBeGreaterThan(n);
    expect(l[n]).toBe('ui_confirm');

    if (!touch) {
      await g.key('KeyM');
      const a = await audio(page);
      expect(a.toast).toBe('已靜音');
      expect(a.toastRect.y - a.toastRect.h / 2, '提示在行動順序列（0～44）下方').toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: testInfo.outputPath('mute-toast-battle.png') });
    }
  });

  test('B-7／B-10：夢客交談的 M 鍵提示不蓋住上方剩餘句數與輸入框；輸入框裡按 Esc 離開時播 ui_cancel', async ({ page }, testInfo) => {
    test.skip(isTouch(testInfo), '手機沒有實體鍵盤（M、Esc）');
    const TOWER_SPOT = { map: 'fx_tower', x: 5, y: 3, dir: 'right' };
    const ATTIC_SPOT = { map: 'attic', x: 3, y: 2, dir: 'up' };
    const mock = createMockCloud();
    await mock.attach(page);
    const player = mock.seedPlayer();
    await page.addInitScript((v) => {
      if (sessionStorage.getItem('__sl_cloud_seeded')) return;
      sessionStorage.setItem('__sl_cloud_seeded', '1');
      localStorage.setItem('steel-labyrinth:cloud', v);
    }, JSON.stringify(player));
    await useDreamFixture(page);
    await seedSaves(page, { 1: makeSaveV3({ location: TOWER_SPOT, dream_return: ATTIC_SPOT, flags: { 'enter:attic': true, 'enter:fx_tower': true } }) });
    await page.goto(`${TEST_URL}&data=${DREAM_FIXTURE_PREFIX}&api=${encodeURIComponent(MOCK_API)}`);
    const g = game(page, { data: DREAM_FIXTURE_PREFIX });
    const u = dreamUi(page, g, false);
    await u.loadFromTitle(1);
    mock.dream.quota = 3;
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    await u.waitChat();
    await u.waitReady();
    // 焦點離開輸入框（在輸入框裡打 M 是輸入文字）
    await page.evaluate(() => document.activeElement?.blur());
    await g.key('KeyM');
    const a = await audio(page);
    expect(a.toast).toBe('已靜音');
    const top = a.toastRect.y - a.toastRect.h / 2;
    expect(top, '提示在輸入框（533～579）下方：不蓋住上方的剩餘句數，也不被中間的 DOM 紀錄蓋住').toBeGreaterThanOrEqual(579);
    expect(a.toastRect.y + a.toastRect.h / 2).toBeLessThanOrEqual(640);
    await page.screenshot({ path: testInfo.outputPath('mute-toast-dream.png') });
    await g.key('KeyM'); // 取消靜音，後面才聽得到取消音
    await page.locator('.sl-chat-input').focus();
    const n = (await lastSfx(page)).length;
    await page.keyboard.press('Escape');
    await g.waitScene('Map');
    expect((await lastSfx(page)).slice(n)).toEqual(['ui_cancel']);
  });

  test('B-10：轉移碼輸入框與回報文字框裡按 Esc 離開時播 ui_cancel', async ({ page }, testInfo) => {
    test.skip(isTouch(testInfo), '手機沒有實體鍵盤（Esc）');
    await page.addInitScript(() => {
      const deny = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
      try { navigator.clipboard.writeText = deny; } catch { /* 沒有 clipboard 時本來就會失敗 */ }
    });
    const mock = createMockCloud(); // 雲端要有 API 位址才開放轉移碼輸入
    await mock.attach(page);
    const g = game(page);
    await page.goto(`${TEST_URL}&api=${encodeURIComponent(MOCK_API)}`);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);
    await titlePick(page, g, false, '用轉移碼接續');
    await g.waitScene('Menu');
    const box = page.locator('.sl-code-input');
    await box.waitFor();
    await box.focus();
    let n = (await lastSfx(page)).length;
    await page.keyboard.press('Escape');
    await g.waitScene('Title');
    expect((await lastSfx(page)).slice(n)).toEqual(['ui_cancel']);

    await g.sleep(300);
    await titlePick(page, g, false, '意見回饋');
    await page.waitForFunction(() => window.__SL.feedback()?.open === true);
    await g.pickMenu('複製回報資訊');
    await page.waitForFunction(() => window.__SL.feedback()?.copy === 'fallback', null, { timeout: 5_000 });
    const ta = page.locator('textarea.sl-report-text');
    await ta.focus();
    n = (await lastSfx(page)).length;
    await page.keyboard.press('Escape');
    await g.waitScene('Title');
    expect((await lastSfx(page)).slice(n)).toEqual(['ui_cancel']);
  });
});

test.describe('M6 聲音（審查修正 Round 2）：M 鍵提示不蓋住按鈕', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(isTouch(testInfo), '手機沒有實體鍵盤（M）');
  });

  test('夢境「醒來／再待一會兒」選項出現時按 M：提示與選項不相交，也不蓋住 HUD', async ({ page }) => {
    const ATTIC_SPOT = { map: 'attic', x: 3, y: 2, dir: 'up' };
    await useDreamFixture(page);
    await seedSaves(page, { 1: makeSave({ location: ATTIC_SPOT }) });
    await page.goto(`${TEST_URL}&data=${DREAM_FIXTURE_PREFIX}`);
    const g = game(page, { data: DREAM_FIXTURE_PREFIX });
    const u = dreamUi(page, g, false);
    await u.loadFromTitle(1);
    await u.investigate([0]); // 入夢
    await u.waitMap('fx_tower');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.faceObject('obj_fx_door');
    await g.act('investigate');
    await g.waitDialogue();
    const d = await g.advanceToChoice();
    expect(d.choices.length).toBeGreaterThanOrEqual(2);
    await g.key('KeyM');
    const a = await audio(page);
    expect(a.toast).toBe('已靜音（選單請按 Esc）');
    const t = toastBox(a.toastRect);
    expect(t.y, '提示在 HUD（0～62）下方').toBeGreaterThanOrEqual(62);
    const rects = await sl(page, () => window.__SL.choiceRects());
    expect(rects.length).toBe(d.choices.length);
    for (const r of rects) expect(overlap(t, r), `提示與選項 ${JSON.stringify(r)} 相交`).toBe(false);
    await g.finishDialogue([0]);
  });

  test('結局畫面（按鈕排到 530／590）按 M：提示與按鈕、標題文字都不相交', async ({ page }) => {
    await useM5Fixture(page);
    await seedSaves(page, { 1: makeSaveV4({
      chapter: 'fx_finale', chapter_done: ['fx_ch4', 'fx_finale'], ending: 'fx_fog', collapse: 75,
      location: { map: 'fx_room', x: 5, y: 5, dir: 'right' },
    }) });
    await page.goto(M5_URL);
    const g = game(page, { data: M5_DATA });
    const u = dreamUi(page, g, false);
    await u.titlePick('繼續');
    await g.waitScene('Menu');
    await g.pickMenu('存檔 1');
    await g.waitScene('ChapterEnd');
    await page.waitForFunction(() => (window.__SL.debug().chapterEnd?.items ?? []).length > 0, null, { timeout: 15_000 });
    const ce = (await sl(page, () => window.__SL.debug())).chapterEnd;
    expect(ce.items.map((x) => x.label)).toEqual(['存檔', '回標題']);
    // 測試資料的致謝較短，按鈕在 500／560；正式資料會排到 530／590（toastY 的單元測試涵蓋）
    expect(ce.items.at(-1).y + ce.items.at(-1).h, '這個畫面的按鈕排在下半部').toBeGreaterThan(560);
    await g.key('KeyM');
    const a = await audio(page);
    expect(a.toast).toBe('已靜音');
    const t = toastBox(a.toastRect);
    for (const r of ce.items) expect(overlap(t, r), `提示與「${r.label}」相交`).toBe(false);
    expect(t.y + t.h, '提示在最上方的「結局」字樣（約 y=84）之上').toBeLessThanOrEqual(84);
  });
});

test.describe('M6 本機伺服器', () => {
  test('音檔用正確的 MIME 類型提供（ogg → audio/ogg、m4a → audio/mp4）', async ({ request }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', '伺服器行為與裝置無關，桌機跑一次即可');
    const ogg = await request.get('audio/sfx/ui_move.ogg');
    expect(ogg.status()).toBe(200);
    expect(ogg.headers()['content-type']).toBe('audio/ogg');
    const m4a = await request.get('audio/sfx/ui_move.m4a');
    expect(m4a.status()).toBe(200);
    expect(m4a.headers()['content-type']).toBe('audio/mp4');
    const cat = await request.get('audio/catalog.json');
    expect(cat.headers()['content-type']).toContain('application/json');
  });
});
