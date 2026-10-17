// 雲端 API 的基底網址（純函式，config.js 的 apiBase() 呼叫它）。
// 修訂 2 G 節：預設是空字串＝雲端功能停用（介面顯示「雲端存檔尚未開放」）；Worker 部署後才把實際網址填進 API_BASE_DEFAULT。

export const API_BASE_DEFAULT = '';

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
  let raw = null;
  try {
    raw = new URLSearchParams(typeof search === 'string' ? search : '').get('api');
  } catch {
    raw = null;
  }
  if (!raw) return API_BASE_DEFAULT;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return API_BASE_DEFAULT;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return API_BASE_DEFAULT;
  if (u.username || u.password) return API_BASE_DEFAULT;
  if (!isLoopback(pageHost) && !isLoopback(u.hostname)) return API_BASE_DEFAULT;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}
