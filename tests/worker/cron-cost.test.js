// 修訂 2 D／修訂 4：Cron Trigger 定期清理；一般請求不再順便清理；每種請求的 D1 讀寫列數上限（用 x-d1-rows 實測）；
// 惡意流量的每日寫入上限依修訂 4 第 6 節的算式重算。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  startWorker, newPlayer, newSecrets, doTransfer, doRotate, json, auth, putSave, sampleSave, d1Rows, readWranglerConfig, ROOT,
  tsToken, loadDreamFixtures, getPass, dreamChat, aiReply,
} from './helpers.js';
import { purge } from '../../worker/src/index.js';

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

// 實測上限（2026-10-17，修訂 4b 之後：限流改成一條原子敘述，讀取列數變多、寫入列數不變）。改變寫入路徑時這張表會擋下來，連帶重算每日寫入上限。
// 已登入寫入分兩種通道量測：［保留］＝每位玩家每小時前 3 次（計入全域每日預算）；［每小時］＝其餘（計入全域每小時上限）。
const MAX_ROWS = {
  'POST /api/player（新建，IPv4）': { read: 15, written: 7 },
  'POST /api/player（新建，IPv6）': { read: 19, written: 8 },
  'POST /api/player（冪等重送）': { read: 11, written: 2 },
  'POST /api/player（轉移碼碰撞 409，IPv6）': { read: 29, written: 6 },
  'GET /api/saves': { read: 1, written: 0 },
  'GET /api/saves（當天第一次，更新 last_seen）': { read: 2, written: 1 },
  'GET /api/save/1': { read: 2, written: 0 },
  'POST /api/transfer（成功，IPv6）': { read: 16, written: 6 },
  'POST /api/transfer（碼錯，IPv6）': { read: 15, written: 3 },
  'POST /api/transfer/rotate（重送已生效的碼）': { read: 1, written: 0 },
  'GET /api/stats（未快取）': { read: 1, written: 0 },
  'GET /api/stats（快取）': { read: 0, written: 0 },
  '401（錯誤權杖）': { read: 0, written: 0 },
  // M4 鐘塔之夢（Turnstile 不碰 D1；失敗時只有限流計數）
  'POST /api/player（Turnstile 失敗）': { read: 10, written: 2 },
  'POST /api/dream/pass': { read: 10, written: 2 },
  'POST /api/dream/pass（Turnstile 失敗）': { read: 11, written: 2 },
  'POST /api/dream/chat（AI 成功）': { read: 15, written: 3 },
  'POST /api/dream/chat（重試後成功）': { read: 21, written: 4 },
  'POST /api/dream/chat（重試後仍過濾）': { read: 22, written: 5 },
  'POST /api/dream/chat（AI 錯誤）': { read: 14, written: 3 },
  'POST /api/dream/chat（額度用完）': { read: 8, written: 0 },
  'POST /api/dream/chat（預算用完）': { read: 8, written: 0 },
  'POST /api/dream/chat（通行證無效）': { read: 1, written: 0 },
};
/** 每種夢客對話實際呼叫 AI 的次數（算「每次 AI 呼叫最多寫幾列」用）。 */
const CHAT_CALLS = {
  'POST /api/dream/chat（AI 成功）': 1, 'POST /api/dream/chat（重試後成功）': 2, 'POST /api/dream/chat（重試後仍過濾）': 2, 'POST /api/dream/chat（AI 錯誤）': 1,
};
const WRITE_KINDS = ['PUT（新建）', 'PUT（覆蓋）', 'PUT（409）', 'DELETE', 'PUT（刪除後重建）',
  'POST /api/clear（新紀錄）', 'POST /api/clear（改善成績）', 'POST /api/clear（沒有改善）', 'POST /api/transfer/rotate',
  'POST /api/transfer/rotate（碰撞 409，IPv6）'];
