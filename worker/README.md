# 雲端存檔 Worker

Cloudflare Worker＋D1。API 規格見 `docs/API.md`（與前文衝突時以最後的「修訂 2」為準）。Worker 直接 import `web/src/core/save.js` 驗證存檔（和客戶端共用同一個 `deserialize`）。

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
4. `npm run worker:deploy`。Cron Trigger（`wrangler.toml` 的 `[triggers] crons`，每天 UTC 03:17 清理）會隨部署自動註冊，**不需要另外設定**；部署輸出會列出 `schedule: 17 3 * * *`。
5. 把部署輸出的 `https://steel-labyrinth.<帳號>.workers.dev` 填進 **`web/src/cloud/endpoint.js` 的 `API_BASE_DEFAULT`**（預設是空字串＝雲端功能停用），再發布網站。`web/src/config.js` 只是呼叫它，不要改那裡。
6. 需要調整限流值、容量或統計門檻時，改 `wrangler.toml` 的 `[vars]` 後重新部署。

### 部署前檢查清單
- [ ] `npm test` 全綠（含 `tests/worker`、`tests/core`）；`npm run worker:build` 成功。
- [ ] `wrangler.toml` 的 `database_id` 已換成實際值（不是全 0）。
- [ ] `ALLOWED_ORIGINS` 只有 `https://teds-lin.github.io`（沒有 localhost；測試會擋）。
- [ ] `CHAPTERS` 等於 `web/data/manifest.json` 的 `chapters`（新增章節時兩邊一起改；測試會擋）。
- [ ] `TRANSFER_PEPPER` 已用 `wrangler secret put` 設定（`npx wrangler secret list --config worker/wrangler.toml` 看得到），沒有寫進任何檔案。
- [ ] 遠端 migration 已套用到最新（`npx wrangler d1 migrations list steel-labyrinth --remote --config worker/wrangler.toml` 沒有待套用的項目）。
- [ ] 部署後：`curl https://<worker>/api/stats` 回 200；帶 `-H 'Origin: https://evil.example'` 回 403；`POST` 不帶 `Content-Type: application/json` 回 415。
- [ ] 最後才把網址填進 `web/src/cloud/endpoint.js` 並發布網站。

## 成本與限制（Workers／D1 免費方案）
- 存檔每格上限 16 KB、請求 body 上限 24 KB（修訂 3）。
- 超過限流的請求只讀不寫（條件式計數）。全域上限（修訂 3）：建立玩家每小時 60、轉移碼每小時 120、已登入寫入（PUT＋DELETE＋clear＋rotate）每小時 400（修訂 3a）；全域滿了之後連來源／玩家的計數都不寫。
- IPv6 以 /64 為單位計算來源。
- `MAX_PLAYERS=5000`：最壞 5000 × 3 格 × 16 KB ≈ 240 MB，低於 D1 免費方案每個資料庫 500 MB 的一半。
- `GET /api/stats` 讀 `chapter_stats`（讀取列數＝章節數），並用 Cache API 快取 60 秒。注意：Cache API 在 `*.workers.dev` 網域上可能不生效；即使不生效，每次也只讀幾列。
- 惡意流量的每日寫入上限由 `tests/worker/cron-cost.test.js` 用 `wrangler.toml` 的實際值與實測的每請求寫入列數計算，並斷言低於免費的 10 萬列；調整 `[vars]` 時這個測試會把關。
