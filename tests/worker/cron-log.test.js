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
