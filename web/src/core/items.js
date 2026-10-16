// 道具的使用（DATA-FORMAT「規格補充」1）。
// - field_effects：在地圖選單中使用，套用遊戲層的對話效果並用掉 1 個（這裡）。
// - target＋battle_effects：戰鬥中使用（battle/engine.js 的 act({ type:'item' })）。
// 兩者都沒有的道具是劇情道具，不能使用。純函式，不修改輸入。
import { applyEffects } from './effects.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const findItem = (data, id) => (Array.isArray(data?.items) ? data.items.find((x) => isObj(x) && x.id === id) : undefined);
const countOf = (state, id) => (isObj(state?.items) && Object.hasOwn(state.items, id) && Number.isInteger(state.items[id]) ? state.items[id] : 0);

/** 地圖選單用：持有且可以在地圖上使用的道具 [{ id, name, desc, count }]。 */
export function fieldItems(state, data) {
  return Object.keys(isObj(state?.items) ? state.items : {}).flatMap((id) => {
    const def = findItem(data, id);
    const count = countOf(state, id);
    if (!def || !Array.isArray(def.field_effects) || count <= 0) return [];
    return [{ id, name: def.name ?? id, desc: def.desc ?? '', count }];
  });
}

/** 在地圖上使用道具：套用 field_effects 後用掉 1 個，回傳新 state。不能用時丟錯。 */
export function useFieldItem(itemId, state, data) {
  const def = findItem(data, itemId);
  if (!def) throw new Error(`找不到道具「${itemId}」`);
  if (!Array.isArray(def.field_effects)) throw new Error(`道具「${itemId}」不能在地圖上使用`);
  const n = countOf(state, itemId);
  if (n <= 0) throw new Error(`沒有道具「${itemId}」`);
  const items = { ...state.items };
  if (n > 1) items[itemId] = n - 1; else delete items[itemId];
  return applyEffects(def.field_effects, { ...state, items });
}
