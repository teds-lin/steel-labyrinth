// 程式產生所有像素貼圖（不下載外部素材）。
// 地形：依 tiles.json 的 color 畫 24×24 格子＋紋理；物件與主角：12×12 點陣放大 2 倍。
import { TILE } from './config.js';

// ---------- 顏色工具 ----------
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  const n = m ? parseInt(m[1], 16) : 0x555b66;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
/** amt > 0 變亮、< 0 變暗（-1～1）。 */
function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex);
  const f = (c) => (amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  return `rgb(${clamp(f(r))},${clamp(f(g))},${clamp(f(b))})`;
}
function rgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** 固定種子的亂數，讓每次產生的紋理一樣。 */
function rng(seedStr) {
  let h = 2166136261;
  for (const ch of String(seedStr)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function makeCanvas(scene, key, w, h) {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, w, h);
  return { tex, ctx: tex.getContext() };
}

// ---------- 地形紋理 ----------
const S = TILE;

function px(ctx, color, x, y, w = 1, h = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function noise(ctx, base, rand, count, amt) {
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rand() * S);
    const y = Math.floor(rand() * S);
    px(ctx, shade(base, (rand() - 0.5) * amt), x, y, 1, 1);
  }
}

function bricks(ctx, base, rand) {
  px(ctx, shade(base, -0.35), 0, 0, S, S); // 灰縫
  const bh = 6;
  for (let row = 0; row < S / bh; row++) {
    const off = row % 2 ? 6 : 0;
    for (let x = -off; x < S; x += 12) {
      const c = shade(base, (rand() - 0.5) * 0.18);
      px(ctx, c, x + 1, row * bh + 1, 10, bh - 1);
      px(ctx, shade(base, 0.12), x + 1, row * bh + 1, 10, 1); // 上緣反光
    }
  }
}

function planks(ctx, base, rand, dark = 0) {
  const b = dark ? shade(base, -0.15) : base;
  px(ctx, b, 0, 0, S, S);
  for (let row = 0; row < 4; row++) {
    const y = row * 6;
    px(ctx, shade(base, -0.35), 0, y + 5, S, 1);
    const seam = Math.floor(rand() * 18) + 3;
    px(ctx, shade(base, -0.3), seam, y, 1, 5);
    for (let i = 0; i < 4; i++) px(ctx, shade(base, (rand() - 0.5) * 0.25), Math.floor(rand() * S), y + 1 + Math.floor(rand() * 4), 3, 1);
  }
}

function slabs(ctx, base, rand, size = 8) {
  px(ctx, shade(base, -0.38), 0, 0, S, S);
  for (let y = 0; y < S; y += size) {
    const off = (y / size) % 2 ? size / 2 : 0;
    for (let x = -off; x < S; x += size) {
      px(ctx, shade(base, (rand() - 0.5) * 0.22), x + 1, y + 1, size - 1, size - 1);
      px(ctx, shade(base, 0.14), x + 1, y + 1, size - 1, 1);
    }
  }
}

function fogWisps(ctx, rand, color, alpha, n) {
  for (let i = 0; i < n; i++) {
    const w = 6 + Math.floor(rand() * 12);
    px(ctx, rgba(color, alpha * (0.5 + rand() * 0.5)), Math.floor(rand() * S) - 3, Math.floor(rand() * S), w, 2);
  }
}

function furniture(ctx, base) {
  px(ctx, shade(base, -0.45), 0, 0, S, S);
  px(ctx, base, 1, 2, S - 2, S - 4);
  px(ctx, shade(base, 0.18), 1, 2, S - 2, 2);
  px(ctx, shade(base, -0.25), 1, S - 4, S - 2, 2);
}

