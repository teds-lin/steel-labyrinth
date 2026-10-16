// 進入點：建立 Phaser 遊戲、註冊場景、測試模式掛勾。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from './config.js';
import { session } from './session.js';
import { BootScene } from './scenes/BootScene.js';
import { TitleScene } from './scenes/TitleScene.js';
import { NameScene } from './scenes/NameScene.js';
import { MapScene } from './scenes/MapScene.js';
import { UIScene } from './scenes/UIScene.js';
import { MenuScene } from './scenes/MenuScene.js';
import { ChapterEndScene } from './scenes/ChapterEndScene.js';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: WIDTH,
  height: HEIGHT,
  backgroundColor: COLORS.bg,
  pixelArt: true,
  dom: { createContainer: true },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  input: { activePointers: 3 },
  scene: [BootScene, TitleScene, NameScene, MapScene, UIScene, MenuScene, ChapterEndScene],
});

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

// E2E 掛勾：只在 ?test=1 時暴露，而且只給唯讀的複本
if (TEST_MODE) {
  const api = Object.freeze({
    getState: () => {
      const s = session.snapshot();
      return s ? deepFreeze(structuredClone(s)) : null;
    },
    currentScene: () => session.scene,
    dialogue: () => (session.dialogueView ? deepFreeze(structuredClone(session.dialogueView)) : null),
  });
  Object.defineProperty(window, '__SL', { value: api, writable: false, configurable: false, enumerable: false });
}

export { game };
