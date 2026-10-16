import { describe, it, expect } from 'vitest';
import { newGame, availableFieldTags, lineageFieldTags, deriveStats, DEFAULT_ECHO_CHARGES } from '../../web/src/core/state.js';
import { CURRENT_VERSION } from '../../web/src/core/save.js';

const manifest = {
  chapters: ['prologue'],
  start: { map: 'attic', spawn: 'default', dialogue: 'dlg_opening' },
  files: { maps: ['attic'], story: ['prologue'], lineages: ['trace'] },
};
const attic = { id: 'attic', spawns: [{ id: 'default', x: 2, y: 3, dir: 'left' }] };
const lineages = [{ id: 'trace', ranks: [
  { rank: 9, field: ['trace', 'smell'], stats: { atk: 1 } },
  { rank: 8, field: ['deep_trace'], stats: { atk: 2 } },
] }];

describe('newGame', () => {
  it('建立符合 DATA-FORMAT 的初始事實狀態', () => {
    const s = newGame({ name: '  艾琳 ', manifest, maps: [attic] });
    expect(s).toEqual({
      schema_version: CURRENT_VERSION,
      player: { name: '艾琳' },
      lineage: null,
      location: { map: 'attic', x: 2, y: 3, dir: 'left' },
      flags: {}, items: {}, echo: { charges: DEFAULT_ECHO_CHARGES }, collapse: 0,
      resonance: {}, chapter: 'prologue', chapter_done: [], playtime_s: 0,
      party: [{ id: 'hero', hp: null, sp: null }], ammo: 0, pending: null,
    });
    expect(DEFAULT_ECHO_CHARGES).toBe(0);
  });
  it('殘響次數讀 manifest.start.echo_charges（預設 0）', () => {
    const m3 = { ...manifest, start: { ...manifest.start, echo_charges: 3 } };
    expect(newGame({ name: 'A', manifest: m3, maps: [attic] }).echo).toEqual({ charges: 3 });
    expect(newGame({ name: 'A', manifest, maps: [attic] }).echo).toEqual({ charges: 0 });
    for (const bad of [-1, 100, 1.5, '3']) {
      const mb = { ...manifest, start: { ...manifest.start, echo_charges: bad } };
      expect(() => newGame({ name: 'A', manifest: mb, maps: [attic] }), String(bad)).toThrow(/echo_charges/);
    }
  });
  it('名字空白時用預設名字', () => {
    expect(newGame({ name: '', manifest, maps: [attic] }).player.name).toBe('雷恩・葛雷');
  });
  it('未提供 maps 時位置只記地圖與 spawn，座標待 enterMap 解析', () => {
    const s = newGame({ name: 'A', manifest });
    expect(s.location).toEqual({ map: 'attic', spawn: 'default', x: null, y: null, dir: 'down' });
  });
  it('manifest 缺 start 或 spawn 找不到就丟錯', () => {
    expect(() => newGame({ name: 'A', manifest: {} })).toThrow(/start/);
    expect(() => newGame({ name: 'A', manifest, maps: [{ id: 'attic', spawns: [] }] })).toThrow(/spawn/);
  });
});

describe('availableFieldTags', () => {
  const data = { lineages };
  const s = (over) => ({ lineage: null, echo: { charges: 0 }, ...over });
  it('沒有譜系也沒有殘響 → 空', () => {
    expect(availableFieldTags(s(), data)).toEqual([]);
  });
  it('殘響 > 0 提供 trace；0 次不提供', () => {
    expect(availableFieldTags(s({ echo: { charges: 1 } }), data)).toEqual(['trace']);
    expect(availableFieldTags(s({ echo: { charges: 0 } }), data)).toEqual([]);
  });
  it('只含已達到的階位（數字越小越強；9 階只拿 9 階）', () => {
    expect(lineageFieldTags(s({ lineage: { id: 'trace', rank: 9 } }), data)).toEqual(['smell', 'trace']);
    expect(lineageFieldTags(s({ lineage: { id: 'trace', rank: 8 } }), data)).toEqual(['deep_trace', 'smell', 'trace']);
  });
  it('聯集且不重複', () => {
    expect(availableFieldTags(s({ lineage: { id: 'trace', rank: 9 }, echo: { charges: 2 } }), data)).toEqual(['smell', 'trace']);
  });
  it('未知譜系不提供任何標籤（不丟錯，畫面不應當機）', () => {
    expect(lineageFieldTags(s({ lineage: { id: 'ghost', rank: 9 } }), data)).toEqual([]);
    expect(lineageFieldTags(s({ lineage: { id: 'trace', rank: 9 } }), {})).toEqual([]);
  });
});

describe('deriveStats（M1 舊介面：轉呼叫 stats.js，算主角）', () => {
  it('沒有譜系、也沒有 characters.json → 全部為 0', () => {
    expect(deriveStats({ lineage: null }, { lineages })).toEqual({ hp: 0, sp: 0, atk: 0, def: 0, spd: 0, will: 0, eva: 0 });
  });
  it('舊介面 (state, data) 與新介面 (charId, state, data) 結果相同：已達到階位的加總', () => {
    const s = { lineage: { id: 'trace', rank: 8 } };
    const st = deriveStats(s, { lineages });
    expect(st.atk).toBe(3);
    expect(deriveStats('hero', s, { lineages })).toEqual(st);
    st.atk = 99;
    expect(lineages[0].ranks[1].stats.atk).toBe(2);
  });
});
