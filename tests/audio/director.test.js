// AudioDirector（M6 P1）：注入假後端驗證音量通道、靜音、打字音開關、解鎖、失敗容錯、設定保存。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioDirector } from '../../web/src/audio/director.js';
import { AUDIO_DEFAULTS, AUDIO_SETTINGS_KEY } from '../../web/src/audio/settings.js';

const catalog = () => ({
  version: 1,
  defaults: {},
  events: { 'battle.hit': 'ui_confirm', 'map.change': null, 'item.get': 'sfx_bell' },
  cues: {
    ui_move: { kind: 'sfx', src: 'sfx/ui_move', volume: 0.5, credit: 'k' },
    ui_confirm: { kind: 'sfx', src: 'sfx/ui_confirm', credit: 'k' },
    text_tick: { kind: 'sfx', src: 'sfx/text_tick', credit: 'c' },
    sfx_bell: { kind: 'sfx', synth: 'bell' },
    bgm_x: { kind: 'bgm', src: 'bgm/bgm_x', loop: true, len: 30, credit: 'k' },
  },
});

function fakeBackend({ throwOn = null } = {}) {
  return {
    kind: 'fake',
    gains: null,
    plays: [],
    synths: [],
    preloaded: [],
    applyGains(g) { this.gains = { ...g }; },
    preload(ids) { this.preloaded.push(...ids); },
    playSfx(id, gain) {
      if (id === throwOn) throw new Error('boom');
      this.plays.push([id, gain]);
    },
    playSynth(name, gain) { this.synths.push([name, gain]); },
  };
}

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

let warn;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

function ready(opts = {}) {
  const d = new AudioDirector({ storage: opts.storage ?? fakeStorage() });
  const b = fakeBackend(opts);
  d.attach(b);
  d.setCatalog(catalog());
  d.markUnlocked();
  return { d, b };
}

describe('設定', () => {
  it('啟動時從 storage 讀設定；讀不到用預設值', () => {
    const st = fakeStorage({ [AUDIO_SETTINGS_KEY]: JSON.stringify({ ...AUDIO_DEFAULTS, sfx: 1, mute: true }) });
    expect(new AudioDirector({ storage: st }).settings).toMatchObject({ sfx: 1, mute: true });
    expect(new AudioDirector({ storage: null }).settings).toEqual(AUDIO_DEFAULTS);
  });
  it('setSettings：整理後保存到 storage、套用到後端、通知監聽者', () => {
    const st = fakeStorage();
    const { d, b } = ready({ storage: st });
    const seen = [];
    d.onChange((s) => seen.push(s.bgm));
    d.setSettings({ ...d.settings, bgm: 9 });
    expect(d.settings.bgm).toBe(4);
    expect(JSON.parse(st.m.get(AUDIO_SETTINGS_KEY)).bgm).toBe(4);
    expect(b.gains).toEqual({ master: 1, bgm: 1, amb: 0.5, sfx: 0.75 });
    expect(seen).toEqual([4]);
  });
  it('attach 時立即套用目前音量；靜音時 master 為 0', () => {
    const d = new AudioDirector({ storage: fakeStorage({ [AUDIO_SETTINGS_KEY]: JSON.stringify({ ...AUDIO_DEFAULTS, mute: true }) }) });
    const b = fakeBackend();
    d.attach(b);
    expect(b.gains.master).toBe(0);
  });
  it('toggleMute 反轉並回傳新狀態；保存失敗（storage 丟錯）也不丟例外', () => {
    const st = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
    const { d } = ready({ storage: st });
    expect(d.toggleMute()).toBe(true);
    expect(d.settings.mute).toBe(true);
    expect(d.toggleMute()).toBe(false);
    expect(d.info().saved).toBe(false);
  });
  it('取消訂閱後不再收到通知', () => {
    const { d } = ready();
    const seen = [];
    const off = d.onChange(() => seen.push(1));
    off();
    d.toggleMute();
    expect(seen).toEqual([]);
  });
});

