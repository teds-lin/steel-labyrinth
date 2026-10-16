// 戰鬥中的行動者（unit）：純資料。
// { uid, side:'party'|'enemy', id, name, sprite, stats（上限／基礎值）, hp, sp, ct, mods, status, alive, acted,
//   skills, intent（敵人：{ skill, target }）, revealed（意圖是否已被預兆揭露）, phasesDone, extraAi }
import { STAT_KEYS, deriveStats, availableSkills, resolveMember, characterDef } from '../stats.js';
import { fill } from '../name.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function blank(uid, side, id, name, sprite, stats, hp, sp, skills) {
  return {
    uid, side, id, name, sprite: sprite ?? id, stats, hp, sp, ct: 0, mods: {}, status: {}, alive: hp > 0, acted: 0,
    skills, intent: null, revealed: false, phasesDone: [], extraAi: [],
  };
}

export function makePartyUnit(member, index, state, data) {
  const r = resolveMember(member, state, data);
  const def = characterDef(member.id, data);
  return blank(`p${index}`, 'party', member.id, fill(def?.name ?? member.id, state), def?.sprite, deriveStats(member.id, state, data),
    r.hp, r.sp, availableSkills(member.id, state, data));
}

export function makeEnemyUnit(def, uid) {
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = num(def.stats?.[k]);
  const u = blank(uid, 'enemy', def.id, def.name ?? def.id, def.sprite, stats, stats.hp, stats.sp, [...(def.skills ?? [])]);
  u.rank = def.rank ?? null;
  return u;
}
