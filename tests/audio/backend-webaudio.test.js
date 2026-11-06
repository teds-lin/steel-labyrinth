// WebAudioBackend（M6 修正 M1-3）：用假的 AudioContext 驗證音量匯流排、載入失敗、網路斷路、分頁隱藏、合成音節點回收、
// 以及所有非同步失敗都有接住（不留 unhandled rejection）。
import { describe, it, expect, afterEach } from 'vitest';
import { WebAudioBackend } from '../../web/src/audio/backend-webaudio.js';

function fakeParam(v = 1) {
  return {
    value: v,
    target: v,
    setTargetAtTime(x) { this.target = x; this.value = x; },
    cancelScheduledValues() {},
    events: [],
    setValueAtTime(x, t) { this.value = x; this.events.push(['set', x, t]); },
    linearRampToValueAtTime(x, t) { this.value = x; this.target = x; this.events.push(['ramp', x, t]); },
    exponentialRampToValueAtTime(x) { this.value = x; },
  };
}

function node(kind, log) {
  const n = {
    kind,
    connected: [],
    disconnects: 0,
    connect(d) { this.connected.push(d); return d; },
    disconnect() { this.disconnects += 1; },
  };
  log.push(n);
  return n;
}

function fakeCtx({ state = 'running', suspendFails = false, resumeFails = false } = {}) {
  const nodes = [];
  const ctx = {
    nodes,
    state,
    currentTime: 0,
    destination: { kind: 'destination' },
    calls: [],
    createGain() { const n = node('gain', nodes); n.gain = fakeParam(1); return n; },
    createBufferSource() {
      const n = node('source', nodes);
      n.start = (when, offset) => { n.started = true; n.startArgs = [when, offset]; };
      n.stop = (when) => { n.stoppedAt = when; };
      return n;
    },
    createBiquadFilter() { const n = node('biquad', nodes); n.type = 'lowpass'; n.frequency = fakeParam(350); n.Q = fakeParam(1); return n; },
    createDynamicsCompressor() {
      const n = node('compressor', nodes);
      for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = fakeParam(0);
      return n;
    },
    createOscillator() {
      const n = node('osc', nodes);
      n.frequency = fakeParam(440);
      n.start = () => {};
      n.stop = () => {};
      n.onended = null;
      return n;
    },
    suspend() { this.calls.push('suspend'); return suspendFails ? Promise.reject(new Error('no')) : Promise.resolve(); },
    resume() { this.calls.push('resume'); return resumeFails ? Promise.reject(new Error('no')) : Promise.resolve(); },
    decodeAudioData(ab) { return ab === 'BAD' ? Promise.reject(new Error('EncodingError')) : Promise.resolve({ buf: ab }); },
  };
  return ctx;
}

const cue = (id) => ({ kind: 'sfx', src: `sfx/${id}`, credit: 'x' });
function fakeDirector(ids = ['a', 'b', 'c']) {
  return {
    unlocked: true,
    catalog: { cues: Object.fromEntries(ids.map((id) => [id, cue(id)])) },
    broken: [],
    warns: [],
    reportBroken(id, e) { this.broken.push([id, String(e?.message ?? e)]); },
    warnOnce(key, msg) { if (!this.warns.some((w) => w[0] === key)) this.warns.push([key, msg]); },
  };
}

