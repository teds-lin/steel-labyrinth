// 頻率限制：每種限制都測到 429＋Retry-After；限制值用 wrangler.toml 的 vars（5／10／60／10／30）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWorker, newPlayer, json, auth, putSave, expectError, sampleSave } from './helpers.js';

let w;
beforeAll(async () => { w = await startWorker(); });
afterAll(async () => { await w?.close(); });

async function expect429(res) {
  const retry = res.headers.get('retry-after');
  await expectError(res, 429, 'rate_limited');
  expect(retry).toMatch(/^\d+$/);
  expect(Number(retry)).toBeGreaterThanOrEqual(1);
  expect(Number(retry)).toBeLessThanOrEqual(3600);
  return Number(retry);
}

describe('POST /api/player：同一 IP 每小時 5 次', () => {
  it('第 6 次 429；別的 IP 不受影響；資料表只存 IP 雜湊', async () => {
    const ip = '198.51.100.23';
    for (let i = 0; i < 5; i++) expect((await w.fetch('/api/player', json({}, { 'cf-connecting-ip': ip }))).status).toBe(201);
    await expect429(await w.fetch('/api/player', json({}, { 'cf-connecting-ip': ip })));
    await expect429(await w.fetch('/api/player', json({}, { 'cf-connecting-ip': ip })));
    expect((await w.fetch('/api/player', json({}, { 'cf-connecting-ip': '198.51.100.24' }))).status).toBe(201);
    const rows = await w.db.prepare('SELECT bucket FROM rate_limits').all();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) {
      expect(r.bucket).not.toContain('198.51.100');
    }
  });

  it('時間窗過了就重新計算（固定時間窗）', async () => {
    const ip = '198.51.100.99';
    for (let i = 0; i < 5; i++) await w.fetch('/api/player', json({}, { 'cf-connecting-ip': ip }));
    await expect429(await w.fetch('/api/player', json({}, { 'cf-connecting-ip': ip })));
    await w.db.prepare('UPDATE rate_limits SET reset_at = 1').run(); // 模擬一小時過去
    expect((await w.fetch('/api/player', json({}, { 'cf-connecting-ip': ip }))).status).toBe(201);
  });

  it('429 回應也帶 CORS 標頭，且暴露 Retry-After', async () => {
    const ip = '198.51.100.50';
    const origin = 'https://teds-lin.github.io';
    for (let i = 0; i < 5; i++) await w.fetch('/api/player', json({}, { 'cf-connecting-ip': ip }));
    const res = await w.fetch('/api/player', json({}, { 'cf-connecting-ip': ip, origin }));
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-expose-headers')).toMatch(/Retry-After/);
    await expect429(res);
  });
});

describe('POST /api/transfer：同一 IP 每小時 10 次（成功失敗都算）', () => {
  it('10 次失敗後，連正確的碼也 429', async () => {
    const ip = '203.0.113.10';
    const victim = await newPlayer(w);
    for (let i = 0; i < 10; i++) {
      await expectError(await w.fetch('/api/transfer', json({ code: 'ABCD-EFGH' }, { 'cf-connecting-ip': ip })), 404, 'not_found');
    }
    await expect429(await w.fetch('/api/transfer', json({ code: victim.transfer_code }, { 'cf-connecting-ip': ip })));
    // 轉移碼沒有被這次嘗試消耗
    expect((await w.fetch('/api/transfer', json({ code: victim.transfer_code }, { 'cf-connecting-ip': '203.0.113.11' }))).status).toBe(200);
  });

  it('成功的轉移也計入次數', async () => {
    const ip = '203.0.113.20';
    let p = await newPlayer(w);
    let code = p.transfer_code;
    for (let i = 0; i < 10; i++) {
      const res = await w.fetch('/api/transfer', json({ code }, { 'cf-connecting-ip': ip }));
      expect(res.status).toBe(200);
      code = (await res.json()).transfer_code;
    }
    await expect429(await w.fetch('/api/transfer', json({ code }, { 'cf-connecting-ip': ip })));
  });

  it('壞 JSON 的嘗試也計入次數', async () => {
    const ip = '203.0.113.30';
    for (let i = 0; i < 10; i++) await w.fetch('/api/transfer', json('{', { 'cf-connecting-ip': ip }));
    await expect429(await w.fetch('/api/transfer', json({ code: 'ABCD-EFGH' }, { 'cf-connecting-ip': ip })));
  });
});

describe('寫入：同一玩家每小時 60 次（PUT＋DELETE 合計）', () => {
  it('30 次 PUT＋30 次 DELETE 後，第 61 次寫入 429；讀取不受影響；別的玩家不受影響', async () => {
    const p = await newPlayer(w);
    for (let i = 0; i < 30; i++) {
      const r = await putSave(w, p.token, 1, sampleSave());
      expect(r.status).toBe(200);
      const { version } = await r.json();
      expect((await w.fetch('/api/save/1', { method: 'DELETE', headers: auth(p.token, { 'if-match': `"${version}"` }) })).status).toBe(204);
    }
    await expect429(await putSave(w, p.token, 2, sampleSave()));
    await expect429(await w.fetch('/api/save/2', { method: 'DELETE', headers: auth(p.token, { 'if-match': '"1"' }) }));
    expect((await w.fetch('/api/saves', { headers: auth(p.token) })).status).toBe(200);
    const q = await newPlayer(w);
    expect((await putSave(w, q.token, 1, sampleSave())).status).toBe(200);
  });

  it('轉移之後仍是同一個玩家的額度（不能靠轉移重置）', async () => {
    const p = await newPlayer(w);
    for (let i = 0; i < 60; i++) await putSave(w, p.token, (i % 3) + 1, '{');
    const t = await (await w.fetch('/api/transfer', json({ code: p.transfer_code }, { 'cf-connecting-ip': w.nextIp() }))).json();
    await expect429(await putSave(w, t.token, 1, sampleSave()));
  });
});

describe('POST /api/transfer/rotate：同一玩家每小時 10 次', () => {
  it('第 11 次 429', async () => {
    const p = await newPlayer(w);
    for (let i = 0; i < 10; i++) expect((await w.fetch('/api/transfer/rotate', { method: 'POST', headers: auth(p.token) })).status).toBe(200);
    await expect429(await w.fetch('/api/transfer/rotate', { method: 'POST', headers: auth(p.token) }));
  });
});

describe('POST /api/clear：同一玩家每小時 30 次', () => {
  it('第 31 次 429', async () => {
    const p = await newPlayer(w);
    const body = JSON.stringify({ chapter: 'chapter1', ending: null, play_seconds: 10, collapse: 0 });
    for (let i = 0; i < 30; i++) expect((await w.fetch('/api/clear', { method: 'POST', headers: auth(p.token), body })).status).toBe(200);
    await expect429(await w.fetch('/api/clear', { method: 'POST', headers: auth(p.token), body }));
  });
});

describe('限流值由 vars 決定', () => {
  it('把 RL_PLAYER_PER_HOUR 調成 1 → 第 2 次就 429', async () => {
    const s = await startWorker({ varsOverride: { RL_PLAYER_PER_HOUR: '1' } });
    try {
      expect((await s.fetch('/api/player', json({}, { 'cf-connecting-ip': '192.0.2.1' }))).status).toBe(201);
      await expect429(await s.fetch('/api/player', json({}, { 'cf-connecting-ip': '192.0.2.1' })));
    } finally {
      await s.close();
    }
  });
});
