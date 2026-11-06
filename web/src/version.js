// 遊戲版本號（意見回饋的「複製回報資訊」會帶上它）。repo 內固定是 'dev'；
// GitHub Actions 發布前由 tools/stamp-version.mjs 依台灣時間日期改寫（格式「年.月.日」，同日第 2 次起加「.1」「.2」…），改寫結果不 commit。
export const GAME_VERSION = 'dev';
