import { describe, it, expect } from 'vitest';
import { CURRENT_VERSION, SLOT_COUNT, KEY_PREFIX, serialize, deserialize, migrations, createStorage } from '../../web/src/core/save.js';
import { newGame } from '../../web/src/core/state.js';

const manifest = { chapters: ['prologue'], start: { map: 'attic', spawn: 'default' } };
const maps = [{ id: 'attic', spawns: [{ id: 'default', x: 1, y: 1, dir: 'down' }] }];
// 存檔 v3 起有 dream_return（newGame 由客戶端補上；這裡明確給 null，讓「來回轉換一致」不受 newGame 的版本影響）
const game = () => ({ ...newGame({ name: '艾琳', manifest, maps }), flags: { door_open: true }, items: { key: 1 }, dream_return: null });

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
    expect(CURRENT_VERSION).toBe(3);
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
    expect(() => deserialize(JSON.stringify({ ...game(), schema_version: 4 }))).toThrow(/版本 4.*較新|較新/);
  });
  it('缺版本或版本不是整數 → 錯誤', () => {
    const { schema_version, ...rest } = game();
    expect(() => deserialize(JSON.stringify(rest))).toThrow(/schema_version/);
    expect(() => deserialize(JSON.stringify({ ...rest, schema_version: '1' }))).toThrow(/schema_version/);
  });
  it('缺欄位 → 指出哪個欄位', () => {
    for (const field of ['player', 'location', 'flags', 'items', 'echo', 'collapse', 'resonance', 'chapter_done', 'playtime_s', 'lineage', 'party', 'ammo', 'pending']) {
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
    expect(st.load(1)).toEqual({ ok: false, reason: 'empty', code: 'empty' });
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
      { slot: 3, ok: false, empty: false, reason: expect.stringMatching(/較新/), code: 'newer' },
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

// ───────────── M2：存檔 v2 ─────────────
import { battleData } from './battle/fixture.js';

const v1Save = (over = {}) => ({
  schema_version: 1, player: { name: '艾琳' }, lineage: null,
  location: { map: 'attic', x: 1, y: 1, dir: 'down' },
  flags: { 'enter:attic': true }, items: {}, echo: { charges: 3 }, collapse: 5, resonance: {},
  chapter: 'prologue', chapter_done: ['prologue'], playtime_s: 10, ...over,
});

describe('v1 → v2 遷移', () => {
  it('party＝只有主角、hp/sp 為 null（讀檔時補成上限）；沒有 revolver 時 ammo 0；pending null', () => {
    const v2 = migrations[1](structuredClone(v1Save()));
    expect(v2.schema_version).toBe(2);
    expect(v2.party).toEqual([{ id: 'hero', hp: null, sp: null }]);
    expect(v2.ammo).toBe(0);
    expect(v2.pending).toBe(null);
    expect(v2.flags).toEqual({ 'enter:attic': true });
  });
  it('持有 revolver 時 ammo 3', () => {
    expect(migrations[1](v1Save({ items: { revolver: 1 } })).ammo).toBe(3);
  });
  it('不修改輸入；deserialize 從 v1 與 v0 都能一路遷移到目前版本（v3）', () => {
    const v1 = v1Save();
    const before = JSON.stringify(v1);
    migrations[1](v1);
    expect(JSON.stringify(v1)).toBe(before);
    const loaded = deserialize(JSON.stringify(v1));
    expect(loaded.schema_version).toBe(CURRENT_VERSION);
    expect(loaded.party).toEqual([{ id: 'hero', hp: null, sp: null }]);
    const v0 = { schema_version: 0, name: '舊', lineage: null, location: { map: 'attic', x: 1, y: 1, dir: 'down' },
      flags: {}, items: { revolver: 1 }, collapse: 0, chapter: 'prologue', chapter_done: [], playtime_s: 0 };
    expect(deserialize(JSON.stringify(v0))).toMatchObject({ schema_version: CURRENT_VERSION, ammo: 3, player: { name: '舊' }, dream_return: null });
  });
});

describe('v2 格式檢查（deserialize）', () => {
  const bad = (mut) => { const s = game(); mut(s); return () => deserialize(JSON.stringify(s)); };
  it('party 必須是陣列，成員 { id:字串, hp/sp:非負整數或 null }', () => {
    expect(bad(() => {})).not.toThrow();
    for (const party of [null, {}, 'hero', [{ hp: 1, sp: 1 }], [{ id: 'hero', hp: -1, sp: 0 }], [{ id: 'hero', hp: 1.5, sp: 0 }],
      [{ id: 'hero', hp: '3', sp: 0 }], [{ id: 'hero', sp: 0 }], [null]]) {
      expect(bad((s) => { s.party = party; }), JSON.stringify(party)).toThrow(/party/);
    }
    expect(bad((s) => { s.party = [{ id: 'hero', hp: 0, sp: null }]; })).not.toThrow();
  });
  it('ammo 為 0～12 的整數', () => {
    for (const v of [-1, 13, 1.5, '3', null]) expect(bad((s) => { s.ammo = v; }), String(v)).toThrow(/ammo/);
    for (const v of [0, 12]) expect(bad((s) => { s.ammo = v; })).not.toThrow();
  });
  it('pending 為 null 或陣列', () => {
    expect(bad((s) => { s.pending = 'x'; })).toThrow(/pending/);
  });
  it('serialize 一律把 pending 寫成 null（對話結束後的待辦不進存檔）', () => {
    const s = { ...game(), pending: [{ type: 'battle', encounter: 'enc_one' }] };
    expect(JSON.parse(serialize(s)).pending).toBe(null);
    expect(s.pending).toHaveLength(1);
  });
  it('拒絕時錯誤帶 code：corrupt／newer', () => {
    const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no-throw'; };
    expect(codeOf(() => deserialize('{x'))).toBe('corrupt');
    expect(codeOf(() => deserialize(JSON.stringify({ ...game(), schema_version: 9 })))).toBe('newer');
    expect(codeOf(bad((s) => { s.ammo = 99; }))).toBe('corrupt');
  });
});

describe('createStorage：code 與自動存檔槽', () => {
  it('load 失敗帶 code（empty／newer／corrupt／invalid_slot／unavailable）', () => {
    const be = memoryBackend();
    const st = createStorage(be);
    expect(st.load(1).code).toBe('empty');
    be.setItem('steel-labyrinth:save:2', '{broken');
    expect(st.load(2)).toMatchObject({ ok: false, code: 'corrupt', reason: expect.stringMatching(/損壞/) });
    be.setItem('steel-labyrinth:save:3', JSON.stringify({ ...game(), schema_version: 9 }));
    expect(st.load(3)).toMatchObject({ ok: false, code: 'newer', reason: expect.stringMatching(/較新/) });
    expect(st.load(9).code).toBe('invalid_slot');
    expect(createStorage(null).load(1).code).toBe('unavailable');
    expect(createStorage(throwingBackend()).save(1, game()).code).toBe('storage_error');
  });
  it('saveAuto／loadAuto 存在 steel-labyrinth:save:auto，附帶要重新挑戰的遭遇 id；不影響 listSlots 的 3 格', () => {
    const be = memoryBackend();
    const st = createStorage(be);
    expect(st.loadAuto()).toMatchObject({ ok: false, code: 'empty' });
    expect(st.saveAuto(game(), { battle: 'enc_one' })).toEqual({ ok: true });
    expect([...be.m.keys()]).toEqual(['steel-labyrinth:save:auto']);
    const r = st.loadAuto();
    expect(r.ok).toBe(true);
    expect(r.state).toEqual(game());
    expect(r.battle).toBe('enc_one');
    expect(st.listSlots()).toHaveLength(3);
    expect(st.listSlots().every((x) => x.empty)).toBe(true);
    st.saveAuto(game());
    expect(st.loadAuto().battle).toBe(null);
  });
  it('自動存檔損壞 → ok:false 帶 code；backend 丟錯不當機', () => {
    const be = memoryBackend();
    be.setItem('steel-labyrinth:save:auto', '{x');
    expect(createStorage(be).loadAuto()).toMatchObject({ ok: false, code: 'corrupt' });
    expect(createStorage(throwingBackend()).saveAuto(game()).ok).toBe(false);
    expect(createStorage(null).loadAuto().ok).toBe(false);
  });
});

describe('sanitizeLoadedState（v2）', () => {
  const bd = battleData();
  const data = {
    ...bd,
    tiles: [{ id: 'wall', solid: true }, { id: 'floor', solid: false }],
    maps: [{ id: 'attic', tiles: ['#####', '#...#', '#####'], legend: { '#': 'wall', '.': 'floor' },
      spawns: [{ id: 'default', x: 1, y: 1, dir: 'down' }] }],
  };
  const good = (over = {}) => ({ ...game(), location: { map: 'attic', x: 1, y: 1, dir: 'down' }, ...over });
  it('hp/sp 的 null 補成上限（由 deriveStats 算），不算警告', () => {
    const r = sanitizeLoadedState(good({ party: [{ id: 'hero', hp: null, sp: 5 }, { id: 'ada', hp: 10, sp: null }] }), data);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.state.party).toEqual([{ id: 'hero', hp: 60, sp: 5 }, { id: 'ada', hp: 10, sp: 35 }]);
  });
  it('超過上限 → 夾到上限並警告（code: party_clamped）', () => {
    const r = sanitizeLoadedState(good({ party: [{ id: 'hero', hp: 999, sp: 20 }] }), data);
    expect(r.ok).toBe(true);
    expect(r.state.party[0].hp).toBe(60);
    expect(r.warnings.map((w) => w.code)).toEqual(['party_clamped']);
  });
  it('隊伍不合法 → 拒絕（code: party_invalid）：不存在的角色、主角不在第一位、重複、超過 3 人、空隊伍', () => {
    const parties = [
      [{ id: 'hero', hp: 1, sp: 1 }, { id: 'ghost', hp: 1, sp: 1 }],
      [{ id: 'ada', hp: 1, sp: 1 }, { id: 'hero', hp: 1, sp: 1 }],
      [{ id: 'hero', hp: 1, sp: 1 }, { id: 'ada', hp: 1, sp: 1 }, { id: 'ada', hp: 1, sp: 1 }],
      [{ id: 'hero', hp: 1, sp: 1 }, { id: 'ada', hp: 1, sp: 1 }, { id: 'herb', hp: 1, sp: 1 }, { id: 'toString', hp: 1, sp: 1 }],
      [],
    ];
    for (const party of parties) {
      const r = sanitizeLoadedState(good({ party }), data);
      expect(r.ok, JSON.stringify(party)).toBe(false);
      expect(r.code, JSON.stringify(party)).toBe('party_invalid');
    }
  });
  it('序章資料沒有 characters.json：主角照樣可讀（hp/sp 維持 null）', () => {
    const { characters, ...noChars } = data;
    const r = sanitizeLoadedState(good(), noChars);
    expect(r.ok).toBe(true);
    expect(r.state.party).toEqual([{ id: 'hero', hp: null, sp: null }]);
    expect(sanitizeLoadedState(good({ party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: 1, sp: 1 }] }), noChars).ok).toBe(false);
  });
  it('pending 一律清成 null', () => {
    const r = sanitizeLoadedState(good({ pending: [{ type: 'goto', map: 'attic', spawn: 'default' }] }), data);
    expect(r.state.pending).toBe(null);
  });
  it('警告與拒絕原因帶 code，訊息字串照舊（String(warning) 仍是原本的文字）', () => {
    const r = sanitizeLoadedState(good({ player: { name: '長'.repeat(20) }, location: { map: 'attic', x: 0, y: 0, dir: 'down' } }), data);
    expect(r.warnings.map((w) => w.code)).toEqual(['name_sanitized', 'relocated']);
    expect(String(r.warnings[0])).toMatch(/名字/);
    expect(String(r.warnings[1])).toMatch(/位置/);
    expect(r.warnings[1].message).toBe(String(r.warnings[1]));
    expect(sanitizeLoadedState(good({ location: { map: 'roof', x: 1, y: 1, dir: 'down' } }), data).code).toBe('unknown_map');
    expect(sanitizeLoadedState(good({ lineage: { id: 'ghost', rank: 9 } }), data).code).toBe('unknown_lineage');
    expect(sanitizeLoadedState(null, data).code).toBe('corrupt');
  });
});

