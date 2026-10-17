// POST /api/player、驗證（401）、CORS、未知路徑、500 不洩漏細節。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  d1Rows, startWorker, newPlayer, newSecrets, doTransfer, json, auth, expectError, readWranglerConfig, devVarOverrides, TEST_PEPPER,
  tsToken,
} from './helpers.js';
import { sha256Hex } from '../../worker/src/codes.js';

let w;
beforeAll(async () => { w = await startWorker(); });
afterAll(async () => { await w?.close(); });

describe('POST /api/player（修訂 2 A：秘密由客戶端產生）', () => {
  const create = (body, headers = {}) => w.fetch('/api/player', json(body, { 'cf-connecting-ip': w.nextIp(), ...headers }));

  it('201：只回 player_id（uuid）；權杖與轉移碼是客戶端送來的那一組', async () => {
    const secrets = newSecrets();
    const res = await create(secrets);
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['player_id']);
    expect(body.player_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect((await w.fetch('/api/saves', { headers: auth(secrets.token) })).status).toBe(200);
    expect((await doTransfer(w, secrets.transfer_code)).res.status).toBe(200);
  });

  it('伺服器只存權杖與轉移碼的雜湊', async () => {
    const p = await newPlayer(w);
    const row = await w.db.prepare('SELECT * FROM players WHERE player_id = ?').bind(p.player_id).first();
    expect(JSON.stringify(row)).not.toContain(p.token);
    expect(JSON.stringify(row)).not.toContain(p.transfer_code.replace('-', ''));
    expect(row.token_hash).toBe(await sha256Hex(p.token));
    expect(row.transfer_hash).toBe(await sha256Hex(`${TEST_PEPPER}${p.transfer_code.replace('-', '')}`));
  });

  it('冪等：同一個 token 重送 → 200 回同一個 player_id，不會多建玩家', async () => {
    const secrets = newSecrets();
    const first = await (await create(secrets)).json();
    const again = await create(secrets);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ player_id: first.player_id });
    // 持有權杖即擁有帳號：轉移碼不同也回同一個玩家，且不會改掉已存的轉移碼
    const other = await create({ token: secrets.token, transfer_code: newSecrets().transfer_code });
    expect(other.status).toBe(200);
    expect((await other.json()).player_id).toBe(first.player_id);
    const n = await w.db.prepare('SELECT COUNT(*) AS n FROM players WHERE token_hash = ?').bind(await sha256Hex(secrets.token)).first();
    expect(n.n).toBe(1);
    expect((await doTransfer(w, secrets.transfer_code)).res.status).toBe(200);
  });

  it('同一組秘密的請求同時抵達：一個 201、其他 200，全部是同一個 player_id，只建一個玩家', async () => {
    const secrets = newSecrets();
    const rs = await Promise.all([create(secrets), create(secrets), create(secrets)]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    const ids = new Set(await Promise.all(rs.map(async (r) => (await r.json()).player_id)));
    expect(ids.size).toBe(1);
    const n = await w.db.prepare('SELECT COUNT(*) AS n FROM players WHERE token_hash = ?').bind(await sha256Hex(secrets.token)).first();
    expect(n.n).toBe(1);
  });

  it('轉移碼雜湊和別人相同 → 409 conflict（客戶端換一組重送）', async () => {
    const a = await newPlayer(w);
    const body = await expectError(await create({ token: newSecrets().token, transfer_code: a.transfer_code, turnstile_token: tsToken('create_player') }), 409, 'conflict');
    expect(body.current).toBeUndefined();
    // 換一組就成功
    expect((await create(newSecrets())).status).toBe(201);
  });

  it.each([
    ['空 body', ''],
    ['{}', {}],
    ['缺 transfer_code', { token: newSecrets().token }],
    ['缺 token', { transfer_code: newSecrets().transfer_code }],
    ['權杖 42 字元', { ...newSecrets(), token: newSecrets().token.slice(1) }],
    ['權杖 44 字元', { ...newSecrets(), token: `${newSecrets().token}A` }],
    ['權杖含 + /', { ...newSecrets(), token: `${'A'.repeat(41)}+/` }],
    ['權杖含補位 =', { ...newSecrets(), token: `${'A'.repeat(42)}=` }],
    ['權杖不是字串', { ...newSecrets(), token: 12345 }],
    ['轉移碼含易混淆字元', { ...newSecrets(), transfer_code: 'ABCD-EFG0' }],
    ['轉移碼太短', { ...newSecrets(), transfer_code: 'ABCD-EFG' }],
    ['轉移碼太長', { ...newSecrets(), transfer_code: 'ABCD-EFGHJ' }],
    ['轉移碼不是字串', { ...newSecrets(), transfer_code: 23456789 }],
    ['不是物件', '[1]'],
    ['壞 JSON', '{bad'],
  ])('格式不合法：%s → 400', async (_, body) => {
    await expectError(await create(body), 400, 'bad_request');
  });

  it('轉移碼的格式寬容：小寫、沒有連字號都接受（正規化後存雜湊）', async () => {
    const { token, transfer_code: code } = newSecrets();
    expect((await create({ token, transfer_code: code.toLowerCase().replace('-', ''), turnstile_token: tsToken('create_player') })).status).toBe(201);
    expect((await doTransfer(w, code)).res.status).toBe(200);
  });
});

