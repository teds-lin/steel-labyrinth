// 入夢與醒來的鐘聲：程序合成（不下載音檔），經 AudioDirector 播放（audio/synth.js 的 bellSynth）。
// M6 起受全部靜音與音效音量控制；?test=1 是 NullBackend，不出聲（只記錄 sfx_bell）。呼叫時機不變。
import { audio } from '../audio/index.js';

export function playBell({ muted = false } = {}) {
  if (muted) return;
  audio.sfx('sfx_bell');
}
