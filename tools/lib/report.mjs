// 回報資訊（web/src/ui/report-info.js 產生的文字）的解析：取出存檔字串、驗證、產生瀏覽器 console 指令。
// 給 tools/load-report.mjs 與單元測試共用。
import { deserialize, sanitizeLoadedState, KEY_PREFIX, SLOT_COUNT } from '../../web/src/core/save.js';
import { REPORT_SAVE_MARKER } from '../../web/src/ui/report-info.js';

/** 去掉貼到討論區後可能多出的引用符號「> 」與行尾的 \r。 */
const cleanLine = (line) => line.replace(/\r$/, '').replace(/^\s*(?:>\s?)+/, '');
const isFence = (line) => /^\s*(```|~~~)/.test(line);

/**
 * 從回報文字取出存檔字串：分隔線之後第一個非空白、不是程式碼區塊標記的行（存檔是單行 JSON）。
 * 找不到回 null。
 */
export function extractSaveString(text) {
  if (typeof text !== 'string' || text === '') return null;
  const lines = text.split('\n').map(cleanLine);
  const at = lines.findIndex((l) => l.trim() === REPORT_SAVE_MARKER);
  if (at < 0) return null;
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === '' || isFence(l)) continue;
    return l.trim();
  }
  return null;
}

/**
 * 取出並驗證存檔：deserialize → sanitizeLoadedState（與遊戲讀檔相同）。
 * 回傳 { ok:true, saveString, state, warnings } 或 { ok:false, saveString|null, reason }。
 */
export function checkReport(text, data) {
  const saveString = extractSaveString(text);
  if (saveString === null) return { ok: false, saveString: null, reason: `找不到存檔內容（回報裡要有「${REPORT_SAVE_MARKER}」那一行與其後的存檔字串）` };
  let state;
  try {
    state = deserialize(saveString);
  } catch (e) {
    return { ok: false, saveString, reason: String(e?.message ?? e) };
  }
  let r;
  try {
    r = sanitizeLoadedState(state, data);
  } catch (e) {
    return { ok: false, saveString, reason: `存檔內容有誤：${e?.message ?? e}` };
  }
  if (!r?.ok) return { ok: false, saveString, reason: String(r?.reason ?? '存檔內容有誤') };
  return { ok: true, saveString, state: r.state, warnings: Array.isArray(r.warnings) ? r.warnings : [] };
}

/** 可直接貼到瀏覽器 console 的指令：把存檔字串寫進指定槽位（JSON.stringify 產生合法的 JS 字串字面值）。 */
export function consoleCommand(saveString, slot = 1) {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) throw new Error(`槽位只能是 1～${SLOT_COUNT}：${slot}`);
  return `localStorage.setItem('${KEY_PREFIX}${slot}', ${JSON.stringify(String(saveString))});`;
}
