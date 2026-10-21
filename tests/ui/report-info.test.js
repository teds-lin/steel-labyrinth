// 意見回饋的「複製回報資訊」：純函式 buildReportInfo（遊戲中／不在遊戲中）、裝置字串、雲端秘密一律不外流、
// 最近一次讀取或存檔的槽位、複製到剪貼簿（失敗回 false）。
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDir, WEB_DATA_DIR } from './load-fixture.js';
import { deserialize, sanitizeLoadedState, serialize, KEY_PREFIX } from '../../web/src/core/save.js';
import { CLOUD_KEY, PENDING_KEY, CLEAR_QUEUE_KEY } from '../../web/src/cloud/sync.js';
import {
  buildReportInfo, describeDevice, collectCloudSecrets, rememberLastSlot, readLastSave, copyText,
  REPORT_SAVE_MARKER, LAST_SLOT_KEY,
} from '../../web/src/ui/report-info.js';

// 假的雲端秘密（格式比照真的：43 字元 base64url 權杖、XXXX-XXXX 轉移碼）
const TOKEN = 'tok_FAKE_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const PENDING_TOKEN = 'tok_FAKE_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
const CODE = 'QWER-TYUP';
const PENDING_CODE = 'ZXCV-BNMK';
const NEW_CODE = 'HJKL-MNBV';
const PLAYER_ID = 'pid-FAKE-0123456789abcdef';

let data;
let state;
beforeAll(() => {
  data = loadDir(WEB_DATA_DIR);
  const raw = {
    schema_version: 4,
    player: { name: '艾琳' },
    lineage: { id: 'trace', rank: 9 },
    location: { map: 'dock', x: 0, y: 6, dir: 'right' },
    flags: {}, items: {}, echo: { charges: 2 }, collapse: 17, resonance: { a: 3, b: 4 },
    chapter: 'chapter2', chapter_done: ['prologue', 'chapter1'], playtime_s: 3725,
    party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }],
    ammo: 0, pending: null, dream_return: null, promotions: [], ending: null,
  };
  const r = sanitizeLoadedState(deserialize(JSON.stringify(raw)), data);
  expect(r.ok).toBe(true);
  state = r.state;
});

const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Mobile Safari/537.36';
const env = (over = {}) => ({
  version: '2026.10.21', now: new Date('2026-10-21T08:09:10.000Z'), userAgent: UA_ANDROID,
  screen: { width: 375, height: 667 }, cloudEnabled: false, ...over,
});

/** 假的 localStorage。 */
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}

/** 放好假權杖與轉移碼的儲存空間（雲端資訊、待確認區、通關待送紀錄）。 */
function secretStorage(extra = {}) {
  return fakeStorage({
    [CLOUD_KEY]: JSON.stringify({
      player_id: PLAYER_ID, token: TOKEN, transfer_code: CODE, pending_transfer_code: NEW_CODE,
      slots: { 1: { version: 3, updated_at: 1760000000 } }, auto_upload: true, local_saved_at: { 1: 1760000000 },
    }),
    [PENDING_KEY]: JSON.stringify({ op: 'enable', token: PENDING_TOKEN, transfer_code: PENDING_CODE, at: 1760000000 }),
    [CLEAR_QUEUE_KEY]: JSON.stringify({ player_id: PLAYER_ID, records: {} }),
    ...extra,
  });
}

const SECRETS = [TOKEN, PENDING_TOKEN, CODE, PENDING_CODE, NEW_CODE, PLAYER_ID];
const expectNoSecrets = (text) => {
  for (const s of SECRETS) {
    expect(text).not.toContain(s);
    expect(text).not.toContain(s.replace('-', '')); // 轉移碼不帶連字號的寫法也不行
  }
  expect(text).not.toContain(CLOUD_KEY);
  expect(text).not.toContain('player_id');
  expect(text).not.toContain('token');
  expect(text).not.toContain('transfer_code');
};

