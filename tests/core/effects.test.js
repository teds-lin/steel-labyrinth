import { describe, it, expect } from 'vitest';
import { applyEffect, applyEffects, checkEffect } from '../../web/src/core/effects.js';

const base = () => ({
  flags: { a: true }, items: { key: 1 }, echo: { charges: 1 }, collapse: 0,
  resonance: {}, chapter: 'prologue', chapter_done: [],
});
const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };

describe('applyEffect', () => {
  it('不原地修改輸入（凍結物件也能用）', () => {
    const s = deepFreeze(base());
    const n = applyEffect({ set_flag: 'b' }, s);
    expect(n).not.toBe(s);
    expect(n.flags).toEqual({ a: true, b: true });
    expect(s.flags).toEqual({ a: true });
  });
  it('set_flag／clear_flag', () => {
    expect(applyEffect({ clear_flag: 'a' }, base()).flags).toEqual({});
    expect(applyEffect({ clear_flag: 'zzz' }, base()).flags).toEqual({ a: true });
  });
  it('give_item 累加、take_item 減到 0 就移除，沒有時不變', () => {
    const s1 = applyEffect({ give_item: 'key' }, base());
    expect(s1.items.key).toBe(2);
    expect(applyEffect({ give_item: 'gem' }, base()).items.gem).toBe(1);
    const s2 = applyEffect({ take_item: 'key' }, base());
    expect(s2.items).toEqual({});
    expect(applyEffect({ take_item: 'none' }, base()).items).toEqual({ key: 1 });
  });
  it('resonance 累加計數', () => {
    const s = applyEffect({ resonance: 'lie' }, applyEffect({ resonance: 'lie' }, base()));
    expect(s.resonance).toEqual({ lie: 2 });
  });
  it('collapse 增減並夾在 0～100', () => {
    expect(applyEffect({ collapse: 5 }, base()).collapse).toBe(5);
    expect(applyEffect({ collapse: -5 }, base()).collapse).toBe(0);
    expect(applyEffect({ collapse: 500 }, base()).collapse).toBe(100);
  });
  it('use_echo 扣 1 次並崩解 +5；0 次時丟錯', () => {
    const s = applyEffect({ use_echo: true }, base());
    expect(s.echo.charges).toBe(0);
    expect(s.collapse).toBe(5);
    expect(() => applyEffect({ use_echo: true }, s)).toThrow(/殘響/);
  });
  it('chapter_end 記入 chapter_done 且不重複', () => {
    const s = applyEffect({ chapter_end: 'prologue' }, base());
    expect(s.chapter_done).toEqual(['prologue']);
    expect(applyEffect({ chapter_end: 'prologue' }, s).chapter_done).toEqual(['prologue']);
  });
  it('未知或不合法寫法丟錯', () => {
    expect(() => applyEffect({ teleport: 'x' }, base())).toThrow(/未知的效果/);
    expect(() => applyEffect({}, base())).toThrow();
    expect(() => applyEffect(null, base())).toThrow();
    expect(() => applyEffect({ set_flag: 'a', give_item: 'b' }, base())).toThrow();
    expect(() => applyEffect({ use_echo: false }, base())).toThrow();
    expect(() => applyEffect({ collapse: '5' }, base())).toThrow();
    expect(() => applyEffect({ give_item: '' }, base())).toThrow();
  });
  it('applyEffects 依序套用；undefined 視為沒有效果', () => {
    const s = applyEffects([{ set_flag: 'x' }, { give_item: 'g' }], base());
    expect(s.flags.x).toBe(true);
    expect(s.items.g).toBe(1);
    const b = base();
    expect(applyEffects(undefined, b)).toEqual(b);
    expect(() => applyEffects({ set_flag: 'x' }, b)).toThrow();
  });
});

describe('checkEffect', () => {
  it('合法回空、不合法回錯誤', () => {
    expect(checkEffect({ use_echo: true })).toEqual([]);
    expect(checkEffect({ bogus: 1 }).length).toBe(1);
  });
});
