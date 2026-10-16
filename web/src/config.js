// 畫面層共用常數：邏輯解析度、版面、色盤、字型。

export const WIDTH = 360;
export const HEIGHT = 640;

/** 地圖格子大小（像素）與地圖鏡頭縮放。 */
export const TILE = 24;
export const MAP_ZOOM = 1.5;

/** 版面：上方 HUD、中段地圖、下方操作區（對話框出現時蓋住操作區）。 */
export const HUD_H = 44;
export const PANEL_Y = 470;
export const MAP_VIEW = { x: 0, y: HUD_H, w: WIDTH, h: PANEL_Y - HUD_H };

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
