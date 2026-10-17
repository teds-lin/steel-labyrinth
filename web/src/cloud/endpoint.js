// 雲端 API 的基底網址（純函式，config.js 的 apiBase() 呼叫它）。
// 正式網站預設連到已部署的 Worker（2026-10-17 部署）。頁面在本機時預設停用雲端（空字串＝「雲端存檔尚未開放」），
// 避免本機開發與自動測試打到正式 Worker；本機要用雲端時以 ?api= 指定。

export const API_BASE_DEFAULT = 'https://steel-labyrinth.ai-in-2026.workers.dev';

/** 有 API 位址才算開放雲端存檔。 */
export const cloudConfigured = (base) => typeof base === 'string' && base !== '';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isLoopback = (host) => typeof host === 'string' && LOOPBACK.has(host.toLowerCase());

/**
 * search：location.search；pageHost：location.hostname。
 * ?api=<url> 只在「頁面本身在本機」或「目標是本機」時採用：正式頁面上的 ?api= 連結
 * 不能把玩家的權杖送到任意伺服器。網址必須是 http(s)、不帶帳密；結尾斜線去掉。
 */
export function resolveApiBase(search, pageHost) {
  const fallback = isLoopback(pageHost) ? '' : API_BASE_DEFAULT;
  let raw = null;
  try {
    raw = new URLSearchParams(typeof search === 'string' ? search : '').get('api');
  } catch {
    raw = null;
  }
  if (!raw) return fallback;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return fallback;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
  if (u.username || u.password) return fallback;
  if (!isLoopback(pageHost) && !isLoopback(u.hostname)) return fallback;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}
