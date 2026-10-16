import { describe, it, expect } from 'vitest';
import { applyEffect, applyEffects, checkEffect } from '../../web/src/core/effects.js';

const base = () => ({
  flags: { a: true }, items: { key: 1 }, echo: { charges: 1 }, collapse: 0,
  resonance: {}, chapter: 'prologue', chapter_done: [],
});
const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };

describe('applyEffect', () => {
  it('不原地修改輸入（凍結物件也能用）', () => {
    const s = deepFreeze(base());
    const n = applyEffect({ set_flag: 'b' }, s);
    expect(n).not.toBe(s);
    expect(n.flags).toEqual({ a: true, b: true });
    expect(s.flags).toEqual({ a: true });
  });
  it('set_flag／clear_flag', () => {
    expect(applyEffect({ clear_flag: 'a' }, base()).flags).toEqual({});
    expect(applyEffect({ clear_flag: 'zzz' }, base()).flags).toEqual({ a: true });
  });
  it('give_item 累加、take_item 減到 0 就移除，沒有時不變', () => {
    const s1 = applyEffect({ give_item: 'key' }, base());
    expect(s1.items.key).toBe(2);
    expect(applyEffect({ give_item: 'gem' }, base()).items.gem).toBe(1);
    const s2 = applyEffect({ take_item: 'key' }, base());
    expect(s2.items).toEqual({});
    expect(applyEffect({ take_item: 'none' }, base()).items).toEqual({ key: 1 });
  });
  it('resonance 累加計數', () => {
    const s = applyEffect({ resonance: 'lie' }, applyEffect({ resonance: 'lie' }, base()));
    expect(s.resonance).toEqual({ lie: 2 });
  });
  it('collapse 增減並夾在 0～100', () => {
    expect(applyEffect({ collapse: 5 }, base()).collapse).toBe(5);
    expect(applyEffect({ collapse: -5 }, base()).collapse).toBe(0);
    expect(applyEffect({ collapse: 500 }, base()).collapse).toBe(100);
  });
  it('use_echo 扣 1 次並崩解 +5；0 次時丟錯', () => {
    const s = applyEffect({ use_echo: true }, base());
    expect(s.echo.charges).toBe(0);
    expect(s.collapse).toBe(5);
    expect(() => applyEffect({ use_echo: true }, s)).toThrow(/殘響/);
  });
  it('chapter_end 記入 chapter_done 且不重複', () => {
    const s = applyEffect({ chapter_end: 'prologue' }, base());
    expect(s.chapter_done).toEqual(['prologue']);
    expect(applyEffect({ chapter_end: 'prologue' }, s).chapter_done).toEqual(['prologue']);
  });
  it('未知或不合法寫法丟錯', () => {
    expect(() => applyEffect({ teleport: 'x' }, base())).toThrow(/未知的效果/);
    expect(() => applyEffect({}, base())).toThrow();
    expect(() => applyEffect(null, base())).toThrow();
    expect(() => applyEffect({ set_flag: 'a', give_item: 'b' }, base())).toThrow();
    expect(() => applyEffect({ use_echo: false }, base())).toThrow();
    expect(() => applyEffect({ collapse: '5' }, base())).toThrow();
    expect(() => applyEffect({ give_item: '' }, base())).toThrow();
  });
  it('applyEffects 依序套用；undefined 視為沒有效果', () => {
    const s = applyEffects([{ set_flag: 'x' }, { give_item: 'g' }], base());
    expect(s.flags.x).toBe(true);
    expect(s.items.g).toBe(1);
    const b = base();
    expect(applyEffects(undefined, b)).toEqual(b);
    expect(() => applyEffects({ set_flag: 'x' }, b)).toThrow();
  });
});

describe('checkEffect', () => {
  it('合法回空、不合法回錯誤', () => {
    expect(checkEffect({ use_echo: true })).toEqual([]);
    expect(checkEffect({ bogus: 1 }).length).toBe(1);
  });
  it('collapse 必須是整數（N2：2.5 會產生讀不回來的存檔）', () => {
    for (const v of [2.5, -0.1, 1e-9]) expect(checkEffect({ collapse: v }).length, String(v)).toBe(1);
    for (const v of [5, -5, 0]) expect(checkEffect({ collapse: v }), String(v)).toEqual([]);
    expect(() => applyEffect({ collapse: 2.5 }, base())).toThrow();
  });
});

