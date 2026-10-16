// 章節結束：「序章 完」→「第一章 製作中」→ 提示存檔（開啟存檔選單）→ 回標題。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, ButtonList } from '../ui/widgets.js';

const CHAPTER_TITLES = { prologue: '序章' };

export class ChapterEndScene extends Phaser.Scene {
  constructor() { super('ChapterEnd'); }

  init(data) {
    this.chapter = data?.chapter ?? 'prologue';
  }

  create() {
    session.scene = 'ChapterEnd';
    this.cameras.main.setBackgroundColor(0x07090c);
    this.list = null;
    const fade = TEST_MODE ? 150 : 900;

    const t1 = addText(this, WIDTH / 2, 230, `${CHAPTER_TITLES[this.chapter] ?? this.chapter}　完`, {
      fontSize: '34px', fontStyle: 'bold', color: '#f0d2a0',
    }).setOrigin(0.5).setAlpha(0);
    const t2 = addText(this, WIDTH / 2, 290, '第一章　製作中', { fontSize: '18px', color: COLORS.textDim }).setOrigin(0.5).setAlpha(0);
    const t3 = addText(this, WIDTH / 2, 370, '要把目前的進度存檔嗎？', { fontSize: '15px', color: COLORS.text }).setOrigin(0.5).setAlpha(0);

    this.tweens.chain({
      tweens: [
        { targets: t1, alpha: 1, duration: fade },
        { targets: t2, alpha: 1, duration: fade, delay: fade / 2 },
        { targets: t3, alpha: 1, duration: fade / 2, delay: fade / 2, onComplete: () => this.showButtons() },
      ],
    });

    this.input.keyboard.on('keydown', (ev) => {
      if (ev.repeat || !claimKey(ev)) return;
      this.list?.handleKey(ev.code);
    });
    this.events.on('resume', () => { session.scene = 'ChapterEnd'; });
  }

  showButtons() {
    this.list = new ButtonList(this, {
      x: WIDTH / 2, y: 430, w: 220, h: 52, gap: 14,
      items: [
        { label: '存檔', onSelect: () => this.openSave() },
        { label: '回標題', onSelect: () => this.scene.start('Title') },
      ],
    });
    addText(this, WIDTH / 2, HEIGHT - 40, '感謝遊玩', { fontSize: '12px', color: COLORS.textDisabled }).setOrigin(0.5);
  }

  openSave() {
    this.scene.pause();
    this.scene.launch('Menu', { mode: 'save', from: 'ChapterEnd' });
  }
}
