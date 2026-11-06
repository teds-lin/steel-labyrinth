// AudioDirector：遊戲唯一的聲音入口（同 session 的單例模式）。不碰 Phaser／DOM，後端由 attach 注入：
//   backend-webaudio.js（瀏覽器，共用 Phaser 的 AudioContext）或 backend-null.js（?test=1：不出聲、不抓檔，只記錄）。
// 原則：每個公開方法都不丟例外；cue 不存在、載入或播放失敗 → console.warn 一次、該 cue 之後保持安靜。
import { loadAudioSettings, saveAudioSettings, parseAudioSettings, levelGain, channelGain, toggleSetting } from './settings.js';
import { validateCatalog } from './catalog.js';
import { pickMusic } from './pick.js';

const LAST_MAX = 200;
/** 同時發聲上限：BURST_MS 內最多 BURST_MAX 個音效開始播放，超過的略過（一個 frame 湧入多個事件、或快轉時不爆音）。 */
const BURST_MAX = 3;
const BURST_MS = 30;
/** info().requests 保留的筆數（E2E 比對整場戰鬥的完整序列）。 */
const REQ_MAX = 400;
/** 同一個 cue 兩次播放的最小間隔（毫秒）：連按或事件重複時不疊成一團。 */
const MIN_GAP_MS = 40;
/** 單調遞增的時鐘（不受系統時間調整影響）；沒有 performance 時退回 Date.now。 */
const defaultNow = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
/** 走「對話打字音」通道的 cue（可單獨關閉）。 */
const TYPING_CUES = new Set(['text_tick']);
/** 換曲時間（秒）：計畫 §3.4。 */
const FADE = Object.freeze({ bgmOut: 0.6, bgmIn: 0.8, amb: 1, battleOut: 0.3, battleIn: 0.3, duck: 0.5, unduck: 1 });
/** 戰鬥中環境音壓低到的比例。 */
const BATTLE_DUCK = 0.3;
const MUSIC_LOG_MAX = 100;
const SCATTER_LOG_MAX = 50;
const defaultTimers = Object.freeze({
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id),
});

export class AudioDirector {
  constructor({ storage = null, now = defaultNow, timers = defaultTimers, rng = Math.random } = {}) {
    this.storage = storage;
    this.now = now;
    this.timers = timers;
    this.rng = rng;
    // 背景音樂與環境音（M6 P3）：sceneCtx＝最後一次畫面（解鎖、目錄載入前先記著）；music＝實際在播的
    this.sceneCtx = null;
    this.music = { bgm: null, amb: null, battle: false, paused: null };
    this.musicLog = [];
    this.scatterTimers = new Set();
    this.scatterGen = 0;
    this.scattered = [];
    this.hidden = false;
    this.lastAt = new Map();
    this.recent = []; // 最近開始播放的時間（同時發聲上限用）
    this.requests = []; // 每個「應該要響」的要求與結果：played／gap（同 cue 40 ms 內重複）／burst（同時發聲上限）
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
    this.applyMusic();
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
    this.applyMusic();
  }

  /** 第一次使用者手勢之後由後端呼叫。 */
  markUnlocked() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.maybePreload();
    this.applyMusic();
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
      if (t - (this.lastAt.get(id) ?? -Infinity) < MIN_GAP_MS) { this.logRequest(id, 'gap', t); return; }
      // 同時發聲上限：短樂句、存檔音（priority）不被擋；打字音（exempt）不被擋也不佔額度
      this.recent = this.recent.filter((x) => t - x < BURST_MS);
      if (cue.burst === undefined && this.recent.length >= BURST_MAX) { this.logRequest(id, 'burst', t); return; }
      if (cue.burst !== 'exempt') this.recent.push(t);
      this.lastAt.set(id, t);
      this.logRequest(id, 'played', t);
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

  logRequest(id, result, t) {
    this.requests.push({ id, result, t: Math.round(t) });
    if (this.requests.length > REQ_MAX) this.requests.splice(0, this.requests.length - REQ_MAX);
  }

