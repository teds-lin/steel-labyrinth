// M4 客戶端：夢境 API 包裝、通行證（只存記憶體）、自由交談的輸入／歷史／結果整理、Turnstile 載入與設定、
// 建立玩家需要 Turnstile（冪等重送不需要）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCloudApi, DREAM_CHAT_TIMEOUT_MS } from '../../web/src/cloud/api.js';
import {
  MAX_INPUT_CHARS, MAX_HISTORY, MAX_HISTORY_CHARS, cleanChatInput, charCount, clampInput, buildHistory,
  scriptedKindFor, interpretChat, createDreamClient, DREAM_MSG,
} from '../../web/src/cloud/dream.js';
import {
  TURNSTILE_TEST_SITEKEY, TURNSTILE_SCRIPT_URL, resolveSitekey,
} from '../../web/src/cloud/turnstile-config.js';
import { createTurnstileLoader, runTurnstile, TURNSTILE_MSG } from '../../web/src/cloud/turnstile.js';
import { CLOUD_KEY, PENDING_KEY, createCloudSync, readCloudInfo } from '../../web/src/cloud/sync.js';
import { createStorage } from '../../web/src/core/save.js';

const BASE = 'https://api.example.test';
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
const json = (status, body, headers = {}) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const make = (fetch, opts = {}) => createCloudApi({ baseUrl: BASE, fetch, getToken: () => 'tok123', ...opts });
const ok = (status, body) => ({ ok: true, status, body, etag: null });
const httpErr = (status, error, extra = {}) => ({ ok: false, kind: 'http', status, error, retryAfter: null, body: { error, message: 'x' }, ...extra });
const NET = { ok: false, kind: 'network', status: 0, error: 'network', retryAfter: null, body: null };
const TIMEOUT = { ok: false, kind: 'timeout', status: 0, error: 'timeout', retryAfter: null, body: null };

afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
describe('API：夢境端點與建立玩家的 turnstile_token', () => {
  it('createPlayer 有 turnstile_token 時放進 body；沒有時 body 不變（相容 M3）', async () => {
    const f = fakeFetch(json(201, { player_id: 'p1' }));
    const api = make(f);
    await api.createPlayer({ token: 'T'.repeat(43), transfer_code: 'ABCD-EFGH', turnstile_token: 'ts1' });
    await api.createPlayer({ token: 'T'.repeat(43), transfer_code: 'ABCD-EFGH' });
    expect(f.calls[0].body).toEqual({ token: 'T'.repeat(43), transfer_code: 'ABCD-EFGH', turnstile_token: 'ts1' });
    expect(f.calls[1].body).toEqual({ token: 'T'.repeat(43), transfer_code: 'ABCD-EFGH' });
  });
  it('dreamPass：POST /api/dream/pass，帶權杖與 turnstile_token', async () => {
    const f = fakeFetch(json(200, { pass: 'P.S', expires_at: 100 }));
    const r = await make(f).dreamPass('ts-token');
    expect(r).toMatchObject({ ok: true, body: { pass: 'P.S', expires_at: 100 } });
    expect(f.calls[0].url).toBe(`${BASE}/api/dream/pass`);
    expect(f.calls[0].init.method).toBe('POST');
    expect(f.calls[0].headers.get('authorization')).toBe('Bearer tok123');
    expect(f.calls[0].body).toEqual({ turnstile_token: 'ts-token' });
  });
  it('dreamChat：POST /api/dream/chat，body 照 API.md', async () => {
    const f = fakeFetch(json(200, { reply: '嗯。', source: 'ai', reason: null, remaining_today: 3 }));
    const body = { pass: 'P.S', guest: 'three', chapter: 'chapter3', history: [{ role: 'player', text: '你好' }], input: '你是誰？' };
    const r = await make(f).dreamChat(body);
    expect(r.ok).toBe(true);
    expect(f.calls[0].url).toBe(`${BASE}/api/dream/chat`);
    expect(f.calls[0].body).toEqual(body);
    expect(f.calls[0].headers.get('authorization')).toBe('Bearer tok123');
  });
  it('dreamChat 的逾時比一般請求長（AI 回覆需要時間），逾時回 kind timeout', async () => {
    expect(DREAM_CHAT_TIMEOUT_MS).toBeGreaterThan(5000);
    vi.useFakeTimers();
    const f = fakeFetch(() => new Promise(() => {}));
    const p = make(f).dreamChat({ pass: 'p', guest: 'g', chapter: 'c', history: [], input: 'x' });
    await vi.advanceTimersByTimeAsync(6000);
    let done = false;
    p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(DREAM_CHAT_TIMEOUT_MS);
    expect(await p).toMatchObject({ ok: false, kind: 'timeout' });
  });
});

