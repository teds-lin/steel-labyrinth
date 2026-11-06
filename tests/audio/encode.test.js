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

// ── M6 P3：背景音樂與環境音（響度正規化、循環交叉淡化、立體聲、MIDI 渲染） ──
import { loopFilter, parseLoudness, loudnessGainDb, measureArgs, inputSpan, kindOfOut, fluidsynthArgs, ALLOWED_SOUNDFONT_LICENSES, xfadeCurve } from '../../tools/lib/audio-recipe.mjs';
import { crossfadeReport } from '../../tools/lib/audio-loop.mjs';

const loopRecipe = () => {
  const r = recipe();
  r.sources['northivanastan-death-waltz'] = {
    title: 'Death Waltz', author: 'northivanastan', license: 'CC0 1.0',
    page: 'https://opengameart.org/content/death-waltz',
    download: 'https://opengameart.org/sites/default/files/death_waltz.mid',
    sha256: '6f93e584e22314e5bb2cd175654a1917f4806393ed5545bcdb007a838526d599',
  };
  r.soundfonts = {
    'fluidr3-gm': {
      title: 'FluidR3_GM', author: 'Frank Wen', license: 'MIT',
      page: 'https://packages.debian.org/sid/fluid-soundfont-gm',
      download: 'https://deb.debian.org/debian/pool/main/f/fluid-soundfont/fluid-soundfont-gm_3.1-6_all.deb',
      sha256: '9965fbcc6acee17d6f72b685d28c7f968ec64eba14645445b476d5c6cc2eee4c',
      file: 'usr/share/sounds/sf2/FluidR3_GM.sf2',
      file_sha256: '74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0',
      notice: 'Copyright (c) 2000-2002, 2008 Frank Wen\n\nPermission is hereby granted ...',
    },
  };
  r.renders = [{
    id: 'city_waltz', source: 'northivanastan-death-waltz', midi: 'death_waltz.mid', soundfont: 'fluidr3-gm',
    fromBar: 12, toBar: 60, repeats: 2, tracks: { 1: { channel: 6 } }, channels: { 0: { program: 21 }, 5: { drop: true } },
  }];
  r.outputs.push(
    { out: 'bgm/bgm_city', source: 'northivanastan-death-waltz', file: 'render/city_waltz.wav', loudness: -20, channels: 2, use: '日常探索' },
    { out: 'amb/amb_rain', source: 'kenney-interface', file: 'a.ogg', start: 1, duration: 26, xfade: 2, loudness: -26, use: '雨' },
  );
  return r;
};

describe('validateRecipe（P3）', () => {
  it('合法的 BGM／環境音／MIDI 渲染配方通過', () => {
    expect(validateRecipe(loopRecipe())).toEqual([]);
  });
  it('bgm／amb 一定要用響度正規化（loudness −36～−10 LUFS），不可用峰值或去靜音（會破壞循環長度）', () => {
    const cases = [
      (o) => { delete o.loudness; },
      (o) => { o.loudness = -5; },
      (o) => { o.peak = -3; },
      (o) => { o.trim = true; },
    ];
    for (const f of cases) {
      const r = loopRecipe();
      f(r.outputs.find((o) => o.out === 'amb/amb_rain'));
      expect(validateRecipe(r).length, f.toString()).toBeGreaterThan(0);
    }
  });
  it('sfx 不可用 loudness／xfade（短音效用峰值正規化）', () => {
    const r = loopRecipe();
    r.outputs[0].loudness = -20;
    r.outputs[0].xfade = 1;
    expect(validateRecipe(r).length).toBe(2);
  });
  it('channels 只能是 1 或 2；xfade 需要 duration，且不可超過 duration 的一半', () => {
    for (const f of [(o) => { o.channels = 3; }, (o) => { delete o.duration; }, (o) => { o.xfade = 20; }, (o) => { o.xfade = -1; }]) {
      const r = loopRecipe();
      f(r.outputs.find((o) => o.out === 'amb/amb_rain'));
      expect(validateRecipe(r).length, f.toString()).toBeGreaterThan(0);
    }
  });
  it('音色庫：授權只能是允許清單（MIT）、要有網址、雜湊、檔案位置與授權全文', () => {
    expect(ALLOWED_SOUNDFONT_LICENSES).toEqual(['MIT']);
    for (const k of ['license', 'page', 'download', 'sha256', 'file', 'file_sha256', 'notice', 'author']) {
      const r = loopRecipe();
      if (k === 'license') r.soundfonts['fluidr3-gm'].license = 'GPL-2.0';
      else delete r.soundfonts['fluidr3-gm'][k];
      expect(validateRecipe(r).length, k).toBeGreaterThan(0);
    }
  });
  it('渲染：來源與音色庫必須存在、小節範圍合法、至少重複 2 次（取第 2 次才有前一次的殘響）、id 不重複', () => {
    const cases = [
      (x) => { x.source = 'nope'; },
      (x) => { x.soundfont = 'nope'; },
      (x) => { x.toBar = x.fromBar; },
      (x) => { x.repeats = 1; },
      (x) => { x.midi = '../x.mid'; },
      (x) => { x.id = 'City'; },
    ];
    for (const f of cases) {
      const r = loopRecipe();
      f(r.renders[0]);
      expect(validateRecipe(r).length, f.toString()).toBeGreaterThan(0);
    }
    const r = loopRecipe();
    r.renders.push({ ...r.renders[0] });
    expect(validateRecipe(r).join()).toMatch(/重複/);
  });
  it('輸出引用 render/<id>.wav 時，該渲染必須存在且來源相同', () => {
    const r = loopRecipe();
    r.outputs.find((o) => o.out === 'bgm/bgm_city').file = 'render/nope.wav';
    expect(validateRecipe(r).join()).toMatch(/渲染/);
    const r2 = loopRecipe();
    r2.outputs.find((o) => o.out === 'bgm/bgm_city').source = 'kenney-interface';
    expect(validateRecipe(r2).join()).toMatch(/渲染/);
  });
});