describe('401 unauthorized', () => {
  const protectedRoutes = [
    ['GET', '/api/saves'], ['GET', '/api/save/1'], ['PUT', '/api/save/1'], ['DELETE', '/api/save/1'],
    ['POST', '/api/transfer/rotate'], ['POST', '/api/clear'],
  ];

  it.each(protectedRoutes)('%s %s 缺少權杖 → 401', async (method, path) => {
    const body = await expectError(await w.fetch(path, { method, headers: { 'content-type': 'application/json' } }), 401, 'unauthorized');
    expect(body.message).toMatch(/[一-鿿]/);
  });

  it.each(protectedRoutes)('%s %s 錯誤權杖 → 401', async (method, path) => {
    await expectError(await w.fetch(path, { method, headers: auth('A'.repeat(43), { 'content-type': 'application/json' }) }), 401, 'unauthorized');
  });

  it('格式錯誤的 Authorization（不是 Bearer、太短、含怪字元、SQL 字串）→ 401', async () => {
    const p = await newPlayer(w);
    for (const h of [p.token, `Basic ${p.token}`, 'Bearer ', 'Bearer abc', `Bearer ${p.token}x`, "Bearer ' OR '1'='1", `Bearer  ${p.token}`]) {
      await expectError(await w.fetch('/api/saves', { headers: { authorization: h } }), 401, 'unauthorized');
    }
  });

  it('正確權杖 → 200（Bearer 不分大小寫）', async () => {
    const p = await newPlayer(w);
    expect((await w.fetch('/api/saves', { headers: auth(p.token) })).status).toBe(200);
    expect((await w.fetch('/api/saves', { headers: { authorization: `bearer ${p.token}` } })).status).toBe(200);
  });
});

