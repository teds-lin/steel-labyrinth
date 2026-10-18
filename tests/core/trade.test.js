// M5 交換（鐘塔之夢）：open_trade 效果、availableTrades、applyTrade、tradeFlag。
import { describe, it, expect } from 'vitest';
import { applyEffect, checkEffect } from '../../web/src/core/effects.js';
import { availableTrades, applyTrade, tradeFlag, findTrade } from '../../web/src/core/trade.js';

const data = () => ({
  items: [{ id: 'sedative', name: '鎮靜香' }, { id: 'echo_moss', name: '回聲苔' }, { id: 'bandage', name: '繃帶' }, { id: 'wax', name: '唱詩蠟' }],
  story: [
    { id: 'chapter3', guests: [{ id: 'three', name: '三點', scripted: {} }] },
    { id: 'chapter6', guests: [{ id: 'nine', name: '九點', scripted: {}, trades: [
      { id: 'nine_moss', label: '兩包鎮靜香換一份回聲苔', give: [{ item: 'sedative', count: 2 }], get: [{ item: 'echo_moss', count: 1 }], if: { flag: 'ch4_started' } },
      { id: 'nine_wax', label: '一份回聲苔換唱詩蠟與繃帶', give: [{ item: 'echo_moss', count: 1 }], get: [{ item: 'wax', count: 1 }, { item: 'bandage', count: 2 }], once: true },
      { id: 'nine_late', label: '晚一點才開放', give: [{ item: 'bandage', count: 1 }], get: [{ item: 'sedative', count: 1 }], if: { flag: 'ch6_started' } },
    ] }] },
  ],
});
const base = (over = {}) => ({ flags: { ch4_started: true }, items: { sedative: 3, echo_moss: 1 }, pending: null, ...over });

describe('open_trade 效果', () => {
  it('寫法：非空字串；寫進 pending', () => {
    expect(checkEffect({ open_trade: 'nine' })).toEqual([]);
    expect(checkEffect({ open_trade: '' }).length).toBeGreaterThan(0);
    expect(checkEffect({ open_trade: true }).length).toBeGreaterThan(0);
    expect(applyEffect({ open_trade: 'nine' }, base()).pending).toEqual([{ type: 'open_trade', guest: 'nine' }]);
  });
});

describe('availableTrades(guestId, state, data)', () => {
  it('只列出 if 成立、而且還沒做過的 once 交換；帶持有數量與是否付得起', () => {
    expect(availableTrades('nine', base(), data())).toEqual([
      { id: 'nine_moss', guest: 'nine', label: '兩包鎮靜香換一份回聲苔',
        give: [{ item: 'sedative', name: '鎮靜香', count: 2, have: 3 }], get: [{ item: 'echo_moss', name: '回聲苔', count: 1 }], once: false, affordable: true },
      { id: 'nine_wax', guest: 'nine', label: '一份回聲苔換唱詩蠟與繃帶',
        give: [{ item: 'echo_moss', name: '回聲苔', count: 1, have: 1 }], get: [{ item: 'wax', name: '唱詩蠟', count: 1 }, { item: 'bandage', name: '繃帶', count: 2 }], once: true, affordable: true },
    ]);
  });

  it('付不起的照樣列出（affordable false），畫面可以顯示「材料不足」', () => {
    const list = availableTrades('nine', base({ items: { sedative: 1 } }), data());
    expect(list.map((t) => [t.id, t.affordable])).toEqual([['nine_moss', false], ['nine_wax', false]]);
  });

  it('once 做過之後不再列出；交換表依章節開放（if）', () => {
    const s = base({ flags: { ch4_started: true, ch6_started: true, [tradeFlag('nine', 'nine_wax')]: true } });
    expect(availableTrades('nine', s, data()).map((t) => t.id)).toEqual(['nine_moss', 'nine_late']);
    expect(availableTrades('nine', base({ flags: {} }), data()).map((t) => t.id)).toEqual(['nine_wax']);
  });

  it('沒有 trades 的夢客、找不到的夢客 → 空陣列', () => {
    expect(availableTrades('three', base(), data())).toEqual([]);
    expect(availableTrades('ghost', base(), data())).toEqual([]);
  });
});

describe('applyTrade(tradeId, state, data)', () => {
  it('扣掉 give、加上 get，不修改輸入', () => {
    const s0 = base();
    const s = applyTrade('nine_moss', s0, data());
    expect(s.items).toEqual({ sedative: 1, echo_moss: 2 });
    expect(s0.items).toEqual({ sedative: 3, echo_moss: 1 });
    expect(s.flags).toEqual(s0.flags); // once false：不記旗標
  });

  it('數量剛好用完時刪掉該道具的鍵', () => {
    const s = applyTrade('nine_wax', base(), data());
    expect(s.items).toEqual({ sedative: 3, wax: 1, bandage: 2 });
    expect(s.flags[tradeFlag('nine', 'nine_wax')]).toBe(true);
    expect(tradeFlag('nine', 'nine_wax')).toBe('trade:nine:nine_wax');
  });

  it('once 做過一次之後再做 → 丟錯', () => {
    const s = applyTrade('nine_wax', base({ items: { echo_moss: 2 } }), data());
    expect(() => applyTrade('nine_wax', s, data())).toThrow(/已經交換過/);
  });

  it('材料不足 → 丟出明確錯誤（列出缺什麼），state 不變', () => {
    expect(() => applyTrade('nine_moss', base({ items: { sedative: 1 } }), data())).toThrow(/材料不足.*鎮靜香.*1.*2/);
  });

  it('if 不成立（尚未開放）→ 丟錯', () => {
    expect(() => applyTrade('nine_late', base({ items: { bandage: 1 } }), data())).toThrow(/尚未開放/);
  });

  it('找不到交換 → 丟錯；可以指定夢客', () => {
    expect(() => applyTrade('nope', base(), data())).toThrow(/找不到交換/);
    expect(() => applyTrade('nine_moss', base(), data(), 'three')).toThrow(/找不到交換/);
    expect(applyTrade('nine_moss', base(), data(), 'nine').items.echo_moss).toBe(2);
  });

  it('findTrade 回傳 { guest, trade }', () => {
    expect(findTrade('nine_wax', data())).toMatchObject({ guest: { id: 'nine' }, trade: { id: 'nine_wax' } });
    expect(findTrade('nope', data())).toBeNull();
  });
});
