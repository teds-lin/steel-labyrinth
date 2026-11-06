// 程序合成音（不下載音檔）。原本在 ui/bell.js 自己開 AudioContext；M6 起改接 AudioDirector 的音效匯流排，受靜音與音量控制。

/**
 * 入夢與醒來的鐘聲：196 Hz 基音加上鐘的泛音（大致比例），3.2 秒衰減。dest：要接上的節點（音效匯流排）。
 * 回傳最後停止的 oscillator，呼叫端在它的 onended 回收節點。
 */
export function bellSynth(ctx, dest, t0 = ctx.currentTime + 0.02) {
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.2);
  out.connect(dest);
  let last = null;
  for (const [ratio, amp] of [[1, 1], [2.0, 0.5], [2.76, 0.35], [5.4, 0.15]]) {
    const o = ctx.createOscillator();
    last = o;
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 196 * ratio;
    g.gain.value = amp;
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + 3.3);
  }
  return last;
}

export const SYNTH_FNS = { bell: bellSynth };
