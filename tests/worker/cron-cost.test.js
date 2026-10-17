// 修訂 2 D：Cron Trigger 定期清理；一般請求不再順便清理；每種請求的 D1 讀寫列數上限（用 x-d1-rows 實測）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startWorker, newPlayer, newSecrets, doTransfer, doRotate, json, auth, putSave, sampleSave, d1Rows, readWranglerConfig, ROOT,
} from './helpers.js';

const DAY = 86400;

describe('Cron：清理 180 天未登入的玩家與過期的限流紀錄', () => {
  let w;
  beforeAll(async () => { w = await startWorker({ varsOverride: { STATS_MIN_PLAYERS: '1' } }); });
  afterAll(async () => { await w?.close(); });

  it('刪除 last_seen 超過 180 天的玩家及其存檔、通關紀錄；其他保留；統計與容量計數跟著更新', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await newPlayer(w);
    const edge = await newPlayer(w);
    const fresh = await newPlayer(w);
    for (const p of [stale, edge, fresh]) {
      expect((await putSave(w, p.token, 1, sampleSave())).status).toBe(200);
      const c = await w.fetch('/api/clear', { method: 'POST', headers: auth(p.token, { 'content-type': 'application/json' }), body: JSON.stringify({ chapter: 'chapter1', play_seconds: 100, collapse: 0 }) });
      expect(c.status).toBe(200);
    }
    await w.db.prepare('UPDATE players SET last_seen = ? WHERE player_id = ?').bind(now - 180 * DAY - 10, stale.player_id).run();
    await w.db.prepare('UPDATE players SET last_seen = ? WHERE player_id = ?').bind(now - 180 * DAY + 3600, edge.player_id).run();
    const countBefore = (await w.db.prepare("SELECT value FROM counters WHERE name = 'players'").first()).value;

    const r = await w.scheduled(now * 1000);
    expect(r.outcome).toBe('ok');

    const left = await w.db.prepare('SELECT player_id FROM players WHERE player_id IN (?, ?, ?)').bind(stale.player_id, edge.player_id, fresh.player_id).all();
    expect(left.results.map((x) => x.player_id).sort()).toEqual([edge.player_id, fresh.player_id].sort());
    for (const t of ['saves', 'clears']) {
      expect((await w.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE player_id = ?`).bind(stale.player_id).first()).n).toBe(0);
      expect((await w.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE player_id = ?`).bind(fresh.player_id).first()).n).toBe(1);
    }
    expect((await w.db.prepare("SELECT value FROM counters WHERE name = 'players'").first()).value).toBe(countBefore - 1);
    expect((await w.db.prepare("SELECT players FROM chapter_stats WHERE chapter = 'chapter1'").first()).players).toBe(2);
    await expectStatus(await w.fetch('/api/saves', { headers: auth(stale.token) }), 401);
    await expectStatus(await w.fetch('/api/saves', { headers: auth(fresh.token) }), 200);
  });

  it('刪除過期的 rate_limits（reset_at ≤ 現在），未過期的保留', async () => {
    const now = Math.floor(Date.now() / 1000);
    await w.db.batch([
      w.db.prepare('INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)').bind('test:old', now - 1),
      w.db.prepare('INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)').bind('test:new', now + 100),
    ]);
    await w.scheduled(now * 1000);
    const rows = await w.db.prepare("SELECT bucket FROM rate_limits WHERE bucket LIKE 'test:%'").all();
    expect(rows.results.map((x) => x.bucket)).toEqual(['test:new']);
  });

  it('一般請求不再順便清理（ratelimit.js 不再有 maybePurge，index.js 不再呼叫）', async () => {
    const rl = await import('../../worker/src/ratelimit.js');
    expect(rl.maybePurge).toBeUndefined();
    expect(readFileSync(join(ROOT, 'worker', 'src', 'index.js'), 'utf8')).not.toMatch(/maybePurge|Math\.random/);
  });
});

async function expectStatus(res, status) {
  expect(res.status).toBe(status);
  await res.arrayBuffer();
}

