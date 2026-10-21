// 觸控面板第二顆能力鍵的名稱：還沒有譜系時是暫時的「殘響」；喝下靈劑後是譜系能力（trace 的顯示名稱，資料提供），
// 與 HUD 的「回溯 ∞」一致（玩家回饋：按鈕寫殘響、實際是回溯）。
import { describe, it, expect } from 'vitest';
import { abilityButtonLabel } from '../../web/src/ui/hud.js';

const data = { lineages: [{ id: 'trace', ranks: [{ rank: 9, field_labels: { trace: '回溯' } }, { rank: 8, field_labels: { voice: '借聲' } }] }] };

describe('abilityButtonLabel', () => {
  it('還沒有譜系（只有暫時的殘響）時顯示「殘響」', () => {
    expect(abilityButtonLabel({ free: false, charges: 3 }, data)).toBe('殘響');
    expect(abilityButtonLabel({ free: false, charges: 0 }, data)).toBe('殘響');
  });
  it('譜系提供 trace（免費）時顯示資料裡的名稱「回溯」', () => {
    expect(abilityButtonLabel({ free: true, charges: 0 }, data)).toBe('回溯');
  });
  it('資料沒有提供名稱時退回「回溯」', () => {
    expect(abilityButtonLabel({ free: true }, { lineages: [] })).toBe('回溯');
  });
  it('沒有資訊時當作殘響', () => {
    expect(abilityButtonLabel(undefined, data)).toBe('殘響');
  });
});