const TILE_PAINTERS = {
  wall: (ctx, c, r) => bricks(ctx, c, r),
  facade: (ctx, c, r) => bricks(ctx, c, r),
  floor: (ctx, c, r) => planks(ctx, c, r),
  threshold: (ctx, c, r) => planks(ctx, c, r, 1),
  rug: (ctx, c, r) => {
    px(ctx, c, 0, 0, S, S);
    noise(ctx, c, r, 40, 0.2);
    px(ctx, shade(c, 0.25), 2, 2, S - 4, 1); px(ctx, shade(c, 0.25), 2, S - 3, S - 4, 1);
    px(ctx, shade(c, 0.25), 2, 2, 1, S - 4); px(ctx, shade(c, 0.25), S - 3, 2, 1, S - 4);
    px(ctx, '#c08a3e', 11, 11, 2, 2);
  },
  window: (ctx, c) => {
    px(ctx, '#3b2c24', 0, 0, S, S);
    px(ctx, shade(c, -0.1), 3, 3, S - 6, S - 8);
    px(ctx, '#3b2c24', 11, 3, 2, S - 8); px(ctx, '#3b2c24', 3, 10, S - 6, 2);
    px(ctx, 'rgba(240,168,72,0.85)', 6, 6, 2, 2); px(ctx, 'rgba(240,168,72,0.6)', 16, 14, 2, 2);
    px(ctx, shade(c, 0.35), 4, 4, 5, 1);
    px(ctx, '#5b4636', 1, S - 5, S - 2, 3);
  },
  bed: (ctx, c) => { furniture(ctx, c); px(ctx, '#e8e2d4', 3, 4, S - 6, 6); px(ctx, shade(c, 0.2), 3, 11, S - 6, 1); },
  desk: (ctx, c) => { furniture(ctx, c); px(ctx, shade(c, -0.3), 4, 12, 6, 1); px(ctx, '#c08a3e', 6, 14, 2, 1); },
  wardrobe: (ctx, c) => { furniture(ctx, c); px(ctx, shade(c, -0.4), 11, 2, 1, S - 4); px(ctx, '#c08a3e', 9, 12, 1, 2); px(ctx, '#c08a3e', 13, 12, 1, 2); },
  stove: (ctx, c) => {
    furniture(ctx, '#3a3d44');
    px(ctx, shade(c, -0.3), 5, 9, 14, 9);
    px(ctx, '#f0a848', 7, 12, 10, 4); px(ctx, '#ffd08a', 9, 13, 5, 2);
    px(ctx, '#2a2e38', 10, 0, 4, 3);
  },
  mirror: (ctx, c) => {
    px(ctx, '#4f3824', 0, 0, S, S);
    px(ctx, c, 3, 2, S - 6, S - 4);
    for (let i = 0; i < 8; i++) px(ctx, shade(c, 0.4), 5 + i, 4 + i, 2, 1);
  },
  wall_lamp: (ctx, c, r) => {
    bricks(ctx, '#2b2f3a', r);
    px(ctx, rgba(c, 0.25), 4, 4, 16, 16);
    px(ctx, '#2a2e38', 11, 4, 2, 6);
    px(ctx, c, 8, 10, 8, 7); px(ctx, '#ffe2b0', 10, 12, 4, 3);
  },
  gas_lamp: (ctx, c, r) => {
    slabs(ctx, '#565c66', r);
    px(ctx, rgba(c, 0.22), 2, 0, 20, 14);
    px(ctx, '#20242c', 11, 8, 3, 16);
    px(ctx, '#20242c', 8, 1, 9, 2);
    px(ctx, c, 9, 3, 7, 6); px(ctx, '#fff0cc', 11, 4, 3, 3);
  },
  stairs_up: (ctx, c) => {
    for (let i = 0; i < 6; i++) { px(ctx, shade(c, 0.15 - i * 0.07), 0, i * 4, S, 4); px(ctx, shade(c, -0.4), 0, i * 4 + 3, S, 1); }
  },
  stairs_down: (ctx, c) => {
    for (let i = 0; i < 6; i++) { px(ctx, shade(c, -0.25 + i * 0.07), 0, i * 4, S, 4); px(ctx, shade(c, 0.2), 0, i * 4, S, 1); }
  },
  railing: (ctx, c) => {
    px(ctx, '#3a3530', 0, 0, S, S);
    px(ctx, shade(c, 0.2), 0, 3, S, 3);
    for (let x = 2; x < S; x += 5) px(ctx, c, x, 6, 2, S - 7);
  },
  iron_rail: (ctx, c) => {
    px(ctx, '#3b414c', 0, 0, S, S);
    px(ctx, shade(c, 0.25), 0, 4, S, 2); px(ctx, shade(c, 0.25), 0, 16, S, 2);
    for (let x = 1; x < S; x += 6) px(ctx, c, x, 2, 2, S - 2);
  },
  front_door: (ctx, c, r) => {
    planks(ctx, c, r);
    px(ctx, shade(c, -0.45), 0, 0, 2, S); px(ctx, shade(c, -0.45), S - 2, 0, 2, S);
    px(ctx, '#f0a848', 17, 12, 2, 2);
  },
  stoop: (ctx, c, r) => slabs(ctx, c, r, 12),
  cobblestone: (ctx, c, r) => slabs(ctx, c, r, 8),
  mist: (ctx, c, r) => { slabs(ctx, '#565c66', r); fogWisps(ctx, r, c, 0.55, 9); },
  fog: (ctx, c, r) => { px(ctx, c, 0, 0, S, S); noise(ctx, c, r, 60, 0.12); fogWisps(ctx, r, '#dfe5ea', 0.5, 7); },
  // ---- 第一章：辦公室、練習室 ----
  bookshelf: (ctx, c, r) => {
    furniture(ctx, c);
    const spines = ['#7a3b2e', '#3e4c63', '#c8b88a', '#4f6a44', '#6a4f7a', '#8a6a3a'];
    for (const y0 of [3, 12]) {
      let x = 2;
      while (x < S - 3) {
        const w = 2 + Math.floor(r() * 2);
        const h = 6 + Math.floor(r() * 2);
        px(ctx, spines[Math.floor(r() * spines.length)], x, y0 + (8 - h), w, h);
        px(ctx, '#e8e2d4', x, y0 + 8 - h + 2, w, 1);
        x += w + 1;
      }
      px(ctx, shade(c, -0.4), 1, y0 + 8, S - 2, 1);
    }
  },
  medicine_cabinet: (ctx, c) => {
    furniture(ctx, c);
    px(ctx, '#c8dde6', 3, 3, 8, 15); px(ctx, '#c8dde6', 13, 3, 8, 15);
    px(ctx, shade(c, -0.3), 3, 10, 18, 1);
    for (const [x, y, col] of [[4, 5, '#5f7f4a'], [7, 6, '#8a3b2e'], [14, 5, '#b4bec8'], [17, 6, '#5f7f4a'], [5, 12, '#d9c99a'], [15, 12, '#8a3b2e'], [18, 13, '#3e4c63']]) {
      px(ctx, col, x, y, 2, 4);
    }
    px(ctx, '#f0a848', 11, 19, 2, 1);
  },
  sofa: (ctx, c) => {
    px(ctx, shade(c, -0.5), 0, 0, S, S);
    px(ctx, shade(c, -0.15), 1, 2, S - 2, 8);   // 椅背
    px(ctx, c, 1, 10, S - 2, 9);                 // 坐墊
    px(ctx, shade(c, 0.18), 2, 10, S - 4, 1);
    px(ctx, shade(c, -0.35), 12, 10, 1, 9);
    px(ctx, shade(c, -0.25), 0, 6, 3, 14); px(ctx, shade(c, -0.25), S - 3, 6, 3, 14); // 扶手
    px(ctx, '#2a1a14', 2, 20, 2, 3); px(ctx, '#2a1a14', S - 4, 20, 2, 3);
  },
  tea_table: (ctx, c) => {
    px(ctx, '#3a2c22', 0, 0, S, S);
    px(ctx, c, 2, 5, S - 4, 12);
    px(ctx, shade(c, 0.2), 2, 5, S - 4, 1);
    px(ctx, shade(c, -0.35), 2, 16, S - 4, 2);
    px(ctx, '#e8e2d4', 6, 8, 5, 4); px(ctx, '#e8e2d4', 11, 9, 2, 1); px(ctx, '#9aa6b4', 7, 7, 3, 1); // 茶壺
    px(ctx, '#e8e2d4', 15, 10, 3, 2); px(ctx, '#8a4a24', 16, 10, 1, 1);                             // 茶杯
    px(ctx, shade(c, -0.4), 4, 18, 2, 5); px(ctx, shade(c, -0.4), S - 6, 18, 2, 5);
  },
  counter: (ctx, c, r) => {
    planks(ctx, c, r, 1);
    px(ctx, shade(c, 0.25), 0, 2, S, 3);
    px(ctx, shade(c, -0.45), 0, 5, S, 1);
    px(ctx, '#d9c99a', 4, 0, 6, 2); px(ctx, '#3b2c24', 5, 0, 4, 1); // 帳本
  },
  training_mat: (ctx, c, r) => {
    px(ctx, c, 0, 0, S, S);
    noise(ctx, c, r, 70, 0.16);
    px(ctx, shade(c, -0.3), 0, 0, S, 1); px(ctx, shade(c, -0.3), 0, 0, 1, S);
    for (let i = 0; i < 3; i++) px(ctx, shade(c, -0.18), Math.floor(r() * 18) + 2, Math.floor(r() * 18) + 2, 4, 1);
  },
  weapon_rack: (ctx, c, r) => {
    bricks(ctx, '#2b2f3a', r);
    px(ctx, c, 2, 6, S - 4, 2); px(ctx, c, 2, 18, S - 4, 2);
    for (const [x, col] of [[5, '#9a7350'], [9, '#a9b6c2'], [13, '#9a7350'], [17, '#6f7e8c']]) px(ctx, col, x, 3, 2, 18);
    px(ctx, '#d0d4d8', 9, 2, 2, 2);
  },
  // ---- 第二章：碼頭、倉庫 ----
  harbor_water: (ctx, c, r) => {
    px(ctx, c, 0, 0, S, S);
    noise(ctx, c, r, 40, 0.15);
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(r() * 18);
      const y = Math.floor(r() * 22);
      px(ctx, shade(c, 0.28), x, y, 4 + Math.floor(r() * 4), 1);
      px(ctx, shade(c, -0.2), x + 1, y + 1, 3, 1);
    }
  },
  pier: (ctx, c, r) => {
    px(ctx, shade(c, -0.45), 0, 0, S, S);
    for (let x = 0; x < S; x += 6) {
      px(ctx, shade(c, (r() - 0.5) * 0.2), x, 0, 5, S);
      px(ctx, shade(c, 0.15), x, 0, 1, S);
      px(ctx, '#2a2420', x + 2, 4, 1, 1); px(ctx, '#2a2420', x + 2, 19, 1, 1);
    }
  },
  bollard: (ctx, c, r) => {
    TILE_PAINTERS.pier(ctx, '#6b5840', r);
    px(ctx, 'rgba(0,0,0,0.35)', 6, 15, 13, 5);
    px(ctx, c, 7, 6, 10, 12);
    px(ctx, shade(c, 0.3), 7, 6, 10, 2);
    px(ctx, shade(c, -0.3), 5, 8, 14, 3);
    px(ctx, '#d9c99a', 4, 11, 16, 1); // 纜繩
  },
  crane: (ctx, c) => {
    px(ctx, '#2f3440', 0, 0, S, S);
    px(ctx, c, 3, 0, 3, S); px(ctx, c, S - 6, 0, 3, S);
    for (let y = 0; y < S; y += 8) {
      for (let i = 0; i < 8; i++) { px(ctx, shade(c, -0.15), 6 + i * 1.5, y + i, 2, 1); }
      px(ctx, shade(c, 0.2), 3, y, S - 6, 1);
    }
    px(ctx, '#3b2c24', 4, 10, 1, 2); px(ctx, '#3b2c24', S - 5, 17, 1, 2); // 鏽斑
  },
  rail_track: (ctx, c, r) => {
    slabs(ctx, '#565c66', r, 8);
    for (let x = 1; x < S; x += 6) px(ctx, '#4a3a2c', x, 4, 3, 16);   // 枕木
    px(ctx, '#9aa6b4', 0, 7, S, 2); px(ctx, '#9aa6b4', 0, 15, S, 2); // 鐵軌
    px(ctx, '#d0d4d8', 0, 7, S, 1); px(ctx, '#d0d4d8', 0, 15, S, 1);
    px(ctx, rgba(c, 0.25), 0, 0, S, S);
  },
  crate: (ctx, c) => {
    px(ctx, shade(c, -0.5), 0, 0, S, S);
    px(ctx, c, 1, 1, S - 2, S - 2);
    px(ctx, shade(c, -0.3), 1, 8, S - 2, 1); px(ctx, shade(c, -0.3), 1, 15, S - 2, 1);
    for (let i = 0; i < S - 4; i++) px(ctx, shade(c, 0.12), 2 + i, 2 + i, 2, 1);
    px(ctx, shade(c, 0.2), 1, 1, S - 2, 1);
    px(ctx, '#2a2e38', 3, 3, 1, 1); px(ctx, '#2a2e38', S - 4, 3, 1, 1); px(ctx, '#2a2e38', 3, S - 4, 1, 1); px(ctx, '#2a2e38', S - 4, S - 4, 1, 1);
  },
  warehouse_wall: (ctx, c, r) => {
    px(ctx, c, 0, 0, S, S);
    for (let x = 0; x < S; x += 4) { px(ctx, shade(c, 0.16), x, 0, 1, S); px(ctx, shade(c, -0.25), x + 2, 0, 1, S); }
    px(ctx, shade(c, -0.4), 0, 11, S, 1);
    for (let i = 0; i < 4; i++) px(ctx, 'rgba(122,82,48,0.55)', Math.floor(r() * 20), 12 + Math.floor(r() * 10), 2, 3); // 鏽痕
  },
  // ---- M4：鐘塔之夢 ----
  tower_wall: (ctx, c, r) => { bricks(ctx, c, r); fogWisps(ctx, r, '#8c98a6', 0.25, 4); },
  clock_face: (ctx, c, r) => {
    px(ctx, shade(c, -0.25), 0, 0, S, S);
    px(ctx, c, 1, 1, S - 2, S - 2);
    noise(ctx, c, r, 30, 0.12);
    px(ctx, shade(c, -0.55), S / 2 - 1, 3, 2, 5); // 刻度
    px(ctx, shade(c, -0.45), 3, S / 2 - 1, 4, 2);
    px(ctx, shade(c, -0.45), S - 7, S / 2 - 1, 4, 2);
    px(ctx, shade(c, 0.3), 2, 2, S - 4, 1);
  },
  dream_floor: (ctx, c, r) => { slabs(ctx, c, r, 12); fogWisps(ctx, r, '#b4bec8', 0.3, 5); },
  high_chair: (ctx, c) => {
    px(ctx, '#3a4256', 0, 0, S, S); // 夢境地板色的底
    px(ctx, shade(c, -0.4), 5, 1, S - 10, S - 4);
    px(ctx, c, 6, 2, S - 12, 12);
    px(ctx, shade(c, 0.2), 6, 2, S - 12, 2);
    px(ctx, shade(c, -0.2), 4, 14, S - 8, 5);
    px(ctx, shade(c, -0.5), 5, 19, 2, 4); px(ctx, shade(c, -0.5), S - 7, 19, 2, 4);
  },
  tower_gate: (ctx, c, r) => {
    px(ctx, c, 0, 0, S, S);
    noise(ctx, c, r, 40, 0.1);
    px(ctx, 'rgba(255,255,255,0.45)', 4, 0, S - 8, S);
    fogWisps(ctx, r, '#ffffff', 0.5, 6);
  },
  concrete_floor: (ctx, c, r) => {
    px(ctx, c, 0, 0, S, S);
    noise(ctx, c, r, 80, 0.14);
    px(ctx, shade(c, -0.3), 0, 0, S, 1); px(ctx, shade(c, -0.3), 0, 0, 1, S);
    let x = Math.floor(r() * 12) + 4;
    for (let y = 3; y < 18; y++) { px(ctx, shade(c, -0.35), x, y, 1, 1); if (r() < 0.4) x += r() < 0.5 ? -1 : 1; }
    px(ctx, 'rgba(30,34,40,0.35)', 14, 15, 6, 4); // 油漬
  },
};

