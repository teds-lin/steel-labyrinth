// 瀏覽器後端：共用 Phaser 的 AudioContext（game.sound.context），不再另開一個。
// 節點圖：各 cue →（低通）→ 增益 → 通道匯流排（bgm／amb／sfx，設定音量）→ 壓低節點（戰鬥時環境音 30%）
//        → master（靜音）→ 壓限器（多個聲音疊在一起時不爆音）→ Phaser 的 destination。
// 背景音樂與環境音（M6 P3）：每個通道同時只有一個循環（換曲時舊的淡出、新的淡入）；
// loopEnd 用目錄的精確長度（AAC 解碼後尾端有幾毫秒的補白，不切掉循環處會有空隙）。
// 解碼後的循環 buffer 超過記憶體上限時丟掉最久沒用的（之後要播再從 HTTP 快取重新解碼）。
// 音檔自己 fetch＋decodeAudioData（loader.js）：解碼失敗或 404／415 才退下一個格式；全部失敗交給 director.reportBroken
// （warn 一次、保持安靜）。網路層失敗（離線）立即斷路：warn 一次、停止預載其餘音檔，避免 console 洗版；
// 收到恢復訊號（window online、分頁回到前景，見 audio/index.js）時 resetOffline 重設，把還沒載入的音檔重新排隊。
import { cueUrls } from './catalog.js';
import { loadFirstDecodable, decodeCompat } from './loader.js';
import { SYNTH_FNS } from './synth.js';

const RAMP = 0.03; // 音量變化的平滑時間常數（秒），避免喀聲
const CHANNELS = ['bgm', 'amb', 'sfx'];
const LOOP_CHANNELS = ['bgm', 'amb'];
/** 解碼後循環 buffer 的記憶體上限（位元組，float32）：計畫 §4.3 音訊緩衝 ≤ 100 MB。 */
const MEMORY_BUDGET = 100 * 1024 * 1024;
/** 壓限器參數與補償增益的抵銷值（補償 +1.71 dB 由 Chromium 的 OfflineAudioContext 實測）。 */
export const LIMITER = Object.freeze({ threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });
export const LIMITER_MAKEUP_DB = 1.71;
export const LIMITER_TRIM = 10 ** (-LIMITER_MAKEUP_DB / 20);
const bufferBytes = (b) => (Number(b?.length) || 0) * (Number(b?.numberOfChannels) || 1) * 4;

