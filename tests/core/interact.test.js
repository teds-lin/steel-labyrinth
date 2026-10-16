import { describe, it, expect } from 'vitest';
import { facingTarget, look, echo, tryUnlock, unlockOptions, NO_TRACE_MESSAGE, parseFallback } from '../../web/src/core/interact.js';

const door = {
  id: 'obj_door', x: 2, y: 1, solid: true, look: 'dlg_door_look',
  lock: { flag: 'door_open', solvable_by: ['trace'], fallback: 'item:attic_key',
    on_tag: { trace: 'dlg_door_echo' }, on_item: 'dlg_door_key', locked: 'dlg_door_locked' },
};
const vial = { id: 'obj_vial', x: 1, y: 0, solid: true, look: 'dlg_vial_look', echo: 'dlg_vial_echo' };
const plain = { id: 'obj_plain', x: 0, y: 1, solid: true, look: 'dlg_plain' };
const hidden = { id: 'obj_hidden', x: 1, y: 2, solid: true, look: 'dlg_h', if: { flag: 'show' } };
const map = { id: 'm', tiles: ['...', '...', '...'], legend: { '.': 'floor' }, objects: [vial, door, plain, hidden] };
const data = {
  tiles: [{ id: 'floor', solid: false }], maps: [map],
  lineages: [{ id: 'hound', ranks: [{ rank: 9, field: ['trace'] }] }, { id: 'smith', ranks: [{ rank: 9, field: ['force'] }] }],
};
const st = (over = {}) => ({
  player: { name: 'A' }, location: { map: 'm', x: 1, y: 1, dir: 'up' }, lineage: null,
  flags: {}, items: {}, echo: { charges: 2 }, collapse: 0, resonance: {}, chapter_done: [], ...over,
});

describe('parseFallback', () => {
  it('item:<id>', () => {
    expect(parseFallback('item:attic_key')).toEqual({ kind: 'item', id: 'attic_key' });
    expect(() => parseFallback('skill:x')).toThrow();
    expect(() => parseFallback('item:')).toThrow();
    expect(() => parseFallback(undefined)).toThrow();
  });
});

describe('facingTarget', () => {
  it('回傳面前那格存在的物件', () => {
    expect(facingTarget(map, st(), data)).toBe(vial);
    expect(facingTarget(map, st({ location: { map: 'm', x: 1, y: 1, dir: 'right' } }), data)).toBe(door);
  });
  it('面前沒東西、地圖外、if 不成立 → null', () => {
    expect(facingTarget(map, st({ location: { map: 'm', x: 1, y: 0, dir: 'up' } }), data)).toBeNull();
    expect(facingTarget(map, st({ location: { map: 'm', x: 1, y: 1, dir: 'down' } }), data)).toBeNull();
    expect(facingTarget(map, st({ location: { map: 'm', x: 1, y: 1, dir: 'down' }, flags: { show: true } }), data)).toBe(hidden);
  });
});

describe('look', () => {
  it('回傳調查對話，不改 state', () => {
    const s = st();
    expect(look(vial, s)).toEqual({ state: s, dialogue: 'dlg_vial_look' });
    expect(look({ id: 'x' }, s).dialogue).toBeNull();
  });
});

describe('echo（殘響）', () => {
  it('有殘響內容：扣 1 次、崩解 +5，回傳殘響對話', () => {
    const r = echo(vial, st(), data);
    expect(r.dialogue).toBe('dlg_vial_echo');
    expect(r.state.echo.charges).toBe(1);
    expect(r.state.collapse).toBe(5);
  });
  it('沒有殘響內容：回「沒有殘留痕跡」且不扣次數', () => {
    const s = st();
    const r = echo(plain, s, data);
    expect(r).toEqual({ state: s, dialogue: null, message: NO_TRACE_MESSAGE });
    expect(NO_TRACE_MESSAGE).toBe('沒有殘留痕跡');
  });
  it('次數為 0：不丟錯，回傳訊息，不改 state', () => {
    const s = st({ echo: { charges: 0 } });
    const r = echo(vial, s, data);
    expect(r.state).toBe(s);
    expect(r.dialogue).toBeNull();
    expect(r.message).toMatch(/用盡/);
  });
  it('對可用 trace 解開的鎖使用殘響 → 以標籤解開', () => {
    const r = echo(door, st(), data);
    expect(r).toMatchObject({ unlocked: true, via: 'tag', tag: 'trace', dialogue: 'dlg_door_echo' });
    expect(r.state.flags.door_open).toBe(true);
    expect(r.state.echo.charges).toBe(1);
  });
});

