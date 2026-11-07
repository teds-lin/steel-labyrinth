// Cron 清理的結構化 log：每次執行一行 JSON（事件、時間、刪除數、批次、耗時），不含任何 player_id 或權杖，也不增加 D1 寫入。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startWorker, newPlayer } from './helpers.js';
import worker from '../../worker/src/index.js';

const DAY = 86400;

describe('Cron：purge 結構化 log', () => {
  let w;
  beforeAll(async () => { w = await startWorker(); });
  afterAll(async () => { await w?.close(); });

  it('scheduled 印出一行 JSON：刪除玩家數、過期限流數、批次、耗時；不含 player_id', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await newPlayer(w);
    await w.db.prepare('UPDATE players SET last_seen = ? WHERE player_id = ?').bind(now - 180 * DAY - 10, stale.player_id).run();
    await w.db.batch([
      w.db.prepare('INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)').bind('test:old1', now - 1),
      w.db.prepare('INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)').bind('test:old2', now - 5),
    ]);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await worker.scheduled({ scheduledTime: now * 1000 }, { DB: w.db, PURGE_BATCH: '450' }, null);
      const lines = spy.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('"event":"purge"'));
      expect(lines).toHaveLength(1);
      const o = JSON.parse(lines[0]);
      expect(o.event).toBe('purge');
      expect(new Date(o.at).toISOString()).toBe(o.at);
      expect(o.deleted_players).toBe(1);
      expect(o.expired_rate_limits).toBeGreaterThanOrEqual(2);
      expect(o.batch).toBe(450);
      expect(typeof o.ms).toBe('number');
      expect(o.ms).toBeGreaterThanOrEqual(0);
      expect(lines[0]).not.toContain(stale.player_id);
      expect(lines[0]).not.toContain(stale.token);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── 每日清理的執行紀錄（purge_runs，2026-11-07）：Workers Logs 只保留 3 天，D1 保留 60 天，漏跑的日子查得出來 ──
import { recordPurgeRun, PURGE_RUNS_KEEP_DAYS } from '../../worker/src/purge-runs.js';

const utcDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

describe('Cron：purge_runs 執行紀錄', () => {
  let w;
  beforeAll(async () => { w = await startWorker(); });
  afterAll(async () => { await w?.close(); });
  const rows = async () => (await w.db.prepare('SELECT * FROM purge_runs ORDER BY day').all()).results;
  const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  it('scheduled 清理完成後寫一列：UTC 日期、排程時間、刪除數、過期限流數、批次、耗時（與 log 一致）', async () => {
    await w.db.prepare('DELETE FROM purge_runs').run();
    const now = Math.floor(Date.now() / 1000);
    const stale = await newPlayer(w);
    await w.db.prepare('UPDATE players SET last_seen = ? WHERE player_id = ?').bind(now - 180 * DAY - 10, stale.player_id).run();
    const spy = quiet();
    try {
      await worker.scheduled({ scheduledTime: now * 1000 }, { DB: w.db, PURGE_BATCH: '450' }, null);
      const log = JSON.parse(spy.mock.calls.map((c) => c.join(' ')).find((l) => l.includes('"event":"purge"')));
      const r = await rows();
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ day: utcDay(now), at: now, deleted_players: 1, expired_rate_limits: log.expired_rate_limits, batch: 450, ms: log.ms });
    } finally { spy.mockRestore(); }
  });

  it('同一天再跑一次：覆蓋成最新一次（不會多一列）', async () => {
    await w.db.prepare('DELETE FROM purge_runs').run();
    const now = Math.floor(Date.now() / 1000);
    const spy = quiet();
    try {
      await worker.scheduled({ scheduledTime: now * 1000 }, { DB: w.db, PURGE_BATCH: '450' }, null);
      await worker.scheduled({ scheduledTime: (now + 60) * 1000 }, { DB: w.db, PURGE_BATCH: '450' }, null);
    } finally { spy.mockRestore(); }
    const r = await rows();
    expect(r).toHaveLength(utcDay(now) === utcDay(now + 60) ? 1 : 2);
    expect(r.at(-1).at).toBe(now + 60);
  });

  it(`只保留最近 ${60} 天：更舊的紀錄在寫入時刪掉`, async () => {
    expect(PURGE_RUNS_KEEP_DAYS).toBe(60);
    await w.db.prepare('DELETE FROM purge_runs').run();
    const now = Math.floor(Date.now() / 1000);
    const ins = (d) => w.db.prepare('INSERT INTO purge_runs (day, at, deleted_players, expired_rate_limits, batch, ms) VALUES (?, ?, 0, 0, 450, 1)').bind(utcDay(now - d * DAY), now - d * DAY);
    await w.db.batch([ins(61), ins(60), ins(59), ins(1)]);
    await recordPurgeRun(w.db, now, { deleted_players: 0, expired_rate_limits: 0, batch: 450, ms: 5 });
    expect((await rows()).map((r) => r.day)).toEqual([utcDay(now - 59 * DAY), utcDay(now - DAY), utcDay(now)]);
  });

  it('寫紀錄失敗（例如資料表不存在）：清理照樣完成、不丟例外，另外印一行 purge_record_failed', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await newPlayer(w);
    await w.db.prepare('UPDATE players SET last_seen = ? WHERE player_id = ?').bind(now - 180 * DAY - 10, stale.player_id).run();
    const broken = new Proxy(w.db, {
      get(t, k) {
        if (k === 'prepare') return (sql) => (sql.includes('purge_runs') ? t.prepare(sql.replace(/purge_runs/g, 'purge_runs_missing')) : t.prepare(sql));
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const spy = quiet();
    try {
      await worker.scheduled({ scheduledTime: now * 1000 }, { DB: broken, PURGE_BATCH: '450' }, null); // 不丟例外
      const lines = spy.mock.calls.map((c) => c.join(' '));
      expect(lines.filter((l) => l.includes('"event":"purge"'))).toHaveLength(1);
      const fail = lines.filter((l) => l.includes('"event":"purge_record_failed"'));
      expect(fail).toHaveLength(1);
      expect(fail[0]).not.toContain(stale.player_id);
    } finally { spy.mockRestore(); }
    expect((await w.db.prepare('SELECT COUNT(*) AS n FROM players WHERE player_id = ?').bind(stale.player_id).first()).n).toBe(0);
  });
});
