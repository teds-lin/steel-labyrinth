// 平衡測試與內容測試共用的戰鬥策略。policy(battle, cmds, data) → command（engine.simulate 的介面）。
// 策略只讀戰鬥狀態與 commands() 給的合法指令，不碰 battle.rng（不影響戰鬥亂數序列）。
import { basicPolicy } from '../../web/src/core/battle/engine.js';
import { chooseTarget } from '../../web/src/core/battle/ai.js';
import { unitOf, hpRatio, hasStatus, findIn } from '../../web/src/core/battle/stat.js';

export { basicPolicy };

/** Boss 戰＝不能逃、輸了要重來的遭遇（教學戰 on_lose: continue 不算）。 */
export const isBossEncounter = (data, encId) => {
  const enc = findIn(data.encounters, encId);
  return !!enc && enc.can_flee !== true && enc.on_lose !== 'continue';
};

/** 重擊＝威力 ≥ 130% 的傷害技能（預兆看到它要打自己時，改成防禦）。 */
const isHeavy = (data, skillId) => {
  const s = findIn(data.skills, skillId);
  return !!s && (s.effects ?? []).some((e) => e.type === 'damage' && (e.power ?? 0) >= 130);
};

export const SMART = Object.freeze({
  /** 崩解達到這個值：艾妲用鎮魂（不必等到更高，她的靈性夠）。 */
  requiemAt: 40,
  /** 崩解達到這個值：用鎮靜香。 */
  incenseAt: 55,
  /** 有人生命低於這個比例：用繃帶。 */
  bandageBelow: 0.4,
  /** 艾妲在 Boss 戰保留給鎮魂的靈性。 */
  adaReserveSp: 12,
});

/**
 * 「簡單合理策略」：
 * 1. 崩解高 → 艾妲的鎮魂（崩解 ≥ 40）或鎮靜香（≥ 55，useItems 時）。
 * 2. 有人生命 < 40% 且有繃帶 → 繃帶（useItems 時）。
 * 3. 預兆已揭露「重擊打我」→ 防禦（useOmen 時）。
 * 4. Boss 戰：主角先預兆（Boss 醒著、意圖還沒揭露、迴避增益沒在身上、靈性夠時；useOmen 時），有子彈就開槍；
 *    艾妲對沒睡著的 Boss 催眠（保留鎮魂的靈性）。一般戰不開槍（子彈留給 Boss）、不放催眠。
 * 5. 其他：攻擊生命比例最低的敵人。
 */
export function makeSmartPolicy({ useItems = true, useOmen = true } = {}) {
  return function smartPolicy(battle, cmds, data) {
    const actor = unitOf(battle, cmds.actor);
    const skill = (id) => cmds.skills.find((s) => s.id === id && s.usable);
    const item = (id) => (useItems ? cmds.items.find((i) => i.id === id && i.count > 0) : undefined);
    const boss = isBossEncounter(data, battle.encounter);
    const enemies = battle.units.filter((u) => u.side === 'enemy' && u.alive);
    const party = battle.units.filter((u) => u.side === 'party' && u.alive);
    const hero = battle.units.find((u) => u.side === 'party' && u.id === 'hero');
    const bossUnit = enemies.reduce((a, b) => (a === null || b.stats.hp > a.stats.hp ? b : a), null);

    // 1. 崩解
    const requiem = skill('requiem');
    if (requiem && battle.collapse >= SMART.requiemAt) return { type: 'skill', skill: 'requiem', target: hero?.alive ? hero.uid : actor.uid };
    const incense = item('sedative_incense');
    if (incense && battle.collapse >= SMART.incenseAt) return { type: 'item', item: incense.id, target: incense.target === 'ally' ? actor.uid : undefined };

    // 2. 生命
    const bandage = item('bandage');
    const hurt = party.filter((u) => hpRatio(u) < SMART.bandageBelow);
    if (bandage && hurt.length) {
      const t = hurt.reduce((a, b) => (hpRatio(b) < hpRatio(a) ? b : a));
      return { type: 'item', item: bandage.id, target: t.uid };
    }

    // 3. 預兆看到重擊要打自己 → 防禦
    if (useOmen && !hasStatus(actor, 'guard')) {
      const incoming = enemies.some((e) => e.revealed && e.intent && e.intent.target === actor.uid && isHeavy(data, e.intent.skill));
      if (incoming && skill('guard')) return { type: 'skill', skill: 'guard' };
    }

    if (boss && bossUnit) {
      // 4. Boss 戰
      if (useOmen && skill('omen') && !actor.mods['buff:eva'] && !bossUnit.revealed && !hasStatus(bossUnit, 'sleep')) return { type: 'skill', skill: 'omen', target: bossUnit.uid };
      if (skill('shoot')) return { type: 'skill', skill: 'shoot', target: bossUnit.uid };
      if (skill('hypnosis') && !hasStatus(bossUnit, 'sleep') && actor.sp - 6 >= SMART.adaReserveSp) {
        return { type: 'skill', skill: 'hypnosis', target: bossUnit.uid };
      }
    }

    // 5. 攻擊
    return { type: 'skill', skill: 'attack', target: chooseTarget(battle, actor, 'enemy') };
  };
}

export const smartPolicy = makeSmartPolicy();
export const noItemNoOmenPolicy = makeSmartPolicy({ useItems: false, useOmen: false });

/** 亂按：只用普攻，目標用 (種子, 行動序號) 雜湊決定（不碰戰鬥亂數）。 */
export function mashPolicy(battle, cmds) {
  const actor = unitOf(battle, cmds.actor);
  const targets = cmds.skills.find((s) => s.id === 'attack')?.targets ?? [];
  if (!targets.length) return { type: 'skill', skill: 'guard' };
  const h = Math.imul((battle.seed >>> 0) ^ 0x9e3779b9, 31) + Math.imul(battle.seq + 1, 0x85ebca6b) + actor.uid.length;
  return { type: 'skill', skill: 'attack', target: targets[(h >>> 0) % targets.length] };
}
