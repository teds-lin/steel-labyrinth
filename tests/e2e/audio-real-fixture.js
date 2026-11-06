// M6 真實音訊後端 E2E 的共用 fixture 與工具（audio-real.spec.js、audio-autoplay.spec.js）。
// gateAudio（預設 true）：頁面載入前把 AudioContext 包一層，一開始一律回報 suspended，直到有人呼叫 resume()
// （Phaser 在第一次手勢時呼叫）——模擬一般瀏覽器「要等手勢才能出聲」，不受無頭瀏覽器自動播放政策影響。
import { readFileSync } from 'node:fs';
import { test as base } from '@playwright/test';
import { expect } from './helpers.js';
import { installFakeTurnstile } from './fake-turnstile.js';
import { installPageImport } from './page-import.js';

export const CATALOG = JSON.parse(readFileSync(new URL('../../web/audio/catalog.json', import.meta.url), 'utf8'));
/** 第一次手勢後預載的音效（有音檔的 sfx）。背景音樂與環境音（M6 P3）不預載，換到用得到的畫面才下載。 */
export const FILE_CUES = Object.entries(CATALOG.cues).filter(([, c]) => c.src && c.kind === 'sfx').map(([id]) => id);
export const SFX_FILE = /\/audio\/sfx\//;
export const AUDIO_FILE = /\/audio\/.+\.(ogg|m4a)(\?|$)/i;
export const REAL_URL = './?test=1&audio=1';

/**
 * 同 helpers.js 的錯誤蒐集 fixture，另外：
 * - 只放行「刻意回 404 的那個音檔」的瀏覽器網路紀錄（Failed to load resource；同 cloud.spec.js 的做法），其他 console error 照樣失敗。
 * - 蒐集 console.warn（驗證失敗只 warn 一次）。
 */
export const test = base.extend({
  allow404: [null, { option: true }],
  /** true：模擬「要等手勢才能出聲」的瀏覽器；false：允許自動播放（無頭 Chromium 預設 context 一開始就 running）。 */
  gateAudio: [true, { option: true }],
  warns: async ({ page }, use) => {
    const list = [];
    page.on('console', (m) => { if (m.type() === 'warning' && !/GL Driver Message/.test(m.text())) list.push(m.text()); });
    await use(list);
  },
  page: async ({ page, allow404, gateAudio }, use) => {
    await installFakeTurnstile(page);
    await installPageImport(page);
    if (gateAudio) await page.addInitScript(() => {
      window.__slActivating = false;
      for (const t of ['keydown', 'pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
        window.addEventListener(t, (e) => {
          window.__slActivating = !(e.type === 'keydown' && e.key === 'Escape');
          setTimeout(() => { window.__slActivating = false; }, 0); // 只在這個事件的處理期間有效
        }, true);
      }
      for (const name of ['AudioContext', 'webkitAudioContext']) {
        const Orig = window[name];
        if (typeof Orig !== 'function') continue;
        const stateOf = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state').get;
        window[name] = class GatedAudioContext extends Orig {
          constructor(...a) { super(...a); this.__gated = true; super.suspend().catch(() => {}); }
          get state() { return this.__gated ? 'suspended' : stateOf.call(this); }
          // 跟真的瀏覽器一樣：只有在「會啟動使用者互動」的輸入事件中才能解鎖；依 HTML 規格 Esc 的 keydown 不算。
          // （無頭 Chromium 的 navigator.userActivation 一開始就是 active，不能拿來判斷，所以自己追蹤。）
          resume() {
            if (this.__gated && !window.__slActivating) {
              return Promise.reject(new DOMException('需要使用者手勢', 'NotAllowedError'));
            }
            this.__gated = false;
            return super.resume();
          }
        };
      }
    });
    const errors = [];
    page.on('console', (m) => {
      if (m.type() !== 'error' || /GL Driver Message/.test(m.text())) return;
      if (allow404 && /^Failed to load resource/.test(m.text()) && (m.location()?.url ?? '').includes(allow404)) return;
      errors.push(`[console.error] ${m.text()} @ ${m.location()?.url ?? ''}`);
    });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await use(page);
    expect(errors, '測試過程中不應有 console error 或 pageerror').toEqual([]);
  },
});

export const audio = (page) => page.evaluate(() => window.__SL.audio());
export function watchAudioRequests(page) {
  const urls = [];
  page.on('request', (r) => { if (AUDIO_FILE.test(r.url())) urls.push(new URL(r.url()).pathname); });
  return urls;
}
/** 點畫面空白處（標題字下方，不是按鈕）＝第一次手勢。 */
export async function gesture(page) {
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.08);
}
/** 等音效預載完成：已解碼的 sfx buffer 數＝n，而且沒有下載中的檔（背景音樂也下載完）。 */
export const waitLoaded = (page, n) => page.waitForFunction((k) => {
  const r = window.__SL.audio().real;
  return r && r.loading === 0 && r.sfxBuffers === k;
}, n, { timeout: 15_000 });

