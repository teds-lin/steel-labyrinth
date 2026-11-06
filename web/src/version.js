// 遊戲版本號（意見回饋的「複製回報資訊」會帶上它）。repo 內固定是 'dev'；
// GitHub Actions 發布前由 tools/stamp-version.mjs 依台灣時間日期改寫（格式「年.月.日」，同日第 2 次起加「.1」「.2」…），改寫結果不 commit。
export const GAME_VERSION = 'dev';
// 資源網址的 cache-bust 參數（?v=…，見 asset-url.js）。repo 內固定是 'dev'（不加參數）；
// 發布前由 tools/stamp-urls.mjs 改寫成「<GAME_VERSION>-<HEAD 短 SHA 7 碼>」：同一天 amend＋force-push 時 GAME_VERSION 可能重複，
// 加上 SHA 才保證一份內容一個網址。玩家看得到的版本號仍是 GAME_VERSION。
export const ASSET_VERSION = 'dev';
