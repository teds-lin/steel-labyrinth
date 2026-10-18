// 戰鬥狀態機：開始、列出指令、執行、敵人回合、勝敗判定、結算回寫（DATA-FORMAT「戰鬥與隊伍」）。
// 戰鬥狀態是純資料、不可變：每個公開函式都回傳新的 battle，不修改輸入。
// 亂數全部來自 battle.rng（種子化），所以同 seed＋同指令序列 → 完全相同的 log。
//
// 畫面的典型流程：
//   b = startBattle(enc, state, data, seed)        // b.opening：開場事件
//   while (b.outcome === null):
//     isPlayerTurn(b) ? 玩家從 commands(b, data) 選 → act(b, cmd, data)
//                     : advanceEnemy(b, data)       // 一次一個敵人行動，畫面逐一播放 log
//   finishBattle(b, state, data) → { state, outcome, rewards, next }
import { createRng, chance, nextInt } from '../rng.js';
import { applyEffects as applyGameEffects } from '../effects.js';
import { CT_THRESHOLD, nextActor, previewOrder } from './turnorder.js';
import { applyEffectMut, hitChance, ONCE_PER_ACTION } from './effects.js';
import { decideIntentMut, targetsFor, chooseTarget } from './ai.js';
import { makePartyUnit, makeEnemyUnit } from './units.js';
import { findIn, skillDef, enemyDef, unitOf, hasStatus, hpRatio } from './stat.js';
import { deriveStats } from '../stats.js';

export const BATTLE_VERSION = 1;
export const FLEE_CHANCE = 50;
/** 勝利（或逃跑、教學戰 continue）後，倒下的隊友以這個生命值歸隊。 */
export const REVIVE_HP = 1;
const MAX_SKIPS = 10000;
const MAX_SIM_STEPS = 5000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SINGLE = ['enemy', 'ally'];
const costOf = (skill) => ({
  sp: isObj(skill.cost) && Number.isInteger(skill.cost.sp) ? skill.cost.sp : 0,
  ammo: isObj(skill.cost) && Number.isInteger(skill.cost.ammo) ? skill.cost.ammo : 0,
});

function encounterDef(data, id) {
  const e = findIn(data?.encounters, id);
  if (!e) throw new Error(`找不到遭遇「${id}」`);
  return e;
}

// ---------- 回合推進 ----------

/** 回合開始：狀態與增益減益的回合數 −1，歸 0 的移除（送出 expire）。 */
function tickDurations(u, log) {
  for (const key of Object.keys(u.status)) {
    u.status[key] -= 1;
    if (u.status[key] <= 0) { delete u.status[key]; log.push({ type: 'expire', uid: u.uid, kind: 'status', key }); }
  }
  for (const key of Object.keys(u.mods)) {
    u.mods[key].turns -= 1;
    if (u.mods[key].turns <= 0) {
      const [kind, stat] = key.split(':');
      delete u.mods[key];
      log.push({ type: 'expire', uid: u.uid, kind, key: stat });
    }
  }
}

/** 勝敗判定（失控由崩解效果當場判定）。回傳是否已結束。 */
function checkEnd(draft, log) {
  if (draft.outcome !== null) { draft.actor = null; return true; }
  const partyAlive = draft.units.some((u) => u.side === 'party' && u.alive);
  const enemyAlive = draft.units.some((u) => u.side === 'enemy' && u.alive);
  if (partyAlive && enemyAlive) return false;
  draft.outcome = partyAlive ? 'victory' : 'defeat';
  draft.actor = null;
  log.push({ type: draft.outcome });
  return true;
}

/** 推進到下一位「醒著」的行動者；睡眠中的人輪到時跳過（sleep_skip）並減少回合。 */
function proceed(draft, log) {
  draft.actor = null;
  for (let i = 0; i < MAX_SKIPS; i++) {
    if (checkEnd(draft, log)) return;
    const r = nextActor(draft.units);
    draft.units = r.units;
    const u = unitOf(draft, r.uid);
    const asleep = hasStatus(u, 'sleep');
    const bound = hasStatus(u, 'bind'); // 影縛：跳過行動（受傷不解除，回合數照樣減少）
    tickDurations(u, log);
    if (asleep || bound) {
      log.push({ type: asleep ? 'sleep_skip' : 'bind_skip', uid: u.uid });
      u.ct -= CT_THRESHOLD;
      continue;
    }
    draft.actor = u.uid;
    log.push({ type: 'turn_start', uid: u.uid });
    return;
  }
  throw new Error('戰鬥推進失敗：連續跳過太多回合');
}

