// M4：Turnstile 驗證（docs/API.md「鐘塔之夢」）。verifyTurnstile 的 siteverify 呼叫可注入；整合測試由 helpers 的假 siteverify 攔下。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { verifyTurnstile, SITEVERIFY_URL, TURNSTILE_TEST_SECRETS } from '../../worker/src/turnstile.js';
import {
  startWorker, newSecrets, json, expectError, d1Rows, tsToken, TEST_TURNSTILE_SECRET, TURNSTILE_OK_HOST,
} from './helpers.js';

const ENV = { TURNSTILE_SECRET: 'secret-x', TURNSTILE_HOSTNAMES: 'teds-lin.github.io, localhost' };

/** 假 fetch：記錄請求，回傳指定 JSON。 */
function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init, form: new URLSearchParams(String(init.body)) });
    return typeof body === 'function' ? body() : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}
const okBody = (action, hostname = 'teds-lin.github.io') => ({ success: true, hostname, action, 'error-codes': [] });

describe('verifyTurnstile（單元）', () => {
  it('POST 到官方 siteverify，帶 secret、response、remoteip；success＋hostname 在清單＋action 相符 → ok', async () => {
    const f = fakeFetch(okBody('create_player'));
    const r = await verifyTurnstile(ENV, 'tok-1', 'create_player', '203.0.113.9', { fetch: f });
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(SITEVERIFY_URL);
    expect(SITEVERIFY_URL).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(f.calls[0].init.method).toBe('POST');
    expect(Object.fromEntries(f.calls[0].form)).toEqual({ secret: 'secret-x', response: 'tok-1', remoteip: '203.0.113.9' });
  });
  it('沒有 IP 時不送 remoteip', async () => {
    const f = fakeFetch(okBody('dream_pass'));
    expect((await verifyTurnstile(ENV, 'tok', 'dream_pass', null, { fetch: f })).ok).toBe(true);
    expect(f.calls[0].form.has('remoteip')).toBe(false);
  });
  it('hostname 清單逗號分隔、去空白；不在清單 → 失敗', async () => {
    expect((await verifyTurnstile(ENV, 't', 'a', null, { fetch: fakeFetch(okBody('a', 'localhost')) })).ok).toBe(true);
    const r = await verifyTurnstile(ENV, 't', 'a', null, { fetch: fakeFetch(okBody('a', 'evil.example')) });
    expect(r).toMatchObject({ ok: false, reason: 'hostname' });
    expect((await verifyTurnstile({ ...ENV, TURNSTILE_HOSTNAMES: '' }, 't', 'a', null, { fetch: fakeFetch(okBody('a')) })).ok).toBe(false);
  });
  it('action 不符、success false、HTTP 錯誤、不是 JSON、網路錯誤 → 失敗', async () => {
    expect(await verifyTurnstile(ENV, 't', 'create_player', null, { fetch: fakeFetch(okBody('dream_pass')) })).toMatchObject({ ok: false, reason: 'action' });
    expect(await verifyTurnstile(ENV, 't', 'a', null, { fetch: fakeFetch({ success: false, 'error-codes': ['timeout-or-duplicate'] }) })).toMatchObject({ ok: false, reason: 'rejected' });
    expect((await verifyTurnstile(ENV, 't', 'a', null, { fetch: fakeFetch(okBody('a'), { status: 500 }) })).ok).toBe(false);
    expect((await verifyTurnstile(ENV, 't', 'a', null, { fetch: fakeFetch(() => new Response('<html>', { status: 200 })) })).ok).toBe(false);
    expect((await verifyTurnstile(ENV, 't', 'a', null, { fetch: async () => { throw new TypeError('network'); } })).ok).toBe(false);
  });
  it('逾時（預設 5 秒，可由 TURNSTILE_TIMEOUT_MS 調整）→ 失敗', async () => {
    const t0 = Date.now();
    const r = await verifyTurnstile({ ...ENV, TURNSTILE_TIMEOUT_MS: '50' }, 't', 'a', null, { fetch: () => new Promise(() => {}) });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('token 缺少、不是字串、空字串、超過 2048 字元 → 失敗且不呼叫 siteverify', async () => {
    const f = fakeFetch(okBody('a'));
    for (const t of [undefined, null, 5, '', 'x'.repeat(2049)]) {
      expect((await verifyTurnstile(ENV, t, 'a', null, { fetch: f })).ok, String(t)).toBe(false);
    }
    expect(f.calls).toHaveLength(0);
  });
  it('沒有設定 TURNSTILE_SECRET → 失敗（fail closed）且不呼叫 siteverify', async () => {
    const f = fakeFetch(okBody('a'));
    expect(await verifyTurnstile({ TURNSTILE_HOSTNAMES: 'x' }, 't', 'a', null, { fetch: f })).toMatchObject({ ok: false, reason: 'no_secret' });
    expect(f.calls).toHaveLength(0);
  });
  it('官方測試金鑰：只在 TURNSTILE_ALLOW_TEST_SECRET=1 時離線模擬（1x 通過、2x 失敗、3x 失敗），不連外網', async () => {
    expect(TURNSTILE_TEST_SECRETS.pass).toBe('1x0000000000000000000000000000000AA');
    expect(TURNSTILE_TEST_SECRETS.fail).toBe('2x0000000000000000000000000000000AA');
    const f = fakeFetch(okBody('a'));
    const allow = { TURNSTILE_ALLOW_TEST_SECRET: '1', TURNSTILE_HOSTNAMES: 'localhost' };
    expect((await verifyTurnstile({ ...allow, TURNSTILE_SECRET: TURNSTILE_TEST_SECRETS.pass }, 'XXXX.DUMMY.TOKEN.XXXX', 'a', null, { fetch: f })).ok).toBe(true);
    expect((await verifyTurnstile({ ...allow, TURNSTILE_SECRET: TURNSTILE_TEST_SECRETS.fail }, 'XXXX.DUMMY.TOKEN.XXXX', 'a', null, { fetch: f })).ok).toBe(false);
    expect((await verifyTurnstile({ ...allow, TURNSTILE_SECRET: TURNSTILE_TEST_SECRETS.spent }, 'XXXX.DUMMY.TOKEN.XXXX', 'a', null, { fetch: f })).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it('正式環境誤設官方測試金鑰（沒有 TURNSTILE_ALLOW_TEST_SECRET）→ 一律失敗、不呼叫 siteverify', async () => {
    const f = fakeFetch(okBody('a'));
    const r = await verifyTurnstile({ TURNSTILE_SECRET: TURNSTILE_TEST_SECRETS.pass, TURNSTILE_HOSTNAMES: 'teds-lin.github.io' }, 'XXXX.DUMMY.TOKEN.XXXX', 'a', null, { fetch: f });
    expect(r).toMatchObject({ ok: false, reason: 'test_secret_not_allowed' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('POST /api/player 需要 Turnstile（action create_player）', () => {
  let w;
  beforeAll(async () => { w = await startWorker(); });
  afterAll(async () => { await w?.close(); });
  const create = (body, ip = w.nextIp()) => w.fetch('/api/player', json(body, { 'cf-connecting-ip': ip }));

  it('通過 → 201；siteverify 收到 secret、token 與 IP', async () => {
    const ip = w.nextIp();
    const before = w.siteverifyCalls.length;
    const res = await create(newSecrets(), ip);
    expect(res.status).toBe(201);
    const call = w.siteverifyCalls.at(-1);
    expect(w.siteverifyCalls.length).toBe(before + 1);
    expect(call).toMatchObject({ secret: TEST_TURNSTILE_SECRET, response: tsToken('create_player'), remoteip: ip, method: 'POST' });
  });

  it('沒帶 turnstile_token、驗證失敗、action 不符、hostname 不在清單 → 403 turnstile_failed，玩家沒有建立', async () => {
    const count = async () => (await w.db.prepare('SELECT COUNT(*) AS n FROM players').first()).n;
    const n0 = await count();
    for (const turnstile_token of [undefined, 'fail', tsToken('dream_pass'), `host:evil.example:create_player`, '500']) {
      const body = { ...newSecrets(), turnstile_token };
      const b = await expectError(await create(body), 403, 'turnstile_failed');
      expect(b.message).toBe('人機驗證失敗，請再試一次。');
    }
    expect(await count()).toBe(n0);
  });

  it('冪等重送（權杖已建立）→ 200 同一個玩家，不驗證 Turnstile（token 只能用一次）', async () => {
    const s = newSecrets();
    const first = await create(s);
    expect(first.status).toBe(201);
    const { player_id } = await first.json();
    const before = w.siteverifyCalls.length;
    const again = await create({ token: s.token, transfer_code: s.transfer_code });
    expect(again.status).toBe(200);
    expect((await again.json()).player_id).toBe(player_id);
    const spent = await create({ ...s, turnstile_token: 'fail' });
    expect(spent.status).toBe(200);
    expect(w.siteverifyCalls.length).toBe(before);
  });

  it('格式錯誤的 body 照舊 400（先於 Turnstile，不呼叫 siteverify）', async () => {
    const before = w.siteverifyCalls.length;
    await expectError(await create({ token: 'short', transfer_code: 'ABCD-EFGH', turnstile_token: tsToken('create_player') }), 400, 'bad_request');
    expect(w.siteverifyCalls.length).toBe(before);
  });

  it('Turnstile 失敗只寫入限流計數（不寫玩家）', async () => {
    const res = await create({ ...newSecrets(), turnstile_token: 'fail' });
    expect(res.status).toBe(403);
    expect(d1Rows(res).written).toBeLessThanOrEqual(2);
    await res.arrayBuffer();
  });

  it('siteverify 逾時 → 403（TURNSTILE_TIMEOUT_MS）', async () => {
    const s = await startWorker({ varsOverride: { TURNSTILE_TIMEOUT_MS: '100' } });
    try {
      await expectError(await s.fetch('/api/player', json({ ...newSecrets(), turnstile_token: 'slow' }, { 'cf-connecting-ip': s.nextIp() })), 403, 'turnstile_failed');
    } finally {
      await s.close();
    }
  });

  it('wrangler.toml 的 TURNSTILE_HOSTNAMES 只有 GitHub Pages', async () => {
    const { readWranglerConfig } = await import('./helpers.js');
    expect(readWranglerConfig().vars.TURNSTILE_HOSTNAMES).toBe(TURNSTILE_OK_HOST);
  });
});