  /** 遊戲事件（事件鍵，見 audio/events.js）：查目錄的 events 對應表；對應為 null 時刻意不發聲。未知的鍵 warn 一次。 */
  event(key) {
    try {
      if (key === null || key === undefined || !this.catalog) return;
      const table = this.catalog.events;
      if (!table || typeof table !== 'object') { this.warnOnce('events-missing', '音訊目錄沒有事件對應表（events），事件音效保持安靜'); return; }
      if (!Object.hasOwn(table, key)) { this.warnOnce(`event:${key}`, `音效對應表沒有事件「${key}」`); return; }
      const cue = table[key];
      if (cue !== null) this.sfx(cue);
    } catch (e) {
      this.warnOnce(`event-error:${key}`, `事件音效「${key}」出錯`, e);
    }
  }

  // ── 背景音樂與環境音（M6 P3） ──

  /**
   * 畫面切換（audio/index.js 依 session.scene 與目前地圖／遭遇／結局組出 ctx）。選曲規則在 audio/pick.js。
   * 解鎖前、目錄載入前只記下最後一次的畫面，之後才播。
   */
  setScene(ctx) {
    // 「不換曲」的畫面（選單、Boot）不覆寫：解鎖或目錄載入剛好發生在選單開著時，仍播得出上一個畫面的曲子
    try { if (pickMusic(ctx, this.catalog ?? {}) === null) return; } catch { return; }
    this.sceneCtx = ctx ?? null;
    this.applyMusic();
  }

  /** 分頁隱藏／回來（同時轉給後端暫停／恢復 context）。隱藏時隨機單次音到時間也不響。 */
  setHidden(v) {
    this.hidden = !!v;
    try { this.backend?.setHidden?.(this.hidden); } catch (e) { this.warnOnce('hidden', '無法暫停／恢復聲音', e); }
  }

  /** 目錄裡找得到、種類也對的 cue id；否則 warn 一次並當作安靜。 */
  resolveCue(id, kind) {
    if (id === null || id === undefined) return null;
    const c = this.catalog?.cues?.[id];
    if (!c || c.kind !== kind) { this.warnOnce(`cue:${id}`, `找不到${kind === 'bgm' ? '背景音樂' : '環境音'}「${id}」，保持安靜`); return null; }
    return id;
  }

  /** 呼叫後端的循環播放方法；後端沒有該方法（舊後端）或丟錯時 warn，不外漏。 */
  loopCall(name, ...args) {
    const fn = this.backend?.[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(this.backend, args); } catch (e) { this.warnOnce(`loop:${name}:${args[1] ?? args[0]}`, `背景聲音播放失敗（${name}）`, e); return undefined; }
  }