/** 行動結束：ct −100、行動次數 +1；敵人立刻決定下一次意圖；推進到下一位。 */
function endAction(draft, actor, data, log) {
  draft.seq += 1;
  if (checkEnd(draft, log)) return;
  actor.ct -= CT_THRESHOLD;
  actor.acted += 1;
  if (actor.side === 'enemy' && actor.alive) decideIntentMut(draft, actor, data);
  proceed(draft, log);
}

// ---------- 執行技能 ----------

function performMut(draft, actor, skill, targetUid, data, log, extra = {}, opts = {}) {
  const targets = targetsFor(draft, actor, skill.target, targetUid);
  log.push({ type: 'action', uid: actor.uid, skill: skill.id, ...extra, target: SINGLE.includes(skill.target) ? (targetUid ?? null) : null, targets: targets.map((t) => t.uid) });
  if (extra.item) {
    draft.items[extra.item] -= 1;
    if (draft.items[extra.item] <= 0) delete draft.items[extra.item];
    log.push({ type: 'item_used', uid: actor.uid, item: extra.item });
  } else {
    const cost = costOf(skill);
    if (cost.sp > 0 || cost.ammo > 0) {
      actor.sp = Math.max(0, actor.sp - cost.sp);
      if (actor.side === 'party') draft.ammo = Math.max(0, draft.ammo - cost.ammo); // 敵人不用子彈
      log.push({ type: 'cost', uid: actor.uid, sp: cost.sp, ammo: actor.side === 'party' ? cost.ammo : 0 });
    }
  }
  // 命中：先依序對每個目標擲骰（攻擊方是敵人、目標是我方時才會閃避）；閃過的目標不受這次行動的逐目標效果。
  const missed = new Set();
  for (const t of targets) {
    const p = hitChance(actor, t);
    if (p >= 100) continue;
    let hit;
    [hit, draft.rng] = chance(draft.rng, p);
    if (!hit) { missed.add(t.uid); log.push({ type: 'miss', source: actor.uid, target: t.uid }); }
  }
  // 規格補充 2 第 4 條：所有目標都閃避時，這次行動的 collapse 不生效。
  const allMissed = targets.length > 0 && targets.every((t) => missed.has(t.uid));
  for (const e of Array.isArray(skill.effects) ? skill.effects : []) {
    if (draft.outcome !== null) break;
    if (e.on === 'self') applyEffectMut(draft, e, actor.uid, actor.uid, data, log, opts);
    else if (ONCE_PER_ACTION.includes(e.type)) {
      if (!(e.type === 'collapse' && allMissed)) applyEffectMut(draft, e, actor.uid, null, data, log, opts);
    } else for (const t of targets) if (!missed.has(t.uid)) applyEffectMut(draft, e, actor.uid, t.uid, data, log, opts);
  }
}

// ---------- 公開 API ----------

/** startBattle 的重試選項 → { preCollapse } 或 null。不合法時丟錯（不默默當成一般戰，以免重試戰又能逃）。 */
function retryInfo(opts) {
  if (!isObj(opts) || opts.retry !== true) return null;
  const c = opts.preCollapse;
  if (!Number.isInteger(c) || c < 0 || c > 100) throw new Error(`重新挑戰需要戰前崩解 preCollapse（0～100 的整數），收到 ${JSON.stringify(c)}`);
  return { preCollapse: c };
}

/**
 * 開始戰鬥。state 的 party（hp/sp 的 null＝滿值）、collapse、ammo、items 帶進戰鬥；所有敵人立刻決定意圖。
 * 回傳 battle（純資料）；battle.opening 是開場到第一位行動者為止的事件。
 * opts.retry：這是「重新挑戰」的那場戰鬥（規格補充 3 第 1 條）。必須同時給 opts.preCollapse＝戰前（prepareRetry 之前）
 *   的崩解；這場戰鬥一律不能逃跑（battle.canFlee false），finishBattle 寫回的崩解＝max(戰後, preCollapse)。
 *   battle.retry＝{ preCollapse }；不是重試戰時為 null。
 */
