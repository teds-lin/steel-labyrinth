# 雲端存檔 Worker

Cloudflare Worker＋D1＋Workers AI。API 規格見 `docs/API.md`（與前文衝突時以最後的修訂為準，目前是「修訂 4b」；M4 的「鐘塔之夢」：Turnstile、夢境通行證、夢客對話）。Worker 直接 import `web/src/core/save.js` 驗證存檔（和客戶端共用同一個 `deserialize`）。

## 本機
| 指令 | 說明 |
|---|---|
| `npm run test:worker` | Miniflare＋記憶體 D1 的整合測試（`npm test` 也會跑） |
| `npm run worker:dev` | （修訂 1 E）**預設使用模擬 AI、不連 Cloudflare**：以本機專用設定 `worker/wrangler.e2e.toml`（沒有 `AI` 綁定、`DREAM_FAKE_AI=1`、Turnstile 官方測試金鑰、本機 pepper 與通行證金鑰）套用本機 migration 後啟動 `wrangler dev --local`（http://localhost:8787），不需要登入。允許來源用 `--var` 覆寫（`ALLOWED_ORIGINS` 加上 `http://localhost:8080`、`http://localhost:8091`）；正式的 `wrangler.toml` 只允許 `https://teds-lin.github.io`。夢客資料用 `npm run dream:upload:e2e` 寫進本機 D1（假人設） |
| `npm run worker:dev:real-ai` | **會用掉 Cloudflare 帳號的 Workers AI 免費額度（每日 10,000 neurons，超過要付費或失敗）**：用正式的 `worker/wrangler.toml`（有 `AI` 綁定），`wrangler dev` 的 AI 一律連到 Cloudflare，需要 `wrangler login`。只在要實測真模型時使用；pepper、Turnstile 測試金鑰與通行證金鑰用 `--var` 帶本機值 |
| `npm run worker:build` | `wrangler deploy --dry-run` 打包檢查，不需要登入 |

本機 D1 狀態存在 `worker/.wrangler/`（已被 `.gitignore` 排除）。自己另外用 `wrangler dev` 啟動時，記得也用 `--var ALLOWED_ORIGINS:<來源,…>` 加上本機來源，否則瀏覽器請求會被 403。

測試時 Worker 會多綁一個 `D1_METRICS=1`，回應帶 `x-d1-rows: read=N; written=M`（該次請求的 D1 讀寫列數），用來斷言成本上限；正式設定沒有這個變數，不會輸出。

## 資料表與 migration
- `0001_init.sql`：初始資料表。**已套用的 migration 不可修改**（測試會比對 0001 的雜湊）。
- `0002_revision2.sql`：修訂 2——`saves.data_sha256`；`rate_limits` 改成 WITHOUT ROWID 並移除 `reset_at` 索引；`counters`（玩家數，trigger 維護，給 `MAX_PLAYERS` 用）；`chapter_stats`（統計彙總，trigger 維護）；移除 `clears_by_chapter` 索引。
- `0003_dream.sql`：M4——`dream_personas`（夢客人設＋預寫台詞）、`dream_lexicon`（簡體字／陸用語詞表）。內容只由 `tools/upload-dream.mjs` 產生的 SQL 寫入。
- 新的變更一律加新檔（`0004_*.sql`…）。

## 部署（需要 `wrangler login` 一次）
1. `npx wrangler d1 create steel-labyrinth`，把回傳的 `database_id` 填進 `worker/wrangler.toml`。
2. `npm run worker:migrate:remote`（依序套用 `worker/migrations/` 的 0001、0002…）。
3. `npx wrangler secret put TRANSFER_PEPPER --config worker/wrangler.toml`，輸入一個長隨機字串
   （例如 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`）。
   **pepper 設定後不要更換**：換了之後所有既有轉移碼都會失效（權杖不受影響），IP 限流的鹽也會跟著換。
   M4 另外兩個 secret（同樣用 `wrangler secret put`，不要寫進任何檔案）：
   - `TURNSTILE_SECRET`：Cloudflare 儀表板建立 Turnstile 小工具（hostname `teds-lin.github.io`）後的 secret key。
   - `DREAM_PASS_SECRET`：夢境通行證的 HMAC 金鑰，至少 32 字元的隨機字串（產生方式同上）。更換只會讓尚未過期的通行證失效（玩家重新入夢即可）。
4. M4：上傳夢客人設與詞表（見下方「鐘塔之夢」），再 `npm run worker:deploy`。Cron Trigger（`wrangler.toml` 的 `[triggers] crons`，每天 UTC 03:17 清理：180 天未登入的玩家、超過 7 天沒有使用（`last_seen`）的空帳號，每次最多 `PURGE_BATCH` 人）會隨部署自動註冊，**不需要另外設定**；部署輸出會列出 `schedule: 17 3 * * *`。
5. 把部署輸出的 `https://steel-labyrinth.<帳號>.workers.dev` 填進 **`web/src/cloud/endpoint.js` 的 `API_BASE_DEFAULT`**（預設是空字串＝雲端功能停用），再發布網站。`web/src/config.js` 只是呼叫它，不要改那裡。
6. 需要調整限流值、容量或統計門檻時，改 `wrangler.toml` 的 `[vars]`，跑 `npm test`（`tests/worker/cron-cost.test.js` 會用新值重算每日最壞寫入並擋下超過 10 萬列的設定）後重新部署。

