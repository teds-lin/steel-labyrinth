// 發布前剝除私有註記：遞迴移除 `_` 開頭的欄位（例如 _note、_todo、_spoiler、單一字元的 _）。
// 唯一例外：地圖檔根層 legend 物件的鍵是單一字元，"_" 是合法的地形字元（例如門檻），只有那裡放行 "_"。
// （stripPrivate 每次處理一個資料檔，地圖的 legend 就在檔案根層。）
const isPrivateKey = (k) => k.startsWith('_');

const stripLegend = (legend) => {
  if (legend === null || typeof legend !== 'object' || Array.isArray(legend)) return strip(legend, false);
  const out = {};
  for (const [k, v] of Object.entries(legend)) if (k === '_' || !isPrivateKey(k)) out[k] = strip(v, false);
  return out;
};

function strip(value, isRoot) {
  if (Array.isArray(value)) return value.map((v) => strip(v, false));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isRoot && k === 'legend') out[k] = stripLegend(v);
      else if (!isPrivateKey(k)) out[k] = strip(v, false);
    }
    return out;
  }
  return value;
}

/** 回傳剝除後的新值，不修改輸入。 */
export function stripPrivate(value) {
  return strip(value, true);
}
