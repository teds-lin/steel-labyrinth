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
import { BattleScene } from './scenes/BattleScene.js';
import { GameOverScene } from './scenes/GameOverScene.js';
import { DreamChatScene } from './scenes/DreamChatScene.js';
import { artReport } from './textures.js';
import { cloud, cloudApiBase } from './cloud-client.js';

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
  // 順序＝繪製順序：Battle 蓋在（睡眠中的）Map／UI 上，Menu 一律 bringToTop
  scene: [BootScene, TitleScene, NameScene, MapScene, UIScene, BattleScene, GameOverScene, DreamChatScene, MenuScene, ChapterEndScene],
});

// 旋轉或改變視窗大小（例如遊戲中 375×667 → 667×375）：讓 FIT 重新計算畫布大小。
// 行動裝置旋轉時 innerWidth／innerHeight 可能晚一點才更新，所以下一幀與稍後各再算一次。
{
  const refit = () => {
    try { game.scale.refresh(); } catch { /* 遊戲尚未初始化完成時略過 */ }
  };
  const onResize = () => {
    refit();
    requestAnimationFrame(refit);
    setTimeout(refit, 250);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

// E2E 掛勾：只在 ?test=1 時暴露，而且只給唯讀的複本
if (TEST_MODE) {
  const ro = (v) => (v === undefined || v === null ? null : deepFreeze(structuredClone(v)));
  const activeScene = (key) => {
    const sc = game.scene.getScene(key);
    return sc && (sc.sys.isActive() || sc.sys.isPaused()) ? sc : null;
  };
  const api = Object.freeze({
    getState: () => {
      const s = session.snapshot();
      return s ? deepFreeze(structuredClone(s)) : null;
    },
    currentScene: () => session.scene,
    dialogue: () => (session.dialogueView ? deepFreeze(structuredClone(session.dialogueView)) : null),
    /** 標題選單各項是否可用、是否顯示橫向提示。不在標題畫面時為 null。 */
    title: () => ro(activeScene('Title')?.debugInfo()),
    /** 選單目前頁面與各項（含邏輯座標）。選單沒開時為 null。 */
    menu: () => ro(activeScene('Menu')?.debugInfo()),
    /** HUD 顯示的文字。不在地圖時為 null。 */
    hud: () => ro(activeScene('UI')?.debugInfo()),
    /** 對話選項按鈕的位置（邏輯座標 360×640）。 */
    choiceRects: () => ro(activeScene('UI')?.dialogue?.choiceRects() ?? []),
    /** 名牌排版：給定名字時名牌實際顯示的文字與寬度。 */
    nameplate: (name) => ro(activeScene('UI')?.dialogue?.nameplateLayout(String(name ?? '')) ?? null),
    /** 雲端存檔的唯讀狀態（不含權杖）：是否啟用、轉移碼、各槽記住的版本、最後的錯誤、API 位址。 */
    cloud: () => ro({ ...cloud.status(), apiBase: cloudApiBase() }),
    /** 戰鬥畫面的唯讀摘要：行動者、指令、敵我生命、被揭露的意圖、選單按鈕位置、結果、完整 log。不在戰鬥中時為 null。 */
    battle: () => ro(activeScene('Battle')?.debugInfo()),
    /** 夢客自由交談畫面（訊息、剩餘句數、輸入框狀態、人機驗證、按鈕位置）。不在該畫面時為 null。 */
    chat: () => ro(activeScene('DreamChat')?.debugInfo()),
    /** 地圖場景的唯讀資訊（目前地圖、夢境視覺）。 */
    map: () => ro(activeScene('Map')?.debugInfo()),
    /** Game Over 畫面（標題、按鈕位置）。不在該畫面時為 null。 */
    gameOver: () => ro(activeScene('GameOver')?.debugInfo()),
    /** 美術覆蓋：資料裡出現但沒有專屬畫法的 sprite／tile／戰鬥背景，以及貼圖是否都已產生。 */
    art: () => {
      const rep = artReport(session.data);
      const tex = game.textures;
      const sprites = new Set();
      for (const m of session.data?.maps ?? []) for (const o of m.objects ?? []) if (typeof o.sprite === 'string') sprites.add(o.sprite);
      const fighters = [...(session.data?.characters ?? []), ...(session.data?.enemies ?? [])].map((c) => c.sprite ?? c.id);
      const missingTextures = [
        ...[...sprites, ...fighters].filter((n) => !tex.exists(`spr:${n}`)).map((n) => `spr:${n}`),
        ...fighters.filter((n) => !tex.exists(`bspr:${n}`)).map((n) => `bspr:${n}`),
        ...(session.data?.tiles ?? []).filter((t) => !tex.exists(`tile:${t.id}`)).map((t) => `tile:${t.id}`),
        ...(session.data?.encounters ?? []).filter((e) => e.bg && !tex.exists(`bg:${e.bg}`)).map((e) => `bg:${e.bg}`),
      ];
      return ro({ ...rep, missingTextures });
    },
    /** 除錯資訊：場景順序、監聽器數量、光暈數量、章節結束畫面文字。 */
    debug: () => ro({
      // 繪製順序（後面的畫在上面），包含暫停中但仍顯示的場景
      sceneOrder: game.scene.scenes.filter((s) => s.sys.isActive() || s.sys.isPaused()).map((s) => s.sys.settings.key),
      listeners: Object.fromEntries(['Map', 'Title', 'ChapterEnd', 'Menu', 'UI', 'Battle', 'GameOver', 'DreamChat'].map((k) => {
        const sc = game.scene.getScene(k);
        return [k, {
          resume: sc?.events?.listenerCount('resume') ?? 0,
          keydown: sc?.input?.keyboard?.listenerCount('keydown') ?? 0,
        }];
      })),
      stateListeners: session.events.listenerCount('state'),
      glows: activeScene('Map')?.debugInfo().glows ?? null,
      chapterEnd: activeScene('ChapterEnd')?.debugInfo() ?? null,
    }),
  });
  Object.defineProperty(window, '__SL', { value: api, writable: false, configurable: false, enumerable: false });
}

export { game };
