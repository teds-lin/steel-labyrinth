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
  // ---- M5 第四章：灰鴿街禮拜堂 ----
  chapel_floor: (ctx, c, r) => {
    px(ctx, shade(c, -0.4), 0, 0, S, S);
    for (let y = 0; y < S; y += 12) for (let x = 0; x < S; x += 12) {
      const light = ((x + y) / 12) % 2 === 0;
      px(ctx, shade(c, light ? 0.1 : -0.12), x + 1, y + 1, 11, 11);
    }
    noise(ctx, c, r, 24, 0.12);
    px(ctx, 'rgba(122,106,160,0.18)', 3, 3, 8, 6); // 彩繪玻璃投下的淡紫光斑
  },
  pew: (ctx, c) => {
    px(ctx, '#4e4a52', 0, 0, S, S);
    px(ctx, shade(c, -0.45), 0, 3, S, 17);
    px(ctx, shade(c, 0.12), 1, 4, S - 2, 5);  // 椅背
    px(ctx, shade(c, 0.3), 1, 4, S - 2, 1);
    px(ctx, c, 1, 10, S - 2, 8);              // 坐板
    px(ctx, shade(c, -0.3), 1, 17, S - 2, 1);
    px(ctx, shade(c, -0.55), 0, 3, 2, 18); px(ctx, shade(c, -0.55), S - 2, 3, 2, 18); // 扶手
    px(ctx, '#d9c99a', 15, 11, 4, 2);         // 擱著的聖歌本
  },
  stained_glass: (ctx, c) => {
    px(ctx, '#2b2832', 0, 0, S, S);
    px(ctx, '#1a1820', 3, 1, 18, 22);
    px(ctx, '#1a1820', 5, 0, 14, 1);
    const panes = ['#7a6aa0', '#3e4c8a', '#d0a050', '#8a3b4e', '#4f7a6a', '#b4a6d8'];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 4; x++) {
      px(ctx, panes[(x * 3 + y * 2) % panes.length], 4 + x * 4, 2 + y * 4, 3, 3);
    }
    px(ctx, shade(c, 0.5), 10, 6, 4, 4); px(ctx, '#f4f1e8', 11, 7, 2, 2); // 中央的白光
    px(ctx, 'rgba(215,207,224,0.25)', 4, 2, 2, 20);
  },
  altar: (ctx, c) => {
    px(ctx, '#4e4a52', 0, 0, S, S);
    px(ctx, '#6a6660', 1, 6, S - 2, 16);
    px(ctx, c, 1, 4, S - 2, 9);               // 白布
    px(ctx, shade(c, 0.3), 1, 4, S - 2, 1);
    px(ctx, shade(c, -0.2), 1, 12, S - 2, 1);
    px(ctx, '#7a2e2a', 10, 4, 4, 14);         // 垂下的紅色布條
    px(ctx, '#a9b6c2', 11, 7, 2, 2); px(ctx, '#a9b6c2', 10, 9, 4, 2); // 銀鐘
    for (const x of [3, 19]) { px(ctx, '#f4f1e8', x, 0, 2, 4); px(ctx, '#ffd08a', x, 0, 2, 1); }
  },
  candle_stand: (ctx, c) => {
    px(ctx, '#4e4a52', 0, 0, S, S);
    px(ctx, rgba(c, 0.18), 2, 0, 20, 14);
    px(ctx, '#2a2e38', 11, 10, 2, 12); px(ctx, '#2a2e38', 7, 21, 10, 2);
    px(ctx, '#2a2e38', 4, 10, 16, 2);
    for (const [x, h] of [[5, 5], [11, 7], [17, 5]]) {
      px(ctx, '#f4f1e8', x, 10 - h, 2, h);
      px(ctx, c, x, 10 - h - 3, 2, 3); px(ctx, '#fff0cc', x, 10 - h - 2, 1, 1);
    }
  },
  stone_floor: (ctx, c, r) => { slabs(ctx, c, r, 8); noise(ctx, c, r, 30, 0.12); },
  cloister_garden: (ctx, c, r) => {
    px(ctx, '#3a3530', 0, 0, S, S);
    px(ctx, c, 1, 1, S - 2, S - 2);
    noise(ctx, c, r, 90, 0.3);
    for (let i = 0; i < 5; i++) px(ctx, '#e8e2d4', 3 + Math.floor(r() * 17), 3 + Math.floor(r() * 17), 1, 1); // 小白花
    px(ctx, shade(c, -0.4), 1, S - 3, S - 2, 2);
    fogWisps(ctx, r, '#b4bec8', 0.25, 3);
  },
  organ: (ctx, c) => {
    px(ctx, '#2a2420', 0, 0, S, S);
    for (let i = 0; i < 7; i++) {
      const h = 4 + (i % 2 ? 3 : 0) + (i === 3 ? 4 : 0);
      px(ctx, '#a08040', 2 + i * 3, 12 - h, 2, h + 1);
      px(ctx, '#d0b070', 2 + i * 3, 12 - h, 1, h + 1);
      px(ctx, '#2a2420', 2 + i * 3, 12 - h + 1, 2, 1);
    }
    px(ctx, c, 0, 12, S, 12);
    px(ctx, shade(c, 0.2), 0, 12, S, 1);
    px(ctx, '#e8e2d4', 2, 15, 20, 3);
    for (let x = 3; x < 22; x += 3) px(ctx, '#15171c', x, 15, 1, 2);
    px(ctx, shade(c, -0.4), 2, 20, 20, 2);
  },
  church_bell: (ctx, c) => {
    px(ctx, '#3a3530', 0, 0, S, S);
    px(ctx, '#5a4030', 0, 1, S, 3);           // 橫樑
    px(ctx, '#2a2e38', 11, 4, 2, 2);
    px(ctx, shade(c, -0.25), 8, 6, 8, 4);
    px(ctx, c, 6, 10, 12, 6);
    px(ctx, shade(c, -0.3), 4, 16, 16, 4);
    px(ctx, shade(c, 0.35), 9, 7, 2, 8);      // 反光
    px(ctx, '#15171c', 6, 19, 12, 1);
    px(ctx, '#2a2e38', 11, 20, 2, 2);         // 鐘舌
  },
  // ---- M5 第五章：舊城水道 ----
  sewer_wall: (ctx, c, r) => {
    bricks(ctx, c, r);
    for (let i = 0; i < 4; i++) px(ctx, 'rgba(95,127,74,0.45)', Math.floor(r() * 20), 18 + Math.floor(r() * 5), 3 + Math.floor(r() * 4), 2); // 青苔
    for (let i = 0; i < 3; i++) { const x = 2 + Math.floor(r() * 20); px(ctx, 'rgba(160,190,180,0.35)', x, 6 + Math.floor(r() * 6), 1, 5); } // 水痕
  },
  sewer_walk: (ctx, c, r) => {
    slabs(ctx, shade(c, -0.22), r, 8);
    px(ctx, 'rgba(15,25,24,0.25)', 0, 0, S, S);
    px(ctx, 'rgba(140,170,170,0.12)', 0, 0, S, 1);
    for (let i = 0; i < 3; i++) px(ctx, 'rgba(20,30,30,0.45)', Math.floor(r() * 18), Math.floor(r() * 20), 4, 2); // 積水
  },
  sewer_water: (ctx, c, r) => {
    px(ctx, c, 0, 0, S, S);
    noise(ctx, c, r, 50, 0.2);
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(r() * 18);
      const y = Math.floor(r() * 22);
      px(ctx, shade(c, 0.3), x, y, 4 + Math.floor(r() * 3), 1);
    }
    for (let i = 0; i < 3; i++) px(ctx, 'rgba(120,130,80,0.5)', Math.floor(r() * 20), Math.floor(r() * 20), 2, 1); // 浮渣
  },
  sewer_grate: (ctx, c, r) => {
    slabs(ctx, '#4f544c', r, 8);
    px(ctx, '#0d0f13', 4, 4, 16, 16);
    px(ctx, c, 3, 3, 18, 2); px(ctx, c, 3, 19, 18, 2); px(ctx, c, 3, 3, 2, 18); px(ctx, c, 19, 3, 2, 18);
    for (let x = 7; x < 19; x += 4) px(ctx, shade(c, 0.25), x, 5, 2, 14);
    px(ctx, 'rgba(160,200,210,0.2)', 8, 12, 6, 1);
  },
  cistern_water: (ctx, c, r) => {
    px(ctx, c, 0, 0, S, S);
    noise(ctx, c, r, 30, 0.15);
    ctx.strokeStyle = shade(c, 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(12, 12, 8, 4, 0, 0, Math.PI * 2); ctx.stroke(); // 一圈一圈的漣漪
    px(ctx, 'rgba(180,200,215,0.35)', 15, 6, 3, 1); // 淡淡的銀光
  },
  // ---- M5 第六、七章：鐘匠巷、港口、沉堤、燈塔 ----
  seawall: (ctx, c, r) => {
    slabs(ctx, c, r, 12);
    for (let i = 0; i < 4; i++) px(ctx, 'rgba(233,239,233,0.35)', Math.floor(r() * 20), Math.floor(r() * 20), 3, 1); // 鹽漬
    px(ctx, 'rgba(34,52,58,0.45)', 0, S - 4, S, 4); // 下緣被浪打濕
  },
  stopped_clock: (ctx, c, r) => {
    px(ctx, '#3a3d44', 0, 0, S, S);
    px(ctx, c, 1, 1, S - 2, S - 2);
    px(ctx, '#e8e2d4', 3, 3, S - 6, S - 6);
    px(ctx, shade(c, 0.3), 1, 1, S - 2, 1);
    for (const [x, y] of [[11, 4], [11, 18], [4, 11], [18, 11]]) px(ctx, '#2a2e38', x, y, 2, 2);
    px(ctx, '#15171c', 11, 7, 2, 6); px(ctx, '#15171c', 12, 11, 5, 2); // 指針
    for (let i = 0; i < 6; i++) px(ctx, '#8a8f96', 6 + i * 2, 15 - i, 1, 1); // 裂痕
    fogWisps(ctx, r, '#c8d0d8', 0.45, 4); // 霧遮住一半的刻度
  },
  breakwater_stone: (ctx, c, r) => {
    px(ctx, '#22343a', 0, 0, S, S);
    for (const [x, y, w, h] of [[0, 0, 13, 11], [12, 2, 12, 10], [1, 11, 10, 12], [11, 12, 13, 11]]) {
      px(ctx, shade(c, (r() - 0.5) * 0.25), x + 1, y + 1, w - 1, h - 1);
      px(ctx, shade(c, 0.18), x + 1, y + 1, w - 1, 1);
    }
    for (let i = 0; i < 5; i++) px(ctx, '#e9efe9', Math.floor(r() * 22), Math.floor(r() * 22), 2, 1); // 縫裡的浪花
  },
  lighthouse_wall: (ctx, c, r) => {
    px(ctx, shade(c, -0.4), 0, 0, S, S);
    for (let y = 0; y < S; y += 6) {
      const off = (y / 6) % 2 ? 4 : 0;
      for (let x = -off; x < S; x += 8) px(ctx, shade(c, (r() - 0.5) * 0.2 + (x > 8 && x < 16 ? 0.08 : -0.05)), x + 1, y + 1, 7, 5);
    }
    px(ctx, '#0d0f13', 11, 6, 2, 9); px(ctx, 'rgba(191,224,232,0.3)', 11, 7, 1, 6); // 細長的窗縫
  },
  lighthouse_floor: (ctx, c, r) => {
    planks(ctx, c, r, 1);
    for (const [x, y] of [[2, 2], [21, 2], [2, 21], [21, 21]]) px(ctx, '#8a8f96', x, y, 1, 1);
    px(ctx, 'rgba(34,52,58,0.25)', 0, 0, S, S);
  },
  spiral_stair: (ctx, c) => {
    px(ctx, shade(c, -0.5), 0, 0, S, S);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = shade(c, 0.2 - i * 0.08);
      ctx.beginPath();
      ctx.moveTo(4, 20);
      const a0 = -Math.PI / 2 + (i * Math.PI) / 12;
      const a1 = a0 + Math.PI / 12;
      ctx.lineTo(4 + Math.cos(a0) * 26, 20 + Math.sin(a0) * 26);
      ctx.lineTo(4 + Math.cos(a1) * 26, 20 + Math.sin(a1) * 26);
      ctx.closePath();
      ctx.fill();
    }
    px(ctx, '#2a2e38', 2, 18, 4, 4); // 中柱
  },
  lamp_lens: (ctx, c) => {
    px(ctx, '#2a2e38', 0, 0, S, S);
    for (let i = 0; i < 5; i++) {
      const inset = 1 + i * 2;
      px(ctx, shade(c, -0.25 + i * 0.12), inset, inset, S - inset * 2, S - inset * 2);
      px(ctx, shade(c, 0.4), inset, inset, S - inset * 2, 1);
    }
    px(ctx, '#bfe0e8', 10, 10, 4, 4); px(ctx, '#f4f1e8', 11, 11, 2, 2); // 冷冷的燈心
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
  // M5 起新增：海水、潮沫、燈鏡冷光、彩繪玻璃、鐘銅、閉口者的灰白皮膚、霧鰻、花
  n: '#3f6066', N: '#22343a', j: '#0c1418', i: '#bfe0e8', t: '#d7cfe0', T: '#7a6aa0',
  B: '#a08040', F: '#e9efe9', P: '#b8b4ac', U: '#8aa4b0', R: '#c86a7a', Y: '#e8d060',
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
  // ---- M5 第四章：上城、灰鴿街禮拜堂 ----
  florist: [ // 花販黛西：圍裙沾花粉，脖子掛小黑板
    '....hhhh....', '...hhhhhh...', '...hpppph...', '...pkppkp...', '...pppppp...', '..eeKKKKee..',
    '.eeeKwwKeee.', '.peeKKKKeep.', '..wwwYwRww..', '..wYwwwwRw..', '..wwwwwwww..', '...kk..kk...'],
  newsboy: [ // 報童彼得：鴨舌帽、一疊比他還高的報紙
    '.........ww.', '...GGGG..wk.', '..GGGGGGGww.', '...pkppkpwk.', '...ppppppww.', '..qqqqqqqwk.',
    '.pqqqqqqqww.', '..qqqqqqpwk.', '..qqqqqqqww.', '..CCCCCC.wk.', '..CC..CC.ww.', '..kk..kk....'],
  patrolman: [ // 巡警霍布斯：歪掉的帽子、快撐不住的扣子
    '.....CCCC...', '...CCCCCCCC.', '...pppppp...', '..ppkppkpp..', '..pppppppp..', '.CCCCCCCCCC.',
    'CCCCCoCCCCCC', 'pCCCCCCCCCCp', 'CCCCCoCCCCCC', '.CCCCCCCCCC.', '..CCC..CCC..', '..kkk..kkk..'],
  old_well: [ // 鐵柵蓋住的老井，井壁長滿回聲苔
    '............', '.KKKKKKKKKK.', '.KkKkKkKkKK.', '.KKKKKKKKKK.', 'SSSSSSSSSSSS', 'SgGgegGgegGS',
    'SGgeggGegggS', 'SgGgGgeggGgS', 'SGgeggGgegGS', 'SggGgegGggeS', 'SSSSSSSSSSSS', '............'],
  hymnal: [ // 封面有銀鐘的聖歌本，擱在長椅椅背上
    '............', '............', '..rrrrrrrr..', '..rwrrssrr..', '..rwrssssr..', '..rwrssssr..',
    '..rwrrssrr..', '..rrrrrrrr..', '..yyyyyyyy..', 'MMMMMMMMMMMM', 'mmmmmmmmmmmm', '.M........M.'],
  cloak_hooks: [ // 衣帽間：一排白袍，旁邊吊著詩班通行牌
    'MMMMMMMMMMMM', '.s...s...s..', 'www.www..k..', 'www.www..q..', 'www.www.qqq.', 'wlw.wlw.qsq.',
    'www.www.qqq.', 'www.www.....', 'wlw.wlw.....', 'www.www.....', 'ww..ww......', '............'],
  usher: [ // 招待員：深色禮服、拉緊的白手套
    '....kkkk....', '...kkkkkk...', '...hpppph...', '...pkppkp...', '...pppppp...', '..KKKwwKKK..',
    '.KKKKwwKKKK.', '.xKKKKKKKKx.', '..KKKKKKKK..', '..KKKKKKKK..', '...KK..KK...', '...kk..kk...'],
  side_door: [
    'SSSSMMMMSSSS', 'SSMMmmmmMMSS', 'SMmmmmmmmmMS', 'SMmMmmmmMmMS', 'SMmMmmmmMmMS', 'SMmMmmmmMmMS',
    'SMmmmmmmmoMS', 'SMmMmmmmMmMS', 'SMmMmmmmMmMS', 'SMmMmmmmMmMS', 'SMmmmmmmmmMS', 'SMMMMMMMMMMS'],
  side_door__open: [
    'SSSSMMMMSSSS', 'SSMMkkkkMMSS', 'SmMkkkkkkkkS', 'SmMkkkkkkkkS', 'SmMkkkkkkkkS', 'SmMkKKKKKKkS',
    'SmMkkkkkkkkS', 'SmMkkkkkkkkS', 'SmMkKKKKKKkS', 'SmMkkkkkkkkS', 'SmMkKKKKKKkS', 'SMMMMMMMMMMS'],
  stone_bench: [
    '............', '............', '............', '............', 'llllllllllll', 'gggggggggggg',
    'GGGGGGGGGGGG', '.GG......GG.', '.gG......gG.', '.GG......GG.', '.GG......GG.', '.kk......kk.'],
  organ_pedal: [ // 小管風琴：銅管、琴鍵、踏板
    '.B..B..B..B.', '.B.BB.BB.BB.', '.BBBBBBBBBB.', 'MMMMMMMMMMMM', 'MwkwkwwkwkwM', 'MwwwwwwwwwwM',
    'MMMMMMMMMMMM', 'MmmmmmmmmmmM', 'MmmmmmmmmmmM', 'MmMMMMMMMMmM', 'MmyMyMyMyMmM', 'MMMMMMMMMMMM'],
  loft_door: [ // 鐘樓小門：包鐵條的厚木門
    'KKKKKKKKKKKK', 'KMMMMMMMMMMK', 'KMmmmmmmmmMK', 'KSSSSSSSSSSK', 'KMmmmmmmmmMK', 'KMmmmmmmkoMK',
    'KMmmmmmmmmMK', 'KSSSSSSSSSSK', 'KMmmmmmmmmMK', 'KMmmmmmmmmMK', 'KSSSSSSSSSSK', 'KMMMMMMMMMMK'],
  loft_door__open: [
    'KMMMMMMMMMMK', 'KmMkkkkkkkkK', 'KmMkkkkkkkkK', 'KSMkkkkkkkkK', 'KmMkkkkkkkkK', 'KmMkKKKKKKkK',
    'KmMkkkkkkkkK', 'KSMkkkkkkkkK', 'KmMkkkkkkkkK', 'KmMkKKKKKKkK', 'KSMkkkkkkkkK', 'KMMMMMMMMMMK'],
  roster_lectern: [ // 小講台上的皮面詩班名冊
    '............', '..hhhhhhhh..', '.hyyyyhyyyyh', '.hyKKyhyKKyh', '.hyyyyhyyyyh', '.hhhhhhhhhhh',
    '..MMMMMMMM..', '....MmmM....', '....MmmM....', '..x.MmmM....', '..MMMMMMMM..', '.MMMMMMMMMM.'],
  matilda: [ // 詩班長瑪蒂達：白詩班袍、蕾絲高領、封蠟的嘴、白手套
    '...ssssss...', '..ssssssss..', '..spppppps..', '..spkppkps..', '..sppxxpps..', '..wwwwwwww..',
    '.xxdxxxxdxx.', 'xxxdxxxxdxxx', 'wxxdxxxxdxxw', '.xxdxxxxdxx.', '.xxxxxxxxxx.', 'xxxxxxxxxxxx'],
  hush_acolyte: [ // 閉口信徒：灰袍、黑線繡著閉口記號的口罩
    '...gggggg...', '..gGGGGGGg..', '..gGppppGg..', '..gpkppkpg..', '..gllKKllg..', '.gggllllggg.',
    'gggggggggggg', 'ggGggggggGgg', 'pgGggggggGgp', '.gGggggggGg.', '.gggggggggg.', '..kk....kk..'],
  choir_chanter: [ // 吟唱者：白詩班袍，嘴張著卻沒有聲音
    '....hhhh....', '...hhhhhh...', '...hpppph...', '...pkppkp...', '...ppkkpp...', '..xxxwwxxx..',
    '.xxxxwwxxxx.', '.pxxxxxxxxp.', '..xxxxxxxx..', '..xlxxxxlx..', '..xxxxxxxx..', '...kk..kk...'],
  // ---- M5 第五章：舊城水道 ----
  ladder: [
    '..S......S..', '..SSSSSSSS..', '..S......S..', '..S......S..', '..SSSSSSSS..', '..S......S..',
    '..S......S..', '..SSSSSSSS..', '..S......S..', '..S......S..', '..SSSSSSSS..', '..S......S..'],
  tally_marks: [ // 磚牆上的刻痕：深的與指甲刮出的白線
    '............', '.k.k.k.k....', '.kkk.k.k....', '.k.kkk.k....', '.k.k.kkk....', '.k.k.k.kk...',
    '............', '.l.l.l.l.l..', '.l.l.l.l.l..', '.l.l.l.l.l..', '.l.l.l.l....', '............'],
  tool_rack: [
    'MMMMMMMMMMMM', '.s..q..S..s.', '.s.qq..S.ss.', 'sss.q..S..s.', '.s..q..S....', '.s..q.SSS...',
    '....q.S.S...', 'MMMMMMMMMMMM', '.m........m.', '.m........m.', '.m........m.', '.m........m.'],
  sluice_valve: [ // 閘門：少了把手，只剩方形的軸頭
    '............', '............', '.....rr.....', '....rKKr....', '.....KK.....', '.....KK.....',
    '....SKKS....', '...SSKKSS...', 'GGGGSSSSGGGG', 'GKKKKKKKKKKG', 'GKKKKKKKKKKG', 'GGGGGGGGGGGG'],
  sluice_valve__open: [ // 裝上把手、閘門打開，水流出來
    '....SSSS....', '...S.ss.S...', '..S..ss..S..', '..SssKKssS..', '..S..KK..S..', '...S.KK.S...',
    '....SKKS....', '...SSKKSS...', 'GGGGSSSSGGGG', 'GKKKKKKKKKKG', 'GuvuuvuuvuuG', 'uuvuuuvuuuvu'],
  shaft_ladder: [
    'kKKKKKKKKKKk', 'kkSkkkkkkSkk', 'kkSSSSSSSSkk', 'kkSkkkkkkSkk', 'kkSkkkkkkSkk', 'kkSSSSSSSSkk',
    'kkSkkkkkkSkk', 'kkSkkkkkkSkk', 'kkSSSSSSSSkk', 'kkSkkkkkkSkk', 'kkSkkkkkkSkk', 'kkSSSSSSSSkk'],
  rest_stone: [ // 回復點：石台，老賀伯的菸斗冒著煙
    '............', '......l.....', '.....l......', '......l.....', '.....o......', '....kOk.....',
    'llllllllllll', 'gggggggggggg', 'gGgggGggggGg', 'GGGGGGGGGGGG', '.GGGGGGGGGG.', '............'],
  boatman: [ // 船夫寇比：瘦、駝背、撐著長篙
    '....GGGG..m.', '...GGGGGG.m.', '...Gpppp..m.', '...pkppk..m.', '....pppp..m.', '..qqqqqq.pm.',
    '.qqqqqqqqqm.', '.qqqqqqq..m.', '..qqqqqq..m.', '..CCCCCC..m.', '..CC..CC..m.', '..kk..kk..m.'],
  sunken_bell: [ // 沉在淺水底、鐘口朝上的報時鐘（鐘舌不見了）
    '............', '.BBBBBBBBBB.', '.BkkkkkkkkB.', '.BBkkkkkkBB.', '..BeBBBBeB..', '..BBeBBeBB..',
    '...BBBBBB...', '...BeBBBB...', '....BBBB....', '.....BB.....', '.v...v...v..', 'v.v.....v.v.'],
  checkpoint_grille: [ // 哨口鐵柵
    'KKKKKKKKKKKK', 'KS.S.S.S.S.K', 'KS.S.S.S.S.K', 'KS.S.S.S.S.K', 'KSSSSSSSSSSK', 'KS.S.SoS.S.K',
    'KS.S.SOS.S.K', 'KSSSSSSSSSSK', 'KS.S.S.S.S.K', 'KS.S.S.S.S.K', 'KS.S.S.S.S.K', 'KKKKKKKKKKKK'],
  checkpoint_grille__open: [
    'KKKKKKKKKKKK', 'KSS........K', 'KSs........K', 'KSS........K', 'KSs........K', 'KSS........K',
    'KSs........K', 'KSS........K', 'KSs........K', 'KSS........K', 'KSs........K', 'KKKKKKKKKKKK'],
  ink_cache: [ // 推開的鬆磚後面，藏著一瓶影墨
    '............', '............', '..GGGGGGGG..', '..GkkkSkkG..', '..GkkjSjkG..', '..GkjjjjkG..',
    '..GkjajjkG..', '..GkjjjjkG..', '..GGGGGGGG..', '............', '.....GGGG...', '.....gggg...'],
  rest_lamp: [ // 回復點：昏黃的油燈
    '............', '.....kk.....', '....kSSk....', '....SooS....', '...SozzoS...', '...SozzoS...',
    '....SooS....', '...SSSSSS...', '....KKKK....', '..GGGGGGGG..', '..GggggggG..', '............'],
  wax_drips: [ // 一路滴向沉閘的白蠟
    '............', '.x..........', '..x.........', '..xw........', '....x.......', '.....x......',
    '.....xw.....', '.......x....', '........x...', '........xw..', '..........x.', '...........x'],
  sluice_gears: [ // 沉閘的機關：兩組齒輪與鐵鍊
    '.S.S.S......', 'SSSSSSS.q.q.', '.SsKsS.qqqqq', 'SSKKKSSqqKqq', '.SsKsS.qqqqq', 'SSSSSSS.q.q.',
    '.S.S.S...K..', '...K.....K..', '...K.....K..', '...K.....K..', '...K.....K..', 'KKKKKKKKKKKK'],
  oswald: [ // 修士歐斯華：深灰兜袍、鑄成閉著的嘴的鐵口罩、腰間拔掉鐘舌的小鈴
    '...KKKKKK...', '..KGGGGGGK..', '..KGppppGK..', '..KpkppkpK..', '..KSSSSSSK..', '..GSkkkkSG..',
    '.GGGSSSSGGG.', 'GGGGGGGGGGGG', 'GGByByBGGGGG', 'SGGGGGGGGGGS', '.GGGGGGGGGG.', '.KKK....KKK.'],
  sewer_gate: [ // 沉閘：鉚釘鐵板
    'KKKKKKKKKKKK', 'KSSSSSSSSSSK', 'KSlSSSSSSlSK', 'KSSSSSSSSSSK', 'KKKKKKKKKKKK', 'KSSSSSSSSSSK',
    'KSlSSKKSSlSK', 'KSSSSKKSSSSK', 'KKKKKKKKKKKK', 'KSSSSSSSSSSK', 'KSlSSSSSSlSK', 'KnnnnnnnnnnK'],
  hushed_one: [ // 閉口者：灰白皮膚、嘴唇黏住、伸手抓撲
    '....gggg....', '...gPPPPg...', '...PPPPPP...', '...PkPPkP...', '...PPggPP...', '..GGGPPGGG..',
    '.GGGGGGGGGG.', 'PGGGGGGGGGGP', 'P.GGGGGGGG.P', '..GGGGGGGG..', '..GG....GG..', '..PP....PP..'],
  fog_eel: [ // 霧鰻：在污水裡游的半透明長魚
    '............', '........UUU.', '.......UlUkU', '..UU...UUUUU', '.UllU..UlU..', 'UlUUlUUlUU..',
    'U...UlUUU...', '.....UU.....', '..l....l..l.', '.l..l.....l.', '............', '............'],
  // ---- M5 第六章：辦公室、鐘匠巷 ----
  inspector: [ // 監察官歐德莉：灰色立領長外套、銀框眼鏡、白手套、黑公文包、倒過來的白燈徽章
    '...hhhhhh...', '..hhhhhhhh..', '..hpppppph..', '..hskssksh..', '..hpppppph..', '..gggggggg..',
    '.ggggxggggg.', '.gggggggggg.', '.xggggggggxk', '..gggggggkkk', '..gggggggkkk', '...kk..kk...'],
  owen: [ // 搬運工歐文：平頂帽、工作背心
    '............', '...MMMMMM...', '..MMMMMMMM..', '...pkppkp...', '...pppppp...', '..bbbwwbbb..',
    '.bbbbwwbbbb.', '.pbbbbbbbbp.', '..bbbbbbbb..', '..CCCCCCCC..', '..CCC..CCC..', '..kkk..kkk..'],
  ashtray: [ // 堆得高高的紙灰，壓著一角沒燒完的紙
    '............', '............', '............', '............', '............', '.....g.l....',
    '...glgGgyo..', '..gGgllgGg..', '.SSSSSSSSSS.', 'SsggGgGgggsS', '.SSSSSSSSSS.', '............'],
  desk_drawer: [
    'mmmmmmmmmmmm', 'MMMMMMMMMMMM', 'MmmmmmmmmmmM', 'MmMMMMMMMMmM', 'MmMmmoommMmM', 'MmMmmmkmmMmM',
    'MmMMMMMMMMmM', 'MmmmmmmmmmmM', 'MMMMMMMMMMMM', 'M..........M', 'M..........M', 'M..........M'],
  desk_drawer__open: [ // 拉開的抽屜，裡面一封封好的信
    'mmmmmmmmmmmm', 'MMMMMMMMMMMM', 'MmmmmmmmmmmM', 'MkkkkkkkkkkM', 'mMMMMMMMMMMm', 'mMwwwrwMyyMm',
    'mMwwwwwMyyMm', 'mMMMMMMMMMMm', 'MMMMMMMMMMMM', 'M..........M', 'M..........M', 'M..........M'],
  clock_plinth: [ // 停了的大鐘：玻璃裂開，鐘座上兩道淺痕
    '...SSSSSS...', '..SyyyyyyS..', '.SyykyyfyyS.', '.SyykyfyyyS.', '.SyykkkyfyS.', '.SyyyyyfyyS.',
    '..SyyyyyyS..', '...SSSSSS...', '....GGGG....', '...GlgglG...', '..GGGGGGGG..', '.GGGGGGGGGG.'],
  hush_monk: [ // 靜默修士：灰兜袍、較簡陋的鐵口罩
    '...GGGGGG...', '..GGGGGGGG..', '..GGppppGG..', '..GpkppkpG..', '..GSSSSSSG..', '..GGSkkSGG..',
    '.GGGGGGGGGG.', 'GGGGGGGGGGGG', 'pGGGGGGGGGGp', '.GGGGGGGGGG.', '..GGG..GGG..', '..kkk..kkk..'],
  // ---- M5 第七章：港口、沉堤、舊燈塔 ----
  night_gate: [ // 碼頭夜閘
    's.s.s.s.s.s.', 'SSSSSSSSSSSS', 'S.S.S.S.S.S.', 'S.S.S.S.S.S.', 'S.S.SoS.S.S.', 'SSSSSSSSSSSS',
    'S.S.S.S.S.S.', 'S.S.S.S.S.S.', 'S.S.S.S.S.S.', 'S.S.S.S.S.S.', 'SSSSSSSSSSSS', 'K.K.K.K.K.K.'],
  night_gate__open: [
    's.s........s', 'SSS........S', 'SSS........S', 'SSS........S', 'SSS........S', 'SSS........S',
    'SSS........S', 'SSS........S', 'SSS........S', 'SSS........S', 'SSS........S', 'KKK........K'],
  iron_grille: [ // 燈塔的鐵柵：生鏽、掛著大鎖，欄杆的縫隙很窄
    'KKKKKKKKKKKK', 'KSqSSSqSSSqK', 'KS.S.S.S.S.K', 'KS.S.S.S.S.K', 'KS.S.S.S.S.K', 'KSSSSkkSSSSK',
    'KS.SokkoS.SK', 'KS.S.oo.S.SK', 'KS.S.S.S.S.K', 'KSqS.S.SqS.K', 'KS.S.S.S.S.K', 'KKKKKKKKKKKK'],
  iron_grille__open: [
    'KKKKKKKKKKKK', 'KSSq.......K', 'KSs........K', 'KSS........K', 'KSs........K', 'KSS........K',
    'KSs........K', 'KSS........K', 'KSs........K', 'KSq........K', 'KSs........K', 'KKKKKKKKKKKK'],
  deserter: [ // 逃走的詩班員：半件詩班袍、半件工作服，嘴角有黑線的舊勒痕
    '....hhhh....', '...hhhhhh...', '...hpppph...', '...pkppkp...', '...kppppk...', '..xxxwwbbb..',
    '.xxxxwwbbbb.', '.pxxxxbbbbp.', '..xxxxbbbb..', '..xxxxCCCC..', '..xxx..CCC..', '...kk..kk...'],
  keeper_log: [ // 窗台上被海水泡皺的看守日誌
    'kkkkkkkkkkkk', 'kbbbbkkbbbbk', 'kbvbbkkbbbbk', 'kbbbbkkbbvbk', 'kkkkkkkkkkkk', 'mmmmmmmmmmmm',
    '.kkkkkkkkkk.', 'kyfyyykyyfyk', 'kyyfyykyfyyk', 'kkkkkkkkkkkk', 'MMMMMMMMMMMM', '.M........M.'],
  keeper_coat: [ // 掛在牆上的看守大衣，口袋縫得死緊
    '.....SS.....', '.....S......', '...CCCCCC...', '..CCCCCCCC..', '.CCCcCCcCCC.', '.CCCcCCcCCC.',
    '.CCCCCCCCCC.', '.CwkwCCwkwC.', '.CCCCCCCCCC.', '.CCCCCCCCCC.', '..CCC..CCC..', '............'],
  landing_bench: [ // 樓梯平台的長椅與小爐子
    '............', '............', '.........KK.', '........KKKK', '........KooK', '.mmmmmm.KOoK',
    '.MMMMMM.KKKK', '.M....M.K..K', '.M....M.K..K', '............', '............', '............'],
  badge_on_desk: [ // 擦得很亮的白燈徽章
    '............', '............', '.....xx.....', '....xzzx....', '....xzzx....', '.....xx.....',
    '....xxxx....', '...lxxxxl...', 'mmmmmmmmmmmm', 'MMMMMMMMMMMM', '.M........M.', '.M........M.'],
  tide_priest: [ // 潮汐祭司伊格納：濕透的黑袍、袍角藤壺、裝著黑水的提燈；唯一沒有封嘴的人
    '...KKKKKK...', '..KKKKKKKK..', '..KKppppKK..', '..KpkppkpK..', '..KpprrppK..', '.KKKKKKKKKK.',
    'KKnKKKKKKKS.', 'KKKKKKKnKSjS', 'pKKKnKKKKSjS', '.KKKKKKKKKS.', 'KgKKKgKKgKK.', 'gKgKgKKgKgK.'],
  tide_spawn: [ // 潮沫：白沫聚成人形又散開
    '....FFFF....', '...FFFFFF...', '...FnFFnF...', '...FFFFFF...', '....FFFF....', '..FFFFFFFF..',
    '.FF.FFFF.FF.', 'F.FFFFFFFF.F', '..FFlFFlFF..', '.F.FFFFFF.F.', '.l.F.FF.F.l.', '.n.l..n..l.n'],
  tide_omen: [ // 潮兆：從港底升起的灰白巨物，表面浮著許多閉著的嘴
    '...llllll...', '.llfllllfll.', '.lkklflkklf.', 'llfllllllfll', 'lflkkllflkkl', 'llllfllllfll',
    'fkklllkklflf', 'lllflllllfll', 'nlfllkklllfn', 'nnllflllflnn', 'NnnnllllnnnN', 'NNnnnnnnnnNN'],
  unknown: [
    '............', '.kkkkkkkkkk.', '.kmmmmmmmmk.', '.kmmyyyymmk.', '.kmmmmmymmk.', '.kmmmmymmmk.',
    '.kmmmymmmmk.', '.kmmmmmmmmk.', '.kmmmymmmmk.', '.kmmmmmmmmk.', '.kkkkkkkkkk.', '............'],
};
ICONS.hero_right = ICONS.hero_left.map((row) => [...row].reverse().join(''));
/** 主角在戰鬥與選單中的立繪（characters.json 的 sprite「hero」）。 */
ICONS.hero = ICONS.hero_down;

