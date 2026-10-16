import { describe, it, expect } from 'vitest';
import { CURRENT_VERSION, SLOT_COUNT, KEY_PREFIX, serialize, deserialize, migrations, createStorage } from '../../web/src/core/save.js';
import { newGame } from '../../web/src/core/state.js';

const manifest = { chapters: ['prologue'], start: { map: 'attic', spawn: 'default' } };
const maps = [{ id: 'attic', spawns: [{ id: 'default', x: 1, y: 1, dir: 'down' }] }];
const game = () => ({ ...newGame({ name: '艾琳', manifest, maps }), flags: { door_open: true }, items: { key: 1 } });

function memoryBackend() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const throwingBackend = () => ({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
});

describe('serialize / deserialize', () => {
  it('版本常數', () => {
    expect(CURRENT_VERSION).toBe(1);
    expect(SLOT_COUNT).toBe(3);
    expect(KEY_PREFIX).toBe('steel-labyrinth:save:');
  });
  it('來回轉換保持一致，且寫入目前版本', () => {
    const s = game();
    const str = serialize({ ...s, schema_version: undefined });
    expect(JSON.parse(str).schema_version).toBe(CURRENT_VERSION);
    expect(deserialize(serialize(s))).toEqual(s);
  });
  it('JSON 損壞 → 明確錯誤', () => {
    expect(() => deserialize('{not json')).toThrow(/損壞/);
    expect(() => deserialize('')).toThrow(/損壞/);
    expect(() => deserialize('null')).toThrow(/損壞/);
    expect(() => deserialize('[1,2]')).toThrow(/損壞/);
    expect(() => deserialize(undefined)).toThrow(/損壞/);
  });
  it('未來版本 → 明確錯誤', () => {
    expect(() => deserialize(JSON.stringify({ ...game(), schema_version: 2 }))).toThrow(/版本 2.*較新|較新/);
  });
  it('缺版本或版本不是整數 → 錯誤', () => {
    const { schema_version, ...rest } = game();
    expect(() => deserialize(JSON.stringify(rest))).toThrow(/schema_version/);
    expect(() => deserialize(JSON.stringify({ ...rest, schema_version: '1' }))).toThrow(/schema_version/);
  });
  it('缺欄位 → 指出哪個欄位', () => {
    for (const field of ['player', 'location', 'flags', 'items', 'echo', 'collapse', 'resonance', 'chapter_done', 'playtime_s', 'lineage']) {
      const s = game();
      delete s[field];
      expect(() => deserialize(JSON.stringify(s)), field).toThrow(new RegExp(field));
    }
    const s = game();
    delete s.player.name;
    expect(() => deserialize(JSON.stringify(s))).toThrow(/player\.name/);
    const t = game();
    t.echo = {};
    expect(() => deserialize(JSON.stringify(t))).toThrow(/echo\.charges/);
  });
});

describe('migrations', () => {
  it('0 → 1：把頂層 name 移入 player，補上 echo 與 resonance', () => {
    const v0 = {
      schema_version: 0, name: '舊存檔', lineage: null,
      location: { map: 'attic', x: 1, y: 1, dir: 'down' },
      flags: { a: true }, items: {}, collapse: 10, chapter: 'prologue', chapter_done: [], playtime_s: 60,
    };
    const v1 = migrations[0](structuredClone(v0));
    expect(v1.schema_version).toBe(1);
    expect(v1.player).toEqual({ name: '舊存檔' });
    expect('name' in v1).toBe(false);
    expect(v1.echo).toEqual({ charges: 3 });
    expect(v1.resonance).toEqual({});
    const loaded = deserialize(JSON.stringify(v0));
    expect(loaded.player.name).toBe('舊存檔');
    expect(loaded.flags).toEqual({ a: true });
    expect(loaded.schema_version).toBe(CURRENT_VERSION);
  });
  it('每一個舊版本都有遷移函式', () => {
    for (let v = 0; v < CURRENT_VERSION; v++) expect(typeof migrations[v]).toBe('function');
  });
  it('負數版本沒有遷移 → 錯誤', () => {
    expect(() => deserialize(JSON.stringify({ ...game(), schema_version: -1 }))).toThrow(/遷移/);
  });
});