describe('unlockOptions', () => {
  it('列出可用解法與代價', () => {
    expect(unlockOptions(door, st(), data)).toEqual([{ method: 'tag', tag: 'trace', cost: 'echo' }]);
    expect(unlockOptions(door, st({ items: { attic_key: 1 } }), data)).toEqual([
      { method: 'tag', tag: 'trace', cost: 'echo' }, { method: 'item', item: 'attic_key', cost: null },
    ]);
    expect(unlockOptions(door, st({ lineage: { id: 'hound', rank: 9 } }), data)).toEqual([{ method: 'tag', tag: 'trace', cost: null }]);
    expect(unlockOptions(door, st({ echo: { charges: 0 } }), data)).toEqual([]);
  });
  it('殘響次數為 0 時不提供 trace 標籤', () => {
    expect(unlockOptions(door, st({ echo: { charges: 0 }, lineage: { id: 'smith', rank: 9 } }), data)).toEqual([]);
  });
});

describe('tryUnlock', () => {
  it('打不開：播 locked，不改 state', () => {
    const s = st({ echo: { charges: 0 } });
    expect(tryUnlock(door, s, data)).toEqual({ state: s, dialogue: 'dlg_door_locked', unlocked: false, via: null });
  });
  it('只有殘響且 allowCost：用標籤解開，扣殘響，設旗標，播 on_tag', () => {
    const s = st();
    const r = tryUnlock(door, s, data, { allowCost: true });
    expect(r).toMatchObject({ unlocked: true, via: 'tag', tag: 'trace', dialogue: 'dlg_door_echo' });
    expect(r.state.flags.door_open).toBe(true);
    expect(r.state.echo.charges).toBe(1);
    expect(s.flags.door_open).toBeUndefined();
  });
  it('有鑰匙也有殘響（即使 allowCost）：優先用不花代價的道具，道具不消耗', () => {
    const r = tryUnlock(door, st({ items: { attic_key: 1 } }), data, { allowCost: true });
    expect(r).toMatchObject({ unlocked: true, via: 'item', item: 'attic_key', dialogue: 'dlg_door_key' });
    expect(r.state.echo.charges).toBe(2);
    expect(r.state.items.attic_key).toBe(1);
  });
  it('譜系永久標籤優先，且不扣殘響', () => {
    const r = tryUnlock(door, st({ lineage: { id: 'hound', rank: 9 }, items: { attic_key: 1 } }), data);
    expect(r).toMatchObject({ via: 'tag', tag: 'trace' });
    expect(r.state.echo.charges).toBe(2);
    expect(r.state.collapse).toBe(0);
  });
  it('可指定解法；指定的解法不可用時當作打不開', () => {
    const s = st({ items: { attic_key: 1 } });
    expect(tryUnlock(door, s, data, { method: 'tag', tag: 'trace', allowCost: true })).toMatchObject({ via: 'tag' });
    expect(tryUnlock(door, st(), data, { method: 'item' })).toMatchObject({ unlocked: false, dialogue: 'dlg_door_locked' });
  });
  it('已解開：回 look 對話、不重複扣', () => {
    const s = st({ flags: { door_open: true } });
    expect(tryUnlock(door, s, data)).toEqual({ state: s, dialogue: 'dlg_door_look', unlocked: true, via: 'already' });
  });
  it('標籤不在 solvable_by 不算數；on_tag 沒寫該標籤時對話為 null', () => {
    const d2 = { ...door, lock: { ...door.lock, solvable_by: ['force'], on_tag: {} } };
    expect(tryUnlock(d2, st(), data, { allowCost: true }).unlocked).toBe(false);
    const r = tryUnlock(d2, st({ lineage: { id: 'smith', rank: 9 } }), data);
    expect(r).toMatchObject({ unlocked: true, via: 'tag', tag: 'force', dialogue: null });
  });
  it('非 lock 物件丟錯', () => {
    expect(() => tryUnlock(vial, st(), data)).toThrow(/lock/);
  });
});

// ───────────── M1 審查修正 ─────────────
import { investigate, echoAvailable, NO_CHARGE_MESSAGE } from '../../web/src/core/interact.js';

describe('tryUnlock：allowCost（預設 false，不花殘響）', () => {
  it('預設只考慮免費解法：只有殘響時回 locked、不扣次數', () => {
    const s = st();
    expect(tryUnlock(door, s, data)).toEqual({ state: s, dialogue: 'dlg_door_locked', unlocked: false, via: null });
  });
  it('allowCost:true 才會花殘響', () => {
    const r = tryUnlock(door, st(), data, { allowCost: true });
    expect(r).toMatchObject({ unlocked: true, via: 'tag', tag: 'trace' });
    expect(r.state.echo.charges).toBe(1);
  });
  it('指定 method:tag 但沒 allowCost → 仍然不花殘響', () => {
    expect(tryUnlock(door, st(), data, { method: 'tag', tag: 'trace' })).toMatchObject({ unlocked: false, dialogue: 'dlg_door_locked' });
  });
  it('道具與譜系標籤是免費的，預設就能用', () => {
    expect(tryUnlock(door, st({ items: { attic_key: 1 } }), data)).toMatchObject({ via: 'item' });
    expect(tryUnlock(door, st({ lineage: { id: 'hound', rank: 9 } }), data)).toMatchObject({ via: 'tag' });
  });
  it('on_tag 查表不吃原型鍵', () => {
    const d = { ...door, lock: { ...door.lock, solvable_by: ['constructor'], on_tag: {} } };
    const dataP = { ...data, lineages: [{ id: 'p', ranks: [{ rank: 9, field: ['constructor'] }] }] };
    expect(tryUnlock(d, st({ lineage: { id: 'p', rank: 9 } }), dataP).dialogue).toBeNull();
  });
});

