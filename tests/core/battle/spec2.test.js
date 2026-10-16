// 規格補充 2（2026-10-17）的核心部分：重新挑戰、睡眠受傷就醒、預兆的收益、崩解要命中才算。
import { describe, it, expect } from 'vitest';
import { prepareRetry, advanceEnemy, startBattle, RETRY_COLLAPSE_CAP } from '../../../web/src/core/battle/engine.js';
import { applyBattleEffect } from '../../../web/src/core/battle/effects.js';
import { deriveStats } from '../../../web/src/core/stats.js';
import { battleData, battleState } from './fixture.js';
import { unit, mkBattle, byUid } from './helpers.js';

const data = battleData();

describe('第 1 條：prepareRetry（重新挑戰＝戰前狀態，全隊回滿，崩解 min(戰前, 60)）', () => {
  const pre = battleState({
    lineage: { id: 'trace', rank: 9 }, collapse: 85, ammo: 2, items: { bandage: 1 },
    party: [{ id: 'hero', hp: 5, sp: 0 }, { id: 'ada', hp: 1, sp: 3 }],
  });
  it('生命、靈性回滿（數值＝deriveStats 的上限）；崩解夾到 60；子彈、道具、旗標照戰前', () => {
    const before = JSON.stringify(pre);
    const s = prepareRetry(pre, data);
    expect(JSON.stringify(pre)).toBe(before); // 不修改輸入
    expect(RETRY_COLLAPSE_CAP).toBe(60);
    expect(s.party).toEqual([
      { id: 'hero', hp: deriveStats('hero', pre, data).hp, sp: deriveStats('hero', pre, data).sp },
      { id: 'ada', hp: deriveStats('ada', pre, data).hp, sp: deriveStats('ada', pre, data).sp },
    ]);
    expect(s.collapse).toBe(60);
    expect(s.ammo).toBe(2);
    expect(s.items).toEqual({ bandage: 1 });
    expect(s.lineage).toEqual(pre.lineage);
    expect(s.pending).toBeNull();
  });
  it('戰前崩解低於 60 時不變', () => {
    expect(prepareRetry({ ...pre, collapse: 33 }, data).collapse).toBe(33);
  });
  it('結果可以直接開戰', () => {
    const b = startBattle('enc_two', prepareRetry(pre, data), data, 7);
    expect(b.units.filter((u) => u.side === 'party').every((u) => u.hp === u.stats.hp && u.sp === u.stats.sp)).toBe(true);
  });
});

describe('第 2 條：睡眠受到傷害就醒', () => {
  it('damage（amount ≥ 1）→ 移除 sleep，送出 wake 事件', () => {
    const b = mkBattle([unit('p0', 'party'), unit('e0', 'enemy', { hp: 100 }, { status: { sleep: 2 } })]);
    const r = applyBattleEffect(b, { type: 'damage', power: 100 }, 'p0', 'e0', data);
    expect(byUid(r.battle, 'e0').status.sleep).toBeUndefined();
    expect(r.log.at(-1)).toEqual({ type: 'wake', uid: 'e0' });
  });
  it('沒睡的人不送 wake；被打倒的人不送 wake', () => {
    const b = mkBattle([unit('p0', 'party'), unit('e0', 'enemy', { hp: 100 })]);
    expect(applyBattleEffect(b, { type: 'damage', power: 100 }, 'p0', 'e0', data).log.some((e) => e.type === 'wake')).toBe(false);
    const k = mkBattle([unit('p0', 'party'), unit('e0', 'enemy', { hp: 100 }, { hp: 1, status: { sleep: 2 } })]);
    expect(applyBattleEffect(k, { type: 'damage', fixed: 5 }, 'p0', 'e0', data).log.some((e) => e.type === 'wake')).toBe(false);
  });
});

/** e0 輪到行動、意圖是 skill 打 p0 的戰鬥。 */
const enemyTurn = (skill, { revealed, eva = 0, will = 0 } = {}) => mkBattle([
  unit('p0', 'party', { hp: 200, eva, will, def: 0 }),
  unit('e0', 'enemy', { hp: 100, atk: 30 }, { intent: { skill, target: 'p0' }, revealed: !!revealed }),
], { actor: 'e0' });

describe('第 3 條：被揭露的意圖執行時，對我方傷害與崩解 × 0.5', () => {
  it('傷害 × 0.5（round，最少 1），事件帶 foreseen', () => {
    const plain = advanceEnemy(enemyTurn('attack'), data).log.find((e) => e.type === 'damage');
    const seen = advanceEnemy(enemyTurn('attack', { revealed: true }), data).log.find((e) => e.type === 'damage');
    expect(plain.foreseen).toBeUndefined();
    expect(seen.amount).toBe(Math.max(1, Math.round(plain.amount * 0.5)));
    expect(seen.foreseen).toBe(true);
  });
  it('崩解增加量 × 0.5', () => {
    const plain = advanceEnemy(enemyTurn('whisper_minor'), data).battle.collapse;
    const seen = advanceEnemy(enemyTurn('whisper_minor', { revealed: true }), data);
    expect(plain).toBe(10);
    expect(seen.battle.collapse).toBe(5);
    expect(seen.log.find((e) => e.type === 'collapse')).toMatchObject({ amount: 5, foreseen: true });
  });
  it('intent_revealed 事件帶技能 id、技能名、目標 uid、目標名稱、敵人名稱', () => {
    const b = mkBattle([unit('p0', 'party'), unit('p1', 'party', {}, { name: '艾妲' }), unit('e0', 'enemy', {}, { name: '霧行者' })]);
    byUid(b, 'e0').intent = { skill: 'whisper_minor', target: 'p1' };
    const r = applyBattleEffect(b, { type: 'reveal_intent' }, 'p0', 'e0', data);
    expect(r.log).toEqual([{
      type: 'intent_revealed', source: 'p0', target: 'e0', target_name: '霧行者',
      skill: 'whisper_minor', skill_name: '低語', intent_target: 'p1', intent_target_name: '艾妲',
    }]);
  });
  it('全體技能的意圖：intent_target／intent_target_name 為 null', () => {
    const b = mkBattle([unit('p0', 'party'), unit('e0', 'enemy')]);
    byUid(b, 'e0').intent = { skill: 'call_fog', target: null };
    const ev = applyBattleEffect(b, { type: 'reveal_intent' }, 'p0', 'e0', data).log[0];
    expect(ev).toMatchObject({ skill: 'call_fog', skill_name: '喚霧', intent_target: null, intent_target_name: null });
  });
});

describe('第 4 條：所有目標都閃避時 collapse 不生效', () => {
  it('唯一目標閃避 → 崩解不變、沒有 collapse 事件', () => {
    const r = advanceEnemy(enemyTurn('whisper_minor', { eva: 100 }), data);
    expect(r.log.some((e) => e.type === 'miss')).toBe(true);
    expect(r.battle.collapse).toBe(0);
    expect(r.log.some((e) => e.type === 'collapse')).toBe(false);
  });
});
