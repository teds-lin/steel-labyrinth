// 殘響（序章的暫時能力）：提供 trace 標籤，用一次扣一次，並使崩解 +5。

export const ECHO_TAG = 'trace';
export const ECHO_COLLAPSE_COST = 5;
export const COLLAPSE_MIN = 0;
export const COLLAPSE_MAX = 100;

export const clampCollapse = (v) => Math.min(COLLAPSE_MAX, Math.max(COLLAPSE_MIN, v));

export const echoCharges = (state) => state?.echo?.charges ?? 0;

export const hasEcho = (state) => echoCharges(state) > 0;

/** 消耗 1 次殘響，回傳新 state；次數為 0 時丟錯。 */
export function spendEcho(state) {
  const n = echoCharges(state);
  if (n <= 0) throw new Error('殘響次數已用盡，無法再使用殘響');
  return {
    ...state,
    echo: { ...state.echo, charges: n - 1 },
    collapse: clampCollapse((state.collapse ?? 0) + ECHO_COLLAPSE_COST),
  };
}
