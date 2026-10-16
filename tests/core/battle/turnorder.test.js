import { describe, it, expect } from 'vitest';
import { CT_THRESHOLD, nextActor, previewOrder, ctbSpeed } from '../../../web/src/core/battle/turnorder.js';

// 最小的行動者：只放 CTB 需要的欄位。
const u = (uid, side, spd, over = {}) => ({ uid, side, alive: true, ct: 0, stats: { spd }, mods: {}, status: {}, ...over });

describe('CTB 行動順序', () => {
  it('門檻 100；每一跳所有人 ct += spd，最先達到 100 的人行動', () => {
    expect(CT_THRESHOLD).toBe(100);
    const units = [u('p0', 'party', 10), u('e0', 'enemy', 25)];
    const r = nextActor(units);
    expect(r.uid).toBe('e0');
    expect(r.units.map((x) => x.ct)).toEqual([40, 100]); // 4 跳
    expect(units.map((x) => x.ct)).toEqual([0, 0]); // 不修改輸入
  });
  it('已有人 ≥ 100 時不再前進（同一跳有多人達標時依序輪流）', () => {
    const units = [u('p0', 'party', 10, { ct: 100 }), u('e0', 'enemy', 10, { ct: 120 })];
    const r = nextActor(units);
    expect(r.uid).toBe('e0');
    expect(r.units.map((x) => x.ct)).toEqual([100, 120]);
  });
  it('平手：ct 高者先；再平手我方先於敵方；同陣營依隊伍順序（不靠亂數）', () => {
    expect(nextActor([u('e0', 'enemy', 10), u('p0', 'party', 10)]).uid).toBe('p0');
    expect(nextActor([u('p1', 'party', 10), u('p0', 'party', 10)]).uid).toBe('p1');
    expect(nextActor([u('e0', 'enemy', 10), u('e1', 'enemy', 10)]).uid).toBe('e0');
    expect(nextActor([u('p0', 'party', 10), u('e0', 'enemy', 11)]).uid).toBe('e0'); // 110 > 100
  });
  it('倒下的人不累積、不行動', () => {
    const r = nextActor([u('p0', 'party', 50, { alive: false }), u('e0', 'enemy', 10)]);
    expect(r.uid).toBe('e0');
    expect(r.units[0].ct).toBe(0);
  });
  it('速度受增益／減益影響；速度最低視為 1（避免永遠輪不到）', () => {
    expect(ctbSpeed(u('p0', 'party', 10, { mods: { 'buff:spd': { pct: 50, turns: 2 } } }))).toBe(15);
    expect(ctbSpeed(u('p0', 'party', 10, { mods: { 'debuff:spd': { pct: 100, turns: 2 } } }))).toBe(1);
    expect(ctbSpeed(u('p0', 'party', 0))).toBe(1);
  });
  it('沒有任何存活的行動者 → 回傳 uid null', () => {
    expect(nextActor([u('p0', 'party', 10, { alive: false })]).uid).toBe(null);
  });
});

describe('previewOrder（不改變狀態）', () => {
  it('預覽 6 人：快的人出現兩次', () => {
    const battle = { actor: null, units: [u('p0', 'party', 10), u('p1', 'party', 20), u('e0', 'enemy', 10)] };
    const before = JSON.stringify(battle);
    expect(previewOrder(battle, 6)).toEqual(['p1', 'p0', 'p1', 'e0', 'p1', 'p0']);
    expect(JSON.stringify(battle)).toBe(before);
  });
  it('目前行動者排第一個（它的 ct 尚未扣 100）', () => {
    const battle = { actor: 'e0', units: [u('p0', 'party', 10, { ct: 50 }), u('e0', 'enemy', 10, { ct: 100 })] };
    expect(previewOrder(battle, 3)).toEqual(['e0', 'p0', 'e0']);
  });
  it('睡眠中的人照樣累積 ct，所以照樣出現在順序裡（輪到時才跳過）', () => {
    const battle = { actor: null, units: [u('p0', 'party', 10, { status: { sleep: 2 } }), u('e0', 'enemy', 5)] };
    expect(previewOrder(battle, 3)).toEqual(['p0', 'p0', 'e0']);
  });
});
