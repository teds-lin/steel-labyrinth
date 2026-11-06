// 解鎖閘門：必須「有過使用者手勢」且「Phaser 的 AudioContext 已解鎖（或本來就沒鎖）」才算解鎖。
// 瀏覽器允許自動播放時 context 一開始就是 running，仍然要等第一次手勢才開始下載與播放（不嚇到玩家、不浪費流量）。
export function createUnlockGate(onUnlock) {
  let gestured = false;
  let ready = false;
  let done = false;
  const check = () => {
    if (done || !gestured || !ready) return;
    done = true;
    onUnlock();
  };
  return {
    gesture() { gestured = true; check(); },
    ready() { ready = true; check(); },
    get unlocked() { return done; },
  };
}

const GESTURES = ['keydown', 'pointerdown', 'mousedown', 'touchstart'];

/**
 * 手勢解鎖器：在 target（window）上以 capture 監聽手勢。每次手勢：
 * - 記下「有過手勢」；
 * - context 不是 running 就自己呼叫 resume()（錯誤一律接住），resume 完成後 context 真的變成 running 才算 ready。
 * 兩者都成立才 onUnlock，然後才移除監聽。resume 被拒絕（例如沒有使用者啟動的 Esc）時監聽還在，下一次手勢再試，
 * 不會像 Phaser 自己的解鎖那樣被拒絕一次就放棄。ctx 為 null（NullBackend）：手勢即解鎖。
 */
export function createGestureUnlocker({ ctx, target, onUnlock }) {
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    for (const t of GESTURES) target.removeEventListener(t, onGesture, true);
  };
  const gate = createUnlockGate(() => { remove(); onUnlock(); });
  const markIfRunning = () => { if (!ctx || ctx.state === 'running') gate.ready(); };
  function onGesture() {
    gate.gesture();
    if (!ctx || ctx.state === 'running') { gate.ready(); return; }
    try {
      Promise.resolve(ctx.resume()).then(markIfRunning, () => { /* 這次不行，下一次手勢再試 */ });
    } catch { /* 同上 */ }
  }
  for (const t of GESTURES) target.addEventListener(t, onGesture, true);
  return { gate, remove };
}
