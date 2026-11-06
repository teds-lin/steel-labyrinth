// 音訊目錄（web/audio/catalog.json）的驗證規則與格式選擇（M6）。
import { describe, it, expect } from 'vitest';
import { validateCatalog, chooseFormats, cueUrls, AUDIO_FORMATS, SYNTHS } from '../../web/src/audio/catalog.js';

const ok = () => ({
  version: 1,
  defaults: { map: null, battle: null },
  cues: {
    ui_move: { kind: 'sfx', src: 'sfx/ui_move', volume: 0.8, credit: 'kenney-interface' },
    bgm_x: { kind: 'bgm', src: 'bgm/bgm_x', loop: true, credit: 'someone' },
    sfx_bell: { kind: 'sfx', synth: 'bell' },
  },
});

const errs = (c) => validateCatalog(c).errors.join('\n');

describe('validateCatalog', () => {
  it('合法目錄通過', () => {
    expect(validateCatalog(ok())).toEqual({ ok: true, errors: [] });
  });
  it('不是物件／版本不對／沒有 cues', () => {
    expect(validateCatalog(null).ok).toBe(false);
    expect(errs({ ...ok(), version: 2 })).toMatch(/version/);
    expect(errs({ version: 1 })).toMatch(/cues/);
  });
  it('cue id 只能是小寫英數與底線', () => {
    const c = ok();
    c.cues['UI-Move'] = { kind: 'sfx', src: 'sfx/x', credit: 'a' };
    expect(errs(c)).toMatch(/UI-Move/);
  });
  it('kind 只能是 bgm／amb／sfx', () => {
    const c = ok();
    c.cues.ui_move.kind = 'voice';
    expect(errs(c)).toMatch(/kind/);
  });
  it('src 與 synth 必須剛好一個；src 必須放在同 kind 的資料夾、不含副檔名或 ..', () => {
    for (const bad of [
      { kind: 'sfx', credit: 'a' },
      { kind: 'sfx', src: 'sfx/a', synth: 'bell', credit: 'a' },
      { kind: 'sfx', src: 'bgm/a', credit: 'a' },
      { kind: 'sfx', src: 'sfx/a.ogg', credit: 'a' },
      { kind: 'sfx', src: 'sfx/../a', credit: 'a' },
      { kind: 'sfx', src: '/sfx/a', credit: 'a' },
    ]) {
      const c = ok();
      c.cues.bad = bad;
      expect(validateCatalog(c).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('有 src 就必須有 credit（授權追溯）', () => {
    const c = ok();
    delete c.cues.ui_move.credit;
    expect(errs(c)).toMatch(/credit/);
  });
  it('synth 名稱必須是已知的程序合成', () => {
    expect(SYNTHS).toContain('bell');
    const c = ok();
    c.cues.sfx_bell.synth = 'rain_magic';
    expect(errs(c)).toMatch(/synth/);
  });
  it('volume 介於 0～1；loop 是布林', () => {
    const c = ok();
    c.cues.ui_move.volume = 1.5;
    c.cues.bgm_x.loop = 'yes';
    const e = errs(c);
    expect(e).toMatch(/volume/);
    expect(e).toMatch(/loop/);
  });
  it('defaults 的值只能是 null 或存在的 cue id', () => {
    const c = ok();
    c.defaults.map = 'bgm_missing';
    expect(errs(c)).toMatch(/bgm_missing/);
  });
});

describe('validateCatalog：events（事件鍵 → cue 的對應表，M6 P2）', () => {
  it('合法：值是存在的 sfx cue 或 null（刻意不發聲）', () => {
    const c = ok();
    c.events = { 'battle.hit': 'ui_move', 'map.change': null, 'battle.victory': 'sfx_bell' };
    expect(validateCatalog(c)).toEqual({ ok: true, errors: [] });
  });
  it('events 不是物件、鍵格式不對、值不是存在的 cue、值是 bgm 都擋下', () => {
    for (const events of [[], 'x', { 'Battle Hit': 'ui_move' }, { 'battle.hit': 'nope' }, { 'battle.hit': 'bgm_x' }, { 'battle.hit': 3 }]) {
      const c = ok();
      c.events = events;
      expect(validateCatalog(c).ok, JSON.stringify(events)).toBe(false);
    }
  });
});

describe('validateCatalog：burst（同時發聲上限的優先序）', () => {
  it('只能是 priority（不受上限）或 exempt（不受上限也不佔額度）', () => {
    const c = ok();
    c.cues.ui_move.burst = 'priority';
    c.cues.sfx_bell.burst = 'exempt';
    expect(validateCatalog(c).ok).toBe(true);
    c.cues.ui_move.burst = 'high';
    expect(validateCatalog(c).errors.join()).toMatch(/burst/);
  });
});

describe('chooseFormats／cueUrls', () => {
  it('格式只有 ogg 與 m4a', () => {
    expect(AUDIO_FORMATS).toEqual(['ogg', 'm4a']);
  });
  it('支援 Ogg Vorbis：先 ogg、失敗退 m4a；不支援：只用 m4a', () => {
    expect(chooseFormats((t) => (t.includes('ogg') ? 'probably' : ''))).toEqual(['ogg', 'm4a']);
    expect(chooseFormats(() => '')).toEqual(['m4a']);
    expect(chooseFormats(() => { throw new Error('x'); })).toEqual(['m4a']);
  });
  it('cueUrls 依格式順序補上副檔名；合成音沒有網址', () => {
    const c = ok();
    expect(cueUrls(c.cues.ui_move, ['ogg', 'm4a'], 'audio/')).toEqual(['audio/sfx/ui_move.ogg', 'audio/sfx/ui_move.m4a']);
    expect(cueUrls(c.cues.sfx_bell, ['ogg', 'm4a'], 'audio/')).toEqual([]);
  });
});
