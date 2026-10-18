// 戰鬥中的能力值（含增益／減益）。turnorder／effects／ai／engine 共用。
// 增益與減益以「種類:能力值」為鍵存在 unit.mods：{ 'buff:eva': { pct 或 amount, turns } }；
// 同一能力值同類效果只留最新的（覆蓋），增益與減益可以並存。
// 實際值＝基礎值 ×（100＋增益 pct − 減益 pct）÷ 100 ＋ 增益 amount − 減益 amount，最少 0。

const modOf = (unit, kind, stat, field) => {
  const m = unit?.mods?.[`${kind}:${stat}`];
  return m && typeof m[field] === 'number' ? m[field] : 0;
};
const pctOf = (unit, kind, stat) => modOf(unit, kind, stat, 'pct');

/** 戰鬥中的實際能力值。 */
export function effectiveStat(unit, stat) {
  const base = unit?.stats?.[stat];
  const b = typeof base === 'number' && Number.isFinite(base) ? base : 0;
  const scaled = (b * (100 + pctOf(unit, 'buff', stat) - pctOf(unit, 'debuff', stat))) / 100;
  return Math.max(0, scaled + modOf(unit, 'buff', stat, 'amount') - modOf(unit, 'debuff', stat, 'amount'));
}

/** 生命比例（0～1）；上限 0 時當 0。 */
export const hpRatio = (unit) => (unit.stats.hp > 0 ? unit.hp / unit.stats.hp : 0);

/** 狀態（status 積木）。 */
// bind（影縛，M5）：持續期間跳過行動；受到傷害不會解除（和 sleep 不同）；機率受意志減免（敵對效果，同其他狀態）。
export const BATTLE_STATUSES = Object.freeze(['sleep', 'confuse', 'taunt', 'guard', 'bind']);
/** buff／debuff 與 damage.stat 可以用的能力值（hp／sp 是資源，不吃百分比增減）。 */
export const MOD_STATS = Object.freeze(['atk', 'def', 'spd', 'will', 'eva']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const findIn = (list, id) => (Array.isArray(list) ? list.find((x) => isObj(x) && x.id === id) : undefined);

/** 查技能定義；找不到丟錯。 */
export function skillDef(data, id) {
  const s = findIn(data?.skills, id);
  if (!s) throw new Error(`找不到技能「${id}」`);
  return s;
}
/** 查敵人定義；找不到丟錯。 */
export function enemyDef(data, id) {
  const e = findIn(data?.enemies, id);
  if (!e) throw new Error(`找不到敵人「${id}」`);
  return e;
}

export const unitOf = (battle, uid) => battle.units.find((u) => u.uid === uid);
export const hasStatus = (unit, s) => typeof unit?.status?.[s] === 'number' && unit.status[s] > 0;