// ---------------------------------------------------------------------------
describe('自由交談：輸入、歷史、預寫台詞種類', () => {
  it('cleanChatInput：去頭尾空白、移除控制與 Cf 字元', () => {
    expect(cleanChatInput('  你好​\u0007嗎 \n')).toBe('你好嗎');
    expect(cleanChatInput('a‮b')).toBe('ab');
    expect(cleanChatInput(null)).toBe('');
  });
  it('charCount 以字元（code point）計；clampInput 截到 120 字', () => {
    expect(MAX_INPUT_CHARS).toBe(120);
    expect(charCount('𠮷野家')).toBe(3);
    const long = '鐘'.repeat(130);
    expect(charCount(clampInput(long))).toBe(120);
    expect(clampInput('𠮷'.repeat(121))).toBe('𠮷'.repeat(120));
    expect(clampInput('短')).toBe('短');
  });
  it('buildHistory：只送玩家與 AI 回覆、最近 6 則、每則 ≤ 150 字', () => {
    expect(MAX_HISTORY).toBe(6);
    expect(MAX_HISTORY_CHARS).toBe(150);
    const log = [
      { role: 'guest', text: '開場白', source: 'greeting' },
      ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'guest' : 'player', text: `第${i}句`, source: i % 2 ? 'ai' : undefined })),
      { role: 'guest', text: '霧太濃了。', source: 'scripted' },
      { role: 'system', text: '說明' },
    ];
    const h = buildHistory(log);
    expect(h).toEqual(['第2句', '第3句', '第4句', '第5句', '第6句', '第7句'].map((t, i) => ({ role: i % 2 ? 'guest' : 'player', text: t })));
    expect(buildHistory([{ role: 'player', text: '長'.repeat(200) }])[0].text.length).toBe(150);
    expect(buildHistory(null)).toEqual([]);
  });
  it('scriptedKindFor：quota／budget → quota、filtered → filtered、其他 → fallback', () => {
    expect(scriptedKindFor('quota')).toBe('quota');
    expect(scriptedKindFor('budget')).toBe('quota');
    expect(scriptedKindFor('filtered')).toBe('filtered');
    expect(scriptedKindFor('ai_error')).toBe('fallback');
    expect(scriptedKindFor(null)).toBe('fallback');
  });
});

describe('interpretChat：伺服器結果 → 畫面要做的事', () => {
  it('200 ai／scripted → reply（含剩餘句數）', () => {
    expect(interpretChat(ok(200, { reply: '嗯。', source: 'ai', reason: null, remaining_today: 17 })))
      .toEqual({ type: 'reply', text: '嗯。', source: 'ai', reason: null, remaining: 17 });
    expect(interpretChat(ok(200, { reply: '先到這裡。', source: 'scripted', reason: 'quota', remaining_today: 0 })))
      .toEqual({ type: 'reply', text: '先到這裡。', source: 'scripted', reason: 'quota', remaining: 0 });
  });
  it('200 但格式不對 → fallback', () => {
    for (const body of [null, {}, { reply: '', source: 'ai' }, { reply: 'x', source: 'other' }, { reply: 3, source: 'ai' }]) {
      expect(interpretChat(ok(200, body))).toMatchObject({ type: 'fallback', kind: 'fallback' });
    }
    expect(interpretChat(ok(200, { reply: 'x', source: 'ai', remaining_today: -1 })).remaining).toBe(null);
  });
  it('401 pass_invalid → 重新驗證；其他 401 → unauthorized', () => {
    expect(interpretChat(httpErr(401, 'pass_invalid'))).toEqual({ type: 'pass_invalid' });
    expect(interpretChat(httpErr(401, 'unauthorized'))).toEqual({ type: 'unauthorized' });
  });
  it('網路錯誤、逾時、429、5xx、400 → fallback 預寫台詞', () => {
    for (const r of [NET, TIMEOUT, httpErr(429, 'rate_limited'), httpErr(500, 'internal'), httpErr(503, 'x'), httpErr(400, 'bad_request')]) {
      expect(interpretChat(r)).toMatchObject({ type: 'fallback', kind: 'fallback' });
    }
  });
});

