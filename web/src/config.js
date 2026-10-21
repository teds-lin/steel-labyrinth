// 畫面層共用常數：邏輯解析度、版面、色盤、字型、雲端 API 位址。
import { API_BASE_DEFAULT, resolveApiBase } from './cloud/endpoint.js';

export const WIDTH = 360;
export const HEIGHT = 640;

/** 地圖格子大小（像素）與地圖鏡頭縮放。 */
export const TILE = 24;
export const MAP_ZOOM = 1.5;

/** 版面：上方 HUD、中段地圖、下方操作區（對話框出現時蓋住操作區）。 */
export const HUD_H = 62;
export const PANEL_Y = 470;
export const MAP_VIEW = { x: 0, y: HUD_H, w: WIDTH, h: PANEL_Y - HUD_H };

/** 意見回饋：GitHub 討論區（全專案只在這裡寫網址；畫面文字由 ui/feedback.js 產生）。 */
export const FEEDBACK_URL = 'https://github.com/teds-lin/steel-labyrinth/discussions';

export const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';

/** 色盤：霧藍灰＋煤氣燈橘。 */
export const COLORS = {
  bg: 0x101319,
  panel: 0x1a1f28,
  panelHi: 0x252c38,
  line: 0x3a4454,
  fog: 0x8c98a6,
  fogLight: 0xb4bec8,
  gas: 0xf0a848,
  gasDeep: 0xb8692a,
  text: '#e8e2d4',
  textDim: '#9aa6b4',
  textGas: '#f0a848',
  textDisabled: '#5c6573',
  danger: 0xc0563a,
};

/** ?test=1：逐字顯示改瞬間、關閉霧氣動畫、暴露 window.__SL。 */
export const TEST_MODE = (() => {
  try {
    return new URLSearchParams(window.location.search).get('test') === '1';
  } catch {
    return false;
  }
})();

/** 文字貼圖解析度：避免高解析度螢幕上中文字模糊。 */
export const TEXT_RESOLUTION = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));

/**
 * 戰鬥亂數種子：?test=1&seed=N 時固定為 N（E2E 重現用）；否則每場戰鬥由時間＋亂數產生。
 */
export function battleSeed() {
  if (TEST_MODE) {
    try {
      const raw = new URLSearchParams(window.location.search).get('seed');
      if (raw !== null && /^\d{1,10}$/.test(raw)) return Number(raw) >>> 0;
    } catch { /* 沒有 seed 參數就照一般方式產生 */ }
  }
  return ((Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
}

/**
 * 雲端 API 的基底網址：預設正式網址（cloud/endpoint.js 的 API_BASE_DEFAULT）；
 * ?api=<url> 可覆寫（只在本機開發頁面、或目標是本機 Worker 時生效）。
 */
export function apiBase() {
  try {
    return resolveApiBase(window.location.search, window.location.hostname);
  } catch {
    return API_BASE_DEFAULT;
  }
}

/**
 * 內容資料的位置：預設 data/。測試模式（?test=1）可用 ?data=<相對路徑>/ 改讀另一份資料（E2E 用 page.route 提供，
 * 例如測試用的夢境地圖或尚未公開的章節）。只接受同網站的相對路徑（英數、底線、連字號、斜線，結尾必須是 /）。
 */
export function dataBase() {
  const fallback = new URL('data/', document.baseURI);
  if (!TEST_MODE) return fallback;
  try {
    const raw = new URLSearchParams(window.location.search).get('data');
    if (raw && /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/$/.test(raw)) return new URL(raw, document.baseURI);
  } catch { /* 參數壞掉就用預設 */ }
  return fallback;
}
