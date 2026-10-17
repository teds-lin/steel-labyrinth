-- 《鋼鐵迷都》M4 鐘塔之夢（docs/API.md「鐘塔之夢」）。0001／0002 已套用，不可修改；所有變更放在這裡。
-- 這兩張表的內容只由 tools/upload-dream.mjs 產生的 SQL 寫入（部署時），Worker 只讀並快取在記憶體。
-- 對話內容（input、history、reply）一律不存；額度只用 rate_limits 的計數。

-- 夢客人設：id＝夢客代號（[a-z0-9_]{1,32}）；data＝人設 JSON（私有 repo 的 dream/personas/<id>.json
-- 加上公開 story 的 guests[].scripted 預寫台詞）。未開放章節的知識卡也在 data 裡，由 Worker 依 CHAPTERS 篩選。
CREATE TABLE dream_personas (
  id         TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- 簡體字／陸用語詞表（由 lexicon.yaml 以 tools/gen-dream-lexicon.mjs 產生）：固定一列 id='main'。
CREATE TABLE dream_lexicon (
  id            TEXT    PRIMARY KEY,
  data          TEXT    NOT NULL,
  source_sha256 TEXT    NOT NULL,
  updated_at    INTEGER NOT NULL
) WITHOUT ROWID;
