// M4：夢境通行證（POST /api/dream/pass；docs/API.md「鐘塔之夢」）。HMAC-SHA256（DREAM_PASS_SECRET），30 分鐘。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { signPass, verifyPass, PASS_TTL } from '../../worker/src/dream.js';
import { startWorker, newPlayer, json, auth, expectError, d1Rows, tsToken, loadDreamFixtures, dreamChat } from './helpers.js';

const SECRET = 'unit-test-secret-0123456789abcdef0123456789';
const b64urlDecode = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

describe('signPass／verifyPass（單元）', () => {
  it('格式 base64url(payload).base64url(HMAC)；payload { p, exp }；有效 30 分鐘', async () => {
    expect(PASS_TTL).toBe(1800);
    const { pass, expires_at } = await signPass(SECRET, 'player-1', 1000);
    expect(expires_at).toBe(2800);
    expect(pass).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(b64urlDecode(pass.split('.')[0])).toEqual({ p: 'player-1', exp: 2800 });
    expect(await verifyPass(SECRET, pass, 'player-1', 1000)).toBe(true);
    expect(await verifyPass(SECRET, pass, 'player-1', 2799)).toBe(true);
  });
  it('過期、別的玩家、別的金鑰、竄改 payload 或簽章、格式錯誤 → false', async () => {
    const { pass } = await signPass(SECRET, 'player-1', 1000);
    const [p, sig] = pass.split('.');
    expect(await verifyPass(SECRET, pass, 'player-1', 2800)).toBe(false);
    expect(await verifyPass(SECRET, pass, 'player-2', 1000)).toBe(false);
    expect(await verifyPass(`${SECRET}x`, pass, 'player-1', 1000)).toBe(false);
    const forged = Buffer.from(JSON.stringify({ p: 'player-2', exp: 2800 })).toString('base64url');
    expect(await verifyPass(SECRET, `${forged}.${sig}`, 'player-2', 1000)).toBe(false);
    const longer = Buffer.from(JSON.stringify({ p: 'player-1', exp: 999999 })).toString('base64url');
    expect(await verifyPass(SECRET, `${longer}.${sig}`, 'player-1', 1000)).toBe(false);
    const flipped = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
    expect(await verifyPass(SECRET, `${p}.${flipped}`, 'player-1', 1000)).toBe(false);
    for (const bad of [undefined, null, 5, '', p, `${p}.`, `.${sig}`, `${p}.${sig}.x`, `${p}!.${sig}`, 'x'.repeat(2000)]) {
      expect(await verifyPass(SECRET, bad, 'player-1', 1000), String(bad)).toBe(false);
    }
  });
  it('簽章正確但 exp 超過現在＋30 分鐘（金鑰外洩以外不可能）、payload 不是物件 → false', async () => {
    const { pass } = await signPass(SECRET, 'player-1', 5000);
    expect(await verifyPass(SECRET, pass, 'player-1', 1000)).toBe(false); // 簽發時間在未來 → exp > now+TTL
  });
  it('金鑰沒設定或太短（< 32 字元）→ 丟錯（設定錯誤，不可默默簽出可偽造的票）', async () => {
    await expect(signPass(undefined, 'p', 1)).rejects.toThrow(/DREAM_PASS_SECRET/);
    await expect(signPass('short', 'p', 1)).rejects.toThrow(/DREAM_PASS_SECRET/);
    await expect(verifyPass('', 'a.b', 'p', 1)).rejects.toThrow(/DREAM_PASS_SECRET/);
  });
});

