// 標題畫面：遊戲名稱、新遊戲、繼續（沒有可讀存檔時停用）、霧氣飄動。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, ButtonList } from '../ui/widgets.js';

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

    const hasSave = session.storage.listSlots().some((s) => s.ok && !s.empty);
    this.menu = new ButtonList(this, {
      x: WIDTH / 2, y: 380, w: 220, h: 52, gap: 14,
      items: [
        { label: '新遊戲', onSelect: () => this.scene.start('Name') },
        {
          label: '繼續', enabled: hasSave, onSelect: () => this.openLoad(),
          sub: hasSave ? null : (session.storageAvailable ? '目前沒有存檔' : '瀏覽器封鎖了儲存空間'),
        },
      ],
    });
    addText(this, WIDTH / 2, HEIGHT - 52, '方向鍵／WASD 移動　空白鍵 調查　E 殘響　Esc 選單', {
      fontSize: '11px', color: COLORS.textDisabled,
    }).setOrigin(0.5);
    addText(this, WIDTH / 2, HEIGHT - 30, '序章（開發中）', { fontSize: '11px', color: COLORS.textDisabled }).setOrigin(0.5);

    this.input.keyboard.on('keydown', (ev) => {
      if (!claimKey(ev)) return;
      this.menu.handleKey(ev.code);
    });
    this.events.on('resume', () => { session.scene = 'Title'; });
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
