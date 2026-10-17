// 頻率限制：每種限制都測到 429＋Retry-After；限制值用 wrangler.toml 的 vars（5／10／20／3／10，修訂 4）。
// 修訂 2 D：超額後不再寫入 D1（條件式加一）、IPv6 以 /64 計算、全域上限、MAX_PLAYERS 容量。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startWorker, newPlayer, newSecrets, doTransfer, doRotate, json, auth, putSave, expectError, sampleSave, d1Rows,
} from './helpers.js';

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

const create = (s, ip, body = newSecrets()) => s.fetch('/api/player', json(body, { 'cf-connecting-ip': ip }));
const clearBody = JSON.stringify({ chapter: 'chapter1', ending: null, play_seconds: 10, collapse: 0 });
const clear = (token, s = w) => s.fetch('/api/clear', { method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), body: clearBody });

describe('POST /api/player：同一 IP 每小時 5 次', () => {
  it('第 6 次 429；別的 IP 不受影響；資料表只存 IP 雜湊', async () => {
    const ip = '198.51.100.23';
    for (let i = 0; i < 5; i++) expect((await create(w, ip)).status).toBe(201);
    await expect429(await create(w, ip));
    await expect429(await create(w, ip));
    expect((await create(w, '198.51.100.24')).status).toBe(201);
    const rows = await w.db.prepare('SELECT bucket FROM rate_limits').all();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const r of rows.results) expect(r.bucket).not.toContain('198.51.100');
  });

  it('時間窗過了就重新計算（固定時間窗）', async () => {
    const ip = '198.51.100.99';
    for (let i = 0; i < 5; i++) await create(w, ip);
    await expect429(await create(w, ip));
    await w.db.prepare("UPDATE rate_limits SET reset_at = 1 WHERE bucket LIKE 'ip:%'").run(); // 模擬一小時過去
    expect((await create(w, ip)).status).toBe(201);
  });

  it('429 回應也帶 CORS 標頭，且暴露 Retry-After', async () => {
    const ip = '198.51.100.50';
    const origin = 'https://teds-lin.github.io';
    for (let i = 0; i < 5; i++) await create(w, ip);
    const res = await w.fetch('/api/player', json(newSecrets(), { 'cf-connecting-ip': ip, origin }));
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(res.headers.get('access-control-expose-headers')).toMatch(/Retry-After/);
    await expect429(res);
  });

  it('IPv6：同一個 /64 內換位址也算同一個來源；不同 /64 各自計算（修訂 2 D）', async () => {
    let ok = 0;
    for (let i = 0; i < 20; i++) if ((await create(w, `2001:db8:aa:1::${i.toString(16)}`)).status === 201) ok++;
    expect(ok).toBe(5);
    await expect429(await create(w, '2001:db8:aa:1:ffff:ffff:ffff:ffff'));
    expect((await create(w, '2001:db8:aa:2::1')).status).toBe(201);
  });
});

describe('超額後不再寫入 D1（修訂 2 D：條件式加一）', () => {
  it('建立玩家超額：429 的寫入列數為 0，計數停在上限', async () => {
    const ip = '198.51.100.77';
    for (let i = 0; i < 5; i++) await create(w, ip);
    for (let i = 0; i < 20; i++) {
      const res = await create(w, ip);
      expect(d1Rows(res).written).toBe(0);
      await expect429(res);
    }
    const max = await w.db.prepare("SELECT MAX(count) AS n FROM rate_limits WHERE bucket LIKE 'ip:player:%'").first();
    expect(max.n).toBe(5);
  });

  it('轉移超額：429 的寫入列數為 0，計數停在上限（審查 t1：5 → 25）', async () => {
    const ip = '203.0.113.200';
    for (let i = 0; i < 10; i++) await doTransfer(w, 'AAAA-AAAA', { ip });
    for (let i = 0; i < 15; i++) {
      const { res } = await doTransfer(w, 'AAAA-AAAA', { ip });
      expect(d1Rows(res).written).toBe(0);
      await expect429(res);
    }
    const max = await w.db.prepare("SELECT MAX(count) AS n FROM rate_limits WHERE bucket LIKE 'ip:transfer:%'").first();
    expect(max.n).toBe(10);
  });

  it('寫入、rotate、clear 超額：429 只讀不寫', async () => {
    const p = await newPlayer(w);
    for (let i = 0; i < 20; i++) await putSave(w, p.token, 1, '{');
    let res = await putSave(w, p.token, 1, sampleSave());
    expect(d1Rows(res).written).toBe(0);
    await expect429(res);
    for (let i = 0; i < 3; i++) await doRotate(w, p.token);
    res = await doRotate(w, p.token);
    expect(d1Rows(res).written).toBe(0);
    await expect429(res);
    for (let i = 0; i < 10; i++) await clear(p.token);
    res = await clear(p.token);
    expect(d1Rows(res).written).toBe(0);
    await expect429(res);
  });
});