describe('createStorage', () => {
  it('存、讀、刪單一存檔槽，key 有前綴', () => {
    const be = memoryBackend();
    const st = createStorage(be);
    expect(st.save(1, game())).toEqual({ ok: true });
    expect([...be.m.keys()]).toEqual(['steel-labyrinth:save:1']);
    const r = st.load(1);
    expect(r.ok).toBe(true);
    expect(r.state).toEqual(game());
    expect(st.remove(1)).toEqual({ ok: true });
    expect(st.load(1)).toEqual({ ok: false, reason: 'empty' });
  });
  it('不合法的槽位回 ok:false', () => {
    const st = createStorage(memoryBackend());
    for (const slot of [0, 4, 1.5, '1', null]) {
      expect(st.save(slot, game()).ok).toBe(false);
      expect(st.load(slot).ok).toBe(false);
    }
  });
  it('backend 丟例外時回 { ok:false, reason } 不當機', () => {
    const st = createStorage(throwingBackend());
    const s = st.save(1, game());
    expect(s.ok).toBe(false);
    expect(s.reason).toMatch(/QuotaExceededError/);
    expect(st.load(1).ok).toBe(false);
    expect(st.remove(1).ok).toBe(false);
    expect(st.listSlots()).toHaveLength(3);
    expect(st.listSlots().every((x) => x.ok === false)).toBe(true);
  });
  it('沒有 backend（例如停用 localStorage）也不當機', () => {
    const st = createStorage(null);
    expect(st.save(1, game()).ok).toBe(false);
    expect(st.listSlots()).toHaveLength(3);
  });
  it('槽內是損壞的存檔 → load 回 ok:false 並說明', () => {
    const be = memoryBackend();
    be.setItem('steel-labyrinth:save:2', '{broken');
    const r = createStorage(be).load(2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/損壞/);
  });
  it('序列化失敗（例如循環參照）回 ok:false', () => {
    const s = game();
    s.flags.self = s;
    expect(createStorage(memoryBackend()).save(1, s).ok).toBe(false);
  });
  it('listSlots 給標題畫面：空槽、正常槽、壞槽', () => {
    const be = memoryBackend();
    const st = createStorage(be);
    st.save(1, { ...game(), playtime_s: 125 });
    be.setItem('steel-labyrinth:save:3', JSON.stringify({ schema_version: 9 }));
    expect(st.listSlots()).toEqual([
      { slot: 1, ok: true, empty: false, name: '艾琳', map: 'attic', chapter: 'prologue', playtime_s: 125 },
      { slot: 2, ok: true, empty: true },
      { slot: 3, ok: false, empty: false, reason: expect.stringMatching(/較新/) },
    ]);
  });
});

// ───────────── M1 審查修正：讀檔驗證 ─────────────
import { sanitizeLoadedState } from '../../web/src/core/save.js';
import { DEFAULT_NAME } from '../../web/src/core/name.js';

describe('deserialize：數值格式檢查（DATA-FORMAT「讀檔驗證」）', () => {
  const bad = (mut) => { const s = game(); mut(s); return () => deserialize(JSON.stringify(s)); };
  it('echo.charges 必須是 0～99 的整數', () => {
    for (const v of [-1, 1e9, 100, 1.5]) expect(bad((s) => { s.echo.charges = v; }), String(v)).toThrow(/echo\.charges/);
    for (const v of [0, 99]) expect(bad((s) => { s.echo.charges = v; })).not.toThrow();
  });
  it('collapse 必須是 0～100 的整數', () => {
    for (const v of [-999, 101, 2.5]) expect(bad((s) => { s.collapse = v; }), String(v)).toThrow(/collapse/);
    expect(bad((s) => { s.collapse = 100; })).not.toThrow();
  });
  it('playtime_s 必須 ≥ 0', () => {
    expect(bad((s) => { s.playtime_s = -1; })).toThrow(/playtime_s/);
  });
  it('道具數量必須是正整數（字串、0、負數、小數都拒絕）', () => {
    for (const v of ['1', 0, -2, 1.5, null, true]) expect(bad((s) => { s.items = { key: v }; }), JSON.stringify(v)).toThrow(/items/);
  });
  it('lineage.rank 必須是整數；location.x/y 型別不檢查（交給 sanitizeLoadedState 修復）', () => {
    expect(bad((s) => { s.lineage = { id: 'trace', rank: 'x' }; })).toThrow(/lineage/);
    expect(bad((s) => { delete s.location.x; })).not.toThrow();
  });
  it('原型鍵：欄位查詢不吃原型上的屬性', () => {
    const s = game();
    delete s.flags;
    const str = JSON.stringify(s).replace('{', '{"constructor":1,');
    expect(() => deserialize(str)).toThrow(/flags/);
  });
});