// 實測上限（2026-10-17，修訂 3 之後）。改變寫入路徑時這張表會擋下來，連帶重算每日寫入上限。
const MAX_ROWS = {
  'POST /api/player（新建）': { read: 6, written: 7 },
  'POST /api/player（冪等重送）': { read: 4, written: 2 },
  'GET /api/saves': { read: 1, written: 0 },
  'GET /api/saves（當天第一次，更新 last_seen）': { read: 2, written: 1 },
  'PUT（新建）': { read: 4, written: 4 },
  'PUT（覆蓋）': { read: 6, written: 3 },
  'PUT（409）': { read: 7, written: 2 },
  'GET /api/save/1': { read: 2, written: 0 },
  'DELETE': { read: 5, written: 3 },
  'PUT（刪除後重建）': { read: 6, written: 3 },
  'POST /api/clear（新紀錄）': { read: 5, written: 5 },
  'POST /api/clear（改善成績）': { read: 7, written: 4 },
  'POST /api/clear（沒有改善）': { read: 6, written: 2 },
  'POST /api/transfer/rotate': { read: 5, written: 4 },
  'POST /api/transfer（成功）': { read: 4, written: 5 },
  'POST /api/transfer（碼錯）': { read: 4, written: 2 },
  'GET /api/stats（未快取）': { read: 1, written: 0 },
  'GET /api/stats（快取）': { read: 0, written: 0 },
  '401（錯誤權杖）': { read: 0, written: 0 },
};

describe('每種請求的 D1 讀寫列數（x-d1-rows 實測；上限是回歸防線）', () => {
  let w;
  const measured = {};
  beforeAll(async () => { w = await startWorker({ varsOverride: { STATS_MIN_PLAYERS: '1' } }); });
  afterAll(async () => {
    console.log(`D1 讀寫列數實測：\n${Object.entries(measured).map(([k, r]) => `  ${k.padEnd(36)} read=${r.read} written=${r.written}`).join('\n')}`);
    await w?.close();
  });
  const record = (name, res) => {
    const rows = d1Rows(res);
    measured[name] = rows;
    expect(rows.read, `${name} read`).toBeLessThanOrEqual(MAX_ROWS[name].read);
    expect(rows.written, `${name} written`).toBeLessThanOrEqual(MAX_ROWS[name].written);
    return rows;
  };
  const clearReq = (token, ps) => w.fetch('/api/clear', {
    method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), body: JSON.stringify({ chapter: 'chapter1', play_seconds: ps, collapse: 0 }),
  });

  it('各端點', async () => {
    const secrets = newSecrets();
    let res = await w.fetch('/api/player', json(secrets, { 'cf-connecting-ip': w.nextIp() }));
    expect(res.status).toBe(201);
    record('POST /api/player（新建）', res);
    res = await w.fetch('/api/player', json(secrets, { 'cf-connecting-ip': w.nextIp() }));
    expect(res.status).toBe(200);
    record('POST /api/player（冪等重送）', res);
    const token = secrets.token;

    res = await w.fetch('/api/saves', { headers: auth(token) });
    record('GET /api/saves', res);
    await w.db.prepare('UPDATE players SET last_seen = 0 WHERE token_hash IS NOT NULL').run();
    res = await w.fetch('/api/saves', { headers: auth(token) });
    record('GET /api/saves（當天第一次，更新 last_seen）', res);

    res = await putSave(w, token, 1, sampleSave());
    expect(res.status).toBe(200);
    record('PUT（新建）', res);
    res = await putSave(w, token, 1, sampleSave({ playtime_s: 999 }), { match: 1 });
    expect(res.status).toBe(200);
    record('PUT（覆蓋）', res);
    res = await putSave(w, token, 1, sampleSave(), { match: 1 });
    expect(res.status).toBe(409);
    record('PUT（409）', res);

    res = await w.fetch('/api/save/1', { headers: auth(token) });
    record('GET /api/save/1', res);

    res = await w.fetch('/api/save/1', { method: 'DELETE', headers: auth(token, { 'if-match': '"2"' }) });
    expect(res.status).toBe(204);
    record('DELETE', res);
    res = await putSave(w, token, 1, sampleSave());
    expect(res.status).toBe(200);
    record('PUT（刪除後重建）', res);

    res = await clearReq(token, 100);
    expect(res.status).toBe(200);
    record('POST /api/clear（新紀錄）', res);
    res = await clearReq(token, 99);
    expect(res.status).toBe(200);
    record('POST /api/clear（改善成績）', res);
    res = await clearReq(token, 500);
    expect(res.status).toBe(200);
    record('POST /api/clear（沒有改善）', res);

    res = await doRotate(w, token);
    expect(res.status).toBe(200);
    record('POST /api/transfer/rotate', res);

    const code = newSecrets().transfer_code;
    await doRotate(w, token, code);
    const t = await doTransfer(w, code);
    expect(t.res.status).toBe(200);
    record('POST /api/transfer（成功）', t.res);
    const miss = await doTransfer(w, 'ABCD-EFGH');
    record('POST /api/transfer（碼錯）', miss.res);

    res = await w.fetch('/api/stats');
    record('GET /api/stats（未快取）', res);
    res = await w.fetch('/api/stats');
    record('GET /api/stats（快取）', res);

    res = await w.fetch('/api/saves', { headers: auth('A'.repeat(43)) });
    record('401（錯誤權杖）', res);
    expect(Object.keys(measured).sort()).toEqual(Object.keys(MAX_ROWS).sort());
  });
});