// ---------------------------------------------------------------------------
describe('createDreamClient：通行證只在記憶體', () => {
  const fakeApi = (handlers) => {
    const calls = [];
    const api = {};
    for (const name of ['dreamPass', 'dreamChat']) {
      api[name] = async (arg) => {
        calls.push({ name, arg });
        const h = handlers[name];
        const pick = Array.isArray(h) ? (h.length > 1 ? h.shift() : h[0]) : h;
        return typeof pick === 'function' ? pick(arg) : pick;
      };
    }
    api.calls = calls;
    return api;
  };
  const NOW = 1_760_000_000_000;

  it('沒有通行證 → hasPass false；取得後 true；快過期（剩不到 60 秒）視為沒有', async () => {
    let now = NOW;
    const api = fakeApi({ dreamPass: ok(200, { pass: 'P1', expires_at: NOW / 1000 + 1800 }) });
    const c = createDreamClient({ api, now: () => now });
    expect(c.hasPass()).toBe(false);
    expect(await c.obtainPass('ts')).toEqual({ ok: true });
    expect(api.calls[0]).toEqual({ name: 'dreamPass', arg: 'ts' });
    expect(c.hasPass()).toBe(true);
    now = NOW + (1800 - 59) * 1000;
    expect(c.hasPass()).toBe(false);
  });
  it('通行證格式不對 → 失敗；403 turnstile_failed → 人機驗證失敗；429 → 等待時間；401 → unauthorized', async () => {
    let c = createDreamClient({ api: fakeApi({ dreamPass: ok(200, { pass: '', expires_at: 1 }) }), now: () => NOW });
    expect(await c.obtainPass('ts')).toMatchObject({ ok: false, kind: 'unavailable' });
    c = createDreamClient({ api: fakeApi({ dreamPass: httpErr(403, 'turnstile_failed') }), now: () => NOW });
    expect(await c.obtainPass('ts')).toEqual({ ok: false, kind: 'turnstile_failed', message: DREAM_MSG.turnstileFailed });
    c = createDreamClient({ api: fakeApi({ dreamPass: httpErr(429, 'rate_limited', { retryAfter: 600 }) }), now: () => NOW });
    expect(await c.obtainPass('ts')).toMatchObject({ ok: false, kind: 'rate_limited', message: expect.stringContaining('約 10 分鐘') });
    c = createDreamClient({ api: fakeApi({ dreamPass: httpErr(401, 'unauthorized') }), now: () => NOW });
    expect(await c.obtainPass('ts')).toMatchObject({ ok: false, kind: 'unauthorized' });
    c = createDreamClient({ api: fakeApi({ dreamPass: NET }), now: () => NOW });
    expect(await c.obtainPass('ts')).toMatchObject({ ok: false, kind: 'unavailable', message: DREAM_MSG.unavailable });
    expect(c.hasPass()).toBe(false);
  });
  it('chat 帶通行證；剩餘句數記在 remaining；pass_invalid 時丟掉通行證', async () => {
    const api = fakeApi({
      dreamPass: ok(200, { pass: 'P1', expires_at: NOW / 1000 + 1800 }),
      dreamChat: [ok(200, { reply: '嗯。', source: 'ai', reason: null, remaining_today: 5 }), httpErr(401, 'pass_invalid')],
    });
    const c = createDreamClient({ api, now: () => NOW });
    expect(c.remaining()).toBe(null);
    await c.obtainPass('ts');
    const r = await c.chat({ guest: 'three', chapter: 'chapter3', history: [], input: '你好' });
    expect(r).toMatchObject({ type: 'reply', remaining: 5 });
    expect(api.calls[1].arg).toEqual({ pass: 'P1', guest: 'three', chapter: 'chapter3', history: [], input: '你好' });
    expect(c.remaining()).toBe(5);
    expect(await c.chat({ guest: 'three', chapter: 'chapter3', history: [], input: '再一句' })).toEqual({ type: 'pass_invalid' });
    expect(c.hasPass()).toBe(false);
  });
  it('obtainPass：回應的 remaining_today 立即記進 remaining（不用等第一句）；缺少或不合法時保持原值', async () => {
    let c = createDreamClient({ api: fakeApi({ dreamPass: ok(200, { pass: 'P1', expires_at: NOW / 1000 + 1800, remaining_today: 20 }) }), now: () => NOW });
    expect(c.remaining()).toBe(null);
    expect(await c.obtainPass('ts')).toEqual({ ok: true });
    expect(c.remaining()).toBe(20);
    c = createDreamClient({ api: fakeApi({ dreamPass: ok(200, { pass: 'P1', expires_at: NOW / 1000 + 1800, remaining_today: 0 }) }), now: () => NOW });
    await c.obtainPass('ts');
    expect(c.remaining()).toBe(0);
    for (const bad of [undefined, -1, 1.5, '3', null]) {
      c = createDreamClient({ api: fakeApi({ dreamPass: ok(200, { pass: 'P1', expires_at: NOW / 1000 + 1800, remaining_today: bad }) }), now: () => NOW });
      expect(await c.obtainPass('ts')).toEqual({ ok: true }); // 舊版伺服器沒有這個欄位：照樣取得通行證
      expect(c.remaining()).toBe(null);
    }
    // 先聊過（remaining 5）再重新取得通行證：以通行證回應的最新值為準
    const api = fakeApi({
      dreamPass: [ok(200, { pass: 'P1', expires_at: NOW / 1000 + 1800, remaining_today: 6 }), ok(200, { pass: 'P2', expires_at: NOW / 1000 + 1800, remaining_today: 4 })],
      dreamChat: [ok(200, { reply: '嗯。', source: 'ai', reason: null, remaining_today: 5 })],
    });
    c = createDreamClient({ api, now: () => NOW });
    await c.obtainPass('ts');
    expect(c.remaining()).toBe(6);
    await c.chat({ guest: 'three', chapter: 'chapter3', history: [], input: '你好' });
    expect(c.remaining()).toBe(5);
    await c.obtainPass('ts');
    expect(c.remaining()).toBe(4);
  });
  it('沒有通行證就 chat → pass_invalid（不送請求）', async () => {
    const api = fakeApi({});
    const c = createDreamClient({ api, now: () => NOW });
    expect(await c.chat({ guest: 'g', chapter: 'c', history: [], input: 'x' })).toEqual({ type: 'pass_invalid' });
    expect(api.calls).toEqual([]);
  });
  it('通行證不寫進任何儲存空間（模組不碰 localStorage）', async () => {
    const spy = vi.fn();
    globalThis.localStorage = { setItem: spy, getItem: spy, removeItem: spy };
    try {
      const c = createDreamClient({ api: fakeApi({ dreamPass: ok(200, { pass: 'P1', expires_at: NOW / 1000 + 1800 }) }), now: () => NOW });
      await c.obtainPass('ts');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete globalThis.localStorage;
    }
  });
});

