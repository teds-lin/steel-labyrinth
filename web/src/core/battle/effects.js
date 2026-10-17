// 戰鬥效果積木（DATA-FORMAT「效果積木」「公式」）。套用到戰鬥狀態。
// 對外：applyBattleEffect（純函式）；engine 內部用 applyEffectMut 在 draft 上就地套用。
// 未知的 type 或欄位型別錯誤一律丟錯。
import { nextFloat, chance } from '../rng.js';
import { HERO_ID } from '../stats.js';
import { effectiveStat, hpRatio, hasStatus, BATTLE_STATUSES, MOD_STATS, enemyDef, unitOf } from './stat.js';
import { makeEnemyUnit } from './units.js';
import { decideIntentMut } from './ai.js';

export { BATTLE_STATUSES, MOD_STATS };
export const CRIT_CHANCE = 5;
export const CRIT_MULT = 1.5;
export const GUARD_MULT = 0.5;
export const DEF_FACTOR = 0.5;
export const RAND_MIN = 0.9;
export const RAND_MAX = 1.1;
export const COLLAPSE_MAX = 100;
/** 規格補充 2 第 3 條：執行被預兆揭露的意圖時，對我方的傷害與崩解增加量乘上這個值（其他減免之後；round，最少 1）。 */
export const FORESEEN_MULT = 0.5;
const foresee = (v) => Math.max(1, Math.round(v * FORESEEN_MULT));
/** 規格補充 3 第 2 條：睡眠中的目標受到的第一次傷害 × 這個值（其他倍率之後、round 之前），然後醒來。 */
export const SLEEP_MULT = 1.5;
/** 這些積木一次行動只作用一次（不分目標）；其他積木逐一作用在每個目標上。 */
export const ONCE_PER_ACTION = Object.freeze(['collapse', 'summon']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const posNum = (v) => isNum(v) && v > 0;
const posInt = (v) => Number.isInteger(v) && v > 0;
const isBool = (v) => typeof v === 'boolean';
const nonZeroInt = (v) => Number.isInteger(v) && v !== 0;

// 每種積木：{ 欄位: [必填?, 檢查] }；共通的選填欄位 on（只能是 'self'）。
const SPEC = Object.freeze(Object.assign(Object.create(null), {
  damage: { power: [false, posNum], stat: [false, (v) => MOD_STATS.includes(v)], ignore_def: [false, isBool], fixed: [false, posInt] },
  heal: { pct: [false, posNum], amount: [false, posInt] },
  sp: { amount: [true, nonZeroInt] },
  buff: { stat: [true, (v) => MOD_STATS.includes(v)], pct: [false, posNum], amount: [false, posInt], turns: [true, posInt] },
  debuff: { stat: [true, (v) => MOD_STATS.includes(v)], pct: [false, posNum], amount: [false, posInt], turns: [true, posInt] },
  status: { status: [true, (v) => BATTLE_STATUSES.includes(v)], chance: [false, (v) => isNum(v) && v > 0 && v <= 100], turns: [true, posInt] },
  reveal_intent: {},
  collapse: { amount: [true, nonZeroInt] },
  summon: { enemy: [true, (v) => typeof v === 'string' && v !== ''], max: [true, posInt] },
}));

/** 靜態檢查一個效果積木，回傳錯誤字串陣列。 */
export function checkBattleEffect(e, path = 'effect') {
  if (!isObj(e)) return [`${path}：效果積木必須是物件`];
  const { type } = e;
  if (typeof type !== 'string' || !Object.hasOwn(SPEC, type)) return [`${path}：未知的效果積木 type「${String(type)}」`];
  const spec = SPEC[type];
  const errs = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === 'type') continue;
    if (k === 'on') { if (v !== 'self') errs.push(`${path}：on 只能是 "self"`); continue; }
    if (!Object.hasOwn(spec, k)) { errs.push(`${path}：${type} 不認得的欄位「${k}」`); continue; }
    if (!spec[k][1](v)) errs.push(`${path}：${type}.${k} 的值不合法：${JSON.stringify(v)}`);
  }
  for (const [k, [required]] of Object.entries(spec)) if (required && !Object.hasOwn(e, k)) errs.push(`${path}：${type} 缺少 ${k}`);
  if (type === 'damage') {
    const hasP = Object.hasOwn(e, 'power');
    const hasF = Object.hasOwn(e, 'fixed');
    if (hasP === hasF) errs.push(`${path}：damage 必須剛好有 power 或 fixed 其中之一`);
  }
  if ((type === 'heal' || type === 'buff' || type === 'debuff') && Object.hasOwn(e, 'pct') === Object.hasOwn(e, 'amount')) {
    errs.push(`${path}：${type} 必須剛好有 pct 或 amount 其中之一`);
  }
  return errs;
}

