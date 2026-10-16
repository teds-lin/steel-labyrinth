import { describe, it, expect } from 'vitest';
import { DEFAULT_NAME, MAX_NAME_LENGTH, sanitizeName, nameLength, fill } from '../../web/src/core/name.js';

describe('sanitizeName 主角名字清理', () => {
  it('預設名字是「雷恩・葛雷」，上限 8 字', () => {
    expect(DEFAULT_NAME).toBe('雷恩・葛雷');
    expect(MAX_NAME_LENGTH).toBe(8);
  });
  it('空字串、全空白、非字串都回預設', () => {
    expect(sanitizeName('')).toBe(DEFAULT_NAME);
    expect(sanitizeName('   ')).toBe(DEFAULT_NAME);
    expect(sanitizeName('　\t')).toBe(DEFAULT_NAME);
    expect(sanitizeName(undefined)).toBe(DEFAULT_NAME);
    expect(sanitizeName(null)).toBe(DEFAULT_NAME);
    expect(sanitizeName(42)).toBe(DEFAULT_NAME);
  });
  it('去除頭尾空白', () => {
    expect(sanitizeName('  艾琳  ')).toBe('艾琳');
  });
  it('移除控制字元與 < >', () => {
    expect(sanitizeName('艾\u0000琳\n')).toBe('艾琳');
    expect(sanitizeName('<b>阿明</b>')).toBe('b阿明/b');
    expect(sanitizeName('<<>>')).toBe(DEFAULT_NAME);
  });
  it('以字元計最多 8 個，超過截斷', () => {
    expect(sanitizeName('一二三四五六七八九十')).toBe('一二三四五六七八');
    expect(sanitizeName('abcdefgh')).toBe('abcdefgh');
  });
  it('emoji（含組合序列）算一個字元', () => {
    expect(nameLength('👍')).toBe(1);
    expect(nameLength('👨‍👩‍👧')).toBe(1);
    const name = '👨‍👩‍👧'.repeat(9);
    expect(sanitizeName(name)).toBe('👨‍👩‍👧'.repeat(8));
    expect(sanitizeName('🦊雷恩')).toBe('🦊雷恩');
  });
  it('截斷後若尾端是空白也要去掉', () => {
    expect(sanitizeName('一二三四五六七 八')).toBe('一二三四五六七');
  });
});

describe('fill 名字代入', () => {
  const state = { player: { name: '艾琳' } };
  it('代入所有 {name}', () => {
    expect(fill('{name}說：「{name}在此。」', state)).toBe('艾琳說：「艾琳在此。」');
  });
  it('null／undefined 原樣回傳（旁白 speaker）', () => {
    expect(fill(null, state)).toBeNull();
    expect(fill(undefined, state)).toBeUndefined();
  });
  it('沒有名字時用預設名字', () => {
    expect(fill('{name}', {})).toBe(DEFAULT_NAME);
  });
  it('名字裡的 $ 不會被當成替換樣式', () => {
    expect(fill('{name}', { player: { name: '$&$1' } })).toBe('$&$1');
  });
});
