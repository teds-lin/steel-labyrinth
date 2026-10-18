// HUD（web/src/ui/hud.js）M5：目前階位名稱、共鳴 有／下一階需要。
import { describe, it, expect } from 'vitest';
import { loadDir, M5_FIXTURE_DIR } from './load-fixture.js';
import { rankHud, resonanceHud } from '../../web/src/ui/hud.js';

const data = loadDir(M5_FIXTURE_DIR);

describe('rankHud', () => {
  it('目前階位名稱', () => {
    expect(rankHud({ lineage: { id: 'trace', rank: 8 } }, data)).toEqual({ text: '借聲者', rank: 8 });
  });
  it('沒有譜系或資料不認得 → null（不丟錯）', () => {
    expect(rankHud({ lineage: null }, data)).toBeNull();
    expect(rankHud({ lineage: { id: 'trace', rank: 3 } }, data)).toBeNull();
    expect(rankHud(null, data)).toBeNull();
  });
});

describe('resonanceHud（M5：有下一階時顯示門檻）', () => {
  it('有門檻：「共鳴 5/12」', () => {
    expect(resonanceHud({ a: 3, b: 2 }, 12).text).toBe('共鳴 5/12');
  });
  it('沒有門檻：照舊只顯示合計', () => {
    expect(resonanceHud({ a: 3 }).text).toBe('共鳴 3');
    expect(resonanceHud({ a: 3 }, 0).text).toBe('共鳴 3');
  });
});
