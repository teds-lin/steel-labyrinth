// 雲端同步：API.md 修訂 4 的客戶端行為。
// 第 3 節：rotate 收到 429／5xx／逾時保留待確認的新碼，只有 400／409 才丟掉。
// 第 4 節：有未滿 PENDING_MAX_AGE_S 的 transfer 待確認時，「啟用雲端存檔」不得覆蓋它。
// 第 5 節：客戶端產生的秘密不會被伺服器的低熵檢查誤殺（10 萬組）。
// 第 7 節：通關時間上限 36000 秒。
import { describe, it, expect } from 'vitest';
import {
  CLOUD_KEY, PENDING_KEY, PENDING_MAX_AGE_S, MSG, readCloudInfo, createCloudSync,
} from '../../web/src/cloud/sync.js';
import { randomToken, randomTransferCode, isLowEntropyToken, isLowEntropyTransferCode } from '../../web/src/cloud/secrets.js';
import { isTokenFormat, normalizeTransferCode, isAcceptableToken, isAcceptableTransferCode } from '../../worker/src/codes.js';
import { createStorage } from '../../web/src/core/save.js';

function memoryBackend(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
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
const ok = (status, body) => ({ ok: true, status, body, etag: null });
const httpErr = (status, error, extra = {}) => ({ ok: false, kind: 'http', status, error, retryAfter: null, body: { error, message: 'x' }, ...extra });
const TIMEOUT = { ok: false, kind: 'timeout', status: 0, error: 'timeout', retryAfter: null, body: null };
const NETWORK = { ok: false, kind: 'network', status: 0, error: 'network', retryAfter: null, body: null };
const TOK = `tok_${'x'.repeat(39)}`;
const INFO = { player_id: 'p1', token: TOK, transfer_code: 'ABCD-EFGH' };
const GEN_TOKEN = (n) => `${String(n).padStart(2, '0')}${'T'.repeat(41)}`;
const NOW = 1_760_000_000_000;
const NOW_S = NOW / 1000;

function setup({ info = INFO, handlers = {}, pending = null } = {}) {
  const b = memoryBackend();
  if (info) b.setItem(CLOUD_KEY, JSON.stringify(info));
  if (pending) b.setItem(PENDING_KEY, JSON.stringify(pending));
  const api = fakeApi(handlers);
  let t = 0;
  const codes = ['WXYZ-2345', 'MNPQ-RSTU', 'HJKM-NPQR'];
  let c = 0;
  const random = { token: () => GEN_TOKEN(++t), code: () => codes[c++ % codes.length] };
  const sync = createCloudSync({ backend: b, saveStore: createStorage(b), api, now: () => NOW, random });
  return { b, api, sync, info: () => readCloudInfo(b), pending: () => JSON.parse(b.getItem(PENDING_KEY) ?? 'null') };
}

describe('第 3 節：rotate 失敗時是否保留待確認的新碼', () => {
  it.each([
    ['429', httpErr(429, 'rate_limited', { retryAfter: 600 })],
    ['500', httpErr(500, 'internal')],
    ['503', httpErr(503, 'http_503')],
    ['逾時', TIMEOUT],
    ['網路錯誤', NETWORK],
  ])('%s → 保留待確認的新碼；舊碼仍顯示為目前的碼；下次用同一個新碼重送', async (_, res) => {
    const s = setup({ handlers: { rotateTransfer: [res, ok(200, {})] } });
    const r = await s.sync.rotate();
    expect(r.ok).toBe(false);
    expect(s.info().pending_transfer_code).toBe('WXYZ-2345');
    expect(s.info().transfer_code).toBe('ABCD-EFGH');
    const r2 = await s.sync.rotate();
    expect(r2).toMatchObject({ ok: true, transferCode: 'WXYZ-2345' });
    expect(s.api.calls.map((c) => c.args[0])).toEqual(['WXYZ-2345', 'WXYZ-2345']);
    expect(s.info().pending_transfer_code).toBeNull();
  });

  it('429 時訊息仍顯示等待時間', async () => {
    const s = setup({ handlers: { rotateTransfer: httpErr(429, 'rate_limited', { retryAfter: 600 }) } });
    const r = await s.sync.rotate();
    expect(r.message).toBe('雲端暫時無法使用，請等約 10 分鐘後再試');
  });

  it.each([
    ['400', httpErr(400, 'bad_request')],
    ['409', httpErr(409, 'conflict')],
  ])('%s → 新碼確定沒生效，丟掉待確認的新碼', async (_, res) => {
    const s = setup({ handlers: { rotateTransfer: res } });
    const r = await s.sync.rotate();
    expect(r.ok).toBe(false);
    expect(s.info().pending_transfer_code).toBeNull();
    expect(s.info().transfer_code).toBe('ABCD-EFGH');
  });

  it('recover：待確認的新碼遇 429 → 仍保留（不會改顯示一個已經失效的舊碼而不提示）', async () => {
    const s = setup({ info: { ...INFO, pending_transfer_code: 'HJKM-NPQR' }, handlers: { rotateTransfer: httpErr(429, 'rate_limited', { retryAfter: 30 }) } });
    await s.sync.recover();
    expect(s.info().pending_transfer_code).toBe('HJKM-NPQR');
    expect(s.sync.status().pendingTransferCode).toBe('HJKM-NPQR');
  });
});

describe('第 4 節：enable() 不得覆蓋新鮮的 transfer 待確認', () => {
  const pendingTransfer = (at) => ({ op: 'transfer', code: 'MNPQ-RSTU', new_token: GEN_TOKEN(90), new_transfer_code: 'HJKM-NPQR', at });

  it('未滿 PENDING_MAX_AGE_S、確認結果是 401（請求可能還在路上）→ 不建立新玩家、不覆蓋，提示稍候', async () => {
    const p = pendingTransfer(NOW_S - 30);
    const s = setup({ info: null, pending: p, handlers: { listSaves: httpErr(401, 'unauthorized'), createPlayer: ok(201, { player_id: 'new' }) } });
    const r = await s.sync.enable();
    expect(r).toMatchObject({ ok: false, kind: 'pending_transfer', message: MSG.pendingTransfer });
    expect(MSG.pendingTransfer).toBe('上一次接續還在確認中，請稍候再試');
    expect(s.pending()).toEqual(p);
    expect(s.api.calls.map((c) => c.name)).toEqual(['listSaves']);
    expect(s.info()).toBeNull();
  });

  it('剛好在邊界內（PENDING_MAX_AGE_S 秒）也不覆蓋', async () => {
    const p = pendingTransfer(NOW_S - PENDING_MAX_AGE_S);
    const s = setup({ info: null, pending: p, handlers: { listSaves: httpErr(401, 'unauthorized') } });
    expect((await s.sync.enable()).kind).toBe('pending_transfer');
    expect(s.pending()).toEqual(p);
  });

  it('超過 PENDING_MAX_AGE_S 且確認是 401 → 視為沒生效，才建立新玩家', async () => {
    const s = setup({ info: null, pending: pendingTransfer(NOW_S - PENDING_MAX_AGE_S - 1), handlers: { listSaves: httpErr(401, 'unauthorized'), createPlayer: ok(201, { player_id: 'new' }) } });
    const r = await s.sync.enable();
    expect(r.ok).toBe(true);
    expect(s.info()).toMatchObject({ player_id: 'new', token: GEN_TOKEN(1) });
    expect(s.pending()).toBeNull();
  });

  it('新鮮的待確認其實已生效（200）→ 直接採用那個帳號', async () => {
    const s = setup({ info: null, pending: pendingTransfer(NOW_S - 5), handlers: { listSaves: ok(200, { slots: [] }) } });
    const r = await s.sync.enable();
    expect(r).toMatchObject({ ok: true, transferCode: 'HJKM-NPQR' });
    expect(s.info().token).toBe(GEN_TOKEN(90));
    expect(s.api.calls.map((c) => c.name)).toEqual(['listSaves']);
  });
});

describe('第 5 節：官方客戶端產生的秘密不會被低熵檢查誤殺', () => {
  it('10 萬組客戶端產生的權杖與轉移碼，伺服器端的檢查 0 個拒絕', () => {
    let rejected = 0;
    for (let i = 0; i < 100_000; i++) {
      const t = randomToken();
      const c = randomTransferCode();
      if (!isTokenFormat(t) || !isAcceptableToken(t)) rejected++;
      const n = normalizeTransferCode(c);
      if (!n || !isAcceptableTransferCode(n)) rejected++;
    }
    expect(rejected).toBe(0);
  });

  it('客戶端與伺服器用同一套判斷（邊界）', () => {
    expect(isLowEntropyToken('A'.repeat(43))).toBe(true);
    expect(isLowEntropyToken('ABCDEFGHIJKLMNO'.repeat(3).slice(0, 43))).toBe(true);
    expect(isLowEntropyToken('ABCDEFGHIJKLMNOP'.repeat(3).slice(0, 43))).toBe(false);
    expect(isLowEntropyTransferCode('AAAA-BCDE')).toBe(true);
    expect(isLowEntropyTransferCode('A2A3A4A5')).toBe(true);
    expect(isLowEntropyTransferCode('AAAB-CDEF')).toBe(false);
    expect(isAcceptableToken('A'.repeat(43))).toBe(false);
    expect(isAcceptableTransferCode('AAAABCDE')).toBe(false);
  });

  it('亂數來源壞掉（永遠同一個位元組）→ 丟例外，不會產生低熵秘密或卡死', () => {
    const stuck = (arr) => arr.fill(7);
    expect(() => randomToken(stuck)).toThrow();
    expect(() => randomTransferCode(stuck)).toThrow();
  });
});

describe('第 7 節：通關時間上限 36000 秒', () => {
  it('超過 36000 秒的遊戲時間以 36000 回報（伺服器會拒絕更大的值）', async () => {
    const s = setup({ handlers: { reportClear: ok(200, { chapter: 'chapter1', best_play_seconds: 36000 }) } });
    await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 50000, collapse: 3 });
    expect(s.api.calls[0].args[0].play_seconds).toBe(36000);
  });
});
