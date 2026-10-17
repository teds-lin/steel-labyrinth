# 雲端存檔 Worker

Cloudflare Worker＋D1。API 規格見 `docs/API.md`。Worker 直接 import `web/src/core/save.js` 驗證存檔。

## 本機
| 指令 | 說明 |
|---|---|
| `npm run test:worker` | Miniflare＋記憶體 D1 的整合測試（`npm test` 也會跑） |
| `npm run worker:dev` | 套用本機 migration 後啟動 `wrangler dev --local`（http://localhost:8787），不需要登入；本機 pepper 用 `--var` 給一個開發用的值 |
| `npm run worker:build` | `wrangler deploy --dry-run` 打包檢查，不需要登入 |

本機 D1 狀態存在 `worker/.wrangler/`（已被 `.gitignore` 排除）。

## 部署（需要 `wrangler login` 一次）
1. `npx wrangler d1 create steel-labyrinth`，把回傳的 `database_id` 填進 `worker/wrangler.toml`。
2. `npm run worker:migrate:remote`（套用 `worker/migrations/`）。
3. `npx wrangler secret put TRANSFER_PEPPER --config worker/wrangler.toml`，輸入一個長隨機字串
   （例如 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`）。
   **pepper 設定後不要更換**：換了之後所有既有轉移碼都會失效（權杖不受影響）。
4. `npm run worker:deploy`，把輸出的 `https://steel-labyrinth.<帳號>.workers.dev` 填進 `web/src/config.js`。
5. 需要調整允許來源或限流值時，改 `wrangler.toml` 的 `[vars]` 後重新部署。
