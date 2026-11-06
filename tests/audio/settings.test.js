// 音量設定（M6）：解析容錯、夾到合法範圍、序列化、存取 localStorage 不丟錯、音量換算。
import { describe, it, expect } from 'vitest';
import {
  AUDIO_SETTINGS_KEY, AUDIO_DEFAULTS, LEVEL_MAX,
  parseAudioSettings, serializeAudioSettings, loadAudioSettings, saveAudioSettings,
  levelGain, channelGain, stepLevel, toggleSetting,
} from '../../web/src/audio/settings.js';

describe('預設值（使用者裁決 2026-11-06）', () => {
  it('預設開聲音：音樂 50%、環境音 50%、音效 75%、打字音開', () => {
    expect(AUDIO_DEFAULTS).toEqual({ v: 1, mute: false, bgm: 2, amb: 2, sfx: 3, typing: true });
    expect(LEVEL_MAX).toBe(4);
    expect(levelGain(AUDIO_DEFAULTS.bgm)).toBe(0.5);
    expect(levelGain(AUDIO_DEFAULTS.amb)).toBe(0.5);
    expect(levelGain(AUDIO_DEFAULTS.sfx)).toBe(0.75);
  });
  it('key 用 steel-labyrinth:settings: 前綴，不和存檔（steel-labyrinth:save:）混在一起', () => {
    expect(AUDIO_SETTINGS_KEY).toBe('steel-labyrinth:settings:audio');
  });
  it('預設值物件是凍結的（不會被意外改掉）', () => {
    expect(Object.isFrozen(AUDIO_DEFAULTS)).toBe(true);
  });
});

describe('parseAudioSettings：壞資料一律回預設或夾到合法範圍', () => {
  it('null／空字串／壞 JSON／非物件 → 預設值', () => {
    for (const raw of [null, undefined, '', '{壞', '"字串"', '42', 'null', '[]', '[1,2]']) {
      expect(parseAudioSettings(raw)).toEqual(AUDIO_DEFAULTS);
    }
  });
  it('缺欄位用預設值補上', () => {
    expect(parseAudioSettings('{"v":1,"bgm":4}')).toEqual({ ...AUDIO_DEFAULTS, bgm: 4 });
  });
  it('超出範圍夾到 0～4；小數四捨五入', () => {
    expect(parseAudioSettings('{"v":1,"bgm":9,"amb":-3,"sfx":2.6}')).toMatchObject({ bgm: 4, amb: 0, sfx: 3 });
  });
  it('字串數字可以接受；其他型別（布林、物件、NaN 字串）回預設', () => {
    expect(parseAudioSettings('{"v":1,"bgm":"3"}').bgm).toBe(3);
    expect(parseAudioSettings('{"v":1,"bgm":true,"amb":{},"sfx":"abc"}')).toMatchObject({ bgm: 2, amb: 2, sfx: 3 });
  });
  it('mute／typing 只接受布林，其他回預設', () => {
    expect(parseAudioSettings('{"v":1,"mute":true,"typing":false}')).toMatchObject({ mute: true, typing: false });
    expect(parseAudioSettings('{"v":1,"mute":"yes","typing":0}')).toMatchObject({ mute: false, typing: true });
  });
  it('未知版本（v 不是 1）→ 整份回預設，不猜格式', () => {
    expect(parseAudioSettings('{"v":2,"bgm":4,"mute":true}')).toEqual(AUDIO_DEFAULTS);
    expect(parseAudioSettings('{"bgm":4}')).toEqual(AUDIO_DEFAULTS);
  });
  it('多出來的欄位丟掉', () => {
    expect(Object.keys(parseAudioSettings('{"v":1,"extra":1,"__proto__":{"x":1}}')).sort())
      .toEqual(['amb', 'bgm', 'mute', 'sfx', 'typing', 'v']);
  });
  it('也接受已經是物件的輸入（記憶體中的設定）', () => {
    expect(parseAudioSettings({ v: 1, sfx: 0 })).toEqual({ ...AUDIO_DEFAULTS, sfx: 0 });
  });
});