describe('loopFilter：循環素材的濾鏡（不去靜音、保留長度）', () => {
  it('預設單聲道 44.1 kHz；channels: 2 時保留立體聲；沒有 silenceremove', () => {
    expect(loopFilter({ out: 'amb/a' })).toContain('channel_layouts=mono');
    const st = loopFilter({ out: 'bgm/a', channels: 2 });
    expect(st).toContain('channel_layouts=stereo');
    expect(st).toContain('aresample=44100');
    expect(st).not.toContain('silenceremove');
  });
  it('xfade：尾端 xfade 秒疊回開頭（開頭淡入、尾段淡出後相加），輸出長度＝duration', () => {
    const f = loopFilter({ out: 'amb/a', duration: 26, xfade: 2 });
    expect(f).toContain('asplit=2');
    expect(f).toContain('atrim=0:26');
    expect(f).toContain('atrim=26:28');
    expect(f).toContain('amix=inputs=2:normalize=0:duration=first');
    expect(f).toContain('curve=qsin'); // 環境音（不相關的雜訊）用等功率
    expect(loopFilter({ out: 'bgm/a', duration: 40, xfade: 0.5 })).toContain('curve=tri'); // 音樂（重複段落、高度相關）用線性
  });
  it('有增益時最後加 volume', () => {
    expect(loopFilter({ out: 'amb/a' }, 3.25)).toMatch(/volume=3\.25dB$/);
    expect(loopFilter({ out: 'amb/a' })).not.toContain('volume=');
  });
});

describe('inputSpan／kindOfOut', () => {
  it('交叉淡化要多讀 xfade 秒', () => {
    expect(inputSpan({ start: 1, duration: 26, xfade: 2 })).toEqual({ start: 1, duration: 28 });
    expect(inputSpan({ duration: 10 })).toEqual({ start: undefined, duration: 10 });
    expect(inputSpan({})).toEqual({ start: undefined, duration: undefined });
  });
  it('kindOfOut 取 out 的第一段', () => {
    expect(kindOfOut('bgm/bgm_city')).toBe('bgm');
    expect(kindOfOut('sfx/ui_move')).toBe('sfx');
  });
});

describe('encodeArgs（P3）：依種類選位元率與聲道數', () => {
  it('bgm 立體聲、amb 單聲道，位元率依種類', () => {
    const bgm = encodeArgs({ input: 'i', filter: 'anull', out: 'o.ogg', format: 'ogg', kind: 'bgm', channels: 2 });
    expect(bgm).toEqual(expect.arrayContaining(['-ac', '2', '-q:a', '1']));
    const amb = encodeArgs({ input: 'i', filter: 'anull', out: 'o.m4a', format: 'm4a', kind: 'amb', channels: 1 });
    expect(amb).toEqual(expect.arrayContaining(['-ac', '1', '-b:a', '48k']));
    const sfx = encodeArgs({ input: 'i', filter: 'anull', out: 'o.ogg', format: 'ogg' });
    expect(sfx).toEqual(expect.arrayContaining(['-ac', '1', '-q:a', '2']));
  });
});

describe('響度正規化', () => {
  it('parseLoudness 讀 ebur128 摘要的 Integrated loudness', () => {
    const log = '[Parsed_ebur128_3 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -17.6 LUFS\n    Threshold: -27.6 LUFS\n';
    expect(parseLoudness(log)).toBe(-17.6);
    expect(parseLoudness('沒有')).toBeNull();
  });
  it('loudnessGainDb：拉到目標響度，但峰值不得超過 −1 dBFS', () => {
    expect(loudnessGainDb(-24, -10, -20)).toBeCloseTo(4);
    expect(loudnessGainDb(-24, -3, -20)).toBeCloseTo(2); // 峰值 −3 → 最多 +2
    expect(loudnessGainDb(null, -3, -20)).toBe(0);
  });
  it('measureArgs 可同時量響度與峰值', () => {
    const a = measureArgs({ input: 'i', filter: 'anull', loudness: true });
    expect(a.join(' ')).toContain('ebur128=framelog=quiet,volumedetect');
  });
});

