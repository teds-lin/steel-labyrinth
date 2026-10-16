// 種子化亂數（mulberry32）。狀態是純資料 { s: uint32 }，可以直接存進戰鬥狀態、JSON 來回轉換。
// API 不可變：每個函式回傳 [值, 下一個狀態]，不修改輸入。

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const isRngState = (r) => isObj(r) && Number.isInteger(r.s) && r.s >= 0 && r.s <= 0xffffffff;

/** 由種子建立亂數狀態。種子必須是有限數字（取 32 位元）。 */
export function createRng(seed) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) throw new Error(`亂數種子必須是有限數字，實際為 ${JSON.stringify(seed)}`);
  return { s: (Math.trunc(seed) >>> 0) };
}

function assertState(r) {
  if (!isRngState(r)) throw new Error(`亂數狀態不合法：${JSON.stringify(r)}`);
}

/** [0, 1) 的浮點數。 */
export function nextFloat(r) {
  assertState(r);
  const s = (r.s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const v = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [v, { s }];
}

/** [lo, hi] 的整數（含兩端）。 */
export function nextInt(r, lo, hi) {
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) throw new Error(`nextInt 範圍不合法：${lo}～${hi}`);
  const [v, nx] = nextFloat(r);
  return [lo + Math.floor(v * (hi - lo + 1)), nx];
}

/** 以 pct（0～100）的機率回傳 true。永遠消耗一個亂數（讓重播序列穩定）。 */
export function chance(r, pct) {
  const [v, nx] = nextFloat(r);
  return [v * 100 < pct, nx];
}