const LANE_ROWS = {
  保留: {
    'PUT（新建）': { read: 16, written: 5 }, 'PUT（覆蓋）': { read: 19, written: 4 }, 'PUT（409）': { read: 20, written: 3 },
    DELETE: { read: 16, written: 4 }, 'PUT（刪除後重建）': { read: 19, written: 4 },
    'POST /api/clear（新紀錄）': { read: 16, written: 6 }, 'POST /api/clear（改善成績）': { read: 20, written: 5 }, 'POST /api/clear（沒有改善）': { read: 19, written: 3 },
    'POST /api/transfer/rotate': { read: 17, written: 5 }, 'POST /api/transfer/rotate（碰撞 409，IPv6）': { read: 30, written: 6 },
  },
  每小時: {
    'PUT（新建）': { read: 17, written: 4 }, 'PUT（覆蓋）': { read: 18, written: 3 }, 'PUT（409）': { read: 21, written: 2 },
    DELETE: { read: 17, written: 3 }, 'PUT（刪除後重建）': { read: 20, written: 3 },
    'POST /api/clear（新紀錄）': { read: 17, written: 5 }, 'POST /api/clear（改善成績）': { read: 21, written: 4 }, 'POST /api/clear（沒有改善）': { read: 20, written: 2 },
    'POST /api/transfer/rotate': { read: 18, written: 4 }, 'POST /api/transfer/rotate（碰撞 409，IPv6）': { read: 31, written: 5 },
  },
};
const OUT = join(ROOT, 'test-results', 'cron-cost.txt');

/**
 * 依序量測每種請求（lane：'保留'｜'每小時'｜null＝不量已登入寫入）。回傳 { 名稱: { read, written, newBuckets } }；
 * newBuckets＝這個請求在 rate_limits 新增了幾列（之後 Cron 刪除時各要再寫 1 列）。
 */