describe('POST /api/transfer：同一 IP 每小時 10 次（成功失敗都算）', () => {
  it('10 次失敗後，連正確的碼也 429；轉移碼沒有被消耗', async () => {
    const ip = '203.0.113.10';
    const victim = await newPlayer(w);
    for (let i = 0; i < 10; i++) await expectError((await doTransfer(w, 'ABCD-EFGH', { ip })).res, 404, 'not_found');
    await expect429((await doTransfer(w, victim.transfer_code, { ip })).res);
    expect((await doTransfer(w, victim.transfer_code, { ip: '203.0.113.11' })).res.status).toBe(200);
  });

  it('成功的轉移也計入次數', async () => {
    const ip = '203.0.113.20';
    let code = (await newPlayer(w)).transfer_code;
    for (let i = 0; i < 10; i++) {
      const t = await doTransfer(w, code, { ip });
      expect(t.res.status).toBe(200);
      code = t.transfer_code;
    }
    await expect429((await doTransfer(w, code, { ip })).res);
  });

  it('壞 JSON 的嘗試也計入次數', async () => {
    const ip = '203.0.113.30';
    for (let i = 0; i < 10; i++) await w.fetch('/api/transfer', json('{', { 'cf-connecting-ip': ip }));
    await expect429((await doTransfer(w, 'ABCD-EFGH', { ip })).res);
  });
});