function paintTile(ctx, tile) {
  const rand = rng(tile.id);
  const color = /^#[0-9a-f]{6}$/i.test(tile.color ?? '') ? tile.color : '#555b66';
  const painter = TILE_PAINTERS[tile.id];
  if (painter) {
    painter(ctx, color, rand);
  } else if (tile.solid) {
    furniture(ctx, color);
  } else {
    px(ctx, color, 0, 0, S, S);
    noise(ctx, color, rand, 50, 0.18);
  }
}

// ---------- 點陣圖示（12×12，放大 2 倍） ----------
const PAL = {
  k: '#15171c', K: '#2a2e38', h: '#3b2c24', p: '#e2bc98', c: '#3e4c63', C: '#2c3646',
  o: '#f0a848', O: '#b8692a', w: '#e8e2d4', s: '#a9b6c2', S: '#6f7e8c', m: '#7a5636',
  M: '#4f3824', b: '#6f8296', y: '#d9c99a', r: '#8a3b2e', v: '#d8ecf6',
  // M2 起新增
  g: '#7d8996', G: '#5a6470', l: '#c8d0d8', f: '#a4aeb8', a: '#6a4f7a', A: '#4a3658', d: '#7a2e2a',
  u: '#4f6f8f', e: '#5f7f4a', q: '#9a7350', x: '#f4f1e8', z: '#ffd870',
};

