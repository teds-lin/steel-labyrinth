// 主角名字：清理玩家輸入、計算字元數、代入 {name}。
// 純函式，瀏覽器與 Node 都能直接執行。

export const DEFAULT_NAME = '雷恩・葛雷';
export const MAX_NAME_LENGTH = 8;

// 控制字元（Cc）、格式字元（Cf：零寬、雙向控制、BOM、軟連字號、tag 字元…）與 < >。
// 例外：夾在兩個 emoji 之間的 ZWJ（U+200D）保留，否則會拆壞 👨‍👩‍👧 這類組合序列。
const FORBIDDEN = /[\p{Cc}<>]/gu;
const ENDS_WITH_EMOJI = /\p{Extended_Pictographic}[\p{M}\u{1F3FB}-\u{1F3FF}]*$/u; // 可帶變體選擇符／膚色
const STARTS_WITH_EMOJI = /^\p{Extended_Pictographic}/u;
// 「看不見」的字元：空白類、韓文填充字（U+3164、U+115F、U+1160、U+FFA0）、點字空白 U+2800、組合記號。
const INVISIBLE = /^[\p{White_Space}\u3164\u115F\u1160\uFFA0\u2800\p{M}]*$/u;

function stripFormat(str) {
  let out = '';
  const chars = Array.from(str);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!/\p{Cf}/u.test(c)) { out += c; continue; }
    // ZWJ：只在 emoji 序列內（前面是 emoji〔可帶變體選擇符〕、後面也是 emoji）時保留
    if (c === '\u200D' && ENDS_WITH_EMOJI.test(out) && STARTS_WITH_EMOJI.test(chars[i + 1] ?? '')) out += c;
  }
  return out;
}

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
  const cleaned = stripFormat(raw.replace(FORBIDDEN, '')).trim();
  const clipped = graphemes(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
  return INVISIBLE.test(clipped) ? DEFAULT_NAME : clipped;
}

/** 把模板裡的 {name} 換成主角名字；null/undefined 原樣回傳。 */
export function fill(template, state) {
  if (template === null || template === undefined) return template;
  const name = state?.player?.name || DEFAULT_NAME;
  return String(template).split('{name}').join(name);
}
