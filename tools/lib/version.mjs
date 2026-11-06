// 遊戲版本號：台灣時間（UTC+8）的日期「年.月.日」；同一天第 n 次（n≥2）加「.n-1」。純函式，方便測試。
const TW_OFFSET_SEC = 8 * 3600;
const pad = (n) => String(n).padStart(2, '0');

/** Unix 秒 → 台灣日期 'YYYY.MM.DD'。 */
export function taiwanDate(unixSec) {
  const d = new Date((unixSec + TW_OFFSET_SEC) * 1000);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

/** 日期＋當天第 n 次（1 起算）→ 版本字串。 */
export function versionFor(date, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`當天第 n 次必須是正整數：${n}`);
  return n === 1 ? date : `${date}.${n - 1}`;
}

/** 時間戳（Unix 秒）陣列中，台灣日期等於 date 的筆數。 */
export function countOnDay(timestamps, date) {
  return timestamps.filter((t) => taiwanDate(t) === date).length;
}

const DECL = /^(export const GAME_VERSION = ')[^']*(';)$/m;
const VERSION_RE = /^20\d{2}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(\.\d+)?$/;

/** 把版本檔原始碼裡的 GAME_VERSION 換成 version；格式不合或找不到宣告就丟錯。 */
export function stampSource(src, version) {
  if (!VERSION_RE.test(version)) throw new Error(`版本格式不合：${version}`);
  if (!DECL.test(src)) throw new Error('找不到 export const GAME_VERSION = \'…\'; 宣告');
  return src.replace(DECL, `$1${version}$2`);
}
