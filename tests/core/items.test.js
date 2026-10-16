import { describe, it, expect } from 'vitest';
import { fieldItems, useFieldItem } from '../../web/src/core/items.js';
import { battleData, battleState } from './battle/fixture.js';

const data = battleData();

describe('地圖選單中使用道具（field_effects）', () => {
  it('fieldItems：只列出持有且有 field_effects 的道具', () => {
    const s = battleState({ items: { incense: 2, bandage: 1, revolver: 1 } });
    expect(fieldItems(s, data)).toEqual([{ id: 'incense', name: '鎮靜香', desc: '降低崩解。', count: 2 }]);
  });
  it('useFieldItem：套用對話效果並用掉 1 個；不修改輸入', () => {
    const s = battleState({ items: { incense: 1 }, collapse: 40 });
    const before = JSON.stringify(s);
    const r = useFieldItem('incense', s, data);
    expect(JSON.stringify(s)).toBe(before);
    expect(r.collapse).toBe(25);
    expect(r.items).toEqual({});
  });
  it('沒有持有、沒有 field_effects（劇情道具）、不存在 → 丟錯', () => {
    expect(() => useFieldItem('incense', battleState(), data)).toThrow(/沒有/);
    expect(() => useFieldItem('revolver', battleState({ items: { revolver: 1 } }), data)).toThrow(/不能/);
    expect(() => useFieldItem('ghost', battleState({ items: { ghost: 1 } }), data)).toThrow(/ghost/);
  });
});
