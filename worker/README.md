# 雲端存檔 Worker

Cloudflare Worker＋D1。API 規格見 `docs/API.md`（與前文衝突時以最後的修訂為準，目前是「修訂 4a」）。Worker 直接 import `web/src/core/save.js` 驗證存檔（和客戶端共用同一個 `deserialize`）。

## 本機
| 指令 | 說明 |
|---|---|
| `npm run test:worker` | Miniflare＋記憶體 D1 的整合測試（`npm test` 也會跑） |
| `npm run worker:dev` | 套用本機 migration 後啟動 `wrangler dev --local`（http://localhost:8787），不需要登入。本機 pepper 與允許來源用 `--var` 覆寫（`ALLOWED_ORIGINS` 加上 `http://localhost:8080`、`http://localhost:8091`）；正式的 `wrangler.toml` 只允許 `https://teds-lin.github.io` |
| `npm run worker:build` | `wrangler deploy --dry-run` 打包檢查，不需要登入 |

本機 D1 狀態存在 `worker/.wrangler/`（已被 `.gitignore` 排除）。自己另外用 `wrangler dev` 啟動時，記得也用 `--var ALLOWED_ORIGINS:<來源,…>` 加上本機來源，否則瀏覽器請求會被 403。

測試時 Worker 會多綁一個 `D1_METRICS=1`，回應帶 `x-d1-rows: read=N; written=M`（該次請求的 D1 讀寫列數），用來斷言成本上限；正式設定沒有這個變數，不會輸出。

## 資料表與 migration
- `0001_init.sql`：初始資料表。**已套用的 migration 不可修改**（測試會比對 0001 的雜湊）。
- `0002_revision2.sql`：修訂 2——`saves.data_sha256`；`rate_limits` 改成 WITHOUT ROWID 並移除 `reset_at` 索引；`counters`（玩家數，trigger 維護，給 `MAX_PLAYERS` 用）；`chapter_stats`（統計彙總，trigger 維護）；移除 `clears_by_chapter` 索引。
- 新的變更一律加新檔（`0003_*.sql`…）。

## 部署（需要 `wrangler login` 一次）
1. `npx wrangler d1 create steel-labyrinth`，把回傳的 `database_id` 填進 `worker/wrangler.toml`。
2. `npm run worker:migrate:remote`（依序套用 `worker/migrations/` 的 0001、0002…）。
3. `npx wrangler secret put TRANSFER_PEPPER --config worker/wrangler.toml`，輸入一個長隨機字串
   （例如 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`）。
   **pepper 設定後不要更換**：換了之後所有既有轉移碼都會失效（權杖不受影響），IP 限流的鹽也會跟著換。
4. `npm run worker:deploy`。Cron Trigger（`wrangler.toml` 的 `[triggers] crons`，每天 UTC 03:17 清理：180 天未登入的玩家、建立超過 7 天的空帳號，每次最多 `PURGE_BATCH` 人）會隨部署自動註冊，**不需要另外設定**；部署輸出會列出 `schedule: 17 3 * * *`。
5. 把部署輸出的 `https://steel-labyrinth.<帳號>.workers.dev` 填進 **`web/src/cloud/endpoint.js` 的 `API_BASE_DEFAULT`**（預設是空字串＝雲端功能停用），再發布網站。`web/src/config.js` 只是呼叫它，不要改那裡。
6. 需要調整限流值、容量或統計門檻時，改 `wrangler.toml` 的 `[vars]`，跑 `npm test`（`tests/worker/cron-cost.test.js` 會用新值重算每日最壞寫入並擋下超過 10 萬列的設定）後重新部署。