export function startBattle(encId, state, data, seed, opts = {}) {
  const retry = retryInfo(opts);
  const enc = encounterDef(data, encId);
  const party = Array.isArray(state?.party) ? state.party : [];
  if (party.length === 0) throw new Error('隊伍是空的，無法開始戰鬥');
  const units = party.map((m, i) => makePartyUnit(m, i, state, data));
  const enemies = (Array.isArray(enc.enemies) ? enc.enemies : []).map((id, i) => makeEnemyUnit(enemyDef(data, id), `e${i}`));
  if (enemies.length === 0) throw new Error(`遭遇「${encId}」沒有任何敵人`);
  const items = {};
  for (const [k, v] of Object.entries(isObj(state.items) ? state.items : {})) if (Number.isInteger(v) && v > 0) items[k] = v;
  const draft = {
    version: BATTLE_VERSION, encounter: enc.id, seed, rng: createRng(seed), seq: 0,
    units: [...units, ...enemies], actor: null,
    collapse: Number.isInteger(state.collapse) ? state.collapse : 0,
    ammo: Number.isInteger(state.ammo) ? state.ammo : 0,
    items, drops: [], outcome: null, nextUid: enemies.length, canFlee: enc.can_flee === true && retry === null, retry, opening: [],
  };
  for (const e of draft.units.filter((u) => u.side === 'enemy')) decideIntentMut(draft, e, data);
  const log = [];
  if (draft.collapse >= 100) {
    draft.outcome = 'lost_control';
    log.push({ type: 'lost_control' });
  }
  proceed(draft, log);
  draft.opening = log;
  return draft;
}

/** 目前行動者 { uid, side, id, name }；戰鬥結束時 null。 */
export function currentActor(battle) {
  if (battle.outcome !== null || !battle.actor) return null;
  const u = unitOf(battle, battle.actor);
  return u ? { uid: u.uid, side: u.side, id: u.id, name: u.name } : null;
}

export const isPlayerTurn = (battle) => currentActor(battle)?.side === 'party';

function validTargets(battle, actor, targetType) {
  if (targetType === 'self') return [actor.uid];
  return targetsFor(battle, actor, targetType === 'enemy' ? 'enemy_all' : targetType === 'ally' ? 'ally_all' : targetType, null).map((u) => u.uid);
}

/**
 * 目前行動者（我方）可用的指令；不是我方回合時回 null。
 * { actor, skills:[{ id, name, desc, target, cost:{sp,ammo}, usable, reason:null|'sp'|'ammo'|'no_target', targets }],
 *   items:[{ id, name, count, target, targets }], canFlee }
 */
export function commands(battle, data) {
  if (!isPlayerTurn(battle)) return null;
  const actor = unitOf(battle, battle.actor);
  const skills = actor.skills.map((id) => {
    const s = skillDef(data, id);
    const cost = costOf(s);
    const targets = validTargets(battle, actor, s.target);
    let reason = null;
    if (cost.sp > actor.sp) reason = 'sp';
    else if (cost.ammo > battle.ammo) reason = 'ammo';
    else if (targets.length === 0) reason = 'no_target';
    return { id: s.id, name: s.name ?? s.id, desc: s.desc ?? '', target: s.target, cost, usable: reason === null, reason, targets };
  });
  const items = [];
  for (const [id, count] of Object.entries(battle.items)) {
    const def = battleItemDef(data, id);
    if (!def || count <= 0) continue;
    items.push({ id, name: def.name ?? id, count, target: def.target, targets: validTargets(battle, actor, def.target) });
  }
  return { actor: actor.uid, skills, items, canFlee: battle.canFlee };
}

/** 戰鬥中可以使用的道具（items.json 有 target＋battle_effects）；不是的回 null。 */
function battleItemDef(data, id) {
  const def = findIn(data?.items, id);
  return def && typeof def.target === 'string' && Array.isArray(def.battle_effects) ? def : null;
}
/** 把道具當成一個沒有消耗的技能來執行。 */
const itemAsSkill = (def) => ({ id: null, target: def.target, effects: def.battle_effects });

function checkTarget(battle, actor, skill, target) {
  if (!SINGLE.includes(skill.target)) return null;
  const valid = validTargets(battle, actor, skill.target);
  if (!valid.includes(target)) throw new Error(`「${skill.id ?? '道具'}」的目標「${String(target)}」不合法（可選：${valid.join('、')}）`);
  return target;
}

