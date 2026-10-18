// 存檔 v4（DATA-FORMAT「第一部完結」）：promotions（晉升紀錄）與 ending（結局 id）、v3→v4 遷移、讀檔驗證。
import { describe, it, expect } from 'vitest';
import { CURRENT_VERSION, serialize, deserialize, migrations, sanitizeLoadedState, MAX_PROMOTIONS } from '../../web/src/core/save.js';
import { newGame } from '../../web/src/core/state.js';

const manifest = { chapters: ['chapter3', 'finale'], start: { map: 'attic', spawn: 'default' } };
const maps = [{ id: 'attic', name: '閣樓', tiles: ['....', '....'], legend: { '.': 'floor' }, spawns: [{ id: 'default', x: 1, y: 1, dir: 'down' }] }];
const data = {
  manifest, maps, tiles: [{ id: 'floor', solid: false }],
  lineages: [{ id: 'trace', ranks: [{ rank: 9, name: '讀痕者' }, { rank: 8, name: '借聲者' }] }],
  story: [{ id: 'chapter3' }, { id: 'finale', endings: [{ id: 'lamp_kept', title: '燈火未熄', dialogue: 'd' }, { id: 'dawn', title: '黎明之前', dialogue: 'd' }] }],
};
const game = (over = {}) => ({ ...newGame({ name: '艾琳', manifest, maps }), ...over });
const v3Save = (over = {}) => {
  const { promotions, ending, ...rest } = game();
  return { ...rest, schema_version: 3, ...over };
};

describe('存檔 v4：遷移', () => {
  it('目前版本是 4', () => {
    expect(CURRENT_VERSION).toBe(4);
  });

  it('migrations[3]：v3 → v4 補 promotions: []、ending: null，不修改輸入', () => {
    const v3 = v3Save();
    const snapshot = structuredClone(v3);
    const v4 = migrations[3](v3);
    expect(v4.schema_version).toBe(4);
    expect(v4.promotions).toEqual([]);
    expect(v4.ending).toBeNull();
    expect(v3).toEqual(snapshot);
  });

  it('v3 存檔字串經 deserialize 自動遷移成 v4；v3 誤帶的 promotions／ending 一律丟掉', () => {
    const loaded = deserialize(JSON.stringify(v3Save({ lineage: { id: 'trace', rank: 9 } })));
    expect(loaded).toMatchObject({ schema_version: 4, promotions: [], ending: null, lineage: { id: 'trace', rank: 9 } });
    const junk = deserialize(JSON.stringify(v3Save({ promotions: 'x', ending: 5 })));
    expect(junk.promotions).toEqual([]);
    expect(junk.ending).toBeNull();
  });

  it('v1（M1 格式）一路遷移到 v4', () => {
    const { party, ammo, pending, dream_return: _d, promotions, ending, ...v1 } = game();
    const loaded = deserialize(JSON.stringify({ ...v1, schema_version: 1 }));
    expect(loaded).toMatchObject({ schema_version: 4, promotions: [], ending: null, dream_return: null });
  });
});

describe('存檔 v4：serialize／deserialize', () => {
  const promos = [{ lineage: 'trace', rank: 8, forced: false, chapter: 'chapter4' }, { lineage: 'trace', rank: 7, forced: true, chapter: null }];

  it('來回轉換保留 promotions 與 ending', () => {
    const s = game({ lineage: { id: 'trace', rank: 7 }, promotions: promos, ending: 'lamp_kept' });
    expect(deserialize(serialize(s))).toEqual({ ...s, schema_version: 4 });
  });

  it('serialize：舊程式建立的 state（沒有 promotions／ending）寫成 [] 與 null', () => {
    const { promotions, ending, ...old } = game();
    const out = JSON.parse(serialize(old));
    expect(out.promotions).toEqual([]);
    expect(out.ending).toBeNull();
  });

  it.each([
    ['promotions 不是陣列', { promotions: {} }],
    ['promotions 缺欄位', { promotions: [{ lineage: 'trace', rank: 8, forced: false }] }],
    ['promotions 多欄位', { promotions: [{ lineage: 'trace', rank: 8, forced: false, chapter: null, x: 1 }] }],
    ['promotions rank 不是整數', { promotions: [{ lineage: 'trace', rank: '8', forced: false, chapter: null }] }],
    ['promotions forced 不是布林', { promotions: [{ lineage: 'trace', rank: 8, forced: 1, chapter: null }] }],
    ['promotions lineage 空字串', { promotions: [{ lineage: '', rank: 8, forced: false, chapter: null }] }],
    ['promotions chapter 不是字串或 null', { promotions: [{ lineage: 'trace', rank: 8, forced: false, chapter: 3 }] }],
    ['promotions 項目不是物件', { promotions: [null] }],
  ])('%s → corrupt 並指出 promotions', (_, over) => {
    expect(() => deserialize(JSON.stringify({ ...game(), ...over }))).toThrow(/promotions/);
  });

  it('promotions 最多 MAX_PROMOTIONS 筆（防灌爆）', () => {
    const many = Array.from({ length: MAX_PROMOTIONS + 1 }, () => promos[0]);
    expect(() => deserialize(JSON.stringify({ ...game(), promotions: many }))).toThrow(/promotions/);
    expect(deserialize(JSON.stringify({ ...game(), promotions: many.slice(1) })).promotions).toHaveLength(MAX_PROMOTIONS);
  });

  it.each([
    ['數字', 5], ['空字串', ''], ['大寫', 'Lamp'], ['太長', 'a'.repeat(33)], ['物件', {}],
  ])('ending 是%s → corrupt 並指出 ending', (_, v) => {
    expect(() => deserialize(JSON.stringify({ ...game(), ending: v }))).toThrow(/ending/);
  });

  it('v4 存檔缺 promotions 或 ending → corrupt', () => {
    const { promotions, ...noP } = game();
    expect(() => deserialize(JSON.stringify(noP))).toThrow(/promotions/);
    const { ending, ...noE } = game();
    expect(() => deserialize(JSON.stringify(noE))).toThrow(/ending/);
  });
});

describe('存檔 v4：sanitizeLoadedState', () => {
  it('合法的 promotions、ending 原樣保留', () => {
    const s = deserialize(serialize(game({ promotions: [{ lineage: 'trace', rank: 8, forced: true, chapter: 'chapter3' }], ending: 'dawn' })));
    const r = sanitizeLoadedState(s, data);
    expect(r.ok).toBe(true);
    expect(r.state.promotions).toEqual(s.promotions);
    expect(r.state.ending).toBe('dawn');
    expect(r.warnings).toEqual([]);
  });

  it('ending 不在任何章節的 endings 裡（例如改名）→ 改成 null 並警告 ending_reset', () => {
    const s = deserialize(serialize(game({ ending: 'old_end' })));
    const r = sanitizeLoadedState(s, data);
    expect(r.ok).toBe(true);
    expect(r.state.ending).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain('ending_reset');
  });

  it('記憶體中的舊 state（沒有 promotions／ending）補成 [] 與 null', () => {
    const { promotions, ending, ...old } = game();
    const r = sanitizeLoadedState(old, data);
    expect(r.ok).toBe(true);
    expect(r.state.promotions).toEqual([]);
    expect(r.state.ending).toBeNull();
  });
});
