// 資料的聲音欄位（M6 P3）：validate 只檢查型別；check-data 對照音訊目錄檢查 cue 存在與種類；正式資料的配置照計畫。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBundle } from '../../web/src/core/validate.js';
import { loadBundle } from '../../tools/lib/bundle.mjs';
import { checkAudioRefs } from '../../tools/lib/audio-refs.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const load = () => loadBundle(join(ROOT, 'web', 'data')).bundle;
const catalog = JSON.parse(readFileSync(join(ROOT, 'web', 'audio', 'catalog.json'), 'utf8'));

describe('validate：聲音欄位只檢查型別', () => {
  it('正式資料通過', () => {
    expect(validateBundle(load())).toEqual([]);
  });
  it('地圖 bgm／amb、遭遇 bgm、結局 bgm：cue id 字串或 null 合法；其他型別擋下', () => {
    const b = load();
    b.maps[0].bgm = null;
    b.maps[0].amb = 'amb_rain';
    b.encounters[0].bgm = 'bgm_boss';
    const story = b.story.find((s) => Array.isArray(s.endings));
    story.endings[0].bgm = 'bgm_theme';
    expect(validateBundle(b)).toEqual([]);
    b.maps[0].bgm = 3;
    b.maps[0].amb = 'Rain Loud';
    b.encounters[0].bgm = {};
    story.endings[0].bgm = '';
    const errs = validateBundle(b).join('\n');
    for (const k of [`maps/${b.maps[0].id}.json：bgm`, `maps/${b.maps[0].id}.json：amb`, `遭遇「${b.encounters[0].id}」：bgm`, `結局「${story.endings[0].id}」：bgm`]) expect(errs).toContain(k);
  });
  it('不存在的 cue 不會讓遊戲啟動失敗（validate 不查目錄）', () => {
    const b = load();
    b.maps[0].bgm = 'bgm_not_exist';
    expect(validateBundle(b)).toEqual([]);
  });
});

describe('checkAudioRefs：對照音訊目錄', () => {
  it('正式資料的引用全部存在、種類正確', () => {
    expect(checkAudioRefs(load(), catalog)).toEqual([]);
  });
  it('不存在的 cue、種類不對都擋下；null 與沒寫都合法', () => {
    const b = load();
    b.maps[0].bgm = 'bgm_nope';
    b.maps[1].amb = 'bgm_city';
    b.maps[2].bgm = null;
    b.encounters[0].bgm = 'amb_rain';
    const errs = checkAudioRefs(b, catalog).join('\n');
    expect(errs).toContain('bgm_nope');
    expect(errs).toMatch(/amb「bgm_city」是 bgm/);
    expect(errs).toMatch(/bgm「amb_rain」是 amb/);
    expect(checkAudioRefs(b, catalog)).toHaveLength(3);
    b.maps[3].bgm = 5; // 型別錯誤由 validate 報，這裡不重複
    expect(checkAudioRefs(b, catalog)).toHaveLength(3);
  });
});

describe('正式資料的聲音配置（計畫 §1.2／§1.3）', () => {
  it('每張現實地圖都明確寫了環境音（amb，null 也算）；夢境地圖用預設', () => {
    for (const m of load().maps) {
      if (m.dream === true) expect(Object.hasOwn(m, 'amb'), m.id).toBe(false);
      else expect(Object.hasOwn(m, 'amb'), `${m.id} 沒有決定環境音`).toBe(true);
    }
  });
  it('計畫刻意不放背景音樂的場景（碼頭、倉庫、禮拜堂、地下水道、燈塔）明確寫 bgm: null；家、街區、公司用預設的城市曲', () => {
    const quiet = /^(dock|dock_ch6|harbor_night|breakwater|warehouse|chapel_.+|sewer_.+|lighthouse|lighthouse_top)$/;
    const real = load().maps.filter((m) => m.dream !== true);
    expect(real.filter((m) => quiet.test(m.id)).length).toBe(15);
    for (const m of real) {
      if (quiet.test(m.id)) expect(m.bgm, m.id).toBeNull();
      else expect(Object.hasOwn(m, 'bgm'), `${m.id} 應該用預設的城市曲`).toBe(false);
    }
  });
  it('不能逃跑的戰鬥（練習戰除外）都用 Boss 曲；其他戰鬥用預設', () => {
    for (const e of load().encounters) {
      const boss = e.can_flee === false && e.id !== 'enc_sparring';
      expect(e.bgm, e.id).toBe(boss ? 'bgm_boss' : undefined);
    }
  });
});
