// AudioDirector：遊戲唯一的聲音入口（同 session 的單例模式）。不碰 Phaser／DOM，後端由 attach 注入：
//   backend-webaudio.js（瀏覽器，共用 Phaser 的 AudioContext）或 backend-null.js（?test=1：不出聲、不抓檔，只記錄）。
// 原則：每個公開方法都不丟例外；cue 不存在、載入或播放失敗 → console.warn 一次、該 cue 之後保持安靜。
import { loadAudioSettings, saveAudioSettings, parseAudioSettings, levelGain, channelGain, toggleSetting } from './settings.js';
import { validateCatalog } from './catalog.js';

const LAST_MAX = 30;
/** 同一個 cue 兩次播放的最小間隔（毫秒）：連按或事件重複時不疊成一團。 */
const MIN_GAP_MS = 40;
/** 單調遞增的時鐘（不受系統時間調整影響）；沒有 performance 時退回 Date.now。 */
const defaultNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
/** 走「對話打字音」通道的 cue（可單獨關閉）。 */
const TYPING_CUES = new Set(['text_tick']);

export class AudioDirector {
  constructor({ storage = null, now = defaultNow } = {}) {
    this.storage = storage;
    this.now = now;
    this.lastAt = new Map();
    this.state = loadAudioSettings(storage);
    this.backend = null;
    this.catalog = null;
    this.unlocked = false;
    this.preloaded = false;
    this.broken = new Set();
    this.warned = new Set();
    this.last = [];
    this.hint = null;
    this.saved = null;
    this.listeners = new Set();
  }

  get settings() { return { ...this.state }; }

  warnOnce(key, msg, err) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try { console.warn(msg, err ?? ''); } catch { /* console 不能用也不影響遊戲 */ }
  }

  attach(backend) {
    this.backend = backend ?? null;
    this.applyGains();
    this.maybePreload();
  }

  setCatalog(cat) {
    const v = validateCatalog(cat);
    if (!v.ok) {
      this.catalog = null;
      this.warnOnce('catalog', `音訊目錄有誤，遊戲將保持安靜：${v.errors.slice(0, 3).join('；')}`);
      return;
    }
    this.catalog = cat;
    this.maybePreload();
  }

  /** 第一次使用者手勢之後由後端呼叫。 */
  markUnlocked() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.maybePreload();
  }

  maybePreload() {
    if (this.preloaded || !this.unlocked || !this.catalog || !this.backend) return;
    this.preloaded = true;
    const ids = Object.entries(this.catalog.cues).filter(([, c]) => c.kind === 'sfx' && typeof c.src === 'string').map(([id]) => id);
    try { this.backend.preload?.(ids); } catch (e) { this.warnOnce('preload', '音效預載失敗，遊戲將保持安靜', e); }
  }

  gains() {
    const s = this.state;
    return { master: s.mute ? 0 : 1, bgm: levelGain(s.bgm), amb: levelGain(s.amb), sfx: levelGain(s.sfx) };
  }

  applyGains() {
    try { this.backend?.applyGains?.(this.gains()); } catch (e) { this.warnOnce('gains', '無法套用音量', e); }
  }

  setSettings(next) {
    this.state = parseAudioSettings({ ...next, v: 1 });
    this.saved = saveAudioSettings(this.storage, this.state);
    this.applyGains();
    for (const fn of [...this.listeners]) {
      try { fn(this.settings); } catch (e) { this.warnOnce('listener', '聲音設定監聽器出錯', e); }
    }
  }

  toggleMute() {
    this.setSettings(toggleSetting(this.state, 'mute'));
    return this.state.mute;
  }

  /** 設定變更通知；回傳取消訂閱的函式。 */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 後端回報某個 cue 載入失敗（404、解碼失敗）：warn 一次，之後不再播。 */
  reportBroken(id, err) {
    this.broken.add(id);
    this.warnOnce(`broken:${id}`, `音效「${id}」無法載入，之後保持安靜`, err?.message ?? err);
  }

  /** 播一個短音效（介面音、打字音、鐘聲等）。 */
  sfx(id) {
    try {
      if (!this.backend || !this.catalog || !this.unlocked) return;
      const cue = this.catalog.cues[id];
      if (!cue || cue.kind !== 'sfx') { this.warnOnce(`unknown:${id}`, `找不到音效「${id}」`); return; }
      if (this.broken.has(id)) return;
      const channel = TYPING_CUES.has(id) ? 'typing' : 'sfx';
      if (channelGain(channel, this.state) <= 0) return;
      const t = this.now();
      if (t - (this.lastAt.get(id) ?? -Infinity) < MIN_GAP_MS) return;
      this.lastAt.set(id, t);
      const vol = typeof cue.volume === 'number' ? cue.volume : 1;
      if (cue.synth) this.backend.playSynth(cue.synth, vol);
      else this.backend.playSfx(id, vol);
      this.last.push(id);
      if (this.last.length > LAST_MAX) this.last.splice(0, this.last.length - LAST_MAX);
    } catch (e) {
      this.broken.add(id);
      this.warnOnce(`play:${id}`, `音效「${id}」播放失敗，之後保持安靜`, e);
    }
  }

  /** M 鍵等提示文字（E2E 讀）。 */
  noteHint(text) { this.hint = text; }

  /** E2E 用的唯讀摘要（複本）。 */
  info() {
    return {
      backend: this.backend?.kind ?? null,
      unlocked: this.unlocked,
      catalog: !!this.catalog,
      settings: this.settings,
      saved: this.saved,
      lastSfx: [...this.last],
      hint: this.hint,
      broken: [...this.broken],
    };
  }
}
