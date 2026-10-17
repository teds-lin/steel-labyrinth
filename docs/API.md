# 雲端 API（Cloudflare Worker＋D1）

Worker 與客戶端的共同約定。基底網址由 `web/src/cloud/endpoint.js` 決定（正式：`https://steel-labyrinth.<帳號>.workers.dev`），測試時可用 `?api=<url>` 覆寫。

## 共通規則
- 所有請求與回應都是 JSON（`content-type: application/json; charset=utf-8`），請求 body 上限 **80 KB**（存檔內容上限 64 KB）。
- **驗證**：除了 `POST /api/player`、`POST /api/transfer`、`GET /api/stats`、`OPTIONS`，其他請求都要帶
  `Authorization: Bearer <token>`。權杖錯誤或缺少 → `401 unauthorized`。
- **錯誤格式**：`{ "error": "<code>", "message": "<給玩家看的台灣繁體說明>" }`，不包含堆疊、SQL 或內部細節。

| HTTP | error | 情況 |
|---|---|---|
| 400 | `bad_request` | JSON 壞掉、欄位缺少或型別錯誤、slot 不是 1～3 |
| 400 | `invalid_save` | 存檔無法通過共用的 `deserialize`（`version_newer` 不算錯） |
| 401 | `unauthorized` | 權杖缺少或錯誤 |
| 404 | `not_found` | 雲端槽是空的、路徑不存在 |
| 409 | `conflict` | 版本不符；body 另附 `current: { version, updated_at, summary }` |
| 413 | `too_large` | body 超過上限 |
| 428 | `precondition_required` | PUT 沒有帶 `If-Match` 也沒有帶 `If-None-Match: *` |
| 429 | `rate_limited` | 超過頻率限制；回應標頭 `Retry-After: <秒>` |
| 500 | `internal` | 其他錯誤（記 log，不洩漏細節） |

- **CORS**：`Origin` 在 `ALLOWED_ORIGINS`（逗號分隔的 vars）裡才回 `Access-Control-Allow-Origin: <該 origin>`，
  並回 `Vary: Origin`；允許方法 `GET, PUT, POST, DELETE, OPTIONS`；允許標頭 `Authorization, Content-Type, If-Match, If-None-Match`；
  暴露標頭 `ETag, Retry-After`。`OPTIONS` 預檢回 204。不在清單的來源不回 CORS 標頭（瀏覽器會擋），但伺服器照常處理非瀏覽器請求。
- 時間一律是 Unix 秒（整數）。

## 端點

### `POST /api/player` — 建立匿名玩家
- body：`{}`（保留擴充）
- 201：`{ "player_id": "<uuid>", "token": "<base64url 43 字元>", "transfer_code": "ABCD-EFGH" }`
- 限流：同一 IP 每小時 5 次。

### `GET /api/saves` — 列出雲端槽
- 200：`{ "slots": [ { "slot": 1, "version": 3, "updated_at": 1760000000, "summary": { … } } | { "slot": 2, "empty": true }, … ] }`（固定 3 筆）

### `GET /api/save/:slot`
- 200：`{ "slot": 1, "version": 3, "updated_at": …, "data": "<存檔字串，即 serialize 的輸出>" }`，標頭 `ETag: "3"`
- 404：空槽

### `PUT /api/save/:slot`
- 標頭：`If-Match: "3"`（覆蓋版本 3）或 `If-None-Match: *`（只在空槽時建立）
- body：`{ "data": "<serialize 的輸出>" }`
- 伺服器用共用的 `deserialize` 驗證；`summary` 由伺服器從存檔算出：`{ "name", "map", "chapter", "playtime_s", "schema_version" }`（名字最多 8 字）。
- 200：`{ "slot": 1, "version": 4, "updated_at": … }`，標頭 `ETag: "4"`
- 409：版本不符（附 current）；412 不使用。
- 限流：同一玩家每小時 60 次寫入（PUT＋DELETE 合計）。

### `DELETE /api/save/:slot`
- 標頭：`If-Match: "<version>"`（必填，避免刪到別台裝置剛寫入的版本）
- 204；版本不符 409；空槽 404。

