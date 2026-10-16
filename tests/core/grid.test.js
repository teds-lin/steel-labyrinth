import { describe, it, expect } from 'vitest';
import { DIRS, canMove, step, enterMap, objectVisible, isUnlocked, tileIdAt, mapSize, onceFlag } from '../../web/src/core/grid.js';

const data = {
  tiles: [{ id: 'wall', solid: true }, { id: 'floor', solid: false }],
  maps: [],
};
//          0123456
const map = {
  id: 'attic', name: '閣樓',
  tiles: [
    '#######', // y0
    '#.....#', // y1
    '#.....#', // y2
    '###.###', // y3  門在 (3,3)? 不，門是物件；這裡 (3,3) 是地板
    '#.....#', // y4
    '#######', // y5
  ],
  legend: { '#': 'wall', '.': 'floor' },
  spawns: [{ id: 'default', x: 1, y: 1, dir: 'down' }, { id: 'back', x: 5, y: 4, dir: 'up' }],
  on_enter: 'dlg_enter',
  objects: [
    { id: 'obj_box', x: 2, y: 1, solid: true, look: 'dlg_box' },
    { id: 'obj_ghost', x: 1, y: 2, solid: true, if: { flag: 'ghost_here' } },
    { id: 'obj_rug', x: 4, y: 2, solid: false },
    { id: 'obj_door', x: 3, y: 3, solid: true, lock: { flag: 'door_open', solvable_by: ['trace'], fallback: 'item:key' } },
  ],
  exits: [
    { x: 1, y: 4, to: 'stairs', spawn: 'from_attic', requires: { flag: 'stairs_ok' }, blocked: 'dlg_blocked' },
    { x: 5, y: 1, to: 'roof', spawn: 'in' },
  ],
  triggers: [
    { id: 'trg_once', x: 3, y: 2, dialogue: 'dlg_once', once: true },
    { id: 'trg_cond', x: 2, y: 2, dialogue: 'dlg_cond', if: { flag: 'cond' } },
    { id: 'trg_repeat', x: 4, y: 4, dialogue: 'dlg_rep' },
  ],
};
data.maps.push(map);
const st = (x, y, dir = 'down', flags = {}) => ({ location: { map: 'attic', x, y, dir }, flags, items: {}, echo: { charges: 0 } });

describe('基本工具', () => {
  it('mapSize／tileIdAt', () => {
    expect(mapSize(map)).toEqual({ width: 7, height: 6 });
    expect(tileIdAt(map, 0, 0)).toBe('wall');
    expect(tileIdAt(map, 1, 1)).toBe('floor');
    expect(tileIdAt(map, 7, 0)).toBeNull();
    expect(tileIdAt(map, -1, 0)).toBeNull();
  });
  it('DIRS', () => {
    expect(DIRS.up).toEqual({ dx: 0, dy: -1 });
    expect(DIRS.right).toEqual({ dx: 1, dy: 0 });
  });
  it('objectVisible／isUnlocked', () => {
    expect(objectVisible(map.objects[1], st(1, 1))).toBe(false);
    expect(objectVisible(map.objects[1], st(1, 1, 'down', { ghost_here: true }))).toBe(true);
    expect(isUnlocked(map.objects[3], st(1, 1))).toBe(false);
    expect(isUnlocked(map.objects[3], st(1, 1, 'down', { door_open: true }))).toBe(true);
    expect(isUnlocked(map.objects[0], st(1, 1))).toBe(false);
  });
});

describe('canMove', () => {
  it('地圖外與 solid 地形不能走', () => {
    expect(canMove(map, st(1, 1), -1, 1, data)).toBe(false);
    expect(canMove(map, st(1, 1), 0, 1, data)).toBe(false);
    expect(canMove(map, st(1, 1), 1, 2, data)).toBe(true);
  });
  it('solid 物件擋路；非 solid 物件不擋', () => {
    expect(canMove(map, st(1, 1), 2, 1, data)).toBe(false);
    expect(canMove(map, st(1, 1), 4, 2, data)).toBe(true);
  });
  it('if 不成立的物件不存在', () => {
    expect(canMove(map, st(1, 1), 1, 2, data)).toBe(true);
    expect(canMove(map, st(1, 1, 'down', { ghost_here: true }), 1, 2, data)).toBe(false);
  });
  it('已解開的 lock 物件不再阻擋', () => {
    expect(canMove(map, st(3, 2), 3, 3, data)).toBe(false);
    expect(canMove(map, st(3, 2, 'down', { door_open: true }), 3, 3, data)).toBe(true);
  });
  it('legend 沒定義的字元或未知地形一律當牆', () => {
    const bad = { ...map, tiles: ['?.'], legend: { '.': 'floor', '?': 'lava' }, objects: [] };
    expect(canMove(bad, st(1, 0), 0, 0, data)).toBe(false);
    const bad2 = { ...map, tiles: ['x.'], legend: { '.': 'floor' }, objects: [] };
    expect(canMove(bad2, st(1, 0), 0, 0, data)).toBe(false);
  });
});

