// M 鍵靜音的短提示：畫在目前最上層、正在執行的場景上（不另開場景，不影響場景順序）。
// 位置依場景避開頂部介面（ui/audio-view.js 的 toastY）。
// 不 import widgets.js：widgets 會 import 聲音模組，避免循環。
import { WIDTH, FONT, TEXT_RESOLUTION } from '../config.js';
import { toastY } from './audio-view.js';

let current = null;

/** 顯示約 1.2 秒後淡出；同時間只有一個（新的取代舊的）。 */
export function showAudioToast(game, text) {
  try {
    if (current?.obj?.active) current.obj.destroy();
    current = null;
    // 地圖場景的鏡頭有縮放，提示畫在它上面會跑位：跳過（地圖上方一定有 UI 場景）
    const scenes = game.scene.getScenes(true).filter((s) => s.sys.settings.key !== 'Map');
    const sc = scenes[scenes.length - 1];
    if (!sc) return;
    const obj = sc.add.text(WIDTH / 2, toastY(sc.sys.settings.key), text, {
      fontFamily: FONT, fontSize: '15px', color: '#ffe2b0', backgroundColor: '#1a1f28ee', padding: { x: 14, y: 8 },
      resolution: TEXT_RESOLUTION,
    }).setOrigin(0.5).setDepth(1000).setScrollFactor(0);
    try { obj.texture?.setFilter?.(Phaser.Textures.FilterMode.LINEAR); } catch { /* Canvas 模式不需要 */ }
    current = { obj, text };
    sc.tweens.add({
      targets: obj, alpha: 0, delay: 1200, duration: 300,
      onComplete: () => { obj.destroy(); if (current?.obj === obj) current = null; },
    });
  } catch { /* 提示失敗不影響遊戲 */ }
}

/** 目前畫面上提示的位置（邏輯座標，中心＋寬高；E2E 用）；沒有就是 null。 */
export function audioToastRect() {
  const o = current?.obj;
  if (!o?.active || !o.visible) return null;
  return { x: o.x, y: o.y, w: o.displayWidth, h: o.displayHeight };
}

/** 目前畫面上的提示文字（E2E 用）；沒有就是 null。 */
export function audioToastText() {
  return current?.obj?.active && current.obj.visible ? current.text : null;
}