async function measureAll(w, lane) {
  const out = {};
  const rlRows = async () => (await w.db.prepare('SELECT COUNT(*) AS n FROM rate_limits').first()).n;
  const rec = async (name, call) => {
    const before = await rlRows();
    const res = await call();
    out[name] = { ...d1Rows(res), newBuckets: (await rlRows()) - before, status: res.status };
    await res.arrayBuffer();
    return res;
  };
  // 讓全域 bucket 先存在（它們是固定幾列，另外計入常數）
  await newPlayer(w);
  const fresh = await newPlayer(w);
  await putSave(w, fresh.token, 1, sampleSave());
  await doTransfer(w, 'ABCD-EFGH');
  if (lane === '每小時') { // 全域每小時 bucket 也先建立
    const q = await newPlayer(w);
    await w.db.prepare('INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1000, ?)').bind(`pl:rsv:${q.player_id}`, Math.floor(Date.now() / 1000) + 3600).run();
    await putSave(w, q.token, 1, sampleSave());
  }

  if (lane === null) {
    const s = newSecrets();
    await rec('POST /api/player（新建，IPv4）', () => w.fetch('/api/player', json(s, { 'cf-connecting-ip': w.nextIp() })));
    await rec('POST /api/player（冪等重送）', () => w.fetch('/api/player', json(s, { 'cf-connecting-ip': w.nextIp() })));
    await rec('POST /api/player（新建，IPv6）', () => w.fetch('/api/player', json(newSecrets(), { 'cf-connecting-ip': '2001:db8:501::1' })));
    await rec('POST /api/player（轉移碼碰撞 409，IPv6）', () => w.fetch('/api/player', json({ token: newSecrets().token, transfer_code: s.transfer_code, turnstile_token: tsToken('create_player') }, { 'cf-connecting-ip': '2001:db8:502::1' })));
    const token = s.token;
    await rec('GET /api/saves', () => w.fetch('/api/saves', { headers: auth(token) }));
    await w.db.prepare('UPDATE players SET last_seen = 0 WHERE token_hash IS NOT NULL').run();
    await rec('GET /api/saves（當天第一次，更新 last_seen）', () => w.fetch('/api/saves', { headers: auth(token) }));
    await putSave(w, token, 1, sampleSave());
    await rec('GET /api/save/1', () => w.fetch('/api/save/1', { headers: auth(token) }));
    const code = newSecrets().transfer_code;
    await doRotate(w, token, code);
    await rec('POST /api/transfer/rotate（重送已生效的碼）', () => doRotate(w, token, code));
    await rec('POST /api/transfer（成功，IPv6）', async () => (await doTransfer(w, code, { ip: '2001:db8:503::1' })).res);
    await rec('POST /api/transfer（碼錯，IPv6）', async () => (await doTransfer(w, 'ABCD-EFGH', { ip: '2001:db8:504::1' })).res);
    await rec('GET /api/stats（未快取）', () => w.fetch('/api/stats'));
    await rec('GET /api/stats（快取）', () => w.fetch('/api/stats'));
    await rec('401（錯誤權杖）', () => w.fetch('/api/saves', { headers: auth('A'.repeat(43)) }));
    // ---- M4 ----
    await rec('POST /api/player（Turnstile 失敗）', () => w.fetch('/api/player', json({ ...newSecrets(), turnstile_token: 'fail' }, { 'cf-connecting-ip': w.nextIp() })));
    await loadDreamFixtures(w);
    const passBody = { turnstile_token: tsToken('dream_pass') };
    let d = await newPlayer(w);
    await rec('POST /api/dream/pass', () => w.fetch('/api/dream/pass', json(passBody, auth(d.token))));
    d = await newPlayer(w);
    await rec('POST /api/dream/pass（Turnstile 失敗）', () => w.fetch('/api/dream/pass', json({ turnstile_token: 'fail' }, auth(d.token))));
    const chatBody = async (pl) => ({ pass: await getPass(w, pl.token), guest: 'lamp', chapter: 'chapter1', history: [], input: '你好' });
    const chatCase = async (name, ai, prep) => {
      const pl = await newPlayer(w);
      const body = await chatBody(pl);
      if (prep) await prep(pl);
      w.setAi(ai);
      await rec(name, () => dreamChat(w, pl.token, body));
    };
    const usage = { usage: { prompt_tokens: 800, completion_tokens: 50, total_tokens: 850 } };
    await chatCase('POST /api/dream/chat（AI 成功）', () => aiReply('燈還亮著。', usage));
    await chatCase('POST /api/dream/chat（重試後成功）', (c, n) => aiReply(n === 1 ? '这是燈。' : '燈還亮著。', usage));
    await chatCase('POST /api/dream/chat（重試後仍過濾）', () => aiReply('这是燈。', usage));
    await chatCase('POST /api/dream/chat（AI 錯誤）', () => { throw new Error('boom'); });
    const now = Math.floor(Date.now() / 1000);
    const midnight = (Math.floor(now / DAY) + 1) * DAY;
    await chatCase('POST /api/dream/chat（額度用完）', () => aiReply('燈。'), (pl) => w.db.prepare('INSERT OR REPLACE INTO rate_limits (bucket, count, reset_at) VALUES (?, 20, ?)').bind(`pl:dchat:${pl.player_id}`, midnight).run());
    const neuronsBucket = `g:neurons:${new Date(now * 1000).toISOString().slice(0, 10)}`;
    await chatCase('POST /api/dream/chat（預算用完）', () => aiReply('燈。'), () => w.db.prepare('INSERT OR REPLACE INTO rate_limits (bucket, count, reset_at) VALUES (?, 8000, ?)').bind(neuronsBucket, midnight).run());
    await w.db.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(neuronsBucket).run();
    out['POST /api/dream/chat（通行證無效）'] = await (async () => {
      const pl = await newPlayer(w);
      const res = await dreamChat(w, pl.token, { pass: 'x.y', guest: 'lamp', chapter: 'chapter1', input: '你好' });
      const r = { ...d1Rows(res), newBuckets: 0, status: res.status };
      await res.arrayBuffer();
      return r;
    })();
    return out;
  }

  // 已登入寫入：每種請求用一個新玩家（第一次寫入 → 新增該玩家的 bucket），量到最壞情況
  const player = async () => {
    const p = await newPlayer(w);
    if (lane === '每小時') await w.db.prepare('INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1000, ?)').bind(`pl:rsv:${p.player_id}`, Math.floor(Date.now() / 1000) + 3600).run();
    return p;
  };
  const clearReq = (token, ps) => w.fetch('/api/clear', {
    method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), body: JSON.stringify({ chapter: 'chapter1', play_seconds: ps, collapse: 0 }),
  });
  let p = await player();
  await rec('PUT（新建）', () => putSave(w, p.token, 1, sampleSave()));
  p = await player();
  await putSave(w, p.token, 1, sampleSave());
  if (lane === '每小時') await w.db.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(`pl:write:${p.player_id}`).run();
  await rec('PUT（覆蓋）', () => putSave(w, p.token, 1, sampleSave({ playtime_s: 999 }), { match: 1 }));
  await rec('PUT（409）', () => putSave(w, p.token, 1, sampleSave(), { match: 1 }));
  p = await player();
  await putSave(w, p.token, 1, sampleSave());
  await w.db.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(`pl:write:${p.player_id}`).run();
  if (lane === '保留') await w.db.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(`pl:rsv:${p.player_id}`).run();
  await rec('DELETE', () => w.fetch('/api/save/1', { method: 'DELETE', headers: auth(p.token, { 'if-match': '"1"' }) }));
  await rec('PUT（刪除後重建）', () => putSave(w, p.token, 1, sampleSave()));
  p = await player();
  await rec('POST /api/clear（新紀錄）', () => clearReq(p.token, 100));
  await rec('POST /api/clear（改善成績）', () => clearReq(p.token, 99));
  await rec('POST /api/clear（沒有改善）', () => clearReq(p.token, 500));
  p = await player();
  await rec('POST /api/transfer/rotate', () => doRotate(w, p.token));
  const other = await newPlayer(w);
  p = await player();
  await rec('POST /api/transfer/rotate（碰撞 409，IPv6）', () => w.fetch('/api/transfer/rotate',
    json({ new_transfer_code: other.transfer_code }, auth(p.token, { 'cf-connecting-ip': '2001:db8:505::1' }))));
  return out;
}

