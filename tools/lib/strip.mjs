// 發布前剝除私有註記：遞迴移除 `_` 開頭的欄位（例如 _note、_todo、_spoiler）。
// 例外：剛好一個字元的 "_" 不算私有欄位——地圖 legend 的鍵是單一字元，"_" 是合法的地形字元（例如門檻）。
const isPrivateKey = (k) => k.length > 1 && k.startsWith('_');

/** 回傳剝除後的新值，不修改輸入。 */
export function stripPrivate(value) {
  if (Array.isArray(value)) return value.map(stripPrivate);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!isPrivateKey(k)) out[k] = stripPrivate(v);
    return out;
  }
  return value;
}