/** 假 fetch：table[url] = { status, body } 或 Error（網路層失敗）；沒列到的回 404。 */
function fakeFetch(table = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = table[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, arrayBuffer: async () => 'x' };
    return { ok: r.status === 200, status: r.status, arrayBuffer: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

function make({ ctx = fakeCtx(), director = fakeDirector(), fetchFn = fakeFetch(), concurrency } = {}) {
  const be = new WebAudioBackend({ ctx, destination: ctx.destination, director, base: 'audio/', formats: ['ogg', 'm4a'], fetchFn, concurrency });
  return { be, ctx, director, fetchFn };
}

// 任何未接住的 rejection 都讓測試失敗
const unhandled = [];
const onUnhandled = (e) => unhandled.push(e);
process.on('unhandledRejection', onUnhandled);
afterEach(async () => {
  await flush();
  const got = unhandled.splice(0);
  expect(got.map(String), '不得有 unhandled rejection').toEqual([]);
});

describe('音量匯流排', () => {
  it('節點圖：bgm／amb／sfx 匯流排 → 各自的壓低（duck）節點 → master（靜音）→ 壓限器 → 補償抵銷 → Phaser 的 destination', () => {
    const { be, ctx } = make();
    expect(be.master.connected).toEqual([be.limiter]);
    expect(be.limiter.connected).toEqual([be.trim]);
    expect(be.trim.connected).toEqual([ctx.destination]);
    expect(be.trim.gain.value).toBeCloseTo(10 ** (-1.71 / 20), 6);
    for (const ch of ['bgm', 'amb', 'sfx']) {
      expect(be.bus[ch].connected).toEqual([be.ducker[ch]]);
      expect(be.ducker[ch].connected).toEqual([be.master]);
    }
  });
  it('壓限器：多個聲音疊在一起時不爆音（門檻 −6 dB、高比例、快速 attack）', () => {
    const { be } = make();
    expect(be.limiter.kind).toBe('compressor');
    expect(be.limiter.threshold.value).toBe(-3);
    expect(be.limiter.knee.value).toBe(0);
    expect(be.limiter.ratio.value).toBeGreaterThanOrEqual(10);
    expect(be.limiter.attack.value).toBeLessThanOrEqual(0.01);
  });
  it('applyGains：靜音時 master 為 0、各通道照設定；取消靜音 master 回 1', () => {
    const { be } = make();
    be.applyGains({ master: 0, bgm: 0.5, amb: 0.25, sfx: 0.75 });
    expect(be.master.gain.target).toBe(0);
    expect([be.bus.bgm.gain.target, be.bus.amb.gain.target, be.bus.sfx.gain.target]).toEqual([0.5, 0.25, 0.75]);
    be.applyGains({ master: 1, bgm: 0.5, amb: 0.25, sfx: 0.75 });
    expect(be.master.gain.target).toBe(1);
    expect(be.debugInfo()).toMatchObject({ masterTarget: 1 });
  });
});

describe('載入', () => {
  it('成功：buffer 進快取，播放時從快取建立 source 接到 sfx 匯流排', async () => {
    const f = fakeFetch({ 'audio/sfx/a.ogg': { status: 200, body: 'OGG' } });
    const { be } = make({ fetchFn: f });
    be.preload(['a']);
    await flush();
    expect(be.debugInfo().buffers).toBe(1);
    be.playSfx('a', 0.5);
    const src = be.ctx.nodes.filter((n) => n.kind === 'source').at(-1);
    expect(src.started).toBe(true);
    expect(src.buffer).toEqual({ buf: 'OGG' });
  });
  it('兩種格式都失敗（404／解碼失敗）→ reportBroken，且沒有 unhandled rejection', async () => {
    const f = fakeFetch({ 'audio/sfx/a.ogg': { status: 200, body: 'BAD' } });
    const { be, director } = make({ fetchFn: f });
    be.preload(['a']);
    await flush();
    expect(director.broken.map((x) => x[0])).toEqual(['a']);
    expect(f.calls).toEqual(['audio/sfx/a.ogg', 'audio/sfx/a.m4a']);
  });
  it('playSfx 遇到還沒載入的 cue：觸發載入；載入失敗走 reportBroken（.catch 存在，不留 unhandled rejection）', async () => {
    const { be, director } = make();
    be.playSfx('b', 1);
    await flush();
    expect(director.broken.map((x) => x[0])).toEqual(['b']);
  });
  it('網路層失敗：斷路——warn 一次、停止預載其餘 cue（不洗版）', async () => {
    const err = new TypeError('Failed to fetch');
    const table = Object.fromEntries(['a', 'b', 'c'].flatMap((id) => [[`audio/sfx/${id}.ogg`, err], [`audio/sfx/${id}.m4a`, err]]));
    const f = fakeFetch(table);
    const { be, director } = make({ fetchFn: f, concurrency: 1 });
    be.preload(['a', 'b', 'c']);
    await flush();
    expect(f.calls).toEqual(['audio/sfx/a.ogg']);
    expect(director.warns, '這次斷路只 warn 一次').toHaveLength(1);
    expect(director.broken).toEqual([]); // 網路問題不是 cue 壞掉
    expect(be.debugInfo().offline).toBe(true);
    be.playSfx('b', 1);
    await flush();
    expect(f.calls).toHaveLength(1); // 斷路後播放也不再抓
  });
  it('斷路後收到恢復訊號（resetOffline）：重設斷路，把還沒載入的 cue 重新排入佇列（不重抓已載入或已壞掉的）', async () => {
    let down = true;
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(url);
      if (down) throw new TypeError('Failed to fetch');
      if (url.includes('/c.')) return { ok: false, status: 404, arrayBuffer: async () => 'x' };
      return { ok: true, status: 200, arrayBuffer: async () => 'OK' };
    };
    const director = fakeDirector(['a', 'b', 'c', 'd']);
    const { be } = make({ fetchFn, director, concurrency: 1 });
    be.preload(['a', 'b', 'c', 'd']);
    await flush();
    expect(be.debugInfo().offline).toBe(true);
    expect(calls).toHaveLength(1);
    down = false;
    be.resetOffline();
    await flush();
    expect(be.debugInfo()).toMatchObject({ offline: false, buffers: 3, loading: 0 });
    expect(director.broken.map((x) => x[0])).toEqual(['c']);
    // 再次恢復訊號：沒有斷路就什麼都不做，不重抓
    const n = calls.length;
    be.resetOffline();
    await flush();
    expect(calls).toHaveLength(n);
  });
  it('每次斷路只 warn 一次；恢復後又斷路會再 warn 一次', async () => {
    const err = new TypeError('Failed to fetch');
    const fetchFn = async () => { throw err; };
    const director = fakeDirector(['a', 'b', 'c']);
    const { be } = make({ fetchFn, director, concurrency: 2 });
    be.preload(['a', 'b', 'c']);
    await flush();
    expect(director.warns).toHaveLength(1);
    be.resetOffline();
    await flush();
    expect(director.warns).toHaveLength(2);
    expect(be.debugInfo().offline).toBe(true);
  });
  it('恢復後重新排隊仍維持並行上限', async () => {
    let down = true;
    let inflight = 0;
    let peak = 0;
    const fetchFn = async () => {
      if (down) throw new TypeError('Failed to fetch');
      inflight += 1; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight -= 1;
      return { ok: true, status: 200, arrayBuffer: async () => 'OK' };
    };
    const director = fakeDirector(['a', 'b', 'c', 'd', 'e', 'f']);
    const { be } = make({ fetchFn, director, concurrency: 2 });
    be.preload(['a', 'b', 'c', 'd', 'e', 'f']);
    await flush();
    down = false;
    be.resetOffline();
    await new Promise((r) => setTimeout(r, 30));
    expect(peak).toBe(2);
    expect(be.debugInfo().buffers).toBe(6);
  });
  it('預載有並行上限：同時最多 concurrency 個請求', async () => {
    let inflight = 0;
    let peak = 0;
    const fetchFn = async () => {
      inflight += 1; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight -= 1;
      return { ok: true, status: 200, arrayBuffer: async () => 'OK' };
    };
    const director = fakeDirector(['a', 'b', 'c', 'd', 'e', 'f']);
    const { be } = make({ fetchFn, director, concurrency: 2 });
    be.preload(['a', 'b', 'c', 'd', 'e', 'f']);
    await new Promise((r) => setTimeout(r, 30));
    expect(peak).toBe(2);
    expect(be.debugInfo().buffers).toBe(6);
  });
});

describe('分頁隱藏（setHidden）', () => {
  it('隱藏且 running → suspend；已經 suspended → 不動', () => {
    const a = make({ ctx: fakeCtx({ state: 'running' }) });
    a.be.setHidden(true);
    expect(a.ctx.calls).toEqual(['suspend']);
    const b = make({ ctx: fakeCtx({ state: 'suspended' }) });
    b.be.setHidden(true);
    expect(b.ctx.calls).toEqual([]);
  });
  it('顯示且已解鎖、context suspended／interrupted → resume；未解鎖 → 不 resume', () => {
    for (const state of ['suspended', 'interrupted']) {
      const a = make({ ctx: fakeCtx({ state }) });
      a.be.setHidden(false);
      expect(a.ctx.calls, state).toEqual(['resume']);
    }
    const d = fakeDirector();
    d.unlocked = false;
    const b = make({ ctx: fakeCtx({ state: 'suspended' }), director: d });
    b.be.setHidden(false);
    expect(b.ctx.calls).toEqual([]);
  });
  it('suspend／resume 被拒絕也不留 unhandled rejection', async () => {
    make({ ctx: fakeCtx({ state: 'running', suspendFails: true }) }).be.setHidden(true);
    make({ ctx: fakeCtx({ state: 'suspended', resumeFails: true }) }).be.setHidden(false);
    await flush();
  });
});

describe('合成音（鐘聲）', () => {
  it('接到 sfx 匯流排；最後一個 oscillator 結束（onended）才斷開節點，不靠計時器', () => {
    const { be } = make();
    be.playSynth('bell', 0.8);
    const oscs = be.ctx.nodes.filter((n) => n.kind === 'osc');
    expect(oscs.length).toBeGreaterThan(0);
    const out = be.ctx.nodes.find((n) => n.kind === 'gain' && n.connected.includes(be.bus.sfx));
    expect(out.gain.value).toBe(0.8);
    expect(out.disconnects).toBe(0);
    const last = oscs.at(-1);
    expect(typeof last.onended).toBe('function');
    last.onended();
    expect(out.disconnects).toBe(1);
  });
  it('未知的合成音名稱：什麼都不做', () => {
    const { be } = make();
    const before = be.ctx.nodes.length;
    be.playSynth('nope', 1);
    expect(be.ctx.nodes.length).toBe(before);
  });
});

// ── M6 P3：循環播放（背景音樂、環境音） ──
const loopCue = (id, extra = {}) => ({ kind: id.startsWith('amb') ? 'amb' : 'bgm', src: `${id.startsWith('amb') ? 'amb' : 'bgm'}/${id}`, loop: true, len: 40, credit: 'x', ...extra });
function loopDirector(cues) {
  const d = fakeDirector([]);
  d.catalog.cues = cues;
  return d;
}
/** 解碼後的假 buffer：秒數、聲道數（記憶體上限用 length × 聲道 × 4 bytes）。 */
function bufCtx(spec = {}) {
  const ctx = fakeCtx();
  ctx.sampleRate = 48000;
  ctx.decodeAudioData = (ab) => {
    const [dur, ch] = spec[ab] ?? [40.02, 2];
    return Promise.resolve({ tag: ab, duration: dur, length: Math.round(dur * 48000), numberOfChannels: ch, sampleRate: 48000 });
  };
  return ctx;
}
const okFetch = (ids) => fakeFetch(Object.fromEntries(ids.map((id) => [`audio/${id.startsWith('amb') ? 'amb' : 'bgm'}/${id}.ogg`, { status: 200, body: id }])));
const sources = (ctx) => ctx.nodes.filter((n) => n.kind === 'source');

describe('循環播放（M6 P3）', () => {
  it('playLoop：載入後開始播放；loop＝true、loopEnd＝目錄的精確長度（切掉 AAC 尾端補白）；音量從 0 淡入到 cue 音量；接到該通道', async () => {
    const ctx = bufCtx({ bgm_a: [40.017, 2] });
    const { be } = make({ ctx, director: loopDirector({ bgm_a: loopCue('bgm_a', { volume: 0.8 }) }), fetchFn: okFetch(['bgm_a']) });
    ctx.currentTime = 5;
    be.playLoop('bgm', 'bgm_a', { fadeIn: 0.8, offset: 0 });
    await flush();
    const src = sources(ctx).at(-1);
    expect(src.buffer.tag).toBe('bgm_a');
    expect([src.loop, src.loopStart, src.loopEnd]).toEqual([true, 0, 40]);
    expect(src.startArgs).toEqual([5, 0]);
    const g = src.connected[0];
    expect(g.gain.events).toEqual([['set', 0, 5], ['ramp', 0.8, 5.8]]);
    expect(g.connected).toEqual([be.bus.bgm]);
    expect(be.debugInfo().loops).toEqual({ bgm: 'bgm_a', amb: null });
  });
  it('目錄長度比 buffer 長（或沒有）時用 buffer 的長度', async () => {
    const ctx = bufCtx({ bgm_a: [39.5, 2] });
    const { be } = make({ ctx, director: loopDirector({ bgm_a: loopCue('bgm_a') }), fetchFn: okFetch(['bgm_a']) });
    be.playLoop('bgm', 'bgm_a', { fadeIn: 0, offset: 0 });
    await flush();
    expect(sources(ctx).at(-1).loopEnd).toBe(39.5);
  });
  it('從指定位置開始（戰鬥後接回）；位置超過長度時取餘數', async () => {
    const ctx = bufCtx();
    const { be } = make({ ctx, director: loopDirector({ bgm_a: loopCue('bgm_a') }), fetchFn: okFetch(['bgm_a']) });
    be.playLoop('bgm', 'bgm_a', { fadeIn: 0.8, offset: 92.5 });
    await flush();
    expect(sources(ctx).at(-1).startArgs[1]).toBeCloseTo(12.5);
  });
  it('stopLoop：音量淡出到 0，淡出完才停止 source；source 結束時斷開節點', async () => {
    const ctx = bufCtx();
    const { be } = make({ ctx, director: loopDirector({ bgm_a: loopCue('bgm_a') }), fetchFn: okFetch(['bgm_a']) });
    be.playLoop('bgm', 'bgm_a', { fadeIn: 0, offset: 0 });
    await flush();
    const src = sources(ctx).at(-1);
    ctx.currentTime = 10;
    be.stopLoop('bgm', { fadeOut: 0.6 });
    expect(src.connected[0].gain.events.at(-1)).toEqual(['ramp', 0, 10.6]);
    expect(src.stoppedAt).toBeCloseTo(10.65);
    src.onended();
    expect(src.disconnects).toBeGreaterThan(0);
    expect(be.debugInfo().loops.bgm).toBeNull();
  });
  it('pauseLoop：回傳目前播到的位置（從開始播放的位置與經過時間算，取循環長度的餘數），並淡出停止', async () => {
    const ctx = bufCtx();
    const { be } = make({ ctx, director: loopDirector({ bgm_a: loopCue('bgm_a') }), fetchFn: okFetch(['bgm_a']) });
    ctx.currentTime = 100;
    be.playLoop('bgm', 'bgm_a', { fadeIn: 0, offset: 30 });
    await flush();
    ctx.currentTime = 125;
    expect(be.pauseLoop('bgm', { fadeOut: 0.3 })).toBeCloseTo(15); // (30 + 25) mod 40
    expect(sources(ctx).at(-1).stoppedAt).toBeCloseTo(125.35);
  });
  it('還在下載時就被換掉或停止：下載完成後不播（只播最後要求的）', async () => {
    const ctx = bufCtx();
    const { be } = make({ ctx, director: loopDirector({ bgm_a: loopCue('bgm_a'), bgm_b: loopCue('bgm_b') }), fetchFn: okFetch(['bgm_a', 'bgm_b']) });
    be.playLoop('bgm', 'bgm_a', { fadeIn: 0, offset: 0 });
    be.playLoop('bgm', 'bgm_b', { fadeIn: 0, offset: 0 });
    await flush();
    expect(sources(ctx).map((s) => s.buffer.tag)).toEqual(['bgm_b']);
    be.stopLoop('bgm', { fadeOut: 0 });
    be.playLoop('amb', 'amb_x', { fadeIn: 0, offset: 0 }); // 目錄沒有：什麼都不做
    await flush();
    expect(sources(ctx)).toHaveLength(1);
  });
  it('下載中被暫停（進戰鬥）：回傳原本要求的位置', () => {
    const ctx = bufCtx();
    const { be } = make({ ctx, director: loopDirector({ bgm_a: loopCue('bgm_a') }), fetchFn: okFetch(['bgm_a']) });
    be.playLoop('bgm', 'bgm_a', { fadeIn: 0, offset: 7 });
    expect(be.pauseLoop('bgm', { fadeOut: 0.3 })).toBe(7);
  });
  it('cue 有 filter.lowpass：source → 低通濾波 → 增益（隔窗雨聲）', async () => {
    const ctx = bufCtx();
    const { be } = make({ ctx, director: loopDirector({ amb_in: loopCue('amb_in', { src: 'amb/amb_rain', filter: { lowpass: 900 } }) }), fetchFn: fakeFetch({ 'audio/amb/amb_rain.ogg': { status: 200, body: 'rain' } }) });
    be.playLoop('amb', 'amb_in', { fadeIn: 1, offset: 0 });
    await flush();
    const src = sources(ctx).at(-1);
    const f = src.connected[0];
    expect(f.kind).toBe('biquad');
    expect([f.type, f.frequency.value]).toEqual(['lowpass', 900]);
    expect(f.connected[0].connected).toEqual([be.bus.amb]);
  });
  it('duck：該通道的壓低節點在 ramp 秒內線性變到指定比例', () => {
    const { be, ctx } = make();
    ctx.currentTime = 3;
    be.duck('amb', 0.3, { ramp: 0.5 });
    expect(be.ducker.amb.gain.events.at(-1)).toEqual(['ramp', 0.3, 3.5]);
    be.duck('nope', 0.3, { ramp: 0.5 }); // 未知通道：不動
  });
  it('記憶體上限：解碼後的循環 buffer 超過上限時，丟掉最久沒用、目前沒在播也沒在等的；音效 buffer 不丟', async () => {
    const ctx = bufCtx({ bgm_a: [90, 2], bgm_b: [90, 2], bgm_c: [90, 2] });
    const cues = { bgm_a: loopCue('bgm_a'), bgm_b: loopCue('bgm_b'), bgm_c: loopCue('bgm_c') };
    const { be } = make({ ctx, director: loopDirector(cues), fetchFn: okFetch(['bgm_a', 'bgm_b', 'bgm_c']) });
    be.memoryBudget = 2 * 90 * 48000 * 2 * 4; // 剛好兩首
    for (const id of ['bgm_a', 'bgm_b', 'bgm_c']) {
      be.playLoop('bgm', id, { fadeIn: 0, offset: 0 });
      await flush();
    }
    expect([...be.buffers.keys()].sort()).toEqual(['bgm_b', 'bgm_c']);
    expect(be.debugInfo().loopBytes).toBeLessThanOrEqual(be.memoryBudget);
  });
  it('合成音與音效可以指定通道（遠方鐘聲、霧笛走環境音）；未知通道退回 sfx', () => {
    const { be, ctx } = make();
    be.playSynth('bell', 0.3, 'amb');
    expect(ctx.nodes.filter((n) => n.kind === 'gain' && n.connected.includes(be.bus.amb)).map((n) => n.gain.value)).toEqual([0.3]);
    be.playSynth('foghorn', 0.5, 'weird');
    const outs = ctx.nodes.filter((n) => n.kind === 'gain' && n.connected.includes(be.bus.sfx));
    expect(outs.length).toBeGreaterThan(0);
  });
});

describe('第 1 輪審查修正（M6 P3）', () => {
  it('淡出：先讀目前音量再取消排程（取消後 value 會變的實作也不跳音）', async () => {
    const ctx = bufCtx();
    const { be } = make({ ctx, director: loopDirector({ bgm_a: loopCue('bgm_a') }), fetchFn: okFetch(['bgm_a']) });
    be.playLoop('bgm', 'bgm_a', { fadeIn: 0.8, offset: 0 });
    await flush();
    const p = sources(ctx).at(-1).connected[0].gain;
    p.value = 0.42; // 淡入到一半
    p.cancelScheduledValues = function () { this.value = 0; }; // 模擬「取消後回到時間軸上的舊值」
    ctx.currentTime = 1;
    be.stopLoop('bgm', { fadeOut: 0.6 });
    expect(p.events.at(-2)).toEqual(['set', 0.42, 1]);
    be.ducker.amb.gain.value = 0.7;
    be.ducker.amb.gain.cancelScheduledValues = function () { this.value = 1; };
    be.duck('amb', 0.3, { ramp: 0.5 });
    expect(be.ducker.amb.gain.events.at(-2)).toEqual(['set', 0.7, 1]);
  });
  it('記憶體整理不丟暫停中的地圖曲（戰鬥後立刻接回）', async () => {
    const ctx = bufCtx({ bgm_city: [90, 2], amb_r: [30, 1], bgm_battle: [90, 2] });
    const cues = { bgm_city: loopCue('bgm_city'), amb_r: loopCue('amb_r'), bgm_battle: loopCue('bgm_battle') };
    const { be } = make({ ctx, director: loopDirector(cues), fetchFn: okFetch(['bgm_city', 'amb_r', 'bgm_battle']) });
    be.memoryBudget = 2 * 90 * 48000 * 2 * 4; // 放不下兩首 BGM＋環境音
    be.playLoop('bgm', 'bgm_city', { fadeIn: 0, offset: 0 });
    be.playLoop('amb', 'amb_r', { fadeIn: 0, offset: 0 });
    await flush();
    be.pauseLoop('bgm', { fadeOut: 0.3 });
    be.playLoop('bgm', 'bgm_battle', { fadeIn: 0, offset: 0 });
    await flush();
    expect(be.buffers.has('bgm_city')).toBe(true);
    expect(be.buffers.has('bgm_battle')).toBe(true);
  });
  it('載入後開始播放時出錯：warn，不當成音檔壞掉', async () => {
    const ctx = bufCtx();
    const { be, director } = make({ ctx, director: loopDirector({ bgm_a: loopCue('bgm_a') }), fetchFn: okFetch(['bgm_a']) });
    ctx.createBufferSource = () => { throw new Error('boom'); };
    be.playLoop('bgm', 'bgm_a', { fadeIn: 0, offset: 0 });
    await flush();
    expect(director.broken).toEqual([]);
    expect(director.warns.map((w) => w[0])).toContain('loop:start:bgm_a');
  });
  it('clearPaused：暫停的那首不再接回時，記憶體整理可以丟掉它', async () => {
    const ctx = bufCtx({ bgm_city: [90, 2], bgm_battle: [90, 2], bgm_theme: [90, 2] });
    const cues = { bgm_city: loopCue('bgm_city'), bgm_battle: loopCue('bgm_battle'), bgm_theme: loopCue('bgm_theme') };
    const { be } = make({ ctx, director: loopDirector(cues), fetchFn: okFetch(['bgm_city', 'bgm_battle', 'bgm_theme']) });
    be.memoryBudget = 2 * 90 * 48000 * 2 * 4;
    be.playLoop('bgm', 'bgm_city', { fadeIn: 0, offset: 0 });
    await flush();
    be.pauseLoop('bgm', {});
    be.playLoop('bgm', 'bgm_battle', { fadeIn: 0, offset: 0 });
    await flush();
    be.stopLoop('bgm', {});
    be.clearPaused('bgm');
    be.playLoop('bgm', 'bgm_theme', { fadeIn: 0, offset: 0 });
    await flush();
    expect(be.buffers.has('bgm_theme')).toBe(true);
    expect(be.buffers.has('bgm_city')).toBe(false);
  });
  it('isRunning：context 是 running 才回 true', () => {
    const { be, ctx } = make();
    expect(be.isRunning()).toBe(true);
    ctx.state = 'interrupted';
    expect(be.isRunning()).toBe(false);
  });
});
