import { describe, it, expect } from 'vitest';
import {
  checkBattleEffect, applyBattleEffect, damageAmount, hitChance, statusChance, collapseAmount, BATTLE_STATUSES,
} from '../../../web/src/core/battle/effects.js';
import { effectiveStat } from '../../../web/src/core/battle/stat.js';
import { createRng } from '../../../web/src/core/rng.js';
import { battleData } from './fixture.js';
import { unit, mkBattle, byUid } from './helpers.js';

const data = battleData();
const seeds = (n) => Array.from({ length: n }, (_, i) => i + 1);

describe('checkBattleEffect（效果積木的寫法）', () => {
  it('合法寫法', () => {
    const ok = [
      { type: 'damage', power: 100 }, { type: 'damage', power: 80, stat: 'will', ignore_def: true }, { type: 'damage', fixed: 25 },
      { type: 'heal', pct: 30 }, { type: 'heal', amount: 20, on: 'self' }, { type: 'sp', amount: -3 },
      { type: 'buff', stat: 'eva', pct: 30, turns: 2 }, { type: 'debuff', stat: 'atk', pct: 20, turns: 1 },
      { type: 'buff', stat: 'eva', amount: 20, turns: 2 }, { type: 'debuff', stat: 'def', amount: 3, turns: 1 },
      { type: 'status', status: 'sleep', chance: 80, turns: 2 }, { type: 'status', status: 'guard', turns: 1 },
      { type: 'reveal_intent' }, { type: 'collapse', amount: 10 }, { type: 'summon', enemy: 'fogwalker', max: 2 },
    ];
    for (const e of ok) expect(checkBattleEffect(e), JSON.stringify(e)).toEqual([]);
    expect(BATTLE_STATUSES).toEqual(['sleep', 'confuse', 'taunt', 'guard']);
  });
  it('不合法：未知 type、缺欄位、型別錯誤、多餘欄位、原型鍵', () => {
    const bad = [
      null, [], {}, { type: 'explode' }, { type: 'toString' }, { type: 'damage' }, { type: 'damage', power: '100' },
      { type: 'damage', power: 100, fixed: 3 }, { type: 'damage', fixed: 0 }, { type: 'damage', power: 100, stat: 'luck' },
      { type: 'damage', power: 100, ignore_def: 1 }, { type: 'damage', power: 100, extra: 1 },
      { type: 'heal' }, { type: 'heal', pct: 10, amount: 3 }, { type: 'heal', pct: -1 }, { type: 'sp' }, { type: 'sp', amount: 1.5 },
      { type: 'buff', stat: 'hp', pct: 10, turns: 1 }, { type: 'buff', stat: 'atk', pct: 10 }, { type: 'debuff', stat: 'atk', pct: 0, turns: 1 },
      { type: 'buff', stat: 'eva', pct: 10, amount: 5, turns: 1 }, { type: 'buff', stat: 'eva', turns: 1 }, { type: 'buff', stat: 'eva', amount: 1.5, turns: 1 },
      { type: 'status', status: 'stone', turns: 1 }, { type: 'status', status: 'sleep', chance: 120, turns: 1 }, { type: 'status', status: 'sleep' },
      { type: 'reveal_intent', x: 1 }, { type: 'collapse', amount: 1.5 }, { type: 'summon', enemy: 'x' }, { type: 'summon', enemy: '', max: 1 },
      { type: 'damage', power: 100, on: 'target' },
    ];
    for (const e of bad) expect(checkBattleEffect(e).length, JSON.stringify(e)).toBeGreaterThan(0);
  });
  it('套用不合法的積木丟錯', () => {
    const b = mkBattle([unit('p0', 'party'), unit('e0', 'enemy')]);
    expect(() => applyBattleEffect(b, { type: 'explode' }, 'p0', 'e0', data)).toThrow(/explode/);
  });
});

