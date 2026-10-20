// 敵人 AI（DATA-FORMAT「enemies.json」）：先過濾 if 成立的規則，再依 weight 加權抽選（用戰鬥 PRNG）。
// 意圖（下一次行動的技能與目標）在戰鬥開始時、以及每次行動後立刻決定並記在 unit.intent，
// 所以預兆揭露的內容必定成真。
import { nextFloat, nextInt } from '../rng.js';
import { hpRatio, hasStatus, BATTLE_STATUSES, skillDef, enemyDef, unitOf } from './stat.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const LEAF = Object.freeze(Object.assign(Object.create(null), {
  hp_lte_pct: (v) => isNum(v) && v >= 0 && v <= 100,
  turn_gte: (v) => Number.isInteger(v) && v >= 1,
  allies_lte: (v) => Number.isInteger(v) && v >= 0,
  target_has_status: (v) => typeof v === 'string' && BATTLE_STATUSES.includes(v),
}));

/** 靜態檢查戰鬥條件，回傳錯誤字串陣列。 */
export function checkBattleCondition(cond, path = 'if') {
  if (!isObj(cond)) return [`${path}：戰鬥條件必須是物件`];
  const keys = Object.keys(cond);
  if (keys.length !== 1) return [`${path}：戰鬥條件必須剛好一個鍵，實際為 ${JSON.stringify(keys)}`];
  const [k] = keys;
  const v = cond[k];
  if (Object.hasOwn(LEAF, k)) return LEAF[k](v) ? [] : [`${path}：「${k}」的值不合法：${JSON.stringify(v)}`];
  if (k === 'all' || k === 'any') {
    if (!Array.isArray(v)) return [`${path}：「${k}」必須是陣列`];
    return v.flatMap((c, i) => checkBattleCondition(c, `${path}.${k}[${i}]`));
  }
  if (k === 'not') return isObj(v) ? checkBattleCondition(v, `${path}.not`) : [`${path}：「not」必須是條件物件`];
  return [`${path}：未知的戰鬥條件寫法「${k}」`];
}

function evalChecked(cond, ctx) {
  const [k] = Object.keys(cond);
  const v = cond[k];
  const { battle, unit } = ctx;
  switch (k) {
    case 'hp_lte_pct': return hpRatio(unit) * 100 <= v;
    case 'turn_gte': return unit.acted + 1 >= v;
    case 'allies_lte': return battle.units.filter((u) => u.alive && u.side === unit.side).length <= v;
    case 'target_has_status': return (ctx.targets ?? []).some((t) => hasStatus(t, v));
    case 'all': return v.every((c) => evalChecked(c, ctx));
    case 'any': return v.some((c) => evalChecked(c, ctx));
    case 'not': return !evalChecked(v, ctx);
    default: throw new Error(`未知的戰鬥條件寫法「${k}」`);
  }
}

/** ctx = { battle, unit（決定行動的人）, targets（候選目標陣列） }。寫法不合法時丟錯。 */
export function evalBattleCondition(cond, ctx) {
  const errors = checkBattleCondition(cond);
  if (errors.length) throw new Error(`戰鬥條件不合法：${errors.join('；')}`);
  return evalChecked(cond, ctx);
}

const opponentsOf = (battle, unit) => battle.units.filter((u) => u.alive && u.side !== unit.side);
const alliesOf = (battle, unit) => battle.units.filter((u) => u.alive && u.side === unit.side);
const lowestRatio = (list) => list.reduce((best, u) => (best === null || hpRatio(u) < hpRatio(best) ? u : best), null);

/**
 * 自動選目標（敵人 AI、模擬策略用）。enemy＝對方陣營生命比例最低者（有 taunt 的優先）；
 * ally＝己方生命比例最低者；self＝自己；全體技能回 null。平手依 units 順序。
 */
export function chooseTarget(battle, unit, targetType) {
  switch (targetType) {
    case 'enemy': {
      const opp = opponentsOf(battle, unit);
      const taunting = opp.filter((u) => hasStatus(u, 'taunt'));
      return lowestRatio(taunting.length ? taunting : opp)?.uid ?? null;
    }
    case 'ally': return lowestRatio(alliesOf(battle, unit))?.uid ?? null;
    case 'self': return unit.uid;
    default: return null;
  }
}

/** 某種目標類型實際會作用到的人（給條件 target_has_status 與 engine 用）。 */
export function targetsFor(battle, unit, targetType, targetUid) {
  switch (targetType) {
    case 'enemy_all': return opponentsOf(battle, unit);
    case 'ally_all': return alliesOf(battle, unit);
    case 'self': return [unit];
    default: {
      const t = targetUid ? unitOf(battle, targetUid) : null;
      return t && t.alive ? [t] : [];
    }
  }
}

/** 敵人的 AI 規則＝enemies.json 的 ai ＋ 進入 phases 後追加的規則。 */
export function aiRules(unit, data) {
  const def = enemyDef(data, unit.id);
  return [...(Array.isArray(def.ai) ? def.ai : []), ...(unit.extraAi ?? [])];
}

const costSp = (skill) => (isObj(skill.cost) && isNum(skill.cost.sp) ? skill.cost.sp : 0);
const isSingle = (t) => t === 'enemy' || t === 'ally';

/** 在 draft 上（可變）決定 unit 的下一次行動；回傳 intent。engine 內部用。 */
export function decideIntentMut(draft, unit, data) {
  const rules = aiRules(unit, data);
  if (rules.length === 0) throw new Error(`敵人「${unit.id}」沒有任何 AI 規則`);
  const cands = rules.map((rule) => {
    const skill = skillDef(data, rule.skill);
    const target = chooseTarget(draft, unit, skill.target);
    const ok = rule.if === undefined || evalBattleCondition(rule.if, { battle: draft, unit, targets: targetsFor(draft, unit, skill.target, target) });
    return { rule, skill, target, ok };
  });
  const passing = cands.filter((c) => c.ok);
  // 禁聲中：消耗靈性的技能視同付不起（只能用不耗靈性的技能）
  const silenced = hasStatus(unit, 'silence');
  const affordable = passing.filter((c) => costSp(c.skill) <= unit.sp && !(silenced && costSp(c.skill) > 0));
  const pool = affordable.length ? affordable : passing.length ? passing : cands;
  const total = pool.reduce((n, c) => n + (isNum(c.rule.weight) && c.rule.weight > 0 ? c.rule.weight : 0), 0);
  let r;
  [r, draft.rng] = nextFloat(draft.rng);
  let pick = pool[pool.length - 1];
  if (total > 0) {
    let x = r * total;
    for (const c of pool) {
      const w = isNum(c.rule.weight) && c.rule.weight > 0 ? c.rule.weight : 0;
      if (x < w) { pick = c; break; }
      x -= w;
    }
  }
  let target = pick.target;
  if (isSingle(pick.skill.target) && hasStatus(unit, 'confuse')) {
    const others = draft.units.filter((u) => u.alive && u.uid !== unit.uid);
    if (others.length) {
      let i;
      [i, draft.rng] = nextInt(draft.rng, 0, others.length - 1);
      target = others[i].uid;
    }
  }
  unit.intent = { skill: pick.skill.id, target };
  unit.revealed = false;
  return unit.intent;
}

/** 純函式版：回傳 { battle（新）, intent }。 */
export function decideIntent(battle, uid, data) {
  const draft = structuredClone(battle);
  const unit = unitOf(draft, uid);
  if (!unit || unit.side !== 'enemy') throw new Error(`「${uid}」不是敵人`);
  const intent = decideIntentMut(draft, unit, data);
  return { battle: draft, intent };
}