describe('describeDevice：userAgent 精簡成作業系統＋瀏覽器名稱與主版本', () => {
  it.each([
    [UA_ANDROID, 'Android 14／Chrome 129'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'iOS 17.5／Safari 17'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1', 'iOS 18.0／Chrome 130'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.46', 'Windows／Edge 130'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Windows／Firefox 131'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'macOS／Safari 18'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'Linux／Chrome 129'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'ChromeOS／Chrome 128'],
    ['Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Android 13／Samsung Internet 25'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.6.1', 'iOS 17.4／LINE 內建瀏覽器 14'],
    ['', '未知作業系統／未知瀏覽器'],
    [undefined, '未知作業系統／未知瀏覽器'],
  ])('%s → %s', (ua, expected) => {
    expect(describeDevice(ua)).toBe(expected);
  });
});

describe('buildReportInfo：遊戲中', () => {
  it('依格式輸出版本、時間、裝置、章節、地圖、位置、譜系、隊伍、雲端狀態與存檔內容', () => {
    const text = buildReportInfo({ state, data, env: env({ cloudEnabled: true }) });
    const lines = text.split('\n');
    expect(lines[0]).toBe('【鋼鐵迷都 回報資訊】');
    expect(lines[1]).toBe('遊戲版本：2026.10.21（存檔格式 v4）');
    expect(lines[2]).toBe('時間：2026-10-21T08:09:10.000Z');
    expect(lines[3]).toBe('裝置：Android 14／Chrome 129；畫面 375×667');
    expect(lines[4]).toBe('章節：第二章　碼頭失蹤案（chapter2）　地圖：卡斯特維爾・碼頭區（dock）　位置：(0, 6)');
    expect(lines[5]).toBe('譜系：讀痕者 共鳴 7　崩解 17　殘響 2　遊戲時間 01:02:05');
    expect(lines[6]).toMatch(/^隊伍：艾琳 \d+\/\d+　艾妲・費恩 \d+\/\d+$/);
    expect(lines[7]).toBe('雲端存檔：已啟用（不含任何權杖或轉移碼）');
    expect(lines[8]).toBe(REPORT_SAVE_MARKER);
    expect(REPORT_SAVE_MARKER).toBe('---- 存檔內容（請勿修改）----');
    expect(lines[9]).toBe(serialize(state));
    expect(lines).toHaveLength(10);
  });

  it('存檔字串可以原樣讀回（deserialize＋sanitizeLoadedState）', () => {
    const text = buildReportInfo({ state, data, env: env() });
    const save = text.split(`${REPORT_SAVE_MARKER}\n`)[1];
    const back = sanitizeLoadedState(deserialize(save), data);
    expect(back.ok).toBe(true);
    expect(back.state.location).toEqual(state.location);
    expect(back.state.player.name).toBe('艾琳');
  });

  it('未啟用雲端、沒有譜系、沒有版本號、時間與畫面不明時照樣輸出', () => {
    const s = { ...state, lineage: null };
    const text = buildReportInfo({ state: s, data, env: env({ version: '', now: 'not-a-date', screen: null, cloudEnabled: false }) });
    expect(text).toContain('遊戲版本：未知（存檔格式 v4）');
    expect(text).toContain('時間：未知');
    expect(text).toContain('；畫面 未知');
    expect(text).toContain('譜系：尚未取得 共鳴 7　崩解 17　殘響 2　遊戲時間 01:02:05');
    expect(text).toContain('雲端存檔：未啟用（不含任何權杖或轉移碼）');
  });

  it('資料不認得的章節／地圖顯示 id；壞掉的 state 不丟錯', () => {
    const s = { ...state, chapter: 'nope', location: { ...state.location, map: 'nowhere' } };
    const text = buildReportInfo({ state: s, data, env: env() });
    expect(text).toContain('章節：nope（nope）');
    expect(text).toContain('地圖：nowhere（nowhere）');
    expect(() => buildReportInfo({ state: { player: 5 }, data: null, env: {} })).not.toThrow();
    expect(() => buildReportInfo({ state, data, env: undefined })).not.toThrow();
    expect(() => buildReportInfo({})).not.toThrow();
  });

  it('玩家名字照存檔原樣（包含引號、斜線等符號）', () => {
    const s = { ...state, player: { name: '小"明/\\' } };
    const text = buildReportInfo({ state: s, data, env: env() });
    expect(text).toContain('隊伍：小"明/\\ ');
    expect(text).toContain(serialize(s));
  });
});

describe('buildReportInfo：不在遊戲中（標題畫面）', () => {
  it('只有版本、時間、裝置與「目前不在遊戲中」；有最近一次的存檔時附上它', () => {
    const raw = serialize(state);
    const text = buildReportInfo({ state: null, data, env: env({ lastSave: { slot: 2, raw, why: 'last' } }) });
    expect(text.split('\n')).toEqual([
      '【鋼鐵迷都 回報資訊】',
      '遊戲版本：2026.10.21（存檔格式 v4）',
      '時間：2026-10-21T08:09:10.000Z',
      '裝置：Android 14／Chrome 129；畫面 375×667',
      '目前不在遊戲中',
      '附上的存檔：存檔 2（最近一次讀取或存檔的槽位）',
      REPORT_SAVE_MARKER,
      raw,
    ]);
  });

  it('沒有最近紀錄、只有一個存檔時註明是唯一的存檔', () => {
    const text = buildReportInfo({ state: null, data, env: env({ lastSave: { slot: 3, raw: '{"x":1}', why: 'only' } }) });
    expect(text).toContain('附上的存檔：存檔 3（唯一的存檔）');
    expect(text.endsWith(`${REPORT_SAVE_MARKER}\n{"x":1}`)).toBe(true);
  });

  it('沒有可附的存檔：不輸出存檔區塊', () => {
    const text = buildReportInfo({ state: null, data, env: env() });
    expect(text.split('\n')).toEqual([
      '【鋼鐵迷都 回報資訊】',
      '遊戲版本：2026.10.21（存檔格式 v4）',
      '時間：2026-10-21T08:09:10.000Z',
      '裝置：Android 14／Chrome 129；畫面 375×667',
      '目前不在遊戲中',
      '沒有附上存檔（找不到最近一次讀取或存檔的槽位）',
    ]);
  });
});

describe('雲端權杖與轉移碼絕不出現', () => {
  it('collectCloudSecrets 收集雲端資訊、待確認區、通關待送紀錄裡的所有字串值', () => {
    const got = collectCloudSecrets(secretStorage());
    for (const s of SECRETS) expect(got).toContain(s);
    expect(collectCloudSecrets(null)).toEqual([]);
    expect(collectCloudSecrets(fakeStorage({ [CLOUD_KEY]: '{壞掉' }))).toEqual([]);
    expect(collectCloudSecrets({ getItem() { throw new Error('blocked'); } })).toEqual([]);
  });

  it('遊戲中：localStorage 有假權杖與轉移碼，產生的文字搜尋不到它們', () => {
    const ls = secretStorage();
    const text = buildReportInfo({ state, data, env: env({ cloudEnabled: true, secrets: collectCloudSecrets(ls) }) });
    expectNoSecrets(text);
  });

  it('標題畫面附存檔時也一樣', () => {
    const raw = serialize(state);
    const ls = secretStorage({ [`${KEY_PREFIX}1`]: raw, [LAST_SLOT_KEY]: '1' });
    const text = buildReportInfo({ state: null, data, env: env({ lastSave: readLastSave(ls), secrets: collectCloudSecrets(ls) }) });
    expect(text).toContain(raw);
    expectNoSecrets(text);
  });

  it('萬一秘密混進存檔或名字（例如名字剛好等於轉移碼）：一律遮蔽', () => {
    const ls = secretStorage();
    const s = { ...state, player: { name: CODE }, flags: { [TOKEN]: true } };
    const text = buildReportInfo({ state: s, data, env: env({ secrets: collectCloudSecrets(ls) }) });
    expectNoSecrets(text);
    expect(text).toContain('［已遮蔽］');
  });
});

describe('最近一次讀取或存檔的槽位', () => {
  it('rememberLastSlot 記住槽位；readLastSave 讀回該槽原始內容', () => {
    const ls = fakeStorage({ [`${KEY_PREFIX}1`]: 'A', [`${KEY_PREFIX}2`]: 'B' });
    expect(rememberLastSlot(ls, 2)).toBe(true);
    expect(ls.getItem(LAST_SLOT_KEY)).toBe('2');
    expect(readLastSave(ls)).toEqual({ slot: 2, raw: 'B', why: 'last' });
  });

  it('記錄的槽位已經空了、或沒有紀錄：只有一個存檔時用它，否則 null', () => {
    expect(readLastSave(fakeStorage({ [`${KEY_PREFIX}3`]: 'C', [LAST_SLOT_KEY]: '1' }))).toEqual({ slot: 3, raw: 'C', why: 'only' });
    expect(readLastSave(fakeStorage({ [`${KEY_PREFIX}1`]: 'A', [`${KEY_PREFIX}3`]: 'C' }))).toBeNull();
    expect(readLastSave(fakeStorage())).toBeNull();
    expect(readLastSave(null)).toBeNull();
    expect(readLastSave({ getItem() { throw new Error('blocked'); } })).toBeNull();
  });

  it('不合法的槽位不記；儲存空間丟錯回 false', () => {
    const ls = fakeStorage();
    expect(rememberLastSlot(ls, 0)).toBe(false);
    expect(rememberLastSlot(ls, 'auto')).toBe(false);
    expect(ls.getItem(LAST_SLOT_KEY)).toBeNull();
    expect(rememberLastSlot({ setItem() { throw new Error('quota'); } }, 1)).toBe(false);
    expect(rememberLastSlot(null, 1)).toBe(false);
    expect(readLastSave(fakeStorage({ [`${KEY_PREFIX}1`]: 'A', [LAST_SLOT_KEY]: '9' }))).toEqual({ slot: 1, raw: 'A', why: 'only' });
  });
});

describe('copyText', () => {
  it('writeText 成功回 true，並收到完整文字', async () => {
    const got = [];
    expect(await copyText('abc\n第二行', { clipboard: { writeText: async (t) => { got.push(t); } } })).toBe(true);
    expect(got).toEqual(['abc\n第二行']);
  });

  it('被拒、丟錯、不支援時回 false，不往外丟錯', async () => {
    expect(await copyText('x', { clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } })).toBe(false);
    expect(await copyText('x', { clipboard: { writeText: () => { throw new Error('sync'); } } })).toBe(false);
    expect(await copyText('x', { clipboard: {} })).toBe(false);
    expect(await copyText('x', {})).toBe(false);
    expect(await copyText('x', null)).toBe(false);
  });
});