  applyMusic() {
    try {
      if (!this.backend || !this.catalog || !this.unlocked || !this.sceneCtx) return;
      const pick = pickMusic(this.sceneCtx, this.catalog);
      if (!pick) return;
      const cur = this.music;
      const nb = this.resolveCue(pick.bgm, 'bgm');
      const na = pick.amb === undefined ? cur.amb : this.resolveCue(pick.amb, 'amb');
      const battle = pick.battle === true;
      let paused = cur.paused;
      if (battle && !cur.battle) {
        // 進戰鬥：地圖曲暫停並記住位置、戰鬥曲從頭、環境音壓低
        paused = null;
        if (cur.bgm) {
          const offset = this.loopCall('pauseLoop', 'bgm', { fadeOut: FADE.battleOut });
          paused = { id: cur.bgm, offset: typeof offset === 'number' && Number.isFinite(offset) ? offset : 0 };
        }
        if (nb) this.loopCall('playLoop', 'bgm', nb, { fadeIn: FADE.battleIn, offset: 0 });
      } else if (!battle && cur.battle) {
        // 離開戰鬥：停戰鬥曲；要回的曲子正是暫停的那首就從原位置接回，否則從頭
        if (cur.bgm) this.loopCall('stopLoop', 'bgm', { fadeOut: FADE.bgmOut });
        if (nb) this.loopCall('playLoop', 'bgm', nb, { fadeIn: FADE.bgmIn, offset: paused && paused.id === nb ? paused.offset : 0 });
        // 暫停的地圖曲不接回了（Game Over、換到別首）：讓後端不再為它保留記憶體
        if (paused && paused.id !== nb) this.loopCall('clearPaused', 'bgm');
        paused = null;
      } else if (nb !== cur.bgm) {
        if (cur.bgm) this.loopCall('stopLoop', 'bgm', { fadeOut: FADE.bgmOut });
        if (nb) this.loopCall('playLoop', 'bgm', nb, { fadeIn: FADE.bgmIn, offset: 0 });
      }
      if (na !== cur.amb) {
        if (cur.amb) this.loopCall('stopLoop', 'amb', { fadeOut: FADE.amb });
        if (na) this.loopCall('playLoop', 'amb', na, { fadeIn: FADE.amb, offset: 0 });
      }
      if (battle && !cur.battle) this.loopCall('duck', 'amb', BATTLE_DUCK, { ramp: FADE.duck });
      else if (!battle && cur.battle) this.loopCall('duck', 'amb', 1, { ramp: FADE.unduck });
      const changed = nb !== cur.bgm || na !== cur.amb || battle !== cur.battle;
      const rescatter = na !== cur.amb || battle !== cur.battle;
      this.music = { bgm: nb, amb: na, battle, paused };
      if (changed) {
        this.musicLog.push({ bgm: nb, amb: na, battle, t: Math.round(this.now()) });
        if (this.musicLog.length > MUSIC_LOG_MAX) this.musicLog.splice(0, this.musicLog.length - MUSIC_LOG_MAX);
      }
      if (rescatter) this.rescheduleScatter();
    } catch (e) {
      this.warnOnce('music', '背景聲音切換出錯', e);
    }
  }

  /** 隨機單次音：取消舊排程；環境音有 scatter 且不在戰鬥中時，每項各排一次（響完再排下一次）。 */
  rescheduleScatter() {
    for (const id of this.scatterTimers) { try { this.timers.clear(id); } catch { /* 已取消 */ } }
    this.scatterTimers.clear();
    const gen = ++this.scatterGen;
    const { amb, battle } = this.music;
    if (!amb || battle) return;
    const list = this.catalog?.cues?.[amb]?.scatter;
    if (!Array.isArray(list)) return;
    for (const sc of list) this.scheduleScatter(sc, gen);
  }

  scheduleScatter(sc, gen) {
    const [lo, hi] = sc.every;
    const ms = (lo + this.rng() * (hi - lo)) * 1000;
    let tid = null;
    tid = this.timers.set(() => {
      this.scatterTimers.delete(tid);
      if (gen !== this.scatterGen) return;
      try {
        const running = typeof this.backend?.isRunning === 'function' ? this.backend.isRunning() : true;
        if (!this.hidden && running && channelGain('amb', this.state) > 0) this.playScatter(sc.cue);
      } catch (e) {
        this.warnOnce(`scatter:${sc.cue}`, `單次音「${sc.cue}」播放失敗`, e);
      }
      this.scheduleScatter(sc, gen);
    }, ms);
    this.scatterTimers.add(tid);
  }

  playScatter(id) {
    const cue = this.catalog?.cues?.[id];
    if (!cue || this.broken.has(id)) return;
    const vol = typeof cue.volume === 'number' ? cue.volume : 1;
    if (cue.synth) this.backend.playSynth(cue.synth, vol, 'amb');
    else this.backend.playSfx(id, vol, 'amb');
    this.scattered.push(id);
    if (this.scattered.length > SCATTER_LOG_MAX) this.scattered.splice(0, this.scattered.length - SCATTER_LOG_MAX);
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
      requests: this.requests.map((r) => ({ ...r })),
      hint: this.hint,
      broken: [...this.broken],
      bgm: this.music.bgm,
      amb: this.music.amb,
      battle: this.music.battle,
      paused: this.music.paused ? { ...this.music.paused } : null,
      music: this.musicLog.map((m) => ({ ...m })),
      scatter: [...this.scattered],
    };
  }
}
