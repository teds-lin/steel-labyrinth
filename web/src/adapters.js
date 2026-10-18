// 畫面層與 core 之間的小型轉接：把【調查】【殘響】按鈕（對「面前那一格」）轉成 core 的呼叫。
// 調查／殘響的規則全部在 core（investigate、echo、echoAvailable），這裡只負責找出面前的物件。
import { facingTarget, investigate, echo, echoAvailable, tryUnlock, NO_TRACE_MESSAGE, NO_CHARGE_MESSAGE } from './core/interact.js';
import { isUnlocked } from './core/grid.js';
import { ECHO_TAG } from './core/echo.js';

/**
 * 這次（不花代價）解鎖會不會用到探索標籤：會的話回傳 { tag }（畫面播借聲／換影等演出），否則 null。
 * 和 investigate 內部用同一個 tryUnlock（純函式、同樣的參數），所以結果一致。
 */
function freeTagUnlock(obj, state, data, opts = {}) {
  if (!obj?.lock || isUnlocked(obj, state)) return null;
  const r = tryUnlock(obj, state, data, { allowCost: false, ...opts });
  return r.unlocked && r.via === 'tag' ? { tag: r.tag, result: r } : null;
}

/**
 * 【調查】面前的物件。回傳 { state, dialogues, message, battle, dream, guest, unlock }；dialogues 依序播放，物件有 battle 時播完後開戰。
 * unlock（M5）：這次用探索標籤解開了鎖時為 { tag }（例如 voice＝借聲），否則 null。
 */
export function investigateFacing(map, state, data) {
  const obj = facingTarget(map, state, data);
  if (!obj) return { state, dialogues: [], message: null, battle: null, dream: null, guest: null, unlock: null };
  const tagged = freeTagUnlock(obj, state, data);
  const r = investigate(obj, state, data);
  return {
    unlock: tagged ? { tag: tagged.tag } : null,
    state: r.state, dialogues: r.dialogues ?? [], message: null, battle: typeof r.battle === 'string' ? r.battle : null,
    dream: r.dream ?? null, // 鐘塔之夢：播完後問「入夢」
    guest: typeof r.guest === 'string' ? r.guest : null,
  };
}

/**
 * 【殘響】（解鎖鍵）面前的物件。core 的 echo() 需要物件；面前沒有物件時依 echoAvailable 給同樣的提示、不改 state。
 * M5：鎖不吃 trace、但譜系提供的其他免費標籤（voice、shadow…）解得開時，自動改用那個標籤（不用道具、不花代價），
 * 回傳的 unlock 為 { tag }。其他情況照舊交給 echo()。
 */
export function echoFacing(map, state, data) {
  const obj = facingTarget(map, state, data);
  if (!obj) {
    return { state, dialogues: [], message: echoAvailable(state, data).usable ? NO_TRACE_MESSAGE : NO_CHARGE_MESSAGE, unlock: null };
  }
  if (obj.lock && !(obj.lock.solvable_by ?? []).includes(ECHO_TAG)) {
    const tagged = freeTagUnlock(obj, state, data, { method: 'tag' });
    if (tagged) {
      const u = tagged.result;
      return { state: u.state, dialogues: u.dialogue ? [u.dialogue] : [], message: null, unlock: { tag: tagged.tag } };
    }
  }
  const r = echo(obj, state, data);
  const tag = r.unlocked && r.via === 'tag' ? r.tag : null;
  return { state: r.state, dialogues: r.dialogue ? [r.dialogue] : [], message: r.message ?? null, unlock: tag && tag !== ECHO_TAG ? { tag } : null };
}

/** 讀檔警告 code（core/save.js）→ 給玩家看的提示。 */
const WARNING_TEXT = {
  relocated: '存檔位置異常，已移到起點',
  name_sanitized: '存檔的名字已重新整理',
  party_clamped: '隊伍的生命或靈性超過上限，已調整',
  dream_return_reset: '夢醒後要回去的位置異常，已改成這一章的起點',
  dream_return_relocated: '夢醒後要回去的位置異常，已移到該地圖的起點',
  woke_up: '夢境已經不存在，你從夢中醒來了',
  ending_reset: '存檔記錄的結局已經不存在，已清除',
};

/** 讀檔警告（core 給的是除錯用的詳細訊息）轉成給玩家看的提示，詳細內容留在 console。 */
export function loadNotice(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  console.warn(`讀檔時修正了存檔內容：\n${warnings.map((w) => `- ${w?.message ?? w?.code ?? String(w)}`).join('\n')}`);
  const msgs = new Set(warnings.map((w) => WARNING_TEXT[w?.code] ?? '存檔有部分內容異常，已自動修正'));
  return [...msgs].join('\n');
}