### `POST /api/transfer` — 用轉移碼接續
- body：`{ "code": "ABCD-EFGH" }`（大小寫、連字號、空白都容忍；比對前正規化）
- 200：`{ "player_id", "token", "transfer_code" }` — 發給新權杖，**舊權杖同時失效**，轉移碼換成新的。
- 404 `not_found`：轉移碼不存在（與格式錯誤回一樣的訊息，不讓人區分）
- 限流：同一 IP 每小時 10 次嘗試（成功與失敗都算）。

### `POST /api/transfer/rotate` — 重新產生轉移碼
- 200：`{ "transfer_code": "WXYZ-2345" }`；舊碼失效。
- 限流：同一玩家每小時 10 次。

### `POST /api/clear` — 回報章節完成
- body：`{ "chapter": "chapter2", "ending": null, "play_seconds": 3600, "collapse": 34 }`
- 驗證：chapter 是 1～32 字元的 `[a-z0-9_]`；play_seconds 0～10⁷；collapse 0～100 整數；ending 為 null 或同 chapter 格式。
- 同一玩家同一章只保留**遊戲時間最短**的一筆。
- 200：`{ "chapter": "chapter2", "best_play_seconds": 3500 }`
- 限流：同一玩家每小時 30 次。

### `GET /api/stats` — 公開統計
- 200：`{ "chapters": [ { "chapter": "chapter2", "players": 12, "avg_play_seconds": 4200 } ], "generated_at": … }`
- 標頭 `Cache-Control: public, max-age=60`。不含任何玩家 id。

## 轉移碼
- 字元集：`ABCDEFGHJKMNPQRSTUVWXYZ23456789`（排除 0、O、1、I、L），8 碼，顯示成 `XXXX-XXXX`。
- 用 `crypto.getRandomValues` 產生，拒絕取樣避免偏差。
- 伺服器只存 `SHA-256(pepper + 正規化碼)`；pepper 是 Worker secret `TRANSFER_PEPPER`。

## 權杖
- 32 bytes 隨機 → base64url。伺服器只存 `SHA-256(token)`；比對用常數時間比較。
- 客戶端存在 localStorage 的 `steel-labyrinth:cloud`：`{ "player_id", "token" }`。

## 頻率限制
- 存在 D1 的 `rate_limits`（固定時間窗）。IP 只以 `SHA-256(每日鹽 + IP)` 形式當作 bucket key，不存原始 IP。
- 限制值放在 `wrangler.toml` 的 vars，方便調整：`RL_PLAYER_PER_HOUR=5`、`RL_TRANSFER_PER_HOUR=10`、`RL_WRITE_PER_HOUR=60`、`RL_ROTATE_PER_HOUR=10`、`RL_CLEAR_PER_HOUR=30`。

## 客戶端行為
- 每個請求逾時 5 秒；網路錯誤、逾時、5xx、429 都只顯示「雲端暫時無法使用」，不影響本機遊戲。
- 401：本機的雲端資訊可能已經被另一台裝置的轉移作廢 → 提示「此裝置的雲端連結已失效，請重新用轉移碼接續」並清除本機雲端資訊。
- 409：顯示雲端與本機兩邊的摘要（地點、名字、遊戲時間、更新時間），讓玩家選「用雲端的」「用本機的（覆蓋雲端）」「取消」。

## 補充（2026-10-17，依後端實作定案）
1. `PUT` 帶 `If-Match` 但雲端槽是空的 → 404 `not_found`。`If-Match: *`、版本格式錯誤、同時帶 `If-Match` 與 `If-None-Match` → 400。`If-Match` 接受 `"3"`、`3`、`W/"3"`。
2. **版本號永不倒退**：刪除雲端槽只是標記為空並把版本加一；之後用 `If-None-Match: *` 重建時，版本從刪除前接著往上加。**客戶端不可假設新建的存檔是 version 1**，一律以回應的 `version`／`ETag` 為準。
3. 409 的 `current` 在極少數競態下可能是 `null`（衝突後槽又被刪除），客戶端要能顯示「雲端已是空的」。
4. `summary` 的欄位在版本較新的存檔中可能是 `null`，客戶端顯示時要處理（例如顯示「—」）。
5. `/api/clear` 的 `ending` 可以省略（視為 null）；`play_seconds` 接受小數並四捨五入。
6. 方法不對的已知路徑回 404（不使用 405）。轉移碼錯誤的 message 是「轉移碼不正確或已經失效。」。
7. 檢查順序：驗證權杖 → slot 與前置條件 → 計入限流 → 讀 body。IP 限流的額度在 UTC 午夜重置（每日鹽更換）。