/** 把點陣換色（例如「回應之後」較淡的潮兆）。 */
const remap = (rows, table) => rows.map((row) => [...row].map((ch) => table[ch] ?? ch).join(''));
/** 在點陣上疊一排直立的欄杆（cols 為欄位索引），上下兩列畫成橫桿。 */
function caged(rows, cols, ch) {
  return rows.map((row, y) => {
    if (y === 0 || y === rows.length - 1) return ch.repeat(row.length);
    return [...row].map((c, x) => (cols.includes(x) ? ch : c)).join('');
  });
}
// 蘿絲：關在生鏽鐵籠裡、詩班袍太大的少女
ICONS.rose_cage = caged([
  '............', '....hhhh....', '...hpppph...', '...pkppkp...', '...ppxxpp...', '..xxxxxxxx..',
  '.xxxxxxxxxx.', '.pxxxxxxxxp.', '..xxxxxxxx..', '..xxxxxxxx..', '...kk..kk...', '............'], [0, 3, 8, 11], 'q');
/** 潮兆（回應之後）：同一個外觀，顏色較淡。 */
const OMEN_WANED = { l: 'x', f: 'l', k: 'f', n: 'U', N: 'u', g: 'l' };
ICONS.tide_omen_waned = remap(ICONS.tide_omen, OMEN_WANED);

