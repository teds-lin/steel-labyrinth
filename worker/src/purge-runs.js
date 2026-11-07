// 每日清理的執行紀錄（purge_runs，migrations/0005）：Cron 清理完成後由 scheduled 呼叫。
// Workers Logs 在免費方案只保留 3 天；這張表保留 60 天，漏跑的日子查得到（tools/player-stats/stats.sh 唯讀查詢）。

/** 執行紀錄保留天數（purge_runs）。 */
export const PURGE_RUNS_KEEP_DAYS = 60;

/**
 * 寫一列清理的執行紀錄（UTC 日期為鍵，同一天重跑覆蓋），並刪掉超過 PURGE_RUNS_KEEP_DAYS 天的舊紀錄。每天約 2 列寫入，
 * 計入 tests/worker/cron-cost.test.js 的每日上限。Workers Logs 只保留 3 天，這張表讓漏跑的日子在 60 天內都查得到。
 */
export async function recordPurgeRun(db, now, s) {
  const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  await db.batch([
    // 同一天重跑：ON CONFLICT DO UPDATE 原地更新（寫入 1 列；INSERT OR REPLACE 在某些實作會算成刪除＋新增）
    db.prepare(`INSERT INTO purge_runs (day, at, deleted_players, expired_rate_limits, batch, ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET at = excluded.at, deleted_players = excluded.deleted_players,
        expired_rate_limits = excluded.expired_rate_limits, batch = excluded.batch, ms = excluded.ms`)
      .bind(day(now), now, s.deleted_players, s.expired_rate_limits, s.batch, s.ms),
    db.prepare('DELETE FROM purge_runs WHERE day < ?').bind(day(now - (PURGE_RUNS_KEEP_DAYS - 1) * 86400)),
  ]);
}
