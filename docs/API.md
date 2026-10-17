# 雲端 API（Cloudflare Worker＋D1）

Worker 與客戶端的共同約定。基底網址由 `web/src/config.js` 決定（正式：`https://steel-labyrinth.<帳號>.workers.dev`），測試時可用 `?api=<url>` 覆寫。

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