describe('fluidsynthArgs', () => {
  it('非互動、輸出檔、44.1 kHz、增益、音色庫、MIDI 檔', () => {
    const a = fluidsynthArgs({ sf2: 's.sf2', mid: 'm.mid', out: 'o.wav', gain: 0.5 });
    expect(a).toEqual(['-ni', '-q', '-F', 'o.wav', '-r', '44100', '-g', '0.5', 's.sf2', 'm.mid']);
  });
});

describe('renderCredits（P3）', () => {
  it('渲染出的音樂註明原曲與音色庫；音色庫的授權全文附在檔尾', () => {
    const md = renderCredits(loopRecipe());
    const line = md.split('\n').find((l) => l.includes('`bgm/bgm_city.ogg`'));
    expect(line).toContain('Death Waltz');
    expect(line).toContain('FluidR3_GM');
    expect(md).toContain('## 音色庫');
    expect(md).toContain('Permission is hereby granted');
    expect(md).toContain('MIT');
  });
});

describe('第 1 輪審查修正（轉檔）', () => {
  it('loopFilter 的交叉淡化完整濾鏡（開頭淡入、尾段淡出、相加不正規化）', () => {
    expect(loopFilter({ out: 'amb/a', duration: 26, xfade: 2 })).toBe(
      'aformat=channel_layouts=mono,aresample=44100,asplit=2[a][b];'
      + '[a]atrim=0:26,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=2:curve=qsin[a1];'
      + '[b]atrim=26:28,asetpts=PTS-STARTPTS,afade=t=out:st=0:d=2:curve=qsin[b1];'
      + '[a1][b1]amix=inputs=2:normalize=0:duration=first',
    );
  });
  it('xfade_curve 可以覆寫預設曲線；只能是 tri 或 qsin', () => {
    expect(xfadeCurve({ out: 'bgm/a' })).toBe('tri');
    expect(xfadeCurve({ out: 'amb/a' })).toBe('qsin');
    expect(xfadeCurve({ out: 'bgm/a', xfade_curve: 'qsin' })).toBe('qsin');
    expect(loopFilter({ out: 'bgm/a', duration: 40, xfade: 0.2, xfade_curve: 'qsin' })).toContain('curve=qsin');
    const r = loopRecipe();
    r.outputs.find((o) => o.out === 'amb/amb_rain').xfade_curve = 'log';
    expect(validateRecipe(r).join()).toMatch(/xfade_curve/);
  });
  it('單聲道素材用 dualmono 量響度（播放時送到左右兩聲道）', () => {
    expect(measureArgs({ input: 'i', filter: 'anull', loudness: true, mono: true }).join(' ')).toContain('ebur128=framelog=quiet:dualmono=true');
    expect(measureArgs({ input: 'i', filter: 'anull', loudness: true }).join(' ')).not.toContain('dualmono');
  });
  it('CREDITS：渲染的音樂授權欄同時寫樂譜 CC0 與音色庫 MIT、作者欄寫音色庫作者', () => {
    const line = renderCredits(loopRecipe()).split('\n').find((l) => l.includes('`bgm/bgm_city.ogg`'));
    expect(line).toContain('CC0 1.0（樂譜）＋MIT（FluidR3_GM 音色庫');
    expect(line).toContain('Frank Wen');
  });
});

describe('crossfadeReport：轉檔前模擬交叉淡化', () => {
  const noise = (n, seed) => { let s = seed; return Float32Array.from({ length: n }, () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1); };
  it('兩段相同：線性曲線沒有凹洞', () => {
    const a = noise(8820, 3);
    const r = crossfadeReport(a, a, 'tri');
    expect(r.corr).toBeCloseTo(1, 6);
    expect(r.worstDb).toBeGreaterThan(-0.1);
  });
  it('兩段不相關：線性曲線中間有約 −3 dB 的凹洞，等功率沒有', () => {
    const a = noise(44100, 3);
    const b = noise(44100, 99);
    expect(crossfadeReport(a, b, 'tri').worstDb).toBeLessThan(-2);
    expect(crossfadeReport(a, b, 'qsin').worstDb).toBeGreaterThan(-1);
  });
  it('兩段反相：線性曲線在中間完全抵消', () => {
    const a = noise(8820, 5);
    const b = a.map((v) => -v);
    expect(crossfadeReport(a, b, 'tri').worstDb).toBeLessThan(-10);
  });
});

describe('crossfadeReport（第 2 輪）：也抓鼓起', () => {
  const noise = (n, seed) => { let s = seed; return Float32Array.from({ length: n }, () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1); };
  it('兩段相同時用等功率曲線：中間鼓起約 +3 dB；線性曲線沒有鼓起', () => {
    const a = noise(8820, 7);
    expect(crossfadeReport(a, a, 'qsin').peakDb).toBeGreaterThan(2);
    expect(crossfadeReport(a, a, 'tri').peakDb).toBeLessThan(0.1);
  });
  it('淡化比窗短時也會檢查（窗長取淡化長度）', () => {
    const a = noise(441, 9);
    expect(crossfadeReport(a, a.map((v) => -v), 'tri').worstDb).toBeLessThan(-3); // 整段一個窗：反相兩段平均約 −4.8 dB
  });
});