describe('sanitizeLoadedState', () => {
  // 5x3：# 牆、. 地板；(3,1) 有 solid 物件；第一個 spawn 在 (1,1)
  const data = {
    tiles: [{ id: 'wall', solid: true }, { id: 'floor', solid: false }],
    lineages: [{ id: 'trace', ranks: [{ rank: 9, field: ['trace'] }] }],
    maps: [{
      id: 'attic', tiles: ['#####', '#...#', '#####'], legend: { '#': 'wall', '.': 'floor' },
      spawns: [{ id: 'default', x: 1, y: 1, dir: 'down' }, { id: 'b', x: 2, y: 1, dir: 'up' }],
      objects: [{ id: 'crate', x: 3, y: 1, solid: true }, { id: 'door', x: 2, y: 1, solid: true, lock: { flag: 'open' } }],
    }],
  };
  const good = () => ({ ...game(), location: { map: 'attic', x: 1, y: 1, dir: 'down' } });
  it('合法狀態原樣通過、沒有警告、不修改輸入', () => {
    const s = good();
    const before = JSON.stringify(s);
    const r = sanitizeLoadedState(s, data);
    expect(r).toEqual({ ok: true, state: s, warnings: [] });
    expect(JSON.stringify(s)).toBe(before);
  });
  it('名字重新經過 sanitizeName（10 萬字、空白）', () => {
    const r = sanitizeLoadedState({ ...good(), player: { name: '長'.repeat(100000) } }, data);
    expect(r.ok).toBe(true);
    expect(r.state.player.name).toBe('長'.repeat(8));
    expect(r.warnings.length).toBe(1);
    expect(sanitizeLoadedState({ ...good(), player: { name: '   ' } }, data).state.player.name).toBe(DEFAULT_NAME);
  });
  it('譜系：不存在的 id 或未開放的 rank → 拒絕', () => {
    expect(sanitizeLoadedState({ ...good(), lineage: { id: 'trace', rank: 9 } }, data).ok).toBe(true);
    const r1 = sanitizeLoadedState({ ...good(), lineage: { id: 'ghost', rank: 9 } }, data);
    expect(r1.ok).toBe(false);
    expect(r1.reason).toMatch(/譜系|ghost/);
    expect(sanitizeLoadedState({ ...good(), lineage: { id: 'trace', rank: 1 } }, data).ok).toBe(false);
    expect(sanitizeLoadedState({ ...good(), lineage: { id: 'toString', rank: 9 } }, data).ok).toBe(false);
  });
  it('地圖不存在 → 拒絕', () => {
    const r = sanitizeLoadedState({ ...good(), location: { map: 'roof', x: 1, y: 1, dir: 'down' } }, data);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/roof/);
  });
  it('座標缺漏／非整數／超出範圍／在牆裡／在 solid 物件上／方向不合法 → 改放第一個 spawn 並警告', () => {
    const locs = [
      { map: 'attic', dir: 'down' },
      { map: 'attic', x: 1.5, y: 1, dir: 'down' },
      { map: 'attic', x: 99, y: 1, dir: 'down' },
      { map: 'attic', x: -1, y: 1, dir: 'down' },
      { map: 'attic', x: 0, y: 0, dir: 'down' },
      { map: 'attic', x: 3, y: 1, dir: 'down' },
      { map: 'attic', x: 2, y: 1, dir: 'down' }, // 鎖著的門（solid）
      { map: 'attic', x: 1, y: 1, dir: 'north' },
      { map: 'attic', x: 1, y: 1, dir: 'toString' },
      { map: 'attic', x: '1', y: 1, dir: 'down' },
    ];
    for (const location of locs) {
      const r = sanitizeLoadedState({ ...good(), location }, data);
      expect(r.ok, JSON.stringify(location)).toBe(true);
      expect(r.state.location, JSON.stringify(location)).toEqual({ map: 'attic', x: 1, y: 1, dir: 'down' });
      expect(r.warnings.length, JSON.stringify(location)).toBe(1);
    }
  });
  it('已解開的門不算 solid 物件，站在上面不搬移', () => {
    const r = sanitizeLoadedState({ ...good(), flags: { open: true }, location: { map: 'attic', x: 2, y: 1, dir: 'up' } }, data);
    expect(r.warnings).toEqual([]);
    expect(r.state.location).toEqual({ map: 'attic', x: 2, y: 1, dir: 'up' });
  });
  it('輸入不是物件或缺必要欄位 → 拒絕而非丟例外', () => {
    expect(sanitizeLoadedState(null, data).ok).toBe(false);
    expect(sanitizeLoadedState({}, data).ok).toBe(false);
  });
  it('地圖沒有任何 spawn 又需要搬移 → 拒絕', () => {
    const d2 = { ...data, maps: [{ ...data.maps[0], spawns: [] }] };
    expect(sanitizeLoadedState({ ...good(), location: { map: 'attic', x: 0, y: 0, dir: 'down' } }, d2).ok).toBe(false);
  });
});
