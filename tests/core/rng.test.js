import { describe, it, expect } from 'vitest';
import { createRng, nextFloat, nextInt, chance, isRngState } from '../../web/src/core/rng.js';

describe('rng（種子化 PRNG，狀態是純資料、API 不可變）', () => {
  it('同種子同序列；不同種子不同序列', () => {
    const seq = (seed, n) => {
      let r = createRng(seed);
      const out = [];
      for (let i = 0; i < n; i++) { const [v, nx] = nextFloat(r); out.push(v); r = nx; }
      return out;
    };
    expect(seq(42, 20)).toEqual(seq(42, 20));
    expect(seq(42, 20)).not.toEqual(seq(43, 20));
  });
  it('不修改輸入狀態；狀態可以 JSON 來回轉換', () => {
    const r = createRng(7);
    const before = JSON.stringify(r);
    const [a, r2] = nextFloat(r);
    expect(JSON.stringify(r)).toBe(before);
    const [b] = nextFloat(JSON.parse(JSON.stringify(r)));
    expect(b).toBe(a);
    expect(isRngState(r2)).toBe(true);
    expect(isRngState({ s: 'x' })).toBe(false);
  });
  it('值域 [0,1)，分布大致均勻', () => {
    let r = createRng(123);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) {
      const [v, nx] = nextFloat(r);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)] += 1;
      r = nx;
    }
    for (const b of buckets) { expect(b).toBeGreaterThan(850); expect(b).toBeLessThan(1150); }
  });
  it('nextInt 在 [lo, hi] 之間；chance 依百分比', () => {
    let r = createRng(9);
    const seen = new Set();
    for (let i = 0; i < 500; i++) { const [v, nx] = nextInt(r, 1, 3); seen.add(v); r = nx; }
    expect([...seen].sort()).toEqual([1, 2, 3]);
    let hits = 0;
    r = createRng(5);
    for (let i = 0; i < 2000; i++) { const [v, nx] = chance(r, 30); if (v) hits++; r = nx; }
    expect(hits).toBeGreaterThan(500);
    expect(hits).toBeLessThan(700);
    expect(chance(createRng(1), 0)[0]).toBe(false);
    expect(chance(createRng(1), 100)[0]).toBe(true);
  });
  it('種子必須是有限數字；壞狀態丟錯', () => {
    expect(() => createRng('a')).toThrow(/種子/);
    expect(() => createRng(NaN)).toThrow(/種子/);
    expect(() => nextFloat({})).toThrow(/亂數狀態/);
  });
});
