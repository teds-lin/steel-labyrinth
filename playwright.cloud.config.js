// 雲端整合 E2E 設定：同時啟動靜態伺服器（8091）與「真的」本機 Worker（8788，wrangler dev --local）。
// M4：Worker 改用 worker/wrangler.e2e.toml（沒有 [ai] 綁定＝內建模擬 AI，不連 Cloudflare、不用真額度；官方 Turnstile 測試金鑰），
// 並在啟動前把假人設、詞表、拒絕清單（tests/worker/fixtures/dream；修訂 1 D）寫進這次的本機 D1（等同 npm run worker:dev:e2e＋dream:upload:e2e，
// 但用獨立的 persist 目錄與 8788 埠，不碰開發資料）。
// 獨立於 playwright.config.js，所以 `npm run e2e` 不會多啟動 Worker。指令：npm run e2e:cloud
// 本機 D1 資料放在 test-results/cloud-worker-state/<時間戳>/（每次執行一份新的，不碰開發資料 .wrangler/state）。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = 8091;
const WORKER_PORT = 8788;
// 主程序先決定一次並放進環境變數，worker 程序重新載入設定時沿用同一個值。
process.env.SL_WORKER_STATE ??= `test-results/cloud-worker-state/${Date.now()}`;
const STATE = process.env.SL_WORKER_STATE;
const WRANGLER = '--config worker/wrangler.e2e.toml';
const DREAM_FIX = 'tests/worker/fixtures/dream';
// upload-dream 不准把 SQL 寫進公開 repo：放系統暫存目錄（內容只有假人設）
const DREAM_SQL = join(tmpdir(), `steel-labyrinth-dream-e2e-${STATE.replace(/\D/g, '')}.sql`);
// 線上驗證：設定 E2E_BASE_URL（例如 GitHub Pages）與 E2E_API_URL（正式 Worker）時，不啟動本機伺服器與 Worker。
// 正式環境有頻率限制，請用 --grep 只跑需要的情境。
const REMOTE = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'cloud-live.spec.js',
  outputDir: 'test-results/cloud-live',
  timeout: 150_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/cloud-live' }]],
  use: {
    baseURL: REMOTE || `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: REMOTE ? undefined : [
    {
      command: 'node tools/serve.mjs',
      env: { PORT: String(PORT) },
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // 先套 migration 到獨立的 persist 目錄，再啟動 Worker。限流額度調高（本檔每次執行會建立很多玩家／轉移）。
      command: `npx wrangler d1 migrations apply steel-labyrinth --local ${WRANGLER} --persist-to ${STATE}`
        + ` && node tools/upload-dream.mjs --personas ${DREAM_FIX}/personas --lexicon ${DREAM_FIX}/lexicon.json --blocklist ${DREAM_FIX}/blocklist.json --story ${DREAM_FIX}/story`
        + ` --config worker/wrangler.e2e.toml --out ${DREAM_SQL}`
        + ` && npx wrangler d1 execute steel-labyrinth --local ${WRANGLER} --persist-to ${STATE} --file ${DREAM_SQL}`
        + ` && npx wrangler dev --local ${WRANGLER} --port ${WORKER_PORT} --inspector-port 9239 --persist-to ${STATE}`
        + ' --var TRANSFER_PEPPER:e2e-only-pepper RL_PLAYER_PER_HOUR:1000 RL_TRANSFER_PER_HOUR:1000'
        + ' RL_WRITE_PER_HOUR:1000 RL_ROTATE_PER_HOUR:1000 RL_CLEAR_PER_HOUR:1000'
        // 全域上限調高（修訂 2 D／3a／4）；統計門檻 1 人；本機來源加進 CORS 白名單（正式 toml 只剩 github.io，修訂 2 C）
        + ' RL_PLAYER_GLOBAL_PER_HOUR:100000 RL_TRANSFER_GLOBAL_PER_HOUR:100000 RL_WRITE_GLOBAL_PER_HOUR:100000'
        // 修訂 4：IPv6 /48 層（本機請求可能是 ::1）、保留通道的全域每日預算也調高
        + ' RL_PLAYER_PER_HOUR_V6_48:100000 RL_TRANSFER_PER_HOUR_V6_48:100000 RL_WRITE_GLOBAL_PER_DAY:1000000'
        + ' STATS_MIN_PLAYERS:1 ALLOWED_ORIGINS:http://localhost:8091'
        // M4：夢境通行證限流調高（每個測試都會重新驗證）；Turnstile hostname 加上本機
        + ' RL_DREAM_PASS_PER_HOUR:1000 RL_DREAM_PASS_GLOBAL_PER_HOUR:100000 TURNSTILE_HOSTNAMES:localhost',
      // 不用 /api/stats 當健康檢查：它有 60 秒快取（修訂 2 E），會讓第一個統計測試讀到啟動時的空結果。
      // /api/saves 未帶權杖回 401，Playwright 視為伺服器已就緒。
      url: `http://localhost:${WORKER_PORT}/api/saves`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], browserName: 'chromium', viewport: { width: 1280, height: 720 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } },
  ],
});
