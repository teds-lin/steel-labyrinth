// 循環長度量測（tools/lib/audio-loop.mjs）：渲染器的時間量化會讓第 2 次重複比理論位置晚幾個取樣點，要量出實際週期。
import { describe, it, expect } from 'vitest';
import { findPeriod } from '../../tools/lib/audio-loop.mjs';

function signal(n, period, seed = 1) {
  // 週期性的「音樂」：一段隨機雜訊重複
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const base = Float32Array.from({ length: period }, rnd);
  return Float32Array.from({ length: n }, (_, i) => base[i % period]);
}

describe('findPeriod', () => {
  it('在預期值附近找到實際週期（取樣點精度）', () => {
    const x = signal(30000, 10007);
    expect(findPeriod(x, { expected: 10000, search: 20, window: 2000, at: 1000 })).toEqual({ period: 10007, score: expect.any(Number) });
    expect(findPeriod(x, { expected: 10000, search: 20, window: 2000, at: 1000 }).score).toBeGreaterThan(0.999);
  });
  it('剛好等於預期值時回傳預期值', () => {
    const x = signal(30000, 10000, 7);
    expect(findPeriod(x, { expected: 10000, search: 5, window: 1000, at: 500 }).period).toBe(10000);
  });
  it('資料不夠長時丟錯', () => {
    expect(() => findPeriod(new Float32Array(100), { expected: 90, search: 20, window: 50, at: 0 })).toThrow();
  });
});
