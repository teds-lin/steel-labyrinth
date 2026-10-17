// 雲端同步：API.md 修訂 2 的客戶端行為（秘密由客戶端產生＋待確認區、data_sha256 自動判定、上傳前語意驗證、
// 本機雲端資訊驗證、429 分鐘數、轉移碼去除 Cf 字元、雲端未開放）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  CLOUD_KEY, PENDING_KEY, MSG, normalizeTransferCode, readCloudInfo, createCloudSync,
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
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function memoryBackend(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function makeState(over = {}) {
  return {
    schema_version: 2, player: { name: '艾琳' }, lineage: null, location: { map: 'attic', x: 2, y: 3, dir: 'down' },
    flags: { 'enter:attic': true }, items: {}, echo: { charges: 3 }, collapse: 0, resonance: {}, chapter: 'prologue',
    chapter_done: [], playtime_s: 125, party: [{ id: 'hero', hp: null, sp: null }], ammo: 0, pending: null, ...over,
  };
}
function fakeApi(handlers = {}) {
  const calls = [];
  const def = (name) => async (...args) => {
    calls.push({ name, args });
    const h = handlers[name];
    const pick = Array.isArray(h) ? (h.length > 1 ? h.shift() : h[0]) : h;
    if (typeof pick === 'function') return pick(...args);
    if (pick) return pick;
    return { ok: false, kind: 'network', status: 0, error: 'network', retryAfter: null, body: null };
  };
  const api = Object.fromEntries(['createPlayer', 'listSaves', 'getSave', 'putSave', 'deleteSave', 'transfer', 'rotateTransfer', 'reportClear', 'stats']
    .map((n) => [n, def(n)]));
  api.calls = calls;
  return api;
}
const ok = (status, body, etag = null) => ({ ok: true, status, body, etag });
const httpErr = (status, error, extra = {}) => ({ ok: false, kind: 'http', status, error, retryAfter: null, body: { error, message: 'x' }, ...extra });
const TIMEOUT = { ok: false, kind: 'timeout', status: 0, error: 'timeout', retryAfter: null, body: null };
const TOK = `tok_${'x'.repeat(39)}`;
const INFO = { player_id: 'p1', token: TOK, transfer_code: 'ABCD-EFGH' };
const GEN_TOKEN = (n) => `${String(n).padStart(2, '0')}${'T'.repeat(41)}`;
function seqRandom() {
  let t = 0;
  let c = 0;
  const codes = ['WXYZ-2345', 'MNPQ-RSTU', 'HJKM-NPQR', 'STUV-WXYZ'];
  return { token: () => GEN_TOKEN(++t), code: () => codes[c++ % codes.length] };
}
const NOW = 1_760_000_000_000;

function setup({ info = INFO, handlers = {}, saves = {}, backend, now = () => NOW, configured } = {}) {
  const b = backend ?? memoryBackend();
  if (info && !backend) b.setItem(CLOUD_KEY, JSON.stringify(info));
  for (const [slot, st] of Object.entries(saves)) b.setItem(`${KEY_PREFIX}${slot}`, typeof st === 'string' ? st : serialize(st));
  const api = fakeApi(handlers);
  const sync = createCloudSync({ backend: b, saveStore: createStorage(b), getData: () => DATA, api, now, random: seqRandom(), configured });
  const pending = () => JSON.parse(b.getItem(PENDING_KEY) ?? 'null');
  return { b, api, sync, info: () => readCloudInfo(b), pending };
}

// ---------------------------------------------------------------------------
describe('A：建立玩家（秘密先寫進待確認區，逾時用同一組重送）', () => {
  it('送出前已把 token／transfer_code 寫進 localStorage 的待確認區；成功後轉正並清掉待確認區', async () => {
    let seenPending = null;
    const s = setup({
      info: null,
      handlers: { createPlayer: (body) => { seenPending = s.pending(); return ok(201, { player_id: 'p9' }); } },
    });
    const r = await s.sync.enable();
    expect(r.ok).toBe(true);
    expect(seenPending).toMatchObject({ op: 'enable', token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345' });
    expect(s.pending()).toBeNull();
    expect(s.info()).toMatchObject({ player_id: 'p9', token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345' });
  });
  it('逾時 → 待確認區保留；再按啟用用同一組秘密重送（伺服器冪等回 200）', async () => {
    const s = setup({ info: null, handlers: { createPlayer: [TIMEOUT, ok(200, { player_id: 'p9' })] } });
    let r = await s.sync.enable();
    expect(r).toMatchObject({ ok: false, message: MSG.unavailable });
    expect(s.info()).toBeNull();
    expect(s.pending()).toMatchObject({ op: 'enable', token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345' });
    r = await s.sync.enable();
    expect(r).toMatchObject({ ok: true, transferCode: 'WXYZ-2345' });
    const sent = s.api.calls.filter((c) => c.name === 'createPlayer').map((c) => c.args[0]);
    expect(sent).toEqual([{ token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345' }, { token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345' }]);
    expect(s.info().token).toBe(GEN_TOKEN(1));
    expect(s.pending()).toBeNull();
  });
  it('409（轉移碼雜湊碰撞）→ 換一組秘密重送', async () => {
    const s = setup({ info: null, handlers: { createPlayer: [httpErr(409, 'conflict'), ok(201, { player_id: 'p9' })] } });
    const r = await s.sync.enable();
    expect(r.ok).toBe(true);
    const sent = s.api.calls.map((c) => c.args[0]);
    expect(sent).toEqual([{ token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345' }, { token: GEN_TOKEN(2), transfer_code: 'MNPQ-RSTU' }]);
    expect(s.info()).toMatchObject({ token: GEN_TOKEN(2), transfer_code: 'MNPQ-RSTU' });
  });
  it('待確認區寫不進去（儲存空間被封鎖）→ 不送請求', async () => {
    const b = memoryBackend();
    b.setItem = () => { throw new Error('QuotaExceededError'); };
    const s = setup({ info: null, backend: b });
    const r = await s.sync.enable();
    expect(r).toMatchObject({ ok: false, kind: 'storage' });
    expect(s.api.calls.length).toBe(0);
  });
});

describe('A：用轉移碼接續（逾時後用 new_token 呼叫 GET /api/saves 判斷）', () => {
  it('送出前 new_token／new_transfer_code 已在待確認區', async () => {
    let seen = null;
    const s = setup({ handlers: { transfer: () => { seen = s.pending(); return ok(200, { player_id: 'p2' }); } } });
    await s.sync.connect('MNPQ-RSTU');
    expect(seen).toMatchObject({ op: 'transfer', code: 'MNPQ-RSTU', new_token: GEN_TOKEN(1), new_transfer_code: 'WXYZ-2345' });
    expect(s.pending()).toBeNull();
  });
  it('逾時 → 用 new_token 列表 200 → 視為轉移成功（舊資訊換掉）', async () => {
    const s = setup({
      info: { ...INFO, slots: { 1: { version: 5, updated_at: 1 } } },
      handlers: { transfer: TIMEOUT, listSaves: ok(200, { slots: [] }) },
    });
    const r = await s.sync.connect('mnpq-rstu');
    expect(r).toMatchObject({ ok: true, transferCode: 'WXYZ-2345' });
    expect(s.api.calls.map((c) => c.name)).toEqual(['transfer', 'listSaves']);
    expect(s.api.calls[1].args[0]).toEqual({ token: GEN_TOKEN(1) });
    expect(s.info()).toMatchObject({ token: GEN_TOKEN(1), transfer_code: 'WXYZ-2345', slots: {} });
    expect(s.pending()).toBeNull();
  });
  it('逾時 → 列表 401（沒成功）→ 暫時無法使用、保留待確認區；重試沿用同一組 new_token，先確認再送', async () => {
    const s = setup({
      handlers: {
        transfer: [TIMEOUT, ok(200, { player_id: 'p2' })],
        listSaves: httpErr(401, 'unauthorized'),
      },
    });
    let r = await s.sync.connect('MNPQ-RSTU');
    expect(r).toMatchObject({ ok: false, message: MSG.unavailable });
    expect(s.info().token).toBe(TOK); // 原本的帳號不受影響
    expect(s.pending()).toMatchObject({ op: 'transfer', new_token: GEN_TOKEN(1) });
    r = await s.sync.connect('MNPQ-RSTU');
    expect(r.ok).toBe(true);
    const transfers = s.api.calls.filter((c) => c.name === 'transfer').map((c) => c.args[0]);
    expect(transfers.map((t) => t.new_token)).toEqual([GEN_TOKEN(1), GEN_TOKEN(1)]);
    expect(transfers.map((t) => t.new_transfer_code)).toEqual(['WXYZ-2345', 'WXYZ-2345']);
    // 第二次送出前先用待確認的權杖確認過一次
    expect(s.api.calls.map((c) => c.name)).toEqual(['transfer', 'listSaves', 'listSaves', 'transfer']);
    expect(s.info().token).toBe(GEN_TOKEN(1));
  });
  it('重試前確認 → 其實上一次已經成功（200）→ 直接完成，不再送轉移', async () => {
    const s = setup({ handlers: { transfer: TIMEOUT, listSaves: [httpErr(401, 'unauthorized'), ok(200, { slots: [] })] } });
    await s.sync.connect('MNPQ-RSTU');
    const r = await s.sync.connect('MNPQ-RSTU');
    expect(r).toMatchObject({ ok: true, transferCode: 'WXYZ-2345' });
    expect(s.api.calls.filter((c) => c.name === 'transfer').length).toBe(1);
  });
  it('轉移回 404，但用 new_token 確認是 200（先前逾時的那次已經用掉這個碼）→ 成功', async () => {
    const s = setup({ handlers: { transfer: [TIMEOUT, httpErr(404, 'not_found')], listSaves: [httpErr(401, 'unauthorized'), httpErr(401, 'unauthorized'), ok(200, { slots: [] })] } });
    await s.sync.connect('MNPQ-RSTU');
    const r = await s.sync.connect('MNPQ-RSTU');
    expect(r.ok).toBe(true);
    expect(s.info().token).toBe(GEN_TOKEN(1));
  });
  it('404 且確認 401 → 轉移碼不正確，清掉待確認區', async () => {
    const s = setup({ handlers: { transfer: httpErr(404, 'not_found'), listSaves: httpErr(401, 'unauthorized') } });
    const r = await s.sync.connect('MNPQ-RSTU');
    expect(r).toMatchObject({ ok: false, kind: 'not_found', message: MSG.badCode });
    expect(s.pending()).toBeNull();
  });
});

describe('A：重新整理後恢復（recover）', () => {
  const pendingOf = (o, at = NOW / 1000) => ({ [PENDING_KEY]: JSON.stringify({ at, ...o }) });
  it('待確認的轉移：new_token 列表 200 → 轉正', async () => {
    const b = memoryBackend({ [CLOUD_KEY]: JSON.stringify(INFO), ...pendingOf({ op: 'transfer', code: 'MNPQ-RSTU', new_token: GEN_TOKEN(7), new_transfer_code: 'HJKM-NPQR' }) });
    const s = setup({ backend: b, handlers: { listSaves: ok(200, { slots: [] }) } });
    const r = await s.sync.recover();
    expect(r).toMatchObject({ recovered: 'transfer' });
    expect(s.api.calls[0]).toEqual({ name: 'listSaves', args: [{ token: GEN_TOKEN(7) }] });
    expect(s.info()).toMatchObject({ token: GEN_TOKEN(7), transfer_code: 'HJKM-NPQR', player_id: null });
    expect(s.pending()).toBeNull();
  });
  it('待確認的建立玩家：權杖列表 200 → 轉正', async () => {
    const b = memoryBackend(pendingOf({ op: 'enable', token: GEN_TOKEN(5), transfer_code: 'STUV-WXYZ' }));
    const s = setup({ backend: b, handlers: { listSaves: ok(200, { slots: [] }) } });
    await s.sync.recover();
    expect(s.info()).toMatchObject({ token: GEN_TOKEN(5), transfer_code: 'STUV-WXYZ' });
    expect(s.sync.enabled()).toBe(true);
  });
  it('列表 401：剛送出的（10 分鐘內）保留；太舊的清掉；網路錯誤保留', async () => {
    const pend = { op: 'transfer', code: 'MNPQ-RSTU', new_token: GEN_TOKEN(7), new_transfer_code: 'HJKM-NPQR' };
    let s = setup({ backend: memoryBackend(pendingOf(pend)), handlers: { listSaves: httpErr(401, 'unauthorized') } });
    await s.sync.recover();
    expect(s.pending()).not.toBeNull();
    s = setup({ backend: memoryBackend(pendingOf(pend, NOW / 1000 - 601)), handlers: { listSaves: httpErr(401, 'unauthorized') } });
    await s.sync.recover();
    expect(s.pending()).toBeNull();
    s = setup({ backend: memoryBackend(pendingOf(pend, NOW / 1000 - 9999)), handlers: { listSaves: TIMEOUT } });
    await s.sync.recover();
    expect(s.pending()).not.toBeNull();
  });
  it('待確認的新轉移碼：用同一個碼重送 rotate，成功後轉正', async () => {
    const s = setup({ info: { ...INFO, pending_transfer_code: 'HJKM-NPQR' }, handlers: { rotateTransfer: ok(200, {}) } });
    await s.sync.recover();
    expect(s.api.calls).toEqual([{ name: 'rotateTransfer', args: ['HJKM-NPQR'] }]);
    expect(s.info()).toMatchObject({ transfer_code: 'HJKM-NPQR', pending_transfer_code: null });
  });
  it('待確認區壞掉（不是 JSON、權杖格式不對）→ 當作沒有並清掉', async () => {
    for (const raw of ['{bad', JSON.stringify({ op: 'transfer', code: 'MNPQ-RSTU', new_token: 'short', new_transfer_code: 'HJKM-NPQR', at: 1 })]) {
      const s = setup({ backend: memoryBackend({ [PENDING_KEY]: raw }) });
      await s.sync.recover();
      expect(s.api.calls.length).toBe(0);
      expect(s.b.getItem(PENDING_KEY)).toBeNull();
    }
  });
  it('沒有待確認的東西 → 不送任何請求', async () => {
    const s = setup();
    await s.sync.recover();
    expect(s.api.calls.length).toBe(0);
  });
});

describe('A：重新產生轉移碼（新碼確認前標示尚未確認，重試用同一個碼）', () => {
  it('逾時：新碼存成待確認（transferCode 仍是舊碼）；再按一次用同一個新碼重送，成功才轉正', async () => {
    const s = setup({ handlers: { rotateTransfer: [TIMEOUT, ok(200, {})] } });
    let r = await s.sync.rotate();
    expect(r).toMatchObject({ ok: false, message: MSG.unavailable, pendingCode: 'WXYZ-2345' });
    expect(s.sync.transferCode()).toBe('ABCD-EFGH');
    expect(s.sync.pendingTransferCode()).toBe('WXYZ-2345');
    expect(s.sync.status().pendingTransferCode).toBe('WXYZ-2345');
    r = await s.sync.rotate();
    expect(r).toMatchObject({ ok: true, transferCode: 'WXYZ-2345' });
    expect(s.api.calls.map((c) => c.args[0])).toEqual(['WXYZ-2345', 'WXYZ-2345']);
    expect(s.sync.transferCode()).toBe('WXYZ-2345');
    expect(s.sync.pendingTransferCode()).toBeNull();
  });
  it('送出前新碼已寫進本機', async () => {
    let seen = null;
    const s = setup({ handlers: { rotateTransfer: () => { seen = s.info().pending_transfer_code; return ok(200, {}); } } });
    await s.sync.rotate();
    expect(seen).toBe('WXYZ-2345');
  });
});

// ---------------------------------------------------------------------------
describe('B：data_sha256 自動判定', () => {
  it('409 但 current.data_sha256 等於要上傳的內容 → 視為已上傳，採用 current.version，不顯示衝突', async () => {
    const s = setup({
      info: { ...INFO, slots: { 1: { version: 1, updated_at: 1 } } },
      saves: { 1: makeState() },
      handlers: { putSave: (slot, data) => httpErr(409, 'conflict', { body: { error: 'conflict', current: { version: 2, updated_at: 9, data_sha256: sha(data), summary: {} } } }) },
    });
    const r = await s.sync.upload(1);
    expect(r).toMatchObject({ ok: true, version: 2 });
    expect(s.info().slots[1]).toMatchObject({ version: 2 });
    expect(s.info().slots[1].pending_sha256 ?? null).toBeNull();
  });
  it('送出前把這次內容的雜湊記成 pending_sha256；成功後清掉', async () => {
    let seen = null;
    const s = setup({ saves: { 1: makeState() }, handlers: { putSave: (slot, data) => { seen = { pending: s.info().slots[1]?.pending_sha256, data }; return ok(200, { slot: 1, version: 1, updated_at: 5 }); } } });
    await s.sync.upload(1);
    expect(seen.pending).toBe(sha(seen.data));
    expect(s.info().slots[1]).toEqual({ version: 1, updated_at: 5 });
  });
  it('上傳逾時（其實寫進去了）→ 下一次上傳前先列表：雜湊相符就採用雲端版本再上傳（新內容），不出現衝突', async () => {
    const server = { version: 1, hash: null };
    const s = setup({
      info: { ...INFO, slots: { 1: { version: 1, updated_at: 1 } } },
      saves: { 1: makeState() },
      handlers: {
        putSave: [
          (slot, data) => { server.version = 2; server.hash = sha(data); return TIMEOUT; },
          (slot, data, { version }) => (version === server.version
            ? ok(200, { slot: 1, version: 3, updated_at: 7 })
            : httpErr(409, 'conflict', { body: { current: { version: server.version, updated_at: 6, data_sha256: server.hash, summary: {} } } })),
        ],
        listSaves: () => ok(200, { slots: [{ slot: 1, version: server.version, updated_at: 6, data_sha256: server.hash, summary: {} }, { slot: 2, empty: true }, { slot: 3, empty: true }] }),
      },
    });
    let r = await s.sync.upload(1);
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
    expect(s.info().slots[1].pending_sha256).toBe(server.hash);
    // 本機又存了不一樣的內容
    s.b.setItem(`${KEY_PREFIX}1`, serialize(makeState({ playtime_s: 999 })));
    r = await s.sync.upload(1);
    expect(r).toMatchObject({ ok: true, version: 3 });
    expect(s.api.calls.map((c) => c.name)).toEqual(['putSave', 'listSaves', 'putSave']);
    expect(s.api.calls[2].args[2]).toEqual({ version: 2 });
  });
  it('上傳中途重新整理：pending_sha256 已在本機；之後再上傳同一份 → 列表雜湊相符，不用再 PUT', async () => {
    const st = makeState();
    const h = sha(serialize(st));
    const s = setup({
      info: { ...INFO, slots: { 1: { pending_sha256: h } } }, // 第一次上傳（空槽）送出後就重新整理了
      saves: { 1: st },
      handlers: { listSaves: ok(200, { slots: [{ slot: 1, version: 4, updated_at: 8, data_sha256: h, summary: {} }] }) },
    });
    const r = await s.sync.upload(1);
    expect(r).toMatchObject({ ok: true, version: 4 });
    expect(s.api.calls.map((c) => c.name)).toEqual(['listSaves']);
    expect(s.info().slots[1]).toEqual({ version: 4, updated_at: 8 });
  });
  it('列表（雲端總覽）時雜湊等於 pending → 也順便採用版本', async () => {
    const h = 'a'.repeat(64);
    const s = setup({
      info: { ...INFO, slots: { 2: { version: 3, updated_at: 1, pending_sha256: h } } },
      handlers: { listSaves: ok(200, { slots: [{ slot: 2, version: 4, updated_at: 9, data_sha256: h, summary: {} }] }) },
    });
    await s.sync.listCloud();
    expect(s.info().slots[2]).toEqual({ version: 4, updated_at: 9 });
  });
  it('雜湊不同 → 照常是衝突', async () => {
    const s = setup({
      saves: { 1: makeState() },
      handlers: { putSave: httpErr(409, 'conflict', { body: { current: { version: 2, updated_at: 9, data_sha256: 'b'.repeat(64), summary: { name: '別台' } } } }) },
    });
    const r = await s.sync.upload(1);
    expect(r).toMatchObject({ ok: false, kind: 'conflict' });
  });
  it('force（用本機的）時 409 但雜湊相同 → 也算成功', async () => {
    const s = setup({
      saves: { 1: makeState() },
      handlers: { putSave: (slot, data) => httpErr(409, 'conflict', { body: { current: { version: 6, updated_at: 9, data_sha256: sha(data), summary: {} } } }) },
    });
    const r = await s.sync.upload(1, { force: true, cloudVersion: 5 });
    expect(r).toMatchObject({ ok: true, version: 6 });
  });
});

describe('B：上傳前必須通過 deserialize＋sanitizeLoadedState', () => {
  it('地圖不存在的本機存檔 → 不送請求，回傳原因', async () => {
    const s = setup({ saves: { 1: makeState({ location: { map: 'nowhere', x: 1, y: 1, dir: 'down' } }) } });
    const r = await s.sync.upload(1);
    expect(r).toMatchObject({ ok: false, kind: 'local_invalid' });
    expect(r.message).toContain('不能上傳');
    expect(r.message).toContain('nowhere');
    expect(s.api.calls.length).toBe(0);
  });
  it('localSummary 標成不能上傳並附原因（畫面停用上傳按鈕）', () => {
    const s = setup({ saves: { 1: makeState({ party: [{ id: 'ghost', hp: 1, sp: 1 }] }), 2: makeState() } });
    const l1 = s.sync.localSummary(1);
    expect(l1).toMatchObject({ slot: 1, empty: false, broken: true, uploadable: false });
    expect(l1.reason).toContain('主角');
    expect(s.sync.localSummary(2)).toMatchObject({ empty: false, broken: false, uploadable: true, name: '艾琳' });
  });
  it('上傳的是 sanitize 後的內容（位置不合法會先修正）', async () => {
    const s = setup({ saves: { 1: makeState({ location: { map: 'attic', x: 999, y: 999, dir: 'down' } }) }, handlers: { putSave: ok(200, { version: 1 }) } });
    await s.sync.upload(1);
    expect(JSON.parse(s.api.calls[0].args[1]).location.x).not.toBe(999);
  });
});

// ---------------------------------------------------------------------------
describe('G：本機雲端資訊驗證', () => {
  const read = (o) => readCloudInfo(memoryBackend({ [CLOUD_KEY]: JSON.stringify(o) }));
  it('權杖必須是 43 字元 base64url，否則視為未啟用', () => {
    for (const token of ['tok', 'x'.repeat(42), 'x'.repeat(44), `${'x'.repeat(42)}=`, `${'x'.repeat(41)}\n`, 'x'.repeat(10_000)]) {
      expect(read({ ...INFO, token }), token.slice(0, 50)).toBeNull();
    }
    expect(read(INFO)).not.toBeNull();
  });
  it('版本必須是 1～2³¹ 的整數，否則忘掉該格版本', () => {
    const i = read({ ...INFO, slots: { 1: { version: 0, updated_at: 1 }, 2: { version: 2 ** 31 + 1 }, 3: { version: 2 ** 31, updated_at: 2 } } });
    expect(i.slots).toEqual({ 3: { version: 2 ** 31, updated_at: 2 } });
    expect(read({ ...INFO, slots: { 1: { version: 1.5 }, 2: { version: '3' }, 3: { version: 1e20 } } }).slots).toEqual({});
  });
  it('player_id 可以沒有（恢復轉移時伺服器沒回）；pending_sha256 必須是 64 字元小寫 hex', () => {
    const i = read({ token: TOK, transfer_code: 'ABCD-EFGH', slots: { 1: { version: 2, pending_sha256: 'A'.repeat(64) }, 2: { pending_sha256: 'f'.repeat(64) } } });
    expect(i.player_id).toBeNull();
    expect(i.slots).toEqual({ 1: { version: 2, updated_at: null }, 2: { version: null, updated_at: null, pending_sha256: 'f'.repeat(64) } });
  });
});

describe('G：轉移碼正規化移除 Unicode Cf（零寬與格式字元）', () => {
  it('零寬空格、零寬連接符、BOM、軟連字號、方向控制字元都會被去掉', () => {
    expect(normalizeTransferCode('AB​CD-EF‍GH')).toBe('ABCDEFGH');
    expect(normalizeTransferCode('﻿abcd efgh⁠')).toBe('ABCDEFGH');
    expect(normalizeTransferCode('ABCD­-EFGH')).toBe('ABCDEFGH');
    expect(normalizeTransferCode('‮ABCD-EFGH‬')).toBe('ABCDEFGH');
  });
  it('其他看不見的非 Cf 字元仍然不合法', () => {
    expect(normalizeTransferCode('ABCD\u0007EFGH')).toBeNull();
  });
});

describe('G：雲端存檔尚未開放（API 位址是空字串）', () => {
  it('即使本機有雲端資訊也視為未啟用；啟用、接續、上傳都不送請求', async () => {
    const s = setup({ configured: () => false, saves: { 1: makeState() } });
    expect(s.sync.configured()).toBe(false);
    expect(s.sync.enabled()).toBe(false);
    expect(await s.sync.enable()).toMatchObject({ ok: false, kind: 'not_open', message: MSG.notOpen });
    expect(await s.sync.connect('ABCD-EFGH')).toMatchObject({ ok: false, kind: 'not_open' });
    expect(await s.sync.upload(1)).toMatchObject({ ok: false });
    await s.sync.recover();
    expect(s.api.calls.length).toBe(0);
    expect(MSG.notOpen).toBe('雲端存檔尚未開放');
  });
});

describe('修訂 3：每格存檔上限 16 KB（UTF-8 位元組）', () => {
  // 名字之外塞大量旗標，讓 serialize 後超過 16 KB（中文 1 字 3 bytes）
  const bigFlags = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`flag_${i}_長長的旗標名稱`, true]));
  it('超過 16 KB → 不送請求、說明原因；localSummary 標成不能上傳', async () => {
    const s = setup({ saves: { 1: makeState({ flags: bigFlags(600) }) } });
    expect(serialize(makeState({ flags: bigFlags(600) })).length).toBeGreaterThan(8000);
    const r = await s.sync.upload(1);
    expect(r).toMatchObject({ ok: false, kind: 'local_too_large' });
    expect(r.message).toContain('16 KB');
    expect(s.api.calls.length).toBe(0);
    expect(s.sync.localSummary(1)).toMatchObject({ broken: true, uploadable: false });
    expect(s.sync.localSummary(1).reason).toContain('16 KB');
  });
  it('剛好在上限內 → 可以上傳', async () => {
    const s = setup({ saves: { 1: makeState({ flags: bigFlags(50) }) }, handlers: { putSave: ok(200, { version: 1 }) } });
    expect((await s.sync.upload(1)).ok).toBe(true);
  });
  it('伺服器回 413 → 說明存檔太大', async () => {
    const s = setup({ saves: { 1: makeState() }, handlers: { putSave: httpErr(413, 'too_large') } });
    const r = await s.sync.upload(1);
    expect(r.message).toBe(MSG.tooLarge);
  });
});

describe('轉移回 409（新秘密碰撞）→ 換一組新秘密重送一次', () => {
  it('第一次 409、確認 401 → 用新的 new_token／new_transfer_code 重送', async () => {
    const s = setup({ handlers: { transfer: [httpErr(409, 'conflict'), ok(200, { player_id: 'p2' })], listSaves: httpErr(401, 'unauthorized') } });
    const r = await s.sync.connect('MNPQ-RSTU');
    expect(r.ok).toBe(true);
    const sent = s.api.calls.filter((c) => c.name === 'transfer').map((c) => c.args[0]);
    expect(sent.map((x) => x.new_token)).toEqual([GEN_TOKEN(1), GEN_TOKEN(2)]);
    expect(s.info().token).toBe(GEN_TOKEN(2));
  });
});
