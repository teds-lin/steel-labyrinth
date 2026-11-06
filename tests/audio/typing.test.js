// 對話送字音（M6）：每 3 個字響一次，空白與標點不算、不響。
import { describe, it, expect } from 'vitest';
import { createTypingTicker, isTickChar } from '../../web/src/audio/typing.js';

const run = (text, every) => {
  const t = createTypingTicker(every === undefined ? undefined : { every });
  return Array.from(text).map((ch) => (t(ch) ? 1 : 0)).join('');
};

describe('isTickChar', () => {
  it('中文、英數算；空白、全形空白、換行、中英文標點不算', () => {
    for (const ch of ['霧', 'A', '7', 'あ']) expect(isTickChar(ch), ch).toBe(true);
    for (const ch of [' ', '　', '\n', '，', '。', '「', '」', '…', '——'.at(0), '！', '？', '、', '.', ',', '!', '?', '～', '（', '）', '：', '；', '『', '』']) {
      expect(isTickChar(ch), JSON.stringify(ch)).toBe(false);
    }
  });
});

describe('createTypingTicker', () => {
  it('每 3 個「算數的字」響一次：第 1 個字就響，之後每 3 個', () => {
    expect(run('一二三四五六七')).toBe('1001001');
  });
  it('標點與空白不響、也不計數', () => {
    expect(run('一，二。三　四')).toBe('1000001');
  });
  it('every 可調整（1＝每個字都響）', () => {
    expect(run('一二三', 1)).toBe('111');
  });
  it('每個 ticker 各自計數（換一句就重來）', () => {
    const a = createTypingTicker();
    expect([a('一'), a('二')]).toEqual([true, false]);
    const b = createTypingTicker();
    expect(b('三')).toBe(true);
  });
});