describe('CORS', () => {
  // 本機來源由 worker:dev 的 --var 覆寫（正式只有 GitHub Pages）；helpers 用同一組值啟動 Worker。
  const ALLOWED = devVarOverrides().ALLOWED_ORIGINS.split(',');

  it('測試用的允許來源含正式來源與本機 8080／8091', () => {
    expect(ALLOWED).toEqual(['https://teds-lin.github.io', 'http://localhost:8080', 'http://localhost:8091']);
  });

  it.each(ALLOWED)('允許的來源 %s：回 Allow-Origin、Vary、Expose', async (origin) => {
    const res = await w.fetch('/api/stats', { headers: { origin } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('vary')).toMatch(/Origin/);
    expect(res.headers.get('access-control-expose-headers')).toMatch(/ETag/);
    expect(res.headers.get('access-control-expose-headers')).toMatch(/Retry-After/);
  });

  it('錯誤回應也帶 CORS 標頭（讓客戶端讀得到 401／429）', async () => {
    const res = await w.fetch('/api/saves', { headers: { origin: ALLOWED[0] } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED[0]);
  });

  it('不允許的來源 → 403 forbidden_origin（修訂 2 C），不回 CORS 標頭、不碰資料庫', async () => {
    for (const origin of ['https://evil.example', 'https://teds-lin.github.io.evil.example', 'http://localhost:9999', 'null', 'https://TEDS-LIN.github.io']) {
      const res = await w.fetch('/api/stats', { headers: { origin } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(d1Rows(res)).toEqual({ read: 0, written: 0 });
      const body = await expectError(res, 403, 'forbidden_origin');
      expect(body.message).toMatch(/[一-鿿]/);
    }
  });

  it('不允許的來源送「簡單請求」（text/plain）建立玩家或轉移 → 403，不會建立玩家、不會消耗轉移碼', async () => {
    const victim = await newPlayer(w);
    const before = (await w.db.prepare('SELECT COUNT(*) AS n FROM players').first()).n;
    const evil = { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example', 'cf-connecting-ip': w.nextIp() };
    await expectError(await w.fetch('/api/player', { method: 'POST', headers: evil, body: JSON.stringify(newSecrets()) }), 403, 'forbidden_origin');
    const s = newSecrets();
    await expectError(await w.fetch('/api/transfer', {
      method: 'POST', headers: evil, body: JSON.stringify({ code: victim.transfer_code, new_token: s.token, new_transfer_code: s.transfer_code }),
    }), 403, 'forbidden_origin');
    expect((await w.fetch('/api/saves', { headers: auth(victim.token) })).status).toBe(200);
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM players').first()).n).toBe(before);
  });

  it('沒有 Origin（非瀏覽器）：照常處理、沒有 Allow-Origin', async () => {
    const res = await w.fetch('/api/stats');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('預檢：允許的來源 → 204＋方法＋標頭', async () => {
    const res = await w.fetch('/api/save/1', {
      method: 'OPTIONS',
      headers: { origin: ALLOWED[1], 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, content-type, if-match' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED[1]);
    const methods = res.headers.get('access-control-allow-methods').split(',').map((s) => s.trim());
    expect(methods.sort()).toEqual(['DELETE', 'GET', 'OPTIONS', 'POST', 'PUT']);
    const hs = res.headers.get('access-control-allow-headers').split(',').map((s) => s.trim().toLowerCase());
    expect(hs.sort()).toEqual(['authorization', 'content-type', 'if-match', 'if-none-match']);
    expect(res.headers.get('vary')).toMatch(/Origin/);
    expect(await res.text()).toBe('');
  });

  it('預檢：不允許的來源 → 403 且沒有 CORS 標頭；預檢不需要權杖', async () => {
    const res = await w.fetch('/api/saves', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
  });
});

describe('415 unsupported_media_type（修訂 2 C）', () => {
  const routes = [['POST', '/api/player'], ['POST', '/api/transfer'], ['POST', '/api/transfer/rotate'], ['POST', '/api/clear'], ['PUT', '/api/save/1']];
  it.each(routes)('%s %s：Content-Type 不是 application/json → 415（在驗證權杖與限流之前）', async (method, path) => {
    for (const ct of [null, 'text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'application/json-patch+json']) {
      const headers = { 'cf-connecting-ip': w.nextIp(), authorization: `Bearer ${'A'.repeat(43)}`, 'if-none-match': '*' };
      if (ct) headers['content-type'] = ct;
      const res = await w.fetch(path, { method, headers, body: '{}' });
      expect(d1Rows(res), String(ct)).toEqual({ read: 0, written: 0 });
      const body = await expectError(res, 415, 'unsupported_media_type');
      expect(body.message).toMatch(/[一-鿿]/);
    }
  });

  it('application/json 帶 charset、大小寫不同都接受', async () => {
    for (const ct of ['application/json', 'application/json; charset=utf-8', 'Application/JSON;charset=UTF-8']) {
      const res = await w.fetch('/api/player', { method: 'POST', headers: { 'content-type': ct, 'cf-connecting-ip': w.nextIp() }, body: JSON.stringify(newSecrets()) });
      expect(res.status, ct).toBe(201);
    }
  });

  it('GET、DELETE 不檢查 Content-Type', async () => {
    const p = await newPlayer(w);
    expect((await w.fetch('/api/saves', { headers: auth(p.token, { 'content-type': 'text/plain' }) })).status).toBe(200);
    expect((await w.fetch('/api/save/1', { method: 'DELETE', headers: auth(p.token, { 'if-match': '"1"' }) })).status).toBe(404);
  });
});

describe('路由', () => {
  it.each([
    ['GET', '/'], ['GET', '/api'], ['GET', '/api/unknown'], ['GET', '/api/save'], ['GET', '/api/save/1/extra'],
    ['GET', '/api/player'], ['DELETE', '/api/stats'], ['POST', '/api/saves'], ['GET', '/api/transfer'],
    ['GET', '/api/../api/stats/x'], ['PATCH', '/api/save/1'],
  ])('%s %s → 404 not_found', async (method, path) => {
    await expectError(await w.fetch(path, { method }), 404, 'not_found');
  });
});

describe('500 不洩漏細節', () => {
  it('資料庫壞掉時回 500 internal，訊息不含 SQL 或堆疊', async () => {
    const broken = await startWorker();
    try {
      const p = await newPlayer(broken);
      await broken.db.prepare('DROP TABLE saves').run();
      const body = await expectError(await broken.fetch('/api/saves', { headers: auth(p.token) }), 500, 'internal');
      expect(body).toEqual({ error: 'internal', message: expect.any(String) });
    } finally {
      await broken.close();
    }
  });

  it('沒有設定 TRANSFER_PEPPER → 建立玩家回 500（不會用空 pepper 繼續）', async () => {
    const cfg = readWranglerConfig();
    const nopepper = await startWorker({ bindingsOverride: { ...cfg.vars } });
    try {
      await expectError(await nopepper.fetch('/api/player', json(newSecrets())), 500, 'internal');
    } finally {
      await nopepper.close();
    }
  });
});
