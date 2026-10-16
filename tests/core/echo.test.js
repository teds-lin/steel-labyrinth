import { describe, it, expect } from 'vitest';
import { ECHO_TAG, ECHO_COLLAPSE_COST, echoCharges, hasEcho, spendEcho, clampCollapse } from '../../web/src/core/echo.js';

describe('殘響小工具', () => {
  const s = { echo: { charges: 2 }, collapse: 10, flags: {} };
  it('常數：標籤 trace、崩解 +5', () => {
    expect(ECHO_TAG).toBe('trace');
    expect(ECHO_COLLAPSE_COST).toBe(5);
  });
  it('echoCharges／hasEcho', () => {
    expect(echoCharges(s)).toBe(2);
    expect(hasEcho(s)).toBe(true);
    expect(hasEcho({ echo: { charges: 0 } })).toBe(false);
    expect(echoCharges({})).toBe(0);
  });
  it('spendEcho 扣 1 次、崩解 +5，不改動輸入', () => {
    const n = spendEcho(s);
    expect(n.echo.charges).toBe(1);
    expect(n.collapse).toBe(15);
    expect(s.echo.charges).toBe(2);
    expect(s.collapse).toBe(10);
  });
  it('spendEcho 崩解夾在 100', () => {
    expect(spendEcho({ echo: { charges: 1 }, collapse: 98 }).collapse).toBe(100);
  });
  it('次數為 0 時丟錯', () => {
    expect(() => spendEcho({ echo: { charges: 0 }, collapse: 0 })).toThrow(/殘響/);
  });
  it('clampCollapse', () => {
    expect(clampCollapse(-3)).toBe(0);
    expect(clampCollapse(150)).toBe(100);
    expect(clampCollapse(42)).toBe(42);
  });
});
