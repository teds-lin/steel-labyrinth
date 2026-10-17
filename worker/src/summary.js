// 存檔驗證與摘要：直接使用客戶端共用的 web/src/core/save.js（不另寫一套驗證）。
import { deserialize } from '../../web/src/core/save.js';
import { sanitizeName, graphemes, MAX_NAME_LENGTH } from '../../web/src/core/name.js';

/** 存檔內容（data 字串）上限 64 KB（UTF-8 位元組）。 */
export const DATA_LIMIT = 64 * 1024;

const str = (v) => (typeof v === 'string' ? v : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clipName = (name) => graphemes(sanitizeName(name)).slice(0, MAX_NAME_LENGTH).join('');

/**
 * 驗證存檔並算出摘要 { name, map, chapter, playtime_s, schema_version }。
 * - 通過 deserialize（含舊版遷移）→ 用遷移後的 state 算摘要；schema_version 記原始版本。
 * - deserialize 回 newer（比伺服器的遊戲版本新）→ 照樣接受，摘要欄位盡量從原始 JSON 取，取不到就是 null。
 * - 其他錯誤 → { ok:false }。
 */
export function buildSummary(data) {
  let state;
  try {
    state = deserialize(data);
  } catch (e) {
    if (e?.code !== 'newer') return { ok: false };
    const raw = JSON.parse(data); // deserialize 已確認是物件且有整數 schema_version
    const name = isObj(raw.player) && typeof raw.player.name === 'string' ? clipName(raw.player.name) : null;
    const playtime = typeof raw.playtime_s === 'number' && Number.isFinite(raw.playtime_s) && raw.playtime_s >= 0 ? raw.playtime_s : null;
    return {
      ok: true,
      summary: {
        name,
        map: isObj(raw.location) ? str(raw.location.map) : null,
        chapter: str(raw.chapter),
        playtime_s: playtime,
        schema_version: raw.schema_version,
      },
    };
  }
  return {
    ok: true,
    summary: {
      name: clipName(state.player.name),
      map: state.location.map,
      chapter: state.chapter,
      playtime_s: state.playtime_s,
      schema_version: JSON.parse(data).schema_version,
    },
  };
}