describe('音效播放', () => {
  it('播放時把 cue 自身音量交給後端（通道音量由後端的匯流排處理），並記在 lastSfx', () => {
    const { d, b } = ready();
    d.sfx('ui_move');
    d.sfx('ui_confirm');
    expect(b.plays).toEqual([['ui_move', 0.5], ['ui_confirm', 1]]);
    expect(d.info().lastSfx).toEqual(['ui_move', 'ui_confirm']);
  });
  it('靜音或音效音量 0 時不送後端、不記錄', () => {
    const { d, b } = ready();
    d.toggleMute();
    d.sfx('ui_move');
    d.setSettings({ ...d.settings, mute: false, sfx: 0 });
    d.sfx('ui_move');
    expect(b.plays).toEqual([]);
    expect(d.info().lastSfx).toEqual([]);
  });
  it('打字音走 typing 通道：關閉時不響，開啟時響', () => {
    const { d, b } = ready();
    d.setSettings({ ...d.settings, typing: false });
    d.sfx('text_tick');
    expect(b.plays).toEqual([]);
    d.setSettings({ ...d.settings, typing: true });
    d.sfx('text_tick');
    expect(b.plays.map((p) => p[0])).toEqual(['text_tick']);
  });
  it('合成音（鐘聲）走 playSynth，也受靜音控制', () => {
    const { d, b } = ready();
    d.sfx('sfx_bell');
    expect(b.synths).toEqual([['bell', 1]]);
    d.toggleMute();
    d.sfx('sfx_bell');
    expect(b.synths).toHaveLength(1);
    expect(d.info().lastSfx).toEqual(['sfx_bell']);
  });
  it('不是 sfx 的 cue 不能用 sfx() 播', () => {
    const { d, b } = ready();
    d.sfx('bgm_x');
    expect(b.plays).toEqual([]);
  });
  it('lastSfx 只保留最近 200 筆（E2E 要看完一整場戰鬥的序列）', () => {
    let t = 0;
    const d = new AudioDirector({ storage: fakeStorage(), now: () => t });
    d.attach(fakeBackend());
    d.setCatalog(catalog());
    d.markUnlocked();
    for (let i = 0; i < 230; i++) { t += 100; d.sfx('ui_move'); }
    expect(d.info().lastSfx).toHaveLength(200);
  });
});

