// 遊戲事實狀態：建立新遊戲、計算探索標籤、推導能力值。
import { sanitizeName } from './name.js';
import { ECHO_TAG, hasEcho } from './echo.js';
import { CURRENT_VERSION, MAX_ECHO_CHARGES } from './save.js';

/** manifest.start.echo_charges 沒寫時的殘響次數。序章在 manifest 裡寫 3。 */
export const DEFAULT_ECHO_CHARGES = 0;

const findById = (list, id) => (Array.isArray(list) ? list.find((x) => x?.id === id) : undefined);

/**
 * 建立初始狀態。maps（選填）用來把 start.spawn 解析成座標；
 * 未提供時 location 帶 spawn、x/y 為 null，由 grid.enterMap 解析。
 */
export function newGame({ name, manifest, maps } = {}) {
  const start = manifest?.start;
  if (!start || typeof start.map !== 'string') throw new Error('manifest 缺少 start.map');
  const echoCharges = start.echo_charges ?? DEFAULT_ECHO_CHARGES;
  if (!Number.isInteger(echoCharges) || echoCharges < 0 || echoCharges > MAX_ECHO_CHARGES) {
    throw new Error(`manifest.start.echo_charges 必須是 0～${MAX_ECHO_CHARGES} 的整數，實際為 ${JSON.stringify(start.echo_charges)}`);
  }
  let location = { map: start.map, spawn: start.spawn, x: null, y: null, dir: 'down' };
  if (maps !== undefined) {
    const map = findById(maps, start.map);
    if (!map) throw new Error(`找不到起始地圖「${start.map}」`);
    const sp = findById(map.spawns, start.spawn);
    if (!sp) throw new Error(`起始地圖「${start.map}」找不到 spawn「${start.spawn}」`);
    location = { map: map.id, x: sp.x, y: sp.y, dir: sp.dir ?? 'down' };
  }
  return {
    schema_version: CURRENT_VERSION,
    player: { name: sanitizeName(name) },
    lineage: null,
    location,
    flags: {},
    items: {},
    echo: { charges: echoCharges },
    collapse: 0,
    resonance: {},
    chapter: manifest.chapters?.[0] ?? null,
    chapter_done: [],
    playtime_s: 0,
  };
}

/** 目前譜系已達到的階位（rank 數字 >= 目前階位）。找不到譜系回空陣列。 */
function reachedRanks(state, data) {
  const lin = state?.lineage;
  if (!lin) return [];
  const def = findById(data?.lineages, lin.id);
  if (!def || !Array.isArray(def.ranks)) return [];
  return def.ranks.filter((r) => typeof r?.rank === 'number' && r.rank >= lin.rank);
}

/** 譜系提供的永久標籤（排序、不重複）。 */
export function lineageFieldTags(state, data) {
  const tags = new Set(reachedRanks(state, data).flatMap((r) => (Array.isArray(r.field) ? r.field : [])));
  return [...tags].sort();
}

/** 暫時能力提供的標籤（序章：殘響 > 0 時提供 trace）。 */
export function temporaryFieldTags(state) {
  return hasEcho(state) ? [ECHO_TAG] : [];
}

/** 目前可用的探索標籤＝譜系已達階位的 field ∪ 暫時能力。 */
export function availableFieldTags(state, data) {
  return [...new Set([...lineageFieldTags(state, data), ...temporaryFieldTags(state)])].sort();
}

/** 能力值（M1 無戰鬥）：回傳目前階位 stats 的複本，沒有則空物件。 */
export function deriveStats(state, data) {
  const lin = state?.lineage;
  if (!lin) return {};
  const def = findById(data?.lineages, lin.id);
  const cur = def?.ranks?.find?.((r) => r?.rank === lin.rank);
  return cur?.stats ? { ...cur.stats } : {};
}
