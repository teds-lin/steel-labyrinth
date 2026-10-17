// 規格補充 3 第 5 條：逃跑退回前一格之前先檢查 canMove；前一格目前不能站時留在原地。
import { describe, it, expect } from 'vitest';
import { fleeBackLocation } from '../../web/src/core/grid.js';

const data = { tiles: [{ id: 'wall', solid: true }, { id: 'floor', solid: false }], maps: [] };
const map = {
  id: 'dock', name: '碼頭',
  tiles: ['#####', '#...#', '#####'],
  legend: { '#': 'wall', '.': 'floor' },
  spawns: [{ id: 'default', x: 1, y: 1 }],
  // 戰鬥中（例如勝利旗標或劇情）擋住退路的物件：flag 成立時才出現
  objects: [{ id: 'obj_crate', x: 1, y: 1, solid: true, if: { flag: 'crate_fell' } }],
};
const here = { map: 'dock', x: 2, y: 1, dir: 'left' };
const from = { map: 'dock', x: 1, y: 1, dir: 'right' };
const st = (flags = {}) => ({ location: here, flags });

describe('fleeBackLocation', () => {
  it('前一格可以站 → 回到前一格（方向照踩上之前）', () => {
    expect(fleeBackLocation(map, st(), from, data)).toEqual(from);
  });
  it('前一格現在被擋住（物件出現）→ 留在原地', () => {
    expect(fleeBackLocation(map, st({ crate_fell: true }), from, data)).toEqual(here);
  });
  it('前一格是牆、不同地圖、沒有前一格 → 留在原地', () => {
    expect(fleeBackLocation(map, st(), { ...from, x: 0 }, data)).toEqual(here);
    expect(fleeBackLocation(map, st(), { ...from, map: 'street' }, data)).toEqual(here);
    expect(fleeBackLocation(map, st(), null, data)).toEqual(here);
  });
});
