// 規格補充 3（2026-10-17，M2 第二輪對抗審查）的核心部分：重新挑戰不能撈好處、催眠要有正收益。
import { describe, it, expect } from 'vitest';
import { startBattle, commands, act, finishBattle, prepareRetry, isPlayerTurn, advanceEnemy } from '../../../web/src/core/battle/engine.js';
import { applyBattleEffect, damageAmount, SLEEP_MULT } from '../../../web/src/core/battle/effects.js';
import { battleData, battleState } from './fixture.js';
import { unit, mkBattle, byUid } from './helpers.js';

const data = battleData();

/** 審查者的攻擊情境：全隊 1 HP、崩解 95 的戰前狀態。 */
const pre = battleState({
  lineage: { id: 'trace', rank: 9 }, collapse: 95, ammo: 0, items: {},
  party: [{ id: 'hero', hp: 1, sp: 0 }, { id: 'ada', hp: 1, sp: 0 }],
});
const retryOpts = { retry: true, preCollapse: pre.collapse };

/** 推進到我方回合（敵人行動交給 advanceEnemy）。 */
function toPlayer(b) {
  let x = b;
  for (let i = 0; i < 50 && x.outcome === null && !isPlayerTurn(x); i++) x = advanceEnemy(x, data).battle;
  return x;
}

describe('第 1 條：重新挑戰的那場戰鬥不能逃跑', () => {
  it('一般 can_flee 遭遇：平常 canFlee true；重試戰 canFlee false，flee 指令丟錯', () => {
    const normal = toPlayer(startBattle('enc_one', prepareRetry(pre, data), data, 3));
    expect(commands(normal, data).canFlee).toBe(true);
    const r = toPlayer(startBattle('enc_one', prepareRetry(pre, data), data, 3, retryOpts));
    expect(r.retry).toEqual({ preCollapse: 95 });
    expect(commands(r, data).canFlee).toBe(false);
    expect(() => act(r, { type: 'flee' }, data)).toThrow(/不能逃跑/);
  });
  it('重試選項不合法時丟錯（preCollapse 必須是 0～100 的整數）', () => {
    expect(() => startBattle('enc_one', pre, data, 3, { retry: true })).toThrow(/preCollapse/);
    expect(() => startBattle('enc_one', pre, data, 3, { retry: true, preCollapse: 101 })).toThrow(/preCollapse/);
  });
});

describe('第 1 條：重試戰結束時崩解取 max(戰後, 戰前)', () => {
  const ended = (b, outcome, collapse) => ({ ...b, outcome, actor: null, collapse });
  it('勝利：戰後 60 < 戰前 95 → 寫回 95；生命靈性照戰後的值', () => {
    const b = startBattle('enc_one', prepareRetry(pre, data), data, 3, retryOpts);
    const res = finishBattle(ended(b, 'victory', 60), prepareRetry(pre, data), data);
    expect(res.state.collapse).toBe(95);
    const heroUnit = b.units.find((u) => u.id === 'hero');
    expect(res.state.party[0].hp).toBe(heroUnit.hp); // 照戰後（回滿後打完的值），不回到 1
  });
  it('勝利：戰後比戰前高時用戰後', () => {
    const b = startBattle('enc_one', prepareRetry(pre, data), data, 3, { retry: true, preCollapse: 20 });
    expect(finishBattle(ended(b, 'victory', 33), pre, data).state.collapse).toBe(33);
  });
  it('教學戰（on_lose: continue）戰敗也套用下限', () => {
    const b = startBattle('enc_boss', prepareRetry(pre, data), data, 3, retryOpts);
    const res = finishBattle(ended(b, 'defeat', 50), prepareRetry(pre, data), data);
    expect(res.next).toEqual({ type: 'dialogue', dialogue: 'dlg_after' });
    expect(res.state.collapse).toBe(95);
  });
  it('不是重試戰時不套用下限', () => {
    const b = startBattle('enc_one', prepareRetry(pre, data), data, 3);
    expect(finishBattle(ended(b, 'victory', 60), pre, data).state.collapse).toBe(60);
  });
});

describe('第 2 條：睡眠中第一次受到的傷害 × 1.5，然後醒來', () => {
  it('公式：SLEEP_MULT＝1.5，在其他倍率（含防禦）之後、round 之前', () => {
    expect(SLEEP_MULT).toBe(1.5);
    expect(damageAmount({ atk: 20, power: 100, def: 0, sleep: true })).toBe(30);
    // 防禦 ×0.5 之後再 ×1.5：20 × 0.5 × 1.5 = 15
    expect(damageAmount({ atk: 20, power: 100, def: 0, guard: true, sleep: true })).toBe(15);
    // round 在最後：(7 − 1 × 0.5) × 1.5 = 9.75 → 10；若先 round（6.5 → 7）再乘會變成 10.5 → 11
    expect(damageAmount({ atk: 7, power: 100, def: 1, sleep: true })).toBe(10);
  });
  it('fixed 傷害也 × 1.5；醒來後第二下恢復原值', () => {
    const b = mkBattle([unit('p0', 'party'), unit('e0', 'enemy', { hp: 100 }, { status: { sleep: 2 } })]);
    const r1 = applyBattleEffect(b, { type: 'damage', fixed: 10 }, 'p0', 'e0', data);
    expect(r1.log.find((e) => e.type === 'damage')).toMatchObject({ amount: 15, sleeping: true });
    expect(r1.log.some((e) => e.type === 'wake' && e.uid === 'e0')).toBe(true);
    expect(byUid(r1.battle, 'e0').hp).toBe(85);
    const r2 = applyBattleEffect(r1.battle, { type: 'damage', fixed: 10 }, 'p0', 'e0', data);
    expect(r2.log.find((e) => e.type === 'damage').amount).toBe(10);
    expect(r2.log.find((e) => e.type === 'damage').sleeping).toBeUndefined();
  });
  it('power 傷害：同一個 rng 下，睡著的目標＝醒著的 round(原始 × 1.5)', () => {
    const mk = (status) => mkBattle([unit('p0', 'party', { atk: 37 }), unit('e0', 'enemy', { hp: 500, def: 3 }, { status })]);
    const awake = applyBattleEffect(mk({}), { type: 'damage', power: 120 }, 'p0', 'e0', data).log.find((e) => e.type === 'damage');
    const asleep = applyBattleEffect(mk({ sleep: 3 }), { type: 'damage', power: 120 }, 'p0', 'e0', data).log.find((e) => e.type === 'damage');
    expect(awake.crit).toBe(asleep.crit);
    // 同一次擲骰：37 × 1.2 − 1.5 再乘亂數倍率；睡著時多乘 1.5 之後才 round
    expect(asleep.amount).toBeGreaterThanOrEqual(Math.floor(awake.amount * 1.5) - 1);
    expect(asleep.amount).toBeLessThanOrEqual(Math.ceil(awake.amount * 1.5) + 1);
    expect(asleep.amount).toBeGreaterThan(awake.amount);
  });
});
