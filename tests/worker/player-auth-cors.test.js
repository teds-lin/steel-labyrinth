// POST /api/player、驗證（401）、CORS、未知路徑、500 不洩漏細節。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWorker, newPlayer, json, auth, expectError, readWranglerConfig } from './helpers.js';
import { sha256Hex } from '../../worker/src/codes.js';

let w;
beforeAll(async () => { w = await startWorker(); });
afterAll(async () => { await w?.close(); });

describe('POST /api/player', () => {
  it('201：回傳 uuid、43 字元權杖、XXXX-XXXX 轉移碼', async () => {
    const res = await w.fetch('/api/player', json({}, { 'cf-connecting-ip': w.nextIp() }));
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['player_id', 'token', 'transfer_code']);
    expect(body.player_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.transfer_code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  });

  it('伺服器只存權杖與轉移碼的雜湊', async () => {
    const p = await newPlayer(w);
    const row = await w.db.prepare('SELECT * FROM players WHERE player_id = ?').bind(p.player_id).first();
    expect(JSON.stringify(row)).not.toContain(p.token);
    expect(JSON.stringify(row)).not.toContain(p.transfer_code.replace('-', ''));
    expect(row.token_hash).toBe(await sha256Hex(p.token));
    expect(row.transfer_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.transfer_hash).not.toBe(await sha256Hex(p.transfer_code.replace('-', ''))); // 有加 pepper
  });

  it('沒有 body 也可以；body 不是物件或壞 JSON → 400', async () => {
    const ok = await w.fetch('/api/player', { method: 'POST', headers: { 'cf-connecting-ip': w.nextIp() } });
    expect(ok.status).toBe(201);
    await expectError(await w.fetch('/api/player', json('{bad', { 'cf-connecting-ip': w.nextIp() })), 400, 'bad_request');
    await expectError(await w.fetch('/api/player', json('[1]', { 'cf-connecting-ip': w.nextIp() })), 400, 'bad_request');
  });

  it('兩個玩家的 id、權杖、轉移碼都不同', async () => {
    const a = await newPlayer(w);
    const b = await newPlayer(w);
    expect(a.player_id).not.toBe(b.player_id);
    expect(a.token).not.toBe(b.token);
    expect(a.transfer_code).not.toBe(b.transfer_code);
  });
});

describe('401 unauthorized', () => {
  const protectedRoutes = [
    ['GET', '/api/saves'], ['GET', '/api/save/1'], ['PUT', '/api/save/1'], ['DELETE', '/api/save/1'],
    ['POST', '/api/transfer/rotate'], ['POST', '/api/clear'],
  ];

  it.each(protectedRoutes)('%s %s 缺少權杖 → 401', async (method, path) => {
    const body = await expectError(await w.fetch(path, { method }), 401, 'unauthorized');
    expect(body.message).toMatch(/[一-鿿]/);
  });

  it.each(protectedRoutes)('%s %s 錯誤權杖 → 401', async (method, path) => {
    await expectError(await w.fetch(path, { method, headers: auth('A'.repeat(43)) }), 401, 'unauthorized');
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
  const ALLOWED = ['https://teds-lin.github.io', 'http://localhost:8080', 'http://localhost:8091'];

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

  it('不允許的來源：不回 CORS 標頭，但照常處理', async () => {
    for (const origin of ['https://evil.example', 'https://teds-lin.github.io.evil.example', 'http://localhost:9999', 'null']) {
      const res = await w.fetch('/api/stats', { headers: { origin } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
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

  it('預檢：不允許的來源 → 204 但沒有 CORS 標頭；預檢不需要權杖', async () => {
    const res = await w.fetch('/api/saves', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
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
      await expectError(await nopepper.fetch('/api/player', json({})), 500, 'internal');
    } finally {
      await nopepper.close();
    }
  });
});