// ---------------------------------------------------------------------------
describe('Turnstile 設定與載入', () => {
  it('本機頁面用官方測試 sitekey；正式頁面用正式值（尚未填時為空字串）', () => {
    expect(TURNSTILE_TEST_SITEKEY).toBe('1x00000000000000000000AA');
    expect(TURNSTILE_SCRIPT_URL).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    expect(resolveSitekey('localhost', 'PROD')).toBe(TURNSTILE_TEST_SITEKEY);
    expect(resolveSitekey('127.0.0.1', '')).toBe(TURNSTILE_TEST_SITEKEY);
    expect(resolveSitekey('teds-lin.github.io', 'PROD')).toBe('PROD');
    expect(resolveSitekey('teds-lin.github.io', '')).toBe('');
  });

  /** 假的 window／document：appendChild 時依 mode 觸發 load 或 error。 */
  function fakeEnv(mode = 'load', api = null) {
    const win = {};
    const scripts = [];
    const doc = {
      createElement: () => ({ set src(v) { this._src = v; }, get src() { return this._src; } }),
      head: {
        appendChild: (el) => {
          scripts.push(el);
          queueMicrotask(() => {
            if (mode === 'load') { win.turnstile = api ?? { render: () => 'w1', remove: () => {} }; el.onload?.(); } else el.onerror?.();
          });
        },
      },
    };
    return { win, doc, scripts };
  }
  it('載入腳本一次（explicit render）；之後重用', async () => {
    const env = fakeEnv('load');
    const loader = createTurnstileLoader({ win: env.win, doc: env.doc });
    const a = await loader.load();
    const b = await loader.load();
    expect(a).toBe(b);
    expect(env.scripts.length).toBe(1);
    expect(env.scripts[0].src).toBe(TURNSTILE_SCRIPT_URL);
    expect(env.scripts[0].async).toBe(true);
  });
  it('window.turnstile 已存在時不載入腳本', async () => {
    const env = fakeEnv('load');
    env.win.turnstile = { render: () => 'x' };
    const loader = createTurnstileLoader({ win: env.win, doc: env.doc });
    expect(await loader.load()).toBe(env.win.turnstile);
    expect(env.scripts.length).toBe(0);
  });
  it('載入失敗 → reject；下次可以重試', async () => {
    const env = fakeEnv('error');
    const loader = createTurnstileLoader({ win: env.win, doc: env.doc });
    await expect(loader.load()).rejects.toThrow();
    await expect(loader.load()).rejects.toThrow();
    expect(env.scripts.length).toBe(2);
  });

  it('runTurnstile：render 帶 sitekey／action；callback → token', async () => {
    let opts = null;
    const ts = { render: (el, o) => { opts = o; setTimeout(() => o.callback('TOKEN'), 0); return 'w1' }, remove: vi.fn() };
    const loader = { load: async () => ts };
    const h = runTurnstile({ loader, container: {}, sitekey: 'KEY', action: 'dream_pass' });
    expect(await h.promise).toEqual({ ok: true, token: 'TOKEN' });
    expect(opts).toMatchObject({ sitekey: 'KEY', action: 'dream_pass' });
  });
  it('runTurnstile：error-callback → failed；載入失敗 → load_failed；沒有 sitekey → no_sitekey；cancel → cancelled', async () => {
    const ts = { render: (el, o) => { setTimeout(() => o['error-callback']('300030'), 0); return 'w1'; }, remove: vi.fn() };
    let r = await runTurnstile({ loader: { load: async () => ts }, container: {}, sitekey: 'K', action: 'a' }).promise;
    expect(r).toEqual({ ok: false, kind: 'failed', message: TURNSTILE_MSG.failed });
    r = await runTurnstile({ loader: { load: async () => { throw new Error('x'); } }, container: {}, sitekey: 'K', action: 'a' }).promise;
    expect(r).toEqual({ ok: false, kind: 'load_failed', message: TURNSTILE_MSG.loadFailed });
    r = await runTurnstile({ loader: { load: async () => ts }, container: {}, sitekey: '', action: 'a' }).promise;
    expect(r).toEqual({ ok: false, kind: 'no_sitekey', message: TURNSTILE_MSG.noSitekey });
    const hang = { render: () => 'w2', remove: vi.fn() };
    const h = runTurnstile({ loader: { load: async () => hang }, container: {}, sitekey: 'K', action: 'a' });
    await new Promise((res) => setTimeout(res, 0));
    h.cancel();
    expect(await h.promise).toEqual({ ok: false, kind: 'cancelled', message: null });
    expect(hang.remove).toHaveBeenCalledWith('w2');
  });
});