### 部署前檢查清單
- [ ] `npm test` 全綠（含 `tests/worker`、`tests/core`）；`npm run worker:build` 成功。
- [ ] `test-results/cron-cost-total.txt`（`npm test` 產生）的每日最壞寫入低於 10 萬列，而且有合理餘裕（目前 98,507 列，鐘塔之夢修訂 1 之後；餘裕約 1.5%，見下方「成本與限制」）。
- [ ] `[vars]` 有修訂 4 的新值：`RL_WRITE_PER_HOUR=20`、`RL_ROTATE_PER_HOUR=3`、`RL_CLEAR_PER_HOUR=10`、`RL_RESERVED_PER_HOUR=3`、`RL_WRITE_GLOBAL_PER_HOUR=100`、`RL_WRITE_GLOBAL_PER_DAY=4000`、`RL_PLAYER_PER_HOUR_V6_48=10`、`RL_TRANSFER_PER_HOUR_V6_48=20`、`PURGE_BATCH=500`、`MAX_PLAYER_SECONDS=36000`（`tests/worker/config.test.js` 把關）。
- [ ] `wrangler.toml` 的 `database_id` 已換成實際值（不是全 0）。
- [ ] `ALLOWED_ORIGINS` 只有 `https://teds-lin.github.io`（沒有 localhost；測試會擋）。
- [ ] `CHAPTERS` 等於 `web/data/manifest.json` 的 `chapters`（新增章節時兩邊一起改；測試會擋）。
- [ ] `TRANSFER_PEPPER`、`TURNSTILE_SECRET`、`DREAM_PASS_SECRET` 都已用 `wrangler secret put` 設定（`npx wrangler secret list --config worker/wrangler.toml` 看得到），沒有寫進任何檔案；`TURNSTILE_SECRET` **不是**官方測試金鑰（`1x…`／`2x…`／`3x…`），也沒有設定 `TURNSTILE_ALLOW_TEST_SECRET`。
- [ ] 夢客人設與詞表已上傳（`npx wrangler d1 execute steel-labyrinth --remote --config worker/wrangler.toml --command "SELECT id, updated_at FROM dream_personas"` 看得到每位夢客）；`CHAPTERS` 新增章節後，夢客才會知道該章的知識卡。
- [ ] 遠端 migration 已套用到最新（`npx wrangler d1 migrations list steel-labyrinth --remote --config worker/wrangler.toml` 沒有待套用的項目）。
- [ ] 部署後：`curl https://<worker>/api/stats` 回 200；帶 `-H 'Origin: https://evil.example'` 回 403；`POST` 不帶 `Content-Type: application/json` 回 415。
- [ ] 最後才把網址填進 `web/src/cloud/endpoint.js` 並發布網站。