describe('每種請求的 D1 讀寫列數（x-d1-rows 實測；上限是回歸防線）', () => {
  const measured = {};
  afterAll(() => {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `D1 讀寫列數實測：\n${Object.entries(measured).map(([k, r]) => `  ${k.padEnd(44)} read=${r.read} written=${r.written} 新 bucket=${r.newBuckets}`).join('\n')}\n`);
  });

  it('不分通道的端點', async () => {
    const w = await startWorker({ varsOverride: { STATS_MIN_PLAYERS: '1' } });
    try {
      const m = await measureAll(w, null);
      for (const [k, max] of Object.entries(MAX_ROWS)) {
        expect(m[k], k).toBeDefined();
        measured[k] = m[k];
        expect(m[k].read, `${k} read`).toBeLessThanOrEqual(max.read);
        expect(m[k].written, `${k} written`).toBeLessThanOrEqual(max.written);
      }
      expect(Object.keys(m).sort()).toEqual(Object.keys(MAX_ROWS).sort());
      expect(m['POST /api/player（轉移碼碰撞 409，IPv6）'].status).toBe(409);
      expect(m['POST /api/transfer（成功，IPv6）'].status).toBe(200);
      expect(m['POST /api/player（Turnstile 失敗）'].status).toBe(403);
      expect(m['POST /api/dream/pass'].status).toBe(200);
      expect(m['POST /api/dream/pass（Turnstile 失敗）'].status).toBe(403);
      expect(m['POST /api/dream/chat（通行證無效）'].status).toBe(401);
      for (const k of Object.keys(CHAT_CALLS)) expect(m[k].status, k).toBe(200);
      // 改用預寫台詞（額度、預算）與無效通行證：一列都不寫
      for (const k of ['POST /api/dream/chat（額度用完）', 'POST /api/dream/chat（預算用完）', 'POST /api/dream/chat（通行證無效）']) expect(m[k].written, k).toBe(0);
    } finally {
      await w.close();
    }
  });

  it.each([['保留', {}], ['每小時', {}]])('已登入寫入：［%s］通道', async (lane) => {
    const w = await startWorker({ varsOverride: { STATS_MIN_PLAYERS: '1', RL_ROTATE_PER_HOUR: '100' } });
    try {
      const m = await measureAll(w, lane);
      const day = await w.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE bucket LIKE 'g:wday:%'").first();
      expect(day.n).toBeGreaterThan(0);
      for (const k of WRITE_KINDS) {
        expect(m[k], k).toBeDefined();
        measured[`${k}［${lane}］`] = m[k];
        expect(m[k].read, `${k}［${lane}］read`).toBeLessThanOrEqual(LANE_ROWS[lane][k].read);
        expect(m[k].written, `${k}［${lane}］written`).toBeLessThanOrEqual(LANE_ROWS[lane][k].written);
      }
      expect(m['POST /api/transfer/rotate（碰撞 409，IPv6）'].status).toBe(409);
    } finally {
      await w.close();
    }
  });
});

