// AudioDirector（M6 P1）：注入假後端驗證音量通道、靜音、打字音開關、解鎖、失敗容錯、設定保存。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioDirector } from '../../web/src/audio/director.js';
import { AUDIO_DEFAULTS, AUDIO_SETTINGS_KEY } from '../../web/src/audio/settings.js';

const catalog = () => ({
  version: 1,
  defaults: {},
  cues: {
    ui_move: { kind: 'sfx', src: 'sfx/ui_move', volume: 0.5, credit: 'k' },
    ui_confirm: { kind: 'sfx', src: 'sfx/ui_confirm', credit: 'k' },
    text_tick: { kind: 'sfx', src: 'sfx/text_tick', credit: 'c' },
    sfx_bell: { kind: 'sfx', synth: 'bell' },
    bgm_x: { kind: 'bgm', src: 'bgm/bgm_x', credit: 'k' },
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
  it('lastSfx 只保留最近 30 筆', () => {
    let t = 0;
    const d = new AudioDirector({ storage: fakeStorage(), now: () => t });
    d.attach(fakeBackend());
    d.setCatalog(catalog());
    d.markUnlocked();
    for (let i = 0; i < 40; i++) { t += 100; d.sfx('ui_move'); }
    expect(d.info().lastSfx).toHaveLength(30);
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