// ---------------------------------------------------------------------------
describe('啟用雲端：建立玩家需要 Turnstile（冪等重送不需要）', () => {
  function memoryBackend() {
    const m = new Map();
    return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  }
  const GEN = (n) => `${String(n).padStart(2, '0')}${'T'.repeat(41)}`;
  function setup(createPlayer) {
    const b = memoryBackend();
    const calls = [];
    let t = 0;
    const codes = ['WXYZ-2345', 'MNPQ-RSTU', 'HJKM-NPQR'];
    const api = {
      createPlayer: async (arg) => { calls.push(arg); return Array.isArray(createPlayer) ? (createPlayer.length > 1 ? createPlayer.shift() : createPlayer[0]) : createPlayer; },
      listSaves: async () => httpErr(401, 'unauthorized'),
    };
    const sync = createCloudSync({ backend: b, saveStore: createStorage(b), api, now: () => 1_760_000_000_000, random: { token: () => GEN(++t), code: () => codes[(t - 1) % 3] } });
    return { b, calls, sync, pending: () => JSON.parse(b.getItem(PENDING_KEY) ?? 'null') };
  }
  it('沒有待確認的建立 → 需要 Turnstile；有 → 不需要', async () => {
    const s = setup(TIMEOUT);
    expect(s.sync.enableNeedsTurnstile()).toBe(true);
    await s.sync.enable({ turnstileToken: 'ts1' });
    expect(s.pending()).toMatchObject({ op: 'enable' });
    expect(s.sync.enableNeedsTurnstile()).toBe(false);
  });
  it('turnstile_token 隨 createPlayer 送出；逾時後重送同一組秘密、不帶 Turnstile', async () => {
    const s = setup([TIMEOUT, ok(200, { player_id: 'p9' })]);
    expect((await s.sync.enable({ turnstileToken: 'ts1' })).ok).toBe(false);
    expect((await s.sync.enable()).ok).toBe(true);
    expect(s.calls).toEqual([
      { token: GEN(1), transfer_code: 'WXYZ-2345', turnstile_token: 'ts1' },
      { token: GEN(1), transfer_code: 'WXYZ-2345' },
    ]);
    expect(readCloudInfo(s.b)).toMatchObject({ player_id: 'p9' });
  });
  it('403 turnstile_failed → needTurnstile、保留待確認的秘密（下次用新的 Turnstile 重送同一組）', async () => {
    const s = setup([httpErr(403, 'turnstile_failed'), ok(201, { player_id: 'p9' })]);
    const r = await s.sync.enable({ turnstileToken: 'ts1' });
    expect(r).toMatchObject({ ok: false, kind: 'turnstile_failed', needTurnstile: true, message: '人機驗證失敗，請再試一次' });
    expect(s.pending()).toMatchObject({ op: 'enable', token: GEN(1) });
    expect((await s.sync.enable({ turnstileToken: 'ts2' })).ok).toBe(true);
    expect(s.calls[1]).toEqual({ token: GEN(1), transfer_code: 'WXYZ-2345', turnstile_token: 'ts2' });
  });
  it('重送沒帶 Turnstile 但伺服器要求（400／403）→ needTurnstile', async () => {
    const s = setup([TIMEOUT, httpErr(403, 'turnstile_failed')]);
    await s.sync.enable({ turnstileToken: 'ts1' });
    const r = await s.sync.enable();
    expect(r).toMatchObject({ ok: false, needTurnstile: true });
    expect(s.pending()).toMatchObject({ op: 'enable', token: GEN(1) });
  });
  it('用過 Turnstile 後 409（碰撞）→ 丟掉待確認的秘密、要求重新驗證（Turnstile token 只能用一次）', async () => {
    const s = setup([httpErr(409, 'conflict'), ok(201, { player_id: 'p9' })]);
    const r = await s.sync.enable({ turnstileToken: 'ts1' });
    expect(r).toMatchObject({ ok: false, needTurnstile: true });
    expect(s.pending()).toBeNull();
    expect(s.calls.length).toBe(1);
    expect(s.sync.enableNeedsTurnstile()).toBe(true);
  });
  it('invalidate：清掉本機雲端資訊（夢境 API 回 401 unauthorized 時用）', () => {
    const s = setup(TIMEOUT);
    s.b.setItem(CLOUD_KEY, JSON.stringify({ player_id: 'p1', token: 'x'.repeat(43), transfer_code: 'ABCD-EFGH' }));
    expect(s.sync.enabled()).toBe(true);
    s.sync.invalidate();
    expect(s.sync.enabled()).toBe(false);
  });
});