// ---------- Boss 戰鬥立繪（24×24，比一般敵人的 12×12 細緻） ----------
/** 潮兆：程式產生的灰白巨物——手指般的突起、表面浮著許多閉著的嘴、下半身沒在海水裡。 */
function omenRows() {
  const N = 24;
  const rand = rng('tide_omen');
  const g = Array.from({ length: N }, () => Array(N).fill('.'));
  const inside = (x, y) => {
    const dx = (x + 0.5 - 12) / 11.6;
    const dy = (y + 0.5 - 17) / 12;
    if (dx * dx + dy * dy <= 1) return true;
    // 像手指又像舌頭的突起
    return [[3, 4], [8, 1], [15, 2], [20, 5]].some(([fx, top]) => y >= top && x >= fx && x <= fx + 1 + (y > top + 2 ? 1 : 0));
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (inside(x, y)) g[y][x] = rand() < 0.22 ? 'f' : 'l';
  // 邊緣加深，讓剪影清楚
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (g[y][x] === '.') continue;
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => !inside(x + a, y + b));
    if (edge) g[y][x] = 'g';
  }
  // 閉著的嘴：一道黑線，上下是淡色的唇
  for (const [mx, my, w] of [[5, 9, 3], [15, 8, 4], [10, 12, 3], [18, 13, 3], [3, 15, 3], [12, 16, 4], [7, 19, 3], [17, 18, 3]]) {
    for (let x = mx; x < mx + w; x++) {
      if (g[my][x] === '.') continue;
      g[my][x] = 'k';
      if (g[my - 1][x] !== '.') g[my - 1][x] = 'f';
      if (g[my + 1]?.[x] && g[my + 1][x] !== '.') g[my + 1][x] = 'f';
    }
  }
  // 海面：最下面幾列被潮水蓋住
  for (let y = 20; y < N; y++) for (let x = 0; x < N; x++) {
    const sea = y >= 22 || rand() < (y - 19) * 0.22;
    if (sea) g[y][x] = y === N - 1 || rand() < 0.3 ? 'N' : 'n';
  }
  for (let x = 0; x < N; x += 3) g[21][x] = g[21][x] === '.' ? 'F' : g[21][x]; // 浪花
  return g.map((r) => r.join(''));
}