## 成本與限制（Workers／D1 免費方案）
- 存檔每格上限 16 KB、請求 body 上限 24 KB（修訂 3）。
- 超過限流的請求不寫入：多個限制用一條 SQL 敘述原子計數（修訂 4b），全部未滿才一起加一，任何一個滿了就一列都不寫——並行請求也一樣（`tests/worker/cron-cost.test.js` 實測並行 33 個被擋的寫入共 0 列）。
- 每位玩家每小時（修訂 4）：存檔寫入（PUT＋DELETE）20、回報通關 10、重新產生轉移碼 3。rotate 重送「目前已生效的碼」直接 200，不計入任何限流。
- **保留通道**（修訂 4）：每位玩家每小時前 3 次寫入（PUT、DELETE、clear、rotate 合計）不受全域每小時上限，改計入全域每日預算 `RL_WRITE_GLOBAL_PER_DAY=4000`；之後的寫入受全域每小時上限 `RL_WRITE_GLOBAL_PER_HOUR=100`（修訂 4a）。每日預算用完時保留通道關閉，所有寫入回到每小時上限。保留名額、端點限制與每日預算原子計數：單一帳號並行送再多請求，每日預算每小時最多也只增加 3（修訂 4b）。
- 全域上限：建立玩家每小時 60、轉移碼每小時 120（含 `POST /api/player` 與 rotate 的轉移碼碰撞 409）。轉移額度（該來源或全域）已滿時，`POST /api/player` 與 rotate 一律 429、不寫入（修訂 4b：避免從「碰撞 429／沒碰撞成功」分辨是否猜中別人的轉移碼）。
- 來源：IPv4 以單一位址、IPv6 以 /64 計算；IPv6 另以 /48 限制（建立玩家 10、轉移 20）。
- 低熵秘密 400：權杖不同字元少於 16 種、轉移碼同一字元出現 4 次以上（客戶端用同一份判斷重抽，官方客戶端不會被誤殺）。
- `MAX_PLAYERS=5000`：最壞 5000 × 3 格 × 16 KB ≈ 240 MB，低於 D1 免費方案每個資料庫 500 MB 的一半。超過 7 天沒有使用（看 `last_seen`，修訂 4b）、沒有存檔也沒有通關紀錄的空帳號由 Cron 刪除，釋出名額；被刪的玩家回到遊戲時會看到重新連結頁面，可以重新啟用雲端存檔。
- Cron 每次最多刪 `PURGE_BATCH=500` 人（單次最多約 11,000 列寫入；每人 22 列：3 格存檔、每章通關、統計 trigger、容量計數、9 個玩家限流 bucket〔write、clear、rotate、rsv、transfer、dpass、dchat、dcall、dmin〕）；玩家的限流紀錄與玩家一起刪，IP 與全域的過期限流紀錄每天清。
- `GET /api/stats` 讀 `chapter_stats`（讀取列數＝章節數），並用 Cache API 快取 60 秒。注意：Cache API 在 `*.workers.dev` 網域上可能不生效；即使不生效，每次也只讀幾列。回報通關的遊戲時間上限 `MAX_PLAYER_SECONDS=36000`（10 小時）。
- 惡意流量的每日寫入上限由 `tests/worker/cron-cost.test.js` 依 API.md 修訂 4 第 6 節／4a 的算式（一個 UTC 日 25 個時間窗、每次已登入寫入以最貴的「新通關」計、Cron 以每日 `PURGE_BATCH` 人計、含 IP 限流紀錄清理），用 `wrangler.toml` 的實際值與實測的每請求寫入列數計算，另含並行失敗路徑（實測 0 列），斷言低於免費的 10 萬列（目前 98,507 列，含夢境通行證與夢客對話）；調整 `[vars]` 時這個測試會把關。
- **在加上 Turnstile 之前，全域額度仍可被有心人耗盡（門檻與時間點，修訂 4b 重估）**：要讓正常玩家連保留通道都寫不進去，必須「全域每日預算 4,000 用完」**而且**「全域每小時上限 100 被佔滿」。修訂 4b 之後每個帳號每小時最多只能消耗 3 次每日預算（並行也一樣），所以 N 個帳號從 UTC 午夜起持續寫入，約在 4,000 ÷ (3N) 小時後用完每日預算，之後鎖死到下一個 UTC 午夜（台灣時間早上 8 點）；佔滿每小時上限只需另外約 4 個帳號（每帳號每小時 30 次一般寫入）。換算：約 170 個帳號 → UTC 8 點（台灣下午 4 點）起鎖死；約 340 個 → UTC 4 點起；約 1,340 個 → UTC 1 點起，幾乎整天。少於約 56 個帳號整天也用不完每日預算（修正前約 5 個帳號以並行請求就能在一天內用完）。帳號建立受每 IP 每小時 5 個、每 /48 每小時 10 個、全域每小時 60 個限制：170 個帳號至少約 3 小時、1,340 個至少約 23 小時（都需要 12 個以上的 IPv4 或 6 個以上的 IPv6 /48 才能跑滿全域 60）；帳號可以事先慢慢建好囤著（有存檔就不會被 Cron 清掉，上限 `MAX_PLAYERS=5000`）。另外約 12 個 IPv4 就能佔滿建立玩家（60）或轉移（120）的全域每小時上限（/48 限制只對 IPv6 有效）；轉移額度被佔滿時，新玩家也無法啟用雲端存檔（修訂 4b 第 2 節的代價）。被耗盡時影響是「雲端暫時無法使用」，本機遊戲不受影響；通關紀錄會留在本機，之後補送。