---

# 修訂 2（2026-10-17，依 M3 第一輪對抗審查定案；與前文衝突時以本節為準）

## A. 秘密改由客戶端產生（修正：轉移逾時造成帳號永久鎖死）
伺服器不再產生權杖與轉移碼，一律由**客戶端**用 `crypto.getRandomValues` 產生（權杖 32 bytes → base64url 43 字元；轉移碼 8 碼、同字元集、拒絕取樣），伺服器只驗證格式並存雜湊。這樣請求逾時也不會遺失秘密。

| 端點 | 請求 body | 成功回應 | 冪等與重試 |
|---|---|---|---|
| `POST /api/player` | `{ "token", "transfer_code" }` | 201 `{ "player_id" }` | 若 `token` 的雜湊已存在 → 200 回同一個 `player_id`（持有權杖即擁有帳號）。轉移碼雜湊碰撞 → 409 `conflict`，客戶端換一組重送 |
| `POST /api/transfer` | `{ "code", "new_token", "new_transfer_code" }` | 200 `{ "player_id" }` | 舊權杖與舊碼同時失效。逾時後客戶端用 `new_token` 呼叫 `GET /api/saves`：200 表示轉移已成功；401 表示沒成功，可以用原本的碼重試 |
| `POST /api/transfer/rotate` | `{ "new_transfer_code" }` | 200 `{}` | 若目前轉移碼雜湊已等於新碼 → 200（重送安全）。逾時就用**同一個**新碼重送，直到成功；成功前畫面標示「新轉移碼尚未確認」 |

- 格式不合法 → 400。`new_token` 與既有任何權杖雜湊相同 → 409（實際上不會發生）。

## B. 存檔雜湊（修正：逾時後內容相同卻顯示衝突）
- `GET /api/saves` 每格與 409 的 `current` 都多一個 `data_sha256`（存檔字串 UTF-8 的 SHA-256，小寫 hex）。
- 客戶端：上傳回 409 時，若 `current.data_sha256` 等於本機要上傳內容的雜湊 → 視為已上傳成功，採用 `current.version`，不顯示衝突畫面。上傳逾時後，下一次上傳前先 `GET /api/saves` 更新版本。
- 客戶端上傳前必須通過 `deserialize`＋`sanitizeLoadedState`，語意壞掉的本機存檔不可上傳（按鈕停用並說明原因）。

## C. 請求驗證
- `POST`／`PUT` 的 `Content-Type` 必須是 `application/json`（可帶 charset），否則 415 `unsupported_media_type`。這會迫使瀏覽器做 CORS 預檢，其他網站無法借訪客的瀏覽器送請求。
- 請求帶有 `Origin` 但不在 `ALLOWED_ORIGINS` → 403 `forbidden_origin`（沒有 Origin 的非瀏覽器請求照常處理）。
- 正式的 `ALLOWED_ORIGINS` 只有 `https://teds-lin.github.io`；本機開發與測試用 `--var` 覆寫。

## D. 頻率限制與免費額度
- **超過限制後不再寫入 D1**：計數用「`count < limit` 才加一」的條件式更新；超過時只讀。
- **IPv6 以 /64 為單位**計算（IPv4 照舊以單一位址）。
- **全域上限**（不分來源）：`RL_TRANSFER_GLOBAL_PER_HOUR=600`、`RL_PLAYER_GLOBAL_PER_HOUR=300`；超過回 429。
- **容量上限**：`MAX_PLAYERS=20000`，達到後 `POST /api/player` 回 503 `capacity`（「雲端存檔目前額滿，請稍後再試」）。
- **定期清理**（Cron Trigger，每天一次）：刪除 `last_seen` 超過 180 天的玩家及其存檔、通關紀錄；刪除過期的 `rate_limits`。不再在一般請求中順便清理。
- 移除 `rate_limits` 的 `reset_at` 索引（清理改由 Cron 全表掃描），減少每次寫入的列數。

