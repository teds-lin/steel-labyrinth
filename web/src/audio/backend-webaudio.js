// 瀏覽器後端：共用 Phaser 的 AudioContext（game.sound.context），不再另開一個。
// 節點圖：各 cue → 通道匯流排（bgm／amb／sfx）→ master（靜音）→ Phaser 的 destination。
// 音檔自己 fetch＋decodeAudioData（loader.js）：解碼失敗或 404／415 才退下一個格式；全部失敗交給 director.reportBroken
// （warn 一次、保持安靜）。網路層失敗（離線）立即斷路：warn 一次、停止預載其餘音檔，避免 console 洗版；
// 收到恢復訊號（window online、分頁回到前景，見 audio/index.js）時 resetOffline 重設，把還沒載入的音檔重新排隊。
import { cueUrls } from './catalog.js';
import { loadFirstDecodable, decodeCompat } from './loader.js';
import { SYNTH_FNS } from './synth.js';

const RAMP = 0.03; // 音量變化的平滑時間常數（秒），避免喀聲
const CHANNELS = ['bgm', 'amb', 'sfx'];

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
    this.master = ctx.createGain();
    this.master.connect(destination ?? ctx.destination);
    this.bus = {};
    for (const ch of CHANNELS) {
      this.bus[ch] = ctx.createGain();
      this.bus[ch].connect(this.master);
    }
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
        .then(({ buffer }) => { this.buffers.set(id, buffer); })
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

  playSfx(id, vol) {
    const buf = this.buffers.get(id);
    if (!buf) { this.load(id); return; } // 還沒載完：這次安靜，載完之後才有聲音
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(g).connect(this.bus.sfx);
    src.onended = () => { try { src.disconnect(); g.disconnect(); } catch { /* 已經斷開 */ } };
    src.start();
  }

  /** 程序合成音：接到音效匯流排；最後一個 oscillator 結束時回收節點。 */
  playSynth(name, vol) {
    const fn = SYNTH_FNS[name];
    if (!fn) return;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    g.connect(this.bus.sfx);
    const last = fn(this.ctx, g);
    const release = () => { try { g.disconnect(); } catch { /* 已經斷開 */ } };
    if (last) last.onended = release;
    else release();
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
      loading: this.loading.size,
      offline: this.offline,
    };
  }
}