describe('POST /api/dream/pass', () => {
  let w;
  beforeAll(async () => { w = await startWorker(); });
  afterAll(async () => { await w?.close(); });
  const req = (token, body = { turnstile_token: tsToken('dream_pass') }, headers = {}) => w.fetch('/api/dream/pass', json(body, auth(token, headers)));

  it('權杖正確＋Turnstile（action dream_pass）→ 200 { pass, expires_at }，通行證屬於這位玩家', async () => {
    const p = await newPlayer(w);
    const now = Math.floor(Date.now() / 1000);
    const res = await req(p.token, undefined, { 'cf-connecting-ip': '198.51.100.7' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['expires_at', 'pass', 'remaining_today']);
    expect(body.remaining_today).toBe(20); // 新玩家：DREAM_CHATS_PER_DAY 整份
    expect(body.expires_at).toBeGreaterThanOrEqual(now + 1800);
    expect(body.expires_at).toBeLessThanOrEqual(now + 1802);
    expect(b64urlDecode(body.pass.split('.')[0])).toEqual({ p: p.player_id, exp: body.expires_at });
    expect(w.siteverifyCalls.at(-1)).toMatchObject({ response: tsToken('dream_pass'), remoteip: '198.51.100.7' });
  });

  it('remaining_today＝今日剩餘句數（與 /api/dream/chat 同一個計數 pl:dchat:<id>，UTC 日）；只讀、不扣額度', async () => {
    const s = await startWorker({ varsOverride: { DREAM_CHATS_PER_DAY: '2' } });
    try {
      await loadDreamFixtures(s);
      const p = await newPlayer(s);
      const get = async () => (await (await s.fetch('/api/dream/pass', json({ turnstile_token: tsToken('dream_pass') }, auth(p.token)))).json());
      const first = await get();
      expect(first.remaining_today).toBe(2);
      expect((await get()).remaining_today).toBe(2); // 取通行證本身不扣
      const chat = (pass) => dreamChat(s, p.token, { pass, guest: 'lamp', chapter: 'chapter1', history: [], input: '你好' });
      expect((await (await chat(first.pass)).json()).remaining_today).toBe(1);
      expect((await get()).remaining_today).toBe(1);
      expect((await (await chat(first.pass)).json()).remaining_today).toBe(0);
      const last = await get();
      expect(last.remaining_today).toBe(0); // 用完了仍然發通行證（客戶端顯示 0，送出時拿預寫台詞）
      expect(typeof last.pass).toBe('string');
      // 別的玩家各自計算
      const q = await newPlayer(s);
      expect((await (await s.fetch('/api/dream/pass', json({ turnstile_token: tsToken('dream_pass') }, auth(q.token)))).json()).remaining_today).toBe(2);
    } finally {
      await s.close();
    }
  });

  it('沒有權杖或權杖錯誤 → 401（不呼叫 siteverify）', async () => {
    const before = w.siteverifyCalls.length;
    await expectError(await w.fetch('/api/dream/pass', json({ turnstile_token: tsToken('dream_pass') })), 401, 'unauthorized');
    await expectError(await req('A'.repeat(43)), 401, 'unauthorized');
    expect(w.siteverifyCalls.length).toBe(before);
  });

  it('Turnstile 失敗、action 不符（create_player 的 token 不能拿來換通行證）、沒帶 → 403 turnstile_failed', async () => {
    const p = await newPlayer(w);
    for (const t of ['fail', tsToken('create_player'), undefined]) {
      await expectError(await req(p.token, { turnstile_token: t }), 403, 'turnstile_failed');
    }
  });

  it('Content-Type 不是 JSON → 415；壞 JSON → 400', async () => {
    const p = await newPlayer(w);
    await expectError(await w.fetch('/api/dream/pass', { method: 'POST', headers: auth(p.token, { 'content-type': 'text/plain' }), body: '{}' }), 415, 'unsupported_media_type');
    await expectError(await w.fetch('/api/dream/pass', { method: 'POST', headers: auth(p.token, { 'content-type': 'application/json' }), body: '{' }), 400, 'bad_request');
  });

  it('限流：同一玩家每小時 6 次（Turnstile 失敗也算）；第 7 次 429，且 429 不寫入', async () => {
    const p = await newPlayer(w);
    for (let i = 0; i < 3; i++) expect((await req(p.token)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await req(p.token, { turnstile_token: 'fail' })).status).toBe(403);
    const before = w.siteverifyCalls.length;
    const res = await req(p.token);
    await expectError(res.clone(), 429, 'rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(d1Rows(res).written).toBe(0);
    expect(w.siteverifyCalls.length).toBe(before);
  });

  it('全站每小時上限（RL_DREAM_PASS_GLOBAL_PER_HOUR）', async () => {
    const s = await startWorker({ varsOverride: { RL_DREAM_PASS_GLOBAL_PER_HOUR: '2' } });
    try {
      const [a, b, c] = [await newPlayer(s), await newPlayer(s), await newPlayer(s)];
      const r = (t) => s.fetch('/api/dream/pass', json({ turnstile_token: tsToken('dream_pass') }, auth(t)));
      expect((await r(a.token)).status).toBe(200);
      expect((await r(b.token)).status).toBe(200);
      await expectError(await r(c.token), 429, 'rate_limited');
    } finally {
      await s.close();
    }
  });

  it('伺服器沒設定 DREAM_PASS_SECRET → 500 internal（不洩漏細節）', async () => {
    const s = await startWorker({ varsOverride: { DREAM_PASS_SECRET: '' } });
    try {
      const p = await newPlayer(s);
      await expectError(await s.fetch('/api/dream/pass', json({ turnstile_token: tsToken('dream_pass') }, auth(p.token))), 500, 'internal');
    } finally {
      await s.close();
    }
  });
});
