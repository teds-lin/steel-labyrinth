// 對話送字音的節奏（純函式）：每 every 個「算數的字」響一次（第 1 個字就響），空白與標點不響也不計數。

/** 空白（含全形）、標點、符號（～ 等）都不算。 */
export function isTickChar(ch) {
  return typeof ch === 'string' && ch.length > 0 && !/^[\p{Z}\p{P}\p{S}\s]+$/u.test(ch);
}

/** 回傳 (ch) => 是否要響。每句對話建立一個新的。 */
export function createTypingTicker({ every = 3 } = {}) {
  let n = 0;
  return (ch) => {
    if (!isTickChar(ch)) return false;
    const hit = n % every === 0;
    n += 1;
    return hit;
  };
}
