// HUD 顯示用的純函式：把 state 的數值轉成要畫的文字。
// 數值異常（NaN、負數、超大、非整數、字串）一律先 clamp，絕不因此丟錯。

/** 殘響最多畫幾個點；超過的用數字表示。 */
export const ECHO_DOTS_MAX = 10;
const ECHO_NUM_MAX = 99;
const COLLAPSE_HUD_MAX = 100;

function toInt(v, lo, hi) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * 殘響區文字。view 來自 core 的 echoAvailable(state, data)：{ free, charges }，
 * max 是新遊戲的殘響次數（manifest.start.echo_charges），用來畫空心點。
 * 回傳 { text, filled, free }。
 */
export function echoHud({ charges, free = false, max = 0 } = {}) {
  if (free === true) return { text: '回溯 ∞', filled: 0, free: true };
  const n = toInt(charges, 0, ECHO_NUM_MAX);
  if (n > ECHO_DOTS_MAX) {
    return { text: `殘響 ${'●'.repeat(ECHO_DOTS_MAX)} ${n}`, filled: ECHO_DOTS_MAX, free: false };
  }
  const total = Math.max(n, toInt(max, 0, ECHO_DOTS_MAX));
  return { text: `殘響 ${'●'.repeat(n)}${'○'.repeat(total - n)}`, filled: n, free: false };
}

/** 崩解值：回傳 { value, text, ratio, danger }。 */
export function collapseHud(c, max = COLLAPSE_HUD_MAX) {
  const top = toInt(max, 1, 10_000);
  const value = toInt(c, 0, top);
  return { value, text: `崩解 ${value}/${top}`, ratio: value / top, danger: value >= top * 0.6 };
}