/** 混亂中：單體技能的目標改成隨機（任一陣營、不含自己）。 */
function confuseTarget(draft, actor, skill, target, log) {
  if (!SINGLE.includes(skill.target) || !hasStatus(actor, 'confuse')) return target;
  const others = draft.units.filter((u) => u.alive && u.uid !== actor.uid);
  if (!others.length) return target;
  let i;
  [i, draft.rng] = nextInt(draft.rng, 0, others.length - 1);
  log.push({ type: 'confused', uid: actor.uid, target: others[i].uid });
  return others[i].uid;
}

/**
 * 我方行動。command：
 *   { type:'skill', skill, target? }   單體技能（enemy／ally）必須給 target（uid）
 *   { type:'item', item, target? }     道具的 target＋battle_effects（items.json）；消耗 1 個（action 事件的 skill 為 null）
 *   { type:'flee' }                    can_flee 的遭遇才可以；成功率 50%，失敗會用掉這個回合
 * 回傳 { battle, log }；執行後推進到下一位行動者（敵人回合請呼叫 advanceEnemy）。指令不合法時丟錯。
 */
export function act(battle, command, data) {
  if (!isPlayerTurn(battle)) throw new Error('現在不是我方的回合');
  if (!isObj(command)) throw new Error('指令必須是物件');
  const draft = structuredClone(battle);
  const actor = unitOf(draft, draft.actor);
  const log = [];
  switch (command.type) {
    case 'skill': {
      if (!actor.skills.includes(command.skill)) throw new Error(`「${actor.name}」不會技能「${String(command.skill)}」`);
      const skill = skillDef(data, command.skill);
      const cost = costOf(skill);
      if (cost.sp > actor.sp) throw new Error(`靈性不足，無法使用「${skill.id}」`);
      if (cost.ammo > draft.ammo) throw new Error(`子彈不足，無法使用「${skill.id}」`);
      const target = confuseTarget(draft, actor, skill, checkTarget(draft, actor, skill, command.target), log);
      performMut(draft, actor, skill, target, data, log);
      break;
    }
    case 'item': {
      const id = command.item;
      if (typeof id !== 'string' || !Object.hasOwn(draft.items, id) || draft.items[id] <= 0) throw new Error(`沒有道具「${String(id)}」`);
      const def = battleItemDef(data, id);
      if (!def) throw new Error(`道具「${id}」不能在戰鬥中使用`);
      const skill = itemAsSkill(def);
      const target = confuseTarget(draft, actor, skill, checkTarget(draft, actor, skill, command.target), log);
      performMut(draft, actor, skill, target, data, log, { item: id });
      break;
    }
    case 'flee': {
      if (!draft.canFlee) throw new Error('這場戰鬥不能逃跑');
      let ok;
      [ok, draft.rng] = chance(draft.rng, FLEE_CHANCE);
      if (ok) {
        draft.outcome = 'fled';
        draft.actor = null;
        draft.seq += 1;
        log.push({ type: 'fled' });
        return { battle: draft, log };
      }
      log.push({ type: 'flee_failed', uid: actor.uid });
      break;
    }
    default:
      throw new Error(`未知的指令「${String(command.type)}」`);
  }
  endAction(draft, actor, data, log);
  return { battle: draft, log };
}

/** 意圖的目標已倒下 → 改打同一陣營中排在它後面的下一位存活者（依隊伍順序，繞回開頭）。 */
function retarget(draft, actor, skill, target, log) {
  if (!SINGLE.includes(skill.target)) return null;
  const orig = target ? unitOf(draft, target) : null;
  if (orig && orig.alive) return target;
  const side = orig ? orig.side : (skill.target === 'enemy' ? (actor.side === 'party' ? 'enemy' : 'party') : actor.side);
  const list = draft.units.filter((u) => u.side === side);
  const start = orig ? list.findIndex((u) => u.uid === orig.uid) : -1;
  for (let k = 1; k <= list.length; k++) {
    const u = list[(start + k + list.length) % list.length];
    if (u.alive) {
      log.push({ type: 'retarget', uid: actor.uid, from: target ?? null, to: u.uid });
      return u.uid;
    }
  }
  return null;
}

