// 遊戲事實狀態：建立新遊戲、計算探索標籤、推導能力值。
import { sanitizeName } from './name.js';
import { ECHO_TAG, hasEcho } from './echo.js';
import { CURRENT_VERSION, MAX_ECHO_CHARGES } from './save.js';
import { HERO_ID, reachedRanksOf, deriveStats as deriveCharStats } from './stats.js';

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
    party: [{ id: HERO_ID, hp: null, sp: null }], // null＝滿值（上限由 deriveStats 算）
    ammo: 0,
    pending: null,
    dream_return: null, // 存檔 v3：夢境中記住的現實位置（{ map, x, y, dir }）
  };
}

/** 目前譜系已達到的階位（rank 數字 >= 目前階位）。找不到譜系回空陣列。 */
function reachedRanks(state, data) {
  return reachedRanksOf(state?.lineage, data);
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

/**
 * 能力值：轉呼叫 stats.js。
 * - 新介面 deriveStats(charId, state, data)。
 * - M1 舊介面 deriveStats(state, data)：等同 deriveStats('hero', state, data)。
 */
export function deriveStats(...args) {
  if (typeof args[0] === 'string') return deriveCharStats(args[0], args[1], args[2]);
  return deriveCharStats(HERO_ID, args[0], args[1]);
}
