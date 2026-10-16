// 畫面層與 core 之間的小型轉接：把【調查】【殘響】按鈕（對「面前那一格」）轉成 core 的呼叫。
// 調查／殘響的規則全部在 core（investigate、echo、echoAvailable），這裡只負責找出面前的物件。
import { facingTarget, investigate, echo, echoAvailable, NO_TRACE_MESSAGE, NO_CHARGE_MESSAGE } from './core/interact.js';

/** 【調查】面前的物件。回傳 { state, dialogues, message }；dialogues 依序播放。 */
export function investigateFacing(map, state, data) {
  const obj = facingTarget(map, state, data);
  if (!obj) return { state, dialogues: [], message: null };
  const r = investigate(obj, state, data);
  return { state: r.state, dialogues: r.dialogues ?? [], message: null };
}

/**
 * 【殘響】面前的物件。core 的 echo() 需要物件；面前沒有物件時依 echoAvailable 給同樣的提示、不改 state。
 */
export function echoFacing(map, state, data) {
  const obj = facingTarget(map, state, data);
  if (!obj) {
    return { state, dialogues: [], message: echoAvailable(state, data).usable ? NO_TRACE_MESSAGE : NO_CHARGE_MESSAGE };
  }
  const r = echo(obj, state, data);
  return { state: r.state, dialogues: r.dialogue ? [r.dialogue] : [], message: r.message ?? null };
}

/** 讀檔警告（core 給的是除錯用的詳細訊息）轉成給玩家看的提示，詳細內容留在 console。 */
export function loadNotice(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return null;
  console.warn('讀檔時修正了存檔內容：', warnings);
  const msgs = new Set(warnings.map((w) => {
    const s = String(w);
    if (/位置/.test(s)) return '存檔位置異常，已移到起點';
    if (/名字/.test(s)) return '存檔的名字已重新整理';
    return '存檔有部分內容異常，已自動修正';
  }));
  return [...msgs].join('\n');
}