describe('serialize ↔ parse', () => {
  it('來回一次得到相同的設定', () => {
    const s = { v: 1, mute: true, bgm: 0, amb: 4, sfx: 1, typing: false };
    expect(parseAudioSettings(serializeAudioSettings(s))).toEqual(s);
  });
  it('序列化前也會整理（不合法的值不會寫進去）', () => {
    expect(JSON.parse(serializeAudioSettings({ v: 1, bgm: 99 })).bgm).toBe(4);
  });
});

/** 假的 localStorage：可以設定 getItem／setItem 會不會丟錯。 */
function fakeStorage({ throwGet = false, throwSet = false, init = {} } = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem(k) { if (throwGet) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (throwSet) throw new Error('quota'); m.set(k, String(v)); },
  };
}

describe('loadAudioSettings／saveAudioSettings：儲存空間不能用時不丟例外', () => {
  it('backend 為 null → 預設值；存檔回 false', () => {
    expect(loadAudioSettings(null)).toEqual(AUDIO_DEFAULTS);
    expect(saveAudioSettings(null, AUDIO_DEFAULTS)).toBe(false);
  });
  it('getItem／setItem 丟錯 → 預設值／false，不往外丟', () => {
    expect(loadAudioSettings(fakeStorage({ throwGet: true }))).toEqual(AUDIO_DEFAULTS);
    expect(saveAudioSettings(fakeStorage({ throwSet: true }), AUDIO_DEFAULTS)).toBe(false);
  });
  it('正常存取：寫入 key 後讀回相同設定', () => {
    const st = fakeStorage();
    const s = { ...AUDIO_DEFAULTS, mute: true, sfx: 1 };
    expect(saveAudioSettings(st, s)).toBe(true);
    expect(JSON.parse(st.m.get(AUDIO_SETTINGS_KEY))).toEqual(s);
    expect(loadAudioSettings(st)).toEqual(s);
  });
});

describe('音量換算', () => {
  it('levelGain：0～4 → 0、0.25、0.5、0.75、1；不合法的值夾住', () => {
    expect([0, 1, 2, 3, 4].map(levelGain)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(levelGain(-1)).toBe(0);
    expect(levelGain(7)).toBe(1);
  });
  it('channelGain：靜音時一律 0；打字音關閉時 typing 通道為 0，開啟時跟著音效音量', () => {
    const s = { ...AUDIO_DEFAULTS };
    expect(channelGain('bgm', s)).toBe(0.5);
    expect(channelGain('sfx', s)).toBe(0.75);
    expect(channelGain('typing', s)).toBe(0.75);
    expect(channelGain('typing', { ...s, typing: false })).toBe(0);
    for (const ch of ['bgm', 'amb', 'sfx', 'typing']) expect(channelGain(ch, { ...s, mute: true })).toBe(0);
  });
  it('channelGain：未知通道回 0', () => {
    expect(channelGain('voice', AUDIO_DEFAULTS)).toBe(0);
  });
});

describe('設定畫面的調整動作（純函式，回新物件）', () => {
  it('stepLevel：加減一格並夾在 0～4；wrap 時 4 再加一格回到 0', () => {
    const s = { ...AUDIO_DEFAULTS };
    expect(stepLevel(s, 'bgm', 1).bgm).toBe(3);
    expect(stepLevel({ ...s, bgm: 4 }, 'bgm', 1).bgm).toBe(4);
    expect(stepLevel({ ...s, bgm: 0 }, 'bgm', -1).bgm).toBe(0);
    expect(stepLevel({ ...s, bgm: 4 }, 'bgm', 1, { wrap: true }).bgm).toBe(0);
    expect(s.bgm).toBe(2); // 不改原物件
  });
  it('stepLevel：不是音量通道就原樣回傳', () => {
    const s = { ...AUDIO_DEFAULTS };
    expect(stepLevel(s, 'mute', 1)).toEqual(s);
  });
  it('toggleSetting：mute／typing 反轉；其他欄位不動', () => {
    expect(toggleSetting(AUDIO_DEFAULTS, 'mute').mute).toBe(true);
    expect(toggleSetting(AUDIO_DEFAULTS, 'typing').typing).toBe(false);
    expect(toggleSetting(AUDIO_DEFAULTS, 'bgm')).toEqual(AUDIO_DEFAULTS);
  });
});
