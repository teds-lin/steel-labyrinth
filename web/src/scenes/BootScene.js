// Boot：載入資料 bundle、等字型、產生貼圖，然後進標題畫面。
import { WIDTH, HEIGHT, FONT, COLORS } from '../config.js';
import { loadBundle } from '../data-loader.js';
import { generateTextures } from '../textures.js';
import { session } from '../session.js';
import { addText } from '../ui/widgets.js';

async function waitFonts(timeoutMs = 2500) {
  if (!document.fonts?.load) return;
  const timeout = new Promise((r) => setTimeout(r, timeoutMs));
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`16px ${FONT}`, '鋼鐵迷都存檔讀取'),
        document.fonts.load(`bold 16px ${FONT}`, '鋼鐵迷都'),
      ]),
      timeout,
    ]);
  } catch { /* 字型載入失敗就用系統字型 */ }
}

export class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create() {
    session.scene = 'Boot';
    this.cameras.main.setBackgroundColor(COLORS.bg);
    this.status = addText(this, WIDTH / 2, HEIGHT / 2, '載入中……', { color: COLORS.textDim }).setOrigin(0.5);
    this.run();
  }

  async run() {
    let result;
    try {
      [result] = await Promise.all([loadBundle(), waitFonts()]);
    } catch (e) {
      result = { bundle: null, errors: [`載入時發生錯誤：${e?.message ?? e}`] };
    }
    if (!result.bundle || result.errors.length) {
      this.showError(result.errors);
      return;
    }
    session.data = result.bundle;
    try {
      generateTextures(this, session.data);
    } catch (e) {
      this.showError([`產生貼圖失敗：${e?.message ?? e}`]);
      return;
    }
    this.scene.start('Title');
  }

  showError(errors) {
    const msg = `遊戲資料載入失敗，請重新整理頁面再試一次。\n\n${errors.map((e) => `・${e}`).join('\n')}`;
    console.error(msg);
    this.status.setText('遊戲資料載入失敗');
    const box = document.getElementById('boot-error');
    if (box) {
      box.textContent = msg; // 只用 textContent，不用 innerHTML
      box.style.display = 'block';
    }
  }
}
