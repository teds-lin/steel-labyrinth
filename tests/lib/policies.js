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
 * M5（useLineage，預設開）：Boss 戰時老賀伯【查閱】、馬洛在隊友生命低於一半時【嘲諷】、換影者【影縛】Boss。
 * 禁聲中消耗靈性的技能不能用（commands 給 usable false），會自動落到普攻。
 */
export function makeSmartPolicy({ useItems = true, useOmen = true, useHypnosis = true, useLineage = true, focusAdds = false, reserveSp = SMART.adaReserveSp } = {}) {
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

    // M5：第四章起的隊友與主角新技能（useLineage）。都只在 Boss 戰用，一般戰照舊普攻。
    if (useLineage && boss && bossUnit) {
      // 老賀伯：【查閱】看穿 Boss 的下一步並降低防禦（還沒揭露、沒有減防時）
      if (actor.id === 'herb' && skill('consult') && !bossUnit.revealed && !bossUnit.mods['debuff:def'] && !hasStatus(bossUnit, 'sleep')) {
        return { type: 'skill', skill: 'consult', target: bossUnit.uid };
      }
      // 馬洛：有隊友生命低於一半時【嘲諷】把攻擊拉到自己身上
      if (actor.id === 'marlo' && skill('taunt') && !hasStatus(actor, 'taunt') && party.some((u) => u !== actor && hpRatio(u) < 0.5)) {
        return { type: 'skill', skill: 'taunt' };
      }
    }

    if (boss && bossUnit) {
      // 4. Boss 戰
      if (useOmen && skill('omen') && !actor.mods['buff:eva'] && !bossUnit.revealed && !hasStatus(bossUnit, 'sleep')) return { type: 'skill', skill: 'omen', target: bossUnit.uid };
      // focusAdds（M5）：Boss 睡著或被影縛時，先清掉小怪（不打醒 Boss）
      const adds = enemies.filter((u) => u !== bossUnit);
      if (focusAdds && adds.length && (hasStatus(bossUnit, 'sleep') || hasStatus(bossUnit, 'bind'))) {
        const t = adds.reduce((a, b) => (hpRatio(b) < hpRatio(a) ? b : a));
        return { type: 'skill', skill: 'attack', target: t.uid };
      }
      if (skill('shoot')) return { type: 'skill', skill: 'shoot', target: bossUnit.uid };
      // 換影者：【影縛】定住 Boss（還沒被縛住、靈性留著下一次預兆時）
      if (useLineage && skill('shadow_bind') && !hasStatus(bossUnit, 'bind') && !hasStatus(bossUnit, 'sleep') && actor.sp - 7 >= 4) {
        return { type: 'skill', skill: 'shadow_bind', target: bossUnit.uid };
      }
      // focusAdds（M5）：只在有小怪時催眠 Boss（趁 Boss 睡著清小怪）；單獨的 Boss 不催眠（打一下就醒，不划算）
      const hypnosisWorth = !focusAdds || enemies.length > 1;
      if (useHypnosis && hypnosisWorth && skill('hypnosis') && !hasStatus(bossUnit, 'sleep') && actor.sp - 6 >= reserveSp) {
        return { type: 'skill', skill: 'hypnosis', target: bossUnit.uid };
      }
    }

    // 5. 攻擊
    return { type: 'skill', skill: 'attack', target: chooseTarget(battle, actor, 'enemy') };
  };
}

export const smartPolicy = makeSmartPolicy();
export const noItemNoOmenPolicy = makeSmartPolicy({ useItems: false, useOmen: false });
/** 合理策略但完全不催眠（規格補充 3 第 2 條：催眠要有正收益，合理策略不得輸給它）。 */
export const smartNoHypnosisPolicy = makeSmartPolicy({ useHypnosis: false });

/**
 * 聰明催眠（審查者 hyp2.mjs 的 hypSmart）：以不催眠的合理策略為底；場上有小怪、Boss 醒著時艾妲催眠 Boss，
 * Boss 睡著時本來要打 Boss 的單體攻擊改打小怪。用來確認「最強的我方策略」也不超過 Boss 勝率上限。
 */
export function hypnosisSmartPolicy(battle, cmds, data) {
  const enemies = battle.units.filter((u) => u.side === 'enemy' && u.alive);
  const boss = enemies.reduce((a, b) => (a === null || b.stats.hp > a.stats.hp ? b : a), null);
  const adds = enemies.filter((u) => u !== boss);
  const r = smartNoHypnosisPolicy(battle, cmds, data);
  if (r.type === 'item' || r.skill === 'requiem' || r.skill === 'guard') return r;
  if (adds.length && boss && !hasStatus(boss, 'sleep') && cmds.skills.some((s) => s.id === 'hypnosis' && s.usable)) {
    return { type: 'skill', skill: 'hypnosis', target: boss.uid };
  }
  if (boss && hasStatus(boss, 'sleep') && adds.length && r.target === boss.uid) {
    return { type: 'skill', skill: r.skill === 'omen' ? 'attack' : r.skill, target: adds[0].uid };
  }
  return r;
}

/** 亂按：只用普攻，目標用 (種子, 行動序號) 雜湊決定（不碰戰鬥亂數）。 */
export function mashPolicy(battle, cmds) {
  const actor = unitOf(battle, cmds.actor);
  const targets = cmds.skills.find((s) => s.id === 'attack')?.targets ?? [];
  if (!targets.length) return { type: 'skill', skill: 'guard' };
  const h = Math.imul((battle.seed >>> 0) ^ 0x9e3779b9, 31) + Math.imul(battle.seq + 1, 0x85ebca6b) + actor.uid.length;
  return { type: 'skill', skill: 'attack', target: targets[(h >>> 0) % targets.length] };
}

/**
 * 催眠單一策略（規格補充 2 後的平衡斷言用）：艾妲只要靈性夠，就對生命上限最高的敵人（Boss）催眠——不管它睡著沒有；
 * 其他時候（以及主角）一律普攻生命比例最低的敵人。不用道具、預兆、子彈。睡眠受傷就醒，所以這招不該比合理策略強。
 */
export function hypnosisPolicy(battle, cmds) {
  const actor = unitOf(battle, cmds.actor);
  const enemies = battle.units.filter((u) => u.side === 'enemy' && u.alive);
  const boss = enemies.reduce((a, b) => (a === null || b.stats.hp > a.stats.hp ? b : a), null);
  if (boss && cmds.skills.some((s) => s.id === 'hypnosis' && s.usable)) return { type: 'skill', skill: 'hypnosis', target: boss.uid };
  return { type: 'skill', skill: 'attack', target: chooseTarget(battle, actor, 'enemy') };
}

// ───────────── M5（第四～七章）的策略 ─────────────
// 合理策略多一條：Boss 睡著或被影縛時先打小怪（focusAdds）；老賀伯【查閱】、馬洛【嘲諷】、換影者【影縛】（useLineage）。
// 艾妲只保留一次鎮魂的靈性（6）就催眠（第四章起她的靈性上限較高，有小怪時催眠的價值也較高）。
const M5 = { focusAdds: true, reserveSp: 6 };
export const smartM5Policy = makeSmartPolicy(M5);
export const noItemNoOmenM5Policy = makeSmartPolicy({ ...M5, useItems: false, useOmen: false });
export const noOmenM5Policy = makeSmartPolicy({ ...M5, useOmen: false });
export const noHypnosisM5Policy = makeSmartPolicy({ ...M5, useHypnosis: false });