describe('惡意流量的每日寫入上限 < 10 萬列（修訂 3；用 wrangler.toml 的實際 vars 計算）', () => {
  let w;
  beforeAll(async () => { w = await startWorker(); });
  afterAll(async () => { await w?.close(); });

  /** 實測 Cron 刪除一個「3 格存檔＋每章一筆通關紀錄」的玩家要寫幾列（含索引與 trigger）。 */
  async function purgeRowsPerPlayer() {
    const { purge } = await import('../../worker/src/index.js');
    const p = await newPlayer(w);
    for (let slot = 1; slot <= 3; slot++) expect((await putSave(w, p.token, slot, sampleSave())).status).toBe(200);
    for (const chapter of String(readWranglerConfig().vars.CHAPTERS).split(',')) {
      const r = await w.fetch('/api/clear', { method: 'POST', headers: auth(p.token, { 'content-type': 'application/json' }), body: JSON.stringify({ chapter, play_seconds: 10, collapse: 0 }) });
      expect(r.status).toBe(200);
    }
    await w.db.prepare('UPDATE players SET last_seen = 0 WHERE player_id = ?').bind(p.player_id).run();
    let written = 0;
    const db = { prepare: (sql) => w.db.prepare(sql), batch: async (st) => { const rs = await w.db.batch(st); for (const r of rs) written += r.meta.rows_written; return rs; } };
    await purge(db, Math.floor(Date.now() / 1000));
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM players WHERE player_id = ?').bind(p.player_id).first()).n).toBe(0);
    return written;
  }

  it('上限＝各全域上限 × 24 小時 × 該類請求的最大寫入列數＋每日 last_seen 更新＋Cron 清理', async () => {
    const v = readWranglerConfig().vars;
    const n = (k) => { const x = Number(v[k]); expect(Number.isInteger(x) && x > 0, k).toBe(true); return x; };
    const wr = (k) => MAX_ROWS[k].written;
    const maxOf = (...ks) => Math.max(...ks.map(wr));
    const hours = 24;
    const chapters = String(v.CHAPTERS).split(',').length;
    // 超額（429）、403、415、401 都是 0 列（其他測試斷言），只有全域額度內的請求會寫入；
    // 全域先只讀預檢，額滿後換再多來源也是 0 列。
    const newPlayersPerDay = Math.min(n('RL_PLAYER_GLOBAL_PER_HOUR') * hours, n('MAX_PLAYERS'));
    const players = n('RL_PLAYER_GLOBAL_PER_HOUR') * hours * maxOf('POST /api/player（新建）', 'POST /api/player（冪等重送）');
    const transfers = n('RL_TRANSFER_GLOBAL_PER_HOUR') * hours * maxOf('POST /api/transfer（成功）', 'POST /api/transfer（碼錯）');
    const authedEach = maxOf('PUT（新建）', 'PUT（覆蓋）', 'PUT（409）', 'DELETE', 'PUT（刪除後重建）',
      'POST /api/clear（改善成績）', 'POST /api/clear（沒有改善）', 'POST /api/transfer/rotate');
    const authed = n('RL_WRITE_GLOBAL_PER_HOUR') * hours * authedEach;
    // 「新紀錄」的 clear 比其他寫入多幾列，但每個玩家每章只有一次：每天最多（新玩家數 × 章節數）次
    const clearNewExtra = Math.max(0, wr('POST /api/clear（新紀錄）') - authedEach) * newPlayersPerDay * chapters;
    // 每個玩家每天最多一次 last_seen 更新（任何已登入請求，包括讀取）
    const lastSeen = n('MAX_PLAYERS') * (wr('GET /api/saves（當天第一次，更新 last_seen）') - wr('GET /api/saves'));
    // Cron：180 天前某一天建立、之後不再登入的玩家（每天最多 newPlayersPerDay 個）在同一天被刪除
    const purgeEach = await purgeRowsPerPlayer();
    const purge = newPlayersPerDay * purgeEach;
    const total = players + transfers + authed + clearNewExtra + lastSeen + purge;
    console.log(`惡意流量每日寫入上限：建立玩家 ${players}＋轉移 ${transfers}＋已登入寫入 ${authed}（每次 ${authedEach} 列）`
      + `＋新通關額外 ${clearNewExtra}＋last_seen ${lastSeen}＋Cron ${purge}（每人 ${purgeEach} 列）＝${total} 列`);
    expect(total).toBeLessThan(100000);
  });
});