/** 敵人行動：執行事先決定的意圖（預兆顯示的內容必定成真），然後立刻決定下一次意圖。回傳 { battle, log }。 */
export function advanceEnemy(battle, data) {
  const cur = currentActor(battle);
  if (!cur || cur.side !== 'enemy') throw new Error('現在不是敵人的回合');
  const draft = structuredClone(battle);
  const actor = unitOf(draft, draft.actor);
  if (!actor.intent) decideIntentMut(draft, actor, data); // 保險：理論上一定已有意圖
  const skill = skillDef(data, actor.intent.skill);
  const log = [];
  const target = retarget(draft, actor, skill, actor.intent.target, log);
  // 規格補充 2 第 3 條：被預兆揭露的意圖，執行時對我方的傷害與崩解減半。
  performMut(draft, actor, skill, target, data, log, {}, { foreseen: actor.revealed === true });
  endAction(draft, actor, data, log);
  return { battle: draft, log };
}

/**
 * 被預兆揭露過的敵人意圖：{ skill, target[, skill_name] }（給 data 時附技能名稱）；沒揭露或已行動回 null。
 */
export function intentOf(battle, enemyUid, data) {
  const u = unitOf(battle, enemyUid);
  if (!u || u.side !== 'enemy' || !u.alive || !u.revealed || !u.intent) return null;
  const out = { skill: u.intent.skill, target: u.intent.target };
  if (data) out.skill_name = findIn(data.skills, u.intent.skill)?.name ?? u.intent.skill;
  return out;
}

/** 行動順序預覽（畫面上方顯示接下來 n 位）：uid 陣列，第一位是目前行動者。不改變狀態。 */
export function turnOrder(battle, n = 6) {
  if (battle.outcome !== null) return [];
  return previewOrder(battle, n);
}

/** 重新挑戰時崩解的上限（規格補充 2 第 1 條）。 */
export const RETRY_COLLAPSE_CAP = 60;

/**
 * 規格補充 2 第 1 條：「重新挑戰」的開戰狀態＝戰前狀態，但全隊生命、靈性回滿（寫成 deriveStats 的上限數值），
 * 崩解改為 min(戰前崩解, 60)。其他（子彈、道具、旗標）照戰前。pending 清成 null。純函式，不修改輸入。
 * 用法：GameOver「重新挑戰」→ startBattle(enc, prepareRetry(pre, data), data, 新種子, retryOptions(pre))。
 */
export function prepareRetry(preState, data) {
  if (!isObj(preState)) throw new Error('prepareRetry：戰前狀態必須是物件');
  const party = (Array.isArray(preState.party) ? preState.party : []).map((m) => {
    const max = deriveStats(m.id, preState, data);
    return { ...m, hp: max.hp, sp: max.sp };
  });
  const c = Number.isInteger(preState.collapse) ? preState.collapse : 0;
  return { ...structuredClone(preState), party, collapse: Math.min(c, RETRY_COLLAPSE_CAP), pending: null };
}

/** 重新挑戰時傳給 startBattle 的第 5 個參數：{ retry: true, preCollapse: 戰前崩解 }（規格補充 3 第 1 條）。 */
export function retryOptions(preState) {
  const c = Number.isInteger(preState?.collapse) ? preState.collapse : 0;
  return { retry: true, preCollapse: Math.min(100, Math.max(0, c)) };
}

function writeBack(battle, state, revive) {
  const party = state.party.map((m) => {
    const u = battle.units.find((x) => x.side === 'party' && x.id === m.id);
    if (!u) return { ...m };
    return { id: m.id, hp: revive && u.hp <= 0 ? REVIVE_HP : u.hp, sp: u.sp };
  });
  // 規格補充 3 第 1 條：重試戰的崩解不得低於戰前（重新挑戰時的 min(戰前, 60) 只是讓這場打得下去，不是回復手段）
  const floor = isObj(battle.retry) && Number.isInteger(battle.retry.preCollapse) ? battle.retry.preCollapse : 0;
  return { ...state, party, ammo: battle.ammo, collapse: Math.max(battle.collapse, floor), items: { ...battle.items } };
}