const BATTLE_ICONS = {
  matilda: [
    '.........ssssss.........', '.......ssssssssss.......', '......ssssssssssss......', '......ssppppppppss......',
    '......spppppppppps......', '......spkkppppkkps......', '......spppppppppps......', '......spppxkkkxpps......',
    '.......ppppppxppp.......', '........dddddddd........', '.......wlwlwlwlwl.......', '....xxxxxxwwwwxxxxxx....',
    '...xxxxxxxxwwxxxxxxxx...', '...xxxdxxxxxxxxxxdxxx...', '..xxxxdxxxxxxxxxxdxxxx..', '..xxxxdxxxlxxlxxxdxxxx..',
    '.wwxxxdxxxxxxxxxxdxxxww.', 'w.w.xxdxxxxxxxxxxdxx.w.w', '....xxdxxxxxxxxxxdxx....', '...xxxdxxxxlxxxxxdxxx...',
    '...xxxxxxxxxxxxxxxxxx...', '..xxxxxxlxxxxxxlxxxxxx..', '..xxxxxxxxxxxxxxxxxxxx..', '.llllllllllllllllllllll.'],
  oswald: [
    '........KKKKKKKK........', '......KKGGGGGGGGKK......', '.....KGGGGGGGGGGGGK.....', '.....KGGGGGGGGGGGGK.....',
    '....KGGGppppppppGGGK....', '....KGGpkkppppkkpGGK....', '....KGGppppppppppGGK....', '....KGKssssssssssKGK....',
    '....KGKslsGGGGslsKGK....', '....KGKssGkkkkGssKGK....', '....KGKsssGGGGsssKGK....', '...KGGGKssssssssKGGGK...',
    '..KGGGGGGGGGGGGGGGGGGK..', '.KGGGGGGGGGGGGGGGGGGGGK.', '.KGGGGGGGGKGGGGGGGGGGGK.', 'KGGGGGGGGGKGGGGGGGGGGGGK',
    'KGGGqqqqqqqqqqqqqqqqGGGK', 'SSGGBBBGBBBGBBBGBBBGGGSS', 'SSSGBBBGBBBGBBBGBBBGGSSS', 'SSSGBkBGBkBGBkBGBkBGGSSS',
    '.SGGGGGGGGGGGGGGGGGGGGS.', '..GGGGGGGGGGGGGGGGGGGG..', '..KKKKKKKKKKKKKKKKKKKK..', '...kkkkk........kkkkk...'],
  tide_priest: [
    '.........KKKKKK.........', '.......KKKKKKKKKK.......', '......KKKKKKKKKKKK......', '......KKKppppppKKK......',
    '......KKppppppppKK......', '......KKpkkppkkpKK......', '......KKppppppppKK......', '......KKpppddpppKK......',
    '.......KKppppppKK.......', '.....KKKKKKKKKKKKKK.....', '....KKKnKKKKKKKKnKKK....', '...KKKKnKKKKKKKKnKKKK...',
    '...KKKKKKKKKKKKKKKKKKp..', '..KKKnKKKKKKKKKKKKnKK.B.', '..KKKKKKKKKKKKKKKKKKKBBB', '.pKKKKnKKKKKKKKKKnKKKBjB',
    '..KKKKKKKKKKKKKKKKKKKBjB', '..KKKnKKKKKKKKKKKnKKKBBB', '..KKKKKKKKKKKKKKKKKKK.n.', '.KKKKnKKKKKKKKKKKKnKKK..',
    '.KgKKKKKgKKKKKKgKKKKgK..', 'KglKKgKKKlgKKKgKKlgKKK..', 'gnglgnKglgnKgnglKgnlgn..', '.n.nn.n..n.nn..n.n.nn...'],
};
BATTLE_ICONS.tide_omen = omenRows();
BATTLE_ICONS.tide_omen_waned = remap(BATTLE_ICONS.tide_omen, OMEN_WANED);

