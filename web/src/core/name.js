// 主角名字：清理玩家輸入、計算字元數、代入 {name}。
// 純函式，瀏覽器與 Node 都能直接執行。

export const DEFAULT_NAME = '雷恩・葛雷';
export const MAX_NAME_LENGTH = 8;

// 控制字元（Cc）與 < >。注意不移除 Cf（ZWJ 等），否則會拆壞 emoji 組合序列。
const FORBIDDEN = /[\p{Cc}<>]/gu;

/** 把字串切成「使用者感知的字元」（grapheme）。 */
export function graphemes(str) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const seg = new Intl.Segmenter('zh-Hant', { granularity: 'grapheme' });
    return Array.from(seg.segment(str), (s) => s.segment);
  }
  return Array.from(str);
}

/** 名字的字元數（emoji 算一個）。 */
export function nameLength(str) {
  return graphemes(String(str ?? '')).length;
}

/** 清理玩家輸入的名字；結果為空時回傳預設名字。 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return DEFAULT_NAME;
  const cleaned = raw.replace(FORBIDDEN, '').trim();
  const clipped = graphemes(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
  return clipped === '' ? DEFAULT_NAME : clipped;
}

/** 把模板裡的 {name} 換成主角名字；null/undefined 原樣回傳。 */
export function fill(template, state) {
  if (template === null || template === undefined) return template;
  const name = state?.player?.name || DEFAULT_NAME;
  return String(template).split('{name}').join(name);
}
