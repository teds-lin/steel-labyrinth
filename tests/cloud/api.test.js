// 雲端 API 包裝（web/src/cloud/api.js）：用假的 fetch 驗證每個端點的請求格式與回傳整理。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCloudApi } from '../../web/src/cloud/api.js';

const BASE = 'https://api.example.test';

/** 假 fetch：依序回傳 responders 的結果，並記錄每次呼叫。 */
function fakeFetch(...responders) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, headers: new Headers(init.headers ?? {}), body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = responders.length > 1 ? responders.shift() : responders[0];
    return typeof r === 'function' ? r(url, init) : r;
  };
  fn.calls = calls;
  return fn;
}
const json = (status, body, headers = {}) => () => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
});

const make = (fetch, opts = {}) => createCloudApi({ baseUrl: BASE, fetch, getToken: () => 'tok123', ...opts });

afterEach(() => { vi.useRealTimers(); });

describe('createCloudApi：請求格式', () => {
  it('POST /api/player：body 帶客戶端產生的 token 與 transfer_code、不帶 Authorization、JSON 標頭（修訂 2 A）', async () => {
    const f = fakeFetch(json(201, { player_id: 'p1' }));
    const r = await make(f).createPlayer({ token: 'T'.repeat(43), transfer_code: 'ABCD-EFGH' });
    expect(r).toEqual({ ok: true, status: 201, body: { player_id: 'p1' }, etag: null });
    const c = f.calls[0];
    expect(c.url).toBe(`${BASE}/api/player`);
    expect(c.init.method).toBe('POST');
    expect(c.body).toEqual({ token: 'T'.repeat(43), transfer_code: 'ABCD-EFGH' });
    expect(c.headers.get('content-type')).toMatch(/^application\/json/);
    expect(c.headers.get('authorization')).toBeNull();
  });

  it('所有 POST／PUT 都帶 Content-Type: application/json（修訂 2 C：否則 415）', async () => {
    const f = fakeFetch(json(200, {}));
    const api = make(f);
    await api.createPlayer({ token: 'T'.repeat(43), transfer_code: 'ABCD-EFGH' });
    await api.transfer({ code: 'ABCD-EFGH', new_token: 'N'.repeat(43), new_transfer_code: 'WXYZ-2345' });
    await api.rotateTransfer('WXYZ-2345');
    await api.reportClear({ chapter: 'prologue', ending: null, play_seconds: 1, collapse: 0 });
    await api.putSave(1, 'D', { version: 2 });
    await api.putSave(2, 'D');
    const writes = f.calls.filter((c) => c.init.method === 'POST' || c.init.method === 'PUT');
    expect(writes.length).toBe(6);
    for (const c of writes) {
      expect(c.headers.get('content-type'), `${c.init.method} ${c.url}`).toBe('application/json; charset=utf-8');
      expect(typeof c.init.body, `${c.init.method} ${c.url}`).toBe('string');
    }
  });

  it('listSaves 可以指定權杖（轉移／建立逾時後用新權杖確認，修訂 2 A）', async () => {
    const f = fakeFetch(json(200, { slots: [] }));
    await make(f).listSaves({ token: 'N'.repeat(43) });
    expect(f.calls[0].headers.get('authorization')).toBe(`Bearer ${'N'.repeat(43)}`);
  });

  it('基底網址結尾的斜線會被去掉', async () => {
    const f = fakeFetch(json(200, { slots: [] }));
    await createCloudApi({ baseUrl: `${BASE}///`, fetch: f, getToken: () => 't' }).listSaves();
    expect(f.calls[0].url).toBe(`${BASE}/api/saves`);
  });

  it('GET /api/saves 帶 Authorization: Bearer', async () => {
    const f = fakeFetch(json(200, { slots: [] }));
    const r = await make(f).listSaves();
    expect(r.ok).toBe(true);
    expect(f.calls[0].init.method).toBe('GET');
    expect(f.calls[0].headers.get('authorization')).toBe('Bearer tok123');
    expect(f.calls[0].init.body).toBeUndefined();
  });

  it('GET /api/save/:slot 回傳 etag', async () => {
    const f = fakeFetch(json(200, { slot: 2, version: 3, updated_at: 1, data: '{}' }, { ETag: '"3"' }));
    const r = await make(f).getSave(2);
    expect(f.calls[0].url).toBe(`${BASE}/api/save/2`);
    expect(r.etag).toBe('"3"');
    expect(r.body.version).toBe(3);
  });

  it('PUT /api/save/:slot：有版本帶 If-Match，沒有版本帶 If-None-Match: *', async () => {
    const f = fakeFetch(json(200, { slot: 1, version: 4, updated_at: 9 }, { ETag: '"4"' }));
    const api = make(f);
    await api.putSave(1, 'DATA', { version: 3 });
    await api.putSave(1, 'DATA', { version: null });
    await api.putSave(1, 'DATA');
    expect(f.calls[0].init.method).toBe('PUT');
    expect(f.calls[0].body).toEqual({ data: 'DATA' });
    expect(f.calls[0].headers.get('if-match')).toBe('"3"');
    expect(f.calls[0].headers.get('if-none-match')).toBeNull();
    expect(f.calls[1].headers.get('if-match')).toBeNull();
    expect(f.calls[1].headers.get('if-none-match')).toBe('*');
    expect(f.calls[2].headers.get('if-none-match')).toBe('*');
    expect(f.calls[0].headers.get('authorization')).toBe('Bearer tok123');
  });

  it('DELETE /api/save/:slot 帶 If-Match；204 的 body 為 null', async () => {
    const f = fakeFetch(json(204, null));
    const r = await make(f).deleteSave(3, 7);
    expect(r).toEqual({ ok: true, status: 204, body: null, etag: null });
    expect(f.calls[0].init.method).toBe('DELETE');
    expect(f.calls[0].headers.get('if-match')).toBe('"7"');
  });

  it('POST /api/transfer 不帶權杖；rotate、clear 帶權杖；stats 不帶', async () => {
    const f = fakeFetch(json(200, {}));
    const api = make(f);
    await api.transfer({ code: 'ABCD-EFGH', new_token: 'N'.repeat(43), new_transfer_code: 'WXYZ-2345' });
    await api.rotateTransfer('MNPQ-RSTU');
    await api.reportClear({ chapter: 'prologue', ending: null, play_seconds: 10, collapse: 0 });
    await api.stats();
    expect(f.calls.map((c) => [c.init.method, c.url.slice(BASE.length), c.headers.get('authorization')])).toEqual([
      ['POST', '/api/transfer', null],
      ['POST', '/api/transfer/rotate', 'Bearer tok123'],
      ['POST', '/api/clear', 'Bearer tok123'],
      ['GET', '/api/stats', null],
    ]);
    expect(f.calls[0].body).toEqual({ code: 'ABCD-EFGH', new_token: 'N'.repeat(43), new_transfer_code: 'WXYZ-2345' });
    expect(f.calls[1].body).toEqual({ new_transfer_code: 'MNPQ-RSTU' });
    expect(f.calls[2].body).toEqual({ chapter: 'prologue', ending: null, play_seconds: 10, collapse: 0 });
  });

  it('沒有權杖時不送 Authorization（交給伺服器回 401）', async () => {
    const f = fakeFetch(json(401, { error: 'unauthorized', message: 'x' }));
    const r = await createCloudApi({ baseUrl: BASE, fetch: f, getToken: () => null }).listSaves();
    expect(f.calls[0].headers.get('authorization')).toBeNull();
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 401, error: 'unauthorized' });
  });

  it('不合法的 slot 不送出請求', async () => {
    const f = fakeFetch(json(200, {}));
    const api = make(f);
    for (const s of [0, 4, '1', 1.5, null]) {
      const r = await api.getSave(s);
      expect(r).toMatchObject({ ok: false, kind: 'http', status: 0, error: 'invalid_slot' });
    }
    expect(f.calls.length).toBe(0);
  });
});

