// 戰鬥指令區的提示文字：不能逃跑的戰鬥（Boss 等）要明講，免得玩家以為「逃跑」鍵不見了。
import { describe, it, expect } from 'vitest';
import { commandPrompt } from '../../web/src/battle-view.js';

describe('commandPrompt', () => {
  it('可以逃跑的戰鬥只問要怎麼做', () => {
    expect(commandPrompt('艾妲・費恩', true)).toBe('艾妲・費恩要怎麼做？');
  });
  it('不能逃跑的戰鬥加註（無法逃跑）', () => {
    expect(commandPrompt('艾妲・費恩', false)).toBe('艾妲・費恩要怎麼做？（無法逃跑）');
  });
  it('沒有指令資訊時當作不能逃跑以外的一般情況，不加註', () => {
    expect(commandPrompt('雷恩', undefined)).toBe('雷恩要怎麼做？');
  });
});