describe('deserialize 加強（API 修訂 2 F：Worker 與客戶端共用）', () => {
  const bad = (mut) => { const s = game(); mut(s); return () => deserialize(JSON.stringify(s)); };
  const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no-throw'; };

  it('flags 的值只能是布林或整數', () => {
    for (const v of [true, false, 0, 3, -2]) expect(bad((s) => { s.flags = { a: v }; }), JSON.stringify(v)).not.toThrow();
    for (const v of ['x', 1.5, null, [], {}, 'true']) {
      expect(bad((s) => { s.flags = { a: v }; }), JSON.stringify(v)).toThrow(/flags/);
      expect(codeOf(bad((s) => { s.flags = { a: v }; }))).toBe('corrupt');
    }
  });

  it('flags 的鍵不限格式（遊戲本身就用 enter:attic 這種鍵）', () => {
    expect(bad((s) => { s.flags = { 'enter:attic': true, 'trigger:x-1': true }; })).not.toThrow();
  });

  it('items／resonance 的鍵必須是 [a-z0-9_]{1,32}', () => {
    for (const k of ['attic_key', 'a', 'x'.repeat(32), 'item_2']) {
      expect(bad((s) => { s.items = { [k]: 1 }; }), k).not.toThrow();
      expect(bad((s) => { s.resonance = { [k]: 0 }; }), k).not.toThrow();
    }
    for (const k of ['', 'Attic', 'a-b', 'a b', 'x'.repeat(33), '鑰匙', '<img>', '__proto__x!']) {
      expect(bad((s) => { s.items = { [k]: 1 }; }), k).toThrow(/items/);
      expect(bad((s) => { s.resonance = { [k]: 1 }; }), k).toThrow(/resonance/);
    }
  });

  it('JSON 巢狀深度上限 8（根物件算第 1 層），字串裡的括號不算', () => {
    const nest = (n) => { let v = 1; for (let i = 0; i < n; i++) v = [v]; return v; };
    // 根(1) → flags 物件(2) 裡不能放陣列（值只能布林／整數），所以用版本較新的存檔測深度：根(1)＋n 層
    const newer = (n) => JSON.stringify({ schema_version: CURRENT_VERSION + 1, x: nest(n) });
    expect(codeOf(() => deserialize(newer(7)))).toBe('newer'); // 深度 8：通過格式檢查，只是版本較新
    expect(codeOf(() => deserialize(newer(8)))).toBe('corrupt'); // 深度 9
    expect(() => deserialize(newer(8))).toThrow(/巢狀/);
    const deep = `{"schema_version":${CURRENT_VERSION},"flags":{"x":${'['.repeat(30000)}${']'.repeat(30000)}}}`;
    expect(codeOf(() => deserialize(deep))).toBe('corrupt');
    const s = game();
    s.player.name = '[[[[[[[[[[[[{{{{{{{{{{"\\"[[[[';
    expect(deserialize(JSON.stringify(s)).player.name).toBe(s.player.name);
  });

  it('遊戲資料裡所有道具 id 與殘響鍵都符合存檔鍵格式（加強後既有存檔仍可讀）', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '..', '..', 'web', 'data');
    const KEY = /^[a-z0-9_]{1,32}$/;
    const found = { give_item: new Set(), take_item: new Set(), resonance: new Set() };
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (Object.hasOwn(found, k) && typeof x === 'string') found[k].add(x);
          walk(x);
        }
      }
    };
    const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    for (const f of files(root).filter((f) => f.endsWith('.json'))) walk(JSON.parse(readFileSync(f, 'utf8')));
    const items = JSON.parse(readFileSync(join(root, 'items.json'), 'utf8'));
    const ids = (Array.isArray(items) ? items : Object.values(items)).map((x) => x.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(found.give_item.size).toBeGreaterThan(0);
    expect(found.resonance.size).toBeGreaterThan(0);
    for (const k of [...ids, ...found.give_item, ...found.take_item, ...found.resonance]) expect(k, k).toMatch(KEY);
  });
});