describe('公式', () => {
  it('傷害：攻擊方 stat × power ÷ 100 − 目標 def × 0.5，再乘亂數、爆擊 ×1.5、防禦中 ×0.5，round，最少 1', () => {
    expect(damageAmount({ atk: 10, power: 100, def: 4, mult: 1 })).toBe(8);
    expect(damageAmount({ atk: 10, power: 100, def: 4, mult: 1.1 })).toBe(9); // 8.8
    expect(damageAmount({ atk: 10, power: 100, def: 4, mult: 1, crit: true })).toBe(12);
    expect(damageAmount({ atk: 10, power: 100, def: 4, mult: 1, guard: true })).toBe(4);
    expect(damageAmount({ atk: 10, power: 100, def: 4, mult: 1, ignoreDef: true })).toBe(10);
    expect(damageAmount({ atk: 1, power: 100, def: 50, mult: 1 })).toBe(1);
    expect(damageAmount({ atk: 10, power: 150, def: 0, mult: 0.9 })).toBe(14); // 13.5 → 14
  });
  it('命中：攻擊方是敵人時＝100 − 目標 eva（含增益），夾在 0～100；我方攻擊必中', () => {
    const p = unit('p0', 'party', { eva: 20 });
    const e = unit('e0', 'enemy', { eva: 50 });
    expect(hitChance(e, p)).toBe(80);
    expect(hitChance(p, e)).toBe(100);
    expect(hitChance(e, { ...p, mods: { 'buff:eva': { pct: 50, turns: 1 } } })).toBe(70);
    expect(hitChance(e, unit('p1', 'party', { eva: 150 }))).toBe(0);
  });
  it('異常機率：對敵對陣營＝chance × 50 ÷ (50＋will)；對自己／同伴不減免', () => {
    expect(statusChance(80, unit('p0', 'party'), unit('e0', 'enemy', { will: 30 }))).toBe(50);
    expect(statusChance(100, unit('p0', 'party'), unit('p1', 'party', { will: 30 }))).toBe(100);
  });
  it('崩解：round(amount × 50 ÷ (50＋主角 will))', () => {
    expect(collapseAmount(10, 14)).toBe(8); // 7.81
    expect(collapseAmount(10, 0)).toBe(10);
    expect(collapseAmount(-10, 50)).toBe(-10); // 降低崩解不受意志縮放
  });
});