/** Boss 立繪的背景特效（畫在點陣之前）：潮兆身後的冷霧。 */
function omenHalo(ctx, size, alpha) {
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c * 1.1, size * 0.1, c, c * 1.1, size * 0.5);
  g.addColorStop(0, `rgba(200,215,225,${alpha})`);
  g.addColorStop(1, 'rgba(200,215,225,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}
const BATTLE_FX = {
  tide_omen: (ctx, size) => omenHalo(ctx, size, 0.35),
  tide_omen_waned: (ctx, size) => omenHalo(ctx, size, 0.18),
};

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
const BATTLE_SCALE = { silent_hauler: 7, matilda: 8, oswald: 8, tide_priest: 8, tide_omen: 10, tide_omen_waned: 10 };
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
  // ---- M5 ----
  uptown_night: (ctx, rand) => {
    bgGradient(ctx, '#151a26', '#3a4250', 150);
    // 白石街的屋頂與禮拜堂尖塔剪影
    ctx.fillStyle = '#232a36';
    for (const [x, w, h] of [[0, 70, 80], [66, 60, 100], [190, 70, 90], [256, 104, 74]]) ctx.fillRect(x, 150 - h, w, h);
    ctx.fillRect(140, 40, 34, 110); ctx.beginPath(); ctx.moveTo(136, 40); ctx.lineTo(157, 4); ctx.lineTo(178, 40); ctx.fill();
    px(ctx, '#3a3f4c', 152, 56, 10, 14); // 鐘樓的窗
    for (let i = 0; i < 14; i++) {
      const x = [10, 30, 80, 100, 200, 225, 270, 300, 330][i % 9] + (i > 8 ? 8 : 0);
      const y = 84 + (i % 3) * 18;
      px(ctx, rand() < 0.35 ? 'rgba(240,168,72,0.8)' : '#1a1f28', x, y, 7, 9);
    }
    // 石板路
    px(ctx, '#4a4f58', 0, 150, BG_W, 100);
    for (let y = 152; y < BG_H; y += 10) {
      const off = ((y - 152) / 10) % 2 ? 12 : 0;
      for (let x = -off; x < BG_W; x += 24) px(ctx, shade('#5a6070', (rand() - 0.5) * 0.25), x + 1, y, 22, 8);
    }
    bgLamp(ctx, 46, 112); bgLamp(ctx, 314, 112);
    px(ctx, '#20242c', 45, 112, 3, 40); px(ctx, '#20242c', 313, 112, 3, 40);
    bgFog(ctx, rand, 110, 230, 18, 0.2);
  },
  chapel: (ctx, rand) => {
    bgGradient(ctx, '#1c1a22', '#2c2834', 150);
    // 尖拱彩繪玻璃窗：投下彩色的光
    const panes = ['#7a6aa0', '#3e4c8a', '#d0a050', '#8a3b4e', '#4f7a6a'];
    for (const wx of [30, 140, 250]) {
      px(ctx, '#121018', wx, 22, 80, 100);
      ctx.fillStyle = '#121018'; ctx.beginPath(); ctx.moveTo(wx, 22); ctx.lineTo(wx + 40, 0); ctx.lineTo(wx + 80, 22); ctx.fill();
      for (let y = 0; y < 8; y++) for (let x = 0; x < 6; x++) px(ctx, panes[(x * 3 + y + wx) % panes.length], wx + 5 + x * 12, 26 + y * 12, 10, 10);
      px(ctx, 'rgba(244,241,232,0.55)', wx + 33, 40, 14, 14);
      const g = ctx.createLinearGradient(0, 120, 0, 250);
      g.addColorStop(0, 'rgba(122,106,160,0.28)'); g.addColorStop(1, 'rgba(122,106,160,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(wx, 122); ctx.lineTo(wx + 80, 122); ctx.lineTo(wx + 100, 250); ctx.lineTo(wx - 20, 250); ctx.fill();
    }
    // 地板與長椅
    px(ctx, '#3a3640', 0, 150, BG_W, 100);
    for (let y = 150; y < BG_H; y += 16) for (let x = ((y / 16) % 2) * 16; x < BG_W; x += 32) px(ctx, '#46424e', x, y, 16, 16);
    for (const y of [176, 214]) for (const x of [10, 220]) {
      px(ctx, '#3a2a20', x, y, 130, 14); px(ctx, '#6a4c38', x, y, 130, 4); px(ctx, '#2a1c14', x, y + 14, 6, 8); px(ctx, '#2a1c14', x + 124, y + 14, 6, 8);
    }
    // 燭台
    for (const x of [16, 344]) { px(ctx, '#2a2e38', x - 1, 120, 3, 30); px(ctx, '#f4f1e8', x - 2, 112, 5, 8); bgLamp(ctx, x, 108); }
    bgFog(ctx, rand, 140, 240, 8, 0.12);
  },
  sewer: (ctx, rand) => {
    bgGradient(ctx, '#0f1412', '#1e2624');
    // 磚造拱頂
    for (let y = 0; y < 150; y += 10) {
      const off = (y / 10) % 2 ? 14 : 0;
      for (let x = -off; x < BG_W; x += 28) px(ctx, shade('#2e3330', (rand() - 0.5) * 0.25), x + 1, y + 1, 26, 8);
    }
    ctx.fillStyle = '#0a0d0c';
    ctx.beginPath(); ctx.ellipse(180, 150, 110, 120, 0, Math.PI, 0); ctx.fill(); // 隧道深處
    for (let i = 0; i < 10; i++) px(ctx, 'rgba(95,127,74,0.4)', Math.floor(rand() * BG_W), 100 + Math.floor(rand() * 40), 10, 3);
    // 兩側走道與中間的污水渠
    px(ctx, '#3f443c', 0, 150, BG_W, 100);
    px(ctx, '#1f2e2c', 70, 150, 220, 100);
    for (let i = 0; i < 40; i++) px(ctx, 'rgba(140,170,160,0.3)', 70 + Math.floor(rand() * 210), 152 + Math.floor(rand() * 96), 6 + Math.floor(rand() * 10), 1);
    px(ctx, '#5a6058', 66, 150, 4, 100); px(ctx, '#5a6058', 290, 150, 4, 100);
    for (let i = 0; i < 12; i++) px(ctx, 'rgba(160,190,180,0.45)', 20 + Math.floor(rand() * 320), Math.floor(rand() * 140), 1, 4); // 滴水
    bgLamp(ctx, 30, 100);
    bgFog(ctx, rand, 140, 240, 12, 0.12);
  },
  clockmaker_lane: (ctx, rand) => {
    bgGradient(ctx, '#1d2028', '#4a505a', 150);
    // 窄巷兩側的鐘錶行
    ctx.fillStyle = '#262a32';
    ctx.fillRect(0, 10, 90, 140); ctx.fillRect(270, 10, 90, 140);
    for (const [x, y] of [[66, 50], [294, 60]]) { // 掛在店門口的小鐘招牌
      px(ctx, '#20242c', x, y - 10, 2, 10);
      ctx.fillStyle = '#a08040'; ctx.beginPath(); ctx.arc(x + 1, y + 8, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8e2d4'; ctx.beginPath(); ctx.arc(x + 1, y + 8, 7, 0, Math.PI * 2); ctx.fill();
      px(ctx, '#15171c', x, y + 3, 2, 6);
    }
    px(ctx, 'rgba(240,168,72,0.6)', 20, 90, 30, 24); px(ctx, '#15171c', 34, 90, 2, 24);
    // 巷底停了的大鐘
    px(ctx, '#3a3d44', 166, 70, 28, 80);
    ctx.fillStyle = '#8a7c5c'; ctx.beginPath(); ctx.arc(180, 60, 30, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#d8d2c2'; ctx.beginPath(); ctx.arc(180, 60, 25, 0, Math.PI * 2); ctx.fill();
    px(ctx, '#15171c', 179, 42, 2, 18); px(ctx, '#15171c', 180, 59, 14, 2);
    ctx.strokeStyle = '#8a8f96'; ctx.beginPath(); ctx.moveTo(164, 48); ctx.lineTo(186, 70); ctx.lineTo(196, 52); ctx.stroke(); // 裂開的玻璃
    px(ctx, '#4a4f58', 0, 150, BG_W, 100);
    for (let i = 0; i < 80; i++) px(ctx, shade('#5a6070', (rand() - 0.5) * 0.3), Math.floor(rand() * BG_W), 150 + Math.floor(rand() * 100), 4, 2);
    bgFog(ctx, rand, 30, 240, 30, 0.26); // 這條巷子的霧最濃
  },
  harbor_night: (ctx, rand) => {
    bgGradient(ctx, '#0e131c', '#25303c', 130);
    // 停泊的船與桅杆剪影
    ctx.fillStyle = '#141a22';
    ctx.fillRect(20, 96, 120, 20); ctx.fillRect(60, 30, 3, 66); ctx.fillRect(100, 44, 3, 52);
    ctx.fillRect(220, 104, 100, 14); ctx.fillRect(260, 50, 3, 54);
    // 遠方不亮的燈塔
    ctx.fillRect(330, 60, 10, 50); ctx.fillRect(327, 54, 16, 8);
    px(ctx, '#22343a', 0, 110, BG_W, 40);
    for (let i = 0; i < 40; i++) px(ctx, 'rgba(150,180,200,0.3)', Math.floor(rand() * BG_W), 112 + Math.floor(rand() * 36), 6 + Math.floor(rand() * 10), 1);
    // 碼頭石岸
    px(ctx, '#4a4f58', 0, 150, BG_W, 100);
    for (let x = 0; x < BG_W; x += 30) px(ctx, shade('#5c6064', (rand() - 0.5) * 0.2), x + 1, 151, 28, 14);
    px(ctx, '#3a3d44', 300, 140, 16, 20); px(ctx, '#55595f', 300, 140, 16, 4);
    bgLamp(ctx, 40, 120);
    bgFog(ctx, rand, 70, 220, 26, 0.24);
  },
  breakwater: (ctx, rand) => {
    bgGradient(ctx, '#10161e', '#2a3542', 140);
    // 海面與打上來的浪
    px(ctx, '#1c2a32', 0, 90, BG_W, 160);
    for (let i = 0; i < 60; i++) px(ctx, 'rgba(160,190,200,0.28)', Math.floor(rand() * BG_W), 92 + Math.floor(rand() * 150), 8 + Math.floor(rand() * 12), 1);
    // 往遠方延伸的沉堤，盡頭是燈塔
    ctx.fillStyle = '#5b6168'; ctx.beginPath(); ctx.moveTo(60, 250); ctx.lineTo(300, 250); ctx.lineTo(196, 110); ctx.lineTo(176, 110); ctx.fill();
    for (let y = 120; y < 250; y += 14) { const w = (y - 110) * 0.85; px(ctx, '#3f454c', 186 - w, y, w * 2, 2); }
    ctx.fillStyle = '#20262e'; ctx.fillRect(180, 40, 12, 70); ctx.fillRect(176, 32, 20, 10);
    for (let i = 0; i < 18; i++) { // 打上堤岸的浪花
      const side = rand() < 0.5 ? -1 : 1;
      const y = 120 + rand() * 120;
      const x = 186 + side * ((y - 110) * 0.85 + 2);
      px(ctx, 'rgba(233,239,233,0.75)', x - 4, y, 8, 2);
    }
    bgFog(ctx, rand, 40, 200, 22, 0.24);
  },
  lighthouse: (ctx, rand) => {
    bgGradient(ctx, '#15181e', '#2a2e36');
    // 彎曲的石牆
    for (let y = 0; y < 160; y += 12) {
      const off = (y / 12) % 2 ? 18 : 0;
      for (let x = -off; x < BG_W; x += 36) {
        const center = 1 - Math.abs(x + 18 - 180) / 220;
        px(ctx, shade('#3a3f47', (rand() - 0.5) * 0.15 + center * 0.15 - 0.1), x + 1, y + 1, 34, 10);
      }
    }
    px(ctx, '#0d0f13', 172, 36, 16, 56); px(ctx, 'rgba(191,224,232,0.25)', 174, 40, 4, 48); // 窗縫
    // 螺旋樓梯
    for (let i = 0; i < 8; i++) px(ctx, shade('#6a6156', -i * 0.06), 250 + i * 10, 150 - i * 18, 60, 6);
    px(ctx, '#2a2e38', 300, 0, 6, 160);
    px(ctx, '#4c4944', 0, 150, BG_W, 100);
    for (let x = 0; x < BG_W; x += 18) px(ctx, '#3a3834', x, 150, 1, 100);
    bgLamp(ctx, 60, 90);
    bgFog(ctx, rand, 150, 240, 10, 0.14);
  },
  lighthouse_top: (ctx, rand) => {
    // 燈室：玻璃外是霧夜與翻湧的海
    bgGradient(ctx, '#0b0f16', '#22303a', 170);
    for (let i = 0; i < 30; i++) px(ctx, 'rgba(160,190,200,0.22)', Math.floor(rand() * BG_W), 120 + Math.floor(rand() * 50), 10 + Math.floor(rand() * 16), 1);
    for (let x = 0; x <= BG_W; x += 60) px(ctx, '#1a1e26', x - 2, 0, 5, 170); // 窗框
    px(ctx, '#1a1e26', 0, 18, BG_W, 4);
    // 巨大的燈鏡：冷光
    const g = ctx.createRadialGradient(180, 30, 4, 180, 30, 80);
    g.addColorStop(0, 'rgba(191,224,232,0.55)'); g.addColorStop(1, 'rgba(191,224,232,0)');
    ctx.fillStyle = g; ctx.fillRect(90, 0, 180, 170);
    for (let i = 0; i < 4; i++) px(ctx, shade('#9fb3bd', -0.3 + i * 0.12), 160 + i * 4, 4 + i * 4, 40 - i * 8, 48 - i * 8);
    px(ctx, '#e8f4f8', 177, 24, 6, 10);
    // 鐵欄杆與鐵板地
    px(ctx, '#3a3f47', 0, 166, BG_W, 4);
    for (let x = 4; x < BG_W; x += 16) px(ctx, '#3a3f47', x, 150, 3, 20);
    px(ctx, '#3a3f47', 0, 150, BG_W, 3);
    px(ctx, '#33363d', 0, 170, BG_W, 80);
    for (let x = 0; x < BG_W; x += 40) for (let y = 172; y < BG_H; y += 26) { px(ctx, '#2a2c32', x, y, 40, 1); px(ctx, '#6f7e8c', x + 3, y + 3, 1, 1); }
    bgFog(ctx, rand, 20, 240, 26, 0.22);
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

/**
 * 點陣格式檢查（測試用）：地圖點陣必須是 12×12、Boss 戰鬥點陣 24×24，字元只能是「.」或色盤裡有的代號。
 * 回傳問題清單，空陣列＝全部正常。
 */
export function artLint() {
  const problems = [];
  const check = (set, label, n) => {
    for (const [name, rows] of Object.entries(set)) {
      if (!Array.isArray(rows) || rows.length !== n) { problems.push(`${label} ${name}：列數 ${rows?.length}，應為 ${n}`); continue; }
      rows.forEach((row, y) => {
        if (row.length !== n) problems.push(`${label} ${name} 第 ${y} 列長度 ${row.length}，應為 ${n}`);
        for (const ch of row) if (ch !== '.' && !Object.hasOwn(PAL, ch)) problems.push(`${label} ${name} 第 ${y} 列有未定義的顏色代號「${ch}」`);
      });
    }
  };
  check(ICONS, '點陣', 12);
  check(BATTLE_ICONS, 'Boss 立繪', 24);
  for (const name of Object.keys(BATTLE_ICONS)) if (!Object.hasOwn(ICONS, name)) problems.push(`Boss 立繪 ${name} 沒有對應的 12×12 點陣`);
  for (const name of Object.keys(BATTLE_ICONS)) if (battleSpriteSize(name) % 24 !== 0) problems.push(`Boss 立繪 ${name} 的尺寸 ${battleSpriteSize(name)} 不是 24 的倍數（像素會糊）`);
  return problems;
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
    if (Object.hasOwn(BATTLE_FX, name)) BATTLE_FX[name](ctx, size);
    const rows = (Object.hasOwn(BATTLE_ICONS, name) && BATTLE_ICONS[name]) || ICONS[name] || ICONS.unknown;
    paintIcon(ctx, rows, size / rows.length);
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