// ---------- 存檔 v3（DATA-FORMAT「鐘塔之夢」）：dream_return ----------
describe('存檔 v3：dream_return 與 v2→v3 遷移', () => {
  const v2Save = (over = {}) => {
    const { dream_return: _d, ...rest } = game();
    return { ...rest, schema_version: 2, ...over };
  };
  it('migrations[2]：補 dream_return: null、版本 3、不修改輸入', () => {
    const v2 = v2Save();
    const before = JSON.stringify(v2);
    const v3 = migrations[2](v2);
    expect(v3.schema_version).toBe(3);
    expect(v3.dream_return).toBe(null);
    expect(JSON.stringify(v2)).toBe(before);
  });
  it('v2 存檔字串經 deserialize 遷移成 v3（dream_return: null）', () => {
    const loaded = deserialize(JSON.stringify(v2Save()));
    expect(loaded.schema_version).toBe(3);
    expect(loaded.dream_return).toBe(null);
  });
  it('v2 存檔裡誤帶的 dream_return 一律以 null 取代（v2 沒有這個欄位）', () => {
    expect(deserialize(JSON.stringify(v2Save({ dream_return: { map: 'x', x: 1, y: 1, dir: 'up' } }))).dream_return).toBe(null);
  });
  it('dream_return：null 或 { map:字串, x, y, dir }；其他型別 → corrupt 並指出欄位', () => {
    const ok = { ...game(), dream_return: { map: 'attic', x: 1, y: 1, dir: 'down' } };
    expect(deserialize(serialize(ok)).dream_return).toEqual({ map: 'attic', x: 1, y: 1, dir: 'down' });
    for (const v of ['attic', 5, [], {}, { map: 3, x: 1, y: 1, dir: 'down' }]) {
      const s = JSON.stringify({ ...game(), dream_return: v, schema_version: 3 });
      expect(() => deserialize(s), JSON.stringify(v)).toThrow(/dream_return/);
    }
    const missing = { ...game(), schema_version: 3 };
    delete missing.dream_return;
    expect(() => deserialize(JSON.stringify(missing))).toThrow(/dream_return/);
  });
  it('serialize：state 沒有 dream_return（舊程式建立的 state）時寫成 null', () => {
    const { dream_return: _d, ...s } = game();
    expect(JSON.parse(serialize(s)).dream_return).toBe(null);
    expect(deserialize(serialize(s)).dream_return).toBe(null);
  });
});

