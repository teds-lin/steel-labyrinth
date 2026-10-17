// 雲端存檔的畫面層入口：把 cloud/api.js 與 cloud/sync.js 接上瀏覽器（fetch、localStorage、目前的內容資料）。
import { apiBase } from './config.js';
import { session } from './session.js';
import { createCloudApi } from './cloud/api.js';
import { createCloudSync, readCloudInfo } from './cloud/sync.js';

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
});

export const cloudApiBase = () => API_BASE;

/** 秒 → 「10/17 08:53」（玩家當地時間）；沒有時間回「—」。 */
export function formatStamp(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