describe('原型鍵不可繞過檢查', () => {
  it('checkEffect 回報未知寫法；applyEffect 丟錯', () => {
    for (const j of ['{"toString":"x"}', '{"constructor":"x"}', '{"__proto__":"x"}', '{"hasOwnProperty":"x"}']) {
      const e = JSON.parse(j);
      const errs = checkEffect(e);
      expect(errs.length, j).toBe(1);
      expect(errs[0], j).toMatch(/未知的效果寫法/);
      expect(() => applyEffect(e, base()), j).toThrow(/未知的效果/);
    }
  });
  it('道具／共鳴名稱是原型鍵時，計數從 0 開始而不是原型上的函式', () => {
    expect(applyEffect({ give_item: 'constructor' }, base()).items.constructor).toBe(1);
    expect(applyEffect({ resonance: 'toString' }, base()).resonance.toString).toBe(1);
    expect(applyEffect({ take_item: 'constructor' }, base()).items).toEqual({ key: 1 });
  });
});

// ───────────── M2：戰鬥與隊伍的對話效果 ─────────────
import { takePending, MAX_AMMO } from '../../web/src/core/effects.js';

describe('M2 效果', () => {
  const st = (over = {}) => ({ flags: {}, items: {}, lineage: null, party: [{ id: 'hero', hp: 30, sp: 2 }], ammo: 0, pending: null, ...over });
  it('battle／goto 寫入 pending（依序累加），由 takePending 取出並清空', () => {
    let s = applyEffect({ battle: 'enc_one' }, st());
    s = applyEffect({ goto: { map: 'office', spawn: 'door', dialogue: 'dlg_x' } }, s);
    expect(s.pending).toEqual([{ type: 'battle', encounter: 'enc_one' }, { type: 'goto', map: 'office', spawn: 'door', dialogue: 'dlg_x' }]);
    const r = takePending(s);
    expect(r.pending).toEqual(s.pending);
    expect(r.state.pending).toBe(null);
    expect(takePending(st())).toEqual({ state: st(), pending: [] });
    expect(applyEffect({ goto: { map: 'office', spawn: 'door' } }, st()).pending).toEqual([{ type: 'goto', map: 'office', spawn: 'door', dialogue: null }]);
  });
  it('set_lineage：主角成為該譜系、階位', () => {
    expect(applyEffect({ set_lineage: { id: 'trace', rank: 9 } }, st()).lineage).toEqual({ id: 'trace', rank: 9 });
  });
  it('join_party／leave_party：加入時 hp/sp 為 null（滿值），重複加入不變，最多 3 人，主角不可離開', () => {
    let s = applyEffect({ join_party: 'ada' }, st());
    expect(s.party).toEqual([{ id: 'hero', hp: 30, sp: 2 }, { id: 'ada', hp: null, sp: null }]);
    expect(applyEffect({ join_party: 'ada' }, s).party).toHaveLength(2);
    s = applyEffect({ join_party: 'herb' }, s);
    expect(() => applyEffect({ join_party: 'mallow' }, s)).toThrow(/3/);
    s = applyEffect({ leave_party: 'ada' }, s);
    expect(s.party.map((m) => m.id)).toEqual(['hero', 'herb']);
    expect(applyEffect({ leave_party: 'ada' }, s).party).toHaveLength(2);
    expect(() => applyEffect({ leave_party: 'hero' }, s)).toThrow(/主角/);
  });
  it('give_ammo：增加子彈，上限 12', () => {
    expect(MAX_AMMO).toBe(12);
    expect(applyEffect({ give_ammo: 6 }, st()).ammo).toBe(6);
    expect(applyEffect({ give_ammo: 6 }, st({ ammo: 10 })).ammo).toBe(12);
    expect(applyEffect({ give_ammo: 1 }, st({ ammo: undefined })).ammo).toBe(1);
  });
  it('heal_party：全隊 hp/sp 記為 null（＝滿值，上限由 deriveStats 算）', () => {
    const s = applyEffect({ heal_party: true }, st({ party: [{ id: 'hero', hp: 0, sp: 0 }, { id: 'ada', hp: 3, sp: 1 }] }));
    expect(s.party).toEqual([{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }]);
  });
  it('不修改輸入', () => {
    const s = st();
    const before = JSON.stringify(s);
    applyEffects([{ battle: 'x' }, { join_party: 'ada' }, { give_ammo: 3 }, { heal_party: true }, { set_lineage: { id: 'trace', rank: 9 } }], s);
    expect(JSON.stringify(s)).toBe(before);
  });
  it('寫法不合法', () => {
    const bad = [
      { battle: '' }, { set_lineage: 'trace' }, { set_lineage: { id: 'trace' } }, { set_lineage: { id: 'trace', rank: 9, x: 1 } },
      { join_party: 3 }, { leave_party: '' }, { give_ammo: 0 }, { give_ammo: 1.5 }, { give_ammo: -1 }, { heal_party: false },
      { goto: 'office' }, { goto: { map: 'office' } }, { goto: { map: 'office', spawn: 'd', dialogue: 3 } }, { goto: { map: 'o', spawn: 'd', x: 1 } },
    ];
    for (const e of bad) expect(checkEffect(e).length, JSON.stringify(e)).toBeGreaterThan(0);
  });
});