describe('step', () => {
  it('移動成功：更新位置與面向，不修改輸入', () => {
    const s = st(1, 1, 'up');
    const r = step(map, s, 'down', data);
    expect(r.moved).toBe(true);
    expect(r.state.location).toEqual({ map: 'attic', x: 1, y: 2, dir: 'down' });
    expect(r.event).toBeNull();
    expect(s.location).toEqual({ map: 'attic', x: 1, y: 1, dir: 'up' });
  });
  it('撞牆：不移動但轉向，事件 bump', () => {
    const r = step(map, st(1, 1, 'down'), 'left', data);
    expect(r.moved).toBe(false);
    expect(r.state.location).toMatchObject({ x: 1, y: 1, dir: 'left' });
    expect(r.event).toEqual({ type: 'bump', x: 0, y: 1 });
  });
  it('撞到 solid 物件也是 bump，並帶物件 id', () => {
    expect(step(map, st(1, 1), 'right', data).event).toEqual({ type: 'bump', x: 2, y: 1, object: 'obj_box' });
  });
  it('進入出口：移動並回報 exit 事件', () => {
    const r = step(map, st(4, 1), 'right', data);
    expect(r.moved).toBe(true);
    expect(r.event).toEqual({ type: 'exit', to: 'roof', spawn: 'in' });
  });
  it('出口 requires 不成立：不移動，回報 blocked 與對話', () => {
    const r = step(map, st(2, 4), 'left', data);
    expect(r.moved).toBe(false);
    expect(r.state.location).toMatchObject({ x: 2, y: 4, dir: 'left' });
    expect(r.event).toEqual({ type: 'blocked', x: 1, y: 4, dialogue: 'dlg_blocked' });
    const ok = step(map, st(2, 4, 'down', { stairs_ok: true }), 'left', data);
    expect(ok.event).toEqual({ type: 'exit', to: 'stairs', spawn: 'from_attic' });
  });
  it('觸發點：once 只觸發一次（記旗標）', () => {
    const r = step(map, st(3, 1), 'down', data);
    expect(r.event).toEqual({ type: 'trigger', id: 'trg_once', dialogue: 'dlg_once' });
    expect(r.state.flags[onceFlag('attic', 'trg_once')]).toBe(true);
    const back = step(map, r.state, 'up', data);
    const again = step(map, back.state, 'down', data);
    expect(again.event).toBeNull();
  });
  it('觸發點：if 不成立不觸發；沒有 once 每次都觸發', () => {
    expect(step(map, st(2, 1 + 0, 'down'), 'down', data).event).toBeNull(); // (2,1) 是箱子，不能站，改用 (1,2)→right
    expect(step(map, st(1, 2), 'right', data).event).toBeNull();
    expect(step(map, st(1, 2, 'down', { cond: true }), 'right', data).event).toMatchObject({ id: 'trg_cond' });
    const a = step(map, st(3, 4), 'right', data);
    expect(a.event).toMatchObject({ id: 'trg_repeat' });
    const b = step(map, step(map, a.state, 'left', data).state, 'right', data);
    expect(b.event).toMatchObject({ id: 'trg_repeat' });
  });
  it('未知方向丟錯', () => {
    expect(() => step(map, st(1, 1), 'north', data)).toThrow(/方向/);
  });
});

describe('enterMap', () => {
  it('依 spawn 放置，第一次進入播 on_enter 並記 enter:<id>', () => {
    const s0 = { location: { map: 'x', x: 0, y: 0, dir: 'down' }, flags: {} };
    const r = enterMap(s0, data, 'attic', 'back');
    expect(r.state.location).toEqual({ map: 'attic', x: 5, y: 4, dir: 'up' });
    expect(r.dialogue).toBe('dlg_enter');
    expect(r.state.flags['enter:attic']).toBe(true);
    const r2 = enterMap(r.state, data, 'attic', 'default');
    expect(r2.dialogue).toBeNull();
    expect(s0.flags).toEqual({});
  });
  it('地圖或 spawn 不存在 → 丟錯', () => {
    expect(() => enterMap({ flags: {} }, data, 'nope', 'default')).toThrow(/nope/);
    expect(() => enterMap({ flags: {} }, data, 'attic', 'nope')).toThrow(/nope/);
  });
});