describe('event(key)：依目錄的 events 對應表播放（M6 P2）', () => {
  it('查表得到 cue 就播；對應為 null（刻意不發聲）或 key 為 null 時安靜', () => {
    const { d, b } = ready();
    d.event('battle.hit');
    d.event('map.change');
    d.event(null);
    d.event('item.get');
    expect(b.plays.map((p) => p[0])).toEqual(['ui_confirm']);
    expect(b.synths.map((p) => p[0])).toEqual(['bell']);
    expect(d.info().lastSfx).toEqual(['ui_confirm', 'sfx_bell']);
  });
  it('目錄缺整張 events 表：不管多少個不同事件鍵，只 warn 一次', () => {
    const { d, b } = ready();
    const cat = catalog();
    delete cat.events;
    d.setCatalog(cat);
    d.event('battle.hit');
    d.event('map.change');
    d.event('save.ok');
    expect(b.plays).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('未知的事件鍵：只 warn 一次、不丟例外', () => {
    const { d, b } = ready();
    d.event('battle.nope');
    d.event('battle.nope');
    expect(b.plays).toEqual([]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('battle.nope'))).toHaveLength(1);
  });
});

describe('同時發聲上限的優先序（M6 P2 Round 1）', () => {
  function burstCatalog() {
    const cat = catalog();
    for (const id of ['u1', 'u2', 'u3', 'u4']) cat.cues[id] = { kind: 'sfx', src: `sfx/${id}`, credit: 'k' };
    cat.cues.jingle_victory = { kind: 'sfx', src: 'sfx/jingle_victory', credit: 'k', burst: 'priority' };
    cat.cues.text_tick.burst = 'exempt';
    cat.events['battle.victory'] = 'jingle_victory';
    return cat;
  }
  function setup() {
    let t = 0;
    const d = new AudioDirector({ storage: fakeStorage(), now: () => t });
    const b = fakeBackend();
    d.attach(b);
    d.setCatalog(burstCatalog());
    d.markUnlocked();
    return { d, b, tick: (ms) => { t += ms; } };
  }
  it('同時送 3 個介面音後 5 ms 送勝利事件：短樂句（burst: priority）仍然播出', () => {
    const { d, b, tick } = setup();
    d.sfx('u1'); d.sfx('u2'); d.sfx('u3');
    tick(5);
    d.event('battle.victory');
    d.sfx('u4');
    expect(b.plays.map((p) => p[0])).toEqual(['u1', 'u2', 'u3', 'jingle_victory']);
  });
  it('打字音（burst: exempt）不受上限、也不佔額度', () => {
    const { d, b } = setup();
    d.sfx('text_tick');
    d.sfx('u1'); d.sfx('u2'); d.sfx('u3');
    d.sfx('u4'); // 額度 3 已滿（打字音沒算進去）
    expect(b.plays.map((p) => p[0])).toEqual(['text_tick', 'u1', 'u2', 'u3']);
    const { d: d2, b: b2 } = setup();
    d2.sfx('u1'); d2.sfx('u2'); d2.sfx('u3');
    d2.sfx('text_tick');
    expect(b2.plays.map((p) => p[0])).toEqual(['u1', 'u2', 'u3', 'text_tick']);
  });
  it('info().requests 記錄每個要求與結果（played／gap／burst），E2E 用來比對完整序列', () => {
    const { d, tick } = setup();
    d.sfx('u1'); d.sfx('u1'); d.sfx('u2'); d.sfx('u3'); d.sfx('u4');
    tick(50);
    d.sfx('u1');
    expect(d.info().requests.map((r) => r.t)).toEqual([0, 0, 0, 0, 0, 50]); // 時間戳（毫秒，診斷用）
    expect(d.info().requests.map(({ id, result }) => ({ id, result }))).toEqual([
      { id: 'u1', result: 'played' }, { id: 'u1', result: 'gap' }, { id: 'u2', result: 'played' },
      { id: 'u3', result: 'played' }, { id: 'u4', result: 'burst' }, { id: 'u1', result: 'played' },
    ]);
  });
  it('靜音、打字音關閉、未解鎖的要求不記錄（它們本來就不該響）', () => {
    const { d } = setup();
    d.toggleMute();
    d.sfx('u1');
    expect(d.info().requests).toEqual([]);
  });
});

describe('同時發聲上限（避免爆音、快轉時不爆量）', () => {
  it('30 ms 內最多 3 個音效開始播放；超過的直接略過（不排隊補播）', () => {
    let t = 0;
    const cat = catalog();
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) cat.cues[id] = { kind: 'sfx', src: `sfx/${id}`, credit: 'k' };
    const d = new AudioDirector({ storage: fakeStorage(), now: () => t });
    const b = fakeBackend();
    d.attach(b);
    d.setCatalog(cat);
    d.markUnlocked();
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) d.sfx(id);
    expect(b.plays.map((p) => p[0])).toEqual(['a1', 'a2', 'a3']);
    t += 29;
    d.sfx('a4');
    expect(b.plays).toHaveLength(3);
    t += 1; // 第一批已滿 30 ms
    d.sfx('a4');
    d.sfx('a5');
    expect(b.plays.map((p) => p[0])).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });
  it('一般節奏（每 16 ms 一個，像 ?test=1 的戰鬥）不會被擋', () => {
    let t = 0;
    const cat = catalog();
    for (let i = 0; i < 10; i++) cat.cues[`c${i}`] = { kind: 'sfx', src: `sfx/c${i}`, credit: 'k' };
    const d = new AudioDirector({ storage: fakeStorage(), now: () => t });
    const b = fakeBackend();
    d.attach(b);
    d.setCatalog(cat);
    d.markUnlocked();
    for (let i = 0; i < 10; i++) { d.sfx(`c${i}`); t += 16; }
    expect(b.plays).toHaveLength(10);
  });
});

