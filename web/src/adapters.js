// 畫面層與 core 之間的小型轉接：把【調查】【殘響】按鈕（對「面前那一格」）轉成 core 的呼叫。
// 調查／殘響的規則全部在 core（investigate、echo、echoAvailable），這裡只負責找出面前的物件。
import { facingTarget, investigate, echo, echoAvailable, NO_TRACE_MESSAGE, NO_CHARGE_MESSAGE } from './core/interact.js';
import { ECHO_TAG } from './core/echo.js';

/** core 回報的 unlock（{ via, tag }）→ 畫面要播標籤演出時的 { tag }；用道具、或用 trace（殘響本身已有演出）時 null。 */
const tagUnlock = (u) => (u && u.via === 'tag' && typeof u.tag === 'string' && u.tag !== ECHO_TAG ? { tag: u.tag } : null);

/**
 * 【調查】面前的物件。回傳 { state, dialogues, message, battle, dream, guest, unlock }；dialogues 依序播放，物件有 battle 時播完後開戰。
 * unlock（M5）：這次用探索標籤（trace 以外）解開了鎖時為 { tag }（例如 voice＝借聲），否則 null。解鎖方式由 core 的 investigate 回報。
 */
export function investigateFacing(map, state, data) {
  const obj = facingTarget(map, state, data);
  if (!obj) return { state, dialogues: [], message: null, battle: null, dream: null, guest: null, unlock: null };
  const r = investigate(obj, state, data);
  return {
    unlock: r.unlock?.via === 'tag' ? { tag: r.unlock.tag } : null,
    state: r.state, dialogues: r.dialogues ?? [], message: null, battle: typeof r.battle === 'string' ? r.battle : null,
    dream: r.dream ?? null, // 鐘塔之夢：播完後問「入夢」
    guest: typeof r.guest === 'string' ? r.guest : null,
  };
}

/**
 * 【殘響】（解鎖鍵）面前的物件。core 的 echo() 需要物件；面前沒有物件時依 echoAvailable 給同樣的提示、不改 state。
 * 「鎖不吃 trace、但譜系的其他免費標籤（voice、shadow）解得開」的規則在 core 的 echo()（DATA-FORMAT M5 整合補充）。
 */
export function echoFacing(map, state, data) {
  const obj = facingTarget(map, state, data);
  if (!obj) {
    return { state, dialogues: [], message: echoAvailable(state, data).usable ? NO_TRACE_MESSAGE : NO_CHARGE_MESSAGE, unlock: null };
  }
  const r = echo(obj, state, data);
  return { state: r.state, dialogues: r.dialogue ? [r.dialogue] : [], message: r.message ?? null, unlock: tagUnlock(r.unlock) };
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