const ICONS = {
  hero_down: [
    '....hhhh....', '...hhhhhh...', '...hpppph...', '...pkppkp...', '...pppppp...', '..cccwwccc..',
    '.ccccwwcccc.', '.pcccoccccp.', '..cccocccc..', '..cccccccc..', '...MM..MM...', '...kk..kk...'],
  hero_up: [
    '....hhhh....', '...hhhhhh...', '...hhhhhh...', '...hhhhhh...', '....pppp....', '..cccccccc..',
    '.cccccccccc.', '.pccccccccp.', '..cccccccc..', '..cccccccc..', '...MM..MM...', '...kk..kk...'],
  hero_left: [
    '....hhhh....', '...hhhhhh...', '...pphhhh...', '...kpphhh...', '...ppppph...', '....cccc....',
    '...cccccc...', '...pccccc...', '...cccccc...', '...cccccc...', '...MM.MM....', '...kk.kk....'],
  nightstand_vial: [
    '............', '.....kk.....', '.....SS.....', '....kvvk....', '....svvs....', '....svvs....',
    '.kkkkkkkkkk.', '.mmmmmmmmmm.', '.mMMMMMMMMm.', '.mMMMooMMMm.', '.mMMMMMMMMm.', '.mm......mm.'],
  window_sill: [
    'kkkkkkkkkkkk', 'kbbbbkkbbbbk', 'kbvbbkkbbobk', 'kbbbbkkbbbbk', 'kbbobkkbvbbk', 'kkkkkkkkkkkk',
    'kbbbbkkbbbbk', 'kbbvbkkbbbbk', 'kbbbbkkbobbk', 'kkkkkkkkkkkk', 'mmmmmmmmmmmm', 'MMMMMMMMMMMM'],
  desk_diary: [
    '............', '............', '............', '..kkkkkkkk..', '.kyyyykyyyyk', '.kyKKykyKKyk',
    '.kyyyykyyyyk', '.kkkkkkkkkkk', 'mmmmmmmmmmmm', 'MMMMMMMMMMMM', '.M........M.', '.M........M.'],
  desk_watch: [
    '............', '.....ss.....', '....s..s....', '...kssssk...', '..ksvwwvsk..', '..kswkwwsk..',
    '..kswkkwsk..', '...kssssk...', 'mmmmmmmmmmmm', 'MMMMMMMMMMMM', '.M........M.', '.M........M.'],
  bed_foot: [
    'MMMMMMMMMMMM', 'MmmmmmmmmmmM', 'kbbbbbbbbbbk', 'kbCbbbbbbCbk', 'kbbbbbbbbbbk', 'kbbCbbbbCbbk',
    'kbbbbbbbbbbk', 'kCCCCCCCCCCk', 'kkkkkkkkkkkk', 'MmmmmmmmmmmM', 'M..........M', 'M..........M'],
  standing_mirror: [
    '...MMMMMM...', '..MvvvvvvM..', '..MvsvvvvM..', '..MvvsvvvM..', '..MvvvsvvM..', '..MvvvvsvM..',
    '..MvvvvvvM..', '..MvvvvvvM..', '...MMMMMM...', '.....MM.....', '....MMMM....', '...M....M...'],
  dresser: [
    '............', '.MMMMMMMMMM.', '.MmmmmmmmmM.', '.MmmmoommmM.', '.MMMMMMMMMM.', '.MmmmmmmmmM.',
    '.MmmmoommmM.', '.MMMMMMMMMM.', '.MmmmmmmmmM.', '.MmmmoommmM.', '.MMMMMMMMMM.', '.M........M.'],
  attic_door: [
    'KMMMMMMMMMMK', 'KMmmmmmmmmMK', 'KMmMMMMMMmMK', 'KMmMmmmmMmMK', 'KMmMmmmmMmMK', 'KMmMMMMMMmMK',
    'KMmmmmmmmoMK', 'KMmMMMMMMmMK', 'KMmMmmmmMmMK', 'KMmMmmmmMmMK', 'KMmMMMMMMmMK', 'KMMMMMMMMMMK'],
  attic_door__open: [
    'KMMMMMMMMMMK', 'KmMkkkkkkkkK', 'KmMkkkkkkkkK', 'KmMkKKKKKKkK', 'KmMkkkkkkkkK', 'KmMoKKKKKKkK',
    'KmMkkkkkkkkK', 'KmMkKKKKKKkK', 'KmMkkkkkkkkK', 'KmMkKKKKKKkK', 'KmMkkkkkkkkK', 'KMMMMMMMMMMK'],
  room_door: [
    'KMMMMMMMMMMK', 'KMmmmmmmmmMK', 'KMmmmyymmmMK', 'KMmmmmmmmmMK', 'KMmMMMMMMmMK', 'KMmMmmmmMmMK',
    'KMmmmmmmmoMK', 'KMmMmmmmMmMK', 'KMmMMMMMMmMK', 'KMmmmmmmmmMK', 'KMmmmmmmmmMK', 'KooooooooooK'],
  hall_table: [
    '...SSSSSS...', '...SbbbbS...', '...SbsbbS...', '...SbbbbS...', '...SSSSSS...', '............',
    '.kkkkkkkkkk.', '.mmmmmmmmmm.', '..M......M..', '..M......M..', '..M......M..', '..M......M..'],
  landlady: [
    '....ssss....', '...ssssss...', '...spppps...', '...pkppkp...', '...pppppp...', '..rrrwwrrr..',
    '.rrrwwwwrrr.', '.prrwwwwrrpo', '..rrwwwwrrOo', '..rrwwwwrr..', '..rrrrrrrr..', '...kk..kk...'],
  white_lamp_man: [
    '....kkkk....', '..kkkkkkkk..', '....pppp....', '....kppk....', '....pppp....', '..KKKKKKKK..',
    '.KKwKKKKKKK.', '.KKKKKKKKKK.', '.pKKKKKKKKp.', '..KKKKKKKK..', '..KKK..KKK..', '..kk....kk..'],
  // ---- M2：角色 ----
  ada: [
    '...rrrrrr...', '..rrrrrrrr..', '..rrpppprr..', '..rpkppkpr..', '..rppppppr..', '..raawwaar..',
    '.raaaaaaaar.', '.paaaaaaaap.', '..aaaaaaaa..', '..AaaaaaaA..', '..AAAAAAAA..', '...kk..kk...'],
  marlo: [
    '...KKKKKK...', '..KKKKKKKK..', '...hpppph...', '...pkppkp...', '...pppppp...', '..KKKwwKKK..',
    '.KKKKKKxKKK.', '.pKKKKKKKKp.', '..KKKKKKKK..', '..KKKKKKKK..', '...KK..KK...', '...kk..kk...'],
  herb: [
    '....ssss....', '...ssssss...', '...spppps...', '...kkppkk...', '...pssssp...', '..mmmwwmmm..',
    '.mmmmwwmmmm.', '.pmmmwwmmmp.', '..mmmmmmmm..', '..MMMMMMMM..', '...MM..MM...', '...kk..kk...'],
  lina: [
    '....uuuu....', '...uuuuuu...', '...uppppu...', '...pkppkp...', '...pppppp...', '..ddwwwwdd..',
    '.dddwwwwddd.', '.pddwwwwddp.', '..ddwwwwdd..', '..dddddddd..', '..dddddddd..', '...kk..kk...'],
  foreman: [
    '...SSSSSS...', '..SSSSSSSS..', '...hpppph...', '...pkppkp...', '...phhhhp...', '.qqqqwwqqqq.',
    'qqqqqwwqqqqq', 'pqqqqwwqqqqp', '.qqqqqqqqqq.', '.CCCCCCCCCC.', '..CCC..CCC..', '..kkk..kkk..'],
  // ---- M2：敵人 ----
  fogwalker: [
    '....gggg....', '...gllllg...', '...gllllg...', '...gllllg...', '....gggg....', '..gggggggg..',
    '.ggglgglggg.', 'gg.gggggg.gg', 'g..gggggg..g', '...gggggg...', '..lg.gg.gl..', '.l..l..l..l.'],
  silent_hauler: [
    'mmmm........', 'mMMm.GGGG...', 'mmmmGffffG..', '.GGGfkffkfG.', '..GGfkkkkfG.', '.GGGGffffGG.',
    'GGbbbbbbbbGG', 'GGbbbbbbbbGG', 'fGbbbbbbbbGf', 'f.bbbbbbbb.f', '..GGG..GGG..', '..kkk..kkk..'],
  // ---- M2：辦公室與練習室的物件 ----
  file_shelf: [
    'MMMMMMMMMMMM', 'MyywyywyywyM', 'MyywyywyywyM', 'MMMMMMMMMMMM', 'MbbwbbwrrwbM', 'MbbwbbwrrwbM',
    'MMMMMMMMMMMM', 'MyywuuwyywyM', 'MyywuuwyywyM', 'MMMMMMMMMMMM', 'M..........M', 'MM........MM'],
  notice_board: [
    'MMMMMMMMMMMM', 'MqqqqqqqqqqM', 'MqwwqqyyyqqM', 'MqwwqqyyyqqM', 'MqqqwwwqqqqM', 'MqyqwwwqrrqM',
    'MqyqqqqqrrqM', 'MqqqwwwwqqqM', 'MMMMMMMMMMMM', '..M......M..', '..M......M..', '..M......M..'],
  potion_cabinet: [
    'MMMMMMMMMMMM', 'MvvvvMMvvvvM', 'MvevvMMvsvvM', 'MvevrMMvsrvM', 'MvvvvMMvvvvM', 'MMMMMoMMMMMM',
    'MvvvvMMvvvvM', 'MvrvvMMvveeM', 'MvrevMMvveeM', 'MvvvvMMvvvvM', 'MMMMMMMMMMMM', 'M..........M'],
  office_door: [
    'KKKKxxxxKKKK', 'KMMMMMMMMMMK', 'KMmmmmmmmmMK', 'KMmvvmmvvmMK', 'KMmvvmmvvmMK', 'KMmmmmmmmmMK',
    'KMmmmmmmmoMK', 'KMmMMMMMMmMK', 'KMmMmmmmMmMK', 'KMmMMMMMMmMK', 'KMmmmmmmmmMK', 'KMMMMMMMMMMK'],
  practice_dummy: [
    '....mmmm....', '....mMMm....', '....mmmm....', '.mmmmmmmmmm.', '.MMMmssmMMM.', '....mmmm....',
    '....mkMm....', '....mmkm....', '....ssss....', '....mmmm....', '...MMMMMM...', '..MMMMMMMM..'],
  // ---- M2：碼頭與倉庫的物件 ----
  wet_glove: [
    '............', '............', '.....b......', '...M.M.M....', '...M.M.M.M..', '...MMMMMMM..',
    '..MMMMMMMM..', '..MMMMMMM...', '...MMMMM.b..', '...hhhhh....', '.b........b.', '............'],
  shed_stove: [
    '.....KK.....', '.....KK.....', '..KKKKKKKK..', '..KkkkkkkK..', '..KkoooOkK..', '..KkozoOkK..',
    '..KkkkkkkK..', '..KKKKKKKK..', '..K......K..', '..K......K..', '.KK......KK.', '............'],
  supply_box: [
    '............', '.mmmmmmmmmm.', '.mMMMMMMMMm.', '.mMmmmmmmMm.', '.mMmmrrmmMm.', '.mMmrrrrmMm.',
    '.mMmrrrrmMm.', '.mMmmrrmmMm.', '.mMmmmmmmMm.', '.mMMMMMMMMm.', '.mmmmmmmmmm.', '............'],
  drag_marks: [
    '............', '.k..........', '..k......k..', '..kk.....k..', '...kk...kk..', '....kk..k...',
    '....kk.kk...', '.....kkk....', '.....kk.....', '......k.....', '......K.....', '............'],
  crane_pillar_mark: [
    '...SSSSSS...', '...SKKKKS...', '...SKSSKS...', '...SKKKKS...', '...SSSSSS...', '...SrrrrS...',
    '...SkkkkS...', '...SrrrrS...', '...SSSSSS...', '...SKKKKS...', '..SSSSSSSS..', '..KKKKKKKK..'],
  warehouse_door: [
    'KKKKKKKKKKKK', 'KSSSSKKSSSSK', 'KSssSKKSssSK', 'KSSSSKKSSSSK', 'KSssSKKSssSK', 'KSSSSooSSSSK',
    'KSSSSooSSSSK', 'KSssSKKSssSK', 'KSSSSKKSSSSK', 'KSssSKKSssSK', 'KSSSSKKSSSSK', 'KKKKKKKKKKKK'],
  warehouse_door__open: [
    'KKKKKKKKKKKK', 'KSSkkkkkkkkK', 'KSskkkkkkkkK', 'KSSkkkkkkkkK', 'KSskkkkkkkkK', 'KSSkkkkkkkkK',
    'KSSkkkkkkkkK', 'KSskkkkkkkkK', 'KSSkkkkkkkkK', 'KSskkkkkkkkK', 'KSSkkkkkkkkK', 'KKKKKKKKKKKK'],
  rest_crate: [
    '.......o....', '......kOk...', '......kok...', '.bbbbbbbbbb.', 'bbubbbbubbbb', 'mmmmmmmmmmmm',
    'mMMMMmmMMMMm', 'mMmmMmmMmmMm', 'mMMMMmmMMMMm', 'mmmmmmmmmmmm', 'm..........m', 'mm........mm'],
  // ---- M4：鐘塔之夢 ----
  guest_three: [
    '....kkkk....', '...kkkkkk...', '..kkkkkkkk..', '....llfl....', '....flll....', '..CCCCCCCC..',
    '.CCCcCCcCCC.', '.CCCcCCcCCC.', '.lCCcCCcCCl.', '..CCCCCCCC..', '..CCC..CCC..', '..kk....kk..'],
  guest_nine: [
    '...aaaaaa...', '..aaaaaaaa..', '..aalfllaa..', '..aallflaa..', '...aollla...', '..oooooooo..',
    '.AAoAAAAAAA.', '.AAAAAAAAAA.', '.lAAAAAAAAl.', '..AAAAAAAA..', '...AAAAAA...', '...kk..kk...'],
  dream_chair_twelve: [
    '..MMMMMMMM..', '..MzzzzzzM..', '..MmmmmmmM..', '..MmmmmmmM..', '..MmmmmmmM..', '..MmmmmmmM..',
    '.MMMMMMMMMM.', '.MqqqqqqqqM.', '.MMMMMMMMMM.', '..M......M..', '..M......M..', '..k......k..'],
  dream_chair: [
    '..MMMMMMMM..', '..MyyyyyyM..', '..MmmmmmmM..', '..MmmmmmmM..', '..MmmmmmmM..', '..MmmmmmmM..',
    '.MMMMMMMMMM.', '.MqqqqqqqqM.', '.MMMMMMMMMM.', '..M......M..', '..M......M..', '..k......k..'],
  dream_door: [
    'KKKKKKKKKKKK', 'KuuuuuuuuuuK', 'KuxxxxxxxxuK', 'KuxvvvvvvxuK', 'KuxvvvvvvxuK', 'KuxvvvvvvxuK',
    'KuxvvvvvvxuK', 'KuxvvvvvvxuK', 'KuxvvvvvvxuK', 'KuxxxxxxxxuK', 'KuuuuuuuuuuK', 'KKKKKKKKKKKK'],
  sofa_bed: [
    '............', '.mmmmmmmmmm.', '.mMMMMMMMMm.', '.mMMMMMMMMm.', 'mmwwwwwwwwmm', 'mMwbbbbbbwMm',
    'mMwbbbbbbwMm', 'mMwwwwwwwwMm', 'mMMMMMMMMMMm', 'mmmmmmmmmmmm', '.k........k.', '............'],
  thermos: [
    '............', '.....kk.....', '....kSSk....', '....ssss....', '....slls....', '....srrs....',
    '....srrs....', '....slls....', '....ssss....', '.mmmmmmmmmm.', '.mMMMMMMMMm.', '.m........m.'],
  stairs_dark: [
    'kkkkkkkkkkkk', 'kKKKKKKKKKKk', 'kkkkkkkkkkkk', 'kKKKKKKKKKKk', 'kkkkkkkkkkkk', 'kGGGGGGGGGGk',
    'kkkkkkkkkkkk', 'kGGGGGGGGGGk', 'kkkkkkkkkkkk', 'kggggggggggk', 'kkkkkkkkkkkk', 'kggggggggggk'],
  unknown: [
    '............', '.kkkkkkkkkk.', '.kmmmmmmmmk.', '.kmmyyyymmk.', '.kmmmmmymmk.', '.kmmmmymmmk.',
    '.kmmmymmmmk.', '.kmmmmmmmmk.', '.kmmmymmmmk.', '.kmmmmmmmmk.', '.kkkkkkkkkk.', '............'],
};
ICONS.hero_right = ICONS.hero_left.map((row) => [...row].reverse().join(''));
/** 主角在戰鬥與選單中的立繪（characters.json 的 sprite「hero」）。 */
ICONS.hero = ICONS.hero_down;