describe('sanitizeLoadedState（v3：dream_return 與地圖不存在）', () => {
  const room = (id, spawns) => ({ id, tiles: ['#####', '#...#', '#####'], legend: { '#': 'wall', '.': 'floor' }, spawns });
  const data = {
    tiles: [{ id: 'wall', solid: true }, { id: 'floor', solid: false }],
    manifest: { chapters: ['prologue', 'chapter1', 'chapter2'], start: { map: 'attic', spawn: 'default' } },
    story: [
      { id: 'prologue', end_screen: { continue: { map: 'office', spawn: 'entry' } } },
      { id: 'chapter1', end_screen: { continue: { map: 'dock', spawn: 'entry' } } },
    ],
    maps: [
      room('attic', [{ id: 'default', x: 1, y: 1, dir: 'down' }]),
      room('office', [{ id: 'other', x: 3, y: 1, dir: 'left' }, { id: 'entry', x: 2, y: 1, dir: 'up' }]),
      room('dock', [{ id: 'entry', x: 3, y: 1, dir: 'right' }]),
      { ...room('clocktower', [{ id: 'center', x: 2, y: 1, dir: 'up' }]), dream: true },
    ],
  };
  const inDream = (over = {}) => ({
    ...game(), chapter: 'chapter1', location: { map: 'clocktower', x: 2, y: 1, dir: 'up' },
    dream_return: { map: 'office', x: 1, y: 1, dir: 'down' }, ...over,
  });
  it('夢境中的合法存檔原樣通過、沒有警告', () => {
    const s = inDream();
    expect(sanitizeLoadedState(s, data)).toEqual({ ok: true, state: s, warnings: [] });
  });
  it('dream_return 指向的地圖不存在 → 改成該章的預設起點（前一章 end_screen.continue）並警告', () => {
    const r = sanitizeLoadedState(inDream({ dream_return: { map: 'ghost', x: 1, y: 1, dir: 'down' } }), data);
    expect(r.ok).toBe(true);
    expect(r.state.dream_return).toEqual({ map: 'office', x: 2, y: 1, dir: 'up' });
    expect(r.warnings.map((w) => w.code)).toEqual(['dream_return_reset']);
    expect(String(r.warnings[0])).toMatch(/ghost/);
  });
  it('第一章（序章）的預設起點是 manifest.start；找不到章節時也用 manifest.start', () => {
    for (const chapter of ['prologue', 'chapter9', null]) {
      const r = sanitizeLoadedState(inDream({ chapter, dream_return: { map: 'ghost', x: 1, y: 1, dir: 'down' } }), data);
      expect(r.ok, String(chapter)).toBe(true);
      expect(r.state.dream_return, String(chapter)).toEqual({ map: 'attic', x: 1, y: 1, dir: 'down' });
    }
  });
  it('dream_return 的位置不合法（牆上、超出範圍、方向錯）→ 移到該地圖第一個 spawn 並警告', () => {
    for (const bad of [{ x: 0, y: 0, dir: 'down' }, { x: 9, y: 1, dir: 'down' }, { x: 1, y: 1, dir: 'sideways' }, { x: '1', y: 1, dir: 'down' }]) {
      const r = sanitizeLoadedState(inDream({ dream_return: { map: 'office', ...bad } }), data);
      expect(r.ok, JSON.stringify(bad)).toBe(true);
      expect(r.state.dream_return).toEqual({ map: 'office', x: 3, y: 1, dir: 'left' });
      expect(r.warnings.map((w) => w.code)).toEqual(['dream_return_relocated']);
    }
  });
  it('目前所在的（夢境）地圖不存在、但 dream_return 合法 → 直接醒來回到 dream_return 並警告', () => {
    const r = sanitizeLoadedState(inDream({ location: { map: 'old_dream', x: 1, y: 1, dir: 'up' } }), data);
    expect(r.ok).toBe(true);
    expect(r.state.location).toEqual({ map: 'office', x: 1, y: 1, dir: 'down' });
    expect(r.state.dream_return).toBe(null);
    expect(r.warnings.map((w) => w.code)).toEqual(['woke_up']);
  });
  it('目前地圖與 dream_return 的地圖都不存在 → 醒到該章的預設起點', () => {
    const r = sanitizeLoadedState(inDream({ location: { map: 'old_dream', x: 1, y: 1, dir: 'up' }, dream_return: { map: 'ghost', x: 1, y: 1, dir: 'up' } }), data);
    expect(r.ok).toBe(true);
    expect(r.state.location).toEqual({ map: 'office', x: 2, y: 1, dir: 'up' });
    expect(r.state.dream_return).toBe(null);
    expect(r.warnings.map((w) => w.code)).toEqual(['dream_return_reset', 'woke_up']);
  });
  it('沒有 dream_return 時地圖不存在 → 照舊拒絕 unknown_map', () => {
    expect(sanitizeLoadedState(inDream({ location: { map: 'old_dream', x: 1, y: 1, dir: 'up' }, dream_return: null }), data).code).toBe('unknown_map');
  });
  it('預設起點也找不到（沒有 manifest）→ 拒絕 no_spawn，不當機', () => {
    const { manifest: _m, ...noManifest } = data;
    expect(sanitizeLoadedState(inDream({ dream_return: { map: 'ghost', x: 1, y: 1, dir: 'down' } }), noManifest).code).toBe('no_spawn');
  });
  it('state 沒有 dream_return（舊程式在記憶體中建立的 state）→ 視為 null', () => {
    const { dream_return: _d, ...s } = inDream();
    const r = sanitizeLoadedState({ ...s, location: { map: 'attic', x: 1, y: 1, dir: 'down' } }, data);
    expect(r.ok).toBe(true);
    expect(r.state.dream_return).toBe(null);
    expect(r.warnings).toEqual([]);
  });
});