describe('createCloudApi：錯誤整理', () => {
  it('HTTP 錯誤：kind http、error 取自 body、附上 body（409 的 current）', async () => {
    const current = { version: 5, updated_at: 100, summary: { name: '艾琳' } };
    const f = fakeFetch(json(409, { error: 'conflict', message: '版本不符', current }));
    const r = await make(f).putSave(1, 'X', { version: 4 });
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 409, error: 'conflict', retryAfter: null });
    expect(r.body.current).toEqual(current);
  });

  it('429：retryAfter 取自 Retry-After 標頭（秒）', async () => {
    const f = fakeFetch(json(429, { error: 'rate_limited', message: '太頻繁' }, { 'Retry-After': '42' }));
    const r = await make(f).createPlayer();
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 429, error: 'rate_limited', retryAfter: 42 });
  });

  it('Retry-After 是 HTTP 日期時換算成秒數；壞掉的值為 null', async () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    let r = await make(fakeFetch(json(429, { error: 'rate_limited' }, { 'Retry-After': future }))).createPlayer();
    expect(r.retryAfter).toBeGreaterThanOrEqual(28);
    expect(r.retryAfter).toBeLessThanOrEqual(31);
    r = await make(fakeFetch(json(429, { error: 'rate_limited' }, { 'Retry-After': 'soon' }))).createPlayer();
    expect(r.retryAfter).toBeNull();
  });

  it('5xx 且 body 不是 JSON：kind http、error 為 http_<status>', async () => {
    const f = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const r = await make(f).listSaves();
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 502, error: 'http_502' });
  });

  it('2xx 但 body 不是 JSON：ok 但 body 為 null', async () => {
    const f = fakeFetch(() => new Response('not json', { status: 200 }));
    const r = await make(f).listSaves();
    expect(r).toEqual({ ok: true, status: 200, body: null, etag: null });
  });

  it('fetch 丟錯（離線、CORS 被擋）：kind network，不丟例外', async () => {
    const f = async () => { throw new TypeError('Failed to fetch'); };
    const r = await make(f).listSaves();
    expect(r).toMatchObject({ ok: false, kind: 'network', status: 0, error: 'network' });
  });

  it('fetch 不是函式、getToken 丟錯、body 讀取失敗都不丟例外', async () => {
    let r = await createCloudApi({ baseUrl: BASE, fetch: null }).listSaves();
    expect(r).toMatchObject({ ok: false, kind: 'network' });
    const f = fakeFetch(json(200, { slots: [] }));
    r = await createCloudApi({ baseUrl: BASE, fetch: f, getToken: () => { throw new Error('boom'); } }).listSaves();
    expect(r.ok).toBe(true);
    expect(f.calls[0].headers.get('authorization')).toBeNull();
    const broken = async () => ({ status: 200, headers: new Headers(), text: async () => { throw new Error('stream'); } });
    r = await make(broken).listSaves();
    expect(r).toMatchObject({ ok: false, kind: 'network' });
  });

  it('逾時：會 abort 請求並回 kind timeout', async () => {
    let signal = null;
    const f = (url, init) => new Promise((_, rej) => {
      signal = init.signal;
      init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });
    const r = await make(f, { timeoutMs: 30 }).listSaves();
    expect(r).toMatchObject({ ok: false, kind: 'timeout', status: 0, error: 'timeout' });
    expect(signal.aborted).toBe(true);
  });

  it('逾時：fetch 不理會 signal 也一樣準時回 timeout', async () => {
    const f = () => new Promise(() => {}); // 永遠不回應
    const t0 = Date.now();
    const r = await make(f, { timeoutMs: 40 }).getSave(1);
    expect(r.kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('預設逾時為 5 秒', async () => {
    vi.useFakeTimers();
    const f = () => new Promise(() => {});
    const p = make(f).listSaves();
    let done = null;
    p.then((r) => { done = r; });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(done).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toMatchObject({ kind: 'timeout' });
  });

  it('body 讀取（回應很慢）也算在逾時內', async () => {
    const f = async () => ({ status: 200, headers: new Headers(), text: () => new Promise(() => {}) });
    const r = await make(f, { timeoutMs: 30 }).listSaves();
    expect(r.kind).toBe('timeout');
  });
});