## E. 統計
- `GET /api/stats` 用 Cache API 快取 60 秒，同一個時間窗內最多查一次 D1。
- `POST /api/clear` 的 `chapter`、`ending` 必須在 vars `CHAPTERS`（逗號分隔，例如 `prologue,chapter1,chapter2`）白名單內，否則 400。`CHAPTERS` 必須等於 `web/data/manifest.json` 的 chapters（由測試把關）。`ending` 目前一律 null。
- 完成人數少於 `STATS_MIN_PLAYERS=3` 的章節不出現在統計中。

## F. 存檔內容
- `summary.map`、`summary.chapter` 必須符合 `[a-z0-9_]{1,32}`，否則為 null。
- 版本較新的存檔仍接受，但必須是 JSON 物件且 `schema_version ≤ CURRENT_VERSION + 5`。
- 共用 `deserialize` 加強：`flags` 的值只能是布林或整數；`items`／`resonance` 的鍵必須是 `[a-z0-9_]{1,32}`；整份存檔的 JSON 巢狀深度上限 8。

## G. 客戶端其他
- 預設 API 位址為空字串＝雲端功能停用（介面顯示「雲端存檔尚未開放」）；部署後才填入實際網址。
- 本機雲端資訊驗證：權杖必須是 43 字元 base64url、版本必須是 1～2³¹ 的整數，不符合就當作未啟用或忘掉該格版本。
- 選單「雲端存檔」在未啟用時也提供「用轉移碼接續」（不只在標題畫面）。
- 429 的等待時間顯示成「約 N 分鐘」（不足 1 分鐘顯示秒數）。
- 轉移碼正規化時移除零寬與格式字元（Unicode Cf）。

# 修訂 3（2026-10-17，免費額度的最終上限；與前文衝突時以本節為準）
實測：新遊戲存檔 316 bytes；悲觀假設 300 個旗標＋40 種道具約 5.5 KB（目前全部劇情只有 36 個旗標）。

| 設定 | 值 | 理由 |
|---|---|---|
| 每格存檔上限 | **16 KB**（UTF-8 位元組） | 約悲觀估計的 3 倍；超過回 413 |
| 請求 body 上限 | **24 KB** | 16 KB 存檔＋JSON 包裝 |
| `MAX_PLAYERS` | **5000** | 最壞 5000 × 3 × 16 KB ≈ 240 MB，低於 D1 免費 500 MB 的一半 |
| `RL_PLAYER_GLOBAL_PER_HOUR` | **60** | |
| `RL_TRANSFER_GLOBAL_PER_HOUR` | **300** | |
| `RL_WRITE_GLOBAL_PER_HOUR`（新） | **600** | 所有已登入的寫入（PUT、DELETE、clear、rotate）合計的全域上限，超過回 429 |

惡意流量的每日寫入上限估算：建立玩家 60×24×7 ≈ 1.0 萬列＋轉移 300×24×2 ≈ 1.4 萬列＋已登入寫入 600×24×3 ≈ 4.3 萬列 ≈ **6.7 萬列**，低於免費 10 萬列。

## 修訂 3a（2026-10-17，實測後修正）
實測每請求寫入列數後（已登入寫入 4 列、成功轉移 5 列，另含 last_seen 每日 1 列與 Cron 清理），修訂 3 的值每日最壞為 128,840 列，超過免費額度。改為：
- `RL_TRANSFER_GLOBAL_PER_HOUR` = **120**
- `RL_WRITE_GLOBAL_PER_HOUR` = **400**
最壞每日寫入 ≈ **88,040 列**（約 12% 餘裕），由 `tests/worker/cron-cost.test.js` 以實際 vars 值與實測列數計算並斷言 < 100,000。

# 修訂 4（2026-10-17，依 M3 第二輪安全審查定案；與前文衝突時以本節為準）

## 1. 防止全域上限被單一攻擊者佔滿
- **每位玩家配額降低**：`RL_WRITE_PER_HOUR=20`（PUT＋DELETE）、`RL_ROTATE_PER_HOUR=3`、`RL_CLEAR_PER_HOUR=10`。
- **保留通道**：每位玩家每小時的前 `RL_RESERVED_PER_HOUR=3` 次寫入（PUT、DELETE、clear、rotate 合計）**不受全域每小時上限**限制，改計入全域**每日**預算 `RL_WRITE_GLOBAL_PER_DAY`（由測試依免費額度推算，確保最壞每日寫入 < 100,000 列）。超過保留通道的寫入才受全域每小時上限限制。
- **IPv6 加一層 /48**：建立玩家與轉移除了 /64 的限制，另外以 /48 為單位限制（`RL_PLAYER_PER_HOUR_V6_48=10`、`RL_TRANSFER_PER_HOUR_V6_48=20`）。

