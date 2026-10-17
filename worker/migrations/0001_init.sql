-- 《鋼鐵迷都》雲端存檔：初始資料表（規格：docs/API.md）
-- 權杖與轉移碼只存 SHA-256 雜湊；不存原始 IP。

-- 匿名玩家。token_hash＝SHA-256(權杖)；transfer_hash＝SHA-256(pepper＋正規化轉移碼)。
CREATE TABLE players (
  player_id     TEXT    PRIMARY KEY,
  token_hash    TEXT    NOT NULL UNIQUE,
  transfer_hash TEXT    NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

-- 雲端存檔槽。data 為 NULL 表示「已刪除的空槽」（保留 version，讓版本號不倒退，
-- 避免拿著刪除前版本號的舊裝置覆蓋之後新建立的存檔）。
CREATE TABLE saves (
  player_id  TEXT    NOT NULL REFERENCES players(player_id),
  slot       INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  version    INTEGER NOT NULL CHECK (version >= 1),
  data       TEXT,
  summary    TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, slot)
);

-- 通關紀錄：同一玩家同一章只留遊戲時間最短的一筆。
CREATE TABLE clears (
  player_id    TEXT    NOT NULL REFERENCES players(player_id),
  chapter      TEXT    NOT NULL,
  ending       TEXT,
  play_seconds INTEGER NOT NULL,
  collapse     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (player_id, chapter)
);
-- GET /api/stats 依章節彙總
CREATE INDEX clears_by_chapter ON clears (chapter, play_seconds);

-- 頻率限制（固定時間窗）。bucket 例：ip:player:<SHA-256(每日鹽＋IP)>、pl:write:<player_id>
CREATE TABLE rate_limits (
  bucket   TEXT    PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
-- 清除過期時間窗用
CREATE INDEX rate_limits_by_reset ON rate_limits (reset_at);
