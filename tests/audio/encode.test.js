// 音檔轉檔工具（tools/audio-encode.mjs）的純函式：配方驗證、ffmpeg 參數、峰值解析、CREDITS 產生。
import { describe, it, expect } from 'vitest';
import {
  validateRecipe, sfxFilter, encodeArgs, parseMaxVolume, peakGainDb, renderCredits, ALLOWED_LICENSES,
} from '../../tools/lib/audio-recipe.mjs';

const recipe = () => ({
  version: 1,
  sources: {
    'kenney-interface': {
      title: 'Interface Sounds', author: 'Kenney', license: 'CC0 1.0',
      page: 'https://opengameart.org/content/interface-sounds',
      download: 'https://opengameart.org/sites/default/files/kenney_interfaceSounds.zip',
      sha256: 'f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232',
    },
  },
  outputs: [
    { out: 'sfx/ui_move', source: 'kenney-interface', file: 'Audio/select_001.ogg', use: '選單游標移動' },
  ],
});

describe('validateRecipe', () => {
  it('合法配方通過', () => {
    expect(validateRecipe(recipe())).toEqual([]);
  });
  it('只接受明確允許的授權', () => {
    expect(ALLOWED_LICENSES).toContain('CC0 1.0');
    const r = recipe();
    r.sources['kenney-interface'].license = 'CC-BY 4.0';
    expect(validateRecipe(r).join()).toMatch(/授權/);
  });
  it('來源必須有 https 頁面、下載網址、作者、sha256', () => {
    for (const k of ['page', 'download', 'author', 'sha256']) {
      const r = recipe();
      delete r.sources['kenney-interface'][k];
      expect(validateRecipe(r).length, k).toBeGreaterThan(0);
    }
    const r = recipe();
    r.sources['kenney-interface'].page = 'http://opengameart.org/x';
    expect(validateRecipe(r).length).toBeGreaterThan(0);
  });
  it('輸出：out 格式、不可重複、來源必須存在、file 不可跳出來源資料夾', () => {
    const bad = [
      { out: 'sfx/UI', source: 'kenney-interface', file: 'a.ogg', use: 'x' },
      { out: 'sfx/a', source: 'nope', file: 'a.ogg', use: 'x' },
      { out: 'sfx/b', source: 'kenney-interface', file: '../a.ogg', use: 'x' },
      { out: 'sfx/c', source: 'kenney-interface', file: '/etc/a.ogg', use: 'x' },
      { out: 'sfx/d', source: 'kenney-interface', file: 'a.ogg' },
    ];
    for (const o of bad) {
      const r = recipe();
      r.outputs.push(o);
      expect(validateRecipe(r).length, JSON.stringify(o)).toBeGreaterThan(0);
    }
    const r = recipe();
    r.outputs.push({ ...r.outputs[0] });
    expect(validateRecipe(r).join()).toMatch(/重複/);
  });
  it('裁切參數必須是非負數', () => {
    const r = recipe();
    r.outputs[0].start = -1;
    r.outputs[0].duration = 'x';
    expect(validateRecipe(r).length).toBe(2);
  });
});

describe('sfxFilter：單聲道、去頭尾靜音、可選淡入淡出、音量增益', () => {
  it('預設：轉單聲道 44.1 kHz，頭尾靜音都去掉', () => {
    const f = sfxFilter({});
    expect(f).toContain('aresample=44100');
    expect(f).toContain('aformat=channel_layouts=mono');
    expect(f.match(/silenceremove/g)).toHaveLength(2);
    expect(f.match(/areverse/g)).toHaveLength(2);
    expect(f).not.toContain('volume=');
  });
  it('有增益與淡出時加上 volume 與 afade', () => {
    const f = sfxFilter({ fade_in: 0.02, fade_out: 0.05 }, -4.5);
    expect(f).toContain('volume=-4.50dB');
    expect(f).toContain('afade=t=in:d=0.02');
    expect(f).toContain('afade=t=in:d=0.05'); // 尾端淡出：反轉後淡入再反轉回來
  });
  it('trim:false 不去靜音（例如本來就要保留餘韻的短樂句）', () => {
    expect(sfxFilter({ trim: false })).not.toContain('silenceremove');
  });
});

describe('encodeArgs', () => {
  it('ogg 用 libvorbis、m4a 用 AAC＋faststart；都清掉 metadata、固定可重現', () => {
    const ogg = encodeArgs({ input: 'in.wav', start: 0.5, duration: 1.2, filter: 'anull', out: 'o.ogg', format: 'ogg' });
    expect(ogg).toEqual(expect.arrayContaining(['-ss', '0.5', '-t', '1.2', '-i', 'in.wav', '-c:a', 'libvorbis', '-map_metadata', '-1']));
    expect(ogg.at(-1)).toBe('o.ogg');
    const m4a = encodeArgs({ input: 'in.wav', filter: 'anull', out: 'o.m4a', format: 'm4a' });
    expect(m4a).toEqual(expect.arrayContaining(['-c:a', 'aac', '-movflags', '+faststart']));
    expect(m4a).not.toContain('-ss');
    expect(() => encodeArgs({ input: 'a', filter: 'anull', out: 'o.mp3', format: 'mp3' })).toThrow();
  });
});

describe('峰值正規化', () => {
  it('parseMaxVolume 讀 volumedetect 的 max_volume', () => {
    const log = '[Parsed_volumedetect_5 @ 0x1] mean_volume: -22.1 dB\n[Parsed_volumedetect_5 @ 0x1] max_volume: -6.4 dB\n';
    expect(parseMaxVolume(log)).toBe(-6.4);
    expect(parseMaxVolume('沒有')).toBeNull();
  });
  it('peakGainDb：把峰值拉到目標（預設 −3 dBFS）', () => {
    expect(peakGainDb(-6.4)).toBeCloseTo(3.4);
    expect(peakGainDb(-1, -3)).toBeCloseTo(-2);
    expect(peakGainDb(null)).toBe(0);
  });
});

describe('renderCredits', () => {
  it('每個輸出檔一列：雙格式檔名、用途、素材名稱、作者、授權、來源網址', () => {
    const md = renderCredits(recipe());
    expect(md).toContain('`sfx/ui_move.ogg`');
    expect(md).toContain('`sfx/ui_move.m4a`');
    expect(md).toContain('選單游標移動');
    expect(md).toContain('Kenney');
    expect(md).toContain('CC0 1.0');
    expect(md).toContain('https://opengameart.org/content/interface-sounds');
    expect(md).toMatch(/自動產生/);
  });
});
