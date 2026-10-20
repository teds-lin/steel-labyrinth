// 美術覆蓋（web/src/textures.js 的 artReport）：資料裡出現、但沒有專屬畫法（會退回預設圖）的 sprite／tile／戰鬥背景一律報出。
// 關卡設計師新增 sprite／tile 後重建 web/data，這個測試會在 npm test 擋下還沒畫的貼圖（E2E battle.spec 另有一份）。
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDir, M5_FIXTURE_DIR, WEB_DATA_DIR } from './load-fixture.js';

let artReport;
let artLint;
beforeAll(async () => {
  // textures.js 透過 config.js 讀 window（瀏覽器環境）；node 裡給一個最小的替身
  globalThis.window ??= { location: { search: '', hostname: 'localhost' }, devicePixelRatio: 1 };
  ({ artReport, artLint } = await import('../../web/src/textures.js'));
});

describe('artReport', () => {
  it('正式資料 web/data：沒有任何退回預設圖的 sprite／tile／戰鬥背景', () => {
    const r = artReport(loadDir(WEB_DATA_DIR));
    expect(r.sprites, '缺專屬點陣圖的 sprite').toEqual([]);
    expect(r.tiles, '缺專屬畫法的 tile').toEqual([]);
    expect(r.bgs, '缺專屬畫法的戰鬥背景').toEqual([]);
  });
  it('M5 測試 fixture 也沒有缺圖', () => {
    const r = artReport(loadDir(M5_FIXTURE_DIR));
    expect([...r.sprites, ...r.tiles, ...r.bgs]).toEqual([]);
  });
  it('新的 sprite／tile／背景／夢客頭像沒有專屬畫法時會被報出（地圖物件、角色、敵人、夢客、地形、遭遇都掃）', () => {
    const d = structuredClone(loadDir(M5_FIXTURE_DIR));
    d.maps[0].objects.push({ id: 'obj_new', x: 1, y: 6, sprite: 'brand_new_statue', solid: true });
    d.tiles.push({ id: 'brand_new_tile', solid: false, color: '#123456' });
    d.story[0].guests[0].sprite = 'brand_new_guest';
    d.enemies.push({ id: 'brand_new_enemy', sprite: 'brand_new_enemy' });
    d.characters.push({ id: 'npc_x', sprite: 'brand_new_ally' });
    d.encounters.push({ id: 'enc_x', enemies: [], bg: 'brand_new_bg' });
    const r = artReport(d);
    expect(r.sprites).toEqual(['brand_new_ally', 'brand_new_enemy', 'brand_new_guest', 'brand_new_statue']);
    expect(r.tiles).toEqual(['brand_new_tile']);
    expect(r.bgs).toEqual(['brand_new_bg']);
  });
  it('原型鏈上的名字（toString、constructor）不會被當成有畫法', () => {
    const d = structuredClone(loadDir(M5_FIXTURE_DIR));
    d.maps[0].objects.push({ id: 'obj_proto', x: 1, y: 6, sprite: 'toString', solid: true });
    d.tiles.push({ id: 'constructor', solid: false });
    const r = artReport(d);
    expect(r.sprites).toContain('toString');
    expect(r.tiles).toContain('constructor');
  });
  it('所有點陣格式正確：地圖 12×12、Boss 立繪 24×24，顏色代號都在色盤裡', () => {
    expect(artLint()).toEqual([]);
  });
});
