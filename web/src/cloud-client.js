// 雲端存檔的畫面層入口：把 cloud/api.js 與 cloud/sync.js 接上瀏覽器（fetch、localStorage、目前的內容資料）。
import { apiBase } from './config.js';
import { cloudConfigured } from './cloud/endpoint.js';
import { session } from './session.js';
import { createCloudApi } from './cloud/api.js';
import { createCloudSync, readCloudInfo } from './cloud/sync.js';
import { createDreamClient } from './cloud/dream.js';
import { createTurnstileLoader } from './cloud/turnstile.js';
import { resolveSitekey } from './cloud/turnstile-config.js';

const API_BASE = apiBase();

const api = createCloudApi({
  baseUrl: API_BASE,
  // 以一般函式呼叫 window.fetch（不能當成別的物件的方法呼叫，否則 Illegal invocation）
  fetch: (url, init) => window.fetch(url, init),
  getToken: () => readCloudInfo(session.backend)?.token ?? null,
});

export const cloud = createCloudSync({
  backend: session.backend,
  saveStore: session.storage,
  getData: () => session.data,
  api,
  // 修訂 2 G：API 位址是空字串＝雲端存檔尚未開放
  configured: () => cloudConfigured(API_BASE),
});

// 重新整理（或上次關閉時請求還在路上）後：確認待確認的權杖是否已生效、用同一個新轉移碼重送（修訂 2 A）。
// 沒有待確認的東西時不送任何請求；失敗只記 console，不影響遊戲。
if (cloud.configured()) {
  cloud.recover().catch((e) => console.warn('雲端待確認項目恢復失敗', e));
}

export const cloudApiBase = () => API_BASE;

/** M4：夢境通行證與夢客對話（通行證只在記憶體）。 */
export const dream = createDreamClient({ api });

/** M4：Turnstile 腳本載入器與 sitekey（本機頁面用官方測試 sitekey）。 */
export const turnstile = {
  loader: createTurnstileLoader(),
  sitekey: () => {
    try { return resolveSitekey(window.location.hostname); } catch { return ''; }
  },
};

/** 秒 → 「10/17 08:53」（玩家當地時間）；沒有時間回「—」。 */
export function formatStamp(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
