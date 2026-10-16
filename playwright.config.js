import { defineConfig, devices } from '@playwright/test';

const PORT = 8091; // 8080 被別的伺服器占用，E2E 專用 8091
// 設定 E2E_BASE_URL 可以改測線上版本（例如 GitHub Pages），此時不啟動本機伺服器。
const REMOTE = process.env.E2E_BASE_URL;
const BASE_URL = REMOTE || `http://localhost:${PORT}/`;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: REMOTE ? undefined : {
    command: 'node tools/serve.mjs',
    env: { PORT: String(PORT) },
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], browserName: 'chromium', viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'mobile',
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 667 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      },
    },
  ],
});
