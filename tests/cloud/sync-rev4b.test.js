// 雲端同步：API.md 修訂 4b 的客戶端行為。
// 第 3 節：401 的重新連結頁面補一句「也可以重新啟用雲端存檔」（空帳號被清理後最常見的情況）。
// 第 4 節：connect 被 429 → 伺服器確定沒處理 → 清除待確認區，不擋「啟用雲端存檔」。
// 第 5 節：回報通關遇到 429（或逾時、網路、5xx）→ 記在本機（各章只留最新一筆），下次啟動或下次通關時補送一次。
import { describe, it, expect } from 'vitest';
import {
  CLOUD_KEY, PENDING_KEY, CLEAR_QUEUE_KEY, MSG, readCloudInfo, createCloudSync,
} from '../../web/src/cloud/sync.js';
import { createStorage } from '../../web/src/core/save.js';

function memoryBackend() {
  const m = new Map();
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
const R429 = httpErr(429, 'rate_limited', { retryAfter: 600 });
const TIMEOUT = { ok: false, kind: 'timeout', status: 0, error: 'timeout', retryAfter: null, body: null };
const TOK = `tok_${'x'.repeat(39)}`;
const INFO = { player_id: 'p1', token: TOK, transfer_code: 'ABCD-EFGH' };
const NOW = 1_760_000_000_000;

function setup({ info = INFO, handlers = {} } = {}) {
  const b = memoryBackend();
  if (info) b.setItem(CLOUD_KEY, JSON.stringify(info));
  const api = fakeApi(handlers);
  let t = 0;
  const random = { token: () => `${String(++t).padStart(2, '0')}${'T'.repeat(41)}`, code: () => 'WXYZ-2345' };
  const sync = createCloudSync({ backend: b, saveStore: createStorage(b), api, now: () => NOW, random });
  return {
    b, api, sync, info: () => readCloudInfo(b),
    pending: () => JSON.parse(b.getItem(PENDING_KEY) ?? 'null'),
    queue: () => JSON.parse(b.getItem(CLEAR_QUEUE_KEY) ?? 'null')?.records ?? null,
    sent: () => api.calls.filter((c) => c.name === 'reportClear').map((c) => c.args[0]),
  };
}
const clearOk = (chapter, sec) => ok(200, { chapter, best_play_seconds: sec });

describe('修訂 4b 第 3 節：重新連結頁面的說明', () => {
  it('頁面文字＝失效訊息＋「也可以重新啟用雲端存檔」；錯誤訊息本身不變', () => {
    expect(MSG.relink).toBe('此裝置的雲端連結已失效，請重新用轉移碼接續');
    expect(MSG.relinkPage.startsWith(MSG.relink)).toBe(true);
    expect(MSG.relinkPage).toContain('也可以重新啟用雲端存檔');
  });
});

describe('修訂 4b 第 4 節：connect 被 429 → 清除待確認區', () => {
  it('429 後待確認區是空的，緊接著「啟用雲端存檔」不會被擋', async () => {
    const s = setup({ info: null, handlers: { transfer: R429, createPlayer: ok(201, { player_id: 'p9' }) } });
    const r = await s.sync.connect('ABCD-EFGJ');
    expect(r).toMatchObject({ ok: false, status: 429 });
    expect(r.message).toBe('雲端暫時無法使用，請等約 10 分鐘後再試');
    expect(s.pending()).toBeNull();
    const e = await s.sync.enable();
    expect(e.ok).toBe(true);
    expect(s.info().player_id).toBe('p9');
  });

  it('沿用舊的待確認秘密重試時遇到 429，也一併清除', async () => {
    const s = setup({ info: null, handlers: { transfer: [TIMEOUT, R429], listSaves: httpErr(401, 'unauthorized') } });
    await s.sync.connect('ABCD-EFGJ');
    expect(s.pending()?.op).toBe('transfer'); // 逾時：結果未知，保留
    await s.sync.connect('ABCD-EFGJ');
    expect(s.pending()).toBeNull();
  });
});

describe('修訂 4b 第 5 節：回報通關失敗時記在本機、之後補送一次', () => {
  it('429 → 記在本機；下次啟動（recover）補送一次，成功後清掉', async () => {
    const s = setup({ handlers: { reportClear: [R429, clearOk('chapter1', 120)] } });
    const r = await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 120, collapse: 3 });
    expect(r).toMatchObject({ ok: false, status: 429, queued: true });
    expect(s.queue()).toMatchObject({ chapter1: { chapter: 'chapter1', ending: null, play_seconds: 120, collapse: 3 } });
    await s.sync.recover();
    expect(s.sent().map((x) => x.chapter)).toEqual(['chapter1', 'chapter1']);
    expect(s.sent()[1]).toEqual({ chapter: 'chapter1', ending: null, play_seconds: 120, collapse: 3 });
    expect(s.queue()).toBeNull();
  });

  it('各章只保留最新一筆', async () => {
    const s = setup({ handlers: { reportClear: R429 } });
    await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 300 });
    await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 500 });
    await s.sync.reportClear({ chapter: 'prologue', play_seconds: 50 });
    const q = s.queue();
    expect(Object.keys(q).sort()).toEqual(['chapter1', 'prologue']);
    expect(q.chapter1.play_seconds).toBe(500);
  });

  it('下次通關回報成功後，補送其他章節的待送紀錄（各一次）', async () => {
    const s = setup({ handlers: { reportClear: [R429, clearOk('chapter2', 900), clearOk('chapter1', 300)] } });
    await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 300 });
    const r = await s.sync.reportClear({ chapter: 'chapter2', play_seconds: 900 });
    expect(r.ok).toBe(true);
    expect(s.sent().map((x) => x.chapter)).toEqual(['chapter1', 'chapter2', 'chapter1']);
    expect(s.queue()).toBeNull();
  });

  it('補送仍遇到 429 → 保留，這次不再重試（每次啟動或通關只補送一次）', async () => {
    const s = setup({ handlers: { reportClear: R429 } });
    await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 300 });
    await s.sync.recover();
    expect(s.sent()).toHaveLength(2);
    expect(s.queue().chapter1.play_seconds).toBe(300);
  });

  it('逾時也記下（伺服器即使已套用，重送同一筆也不會變差）；400 不記', async () => {
    const s = setup({ handlers: { reportClear: [TIMEOUT, httpErr(400, 'bad_request')] } });
    expect((await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 300 })).queued).toBe(true);
    const r = await s.sync.reportClear({ chapter: 'prologue', play_seconds: 10 });
    expect(r.queued).toBeUndefined();
    expect(Object.keys(s.queue())).toEqual(['chapter1']);
  });

  it('同一章新的回報成功 → 舊的待送紀錄作廢', async () => {
    const s = setup({ handlers: { reportClear: [R429, clearOk('chapter1', 200)] } });
    await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 300 });
    await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 200 });
    expect(s.sent()).toHaveLength(2);
    expect(s.queue()).toBeNull();
  });

  it('401 或停用雲端 → 待送紀錄清掉；沒有待送紀錄時 recover 不送任何請求', async () => {
    const s = setup({ handlers: { reportClear: [R429, httpErr(401, 'unauthorized')] } });
    await s.sync.reportClear({ chapter: 'chapter1', play_seconds: 300 });
    await s.sync.recover();
    expect(s.queue()).toBeNull();
    const t = setup({ handlers: { reportClear: R429 } });
    await t.sync.reportClear({ chapter: 'chapter1', play_seconds: 300 });
    t.sync.disable();
    expect(t.queue()).toBeNull();
    const u = setup();
    await u.sync.recover();
    expect(u.api.calls).toEqual([]);
  });
});