### 部署前檢查清單
- [ ] `npm test` 全綠（含 `tests/worker`、`tests/core`）；`npm run worker:build` 成功。
- [ ] `test-results/cron-cost-total.txt`（`npm test` 產生）的每日最壞寫入低於 10 萬列，而且有合理餘裕（目前 88,504 列）。
- [ ] `[vars]` 有修訂 4 的新值：`RL_WRITE_PER_HOUR=20`、`RL_ROTATE_PER_HOUR=3`、`RL_CLEAR_PER_HOUR=10`、`RL_RESERVED_PER_HOUR=3`、`RL_WRITE_GLOBAL_PER_HOUR=100`、`RL_WRITE_GLOBAL_PER_DAY=4000`、`RL_PLAYER_PER_HOUR_V6_48=10`、`RL_TRANSFER_PER_HOUR_V6_48=20`、`PURGE_BATCH=500`、`MAX_PLAYER_SECONDS=36000`（`tests/worker/config.test.js` 把關）。
- [ ] `wrangler.toml` 的 `database_id` 已換成實際值（不是全 0）。
- [ ] `ALLOWED_ORIGINS` 只有 `https://teds-lin.github.io`（沒有 localhost；測試會擋）。
- [ ] `CHAPTERS` 等於 `web/data/manifest.json` 的 `chapters`（新增章節時兩邊一起改；測試會擋）。
- [ ] `TRANSFER_PEPPER` 已用 `wrangler secret put` 設定（`npx wrangler secret list --config worker/wrangler.toml` 看得到），沒有寫進任何檔案。
- [ ] 遠端 migration 已套用到最新（`npx wrangler d1 migrations list steel-labyrinth --remote --config worker/wrangler.toml` 沒有待套用的項目）。
- [ ] 部署後：`curl https://<worker>/api/stats` 回 200；帶 `-H 'Origin: https://evil.example'` 回 403；`POST` 不帶 `Content-Type: application/json` 回 415。
- [ ] 最後才把網址填進 `web/src/cloud/endpoint.js` 並發布網站。

## 成本與限制（Workers／D1 免費方案）
- 存檔每格上限 16 KB、請求 body 上限 24 KB（修訂 3）。
- 超過限流的請求只讀不寫（條件式計數；有多個限制時先全部只讀檢查，任何一個滿了就整個不寫）。
- 每位玩家每小時（修訂 4）：存檔寫入（PUT＋DELETE）20、回報通關 10、重新產生轉移碼 3。rotate 重送「目前已生效的碼」直接 200，不計入任何限流。
- **保留通道**（修訂 4）：每位玩家每小時前 3 次寫入（PUT、DELETE、clear、rotate 合計）不受全域每小時上限，改計入全域每日預算 `RL_WRITE_GLOBAL_PER_DAY=4000`；之後的寫入受全域每小時上限 `RL_WRITE_GLOBAL_PER_HOUR=100`（修訂 4a）。每日預算用完時保留通道關閉，所有寫入回到每小時上限。
- 全域上限：建立玩家每小時 60、轉移碼每小時 120（含 `POST /api/player` 與 rotate 的轉移碼碰撞 409）。
- 來源：IPv4 以單一位址、IPv6 以 /64 計算；IPv6 另以 /48 限制（建立玩家 10、轉移 20）。
- 低熵秘密 400：權杖不同字元少於 16 種、轉移碼同一字元出現 4 次以上（客戶端用同一份判斷重抽，官方客戶端不會被誤殺）。
- `MAX_PLAYERS=5000`：最壞 5000 × 3 格 × 16 KB ≈ 240 MB，低於 D1 免費方案每個資料庫 500 MB 的一半。建立超過 7 天、沒有存檔也沒有通關紀錄的空帳號由 Cron 刪除，釋出名額。
- Cron 每次最多刪 `PURGE_BATCH=500` 人（單次最多約 8,000 列寫入）；玩家的限流紀錄與玩家一起刪，IP 與全域的過期限流紀錄每天清。
- `GET /api/stats` 讀 `chapter_stats`（讀取列數＝章節數），並用 Cache API 快取 60 秒。注意：Cache API 在 `*.workers.dev` 網域上可能不生效；即使不生效，每次也只讀幾列。回報通關的遊戲時間上限 `MAX_PLAYER_SECONDS=36000`（10 小時）。
- 惡意流量的每日寫入上限由 `tests/worker/cron-cost.test.js` 依 API.md 修訂 4 第 6 節／4a 的算式（一個 UTC 日 25 個時間窗、每次已登入寫入以最貴的「新通關」計、Cron 以每日 `PURGE_BATCH` 人計、含 IP 限流紀錄清理），用 `wrangler.toml` 的實際值與實測的每請求寫入列數計算，斷言低於免費的 10 萬列（目前 88,504 列）；調整 `[vars]` 時這個測試會把關。
- **在加上 Turnstile 之前，全域額度仍可被有心人耗盡**：約 54 個帳號整天持續寫入（每帳號每小時 3 次保留＋30 次一般寫入）就能同時耗盡每日預算與每小時上限；帳號建立受每 IP 每小時 5 個、每 /48 每小時 10 個、全域每小時 60 個限制（1 個 IPv4 約 11 小時、11 個 IPv4 約 1 小時可建好）。另外約 12 個 IPv4 就能佔滿建立玩家（60）或轉移（120）的全域每小時上限（/48 限制只對 IPv6 有效）。被耗盡時影響是「雲端暫時無法使用」，本機遊戲不受影響。
