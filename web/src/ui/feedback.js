// 意見回饋：按鈕與提示頁的文字、開新分頁前往 GitHub 討論區。
// 網址只定義在 config.js 的 FEEDBACK_URL；這裡的手動前往提示由它推導，不另寫一份。
import { FEEDBACK_URL } from '../config.js';

export const FEEDBACK_LABEL = '意見回饋';
export const FEEDBACK_TITLE = '意見回饋';
export const FEEDBACK_BODY = '即將在新分頁開啟 GitHub 討論區。你可以在那裡回報問題、提出建議，或分享遊玩心得。（發文需要 GitHub 帳號）';
export const FEEDBACK_GO = '前往討論區';
export const FEEDBACK_CANCEL = '取消';
/** 複製回報資訊（回報內容由 ui/report-info.js 產生；不含雲端權杖或轉移碼）。 */
export const REPORT_COPY_LABEL = '複製回報資訊';
export const REPORT_COPIED = '已複製，請貼到討論區的回報表單裡';
export const REPORT_COPY_FAILED = '無法自動複製，請在下方框內全選文字後手動複製';
export const REPORT_PRIVACY = '回報資訊會包含你的角色名字與遊戲進度';

/** 顯示用網址：去掉 https:// 與結尾斜線。 */
export function feedbackDisplayUrl(url = FEEDBACK_URL) {
  return String(url).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** 新分頁被瀏覽器擋下時的提示。 */
export function feedbackBlockedText(url = FEEDBACK_URL) {
  return `瀏覽器擋下了新分頁，請手動前往：${feedbackDisplayUrl(url)}`;
}

/**
 * 提示頁顯示用的排版（只改顯示）：空白改成不換行空白，讓自動換行逐字斷行，
 * 不會在「GitHub」前後的空白斷成很短的第一行；手動前往的網址另起一行，太長時在帳號後的斜線換行（不會只剩一個字掉到下一行）。
 */
export function feedbackNoteForDisplay(text) {
  return String(text ?? '')
    .replace(/ /g, '\u00a0')
    .replace('請手動前往：', '請手動前往：\n')
    .replace(/(：\n[^/\n]+\/[^/\n]+\/)/, '$1\n');
}

/**
 * 以新分頁開啟討論區；必須在使用者輸入事件（pointerup／touchend／keydown）的同步處理中呼叫，
 * 否則會被瀏覽器當成彈出視窗擋下。回傳 true＝已開啟，false＝被擋下（或沒有 window.open）。
 *
 * 不帶 'noopener,noreferrer'：依 HTML 規格，帶了 noopener／noreferrer 的 window.open 一律回傳 null
 * （即使成功開啟），就無法分辨「被擋下」。改成開啟後立刻把新分頁的 opener 設為 null，
 * 在 GitHub 的頁面載入前就切斷它對本頁的存取（效果等同 noopener）。
 */
export function openFeedback(win = globalThis.window) {
  let child = null;
  try {
    child = typeof win?.open === 'function' ? win.open(FEEDBACK_URL, '_blank') : null;
  } catch {
    child = null;
  }
  if (!child) return false;
  try { child.opener = null; } catch { /* 少數環境 opener 唯讀：已經開啟，照樣算成功 */ }
  return true;
}