function paintIcon(ctx, rows, scale = 2) {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = PAL[ch];
      if (c) px(ctx, c, x * scale, y * scale, scale, scale);
    });
  });
}

/** 一般「打開的門」：沒有專屬圖時，畫成暗色門洞＋靠邊的門板。 */
function paintGenericOpen(ctx) {
  px(ctx, '#2a2e38', 0, 0, S, S);
  px(ctx, '#0d0f13', 4, 2, S - 6, S - 2);
  px(ctx, '#7a5636', 0, 2, 4, S - 2);
}

export const tileKey = (id) => `tile:${id}`;
export const spriteKey = (name, open = false) => `spr:${name}${open ? ':open' : ''}`;
export const heroKey = (dir) => `hero:${dir}`;
/** 戰鬥畫面用的放大立繪（同一張 12×12 點陣，放大到 60 像素以上）。 */
export const battleSpriteKey = (name) => `bspr:${name}`;
/** 戰鬥背景。 */
export const bgKey = (id) => `bg:${id}`;
export const BG_W = 360;
export const BG_H = 250;
/** 戰鬥立繪的放大倍率：Boss 畫得比較大。 */
const BATTLE_SCALE = { silent_hauler: 7 };
const DEFAULT_BATTLE_SCALE = 5;
export const battleSpriteSize = (name) => 12 * (BATTLE_SCALE[name] ?? DEFAULT_BATTLE_SCALE);

