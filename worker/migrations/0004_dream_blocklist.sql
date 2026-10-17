-- 《鋼鐵迷都》鐘塔之夢 修訂 1（docs/API.md「鐘塔之夢 修訂 1」D）。0001～0003 已套用，不可修改。
-- 夢客回覆的拒絕清單（不雅、仇恨、自我傷害、政治與統戰用語）：固定一列 id='main'。
-- 內容只放在私有 repo 的 dream/blocklist.json，由 tools/upload-dream.mjs 產生的 SQL 寫入；Worker 只讀並快取在記憶體。
CREATE TABLE dream_blocklist (
  id         TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  sha256     TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