describe('寫入：同一玩家每小時 20 次（PUT＋DELETE 合計；修訂 4）', () => {
  it('10 次 PUT＋10 次 DELETE 後，第 21 次寫入 429；讀取不受影響；別的玩家不受影響', async () => {
    const p = await newPlayer(w);
    for (let i = 0; i < 10; i++) {
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
    for (let i = 0; i < 20; i++) await putSave(w, p.token, (i % 3) + 1, '{');
    const t = await doTransfer(w, p.transfer_code);
    expect(t.res.status).toBe(200);
    await expect429(await putSave(w, t.token, 1, sampleSave()));
  });
});

describe('POST /api/transfer/rotate：同一玩家每小時 3 次（修訂 4）', () => {
  it('第 4 次 429', async () => {
    const p = await newPlayer(w);
    for (let i = 0; i < 3; i++) expect((await doRotate(w, p.token)).status).toBe(200);
    await expect429(await doRotate(w, p.token));
  });
});

describe('POST /api/clear：同一玩家每小時 10 次（修訂 4）', () => {
  it('第 11 次 429', async () => {
    const p = await newPlayer(w);
    for (let i = 0; i < 10; i++) expect((await clear(p.token)).status).toBe(200);
    await expect429(await clear(p.token));
  });
});

describe('全域上限（修訂 2 D：不分來源）', () => {
  it('RL_PLAYER_GLOBAL_PER_HOUR：不同 IP 合計超過就 429；超過後連 IP 的計數都不寫', async () => {
    const s = await startWorker({ varsOverride: { RL_PLAYER_GLOBAL_PER_HOUR: '3' } });
    try {
      for (let i = 0; i < 3; i++) expect((await create(s, `192.0.2.${i + 1}`)).status).toBe(201);
      const before = (await s.db.prepare('SELECT COUNT(*) AS n FROM rate_limits').first()).n;
      for (let i = 0; i < 5; i++) {
        const res = await create(s, `2001:db8:${i + 10}::1`);
        expect(d1Rows(res).written).toBe(0);
        await expect429(res);
      }
      expect((await s.db.prepare('SELECT COUNT(*) AS n FROM rate_limits').first()).n).toBe(before);
    } finally {
      await s.close();
    }
  });

  it('RL_TRANSFER_GLOBAL_PER_HOUR：不同 IP 合計超過就 429', async () => {
    const s = await startWorker({ varsOverride: { RL_TRANSFER_GLOBAL_PER_HOUR: '2' } });
    try {
      for (let i = 0; i < 2; i++) expect((await doTransfer(s, 'ABCD-EFGH', { ip: `192.0.2.${i + 1}` })).res.status).toBe(404);
      const { res } = await doTransfer(s, 'ABCD-EFGH', { ip: '192.0.2.99' });
      expect(d1Rows(res).written).toBe(0);
      await expect429(res);
    } finally {
      await s.close();
    }
  });

  it('預設值（修訂 3／3a／4a）：玩家 60、轉移 120、已登入寫入每小時 100＋保留通道每日 4000、容量 5000', async () => {
    const { readWranglerConfig } = await import('./helpers.js');
    const { vars } = readWranglerConfig();
    expect(Number(vars.RL_PLAYER_GLOBAL_PER_HOUR)).toBe(60);
    expect(Number(vars.RL_TRANSFER_GLOBAL_PER_HOUR)).toBe(120);
    expect(Number(vars.RL_WRITE_GLOBAL_PER_HOUR)).toBe(100);
    expect(Number(vars.RL_WRITE_GLOBAL_PER_DAY)).toBe(4000);
    expect(Number(vars.MAX_PLAYERS)).toBe(5000);
  });

  it('RL_WRITE_GLOBAL_PER_HOUR：PUT、DELETE、clear、rotate 不分玩家合計；超過 429 且不寫入（修訂 3）', async () => {
    // 保留通道（修訂 4）另測：這裡把全域每日預算設成 1 並先用掉，之後的寫入都只走全域每小時上限
    const s = await startWorker({ varsOverride: { RL_WRITE_GLOBAL_PER_HOUR: '4', RL_WRITE_GLOBAL_PER_DAY: '1' } });
    try {
      const ps = [];
      for (let i = 0; i < 3; i++) ps.push(await newPlayer(s));
      expect((await clear((await newPlayer(s)).token, s)).status).toBe(200);
      const put = await putSave(s, ps[0].token, 1, sampleSave());
      expect(put.status).toBe(200);
      const { version } = await put.json();
      expect((await s.fetch('/api/save/1', { method: 'DELETE', headers: auth(ps[0].token, { 'if-match': `"${version}"` }) })).status).toBe(204);
      expect((await s.fetch('/api/clear', { method: 'POST', headers: auth(ps[1].token, { 'content-type': 'application/json' }), body: clearBody })).status).toBe(200);
      expect((await doRotate(s, ps[2].token)).status).toBe(200);
      const attempts = [
        () => putSave(s, ps[1].token, 1, sampleSave()),
        () => s.fetch('/api/save/1', { method: 'DELETE', headers: auth(ps[2].token, { 'if-match': '"1"' }) }),
        () => s.fetch('/api/clear', { method: 'POST', headers: auth(ps[2].token, { 'content-type': 'application/json' }), body: clearBody }),
        () => doRotate(s, ps[0].token),
      ];
      const before = (await s.db.prepare("SELECT count FROM rate_limits WHERE bucket = 'g:write'").first()).count;
      expect(before).toBe(4);
      for (const a of attempts) {
        const res = await a();
        expect(d1Rows(res).written).toBe(0);
        await expect429(res);
      }
      expect((await s.db.prepare("SELECT count FROM rate_limits WHERE bucket = 'g:write'").first()).count).toBe(4);
      // 讀取不受影響
      expect((await s.fetch('/api/saves', { headers: auth(ps[0].token) })).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe('容量上限 MAX_PLAYERS（修訂 2 D）', () => {
  it('達到上限後 POST /api/player 回 503 capacity；已建立的權杖重送仍回 200；刪掉玩家後又能建立', async () => {
    const s = await startWorker({ varsOverride: { MAX_PLAYERS: '2' } });
    try {
      const first = newSecrets();
      expect((await create(s, '192.0.2.1', first)).status).toBe(201);
      expect((await create(s, '192.0.2.2')).status).toBe(201);
      const res = await create(s, '192.0.2.3');
      const body = await expectError(res, 503, 'capacity');
      expect(body.message).toBe('雲端存檔目前額滿，請稍後再試。');
      expect((await s.db.prepare('SELECT COUNT(*) AS n FROM players').first()).n).toBe(2);
      expect((await create(s, '192.0.2.4', first)).status).toBe(200); // 冪等重送不受容量影響
      await s.db.prepare('DELETE FROM players WHERE token_hash != (SELECT token_hash FROM players LIMIT 1)').run();
      expect((await create(s, '192.0.2.5')).status).toBe(201);
    } finally {
      await s.close();
    }
  });

  it('容量檢查不掃描整張 players（讀取列數與玩家數無關）', async () => {
    const s = await startWorker();
    try {
      await s.db.prepare(`INSERT INTO players (player_id, token_hash, transfer_hash, created_at, last_seen)
        SELECT 'p' || value, 't' || value, 'x' || value, 0, 0 FROM json_each(?)`).bind(JSON.stringify(Array.from({ length: 2000 }, (_, i) => i))).run();
      const res = await create(s, '192.0.2.9');
      expect(res.status).toBe(201);
      expect(d1Rows(res).read).toBeLessThan(20);
    } finally {
      await s.close();
    }
  });
});

describe('限流值由 vars 決定', () => {
  it('把 RL_PLAYER_PER_HOUR 調成 1 → 第 2 次就 429', async () => {
    const s = await startWorker({ varsOverride: { RL_PLAYER_PER_HOUR: '1' } });
    try {
      expect((await create(s, '192.0.2.1')).status).toBe(201);
      await expect429(await create(s, '192.0.2.1'));
    } finally {
      await s.close();
    }
  });
});