describe('同一個音效的最小間隔（約 40 ms）', () => {
  it('40 ms 內重複要求同一個 cue 只播一次；不同 cue 互不影響；過了間隔可以再播', () => {
    let t = 1000;
    const d = new AudioDirector({ storage: fakeStorage(), now: () => t });
    const b = fakeBackend();
    d.attach(b);
    d.setCatalog(catalog());
    d.markUnlocked();
    d.sfx('ui_move');
    t += 10;
    d.sfx('ui_move');
    d.sfx('ui_confirm');
    t += 39;
    d.sfx('ui_move');
    t += 1;
    d.sfx('ui_move');
    expect(b.plays.map((p) => p[0])).toEqual(['ui_move', 'ui_confirm', 'ui_move']);
    expect(d.info().lastSfx).toEqual(['ui_move', 'ui_confirm', 'ui_move']);
  });
  it('預設時鐘用 performance.now()（單調遞增，不受系統時間調整影響）', () => {
    const spy = vi.spyOn(performance, 'now');
    let t = 1000;
    spy.mockImplementation(() => t);
    try {
      const d = new AudioDirector({ storage: fakeStorage() });
      const b = fakeBackend();
      d.attach(b);
      d.setCatalog(catalog());
      d.markUnlocked();
      d.sfx('ui_move');
      t += 1000; // performance.now 前進 1 秒：可以再播（Date.now 幾乎沒變，若用 Date.now 會被擋）
      d.sfx('ui_move');
      t += 5;
      d.sfx('ui_move');
      expect(b.plays.map((p) => p[0])).toEqual(['ui_move', 'ui_move']);
    } finally {
      spy.mockRestore();
    }
  });
  it('被間隔擋下的不算靜音也不算壞掉', () => {
    let t = 0;
    const d = new AudioDirector({ storage: fakeStorage(), now: () => t });
    d.attach(fakeBackend());
    d.setCatalog(catalog());
    d.markUnlocked();
    d.sfx('ui_move');
    d.sfx('ui_move');
    expect(d.info().broken).toEqual([]);
  });
});

describe('解鎖與載入', () => {
  it('解鎖前的音效直接丟掉（不延後補播）；解鎖後才預載音效包', () => {
    const d = new AudioDirector({ storage: fakeStorage() });
    const b = fakeBackend();
    d.attach(b);
    d.setCatalog(catalog());
    d.sfx('ui_move');
    expect(b.plays).toEqual([]);
    expect(b.preloaded).toEqual([]);
    expect(d.info().unlocked).toBe(false);
    d.markUnlocked();
    expect(d.info().unlocked).toBe(true);
    expect(b.preloaded.sort()).toEqual(['text_tick', 'ui_confirm', 'ui_move']); // 只預載有檔案的 sfx
    d.sfx('ui_move');
    expect(b.plays).toHaveLength(1);
  });
  it('目錄比解鎖晚到時，在目錄到的那一刻才預載', () => {
    const d = new AudioDirector({ storage: fakeStorage() });
    const b = fakeBackend();
    d.attach(b);
    d.markUnlocked();
    expect(b.preloaded).toEqual([]);
    d.setCatalog(catalog());
    expect(b.preloaded.length).toBe(3);
  });
  it('重複 markUnlocked 不會重複預載', () => {
    const { d, b } = ready();
    d.markUnlocked();
    expect(b.preloaded.length).toBe(3);
  });
});

