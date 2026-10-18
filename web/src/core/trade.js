// 交換（DATA-FORMAT「第一部完結（M5 起）」的「交換（鐘塔之夢）」）：夢客的 trades 表。純客戶端、不連伺服器。純函式，不修改輸入。
// 畫面流程：look 對話的 { open_trade: "nine" } → 對話結束後 pending 有 { type:'open_trade', guest } →
// 用 availableTrades 列出 → 玩家選了之後 applyTrade 換道具（材料不足等情況丟錯；畫面應先看 affordable）。
// 夢客以目前章節為準（DATA-FORMAT 補充（依故事聖經）3，見 dream.js 的 guestFor）；once 旗標跨章節共用。
import { evalCondition } from './conditions.js';
import { guestFor } from './dream.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const countOf = (state, id) => (isObj(state?.items) && Object.hasOwn(state.items, id) && Number.isInteger(state.items[id]) && state.items[id] > 0 ? state.items[id] : 0);
const itemName = (data, id) => arr(data?.items).find((x) => isObj(x) && x.id === id)?.name ?? id;
const lines = (list) => arr(list).filter((x) => isObj(x) && typeof x.item === 'string' && Number.isInteger(x.count));

/** once: true 的交換做過之後記的旗標。 */
export const tradeFlag = (guestId, tradeId) => `trade:${guestId}:${tradeId}`;

/** 目前章節看得到的夢客（每個 id 依 guestFor 的章節規則取一份）；沒有 state 時每個 id 取第一次出現的。 */
function allGuests(data, state) {
  const ids = [];
  for (const story of arr(data?.story)) for (const g of arr(story?.guests)) if (isObj(g) && typeof g.id === 'string' && !ids.includes(g.id)) ids.push(g.id);
  return ids.map((id) => (state ? guestFor(id, state, data) : arr(data?.story).flatMap((s) => arr(s?.guests)).find((g) => isObj(g) && g.id === id))).filter(isObj);
}

/** 依交換 id 找 { guest, trade }（guestId 選填：只在該夢客裡找；state 選填：依目前章節）；找不到回 null。 */
export function findTrade(tradeId, data, guestId, state) {
  for (const guest of allGuests(data, state)) {
    if (guestId !== undefined && guest.id !== guestId) continue;
    const trade = arr(guest.trades).find((t) => isObj(t) && t.id === tradeId);
    if (trade) return { guest, trade };
  }
  return null;
}

const isDone = (guest, trade, state) => trade.once === true && state?.flags?.[tradeFlag(guest.id, trade.id)] === true;
const isOpen = (trade, state, data) => trade.if === undefined || evalCondition(trade.if, state, data);

/**
 * 目前可以和這位夢客做的交換（if 成立、once 的還沒做過）。付不起的也列出（affordable false）。
 * 回傳 [{ id, guest, label, give:[{ item, name, count, have }], get:[{ item, name, count }], once, affordable }]。
 */
export function availableTrades(guestId, state, data) {
  const guest = guestFor(guestId, state, data);
  if (!guest) return [];
  return arr(guest.trades).filter((t) => isObj(t) && !isDone(guest, t, state) && isOpen(t, state, data)).map((t) => {
    const give = lines(t.give).map((g) => ({ item: g.item, name: itemName(data, g.item), count: g.count, have: countOf(state, g.item) }));
    return {
      id: t.id, guest: guest.id, label: t.label, give,
      get: lines(t.get).map((g) => ({ item: g.item, name: itemName(data, g.item), count: g.count })),
      once: t.once === true,
      affordable: give.every((g) => g.have >= g.count),
    };
  });
}

/** 做一次交換：扣掉 give、加上 get；once 的記旗標 trade:<guest>:<id>。找不到、尚未開放、已做過、材料不足都丟出明確錯誤。 */
export function applyTrade(tradeId, state, data, guestId) {
  const found = findTrade(tradeId, data, guestId, state ?? {});
  if (!found) throw new Error(`找不到交換「${tradeId}」${guestId !== undefined ? `（夢客「${guestId}」）` : ''}`);
  const { guest, trade } = found;
  if (isDone(guest, trade, state)) throw new Error(`交換「${tradeId}」已經交換過了（只能交換一次）`);
  if (!isOpen(trade, state, data)) throw new Error(`交換「${tradeId}」尚未開放`);
  const short = lines(trade.give).filter((g) => countOf(state, g.item) < g.count);
  if (short.length) {
    throw new Error(`交換「${tradeId}」材料不足：${short.map((g) => `${itemName(data, g.item)} ${countOf(state, g.item)}／${g.count}`).join('、')}`);
  }
  const items = { ...state.items };
  for (const g of lines(trade.give)) {
    const left = countOf({ items }, g.item) - g.count;
    if (left > 0) items[g.item] = left; else delete items[g.item];
  }
  for (const g of lines(trade.get)) items[g.item] = countOf({ items }, g.item) + g.count;
  const flags = trade.once === true ? { ...state.flags, [tradeFlag(guest.id, trade.id)]: true } : state.flags;
  return { ...state, items, flags };
}