export class WebAudioBackend {
  constructor({ ctx, destination, director, base, formats, fetchFn, concurrency = 4 }) {
    this.kind = 'webaudio';
    this.ctx = ctx;
    this.director = director;
    this.base = base;
    this.formats = formats;
    this.fetchFn = fetchFn;
    this.concurrency = concurrency;
    this.buffers = new Map();
    this.loading = new Set();
    this.queue = [];
    this.active = 0;
    this.offline = false;
    this.outages = 0;
    this.wanted = new Set(); // 曾經要求載入的 cue（恢復連線時重新排隊用）
    this.failed = new Set(); // 已判定壞掉（404、解碼失敗）的 cue：不重抓
    this.masterTarget = 1;
    // 壓限器：只在接近滿刻度（−3 dBFS 以上）時壓住峰值，幾個大聲的音效疊在一起時不爆音。
    // Web Audio 規格的 DynamicsCompressor 會自動加補償增益（這組參數實測 +1.71 dB，所有音量一起變大），
    // 所以後面串一個固定的 trim 抵銷，門檻以下的聲音維持原音量（tests/e2e/audio-real.spec.js 用 OfflineAudioContext 量）。
    this.limiter = ctx.createDynamicsCompressor();
    for (const [k, v] of Object.entries(LIMITER)) this.limiter[k].value = v;
    this.trim = ctx.createGain();
    this.trim.gain.value = LIMITER_TRIM;
    this.limiter.connect(this.trim);
    this.trim.connect(destination ?? ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(this.limiter);
    this.bus = {};
    this.ducker = {};
    for (const ch of CHANNELS) {
      this.bus[ch] = ctx.createGain();
      this.ducker[ch] = ctx.createGain();
      this.bus[ch].connect(this.ducker[ch]);
      this.ducker[ch].connect(this.master);
    }
    this.loops = { bgm: null, amb: null }; // 正在播的循環：{ id, src, gain, nodes, startedAt, offset, len }
    this.wantLoop = { bgm: null, amb: null }; // 要求播放但還在下載的：{ id, fadeIn, offset }
    this.pausedId = { bgm: null, amb: null }; // 暫停中（戰鬥時的地圖曲）：記憶體整理時不丟，戰鬥後才能立刻接回
    this.memoryBudget = MEMORY_BUDGET;
    this.useTick = 0;
    this.lastUsed = new Map(); // 循環 cue 最後使用的順序（記憶體上限用）
  }

  setGain(node, v) {
    const t = this.ctx.currentTime;
    node.gain.cancelScheduledValues(t);
    node.gain.setTargetAtTime(v, t, RAMP);
  }

  applyGains(g) {
    this.masterTarget = g.master;
    this.setGain(this.master, g.master);
    for (const ch of CHANNELS) this.setGain(this.bus[ch], g[ch]);
  }

  preload(ids) {
    for (const id of ids) this.load(id);
  }

  /** 排進下載佇列（同時最多 concurrency 個）。已載入、載入中、離線時略過。 */
  load(id) {
    const cue = this.director.catalog?.cues?.[id];
    const urls = cueUrls(cue, this.formats, this.base);
    if (!urls.length) return;
    this.wanted.add(id);
    if (this.offline || this.buffers.has(id) || this.loading.has(id) || this.failed.has(id)) return;
    this.loading.add(id);
    this.queue.push({ id, urls });
    this.pump();
  }

  pump() {
    while (!this.offline && this.active < this.concurrency && this.queue.length) {
      const { id, urls } = this.queue.shift();
      this.active += 1;
      loadFirstDecodable(urls, { fetch: this.fetchFn, decode: (ab) => decodeCompat(this.ctx, ab) })
        .then(({ buffer }) => {
          this.buffers.set(id, buffer);
          // 開始播放或記憶體整理出錯不等於音檔壞掉：另外 warn，不進 failed／reportBroken
          try { this.onLoaded(id); } catch (e) { this.director.warnOnce(`loop:start:${id}`, `「${id}」載入後無法開始播放`, e?.message ?? e); }
        })
        .catch((e) => {
          if (e?.network) {
            if (!this.offline) {
              this.offline = true;
              this.outages += 1;
              // 每次斷路只 warn 一次（key 帶斷路次數：恢復後又斷會再 warn 一次）
              this.director.warnOnce(`offline:${this.outages}`, '音檔下載失敗（網路），暫停下載，恢復連線後再試', e?.message ?? e);
            }
            for (const q of this.queue) this.loading.delete(q.id);
            this.queue = [];
          } else {
            this.failed.add(id);
            this.director.reportBroken(id, e);
          }
        })
        .finally(() => {
          this.loading.delete(id);
          this.active -= 1;
          this.pump();
        });
    }
  }

  /** 恢復訊號（網路恢復、分頁回到前景）：解除斷路，把還沒載入、也沒壞掉的 cue 重新排隊（仍受並行上限）。 */
  resetOffline() {
    if (!this.offline) return;
    this.offline = false;
    for (const id of this.wanted) this.load(id);
  }

  playSfx(id, vol, ch = 'sfx') {
    const buf = this.buffers.get(id);
    if (!buf) { this.load(id); return; } // 還沒載完：這次安靜，載完之後才有聲音
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(this.bus[CHANNELS.includes(ch) ? ch : 'sfx']);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* 已經斷開 */ } };
    src.start();
  }

  /** 程序合成音：接到指定通道（預設音效；遠方鐘聲、霧笛走環境音）；最後一個 oscillator 結束時回收節點。 */
  playSynth(name, vol, ch = 'sfx') {
    const fn = SYNTH_FNS[name];
    if (!fn) return;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    g.connect(this.bus[CHANNELS.includes(ch) ? ch : 'sfx']);
    const last = fn(this.ctx, g);
    const release = () => { try { g.disconnect(); } catch { /* 已經斷開 */ } };
    if (last) last.onended = release;
    else release();
  }

  // ── 循環播放（背景音樂、環境音；M6 P3） ──

  /** 播放循環：buffer 已載入就開始，否則排下載、載完時若仍是最後要求的才開始。 */
  playLoop(ch, id, { fadeIn = 0.8, offset = 0 } = {}) {
    if (!LOOP_CHANNELS.includes(ch)) return;
    if (this.loops[ch]) this.stopLoop(ch, { fadeOut: 0.3 });
    if (this.pausedId[ch] === id) this.pausedId[ch] = null; // 接回暫停的那首（戰鬥曲在同一個通道播，不清）
    const cue = this.director.catalog?.cues?.[id];
    if (!cue || typeof cue.src !== 'string') { this.wantLoop[ch] = null; return; }
    this.wantLoop[ch] = { id, fadeIn, offset };
    this.touch(id);
    const buf = this.buffers.get(id);
    if (buf) this.startLoop(ch, buf);
    else this.load(id);
  }

  onLoaded(id) {
    for (const ch of LOOP_CHANNELS) {
      if (this.wantLoop[ch]?.id === id && !this.loops[ch]) this.startLoop(ch, this.buffers.get(id));
    }
    if (LOOP_CHANNELS.includes(this.director.catalog?.cues?.[id]?.kind)) this.enforceMemory();
  }

  startLoop(ch, buf) {
    const want = this.wantLoop[ch];
    if (!want || !buf) return;
    this.wantLoop[ch] = null;
    const cue = this.director.catalog?.cues?.[want.id] ?? {};
    const ctx = this.ctx;
    const dur = Number(buf.duration) || 0;
    const len = typeof cue.len === 'number' && cue.len > 0 && cue.len <= dur ? cue.len : dur;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = len;
    const nodes = [];
    let head = src;
    if (cue.filter && typeof cue.filter.lowpass === 'number') {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cue.filter.lowpass;
      f.Q.value = 0.7;
      head.connect(f);
      nodes.push(f);
      head = f;
    }
    const g = ctx.createGain();
    const vol = typeof cue.volume === 'number' ? cue.volume : 1;
    const t = ctx.currentTime;
    if (want.fadeIn > 0) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + want.fadeIn);
    } else {
      g.gain.value = vol;
    }
    head.connect(g);
    g.connect(this.bus[ch]);
    nodes.push(g);
    const offset = len > 0 ? ((want.offset % len) + len) % len : 0;
    src.onended = () => { try { src.disconnect(); for (const n of nodes) n.disconnect(); } catch { /* 已經斷開 */ } };
    src.start(t, offset);
    this.loops[ch] = { id: want.id, src, gain: g, startedAt: t, offset, len };
  }

  /** 淡出後停止（還在下載的要求一併取消）。 */
  stopLoop(ch, { fadeOut = 0.6 } = {}) {
    if (!LOOP_CHANNELS.includes(ch)) return;
    this.wantLoop[ch] = null;
    this.pausedId[ch] = null; // 離開戰鬥（接著馬上 playLoop 接回，中間不會整理記憶體）或 Game Over：不再保留
    const L = this.loops[ch];
    if (!L) return;
    this.loops[ch] = null;
    const t = this.ctx.currentTime;
    const p = L.gain.gain;
    const v = p.value; // 先讀目前值再取消排程（有些實作取消後 value 會回到時間軸上的舊值）
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
    p.linearRampToValueAtTime(0, t + fadeOut);
    try { L.src.stop(t + fadeOut + 0.05); } catch { /* 已經停止 */ }
  }

  /** 暫停（戰鬥時的地圖曲）：回傳目前播到的位置（秒），之後用 playLoop 的 offset 接回。 */
  pauseLoop(ch, { fadeOut = 0.3 } = {}) {
    if (!LOOP_CHANNELS.includes(ch)) return 0;
    const L = this.loops[ch];
    let pos = this.wantLoop[ch]?.offset ?? 0;
    if (L) pos = L.len > 0 ? (L.offset + Math.max(0, this.ctx.currentTime - L.startedAt)) % L.len : 0;
    const id = L?.id ?? this.wantLoop[ch]?.id ?? null;
    this.stopLoop(ch, { fadeOut });
    this.pausedId[ch] = id;
    return pos;
  }

  /** context 正在跑（不是 suspended／interrupted）：隨機單次音只在這時候送出，避免停住期間累積、恢復時一起響。 */
  isRunning() { return this.ctx.state === 'running'; }

  /** 暫停的那首不再接回（director 在 Game Over 等情況呼叫）：記憶體整理時可以丟掉。 */
  clearPaused(ch) {
    if (LOOP_CHANNELS.includes(ch)) this.pausedId[ch] = null;
  }

  /** 戰鬥中壓低環境音：ramp 秒內線性變到 level（0～1）。 */
  duck(ch, level, { ramp = 0.5 } = {}) {
    const n = this.ducker[ch];
    if (!n) return;
    const t = this.ctx.currentTime;
    const v = n.gain.value;
    n.gain.cancelScheduledValues(t);
    n.gain.setValueAtTime(v, t);
    n.gain.linearRampToValueAtTime(level, t + ramp);
  }

  touch(id) { this.lastUsed.set(id, ++this.useTick); }

  loopBytes() {
    let n = 0;
    for (const [id, b] of this.buffers) if (LOOP_CHANNELS.includes(this.director.catalog?.cues?.[id]?.kind)) n += bufferBytes(b);
    return n;
  }

  /** 循環 buffer 超過記憶體上限：丟掉最久沒用、目前沒在播也沒在等的（音效 buffer 很小，不丟）。 */
  enforceMemory() {
    const inUse = new Set(LOOP_CHANNELS.flatMap((ch) => [this.loops[ch]?.id, this.wantLoop[ch]?.id, this.pausedId[ch]]).filter(Boolean));
    while (this.loopBytes() > this.memoryBudget) {
      const victim = [...this.buffers.keys()]
        .filter((id) => LOOP_CHANNELS.includes(this.director.catalog?.cues?.[id]?.kind) && !inUse.has(id))
        .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))[0];
      if (!victim) break;
      this.buffers.delete(victim);
      this.wanted.delete(victim);
    }
  }

  /**
   * 分頁隱藏時暫停整個 context，回來時恢復（只在已解鎖時）。由 Phaser 的 HIDDEN／VISIBLE 事件呼叫（audio/index.js）。
   * 只管聲音：遊戲迴圈在分頁隱藏時本來就由 Phaser 停止，回來時 Phaser 自己恢復；這裡不碰迴圈。
   */
  setHidden(hidden) {
    const st = this.ctx.state;
    if (hidden && st === 'running') this.ctx.suspend().catch(() => {});
    else if (!hidden && this.director.unlocked && (st === 'suspended' || st === 'interrupted')) this.ctx.resume().catch(() => {});
  }

  /** E2E 用（?test=1&audio=1）的唯讀摘要。 */
  debugInfo() {
    return {
      state: this.ctx.state,
      masterTarget: this.masterTarget,
      master: this.master.gain.value,
      buffers: this.buffers.size,
      sfxBuffers: [...this.buffers.keys()].filter((id) => this.director.catalog?.cues?.[id]?.kind === 'sfx').length,
      loading: this.loading.size,
      offline: this.offline,
      loops: { bgm: this.loops.bgm?.id ?? null, amb: this.loops.amb?.id ?? null },
      loopBytes: this.loopBytes(),
      ducked: { amb: this.ducker.amb.gain.value },
    };
  }
}
