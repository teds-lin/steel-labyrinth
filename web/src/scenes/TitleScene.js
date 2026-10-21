import { titleFooter, TITLE_KEY_HINT } from '../ui/m5-view.js';
// 標題畫面：遊戲名稱、新遊戲、繼續（沒有可讀存檔時停用）、用轉移碼接續（雲端存檔）、意見回饋、霧氣飄動。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, ButtonList } from '../ui/widgets.js';
import { FEEDBACK_LABEL } from '../ui/feedback.js';

export class TitleScene extends Phaser.Scene {
  constructor() { super('Title'); }

  create() {
    session.scene = 'Title';
    session.reset();
    this.cameras.main.setBackgroundColor(COLORS.bg);
    this.drawBackdrop();
    this.drawFog();

    addText(this, WIDTH / 2, 170, '鋼鐵迷都', {
      fontSize: '44px', fontStyle: 'bold', color: '#f0d2a0',
      stroke: '#2a1a0c', strokeThickness: 6,
    }).setOrigin(0.5);
    addText(this, WIDTH / 2, 222, '蒸汽與迷霧交織的城市', { fontSize: '15px', color: COLORS.textDim }).setOrigin(0.5);

    // 只要有任何非空的存檔槽（包含損壞、版本較新）就可以按「繼續」，在讀取選單裡看到狀態
    const hasSave = session.hasAnySave();
    this.menu = new ButtonList(this, {
      // 四個按鈕：往上移、間距縮小，最後一個不壓到下方的操作說明
      x: WIDTH / 2, y: 340, w: 220, h: 52, gap: 12,
      items: [
        { label: '新遊戲', onSelect: () => this.scene.start('Name') },
        {
          label: '繼續', enabled: hasSave, onSelect: () => this.openLoad(),
          sub: hasSave ? null : (session.storageAvailable ? '目前沒有存檔' : '瀏覽器封鎖了儲存空間'),
        },
        {
          label: '用轉移碼接續', enabled: session.storageAvailable, onSelect: () => this.openTransfer(),
          sub: session.storageAvailable ? null : '瀏覽器封鎖了儲存空間',
        },
        { label: FEEDBACK_LABEL, onSelect: () => this.openFeedback() },
      ],
    });
    addText(this, WIDTH / 2, HEIGHT - 52, TITLE_KEY_HINT, {
      fontSize: '11px', color: COLORS.textDisabled,
    }).setOrigin(0.5);
    const footer = titleFooter(session.data);
    if (footer) {
      addText(this, WIDTH / 2, HEIGHT - 30, footer, { fontSize: '11px', color: COLORS.textDisabled }).setOrigin(0.5);
    }

    // 橫向手機（高度不夠）：本版沒有橫向版面，提示改用直向
    this.landscapeHint = addText(this, WIDTH / 2, 28, '建議直向遊玩', {
      fontSize: '14px', color: '#ffe2b0', backgroundColor: '#1a1f28dd', padding: { x: 12, y: 6 },
    }).setOrigin(0.5).setDepth(50);
    const onResize = () => this.updateLandscapeHint();
    this.scale.on('resize', onResize);
    window.addEventListener('resize', onResize);
    this.events.once('shutdown', () => {
      this.scale.off('resize', onResize);
      window.removeEventListener('resize', onResize);
    });
    this.updateLandscapeHint();

    this.input.keyboard.on('keydown', (ev) => {
      if (!claimKey(ev)) return;
      this.menu.handleKey(ev.code);
    });
    this.events.on('resume', this.onResume, this);
    this.events.once('shutdown', () => this.events.off('resume', this.onResume, this));
  }

  onResume() { session.scene = 'Title'; }

  updateLandscapeHint() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.landscapeHint?.setVisible(w > h && h < 500);
  }

  /** E2E 用的唯讀資訊。 */
  debugInfo() {
    return {
      items: this.menu.buttons.map((b, i) => ({
        label: b.label.text, enabled: b.enabled, focused: i === this.menu.index, sub: b.sub?.text ?? null, x: b.x, y: b.y, w: b.w, h: b.h,
      })),
      landscapeHint: !!this.landscapeHint?.visible,
    };
  }

  openTransfer() {
    this.scene.pause();
    this.scene.launch('Menu', { mode: 'transfer', from: 'Title' });
  }

  /** 意見回饋：提示頁（選單場景的 feedback 模式）疊在標題上，關閉後回到標題。 */
  openFeedback() {
    this.scene.pause();
    this.scene.launch('Menu', { mode: 'feedback', from: 'Title' });
  }

  openLoad() {
    this.scene.pause();
    this.scene.launch('Menu', { mode: 'load', from: 'Title' });
  }

  drawBackdrop() {
    const g = this.add.graphics();
    // 遠方的城市剪影＋煤氣燈
    g.fillStyle(0x161b23, 1);
    const rand = new Phaser.Math.RandomDataGenerator(['steel']);
    let x = 0;
    while (x < WIDTH) {
      const w = rand.between(24, 54);
      const h = rand.between(60, 170);
      g.fillRect(x, HEIGHT - 110 - h, w, h + 110);
      x += w + rand.between(0, 6);
    }
    g.fillStyle(0x1d232d, 1);
    g.fillRect(0, HEIGHT - 120, WIDTH, 120);
    for (let i = 0; i < 5; i++) {
      const lx = 30 + i * 75;
      this.add.image(lx, HEIGHT - 150, 'fx:glow').setScale(1.4).setAlpha(0.8);
      g.fillStyle(0x0d1015, 1);
      g.fillRect(lx - 1, HEIGHT - 150, 3, 50);
      g.fillStyle(COLORS.gas, 1);
      g.fillRect(lx - 3, HEIGHT - 156, 7, 7);
    }
  }

  drawFog() {
    this.fog = [];
    for (let i = 0; i < 7; i++) {
      const img = this.add.image(Phaser.Math.Between(-60, WIDTH + 60), 120 + i * 70, 'fx:fog')
        .setScale(3 + (i % 3)).setAlpha(0.35 + (i % 2) * 0.15);
      img.speed = 6 + (i % 4) * 4;
      this.fog.push(img);
    }
  }

  update(_t, delta) {
    if (TEST_MODE) return; // 測試模式關閉霧氣動畫
    for (const img of this.fog) {
      img.x += (img.speed * delta) / 1000;
      if (img.x - img.displayWidth / 2 > WIDTH) img.x = -img.displayWidth / 2;
    }
  }
}