## 2. 空帳號
- 每日 Cron 另外刪除「建立超過 7 天、沒有任何存檔也沒有通關紀錄」的玩家。
- **Cron 分批**：每次執行最多刪除 `PURGE_BATCH=500` 名玩家（含其存檔、通關紀錄），避免單次寫入暴增。

## 3. rotate 的冪等優先於限流
- 伺服器：rotate 先驗證權杖、讀 body、比對雜湊；若新碼雜湊已等於目前的轉移碼雜湊 → 直接 200，**不計入任何限流**。之後才計入限流與執行更換。
- 客戶端：rotate 收到 **429 或 5xx 或逾時**時保留待確認的新碼；只有收到 **400 或 409** 才丟掉。

## 4. 待確認秘密不可被覆蓋
- 客戶端：`steel-labyrinth:cloud-pending` 裡有未滿 `PENDING_MAX_AGE_S` 的 transfer 待確認時，「啟用雲端存檔」不得覆蓋它；先嘗試確認，仍未決就提示「上一次接續還在確認中，請稍候再試」。

## 5. 轉移碼探測
- `POST /api/player` 與 `rotate` 因**轉移碼雜湊碰撞**回 409 時，該次請求計入 `ip:transfer` 與 `g:transfer` 的額度（rotate 無 IP 資訊時以玩家計入 `g:transfer`）。
- 伺服器拒絕低熵秘密（400）：權杖中不同字元少於 16 種；轉移碼中同一字元出現 4 次以上。

## 6. 每日寫入上限的算式
- 時間窗以「一個 UTC 日最多 25 個窗」計算；新通關的額外寫入以「已登入寫入次數上限」計；Cron 以每日最多 `PURGE_BATCH` 人計。`tests/worker/cron-cost.test.js` 依實際 vars 與實測每請求列數重算，並斷言 < 100,000；另斷言 Cron 單次寫入列數 ≤ `PURGE_BATCH × 實測每人列數`。

## 7. 統計
- `play_seconds` 上限改為 `MAX_PLAYER_SECONDS=36000`（10 小時），超過回 400。

## 修訂 4a（2026-10-17，實測後修正；與前文衝突時以本節為準）
依第 6 節的算式實測（`tests/worker/cron-cost.test.js`），修訂 3a 的 `RL_WRITE_GLOBAL_PER_HOUR=400` 單獨就佔 400 × 25 窗 × 5 列 = 50,000 列；
加上其他固定項（建立玩家、轉移、last_seen、Cron、限流紀錄清理，共 52,004 列）已超過免費的 10 萬列，保留通道分不到任何預算。改為：

| 設定 | 值 | 說明 |
|---|---|---|
| `RL_WRITE_GLOBAL_PER_HOUR` | **100** | 保留通道以外的已登入寫入，全部玩家合計 |
| `RL_WRITE_GLOBAL_PER_DAY` | **4000** | 保留通道的全域每日預算（bucket 帶 UTC 日期，到下一個 UTC 午夜重置） |

- **限流紀錄的清理也計入成本**：IP bucket 每天換鹽，Cron 刪除時每列再寫 1 列。玩家的 bucket（`pl:*`）不在每日清理時刪除（下次寫入時原地重設，不多寫），改在玩家被 Cron 刪除時一起刪（算進每人列數）。
- **碰撞 409 的成本**：`POST /api/player` 與 rotate 的碰撞多寫的轉移 bucket 共用 `g:transfer` 額度，算在「轉移」那一項（測試斷言碰撞多出的列數 ≤ 一次轉移的列數）。
- **每日最壞寫入**（實測每請求列數，2026-10-17）：
  建立玩家 60×25×8＝12,000＋轉移 120×25×6＝18,000＋每小時通道 100×25×5＝12,500＋保留通道 4,000×6＝24,000
  ＋last_seen 5,000×1＝5,000＋Cron 500 人×16 列＝8,000＋IP 限流紀錄清理（60×25＋120×25）×2＋4＝9,004 ＝ **88,504 列**（約 11% 餘裕）。
