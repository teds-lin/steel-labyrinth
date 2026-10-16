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
  unknown: [
    '............', '.kkkkkkkkkk.', '.kmmmmmmmmk.', '.kmmyyyymmk.', '.kmmmmmymmk.', '.kmmmmymmmk.',
    '.kmmmymmmmk.', '.kmmmmmmmmk.', '.kmmmymmmmk.', '.kmmmmmmmmk.', '.kkkkkkkkkk.', '............'],
};
ICONS.hero_right = ICONS.hero_left.map((row) => [...row].reverse().join(''));

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

/** 產生全部貼圖。spriteNames 為地圖物件用到的 sprite 名稱。 */
export function generateTextures(scene, data) {
  for (const tile of data.tiles ?? []) {
    const { tex, ctx } = makeCanvas(scene, tileKey(tile.id), S, S);
    paintTile(ctx, tile);
    tex.refresh();
  }
  const lockedSprites = new Set();
  const sprites = new Set();
  for (const map of data.maps ?? []) {
    for (const o of map.objects ?? []) {
      if (typeof o.sprite !== 'string') continue;
      sprites.add(o.sprite);
      if (o.lock) lockedSprites.add(o.sprite);
    }
  }
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
  for (const dir of ['up', 'down', 'left', 'right']) {
    const { tex, ctx } = makeCanvas(scene, heroKey(dir), S, S);
    paintIcon(ctx, ICONS[`hero_${dir}`]);
    tex.refresh();
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
