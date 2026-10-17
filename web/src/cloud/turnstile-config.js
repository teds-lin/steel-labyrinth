// Turnstile（Cloudflare 人機驗證）的設定：放在 endpoint.js 旁邊，部署時才填正式 sitekey。
// 本機頁面（localhost／127.0.0.1）一律用官方測試 sitekey（永遠通過），避免開發與自動測試用到正式小工具。

/** 正式 sitekey：2026-10-18 建立的 Turnstile 小工具（網域限定 teds-lin.github.io）。sitekey 本身是公開值。 */
export const TURNSTILE_SITEKEY_PROD = '0x4AAAAAAFZn3lEsx_Jap35n';
/** Cloudflare 官方測試 sitekey：一律通過（visible）。 */
export const TURNSTILE_TEST_SITEKEY = '1x00000000000000000000AA';
/** explicit render：由程式決定何時、在哪裡顯示小工具。 */
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** 各端點的 action（伺服器 siteverify 會比對）。 */
export const TURNSTILE_ACTIONS = Object.freeze({ createPlayer: 'create_player', dreamPass: 'dream_pass' });

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 頁面主機 → 要用的 sitekey。 */
export function resolveSitekey(pageHost, prod = TURNSTILE_SITEKEY_PROD) {
  if (typeof pageHost === 'string' && LOOPBACK.has(pageHost.toLowerCase())) return TURNSTILE_TEST_SITEKEY;
  return typeof prod === 'string' ? prod : '';
}
