// 章節結束：story 的 end_screen（標題、副標）→ 提示存檔（開啟存檔選單）→ 回標題。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, ButtonList } from '../ui/widgets.js';

export class ChapterEndScene extends Phaser.Scene {
  constructor() { super('ChapterEnd'); }

  init(data) {
    this.chapter = data?.chapter ?? session.data?.manifest?.chapters?.[0] ?? null;
  }

  /** 章節結束畫面的文字：story.end_screen，沒寫時用「<章名>　完」、無副標。 */
  screenTexts() {
    const story = session.data?.story?.find((c) => c?.id === this.chapter);
    const name = story?.title ?? this.chapter ?? '';
    const es = story?.end_screen;
    return {
      title: typeof es?.title === 'string' ? es.title : `${name}　完`,
      subtitle: typeof es?.subtitle === 'string' ? es.subtitle : '',
    };
  }

  /** E2E 用的唯讀資訊。 */
  debugInfo() { return this.texts ?? null; }

  create() {
    session.scene = 'ChapterEnd';
    this.cameras.main.setBackgroundColor(0x07090c);
    this.list = null;
    const fade = TEST_MODE ? 150 : 900;

    this.texts = this.screenTexts();
    const t1 = addText(this, WIDTH / 2, 230, this.texts.title, {
      fontSize: '34px', fontStyle: 'bold', color: '#f0d2a0',
    }).setOrigin(0.5).setAlpha(0);
    if (t1.width > WIDTH - 32) t1.setScale((WIDTH - 32) / t1.width);
    const t2 = addText(this, WIDTH / 2, 290, this.texts.subtitle, {
      fontSize: '18px', color: COLORS.textDim, align: 'center', wordWrap: { width: WIDTH - 48, useAdvancedWrap: true },
    }).setOrigin(0.5).setAlpha(0);
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
    this.events.on('resume', this.onResume, this);
    this.events.once('shutdown', () => this.events.off('resume', this.onResume, this));
  }

  onResume() { session.scene = 'ChapterEnd'; }

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