// ---------- 公式（純數學，平衡測試共用） ----------

/** 傷害：atk × power ÷ 100，未 ignoreDef 時 −def × 0.5；× mult、爆擊 ×1.5、防禦中 ×0.5、睡眠中 ×1.5；round，最少 1。 */
export function damageAmount({ atk, power, def = 0, ignoreDef = false, mult = 1, crit = false, guard = false, sleep = false }) {
  let v = (atk * power) / 100;
  if (!ignoreDef) v -= def * DEF_FACTOR;
  v *= mult;
  if (crit) v *= CRIT_MULT;
  if (guard) v *= GUARD_MULT;
  if (sleep) v *= SLEEP_MULT;
  return Math.max(1, Math.round(v));
}

/** 命中率（%）：攻擊方是敵人、目標是我方時＝100 − 目標 eva（含增益），夾在 0～100；其餘必中。 */
export function hitChance(attacker, target) {
  if (attacker.side !== 'enemy' || target.side === attacker.side) return 100;
  return Math.min(100, Math.max(0, 100 - effectiveStat(target, 'eva')));
}

/** 異常狀態機率（%）：對敵對陣營＝chance × 50 ÷ (50＋目標 will)；對自己／同陣營不減免。 */
export function statusChance(base, source, target) {
  if (source.side === target.side) return base;
  return (base * 50) / (50 + effectiveStat(target, 'will'));
}

/** 崩解實際值：增加時＝round(amount × 50 ÷ (50＋主角 will))；降低（負值）時不受意志縮放。 */
export const collapseAmount = (amount, will) => (amount < 0 ? amount : Math.round((amount * 50) / (50 + will)));

/** 主角的 will（含增益）；主角倒下也照算。 */
function heroWill(draft) {
  const hero = draft.units.find((u) => u.side === 'party' && u.id === HERO_ID);
  return hero ? effectiveStat(hero, 'will') : 0;
}

// ---------- 套用 ----------

function rollDrops(draft, unit, data, log) {
  const def = enemyDef(data, unit.id);
  for (const d of Array.isArray(def.drops) ? def.drops : []) {
    let ok;
    [ok, draft.rng] = chance(draft.rng, d.chance);
    if (!ok) continue;
    const cur = draft.drops.find((x) => x.item === d.item);
    if (cur) cur.count += 1; else draft.drops.push({ item: d.item, count: 1 });
    log.push({ type: 'drop', uid: unit.uid, item: d.item });
  }
}

/** 生命降到門檻以下 → 進入該階段。一次跨過多個門檻時依門檻由高到低依序觸發（同門檻依資料順序），每段只觸發一次。 */
function checkPhases(draft, unit, data, log) {
  const def = enemyDef(data, unit.id);
  const phases = (Array.isArray(def.phases) ? def.phases : []).map((ph, index) => ({ ph, index }))
    .sort((a, b) => b.ph.hp_lte_pct - a.ph.hp_lte_pct || a.index - b.index);
  phases.forEach(({ ph, index }) => {
    if (unit.phasesDone.includes(index) || !(hpRatio(unit) * 100 <= ph.hp_lte_pct)) return;
    unit.phasesDone.push(index);
    unit.extraAi.push(...structuredClone(Array.isArray(ph.add_ai) ? ph.add_ai : []));
    log.push({ type: 'phase', uid: unit.uid, index, dialogue: typeof ph.dialogue === 'string' ? ph.dialogue : null });
  });
}

