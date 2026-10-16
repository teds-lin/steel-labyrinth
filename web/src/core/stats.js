// 能力值與技能（DATA-FORMAT「戰鬥與隊伍」的「能力值」「characters.json」）。
// 能力值＝characters.base＋該角色譜系「已達到的所有階位」（rank ≥ 目前階位）的 stats 加總＋裝備（M2 沒有裝備）。
// 存檔不存能力值；一律由這裡算出。純函式，不修改輸入。
import { fill } from './name.js';

export const STAT_KEYS = Object.freeze(['hp', 'sp', 'atk', 'def', 'spd', 'will', 'eva']);
export const HERO_ID = 'hero';
/** 子彈上限、隊伍人數上限（主角永遠在隊伍第一位）。 */
export const MAX_AMMO = 12;
export const MAX_PARTY = 3;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const findById = (list, id) => (Array.isArray(list) ? list.find((x) => isObj(x) && x.id === id) : undefined);

/** characters.json 裡的角色定義；找不到回 undefined。 */
export const characterDef = (charId, data) => findById(data?.characters, charId);

function requireChar(charId, data) {
  const def = characterDef(charId, data);
  if (!def && charId !== HERO_ID) throw new Error(`找不到角色「${charId}」`);
  return def ?? null; // 主角沒有定義時（序章資料沒有 characters.json）視為全 0、沒有技能
}

/** 角色的譜系：主角來自 state.lineage；隊友固定寫在 characters.json。 */
export function characterLineage(charId, state, data) {
  const def = requireChar(charId, data);
  if (charId === HERO_ID) return state?.lineage ?? null;
  return isObj(def?.lineage) ? def.lineage : null;
}

/** 某個譜系＋階位已達到的階位（rank 數字 ≥ 目前階位），依取得順序（數字大到小）。 */
export function reachedRanksOf(lineage, data) {
  if (!isObj(lineage)) return [];
  const def = findById(data?.lineages, lineage.id);
  if (!def || !Array.isArray(def.ranks)) return [];
  return def.ranks
    .filter((r) => isObj(r) && isNum(r.rank) && r.rank >= lineage.rank)
    .sort((a, b) => b.rank - a.rank);
}

/** 能力值：回傳 { hp, sp, atk, def, spd, will, eva } 的新物件。 */
export function deriveStats(charId, state, data) {
  const def = requireChar(charId, data);
  const out = {};
  for (const k of STAT_KEYS) out[k] = isNum(def?.base?.[k]) ? def.base[k] : 0;
  for (const r of reachedRanksOf(characterLineage(charId, state, data), data)) {
    if (!isObj(r.stats)) continue;
    for (const k of STAT_KEYS) if (Object.hasOwn(r.stats, k) && isNum(r.stats[k])) out[k] += r.stats[k];
  }
  return out;
}

/** 實際可用技能＝characters.skills ∪ 譜系已達到階位的 skills（保持取得順序、不重複）。 */
export function availableSkills(charId, state, data) {
  const def = requireChar(charId, data);
  const out = [];
  const add = (list) => { for (const s of Array.isArray(list) ? list : []) if (typeof s === 'string' && !out.includes(s)) out.push(s); };
  add(def?.skills);
  for (const r of reachedRanksOf(characterLineage(charId, state, data), data)) add(r.skills);
  return out;
}

/** 把隊伍成員的目前值解析成數字：null＝滿值，超過上限夾到上限。 */
export function resolveMember(member, state, data) {
  const max = deriveStats(member.id, state, data);
  const cur = (v, m) => (v === null || v === undefined ? m : Math.min(m, Math.max(0, v)));
  return { id: member.id, hp: cur(member.hp, max.hp), sp: cur(member.sp, max.sp), max };
}

/** 畫面（HUD、選單）用：[{ id, name, hp, sp, max }]。 */
export function partyStatus(state, data) {
  const party = Array.isArray(state?.party) ? state.party : [];
  return party.map((m) => {
    const r = resolveMember(m, state, data);
    const def = characterDef(m.id, data);
    return { id: r.id, name: fill(def?.name ?? m.id, state), hp: r.hp, sp: r.sp, max: r.max };
  });
}
