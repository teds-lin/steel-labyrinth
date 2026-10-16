import { describe, it, expect } from 'vitest';
import { checkBattleCondition, evalBattleCondition, chooseTarget, decideIntent, aiRules } from '../../../web/src/core/battle/ai.js';
import { createRng } from '../../../web/src/core/rng.js';
import { battleData } from './fixture.js';
import { unit, mkBattle, byUid } from './helpers.js';

const data = battleData();
const fog = (uid, over = {}) => unit(uid, 'enemy', { hp: 40, sp: 0, atk: 9, def: 4, spd: 9, will: 5, eva: 5 }, { id: 'fogwalker', ...over });

describe('戰鬥條件', () => {
  const b = mkBattle([unit('p0', 'party', { hp: 60 }, { hp: 30, status: { sleep: 1 } }), unit('p1', 'party'), fog('e0', { hp: 10, acted: 1 }), fog('e1')]);
  const ctx = { battle: b, unit: byUid(b, 'e0'), targets: [byUid(b, 'p0')] };
  it('hp_lte_pct（自己的生命比例）、turn_gte（這是自己的第幾次行動）、allies_lte（場上存活的同陣營人數）', () => {
    expect(evalBattleCondition({ hp_lte_pct: 25 }, ctx)).toBe(true); // 10/40
    expect(evalBattleCondition({ hp_lte_pct: 20 }, ctx)).toBe(false);
    expect(evalBattleCondition({ turn_gte: 2 }, ctx)).toBe(true); // 已行動 1 次 → 正在決定第 2 次
    expect(evalBattleCondition({ turn_gte: 3 }, ctx)).toBe(false);
    expect(evalBattleCondition({ allies_lte: 2 }, ctx)).toBe(true);
    expect(evalBattleCondition({ allies_lte: 1 }, ctx)).toBe(false);
  });
  it('target_has_status（候選目標身上有該狀態）與 all／any／not', () => {
    expect(evalBattleCondition({ target_has_status: 'sleep' }, ctx)).toBe(true);
    expect(evalBattleCondition({ target_has_status: 'taunt' }, ctx)).toBe(false);
    expect(evalBattleCondition({ all: [{ turn_gte: 2 }, { not: { allies_lte: 1 } }] }, ctx)).toBe(true);
    expect(evalBattleCondition({ any: [{ turn_gte: 9 }, { hp_lte_pct: 1 }] }, ctx)).toBe(false);
  });
  it('不合法寫法：checkBattleCondition 回報、evalBattleCondition 丟錯', () => {
    for (const c of [{}, { flag: 'x' }, { hp_lte_pct: 120 }, { turn_gte: 0 }, { allies_lte: -1 }, { target_has_status: 'stone' },
      { all: {} }, { not: [] }, { hp_lte_pct: 10, turn_gte: 1 }, { toString: 1 }]) {
      expect(checkBattleCondition(c).length, JSON.stringify(c)).toBeGreaterThan(0);
      expect(() => evalBattleCondition(c, ctx), JSON.stringify(c)).toThrow();
    }
  });
});

describe('目標選擇', () => {
  it('單體技能選我方生命比例最低者；平手依隊伍順序', () => {
    const b = mkBattle([unit('p0', 'party', { hp: 60 }, { hp: 30 }), unit('p1', 'party', { hp: 50 }, { hp: 20 }), fog('e0')]);
    expect(chooseTarget(b, byUid(b, 'e0'), 'enemy')).toBe('p1'); // 0.4 < 0.5
    const t = mkBattle([unit('p0', 'party', { hp: 60 }, { hp: 30 }), unit('p1', 'party', { hp: 50 }, { hp: 25 }), fog('e0')]);
    expect(chooseTarget(t, byUid(t, 'e0'), 'enemy')).toBe('p0');
  });
  it('有 taunt 的角色優先；倒下的不選', () => {
    const b = mkBattle([unit('p0', 'party', {}, { status: { taunt: 2 } }), unit('p1', 'party', { hp: 50 }, { hp: 1 }), unit('p2', 'party', {}, { hp: 0, alive: false }), fog('e0')]);
    expect(chooseTarget(b, byUid(b, 'e0'), 'enemy')).toBe('p0');
  });
  it('ally 選同陣營生命比例最低者；self 是自己；全體技能沒有單一目標', () => {
    const b = mkBattle([unit('p0', 'party'), fog('e0', { hp: 40 }), fog('e1', { hp: 5 })]);
    expect(chooseTarget(b, byUid(b, 'e0'), 'ally')).toBe('e1');
    expect(chooseTarget(b, byUid(b, 'e0'), 'self')).toBe('e0');
    expect(chooseTarget(b, byUid(b, 'e0'), 'enemy_all')).toBe(null);
  });
});