/** 讓 unit 倒下：清掉狀態與意圖；敵人擲掉落。 */
function defeat(draft, unit, data, log) {
  unit.hp = 0;
  unit.alive = false;
  unit.status = {};
  unit.mods = {};
  unit.intent = null;
  unit.revealed = false;
  log.push({ type: 'defeated', uid: unit.uid });
  if (unit.side === 'enemy') rollDrops(draft, unit, data, log);
}

/**
 * 在 draft 上就地套用一個積木（engine 內部用）。sourceUid 是施放者；targetUid 是這個積木的目標
 * （collapse／summon 不看目標）。戰鬥已結束時不做任何事。
 * opts.foreseen：這是被預兆揭露的敵人意圖 → 對我方的傷害、崩解增加量 × FORESEEN_MULT（事件帶 foreseen: true）。
 */
export function applyEffectMut(draft, effect, sourceUid, targetUid, data, log, opts = {}) {
  const errs = checkBattleEffect(effect);
  if (errs.length) throw new Error(`效果積木不合法：${errs.join('；')}`);
  if (draft.outcome !== null) return;
  const source = unitOf(draft, sourceUid);
  if (!source) throw new Error(`找不到施放者「${sourceUid}」`);
  const target = targetUid === null || targetUid === undefined ? null : unitOf(draft, targetUid);
  const needTarget = !ONCE_PER_ACTION.includes(effect.type);
  if (needTarget && !target) throw new Error(`找不到目標「${targetUid}」`);
  if (needTarget && !target.alive) return; // 倒下的目標不受任何效果

  switch (effect.type) {
    case 'damage': {
      let amount;
      let crit = false;
      const sleeping = hasStatus(target, 'sleep');
      if (Object.hasOwn(effect, 'fixed')) {
        amount = sleeping ? Math.max(1, Math.round(effect.fixed * SLEEP_MULT)) : effect.fixed;
      } else {
        let r;
        [r, draft.rng] = nextFloat(draft.rng);
        const mult = RAND_MIN + r * (RAND_MAX - RAND_MIN);
        [crit, draft.rng] = chance(draft.rng, CRIT_CHANCE);
        amount = damageAmount({
          atk: effectiveStat(source, effect.stat ?? 'atk'), power: effect.power, def: effectiveStat(target, 'def'),
          ignoreDef: effect.ignore_def === true, mult, crit, guard: hasStatus(target, 'guard'), sleep: sleeping,
        });
        if (crit) log.push({ type: 'crit', source: source.uid, target: target.uid });
      }
      const foreseen = opts.foreseen === true && target.side === 'party';
      if (foreseen) amount = foresee(amount);
      target.hp = Math.max(0, target.hp - amount);
      log.push({ type: 'damage', source: source.uid, target: target.uid, amount, crit, hp: target.hp, ...(foreseen ? { foreseen: true } : {}), ...(sleeping ? { sleeping: true } : {}) });
      if (target.hp === 0) { defeat(draft, target, data, log); return; }
      if (amount >= 1 && sleeping) { // 規格補充 2 第 2 條：受到傷害就醒（第一下已經 × SLEEP_MULT）
        delete target.status.sleep;
        log.push({ type: 'wake', uid: target.uid });
      }
      if (target.side === 'enemy') checkPhases(draft, target, data, log);
      return;
    }
    case 'heal': {
      const want = Object.hasOwn(effect, 'pct') ? Math.round((target.stats.hp * effect.pct) / 100) : effect.amount;
      const before = target.hp;
      target.hp = Math.min(target.stats.hp, target.hp + want);
      log.push({ type: 'heal', source: source.uid, target: target.uid, amount: target.hp - before, hp: target.hp });
      return;
    }
    case 'sp': {
      const before = target.sp;
      target.sp = Math.min(target.stats.sp, Math.max(0, target.sp + effect.amount));
      log.push({ type: 'sp', source: source.uid, target: target.uid, amount: target.sp - before, sp: target.sp });
      return;
    }
    case 'buff':
    case 'debuff': {
      const mod = Object.hasOwn(effect, 'pct') ? { pct: effect.pct } : { amount: effect.amount };
      target.mods[`${effect.type}:${effect.stat}`] = { ...mod, turns: effect.turns };
      log.push({ type: effect.type, source: source.uid, target: target.uid, stat: effect.stat, ...mod, turns: effect.turns });
      return;
    }
    case 'status': {
      const p = statusChance(effect.chance ?? 100, source, target);
      let ok = true;
      if (p < 100) [ok, draft.rng] = chance(draft.rng, p);
      if (!ok) {
        log.push({ type: 'status_resisted', source: source.uid, target: target.uid, status: effect.status });
        return;
      }
      target.status[effect.status] = effect.turns;
      log.push({ type: 'status', source: source.uid, target: target.uid, status: effect.status, turns: effect.turns });
      return;
    }
    case 'reveal_intent': {
      if (target.side !== 'enemy' || !target.intent) return;
      target.revealed = true;
      // 畫面當下就要顯示「誰要對誰用什麼」，所以名稱一併帶上，不必之後再查。
      const it = target.intent.target ? unitOf(draft, target.intent.target) : null;
      const sk = Array.isArray(data?.skills) ? data.skills.find((x) => isObj(x) && x.id === target.intent.skill) : undefined;
      log.push({
        type: 'intent_revealed', source: source.uid, target: target.uid, target_name: target.name,
        skill: target.intent.skill, skill_name: sk?.name ?? target.intent.skill,
        intent_target: target.intent.target ?? null, intent_target_name: it ? it.name : null,
      });
      return;
    }
    case 'collapse': {
      let amount = collapseAmount(effect.amount, heroWill(draft));
      const foreseen = opts.foreseen === true && amount > 0;
      if (foreseen) amount = foresee(amount);
      draft.collapse = Math.min(COLLAPSE_MAX, Math.max(0, draft.collapse + amount));
      log.push({ type: 'collapse', source: source.uid, amount, total: draft.collapse, ...(foreseen ? { foreseen: true } : {}) });
      if (draft.collapse >= COLLAPSE_MAX) {
        draft.outcome = 'lost_control';
        draft.actor = null;
        log.push({ type: 'lost_control' });
      }
      return;
    }
    case 'summon': {
      const alive = draft.units.filter((u) => u.alive && u.side === 'enemy' && u.id === effect.enemy).length;
      if (alive >= effect.max) {
        log.push({ type: 'summon_failed', source: source.uid, enemy: effect.enemy });
        return;
      }
      const u = makeEnemyUnit(enemyDef(data, effect.enemy), `e${draft.nextUid}`);
      draft.nextUid += 1;
      draft.units.push(u);
      decideIntentMut(draft, u, data);
      log.push({ type: 'summon', source: source.uid, uid: u.uid, enemy: effect.enemy });
      return;
    }
    default:
      throw new Error(`未知的效果積木 type「${effect.type}」`);
  }
}

/** 純函式版：回傳 { battle（新）, log }。 */
export function applyBattleEffect(battle, effect, sourceUid, targetUid, data) {
  const draft = structuredClone(battle);
  const log = [];
  applyEffectMut(draft, effect, sourceUid, targetUid, data, log);
  return { battle: draft, log };
}