describe('applyBattleEffect（不可變）', () => {
  const base = () => mkBattle([
    unit('p0', 'party', { hp: 60, will: 14, eva: 0 }),
    unit('p1', 'party', { hp: 50 }, { hp: 20 }),
    unit('e0', 'enemy', { hp: 40, def: 4 }),
    unit('e1', 'enemy', { hp: 40 }, { id: 'porter', stats: { hp: 120, sp: 0, atk: 12, def: 6, spd: 8, will: 10, eva: 0 }, hp: 70 }),
  ]);
  it('不修改輸入，回傳新的 battle 與事件', () => {
    const b = base();
    const before = JSON.stringify(b);
    const r = applyBattleEffect(b, { type: 'damage', power: 100 }, 'p0', 'e0', data);
    expect(JSON.stringify(b)).toBe(before);
    expect(r.log.find((e) => e.type === 'damage')).toMatchObject({ type: 'damage', source: 'p0', target: 'e0' });
    expect(byUid(r.battle, 'e0').hp).toBe(40 - r.log.find((e) => e.type === 'damage').amount);
  });
  it('damage：數值落在亂數範圍內（8 × 0.9～1.1，或爆擊 ×1.5）', () => {
    const amounts = new Set();
    for (const s of seeds(300)) {
      const r = applyBattleEffect({ ...base(), rng: createRng(s) }, { type: 'damage', power: 100 }, 'p0', 'e0', data);
      amounts.add(r.log.find((e) => e.type === 'damage').amount);
    }
    expect([...amounts].every((a) => [7, 8, 9, 11, 12, 13].includes(a))).toBe(true);
    expect([...amounts].some((a) => a >= 11)).toBe(true); // 300 次裡有爆擊
  });
  it('damage：爆擊會先送出 crit 事件；fixed 是固定值（不受亂數、爆擊、防禦影響）', () => {
    let found = false;
    for (const s of seeds(300)) {
      const r = applyBattleEffect({ ...base(), rng: createRng(s) }, { type: 'damage', power: 100 }, 'p0', 'e0', data);
      if (r.log[0].type === 'crit') { expect(r.log[1]).toMatchObject({ type: 'damage', crit: true }); found = true; break; }
    }
    expect(found).toBe(true);
    const b = base();
    byUid(b, 'e0').status.guard = 1;
    const r = applyBattleEffect(b, { type: 'damage', fixed: 25, ignore_def: true }, 'p0', 'e0', data);
    expect(r.log).toEqual([{ type: 'damage', source: 'p0', target: 'e0', amount: 25, crit: false, hp: 15 }]);
  });
  it('damage：生命歸 0 → defeated，倒下的敵人擲掉落', () => {
    const b = base();
    byUid(b, 'e0').hp = 3;
    const r = applyBattleEffect(b, { type: 'damage', fixed: 25 }, 'p0', 'e0', data);
    expect(byUid(r.battle, 'e0')).toMatchObject({ hp: 0, alive: false, intent: null });
    expect(r.log.map((e) => e.type)).toContain('defeated');
    const porter = applyBattleEffect(b, { type: 'damage', fixed: 999 }, 'p0', 'e1', data);
    expect(porter.battle.drops).toEqual([{ item: 'pocket_watch', count: 1 }]); // chance 100
    expect(porter.log).toContainEqual({ type: 'drop', uid: 'e1', item: 'pocket_watch' });
  });
  it('damage：已倒下的目標不受影響', () => {
    const b = base();
    Object.assign(byUid(b, 'e0'), { hp: 0, alive: false });
    expect(applyBattleEffect(b, { type: 'damage', fixed: 5 }, 'p0', 'e0', data).log).toEqual([]);
  });
  it('phases：敵人生命降到門檻以下 → 進入新階段（追加 AI、送出 phase 事件），只觸發一次', () => {
    const b = base(); // e1 是 porter：hp 70/120
    const r = applyBattleEffect(b, { type: 'damage', fixed: 15 }, 'p0', 'e1', data); // 55/120 ≈ 45.8%
    expect(r.log).toContainEqual({ type: 'phase', uid: 'e1', index: 0, dialogue: 'dlg_phase' });
    expect(byUid(r.battle, 'e1').phasesDone).toEqual([0]);
    expect(byUid(r.battle, 'e1').extraAi).toEqual([{ skill: 'call_fog', weight: 100, if: { allies_lte: 1 } }]);
    const r2 = applyBattleEffect(r.battle, { type: 'damage', fixed: 1 }, 'p0', 'e1', data);
    expect(r2.log.some((e) => e.type === 'phase')).toBe(false);
  });
  it('phases：add_ai／dialogue 選填；一次跨過多個門檻時依門檻由高到低依序觸發，每段只觸發一次', () => {
    const d = structuredClone(data);
    d.enemies[1].phases = [{ hp_lte_pct: 25, dialogue: 'dlg_low' }, { hp_lte_pct: 60 }, { hp_lte_pct: 50, add_ai: [{ skill: 'attack', weight: 1 }] }];
    const r = applyBattleEffect(base(), { type: 'damage', fixed: 50 }, 'p0', 'e1', d); // 70 → 20/120 ≈ 16.7%
    expect(r.log.filter((e) => e.type === 'phase')).toEqual([
      { type: 'phase', uid: 'e1', index: 1, dialogue: null },
      { type: 'phase', uid: 'e1', index: 2, dialogue: null },
      { type: 'phase', uid: 'e1', index: 0, dialogue: 'dlg_low' },
    ]);
    expect(byUid(r.battle, 'e1').phasesDone).toEqual([1, 2, 0]);
    expect(byUid(r.battle, 'e1').extraAi).toEqual([{ skill: 'attack', weight: 1 }]);
  });
  it('heal：pct 或 amount，不超過上限；倒下的不回復', () => {
    let r = applyBattleEffect(base(), { type: 'heal', pct: 30 }, 'p0', 'p1', data);
    expect(r.log).toEqual([{ type: 'heal', source: 'p0', target: 'p1', amount: 15, hp: 35 }]);
    r = applyBattleEffect(base(), { type: 'heal', amount: 999 }, 'p0', 'p1', data);
    expect(byUid(r.battle, 'p1').hp).toBe(50);
    const b = base();
    Object.assign(byUid(b, 'p1'), { hp: 0, alive: false });
    expect(applyBattleEffect(b, { type: 'heal', amount: 10 }, 'p0', 'p1', data).log).toEqual([]);
  });
  it('sp：回復／扣除，夾在 0～上限', () => {
    const b = base();
    byUid(b, 'p0').sp = 4;
    expect(byUid(applyBattleEffect(b, { type: 'sp', amount: 100 }, 'p0', 'p0', data).battle, 'p0').sp).toBe(10);
    const r = applyBattleEffect(b, { type: 'sp', amount: -9 }, 'p0', 'p0', data);
    expect(r.log).toEqual([{ type: 'sp', source: 'p0', target: 'p0', amount: -4, sp: 0 }]);
  });
  it('buff／debuff：同一能力值同類效果取最新的覆蓋；增益與減益並存', () => {
    let r = applyBattleEffect(base(), { type: 'buff', stat: 'atk', pct: 50, turns: 3 }, 'p0', 'p0', data);
    r = applyBattleEffect(r.battle, { type: 'buff', stat: 'atk', pct: 20, turns: 1 }, 'p0', 'p0', data);
    r = applyBattleEffect(r.battle, { type: 'debuff', stat: 'atk', pct: 10, turns: 2 }, 'e0', 'p0', data);
    const p0 = byUid(r.battle, 'p0');
    expect(p0.mods).toEqual({ 'buff:atk': { pct: 20, turns: 1 }, 'debuff:atk': { pct: 10, turns: 2 } });
    expect(effectiveStat(p0, 'atk')).toBe(11);
    expect(r.log.at(-1)).toEqual({ type: 'debuff', source: 'e0', target: 'p0', stat: 'atk', pct: 10, turns: 2 });
  });
  it('buff／debuff 的 amount：能力值直接加減（eva 這類百分比能力值用 amount）；與 pct 並用時先乘後加', () => {
    let r = applyBattleEffect(base(), { type: 'buff', stat: 'eva', amount: 30, turns: 2 }, 'p0', 'p0', data);
    expect(byUid(r.battle, 'p0').mods).toEqual({ 'buff:eva': { amount: 30, turns: 2 } });
    expect(effectiveStat(byUid(r.battle, 'p0'), 'eva')).toBe(30);
    expect(r.log.at(-1)).toEqual({ type: 'buff', source: 'p0', target: 'p0', stat: 'eva', amount: 30, turns: 2 });
    r = applyBattleEffect(r.battle, { type: 'debuff', stat: 'eva', amount: 50, turns: 1 }, 'e0', 'p0', data);
    expect(effectiveStat(byUid(r.battle, 'p0'), 'eva')).toBe(0); // 最少 0
    r = applyBattleEffect(base(), { type: 'buff', stat: 'atk', pct: 50, turns: 2 }, 'p0', 'p0', data);
    r = applyBattleEffect(r.battle, { type: 'debuff', stat: 'atk', amount: 3, turns: 2 }, 'e0', 'p0', data);
    expect(effectiveStat(byUid(r.battle, 'p0'), 'atk')).toBe(12); // 10 × 1.5 − 3
  });
  it('status：對敵對陣營的機率受 will 減免；對自己必定成功（例如防禦）；覆蓋回合數', () => {
    let ok = 0;
    for (const s of seeds(400)) {
      const b = { ...base(), rng: createRng(s) };
      byUid(b, 'e0').stats.will = 50; // 100 × 50 ÷ 100 = 50%
      const r = applyBattleEffect(b, { type: 'status', status: 'sleep', turns: 2 }, 'p0', 'e0', data);
      if (byUid(r.battle, 'e0').status.sleep === 2) ok++;
      else expect(r.log).toEqual([{ type: 'status_resisted', source: 'p0', target: 'e0', status: 'sleep' }]);
    }
    expect(ok).toBeGreaterThan(160);
    expect(ok).toBeLessThan(240);
    const g = applyBattleEffect(base(), { type: 'status', status: 'guard', turns: 1 }, 'p0', 'p0', data);
    expect(byUid(g.battle, 'p0').status).toEqual({ guard: 1 });
    expect(g.log).toEqual([{ type: 'status', source: 'p0', target: 'p0', status: 'guard', turns: 1 }]);
  });
  it('防禦中受到的傷害 ×0.5', () => {
    const b = base();
    byUid(b, 'e0').status.guard = 1;
    const plain = applyBattleEffect(base(), { type: 'damage', power: 100 }, 'p0', 'e0', data).log.at(-1).amount;
    const guarded = applyBattleEffect(b, { type: 'damage', power: 100 }, 'p0', 'e0', data).log.at(-1).amount;
    expect(guarded).toBeLessThan(plain);
  });
  it('reveal_intent：標記目標敵人的意圖為已揭露，事件帶技能與目標', () => {
    const b = base();
    byUid(b, 'e0').intent = { skill: 'attack', target: 'p1' };
    const r = applyBattleEffect(b, { type: 'reveal_intent' }, 'p0', 'e0', data);
    expect(byUid(r.battle, 'e0').revealed).toBe(true);
    expect(r.log).toEqual([{ type: 'intent_revealed', source: 'p0', target: 'e0', target_name: 'e0', skill: 'attack', skill_name: '攻擊', intent_target: 'p1', intent_target_name: 'p1' }]);
  });
  it('collapse：依主角（隊伍裡的 hero）will 減免，夾在 0～100；達 100 → lost_control 並結束戰鬥', () => {
    let r = applyBattleEffect(base(), { type: 'collapse', amount: 10 }, 'e0', 'p1', data);
    expect(r.battle.collapse).toBe(8);
    expect(r.log).toEqual([{ type: 'collapse', source: 'e0', amount: 8, total: 8 }]);
    const b = { ...base(), collapse: 95 };
    Object.assign(byUid(b, 'p0'), { hp: 0, alive: false }); // 主角倒下也照算
    r = applyBattleEffect(b, { type: 'collapse', amount: 10 }, 'e0', 'p1', data);
    expect(r.battle.collapse).toBe(100);
    expect(applyBattleEffect({ ...base(), collapse: 30 }, { type: 'collapse', amount: -15 }, 'p1', 'p1', data).battle.collapse).toBe(15);
    expect(r.battle.outcome).toBe('lost_control');
    expect(r.log.at(-1)).toEqual({ type: 'lost_control' });
  });
  it('summon：召喚敵人（決定好意圖），場上同種敵人不超過 max', () => {
    let r = applyBattleEffect(base(), { type: 'summon', enemy: 'fogwalker', max: 2 }, 'e1', 'e1', data);
    const added = r.battle.units.at(-1);
    expect(added).toMatchObject({ uid: 'e4', side: 'enemy', id: 'fogwalker', hp: 40, ct: 0, alive: true });
    expect(added.intent).toMatchObject({ skill: 'attack' });
    expect(r.log).toEqual([{ type: 'summon', source: 'e1', uid: 'e4', enemy: 'fogwalker' }]);
    r = applyBattleEffect(r.battle, { type: 'summon', enemy: 'fogwalker', max: 2 }, 'e1', 'e1', data);
    expect(r.log).toEqual([{ type: 'summon_failed', source: 'e1', enemy: 'fogwalker' }]);
  });
});
