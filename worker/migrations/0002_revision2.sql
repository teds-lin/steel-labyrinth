-- 《鋼鐵迷都》雲端存檔：API 修訂 2（M3 第一輪對抗審查）。0001 已套用，不可修改；所有變更放在這裡。

-- B：存檔雜湊。data 字串 UTF-8 的 SHA-256（小寫 hex）；空槽為 NULL。
ALTER TABLE saves ADD COLUMN data_sha256 TEXT;

-- D：限流表改成 WITHOUT ROWID、拿掉 reset_at 索引（清理改由 Cron 全表掃描），每次計數只寫一列。
-- 限流紀錄只是一小時內的計數，重建時丟掉沒有影響。
DROP INDEX rate_limits_by_reset;
DROP TABLE rate_limits;
CREATE TABLE rate_limits (
  bucket   TEXT    PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
) WITHOUT ROWID;

-- D：容量上限用的計數（不必每次 COUNT(*) 掃整張 players）。由 trigger 維護，和 players 同一個交易內更新。
CREATE TABLE counters (
  name  TEXT    PRIMARY KEY,
  value INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO counters (name, value) SELECT 'players', COUNT(*) FROM players;

CREATE TRIGGER players_count_insert AFTER INSERT ON players
BEGIN
  UPDATE counters SET value = value + 1 WHERE name = 'players';
END;

CREATE TRIGGER players_count_delete AFTER DELETE ON players
BEGIN
  UPDATE counters SET value = value - 1 WHERE name = 'players';
END;

-- E：統計彙總表（GET /api/stats 只讀這張表，讀取列數＝章節數，與通關紀錄筆數無關）。由 trigger 維護。
CREATE TABLE chapter_stats (
  chapter       TEXT    PRIMARY KEY,
  players       INTEGER NOT NULL,
  total_seconds INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO chapter_stats (chapter, players, total_seconds)
  SELECT chapter, COUNT(*), SUM(play_seconds) FROM clears GROUP BY chapter;

CREATE TRIGGER clears_stats_insert AFTER INSERT ON clears
BEGIN
  INSERT INTO chapter_stats (chapter, players, total_seconds) VALUES (NEW.chapter, 1, NEW.play_seconds)
    ON CONFLICT (chapter) DO UPDATE SET players = players + 1, total_seconds = total_seconds + NEW.play_seconds;
END;

CREATE TRIGGER clears_stats_update AFTER UPDATE OF play_seconds ON clears
BEGIN
  UPDATE chapter_stats SET total_seconds = total_seconds - OLD.play_seconds + NEW.play_seconds WHERE chapter = NEW.chapter;
END;

CREATE TRIGGER clears_stats_delete AFTER DELETE ON clears
BEGIN
  UPDATE chapter_stats SET players = players - 1, total_seconds = total_seconds - OLD.play_seconds WHERE chapter = OLD.chapter;
END;

-- 統計改讀 chapter_stats，原本給 GROUP BY 用的索引不再需要（少一筆索引寫入）。
DROP INDEX clears_by_chapter;