- Cron 單次寫入 ≤ `PURGE_BATCH` × 每人 16 列＝8,000 列（每人：3 格存檔、每章一筆通關紀錄、統計 trigger、容量計數、5 個玩家限流 bucket）。
- 低熵檢查：客戶端產生器（`web/src/cloud/secrets.js`）用與伺服器相同的判斷重抽（未重抽時約 0.22% 的轉移碼會被拒），Worker 直接匯入同一份判斷。
- 客戶端：`enable()` 遇到新鮮的 transfer 待確認時回 `{ ok:false, kind:'pending_transfer', message:'上一次接續還在確認中，請稍候再試' }`；回報通關的遊戲時間超過 36000 秒時以 36000 回報。

## 修訂 4b（2026-10-17，M3 部署前最後一輪審查；與前文衝突時以本節為準）

### 1. 保留通道不可被並行請求放大
- 問題：修訂 4 的實作先只讀檢查保留名額，再「先計每日預算、後計保留名額」。單一帳號同時送 33 個寫入時，33 個都通過只讀檢查，每日預算被計 33 次（應為 3）。
- 修正：限流改成**一條 SQL 敘述原子計數**——在同一條敘述內先檢查全部 bucket 未滿，成立才一起加一，任何一個滿了就一列都不寫。已登入寫入先嘗試「端點限制＋保留名額＋每日預算」三者一起計；沒拿到（保留名額或每日預算已滿）就改為「端點限制＋全域每小時上限」，保留名額**不被消耗**。
- 結果：單一帳號並行 33 個寫入，`g:wday` 只增加 3；被擋下（429）的請求在並行時也是 0 列寫入。每日寫入上限的算式加入「並行失敗路徑」一項，以實測值（0 列）計入，總計仍為 **88,504 列**。
- 每個請求的讀取列數因此增加（例如 PUT 約 16～20 列、建立玩家約 15～19 列），寫入列數不變；讀取額度（每日 500 萬列）遠大於寫入，不影響上限。

### 2. 轉移額度用完時不可分辨碰撞
- `POST /api/player` 與 rotate 在寫入轉移碼之前，先只讀檢查轉移相關 bucket（`ip:transfer`〔IPv6 另含 /48〕或 rotate 無 IP 時的 `pl:transfer`，以及 `g:transfer`）；任何一個已滿 → 一律 **429**，不執行 INSERT／UPDATE。避免額度用完後仍能由「碰撞 → 429」與「沒碰撞 → 成功」分辨是否猜中別人的轉移碼。
- 代價：轉移額度被灌滿時，新玩家暫時無法啟用雲端存檔（rotate 的冪等重送不受影響）。

### 3. 空帳號改看最後使用時間
- 修訂 4 第 2 節的「建立超過 7 天」改為「**超過 7 天沒有使用**（`last_seen < 現在 − 7 天`）」，其餘條件不變（沒有任何存檔也沒有通關紀錄）。`last_seen` 一天最多更新一次，實際上是至少約 6 天沒有任何已登入請求才會刪。
- 客戶端：401 的重新連結頁面加上「也可以重新啟用雲端存檔（本機存檔不受影響）。」

### 4. 用轉移碼接續被 429
- 客戶端 `connect` 收到 429 時，伺服器確定沒有處理 → **清除待確認區**，不再擋住接下來的「啟用雲端存檔」（原本會擋 `PENDING_MAX_AGE_S` 10 分鐘）。

### 5. 回報通關失敗時補送
- 客戶端回報通關遇到 429、逾時、網路錯誤或 5xx 時，把這筆記在本機 `steel-labyrinth:cloud-clear-queue`（`{ player_id, records:{ <章>: { chapter, ending, play_seconds, collapse } } }`，**各章只留最新一筆**）。
- 下次啟動（`recover`）或下次通關回報成功後，每筆**補送一次**：成功或 400 → 刪除；429 → 這次停止、保留到下次；401 或停用雲端 → 全部清掉；換了帳號（player_id 不同）→ 舊帳號的紀錄作廢。
- 伺服器端的通關紀錄只在成績改善時更新，重送同一筆不會讓紀錄變差。
