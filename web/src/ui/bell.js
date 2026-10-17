// 入夢與醒來的鐘聲：用 Web Audio 合成（不下載音檔）。瀏覽器不支援或被擋時安靜略過。
let ctx = null;

export function playBell({ muted = false } = {}) {
  if (muted) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = ctx ?? new AC();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.02;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.2);
    out.connect(ctx.destination);
    // 鐘的泛音（大致比例）
    for (const [ratio, amp] of [[1, 1], [2.0, 0.5], [2.76, 0.35], [5.4, 0.15]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 196 * ratio;
      g.gain.value = amp;
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + 3.3);
    }
  } catch { /* 沒有音效也不影響遊戲 */ }
}