/**
 * 戰鬥結算，回傳 { state, outcome, rewards:{ items:[{item,count}] }, next }。不修改輸入。
 * - victory：回寫 hp/sp/子彈/崩解/道具（倒下的隊友以 1 點生命歸隊）、發放掉落、套用 on_win.effects；
 *   next＝on_win.dialogue ? { type:'dialogue', dialogue } : null。
 * - fled：回寫狀態，沒有獎勵與劇情；next null。
 * - defeat：on_lose 'continue' → 與勝利相同的劇情（不發掉落）；否則（預設 'retry'）state 不變、next { type:'retry' }。
 * - lost_control：一律 state 不變、next { type:'retry' }（畫面顯示失控／Game Over，提供重新挑戰或回標題）。
 * - 重試戰（startBattle 的 opts.retry）：回寫的崩解＝max(戰後, battle.retry.preCollapse)；生命、靈性照戰後的值。
 */
export function finishBattle(battle, state, data) {
  if (battle.outcome === null) throw new Error('戰鬥尚未結束');
  const enc = encounterDef(data, battle.encounter);
  const onWin = isObj(enc.on_win) ? enc.on_win : {};
  const story = (s) => ({
    state: applyGameEffects(onWin.effects, s, data),
    next: typeof onWin.dialogue === 'string' ? { type: 'dialogue', dialogue: onWin.dialogue } : null,
  });
  const none = { items: [] };
  switch (battle.outcome) {
    case 'victory': {
      let s = writeBack(battle, state, true);
      const items = { ...s.items };
      for (const d of battle.drops) items[d.item] = (Number.isInteger(items[d.item]) ? items[d.item] : 0) + d.count;
      s = { ...s, items };
      const r = story(s);
      return { state: r.state, outcome: 'victory', rewards: { items: battle.drops.map((d) => ({ ...d })) }, next: r.next };
    }
    case 'fled':
      return { state: writeBack(battle, state, true), outcome: 'fled', rewards: none, next: null };
    case 'defeat':
      if (enc.on_lose === 'continue') {
        const r = story(writeBack(battle, state, true));
        return { state: r.state, outcome: 'defeat', rewards: none, next: r.next };
      }
      return { state, outcome: 'defeat', rewards: none, next: { type: 'retry' } };
    case 'lost_control':
      return { state, outcome: 'lost_control', rewards: none, next: { type: 'retry' } };
    default:
      throw new Error(`未知的戰鬥結果「${battle.outcome}」`);
  }
}

// ---------- 模擬（平衡測試、重播用） ----------

/**
 * 簡單合理策略：有人生命低於 35% 且有可用的回復道具 → 用在他身上；
 * 否則用「攻擊」打生命比例最低的敵人（不會攻擊時用第一個可用的技能）。
 */
export function basicPolicy(battle, cmds) {
  const actor = unitOf(battle, cmds.actor);
  const hurt = battle.units.filter((u) => u.side === 'party' && u.alive && hpRatio(u) < 0.35);
  const heal = cmds.items.find((i) => i.target === 'ally' && i.targets.length);
  if (hurt.length && heal) {
    const t = hurt.reduce((a, b) => (hpRatio(b) < hpRatio(a) ? b : a));
    if (heal.targets.includes(t.uid)) return { type: 'item', item: heal.id, target: t.uid };
  }
  const attack = cmds.skills.find((s) => s.id === 'attack' && s.usable) ?? cmds.skills.find((s) => s.usable);
  if (!attack) return cmds.canFlee ? { type: 'flee' } : { type: 'skill', skill: cmds.skills[0].id };
  const target = attack.target === 'enemy' || attack.target === 'ally' ? chooseTarget(battle, actor, attack.target) : undefined;
  return { type: 'skill', skill: attack.id, target };
}

/**
 * 純函式：用 policy(battle, commands, data) → command 打完整場戰鬥。
 * 回傳 { outcome, battle（最終狀態）, log（含開場的全部事件）, steps }。
 */
export function simulate(encId, state, data, seed, policy = basicPolicy) {
  let b = startBattle(encId, state, data, seed);
  const log = [...b.opening];
  let steps = 0;
  while (b.outcome === null) {
    if (++steps > MAX_SIM_STEPS) throw new Error(`模擬超過 ${MAX_SIM_STEPS} 步仍未結束`);
    const r = isPlayerTurn(b) ? act(b, policy(b, commands(b, data), data), data) : advanceEnemy(b, data);
    b = r.battle;
    log.push(...r.log);
  }
  return { outcome: b.outcome, battle: b, log, steps };
}
