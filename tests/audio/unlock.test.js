// 解鎖閘門（M6 修正 A-L-A）：必須「有過使用者手勢」且「Phaser 已解鎖（或本來就沒鎖）」才算解鎖。
// 瀏覽器允許自動播放時 context 一開始就是 running，也不能在手勢前下載音檔。
import { describe, it, expect } from 'vitest';
import { createUnlockGate } from '../../web/src/audio/unlock.js';

describe('createUnlockGate', () => {
  it('只有手勢、沒有 Phaser 解鎖 → 不解鎖', () => {
    let n = 0;
    const g = createUnlockGate(() => { n += 1; });
    g.gesture();
    expect(n).toBe(0);
    expect(g.unlocked).toBe(false);
  });
  it('Phaser 先 ready（允許自動播放）→ 仍要等手勢', () => {
    let n = 0;
    const g = createUnlockGate(() => { n += 1; });
    g.ready();
    expect(n).toBe(0);
    g.gesture();
    expect(n).toBe(1);
    expect(g.unlocked).toBe(true);
  });
  it('兩個條件都成立只觸發一次', () => {
    let n = 0;
    const g = createUnlockGate(() => { n += 1; });
    g.gesture(); g.ready(); g.gesture(); g.ready();
    expect(n).toBe(1);
  });
});

// 手勢解鎖器（M6 Round 2 修正 5）：每次手勢在 context 不是 running 時自己呼叫 resume()（錯誤接住），
// 變成 running 才算 ready；解鎖後才移除監聽。避免 resume 被拒絕一次就永遠不解鎖。
import { createGestureUnlocker } from '../../web/src/audio/unlock.js';

function fakeTarget() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(t, fn, cap) { handlers.set(t, { fn, cap }); },
    removeEventListener(t) { handlers.delete(t); },
    fire(t) { handlers.get(t)?.fn({ type: t }); },
  };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('createGestureUnlocker', () => {
  it('第一次手勢 resume 被拒絕 → 不解鎖、監聽還在；第二次手勢 resume 成功 → 解鎖並移除監聽', async () => {
    let tries = 0;
    const ctx = {
      state: 'suspended',
      resume() {
        tries += 1;
        if (tries === 1) return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
        this.state = 'running';
        return Promise.resolve();
      },
    };
    const target = fakeTarget();
    let unlocked = 0;
    createGestureUnlocker({ ctx, target, onUnlock: () => { unlocked += 1; } });
    expect([...target.handlers.keys()].sort()).toEqual(['keydown', 'mousedown', 'pointerdown', 'touchstart']);
    expect([...target.handlers.values()].every((h) => h.cap === true)).toBe(true);
    target.fire('pointerdown');
    await flush();
    expect(unlocked).toBe(0);
    expect(target.handlers.size).toBe(4);
    target.fire('keydown');
    await flush();
    expect(unlocked).toBe(1);
    expect(target.handlers.size).toBe(0);
  });
  it('resume 完成但 context 仍不是 running（例如 Esc 不算使用者啟動）→ 不解鎖', async () => {
    const ctx = { state: 'suspended', resume: () => Promise.resolve() };
    const target = fakeTarget();
    let unlocked = 0;
    createGestureUnlocker({ ctx, target, onUnlock: () => { unlocked += 1; } });
    target.fire('keydown');
    await flush();
    expect(unlocked).toBe(0);
  });
  it('context 一開始就 running（允許自動播放）→ 仍要等第一次手勢；手勢時不必 resume', async () => {
    const ctx = { state: 'running', resume: () => { throw new Error('不該呼叫'); } };
    const target = fakeTarget();
    let unlocked = 0;
    createGestureUnlocker({ ctx, target, onUnlock: () => { unlocked += 1; } });
    await flush();
    expect(unlocked).toBe(0);
    target.fire('mousedown');
    await flush();
    expect(unlocked).toBe(1);
  });
  it('resume 同步丟錯也接住', async () => {
    const ctx = { state: 'suspended', resume: () => { throw new Error('sync'); } };
    const target = fakeTarget();
    createGestureUnlocker({ ctx, target, onUnlock: () => {} });
    expect(() => target.fire('keydown')).not.toThrow();
    await flush();
  });
  it('沒有 context（NullBackend）：手勢即解鎖', async () => {
    const target = fakeTarget();
    let unlocked = 0;
    createGestureUnlocker({ ctx: null, target, onUnlock: () => { unlocked += 1; } });
    target.fire('touchstart');
    await flush();
    expect(unlocked).toBe(1);
    expect(target.handlers.size).toBe(0);
  });
});
