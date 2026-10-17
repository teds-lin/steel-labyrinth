// 雲端同步邏輯（web/src/cloud/sync.js）：轉移碼格式、雲端資訊存取、上傳／下載／衝突／401／離線。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CLOUD_KEY, MSG, normalizeTransferCode, formatTransferCode, readCloudInfo, writeCloudInfo, clearCloudInfo,
  cloudErrorMessage, summarizeState, createCloudSync,
} from '../../web/src/cloud/sync.js';
import { createStorage, serialize, KEY_PREFIX } from '../../web/src/core/save.js';

const readData = (p) => JSON.parse(readFileSync(new URL(`../../web/data/${p}`, import.meta.url), 'utf8'));
const DATA = {
  maps: [readData('maps/attic.json'), readData('maps/street.json')],
  tiles: readData('tiles.json'),
  lineages: [],
  characters: [],
  items: [],
};

function memoryBackend(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const throwingBackend = () => ({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
});

/** 合法的 v2 存檔（閣樓）。 */
function makeState(over = {}) {
  return {
    schema_version: 2,
    player: { name: '艾琳' },
    lineage: null,
    location: { map: 'attic', x: 2, y: 3, dir: 'down' },
    flags: { 'enter:attic': true },
    items: {},
    echo: { charges: 3 },
    collapse: 0,
    resonance: {},
    chapter: 'prologue',
    chapter_done: [],
    playtime_s: 125,
    party: [{ id: 'hero', hp: null, sp: null }],
    ammo: 0,
    pending: null,
    ...over,
  };
}

/** 假 API：每個方法依 handlers 回應，並記錄呼叫。 */
function fakeApi(handlers = {}) {
  const calls = [];
  const def = (name) => async (...args) => {
    calls.push({ name, args });
    const h = handlers[name];
    if (typeof h === 'function') return h(...args);
    if (h) return h;
    return { ok: false, kind: 'network', status: 0, error: 'network', retryAfter: null, body: null };
  };
  const api = Object.fromEntries(['createPlayer', 'listSaves', 'getSave', 'putSave', 'deleteSave', 'transfer', 'rotateTransfer', 'reportClear', 'stats']
    .map((n) => [n, def(n)]));
  api.calls = calls;
  return api;
}
const ok = (status, body, etag = null) => ({ ok: true, status, body, etag });
const httpErr = (status, error, extra = {}) => ({ ok: false, kind: 'http', status, error, retryAfter: null, body: { error, message: 'x' }, ...extra });
const TOK = `tok_${'x'.repeat(39)}`; // 43 字元 base64url（修訂 2 G：格式不對的權杖視為未啟用）
const INFO = { player_id: 'p1', token: TOK, transfer_code: 'ABCD-EFGH' };
/** 可預測的「客戶端產生秘密」：權杖 01TTT…、02TTT…；轉移碼依序取用。 */
function seqRandom() {
  let t = 0;
  let c = 0;
  const codes = ['WXYZ-2345', 'MNPQ-RSTU', 'HJKM-NPQR', 'STUV-WXYZ'];
  return { token: () => `${String(++t).padStart(2, '0')}${'T'.repeat(41)}`, code: () => codes[c++ % codes.length] };
}
const GEN_TOKEN = (n) => `${String(n).padStart(2, '0')}${'T'.repeat(41)}`;

function setup({ info = INFO, handlers = {}, saves = {}, backend, random = seqRandom(), now = () => 1_760_000_000_000 } = {}) {
  const b = backend ?? memoryBackend();
  if (info && !backend) b.setItem(CLOUD_KEY, JSON.stringify(info));
  for (const [slot, st] of Object.entries(saves)) b.setItem(`${KEY_PREFIX}${slot}`, typeof st === 'string' ? st : serialize(st));
  const api = fakeApi(handlers);
  const saveStore = createStorage(b);
  const sync = createCloudSync({ backend: b, saveStore, getData: () => DATA, api, now, random });
  return { b, api, sync, saveStore, info: () => readCloudInfo(b) };
}

describe('轉移碼', () => {
  it('正規化：容忍小寫、空白、連字號', () => {
    expect(normalizeTransferCode('ABCD-EFGH')).toBe('ABCDEFGH');
    expect(normalizeTransferCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizeTransferCode('ab cd ef gh')).toBe('ABCDEFGH');
    expect(normalizeTransferCode('abcd——efgh')).toBe('ABCDEFGH'); // 全形破折號
    expect(normalizeTransferCode('ＡＢＣＤ－ＥＦＧＨ')).toBe('ABCDEFGH'); // 全形字母
    expect(normalizeTransferCode('wxyz2345')).toBe('WXYZ2345');
  });
  it('排除 0 O 1 I L、長度不對、非字串 → null', () => {
    for (const bad of ['ABCD-EFG0', 'ABCD-EFGO', 'ABCD-EFG1', 'ABCD-EFGI', 'ABCD-EFGL', 'ABCDEFG', 'ABCDEFGHJ', '', null, 12345678, 'ABCD_EFGH!']) {
      expect(normalizeTransferCode(bad), String(bad)).toBeNull();
    }
  });
  it('格式化成 XXXX-XXXX', () => {
    expect(formatTransferCode('abcdefgh')).toBe('ABCD-EFGH');
    expect(formatTransferCode('ABCD-EFGH')).toBe('ABCD-EFGH');
    expect(formatTransferCode('bad')).toBeNull();
  });
});

describe('雲端資訊（localStorage steel-labyrinth:cloud）', () => {
  it('不存在、JSON 壞掉、缺權杖、存取丟錯 → null', () => {
    expect(readCloudInfo(memoryBackend())).toBeNull();
    expect(readCloudInfo(memoryBackend({ [CLOUD_KEY]: '{bad' }))).toBeNull();
    expect(readCloudInfo(memoryBackend({ [CLOUD_KEY]: JSON.stringify({ player_id: 'p' }) }))).toBeNull();
    expect(readCloudInfo(memoryBackend({ [CLOUD_KEY]: JSON.stringify({ player_id: 'p', token: 5 }) }))).toBeNull();
    expect(readCloudInfo(throwingBackend())).toBeNull();
    expect(readCloudInfo(null)).toBeNull();
  });
  it('補上預設值；不合法的槽版本被丟掉', () => {
    const b = memoryBackend({ [CLOUD_KEY]: JSON.stringify({ ...INFO, slots: { 1: { version: 3, updated_at: 9 }, 2: { version: 'x' }, 9: { version: 1 } } }) });
    const i = readCloudInfo(b);
    expect(i).toMatchObject({ player_id: 'p1', token: TOK, transfer_code: 'ABCD-EFGH', auto_upload: false });
    expect(i.slots).toEqual({ 1: { version: 3, updated_at: 9 } });
    expect(i.local_saved_at).toEqual({});
  });
  it('寫入與清除；存取失敗回 false 不丟錯', () => {
    const b = memoryBackend();
    expect(writeCloudInfo(b, INFO)).toBe(true);
    expect(readCloudInfo(b).token).toBe(TOK);
    expect(clearCloudInfo(b)).toBe(true);
    expect(b.m.has(CLOUD_KEY)).toBe(false);
    expect(writeCloudInfo(throwingBackend(), INFO)).toBe(false);
    expect(clearCloudInfo(throwingBackend())).toBe(false);
  });
});

describe('錯誤訊息', () => {
  it('網路、逾時、5xx 都是同一句；429 帶秒數', () => {
    expect(MSG.unavailable).toBe('雲端暫時無法使用，稍後再試');
    expect(cloudErrorMessage({ ok: false, kind: 'network' })).toBe(MSG.unavailable);
    expect(cloudErrorMessage({ ok: false, kind: 'timeout' })).toBe(MSG.unavailable);
    expect(cloudErrorMessage({ ok: false, kind: 'http', status: 503 })).toBe(MSG.unavailable);
    expect(cloudErrorMessage({ ok: false, kind: 'http', status: 429, retryAfter: 37 })).toBe('雲端暫時無法使用，請等 37 秒後再試');
    // 修訂 2 G：1 分鐘以上顯示「約 N 分鐘」（無條件進位）
    expect(cloudErrorMessage({ ok: false, kind: 'http', status: 429, retryAfter: 60 })).toBe('雲端暫時無法使用，請等約 1 分鐘後再試');
    expect(cloudErrorMessage({ ok: false, kind: 'http', status: 429, retryAfter: 61 })).toBe('雲端暫時無法使用，請等約 2 分鐘後再試');
    expect(cloudErrorMessage({ ok: false, kind: 'http', status: 429, retryAfter: 3600 })).toBe('雲端暫時無法使用，請等約 60 分鐘後再試');
    expect(cloudErrorMessage({ ok: false, kind: 'http', status: 429, retryAfter: null })).toBe(MSG.unavailable);
    expect(cloudErrorMessage({ ok: false, kind: 'http', status: 401 })).toBe(MSG.relink);
    expect(MSG.relink).toBe('此裝置的雲端連結已失效，請重新用轉移碼接續');
  });
});

describe('summarizeState', () => {
  it('取名字、地點、章節、遊戲時間', () => {
    expect(summarizeState(makeState())).toEqual({ name: '艾琳', map: 'attic', chapter: 'prologue', playtime_s: 125 });
    expect(summarizeState(null)).toBeNull();
  });
});

describe('啟用與轉移', () => {
  it('enable：權杖與轉移碼由客戶端產生並送出；成功後存下 player_id、token、轉移碼（修訂 2 A）', async () => {
    const { sync, info, api } = setup({ info: null, handlers: { createPlayer: ok(201, { player_id: 'p9' }) } });
    expect(sync.enabled()).toBe(false);
    const r = await sync.enable();
    expect(r).toMatchObject({ ok: true, transferCode: 'WXYZ-2345' });
    expect(api.calls).toEqual([{ name: 'createPlayer', args: [{ token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345' }] }]);
    expect(info()).toMatchObject({ player_id: 'p9', token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345', slots: {}, auto_upload: false });
    expect(sync.enabled()).toBe(true);
  });
  it('enable：已啟用時不重複建立', async () => {
    const { sync, api } = setup();
    const r = await sync.enable();
    expect(r.ok).toBe(true);
    expect(api.calls.length).toBe(0);
  });
  it('enable：網路錯誤、回應缺欄位都不寫入雲端資訊', async () => {
    let s = setup({ info: null });
    let r = await s.sync.enable();
    expect(r).toMatchObject({ ok: false, message: MSG.unavailable });
    expect(s.info()).toBeNull();
    s = setup({ info: null, handlers: { createPlayer: ok(201, {}) } });
    r = await s.sync.enable();
    expect(r.ok).toBe(false);
    expect(s.info()).toBeNull();
  });
  it('enable：429 顯示「約 N 分鐘」', async () => {
    const { sync } = setup({ info: null, handlers: { createPlayer: httpErr(429, 'rate_limited', { retryAfter: 1200 }) } });
    const r = await sync.enable();
    expect(r.message).toBe('雲端暫時無法使用，請等約 20 分鐘後再試');
  });
  it('enable：503 capacity → 額滿訊息', async () => {
    const { sync } = setup({ info: null, handlers: { createPlayer: httpErr(503, 'capacity') } });
    expect((await sync.enable()).message).toBe(MSG.capacity);
  });
  it('enable：儲存空間被封鎖 → 失敗並說明，不送請求', async () => {
    const api = fakeApi({ createPlayer: ok(201, { player_id: 'p9' }) });
    const sync = createCloudSync({ backend: throwingBackend(), saveStore: createStorage(throwingBackend()), getData: () => DATA, api, random: seqRandom() });
    const r = await sync.enable();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('儲存空間');
    expect(api.calls.length).toBe(0);
  });
  it('connect：格式不對不送請求；成功後換成客戶端產生的新權杖與新轉移碼（版本紀錄清空）', async () => {
    const { sync, api, info } = setup({
      info: { ...INFO, slots: { 1: { version: 5, updated_at: 1 } } },
      handlers: { transfer: ok(200, { player_id: 'p2' }) },
    });
    let r = await sync.connect('ABC');
    expect(r).toMatchObject({ ok: false, kind: 'not_found' });
    expect(api.calls.length).toBe(0);
    r = await sync.connect(' mnpq rstu ');
    expect(api.calls[0]).toEqual({ name: 'transfer', args: [{ code: 'MNPQ-RSTU', new_token: GEN_TOKEN(1), new_transfer_code: 'WXYZ-2345' }] });
    expect(r).toMatchObject({ ok: true, transferCode: 'WXYZ-2345' });
    expect(info()).toMatchObject({ player_id: 'p2', token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345', slots: {} });
  });
  it('connect：404 且新權杖確認是 401 → 轉移碼不正確；網路錯誤 → 暫時無法使用；原本的資訊不變', async () => {
    let s = setup({ handlers: { transfer: httpErr(404, 'not_found'), listSaves: httpErr(401, 'unauthorized') } });
    let r = await s.sync.connect('MNPQ-RSTU');
    expect(r).toMatchObject({ ok: false, kind: 'not_found', message: MSG.badCode });
    expect(s.info().token).toBe(TOK);
    s = setup({ handlers: { transfer: { ok: false, kind: 'timeout', status: 0, error: 'timeout' }, listSaves: httpErr(401, 'unauthorized') } });
    r = await s.sync.connect('MNPQ-RSTU');
    expect(r.message).toBe(MSG.unavailable);
    expect(s.info().token).toBe(TOK);
  });
  it('rotate：新碼由客戶端產生並送出，成功後才換掉本機記住的轉移碼', async () => {
    const { sync, info, api } = setup({ handlers: { rotateTransfer: ok(200, {}) } });
    const r = await sync.rotate();
    expect(api.calls[0]).toEqual({ name: 'rotateTransfer', args: ['WXYZ-2345'] });
    expect(r).toMatchObject({ ok: true, transferCode: 'WXYZ-2345' });
    expect(info().transfer_code).toBe('WXYZ-2345');
    expect(info().pending_transfer_code).toBeNull();
  });
  it('disable：只清本機資訊，不呼叫 API', async () => {
    const { sync, api, info } = setup();
    expect(sync.disable()).toBe(true);
    expect(info()).toBeNull();
    expect(api.calls.length).toBe(0);
  });
  it('setAutoUpload 記在雲端資訊；noteLocalSave 記錄本機存檔時間', () => {
    const { sync, info } = setup();
    sync.setAutoUpload(true);
    expect(info().auto_upload).toBe(true);
    sync.noteLocalSave(2);
    expect(info().local_saved_at).toEqual({ 2: 1_760_000_000 });
  });
});

describe('401：清除本機雲端資訊並要求重新轉移', () => {
  for (const [name, call, handler] of [
    ['listCloud', (s) => s.listCloud(), 'listSaves'],
    ['upload', (s) => s.upload(1), 'putSave'],
    ['download', (s) => s.download(1), 'getSave'],
    ['rotate', (s) => s.rotate(), 'rotateTransfer'],
    ['reportClear', (s) => s.reportClear({ chapter: 'prologue', play_seconds: 1, collapse: 0 }), 'reportClear'],
  ]) {
    it(name, async () => {
      const { sync, info } = setup({ saves: { 1: makeState() }, handlers: { [handler]: httpErr(401, 'unauthorized') } });
      const r = await call(sync);
      expect(r).toMatchObject({ ok: false, kind: 'unauthorized', relink: true, message: MSG.relink });
      expect(info()).toBeNull();
      expect(sync.enabled()).toBe(false);
    });
  }
});

describe('列出雲端槽', () => {
  it('整理成固定 3 筆', async () => {
    const { sync } = setup({
      handlers: {
        listSaves: ok(200, { slots: [
          { slot: 1, version: 3, updated_at: 1_760_000_000, summary: { name: '艾琳', map: 'attic', chapter: 'prologue', playtime_s: 99, schema_version: 2 } },
          { slot: 2, empty: true },
        ] }),
      },
    });
    const r = await sync.listCloud();
    expect(r.ok).toBe(true);
    expect(r.slots).toEqual([
      { slot: 1, empty: false, version: 3, updated_at: 1_760_000_000, summary: { name: '艾琳', map: 'attic', chapter: 'prologue', playtime_s: 99 } },
      { slot: 2, empty: true },
      { slot: 3, empty: true },
    ]);
  });
  it('回應格式不對 → 失敗', async () => {
    const { sync } = setup({ handlers: { listSaves: ok(200, { nope: 1 }) } });
    expect((await sync.listCloud()).ok).toBe(false);
  });
  it('summary 欄位是 null 或型別不對（版本較新的存檔）→ null，由畫面顯示「—」（API.md 補充 4）', async () => {
    const { sync } = setup({ handlers: { listSaves: ok(200, { slots: [
      { slot: 1, version: 1, updated_at: 1, summary: { name: 5, map: null, chapter: null, playtime_s: null, schema_version: 3 } },
      { slot: 2, version: 2, updated_at: 1, summary: null },
    ] }) } });
    const r = await sync.listCloud();
    expect(r.slots[0].summary).toEqual({ name: null, map: null, chapter: null, playtime_s: null });
    expect(r.slots[1].summary).toEqual({ name: null, map: null, chapter: null, playtime_s: null });
  });
  it('未啟用時不送請求', async () => {
    const { sync, api } = setup({ info: null });
    const r = await sync.listCloud();
    expect(r).toMatchObject({ ok: false, kind: 'disabled' });
    expect(api.calls.length).toBe(0);
  });
});

describe('上傳', () => {
  it('沒有記住版本 → 不帶版本（If-None-Match: *），成功記下新版本', async () => {
    const { sync, api, info } = setup({ saves: { 1: makeState() }, handlers: { putSave: ok(200, { slot: 1, version: 1, updated_at: 1_760_000_100 }, '"1"') } });
    const r = await sync.upload(1);
    expect(r).toMatchObject({ ok: true, version: 1 });
    const [slot, data, opts] = api.calls[0].args;
    expect(slot).toBe(1);
    expect(JSON.parse(data).player.name).toBe('艾琳');
    expect(opts).toEqual({ version: null });
    expect(info().slots).toEqual({ 1: { version: 1, updated_at: 1_760_000_100 } });
  });
  it('新建的存檔版本不一定是 1：以回應的 version 為準（API.md 補充 2）', async () => {
    const { sync, info } = setup({ saves: { 1: makeState() }, handlers: { putSave: ok(200, { slot: 1, version: 42, updated_at: 5 }, '"42"') } });
    const r = await sync.upload(1);
    expect(r.version).toBe(42);
    expect(info().slots[1].version).toBe(42);
  });
  it('下一次上傳以 If-Match 帶回應給的版本（不是 1）', async () => {
    const results = [ok(200, { slot: 1, version: 42, updated_at: 5 }), ok(200, { slot: 1, version: 43, updated_at: 6 })];
    const { sync, api } = setup({ saves: { 1: makeState() }, handlers: { putSave: () => results.shift() } });
    await sync.upload(1);
    await sync.upload(1);
    expect(api.calls.map((c) => c.args[2])).toEqual([{ version: null }, { version: 42 }]);
  });
  it('ETag 是 W/"7" 或沒有引號時也能解析', async () => {
    for (const etag of ['W/"7"', '7']) {
      const { sync } = setup({ saves: { 1: makeState() }, handlers: { putSave: ok(200, {}, etag) } });
      expect((await sync.upload(1)).version).toBe(7);
    }
  });
  it('有記住版本 → 帶 If-Match 該版本', async () => {
    const { sync, api, info } = setup({
      info: { ...INFO, slots: { 2: { version: 4, updated_at: 1 } } },
      saves: { 2: makeState() },
      handlers: { putSave: ok(200, { slot: 2, version: 5, updated_at: 2 }) },
    });
    await sync.upload(2);
    expect(api.calls[0].args[2]).toEqual({ version: 4 });
    expect(info().slots[2].version).toBe(5);
  });
  it('回應沒有 version 時改用 ETag', async () => {
    const { sync, info } = setup({ saves: { 1: makeState() }, handlers: { putSave: ok(200, {}, '"7"') } });
    const r = await sync.upload(1);
    expect(r.version).toBe(7);
    expect(info().slots[1].version).toBe(7);
  });
  it('本機槽是空的或損壞 → 不送請求', async () => {
    const { sync, api } = setup({ saves: { 2: '{bad' } });
    let r = await sync.upload(1);
    expect(r).toMatchObject({ ok: false, kind: 'local_empty' });
    r = await sync.upload(2);
    expect(r).toMatchObject({ ok: false, kind: 'local_broken' });
    expect(api.calls.length).toBe(0);
  });
  it('409：整理成雲端摘要 vs 本機摘要，不改記住的版本', async () => {
    const current = { version: 9, updated_at: 1_760_000_500, summary: { name: '別台', map: 'street', chapter: 'prologue', playtime_s: 600, schema_version: 2 } };
    const { sync, info } = setup({
      info: { ...INFO, slots: { 1: { version: 4, updated_at: 1 } }, local_saved_at: { 1: 1_760_000_050 } },
      saves: { 1: makeState() },
      handlers: { putSave: httpErr(409, 'conflict', { body: { error: 'conflict', message: 'x', current } }) },
    });
    const r = await sync.upload(1);
    expect(r).toEqual({
      ok: false, kind: 'conflict', slot: 1,
      conflict: {
        slot: 1,
        cloudVersion: 9,
        cloud: { empty: false, version: 9, updated_at: 1_760_000_500, name: '別台', map: 'street', chapter: 'prologue', playtime_s: 600 },
        local: { empty: false, name: '艾琳', map: 'attic', chapter: 'prologue', playtime_s: 125, updated_at: 1_760_000_050 },
      },
    });
    expect(info().slots[1].version).toBe(4);
  });
  it('409 沒有 current（雲端是空的）→ 雲端摘要標成空', async () => {
    const { sync } = setup({ saves: { 1: makeState() }, handlers: { putSave: httpErr(409, 'conflict', { body: { error: 'conflict', message: 'x', current: null } }) } });
    const r = await sync.upload(1);
    expect(r.conflict.cloud).toEqual({ empty: true }); // current 為 null（API.md 補充 3）
    expect(r.conflict.cloudVersion).toBeNull();
    expect(r.conflict.local.updated_at).toBeNull();
  });
  it('「用本機的」：force 時以衝突時的雲端版本為 If-Match', async () => {
    const { sync, api, info } = setup({
      info: { ...INFO, slots: { 1: { version: 4, updated_at: 1 } } },
      saves: { 1: makeState() },
      handlers: { putSave: ok(200, { slot: 1, version: 10, updated_at: 3 }) },
    });
    await sync.upload(1, { force: true, cloudVersion: 9 });
    expect(api.calls[0].args[2]).toEqual({ version: 9 });
    expect(info().slots[1].version).toBe(10);
    await sync.upload(1, { force: true, cloudVersion: null });
    expect(api.calls[1].args[2]).toEqual({ version: null });
  });
  it('PUT 回 404（雲端槽被刪掉）→ 忘記版本，改用 If-None-Match 重試一次', async () => {
    const results = [httpErr(404, 'not_found'), ok(200, { slot: 1, version: 1, updated_at: 5 })];
    const { sync, api, info } = setup({
      info: { ...INFO, slots: { 1: { version: 4, updated_at: 1 } } },
      saves: { 1: makeState() },
      handlers: { putSave: () => results.shift() },
    });
    const r = await sync.upload(1);
    expect(r.ok).toBe(true);
    expect(api.calls.map((c) => c.args[2])).toEqual([{ version: 4 }, { version: null }]);
    expect(info().slots[1].version).toBe(1);
  });
  it('網路錯誤、逾時、5xx、429：回傳訊息，本機存檔不受影響', async () => {
    for (const res of [
      { ok: false, kind: 'network', status: 0, error: 'network' },
      { ok: false, kind: 'timeout', status: 0, error: 'timeout' },
      httpErr(500, 'internal'),
      httpErr(429, 'rate_limited', { retryAfter: 12 }),
    ]) {
      const { sync, saveStore, info } = setup({ saves: { 1: makeState() }, handlers: { putSave: res } });
      const r = await sync.upload(1);
      expect(r.ok).toBe(false);
      expect(r.message).toBe(res.status === 429 ? '雲端暫時無法使用，請等 12 秒後再試' : MSG.unavailable);
      expect(saveStore.load(1).ok).toBe(true);
      expect(info().token).toBe(TOK);
      expect(sync.status().lastError).toMatchObject({ op: 'upload', kind: res.kind });
    }
  });
});

describe('下載', () => {
  const cloudSave = (st, version = 3) => ok(200, { slot: 1, version, updated_at: 1_760_000_900, data: typeof st === 'string' ? st : serialize(st) }, `"${version}"`);

  it('deserialize＋sanitizeLoadedState 後才寫入本機槽，並記下版本', async () => {
    const { sync, saveStore, info } = setup({ handlers: { getSave: cloudSave(makeState({ player: { name: '雲端的艾琳' } })) } });
    const r = await sync.download(1);
    expect(r.ok).toBe(true);
    expect(r.state.player.name).toBe('雲端的艾琳');
    expect(saveStore.load(1).state.player.name).toBe('雲端的艾琳');
    expect(info().slots[1]).toEqual({ version: 3, updated_at: 1_760_000_900 });
  });
  it('位置不合法的存檔：修正後寫入並帶警告', async () => {
    const { sync, saveStore } = setup({ handlers: { getSave: cloudSave(makeState({ location: { map: 'attic', x: 999, y: 999, dir: 'down' } })) } });
    const r = await sync.download(1);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(saveStore.load(1).state.location.x).not.toBe(999);
  });
  it('名字含不合法字元：sanitize 後才寫入', async () => {
    const { sync, saveStore } = setup({ handlers: { getSave: cloudSave(makeState({ player: { name: '<img src=x onerror=alert(1)>' } })) } });
    const r = await sync.download(1);
    expect(r.ok).toBe(true);
    expect(saveStore.load(1).state.player.name).not.toContain('<');
  });
  it('損壞、版本較新、語意不合法（地圖不存在）、data 不是字串 → 不寫入', async () => {
    for (const [data, kind] of [
      ['{bad', 'broken'],
      [JSON.stringify({ ...makeState(), schema_version: 99 }), 'newer'],
      [serialize(makeState({ location: { map: 'nowhere', x: 1, y: 1, dir: 'down' } })), 'broken'],
      [42, 'broken'],
    ]) {
      const prev = makeState({ player: { name: '本機' } });
      const { sync, saveStore, info } = setup({ saves: { 1: prev }, handlers: { getSave: ok(200, { slot: 1, version: 3, updated_at: 1, data }) } });
      const r = await sync.download(1);
      expect(r).toMatchObject({ ok: false, kind });
      expect(saveStore.load(1).state.player.name).toBe('本機');
      expect(info().slots[1]).toBeUndefined();
    }
  });
  it('版本較新的訊息請玩家更新遊戲', async () => {
    const { sync } = setup({ handlers: { getSave: ok(200, { slot: 1, version: 3, updated_at: 1, data: JSON.stringify({ ...makeState(), schema_version: 99 }) }) } });
    expect((await sync.download(1)).message).toContain('請更新遊戲');
  });
  it('404 → 雲端這格是空的', async () => {
    const { sync } = setup({ handlers: { getSave: httpErr(404, 'not_found') } });
    expect(await sync.download(1)).toMatchObject({ ok: false, kind: 'empty', message: MSG.cloudEmpty });
  });
  it('下載到另一格：不記版本（版本只對應同一格）', async () => {
    const { sync, saveStore, info } = setup({ handlers: { getSave: cloudSave(makeState()) } });
    const r = await sync.download(1, 3);
    expect(r.ok).toBe(true);
    expect(saveStore.load(3).ok).toBe(true);
    expect(saveStore.load(1).ok).toBe(false);
    expect(info().slots).toEqual({});
  });
  it('fetchCloud：只取回並驗證，不寫入本機', async () => {
    const { sync, saveStore } = setup({ handlers: { getSave: cloudSave(makeState()) } });
    const r = await sync.fetchCloud(1);
    expect(r.ok).toBe(true);
    expect(r.state.player.name).toBe('艾琳');
    expect(saveStore.load(1).ok).toBe(false);
  });
  it('本機儲存空間寫入失敗 → 失敗並說明', async () => {
    const b = memoryBackend({ [CLOUD_KEY]: JSON.stringify(INFO) });
    const api = fakeApi({ getSave: cloudSave(makeState()) });
    const saveStore = { load: () => ({ ok: false, code: 'empty', reason: 'empty' }), save: () => ({ ok: false, code: 'storage_error', reason: 'Quota' }) };
    const sync = createCloudSync({ backend: b, saveStore, getData: () => DATA, api });
    const r = await sync.download(1);
    expect(r).toMatchObject({ ok: false, kind: 'local_write' });
    expect(readCloudInfo(b).slots).toEqual({});
  });
  it('網路錯誤：本機槽不變', async () => {
    const { sync, saveStore } = setup({ saves: { 1: makeState({ player: { name: '本機' } }) } });
    const r = await sync.download(1);
    expect(r.message).toBe(MSG.unavailable);
    expect(saveStore.load(1).state.player.name).toBe('本機');
  });
});

describe('通關回報', () => {
  it('送出整理過的紀錄', async () => {
    const { sync, api } = setup({ handlers: { reportClear: ok(200, { chapter: 'prologue', best_play_seconds: 10 }) } });
    const r = await sync.reportClear({ chapter: 'prologue', ending: null, play_seconds: 3600.7, collapse: 34 });
    expect(r.ok).toBe(true);
    expect(api.calls[0].args[0]).toEqual({ chapter: 'prologue', ending: null, play_seconds: 3600, collapse: 34 });
  });
  it('數值超出範圍時夾到合法範圍；ending 不合法時改 null', async () => {
    const { sync, api } = setup({ handlers: { reportClear: ok(200, {}) } });
    await sync.reportClear({ chapter: 'chapter2', ending: 'Bad Ending!', play_seconds: 1e9, collapse: 150 });
    expect(api.calls[0].args[0]).toEqual({ chapter: 'chapter2', ending: null, play_seconds: 36000, collapse: 100 }); // 修訂 4 第 7 節
  });
  it('章節 id 不合法或未啟用 → 不送', async () => {
    let s = setup();
    expect((await s.sync.reportClear({ chapter: 'Bad-Chapter', play_seconds: 1, collapse: 0 })).ok).toBe(false);
    expect(s.api.calls.length).toBe(0);
    s = setup({ info: null });
    expect(await s.sync.reportClear({ chapter: 'prologue', play_seconds: 1, collapse: 0 })).toMatchObject({ ok: false, kind: 'disabled' });
    expect(s.api.calls.length).toBe(0);
  });
});

describe('status（給 __SL.cloud 的唯讀狀態）', () => {
  it('不含權杖', () => {
    const { sync } = setup({ info: { ...INFO, auto_upload: true } });
    const st = sync.status();
    expect(st).toMatchObject({ enabled: true, playerId: 'p1', transferCode: 'ABCD-EFGH', autoUpload: true });
    expect(JSON.stringify(st)).not.toContain(TOK);
  });
  it('未啟用', () => {
    const { sync } = setup({ info: null });
    expect(sync.status()).toMatchObject({ enabled: false, playerId: null, transferCode: null });
  });
});