describe('echo：譜系已提供 trace 時免費', () => {
  const hound = { lineage: { id: 'hound', rank: 9 } };
  it('一般物件：播 echo 對話、不扣次數、不加崩解', () => {
    const r = echo(vial, st({ ...hound, echo: { charges: 0 } }), data);
    expect(r.dialogue).toBe('dlg_vial_echo');
    expect(r.message).toBeUndefined();
    expect(r.state.echo.charges).toBe(0);
    expect(r.state.collapse).toBe(0);
  });
  it('lock 物件：以 trace 免費解開', () => {
    const r = echo(door, st({ ...hound, echo: { charges: 2 } }), data);
    expect(r).toMatchObject({ unlocked: true, via: 'tag', dialogue: 'dlg_door_echo' });
    expect(r.state.echo.charges).toBe(2);
    expect(r.state.collapse).toBe(0);
  });
  it('次數 0 且譜系沒有 trace 才回 NO_CHARGE_MESSAGE', () => {
    expect(echo(vial, st({ echo: { charges: 0 }, lineage: { id: 'smith', rank: 9 } }), data).message).toBe(NO_CHARGE_MESSAGE);
    expect(echo(plain, st({ ...hound, echo: { charges: 0 } }), data).message).toBe(NO_TRACE_MESSAGE);
  });
  it('只有暫時殘響時，有鑰匙也照樣扣殘響（玩家選了殘響）', () => {
    const r = echo(door, st({ items: { attic_key: 1 } }), data);
    expect(r).toMatchObject({ via: 'tag' });
    expect(r.state.echo.charges).toBe(1);
  });
});

describe('investigate（調查）', () => {
  it('一般物件：只播 look，unlocked 為 null', () => {
    const s = st();
    expect(investigate(vial, s, data)).toEqual({ state: s, dialogues: ['dlg_vial_look'], unlocked: null });
    expect(investigate({ id: 'x' }, s, data)).toEqual({ state: s, dialogues: [], unlocked: null });
  });
  it('鎖著且沒有免費解法：look → locked，絕不扣殘響', () => {
    const s = st();
    expect(investigate(door, s, data)).toEqual({ state: s, dialogues: ['dlg_door_look', 'dlg_door_locked'], unlocked: false });
  });
  it('鎖著但有鑰匙：look → on_item，設旗標', () => {
    const r = investigate(door, st({ items: { attic_key: 1 } }), data);
    expect(r.dialogues).toEqual(['dlg_door_look', 'dlg_door_key']);
    expect(r.unlocked).toBe(true);
    expect(r.state.flags.door_open).toBe(true);
    expect(r.state.echo.charges).toBe(2);
  });
  it('鎖著但譜系有 trace：look → on_tag，不扣殘響', () => {
    const r = investigate(door, st({ lineage: { id: 'hound', rank: 9 } }), data);
    expect(r.dialogues).toEqual(['dlg_door_look', 'dlg_door_echo']);
    expect(r.state.echo.charges).toBe(2);
  });
  it('沒有 look 的鎖：locked 代替它', () => {
    const { look: _l, ...noLook } = door;
    expect(investigate(noLook, st(), data).dialogues).toEqual(['dlg_door_locked']);
  });
  it('已解開：只播 look', () => {
    const s = st({ flags: { door_open: true } });
    expect(investigate(door, s, data)).toEqual({ state: s, dialogues: ['dlg_door_look'], unlocked: true });
  });
});

describe('echoAvailable（HUD 用）', () => {
  it('次數、是否免費、是否可用', () => {
    expect(echoAvailable(st(), data)).toEqual({ free: false, charges: 2, usable: true });
    expect(echoAvailable(st({ echo: { charges: 0 } }), data)).toEqual({ free: false, charges: 0, usable: false });
    expect(echoAvailable(st({ echo: { charges: 0 }, lineage: { id: 'hound', rank: 9 } }), data)).toEqual({ free: true, charges: 0, usable: true });
  });
});

// ───────────── M2：物件的 battle 欄位 ─────────────
import { investigate } from '../../web/src/core/interact.js';
describe('調查有 battle 的物件', () => {
  it('先播 look，再開戰：回傳值帶 battle；沒有 battle 的物件不帶這個鍵', () => {
    const foe = { id: 'obj_foe', x: 1, y: 0, solid: true, look: 'dlg_foe', battle: 'enc_one' };
    expect(investigate(foe, st(), data)).toEqual({ state: st(), dialogues: ['dlg_foe'], unlocked: null, battle: 'enc_one' });
    expect(investigate({ ...foe, look: undefined }, st(), data)).toEqual({ state: st(), dialogues: [], unlocked: null, battle: 'enc_one' });
    expect(Object.hasOwn(investigate(plain, st(), data), 'battle')).toBe(false);
  });
});