describe('decideIntent（規則過濾＋加權＋目標）', () => {
  it('if 不成立的規則不會被選；加權抽選大致依 weight', () => {
    const counts = { attack: 0, whisper_minor: 0 };
    for (let s = 1; s <= 400; s++) {
      const b = mkBattle([unit('p0', 'party'), fog('e0', { acted: 0 })], { rng: createRng(s) });
      expect(decideIntent(b, 'e0', data).intent.skill).toBe('attack'); // whisper 要 turn_gte 2
      const b2 = mkBattle([unit('p0', 'party'), fog('e0', { acted: 1 })], { rng: createRng(s) });
      counts[decideIntent(b2, 'e0', data).intent.skill]++;
    }
    expect(counts.whisper_minor).toBeGreaterThan(60); // 期望 100（1:3）
    expect(counts.whisper_minor).toBeLessThan(140);
  });
  it('意圖記在戰鬥狀態（技能＋目標），揭露旗標重設；不修改輸入；消耗亂數', () => {
    const b = mkBattle([unit('p0', 'party'), fog('e0', { revealed: true })]);
    const before = JSON.stringify(b);
    const r = decideIntent(b, 'e0', data);
    expect(JSON.stringify(b)).toBe(before);
    expect(r.intent).toEqual({ skill: 'attack', target: 'p0' });
    expect(byUid(r.battle, 'e0')).toMatchObject({ intent: { skill: 'attack', target: 'p0' }, revealed: false });
    expect(r.battle.rng).not.toEqual(b.rng);
  });
  it('付不起靈性的技能先濾掉；全部付不起時忽略消耗', () => {
    const d = structuredClone(data);
    d.enemies[0].ai = [{ skill: 'omen', weight: 100 }, { skill: 'attack', weight: 1 }];
    for (let s = 1; s <= 20; s++) {
      const b = mkBattle([unit('p0', 'party'), fog('e0')], { rng: createRng(s) }); // sp 0，omen 要 4
      expect(decideIntent(b, 'e0', d).intent.skill).toBe('attack');
    }
    d.enemies[0].ai = [{ skill: 'omen', weight: 1 }];
    expect(decideIntent(mkBattle([unit('p0', 'party'), fog('e0')]), 'e0', d).intent.skill).toBe('omen');
  });
  it('phases 追加的規則併入（aiRules）', () => {
    const e = fog('e0', { extraAi: [{ skill: 'call_fog', weight: 5 }] });
    expect(aiRules(e, data).map((r) => r.skill)).toEqual(['whisper_minor', 'attack', 'call_fog']);
  });
  it('混亂中的敵人：單體技能的目標改成隨機（任一陣營、不含自己）', () => {
    const targets = new Set();
    for (let s = 1; s <= 60; s++) {
      const b = mkBattle([unit('p0', 'party'), unit('p1', 'party'), fog('e0', { status: { confuse: 2 } }), fog('e1')], { rng: createRng(s) });
      targets.add(decideIntent(b, 'e0', data).intent.target);
    }
    expect([...targets].sort()).toEqual(['e1', 'p0', 'p1']);
  });
});