// ---------- 戰鬥背景（360×250） ----------
function bgGradient(ctx, top, bottom, h = BG_H) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, BG_W, h);
}
function bgFog(ctx, rand, y0, y1, n, alpha = 0.18) {
  for (let i = 0; i < n; i++) {
    const x = rand() * BG_W;
    const y = y0 + rand() * (y1 - y0);
    const r = 30 + rand() * 50;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(190,200,210,${alpha})`);
    g.addColorStop(1, 'rgba(190,200,210,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}
function bgLamp(ctx, x, y) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, 46);
  g.addColorStop(0, 'rgba(240,168,72,0.45)');
  g.addColorStop(1, 'rgba(240,168,72,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - 46, y - 46, 92, 92);
  px(ctx, '#2a2e38', x - 1, y - 14, 2, 10);
  px(ctx, '#f0a848', x - 4, y - 4, 8, 7);
  px(ctx, '#fff0cc', x - 2, y - 2, 4, 3);
}

const BG_PAINTERS = {
  training_room: (ctx, rand) => {
    bgGradient(ctx, '#1d1a1a', '#2a2420');
    // 磚牆
    for (let y = 0; y < 150; y += 10) {
      const off = (y / 10) % 2 ? 14 : 0;
      for (let x = -off; x < BG_W; x += 28) px(ctx, shade('#4a3a34', (rand() - 0.5) * 0.2), x + 1, y + 1, 26, 8);
    }
    px(ctx, 'rgba(0,0,0,0.35)', 0, 0, BG_W, 150);
    bgLamp(ctx, 70, 60); bgLamp(ctx, 290, 60);
    // 木人樁與武器架
    px(ctx, '#5a4030', 30, 92, 12, 58); px(ctx, '#5a4030', 18, 104, 36, 6); px(ctx, '#a9b6c2', 30, 120, 12, 3);
    px(ctx, '#3b302a', 300, 96, 44, 4); px(ctx, '#3b302a', 300, 132, 44, 4);
    for (const x of [306, 316, 326, 336]) px(ctx, x % 20 ? '#9a7350' : '#a9b6c2', x, 86, 3, 60);
    // 地板與軟墊
    px(ctx, '#4a3e32', 0, 150, BG_W, 100);
    for (let y = 150; y < BG_H; y += 8) px(ctx, '#3a3028', 0, y, BG_W, 1);
    px(ctx, '#6a5f4a', 40, 170, 280, 70); px(ctx, '#7a6e57', 40, 170, 280, 2); px(ctx, '#544a3a', 180, 170, 2, 70);
  },
  dock: (ctx, rand) => {
    bgGradient(ctx, '#2a3340', '#55606c', 150);
    // 遠方的起重機剪影
    ctx.fillStyle = '#1f2630';
    ctx.fillRect(40, 30, 8, 120); ctx.fillRect(40, 30, 120, 6); ctx.fillRect(150, 36, 2, 50);
    ctx.fillRect(250, 50, 6, 100); ctx.fillRect(220, 50, 110, 5);
    for (let i = 0; i < 8; i++) ctx.fillRect(48 + i * 14, 36 + (i % 2) * 2, 2, 8);
    // 河面
    px(ctx, '#2f4250', 0, 110, BG_W, 40);
    for (let i = 0; i < 40; i++) px(ctx, 'rgba(160,190,210,0.35)', Math.floor(rand() * BG_W), 112 + Math.floor(rand() * 36), 6 + Math.floor(rand() * 10), 1);
    // 碼頭木板
    px(ctx, '#4a3c2c', 0, 150, BG_W, 100);
    for (let x = 0; x < BG_W; x += 20) { px(ctx, shade('#6b5840', (rand() - 0.5) * 0.2), x, 150, 19, 100); px(ctx, '#2a2420', x + 9, 160, 2, 2); }
    px(ctx, '#3a3d44', 20, 140, 18, 22); px(ctx, '#55595f', 20, 140, 18, 4);
    bgLamp(ctx, 320, 96);
    bgFog(ctx, rand, 60, 200, 22, 0.22);
  },
  warehouse: (ctx, rand) => {
    bgGradient(ctx, '#15181d', '#262a30');
    for (let x = 0; x < BG_W; x += 8) { px(ctx, '#33363d', x, 0, 4, 150); px(ctx, '#2a2c32', x + 4, 0, 4, 150); }
    px(ctx, 'rgba(0,0,0,0.3)', 0, 0, BG_W, 150);
    bgLamp(ctx, 180, 40);
    // 木箱堆
    const crate = (x, y, w, h) => {
      px(ctx, '#4a3a28', x, y, w, h); px(ctx, '#7b6040', x + 2, y + 2, w - 4, h - 4);
      px(ctx, '#5a4630', x + 2, y + h / 2, w - 4, 2); px(ctx, '#8a7050', x + 2, y + 2, w - 4, 2);
    };
    crate(10, 100, 50, 50); crate(20, 60, 40, 40); crate(300, 96, 54, 54); crate(310, 56, 36, 40); crate(250, 118, 34, 32);
    px(ctx, '#4c4f54', 0, 150, BG_W, 100);
    for (let i = 0; i < 90; i++) px(ctx, shade('#5c5f63', (rand() - 0.5) * 0.3), Math.floor(rand() * BG_W), 150 + Math.floor(rand() * 100), 3, 2);
    bgFog(ctx, rand, 140, 240, 14, 0.18);
  },
};

function paintBg(ctx, id) {
  const rand = rng(`bg:${id}`);
  const painter = BG_PAINTERS[id];
  if (painter) { painter(ctx, rand); return; }
  bgGradient(ctx, '#1a1f28', '#2a303a');
  bgFog(ctx, rand, 40, 220, 16);
}

/** 資料裡出現的所有 sprite／tile／戰鬥背景名稱。 */
export function artNames(data) {
  const sprites = new Set();
  const locked = new Set();
  for (const map of data?.maps ?? []) {
    for (const o of map.objects ?? []) {
      if (typeof o.sprite !== 'string') continue;
      sprites.add(o.sprite);
      if (o.lock) locked.add(o.sprite);
    }
  }
  const battleSprites = new Set();
  for (const c of [...(data?.characters ?? []), ...(data?.enemies ?? [])]) {
    const name = typeof c?.sprite === 'string' ? c.sprite : c?.id;
    if (typeof name === 'string') { sprites.add(name); battleSprites.add(name); }
  }
  // 夢客的頭像（自由交談畫面）
  for (const ch of data?.story ?? []) {
    for (const g of Array.isArray(ch?.guests) ? ch.guests : []) if (typeof g?.sprite === 'string') sprites.add(g.sprite);
  }
  const bgs = new Set((data?.encounters ?? []).map((e) => e?.bg).filter((b) => typeof b === 'string'));
  const tiles = new Set((data?.tiles ?? []).map((t) => t?.id).filter((t) => typeof t === 'string'));
  return { sprites, locked, battleSprites, bgs, tiles };
}

/**
 * 美術覆蓋檢查：資料裡出現、但沒有專屬畫法（會退回通用圖）的名稱。E2E 斷言全部為空。
 * 打開的門沒有專屬圖時用通用門洞，不算缺。
 */
export function artReport(data) {
  const n = artNames(data);
  return {
    sprites: [...n.sprites].filter((x) => !Object.hasOwn(ICONS, x)).sort(),
    tiles: [...n.tiles].filter((x) => !Object.hasOwn(TILE_PAINTERS, x)).sort(),
    bgs: [...n.bgs].filter((x) => !Object.hasOwn(BG_PAINTERS, x)).sort(),
    counts: { sprites: n.sprites.size, tiles: n.tiles.size, bgs: n.bgs.size },
  };
}

/** 產生全部貼圖。 */
export function generateTextures(scene, data) {
  for (const tile of data.tiles ?? []) {
    const { tex, ctx } = makeCanvas(scene, tileKey(tile.id), S, S);
    paintTile(ctx, tile);
    tex.refresh();
  }
  const { sprites, locked: lockedSprites, battleSprites, bgs } = artNames(data);
  sprites.add('unknown');
  for (const name of sprites) {
    const { tex, ctx } = makeCanvas(scene, spriteKey(name), S, S);
    paintIcon(ctx, ICONS[name] ?? ICONS.unknown);
    tex.refresh();
  }
  for (const name of lockedSprites) {
    const { tex, ctx } = makeCanvas(scene, spriteKey(name, true), S, S);
    const open = ICONS[`${name}__open`];
    if (open) paintIcon(ctx, open); else paintGenericOpen(ctx);
    tex.refresh();
  }
  for (const name of battleSprites) {
    const size = battleSpriteSize(name);
    const { tex, ctx } = makeCanvas(scene, battleSpriteKey(name), size, size);
    paintIcon(ctx, ICONS[name] ?? ICONS.unknown, size / 12);
    tex.refresh();
  }
  for (const id of bgs) {
    const { tex, ctx } = makeCanvas(scene, bgKey(id), BG_W, BG_H);
    paintBg(ctx, id);
    tex.refresh();
  }
  {
    const { tex, ctx } = makeCanvas(scene, bgKey('__default'), BG_W, BG_H);
    paintBg(ctx, '__default');
    tex.refresh();
  }
  for (const dir of ['up', 'down', 'left', 'right']) {
    const { tex, ctx } = makeCanvas(scene, heroKey(dir), S, S);
    paintIcon(ctx, ICONS[`hero_${dir}`]);
    tex.refresh();
  }
  // 崩解增加時的暗角（戰鬥畫面）
  {
    const { tex, ctx } = makeCanvas(scene, 'fx:vignette', 180, 320);
    const g = ctx.createRadialGradient(90, 160, 60, 90, 160, 190);
    g.addColorStop(0, 'rgba(60,0,20,0)');
    g.addColorStop(1, 'rgba(90,10,30,0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 180, 320);
    tex.refresh();
    tex.setFilter(Phaser.Textures.FilterMode.LINEAR);
  }
  // 霧氣（標題畫面用）：柔邊的灰藍色雲團
  {
    const { tex, ctx } = makeCanvas(scene, 'fx:fog', 128, 64);
    const rand = rng('fog');
    for (let i = 0; i < 14; i++) {
      const x = 20 + rand() * 88;
      const y = 18 + rand() * 28;
      const r = 12 + rand() * 18;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(180,190,200,0.35)');
      g.addColorStop(1, 'rgba(180,190,200,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 64);
    }
    tex.refresh();
    tex.setFilter(Phaser.Textures.FilterMode.LINEAR);
  }
  // 煤氣燈光暈
  {
    const { tex, ctx } = makeCanvas(scene, 'fx:glow', 64, 64);
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(240,168,72,0.55)');
    g.addColorStop(1, 'rgba(240,168,72,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    tex.refresh();
    tex.setFilter(Phaser.Textures.FilterMode.LINEAR);
  }
}