describe('失敗容錯：只 warn 一次、保持安靜、絕不丟例外', () => {
  it('沒有後端、沒有目錄、未知 cue：都不丟例外', () => {
    const d = new AudioDirector({ storage: null });
    expect(() => d.sfx('ui_move')).not.toThrow();
    d.attach(fakeBackend());
    d.markUnlocked();
    expect(() => d.sfx('ui_move')).not.toThrow();
    d.setCatalog(catalog());
    expect(() => d.sfx('nope')).not.toThrow();
    expect(() => d.sfx('nope')).not.toThrow();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('nope'))).toHaveLength(1);
  });
  it('不合法的目錄：warn 一次，之後所有 cue 都安靜', () => {
    const d = new AudioDirector({ storage: null });
    const b = fakeBackend();
    d.attach(b);
    d.markUnlocked();
    d.setCatalog({ version: 99 });
    d.sfx('ui_move');
    expect(b.plays).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('後端播放丟錯：warn 一次，該 cue 標為壞掉、之後不再嘗試', () => {
    const { d, b } = ready({ throwOn: 'ui_move' });
    d.sfx('ui_move');
    d.sfx('ui_move');
    d.sfx('ui_confirm');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(b.plays).toEqual([['ui_confirm', 1]]);
  });
  it('後端回報載入失敗（reportBroken）：warn 一次，之後不再播', () => {
    const { d, b } = ready();
    d.reportBroken('ui_move', new Error('404'));
    d.reportBroken('ui_move', new Error('404'));
    d.sfx('ui_move');
    expect(b.plays).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('info()：E2E 讀的唯讀摘要', () => {
  it('包含後端種類、解鎖、設定、最近音效、提示', () => {
    const { d } = ready();
    d.noteHint('已靜音');
    const i = d.info();
    expect(i).toMatchObject({ backend: 'fake', unlocked: true, settings: AUDIO_DEFAULTS, lastSfx: [], hint: '已靜音', catalog: true });
    i.lastSfx.push('x');
    expect(d.info().lastSfx).toEqual([]); // 回傳的是複本
  });
});

// ── M6 P3：背景音樂與環境音 ──
const musicCatalog = () => ({
  version: 1,
  defaults: { title: 'bgm_theme', map: 'bgm_city', dream: 'bgm_dream', battle: 'bgm_battle', game_over: null, map_amb: null, dream_amb: null },
  events: {},
  cues: {
    bgm_theme: { kind: 'bgm', src: 'bgm/bgm_theme', loop: true, len: 74, credit: 'w' },
    bgm_city: { kind: 'bgm', src: 'bgm/bgm_city', loop: true, len: 86, volume: 0.9, credit: 'n' },
    bgm_dream: { kind: 'bgm', src: 'bgm/bgm_dream', loop: true, len: 78, credit: 'a' },
    bgm_battle: { kind: 'bgm', src: 'bgm/bgm_battle', loop: true, len: 40, credit: 'w' },
    bgm_boss: { kind: 'bgm', src: 'bgm/bgm_boss', loop: true, len: 54, credit: 'e' },
    amb_rain: { kind: 'amb', src: 'amb/amb_rain', loop: true, len: 27, credit: 'y', scatter: [{ cue: 'sfx_bell_far', every: [60, 120] }] },
    amb_harbor: { kind: 'amb', src: 'amb/amb_harbor', loop: true, len: 40, credit: 'r', scatter: [{ cue: 'sfx_horn', every: [40, 90] }] },
    sfx_bell_far: { kind: 'sfx', synth: 'bell', volume: 0.3 },
    sfx_horn: { kind: 'sfx', synth: 'foghorn', volume: 0.5 },
  },
});

function loopBackend({ throwOn = null, pauseAt = 12.5 } = {}) {
  const b = fakeBackend();
  b.loops = [];
  b.playLoop = function (ch, id, opts) {
    if (id === throwOn) throw new Error('boom');
    this.loops.push(['play', ch, id, { ...opts }]);
  };
  b.stopLoop = function (ch, opts) { this.loops.push(['stop', ch, { ...opts }]); };
  b.pauseLoop = function (ch, opts) { this.loops.push(['pause', ch, { ...opts }]); return pauseAt; };
  b.duck = function (ch, level, opts) { this.loops.push(['duck', ch, level, { ...opts }]); };
  b.clearPaused = function (ch) { this.loops.push(['clearPaused', ch]); };
  b.playSynth = function (name, gain, ch) { this.synths.push([name, gain, ch]); };
  return b;
}

function fakeTimers() {
  const t = { list: [], next: 1 };
  t.set = (fn, ms) => { const id = t.next++; t.list.push({ id, fn, ms }); return id; };
  t.clear = (id) => { t.list = t.list.filter((x) => x.id !== id); };
  t.fire = () => { const all = t.list; t.list = []; for (const x of all) x.fn(); };
  return t;
}

function musicReady({ unlock = true, rng = () => 0.5, ...opts } = {}) {
  const timers = fakeTimers();
  const d = new AudioDirector({ storage: fakeStorage(), timers: { set: timers.set, clear: timers.clear }, rng });
  const b = loopBackend(opts);
  d.attach(b);
  d.setCatalog(musicCatalog());
  if (unlock) d.markUnlocked();
  return { d, b, timers };
}
const plays = (b) => b.loops.filter((x) => x[0] === 'play').map((x) => [x[1], x[2], x[3].offset ?? 0]);

describe('背景音樂與環境音（M6 P3）', () => {
  it('解鎖前只記下想播的；解鎖後才播，而且只播最後一次的畫面', () => {
    const { d, b } = musicReady({ unlock: false });
    d.setScene({ scene: 'Title' });
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    expect(b.loops).toEqual([]);
    expect(d.info()).toMatchObject({ bgm: null, amb: null });
    d.markUnlocked();
    expect(plays(b)).toEqual([['bgm', 'bgm_city', 0], ['amb', 'amb_rain', 0]]);
    expect(d.info()).toMatchObject({ bgm: 'bgm_city', amb: 'amb_rain', battle: false });
  });
  it('目錄晚到：先記下畫面，目錄載入後才播', () => {
    const d = new AudioDirector({ storage: fakeStorage(), timers: fakeTimers() });
    const b = loopBackend();
    d.attach(b);
    d.markUnlocked();
    d.setScene({ scene: 'Title' });
    expect(b.loops).toEqual([]);
    d.setCatalog(musicCatalog());
    expect(plays(b)).toEqual([['bgm', 'bgm_theme', 0]]);
  });
  it('同一首不重播（辦公室走到街道都是 bgm_city）；只換環境音', () => {
    const { d, b } = musicReady();
    d.setScene({ scene: 'Map', map: { id: 'office' } });
    b.loops = [];
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    expect(b.loops.map((x) => x.slice(0, 3))).toEqual([['play', 'amb', 'amb_rain']]);
  });
  it('換曲：舊曲淡出 0.6 秒、新曲淡入 0.8 秒；環境音交叉淡化 1 秒；改成 null 只停不播', () => {
    const { d, b } = musicReady();
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    b.loops = [];
    d.setScene({ scene: 'Map', map: { id: 'dock', bgm: null, amb: 'amb_harbor' } });
    expect(b.loops).toEqual([
      ['stop', 'bgm', { fadeOut: 0.6 }],
      ['stop', 'amb', { fadeOut: 1 }],
      ['play', 'amb', 'amb_harbor', { fadeIn: 1, offset: 0 }],
    ]);
    b.loops = [];
    d.setScene({ scene: 'Title' });
    expect(b.loops).toEqual([
      ['play', 'bgm', 'bgm_theme', { fadeIn: 0.8, offset: 0 }],
      ['stop', 'amb', { fadeOut: 1 }],
    ]);
  });
  it('選單等「不換」的畫面不動聲音', () => {
    const { d, b } = musicReady();
    d.setScene({ scene: 'Map', map: { id: 'office' } });
    b.loops = [];
    d.setScene({ scene: 'Menu' });
    expect(b.loops).toEqual([]);
  });
  it('戰鬥：地圖曲暫停並記住位置、戰鬥曲從頭、環境音壓到 30%；結束回地圖時從原位置接回、環境音恢復', () => {
    const { d, b } = musicReady({ pauseAt: 12.5 });
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    b.loops = [];
    d.setScene({ scene: 'Battle', encounter: { id: 'e1' } });
    expect(b.loops).toEqual([
      ['pause', 'bgm', { fadeOut: 0.3 }],
      ['play', 'bgm', 'bgm_battle', { fadeIn: 0.3, offset: 0 }],
      ['duck', 'amb', 0.3, { ramp: 0.5 }],
    ]);
    expect(d.info()).toMatchObject({ bgm: 'bgm_battle', amb: 'amb_rain', battle: true, paused: { id: 'bgm_city', offset: 12.5 } });
    b.loops = [];
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    expect(b.loops).toEqual([
      ['stop', 'bgm', { fadeOut: 0.6 }],
      ['play', 'bgm', 'bgm_city', { fadeIn: 0.8, offset: 12.5 }],
      ['duck', 'amb', 1, { ramp: 1 }],
    ]);
    expect(d.info()).toMatchObject({ bgm: 'bgm_city', battle: false, paused: null });
  });
  it('Boss 戰用遭遇指定的曲子', () => {
    const { d, b } = musicReady();
    d.setScene({ scene: 'Map', map: { id: 'office' } });
    d.setScene({ scene: 'Battle', encounter: { id: 'boss', bgm: 'bgm_boss' } });
    expect(plays(b).at(-1)).toEqual(['bgm', 'bgm_boss', 0]);
  });
  it('戰敗 → GameOver：全部停下、丟掉暫停的地圖曲；重新挑戰時戰鬥曲從頭；贏了回地圖時地圖曲從頭', () => {
    const { d, b } = musicReady();
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    d.setScene({ scene: 'Battle', encounter: { id: 'e1' } });
    b.loops = [];
    d.setScene({ scene: 'GameOver' });
    expect(b.loops).toEqual([
      ['stop', 'bgm', { fadeOut: 0.6 }],
      ['clearPaused', 'bgm'],
      ['stop', 'amb', { fadeOut: 1 }],
      ['duck', 'amb', 1, { ramp: 1 }],
    ]);
    expect(d.info()).toMatchObject({ bgm: null, amb: null, battle: false, paused: null });
    b.loops = [];
    d.setScene({ scene: 'Battle', encounter: { id: 'e1' } });
    expect(plays(b)).toEqual([['bgm', 'bgm_battle', 0]]);
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    expect(plays(b).slice(1)).toEqual([['bgm', 'bgm_city', 0], ['amb', 'amb_rain', 0]]);
  });
  it('不存在或種類不對的 cue：warn 一次、當作安靜，不丟錯', () => {
    const { d, b } = musicReady();
    expect(() => d.setScene({ scene: 'Map', map: { id: 'x', bgm: 'bgm_nope', amb: 'bgm_city' } })).not.toThrow();
    expect(b.loops).toEqual([]);
    d.setScene({ scene: 'Map', map: { id: 'y', bgm: 'bgm_nope' } });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('bgm_nope'))).toHaveLength(1);
    expect(d.info()).toMatchObject({ bgm: null, amb: null });
  });
  it('後端丟錯：warn、不外漏；之後其他曲子照常', () => {
    const { d, b } = musicReady({ throwOn: 'bgm_city' });
    expect(() => d.setScene({ scene: 'Map', map: { id: 'office' } })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    d.setScene({ scene: 'Title' });
    expect(plays(b)).toEqual([['bgm', 'bgm_theme', 0]]);
  });
  it('每次換曲記一筆（E2E 比對換場景的序列）', () => {
    const { d } = musicReady();
    d.setScene({ scene: 'Title' });
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    expect(d.info().music.map((m) => [m.bgm, m.amb, m.battle])).toEqual([['bgm_theme', null, false], ['bgm_city', 'amb_rain', false]]);
  });
});

describe('隨機單次音（遠方鐘聲、霧笛；M6 P3）', () => {
  it('環境音開始後排程；時間＝最短＋亂數×（最長−最短）；響的時候走環境音通道；響完再排下一次', () => {
    const { d, timers } = musicReady({ rng: () => 0.25 });
    d.setScene({ scene: 'Map', map: { id: 'dock', bgm: null, amb: 'amb_harbor' } });
    expect(timers.list.map((t) => t.ms)).toEqual([(40 + 0.25 * 50) * 1000]);
    timers.fire();
    expect(d.backend.synths).toEqual([['foghorn', 0.5, 'amb']]);
    expect(timers.list).toHaveLength(1);
    expect(d.info().scatter).toEqual(['sfx_horn']);
  });
  it('換環境音時取消舊的排程；換到沒有單次音的環境音就不排', () => {
    const { d, timers } = musicReady();
    d.setScene({ scene: 'Map', map: { id: 'dock', bgm: null, amb: 'amb_harbor' } });
    d.setScene({ scene: 'Map', map: { id: 'street', amb: 'amb_rain' } });
    expect(timers.list.map((t) => t.ms)).toEqual([90000]);
    d.setScene({ scene: 'Title' });
    expect(timers.list).toEqual([]);
  });
  it('戰鬥中不響（暫停排程），回到地圖再排', () => {
    const { d, timers } = musicReady();
    d.setScene({ scene: 'Map', map: { id: 'dock', bgm: null, amb: 'amb_harbor' } });
    d.setScene({ scene: 'Battle', encounter: { id: 'e' } });
    expect(timers.list).toEqual([]);
    d.setScene({ scene: 'Map', map: { id: 'dock', bgm: null, amb: 'amb_harbor' } });
    expect(timers.list).toHaveLength(1);
  });
  it('環境音音量 0、全部靜音、分頁隱藏時，到時間也不響（但繼續排下一次）', () => {
    const { d, timers } = musicReady();
    d.setScene({ scene: 'Map', map: { id: 'dock', bgm: null, amb: 'amb_harbor' } });
    d.setSettings({ ...d.settings, amb: 0 });
    timers.fire();
    d.setSettings({ ...d.settings, amb: 2, mute: true });
    timers.fire();
    d.setSettings({ ...d.settings, mute: false });
    d.setHidden(true);
    timers.fire();
    expect(d.backend.synths).toEqual([]);
    expect(timers.list).toHaveLength(1);
    d.setHidden(false);
    timers.fire();
    expect(d.backend.synths).toHaveLength(1);
  });
});

describe('第 1 輪審查修正（M6 P3）', () => {
  it('解鎖時最後一個畫面是選單（不換曲）：仍播上一個畫面（標題）的曲子', () => {
    const { d, b } = musicReady({ unlock: false });
    d.setScene({ scene: 'Title' });
    d.setScene({ scene: 'Menu' });
    d.markUnlocked();
    expect(plays(b)).toEqual([['bgm', 'bgm_theme', 0]]);
  });
  it('context 沒有在跑（iOS 中斷、resume 被拒）時，單次音到時間也不送出，只排下一次', () => {
    const { d, timers } = musicReady();
    d.backend.isRunning = () => false;
    d.setScene({ scene: 'Map', map: { id: 'dock', bgm: null, amb: 'amb_harbor' } });
    timers.fire();
    timers.fire();
    expect(d.backend.synths).toEqual([]);
    expect(timers.list).toHaveLength(1);
    d.backend.isRunning = () => true;
    timers.fire();
    expect(d.backend.synths).toHaveLength(1);
  });
});