## 鐘塔之夢（M4）

### 端點
- `POST /api/player` 新建時需要 `turnstile_token`（action `create_player`）；同一個權杖的冪等重送不驗證（Turnstile token 只能用一次）。
- `POST /api/dream/pass`：權杖＋`turnstile_token`（action `dream_pass`）→ `{ pass, expires_at, ttl_s, remaining_today }`，有效 `DREAM_PASS_TTL_S=7200`（2 小時）。客戶端以「收到回應的本機時間＋`ttl_s`」判斷過期。
  限流（修訂 1 B）：同一玩家每小時 6 次（滿了 429，不呼叫 siteverify）；**Turnstile 通過後**才計入全站 `RL_DREAM_PASS_GLOBAL_PER_HOUR=50`（2 小時 × 50 ≈ 100 人同時入夢）。Turnstile 失敗照樣計入玩家的 6 次，另計一個失敗專用的全站 bucket `RL_DREAM_PASS_FAIL_GLOBAL_PER_HOUR=10`；它滿了之後失敗一列都不寫（仍回 403），不影響成功的玩家。
- `POST /api/dream/chat`：權杖＋通行證（屬於同一玩家、未過期，否則 401 `pass_invalid`）。200 的 `source` 為 `ai` 或 `scripted`（`reason`：`quota`、`budget`、`ai_error`、`filtered`），並帶 `sig`；每位玩家每分鐘超過 `DREAM_CHATS_PER_MINUTE=6` 次回 **429**。
  - 每位玩家每 UTC 日 `DREAM_CHATS_PER_DAY=20` 句（AI 回覆通過檢查才扣）＋ `DREAM_CALLS_PER_DAY=40` 次 AI 呼叫（`pl:dcall`；filtered、ai_error、重試都計入、不退還；用完 → `quota`）。
  - `sig`＝base64url(HMAC-SHA256(`DREAM_PASS_SECRET`, `player_id` 換行 `guest` 換行 `reply`))。客戶端把它原樣存在對話紀錄、送 `history` 時帶上；`role: "guest"` 沒有有效 `sig` 的項目會被伺服器丟掉（不報錯）。
  - 輸出檢查（`worker/src/dreamcheck.js`）：NFKC → 移除 Cc／Cf → 比對用的版本再移除空白與標點；詞表、自稱 AI、洩漏特徵、照抄人設／界線／迴避主題、網址與網域、電子郵件、6 位以上連續數字、聯絡方式（LINE ID、微信…）、假冒系統訊息、方向控制字元、中文字比例低於 60%、拒絕清單 `dream_blocklist`。命中 → 重試一次 → `filtered`。

### Turnstile 的測試金鑰（本機開發與 E2E）
Cloudflare 官方測試金鑰（不需要帳號、不需要網路）：

| 用途 | sitekey（客戶端） | secret（Worker） |
|---|---|---|
| 一律通過 | `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` |
| 一律失敗 | `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` |
| token 已使用過 | — | `3x0000000000000000000000000000000AA` |

測試 sitekey 產生的 token 是 `XXXX.DUMMY.TOKEN.XXXX`。Worker 只有在 `--var TURNSTILE_ALLOW_TEST_SECRET:1` 時才接受測試 secret，而且**離線模擬**（1x 通過、2x／3x 失敗；官方的模擬回應不帶真正的 hostname／action，所以不檢查），不連 `challenges.cloudflare.com`；沒有這個開關時，測試 secret 一律失敗（正式環境誤設也不會變成人人通過）。
`npm run worker:dev` 與 E2E 用的 `worker/wrangler.e2e.toml` 已經帶好這些值；自己用正式設定跑 `wrangler dev`（例如 `npm run worker:dev:real-ai`）時要加上：

```
--var TURNSTILE_SECRET:1x0000000000000000000000000000000AA TURNSTILE_ALLOW_TEST_SECRET:1 DREAM_PASS_SECRET:local-dev-only-dream-pass-secret-0123456789
```

（`--var` 只用在本機；正式的 secret 用 `wrangler secret put`。）**注意**：正式設定的 `AI` 綁定在 `wrangler dev` 一律連到 Cloudflare（需要登入、**會用掉 Workers AI 額度**）；不登入時呼叫 AI 會失敗，夢客改用預寫台詞（`reason: ai_error`），其他功能照常。平常開發請用預設的 `npm run worker:dev`（模擬 AI）。

