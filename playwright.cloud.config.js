// 雲端整合 E2E 設定：同時啟動靜態伺服器（8091）與「真的」本機 Worker（8788，wrangler dev --local）。
// 獨立於 playwright.config.js，所以 `npm run e2e` 不會多啟動 Worker。指令：npm run e2e:cloud
// 本機 D1 資料放在 test-results/cloud-worker-state/<時間戳>/（每次執行一份新的，不碰開發資料 .wrangler/state）。
import { defineConfig, devices } from '@playwright/test';

const PORT = 8091;
const WORKER_PORT = 8788;
// 主程序先決定一次並放進環境變數，worker 程序重新載入設定時沿用同一個值。
process.env.SL_WORKER_STATE ??= `test-results/cloud-worker-state/${Date.now()}`;
const STATE = process.env.SL_WORKER_STATE;
const WRANGLER = '--config worker/wrangler.toml';

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
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
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
        + ` && npx wrangler dev --local ${WRANGLER} --port ${WORKER_PORT} --inspector-port 9239 --persist-to ${STATE}`
        + ' --var TRANSFER_PEPPER:e2e-only-pepper RL_PLAYER_PER_HOUR:1000 RL_TRANSFER_PER_HOUR:1000'
        + ' RL_WRITE_PER_HOUR:1000 RL_ROTATE_PER_HOUR:1000 RL_CLEAR_PER_HOUR:1000',
      url: `http://localhost:${WORKER_PORT}/api/stats`,
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
