-- 《鋼鐵迷都》每日清理的執行紀錄（2026-11-07）。0001～0004 已套用，不可修改。
-- Cron 每次清理完成後寫一列（以 UTC 日期為鍵，同一天重跑會更新同一列），只保留最近 60 天。
-- Workers Logs 在免費方案只保留 3 天；這張表讓「哪一天漏跑」在 60 天內都查得到（tools/player-stats/stats.sh 唯讀查詢）。
-- 只有匯總數字，沒有任何 player_id 或權杖。
CREATE TABLE purge_runs (
  day                 TEXT    PRIMARY KEY,  -- UTC 日期 YYYY-MM-DD
  at                  INTEGER NOT NULL,     -- 排程時間（Unix 秒）
  deleted_players     INTEGER NOT NULL,
  expired_rate_limits INTEGER NOT NULL,
  batch               INTEGER NOT NULL,
  ms                  INTEGER NOT NULL
) WITHOUT ROWID;
