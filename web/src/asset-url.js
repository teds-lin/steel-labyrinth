// 執行期組出來的同源資源網址（遊戲資料 JSON、音訊目錄）一律經過 assetUrl()：發布版加上 ?v=<ASSET_VERSION>
// （＝<GAME_VERSION>-<HEAD 短 SHA>，與 tools/stamp-urls.mjs 改寫的模組網址同一個參數），避免 GitHub Pages 的快取（max-age=600）讓新舊版本的檔案混用。
// 本機開發與 E2E（版本 'dev'）不加任何參數，行為與以前相同。
import { ASSET_VERSION } from './version.js';

/**
 * path：相對路徑字串（以 base 解析）或 URL 物件。回傳絕對網址字串；不會改到傳進來的 URL 物件。
 * 已有的查詢參數保留；已有 v 就換成目前版本。
 */
export function assetUrl(path, { version = ASSET_VERSION, base = globalThis.document?.baseURI } = {}) {
  const u = new URL(String(path instanceof URL ? path.href : path), base);
  if (version !== 'dev') u.searchParams.set('v', version);
  return u.href;
}
