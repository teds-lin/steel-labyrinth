import { describe, it, expect } from 'vitest';
import { evalCondition, checkCondition } from '../../web/src/core/conditions.js';

const st = (over = {}) => ({
  flags: { door_open: true }, items: { attic_key: 1 }, echo: { charges: 2 },
  lineage: { id: 'trace', rank: 9 }, ...over,
});

describe('evalCondition', () => {
  it('flag／not_flag', () => {
    expect(evalCondition({ flag: 'door_open' }, st())).toBe(true);
    expect(evalCondition({ flag: 'nope' }, st())).toBe(false);
    expect(evalCondition({ not_flag: 'nope' }, st())).toBe(true);
    expect(evalCondition({ not_flag: 'door_open' }, st())).toBe(false);
  });
  it('旗標值 false 視為不成立', () => {
    expect(evalCondition({ flag: 'x' }, st({ flags: { x: false } }))).toBe(false);
  });
  it('item：持有數量 > 0', () => {
    expect(evalCondition({ item: 'attic_key' }, st())).toBe(true);
    expect(evalCondition({ item: 'other' }, st())).toBe(false);
    expect(evalCondition({ item: 'attic_key' }, st({ items: { attic_key: 0 } }))).toBe(false);
  });
  it('echo_gte', () => {
    expect(evalCondition({ echo_gte: 2 }, st())).toBe(true);
    expect(evalCondition({ echo_gte: 3 }, st())).toBe(false);
    expect(evalCondition({ echo_gte: 0 }, st({ echo: { charges: 0 } }))).toBe(true);
  });
  it('lineage 與 rank_lte（沒有譜系時一律不成立）', () => {
    expect(evalCondition({ lineage: 'trace' }, st())).toBe(true);
    expect(evalCondition({ lineage: 'other' }, st())).toBe(false);
    expect(evalCondition({ rank_lte: 9 }, st())).toBe(true);
    expect(evalCondition({ rank_lte: 8 }, st())).toBe(false);
    expect(evalCondition({ lineage: 'trace' }, st({ lineage: null }))).toBe(false);
    expect(evalCondition({ rank_lte: 99 }, st({ lineage: null }))).toBe(false);
  });
  it('all／any／not 組合，空 all 為真、空 any 為假', () => {
    expect(evalCondition({ all: [{ flag: 'door_open' }, { item: 'attic_key' }] }, st())).toBe(true);
    expect(evalCondition({ all: [{ flag: 'door_open' }, { item: 'x' }] }, st())).toBe(false);
    expect(evalCondition({ any: [{ flag: 'x' }, { item: 'attic_key' }] }, st())).toBe(true);
    expect(evalCondition({ not: { flag: 'door_open' } }, st())).toBe(false);
    expect(evalCondition({ all: [] }, st())).toBe(true);
    expect(evalCondition({ any: [] }, st())).toBe(false);
  });
  it('未知寫法一律丟錯，不可當成成立', () => {
    expect(() => evalCondition({ flagg: 'x' }, st())).toThrow(/未知的條件/);
    expect(() => evalCondition({}, st())).toThrow();
    expect(() => evalCondition(null, st())).toThrow();
    expect(() => evalCondition('flag', st())).toThrow();
    expect(() => evalCondition({ flag: 'a', item: 'b' }, st())).toThrow(/一個/);
    expect(() => evalCondition({ echo_gte: '1' }, st())).toThrow();
    expect(() => evalCondition({ all: {} }, st())).toThrow();
    expect(() => evalCondition({ any: [{ bogus: 1 }] }, st())).toThrow();
  });
  it('巢狀內的未知寫法即使短路也要丟錯', () => {
    expect(() => evalCondition({ any: [{ flag: 'door_open' }, { bogus: 1 }] }, st())).toThrow();
  });
});

describe('checkCondition（靜態檢查，給 validate 用）', () => {
  it('合法寫法回傳空陣列', () => {
    expect(checkCondition({ all: [{ flag: 'a' }, { not: { item: 'b' } }, { rank_lte: 8 }] })).toEqual([]);
  });
  it('不合法寫法回傳錯誤訊息', () => {
    expect(checkCondition({ bogus: 1 }).length).toBe(1);
    expect(checkCondition({ flag: '' }).length).toBe(1);
    expect(checkCondition({ not: [] }).length).toBe(1);
    expect(checkCondition({ any: [{ flag: 'a' }, { x: 1 }] }).length).toBe(1);
  });
});