### 夢客人設與詞表（私有資料）
人設（`dream/personas/*.json`）、詞表（`dream/lexicon.json`）與拒絕清單（`dream/blocklist.json`：不雅、仇恨、自我傷害、政治與統戰用語；格式 `{ categories: { 分類: [詞…] }, exceptions: [例外詞…] }`）只放在私有 repo `steel-labyrinth-design`；公開 repo 的測試只用 `tests/worker/fixtures/dream/` 的假資料（假清單）。
人設的 `deflect_topics` 依章節分層（`{ "chapter3": ["……"] }`，伺服器只取到判定的章節為止），寫法以抽象主題為主（不暗示答案存在）。

1. 產生詞表（來源是 sdg_pipeline 的 `lexicon.yaml`，只讀；需要有 PyYAML 與 dragonmapper 的 Python）：
   `node tools/gen-dream-lexicon.mjs --out ../steel-labyrinth-design/dream/lexicon.json --python <python>`
2. 產生 SQL（只讀 `dream/personas/*.json`，同資料夾的 `README-internal.md` 等內部筆記不會被讀入；拒絕清單預設取人設資料夾上一層的 `blocklist.json`，也可以用 `--blocklist <檔案>` 指定；預寫台詞從公開的 `web/data/story/*.json` 的 `guests[].scripted` 合併）。部署前先 `npm run worker:migrate:remote` 套用 `0004_dream_blocklist.sql`：
   `node tools/upload-dream.mjs --out /tmp/steel-labyrinth-dream.sql [--apply-local | --apply-remote]`
   - SQL 裡有人設與詞表，工具拒絕寫進公開 repo。
   - `--apply-local` 寫進本機 D1（`wrangler dev` 用）；`--apply-remote` **只印出指令**，部署時自己執行：
     `npx wrangler d1 execute steel-labyrinth --remote --config worker/wrangler.toml --file /tmp/steel-labyrinth-dream.sql`
   - 人設缺欄位、有未知欄位、含主角的預設名字（提示詞不得帶玩家真名，主角在鐘塔裡叫「十二點」）、或在 story 找不到預寫台詞時會報錯。
3. Worker 把人設與詞表快取在記憶體（每個 isolate 最多 10 分鐘），上傳後最多 10 分鐘生效。

### 模型與成本
- `DREAM_MODEL=@cf/google/gemma-4-26b-a4b-it`（`plans/M4-model-eval.md`）；`max_tokens` 200、`temperature` 0.7、`chat_template_kwargs.enable_thinking=false`。換模型只改 vars（qwen3 會自動在玩家訊息尾端加 ` /no_think`）；回應讀 `choices[0].message.content`（沒有就讀 `response`），`message.reasoning` 一律不採用。
- 每次 AI 呼叫預扣 `DREAM_NEURONS_PER_CALL=20` neurons，呼叫後依 usage 修正（`DREAM_NEURONS_PER_M_INPUT／OUTPUT` 換算），每次計費夾在 `[DREAM_NEURONS_MIN_PER_CALL=10, DREAM_NEURONS_MAX_PER_CALL=60]`（不完全信任 usage）；全站每日 `DREAM_NEURONS_PER_DAY=8000`、每位玩家每日 `DREAM_CHATS_PER_DAY=20` 句、`DREAM_CALLS_PER_DAY=40` 次 AI 呼叫。單一帳號一天最多消耗 40 × 60 = 2,400 neurons，用不完全站預算。
- 每日 AI 呼叫次數 ≤ 8000 ÷ 10 = 800 次，每次最多寫 5 列（`pl:dmin`、`pl:dcall`、`g:neurons` 預扣＋neurons 修正＋`pl:dchat`）→ 夢客對話每日最多 4,000 列；夢境通行證（成功 50 × 25 窗 × 2 列＋失敗 10 × 25 窗 × 2 列）= 3,000 列；句數／呼叫次數／預算用完、每分鐘 429、失敗上限已滿的通行證都是 0 列（`tests/worker/cron-cost.test.js` 實測並計入）。
- 修訂 1 的取捨：`DREAM_NEURONS_MIN_PER_CALL` 由 8 調高到 10（每日呼叫上限 1,000 → 800 次），換回約 1,000 列的寫入餘裕；實測每句約 9.4 neurons、進位後本來就計 10，正常玩家的容量幾乎不變。
- 隱私：對話內容（`input`、`history`、`reply`）不寫進 D1，log 只記 `source`、`reason` 與耗時。