const PLAYER_KEYS = ['write', 'clear', 'rotate', 'rsv', 'transfer', 'dpass', 'dchat'];

/**
 * 實測 Cron 刪除一個「3 格存檔＋每章一筆通關紀錄＋5 種玩家限流 bucket」的玩家要寫幾列（含索引與 trigger）。
 * 玩家的限流 bucket 平常不清（原地重設），只在玩家被刪時一起刪，所以算在每人列數裡。
 */
async function purgeRowsPerPlayer(w) {
  const p = await newPlayer(w);
  for (let slot = 1; slot <= 3; slot++) expect((await putSave(w, p.token, slot, sampleSave())).status).toBe(200);
  for (const chapter of String(readWranglerConfig().vars.CHAPTERS).split(',')) {
    const r = await w.fetch('/api/clear', { method: 'POST', headers: auth(p.token, { 'content-type': 'application/json' }), body: JSON.stringify({ chapter, play_seconds: 10, collapse: 0 }) });
    expect(r.status).toBe(200);
  }
  await w.db.prepare('UPDATE players SET last_seen = 0 WHERE player_id = ?').bind(p.player_id).run();
  for (const k of PLAYER_KEYS) {
    await w.db.prepare('INSERT OR REPLACE INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, 1)').bind(`pl:${k}:${p.player_id}`).run();
  }
  // 只量玩家本身：IP／全域的過期限流紀錄另外計（先清掉，避免混在一起）
  await w.db.prepare("DELETE FROM rate_limits WHERE substr(bucket, 1, 3) <> 'pl:'").run();
  const meter = metered(w.db);
  expect(await purge(meter.db, Math.floor(Date.now() / 1000))).toBe(1);
  expect((await w.db.prepare('SELECT COUNT(*) AS n FROM players WHERE player_id = ?').bind(p.player_id).first()).n).toBe(0);
  expect((await w.db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE bucket LIKE ?').bind(`%${p.player_id}`).first()).n).toBe(0);
  return meter.written();
}

/** 包一層 D1：累計 batch／all／run 的寫入列數。 */
function metered(db) {
  let written = 0;
  const wrap = (st) => ({
    bind: (...a) => wrap(st.bind(...a)),
    all: async () => { const r = await st.all(); written += r.meta.rows_written; return r; },
    run: async () => { const r = await st.run(); written += r.meta.rows_written; return r; },
    first: async () => (await st.all()).results[0] ?? null,
    raw: st,
  });
  return {
    db: {
      prepare: (sql) => wrap(db.prepare(sql)),
      batch: async (sts) => { const rs = await db.batch(sts.map((s) => s.raw ?? s)); for (const r of rs) written += r.meta.rows_written; return rs; },
    },
    written: () => written,
  };
}

describe('Cron 單次寫入列數上限（修訂 4 第 2、6 節）', () => {
  it('一次最多刪 PURGE_BATCH 人；玩家部分的寫入 ≤ PURGE_BATCH × 實測每人列數', async () => {
    const v = readWranglerConfig().vars;
    const batch = Number(v.PURGE_BATCH);
    expect(batch).toBe(500);
    const w = await startWorker();
    try {
      const perPerson = await purgeRowsPerPlayer(w);
      // 600 個「3 格存檔＋每章通關」的過期玩家（直接寫 SQL，trigger 照常運作）
      const old = 1000;
      const ids = JSON.stringify(Array.from({ length: 600 }, (_, i) => `z${String(i).padStart(4, '0')}`));
      const chapters = JSON.stringify(String(v.CHAPTERS).split(','));
      await w.db.batch([
        w.db.prepare(`INSERT INTO players (player_id, token_hash, transfer_hash, created_at, last_seen)
          SELECT value, 't' || value, 'x' || value, ?, ? FROM json_each(?)`).bind(old, old, ids),
        w.db.prepare(`INSERT INTO saves (player_id, slot, version, data, data_sha256, summary, updated_at)
          SELECT p.value, s.value, 1, '{}', 'h', '{}', ? FROM json_each(?) p, json_each('[1,2,3]') s`).bind(old, ids),
        w.db.prepare(`INSERT INTO clears (player_id, chapter, ending, play_seconds, collapse, created_at)
          SELECT p.value, c.value, NULL, 10, 0, ? FROM json_each(?) p, json_each(?) c`).bind(old, ids, chapters),
        w.db.prepare(`INSERT INTO rate_limits (bucket, count, reset_at)
          SELECT 'pl:' || k.value || ':' || p.value, 1, 1 FROM json_each(?) p, json_each(?) k`).bind(ids, JSON.stringify(PLAYER_KEYS)),
      ]);
      const meter = metered(w.db);
      const deleted = await purge(meter.db, Math.floor(Date.now() / 1000), { batch });
      expect(deleted).toBe(batch);
      expect(meter.written()).toBeLessThanOrEqual(batch * perPerson);
      expect((await w.db.prepare("SELECT COUNT(*) AS n FROM players WHERE player_id LIKE 'z%'").first()).n).toBe(100);
      // scheduled() 用的是 vars 的 PURGE_BATCH
      await w.scheduled(Date.now());
      expect((await w.db.prepare("SELECT COUNT(*) AS n FROM players WHERE player_id LIKE 'z%'").first()).n).toBe(0);
      const stats = await w.db.prepare("SELECT players FROM chapter_stats WHERE chapter = 'prologue'").first();
      expect(stats?.players ?? 0).toBe(0);
      writeFileSync(join(ROOT, 'test-results', 'cron-batch.txt'), `Cron 一次刪 ${deleted} 人：寫入 ${meter.written()} 列（每人上限 ${perPerson} 列 → 上限 ${batch * perPerson}）\n`);
    } finally {
      await w.close();
    }
  });
});

/**
 * 並行失敗路徑的實測：單一帳號並行 33 個寫入（20 PUT＋10 clear＋3 rotate），分別在「全域每小時上限已滿」與
 * 「全域每日預算與每小時上限都已滿」時送出；回傳所有 429 回應的寫入列數總和（應為 0）。
 */
async function concurrentRejectedWrites() {
  const w = await startWorker();
  let wasted = 0;
  try {
    const now = Math.floor(Date.now() / 1000);
    const fill = (b, c, r) => w.db.prepare('INSERT OR REPLACE INTO rate_limits (bucket, count, reset_at) VALUES (?, ?, ?)').bind(b, c, r).run();
    const v = readWranglerConfig().vars;
    await fill('g:write', Number(v.RL_WRITE_GLOBAL_PER_HOUR), now + 3600);
    for (const dayFull of [false, true]) {
      if (dayFull) await fill(`g:wday:${new Date(now * 1000).toISOString().slice(0, 10)}`, Number(v.RL_WRITE_GLOBAL_PER_DAY), (Math.floor(now / DAY) + 1) * DAY);
      const p = await newPlayer(w);
      const reqs = [];
      for (let i = 0; i < 20; i++) reqs.push(putSave(w, p.token, (i % 3) + 1, sampleSave({ playtime_s: i })));
      for (let i = 0; i < 10; i++) {
        reqs.push(w.fetch('/api/clear', { method: 'POST', headers: auth(p.token, { 'content-type': 'application/json' }), body: JSON.stringify({ chapter: 'chapter1', play_seconds: 100 + i, collapse: 0 }) }));
      }
      for (let i = 0; i < 3; i++) reqs.push(doRotate(w, p.token));
      let rejected = 0;
      for (const r of await Promise.all(reqs)) {
        if (r.status === 429) { wasted += d1Rows(r).written; rejected++; }
        await r.arrayBuffer();
      }
      expect(rejected).toBe(dayFull ? 33 : 30);
    }
  } finally {
    await w.close();
  }
  return wasted;
}

describe('惡意流量的每日寫入上限 < 10 萬列（修訂 4 第 6 節；用 wrangler.toml 的實際 vars 計算）', () => {
  it('上限＝各全域額度 × 25 個時間窗 × 該類請求的最大寫入列數＋保留通道每日預算＋last_seen＋Cron＋限流紀錄清理＋並行失敗路徑', async () => {
    const v = readWranglerConfig().vars;
    const n = (k) => { const x = Number(v[k]); expect(Number.isInteger(x) && x > 0, k).toBe(true); return x; };
    const windows = 25; // 固定時間窗從第一次命中起算 1 小時，一個 UTC 日最多跨到 25 個窗
    const wr = (k) => MAX_ROWS[k].written;
    const lane = (name, ks = WRITE_KINDS) => Math.max(...ks.map((k) => LANE_ROWS[name][k].written));
    // 已登入寫入：每一次都當作「新通關」（最貴的一種）計——新通關的額外寫入以已登入寫入次數上限計。
    // rotate 碰撞 409 另外計入轉移額度（g:transfer），它多出來的限流列數算在轉移那一項，所以這裡排除它：
    const plainKinds = WRITE_KINDS.filter((k) => !k.includes('碰撞'));
    for (const name of ['保留', '每小時']) {
      expect(LANE_ROWS[name]['POST /api/transfer/rotate（碰撞 409，IPv6）'].written - LANE_ROWS[name]['POST /api/transfer/rotate'].written)
        .toBeLessThanOrEqual(wr('POST /api/transfer（成功，IPv6）'));
    }
    expect(wr('POST /api/player（轉移碼碰撞 409，IPv6）')).toBeLessThanOrEqual(wr('POST /api/player（新建，IPv6）'));

    const playerReq = n('RL_PLAYER_GLOBAL_PER_HOUR') * windows;
    const transferReq = n('RL_TRANSFER_GLOBAL_PER_HOUR') * windows; // 含 player／rotate 碰撞 409（共用 g:transfer）
    const hourlyReq = n('RL_WRITE_GLOBAL_PER_HOUR') * windows;
    const reservedReq = n('RL_WRITE_GLOBAL_PER_DAY'); // 保留通道：帶日期的 bucket，一個 UTC 日就是一個窗
    const players = playerReq * Math.max(wr('POST /api/player（新建，IPv4）'), wr('POST /api/player（新建，IPv6）'), wr('POST /api/player（冪等重送）'));
    const transfers = transferReq * Math.max(wr('POST /api/transfer（成功，IPv6）'), wr('POST /api/transfer（碼錯，IPv6）'));
    const hourly = hourlyReq * lane('每小時', plainKinds);
    const reserved = reservedReq * lane('保留', plainKinds);
    // 每個玩家每天最多一次 last_seen 更新（任何已登入請求，包括讀取）
    const lastSeen = n('MAX_PLAYERS') * (wr('GET /api/saves（當天第一次，更新 last_seen）') - wr('GET /api/saves'));
    // Cron：每天一次，最多 PURGE_BATCH 人
    const w = await startWorker();
    let perPerson;
    try { perPerson = await purgeRowsPerPlayer(w); } finally { await w.close(); }
    const cron = n('PURGE_BATCH') * perPerson;
    // 限流紀錄清理：IP bucket 每天換鹽，建立後 Cron 刪除時再寫 1 列。每個請求最多新增幾列由下一個測試實測斷言：
    // 建立玩家／轉移（IPv6 的 /64＋/48）≤ 2；全域 bucket（g:player、g:transfer、g:write、g:wday）每天至多 4 列。
    // 玩家的 bucket（pl:*）原地重設、不每天清，只在玩家被刪時一起刪（已含在 Cron 每人列數）。
    const rlPurge = playerReq * 2 + transferReq * 2 + 4;
    // 並行失敗路徑（修訂 4b 第 1 節）：限流改成一條原子敘述，被擋下的請求（含並行搶輸保留名額、每日預算剛好用完而退到
    // 每小時通道又被擋的請求）一列都不寫，所以這一項以「每個 429 的實測寫入列數 × 不設上限的次數」計＝必須是 0。
    // 退到每小時通道而成功的請求，寫入列數與每小時通道相同（保留名額不被消耗），已含在 hourly。
    const raceWaste = await concurrentRejectedWrites();
    expect(raceWaste).toBe(0);
    // M4：Turnstile 失敗的建立玩家只寫限流計數，算在「建立玩家」那一項（不多於成功建立）
    expect(wr('POST /api/player（Turnstile 失敗）')).toBeLessThanOrEqual(wr('POST /api/player（新建，IPv4）'));
    // M4：夢境通行證＝全站每小時上限 × 25 窗 × 每次最多寫入列數（Turnstile 失敗也計入限流）
    const passReq = n('RL_DREAM_PASS_GLOBAL_PER_HOUR') * windows;
    const passes = passReq * Math.max(wr('POST /api/dream/pass'), wr('POST /api/dream/pass（Turnstile 失敗）'));
    // M4：夢客對話。每次寫入都要先在全站每日 neurons 預算預扣成功，而每次 AI 呼叫最少計 DREAM_NEURONS_MIN_PER_CALL，
    // 所以每日 AI 呼叫次數 ≤ DREAM_NEURONS_PER_DAY ÷ DREAM_NEURONS_MIN_PER_CALL；改用預寫台詞（額度、預算）寫 0 列。
    const aiCalls = Math.floor(n('DREAM_NEURONS_PER_DAY') / n('DREAM_NEURONS_MIN_PER_CALL'));
    const rowsPerCall = Math.max(...Object.entries(CHAT_CALLS).map(([k, c]) => Math.ceil(wr(k) / c)));
    const chats = aiCalls * rowsPerCall;
    // 全域 bucket 多兩列：g:dpass、g:neurons:<日期>（每天由 Cron 刪除時各再寫 1 列）
    const dreamRlPurge = 2;
    const total = players + transfers + hourly + reserved + lastSeen + cron + rlPurge + raceWaste + passes + chats + dreamRlPurge;
    const line = `惡意流量每日寫入上限：建立玩家 ${players}＋轉移 ${transfers}＋已登入每小時通道 ${hourly}（${hourlyReq} 次 × ${lane('每小時', plainKinds)} 列）`
      + `＋保留通道 ${reserved}（${reservedReq} 次 × ${lane('保留', plainKinds)} 列）＋last_seen ${lastSeen}＋Cron ${cron}（${n('PURGE_BATCH')} 人 × ${perPerson} 列）`
      + `＋限流紀錄清理 ${rlPurge}＋並行失敗路徑 ${raceWaste}`
      + `＋夢境通行證 ${passes}（${passReq} 次 × ${passes / passReq} 列）＋夢客對話 ${chats}（${aiCalls} 次 AI 呼叫 × ${rowsPerCall} 列）＋夢境限流紀錄清理 ${dreamRlPurge}＝${total} 列`;
    mkdirSync(join(ROOT, 'test-results'), { recursive: true });
    writeFileSync(join(ROOT, 'test-results', 'cron-cost-total.txt'), `${line}\n`);
    console.log(line);
    expect(total).toBeLessThan(100000);
  });

  it('每個請求新增的 IP 限流列數不超過算式假設（IPv6 建立玩家／轉移 ≤ 2）；玩家 bucket 不會被每日清理', async () => {
    const w = await startWorker({ varsOverride: { RL_ROTATE_PER_HOUR: '100' } });
    try {
      const plain = await measureAll(w, null);
      expect(plain['POST /api/player（新建，IPv6）'].newBuckets).toBeLessThanOrEqual(2);
      expect(plain['POST /api/player（轉移碼碰撞 409，IPv6）'].newBuckets).toBeLessThanOrEqual(4); // 2（玩家）＋2（轉移，算在轉移額度）
      expect(plain['POST /api/transfer（成功，IPv6）'].newBuckets).toBeLessThanOrEqual(2);
      expect(plain['POST /api/transfer（碼錯，IPv6）'].newBuckets).toBeLessThanOrEqual(2);
    } finally {
      await w.close();
    }
    const s = await startWorker();
    try {
      const p = await newPlayer(s);
      expect((await putSave(s, p.token, 1, sampleSave())).status).toBe(200);
      await s.db.prepare('UPDATE rate_limits SET reset_at = 1').run(); // 全部過期
      await s.scheduled(Date.now());
      const left = await s.db.prepare('SELECT bucket FROM rate_limits').all();
      expect(left.results.map((r) => r.bucket).sort()).toEqual([`pl:rsv:${p.player_id}`, `pl:write:${p.player_id}`]);
    } finally {
      await s.close();
    }
  });
});
