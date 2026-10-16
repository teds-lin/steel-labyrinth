// 畫面層與 core 之間的小型轉接：把【調查】【殘響】按鈕轉成 core 的呼叫。
import { facingTarget, look, tryUnlock, echo, unlockOptions, NO_TRACE_MESSAGE, NO_CHARGE_MESSAGE } from './core/interact.js';
import { isUnlocked } from './core/grid.js';
import { hasEcho } from './core/echo.js';

/**
 * 【調查】面前的物件。回傳 { state, dialogue, message }。
 * 鎖住的物件：只嘗試「不需付出代價」的解法（免費標籤或道具）。
 * 不直接呼叫 tryUnlock(obj, state, data)（自動挑選），因為沒有鑰匙但還有殘響時，
 * 它會選「要消耗殘響的 trace 標籤」，等於按【調查】就默默扣掉殘響；殘響只該由【殘響】鍵觸發。
 */
export function investigate(map, state, data) {
  const obj = facingTarget(map, state, data);
  if (!obj) return { state, dialogue: null, message: null };
  if (obj.lock && !isUnlocked(obj, state)) {
    const free = unlockOptions(obj, state, data).filter((o) => o.cost === null);
    // 偏好順序與 core 相同：免費標籤 > 道具
    const pick = free.find((o) => o.method === 'tag') ?? free.find((o) => o.method === 'item');
    const r = pick
      ? tryUnlock(obj, state, data, pick.method === 'tag' ? { method: 'tag', tag: pick.tag } : { method: 'item' })
      : { state, dialogue: obj.lock.locked ?? null };
    return { state: r.state, dialogue: r.dialogue ?? null, message: null };
  }
  const r = look(obj, state);
  return { state: r.state, dialogue: r.dialogue, message: null };
}

/**
 * 【殘響】面前的物件。core 的 echo() 已處理：次數 0、鎖住且可用 trace 解開、物件的 echo 對話、沒有痕跡。
 * 面前沒有物件時 core 沒有對應 API（echo 需要物件），這裡補上同樣的訊息、不扣次數。
 */
export function useEcho(map, state, data) {
  const obj = facingTarget(map, state, data);
  if (!obj) {
    return { state, dialogue: null, message: hasEcho(state) ? NO_TRACE_MESSAGE : NO_CHARGE_MESSAGE };
  }
  const r = echo(obj, state, data);
  return { state: r.state, dialogue: r.dialogue ?? null, message: r.message ?? null };
}
