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
    setValueAtTime(x) { this.value = x; },
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
      n.start = () => { n.started = true; };
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
  it('master 接到 Phaser 的 destination；bgm／amb／sfx 接到 master', () => {
    const { be, ctx } = make();
    expect(be.master.connected).toEqual([ctx.destination]);
    for (const ch of ['bgm', 'amb', 'sfx']) expect(be.bus[ch].connected).toEqual([be.master]);
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
