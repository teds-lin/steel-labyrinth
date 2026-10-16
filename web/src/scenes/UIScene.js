// UI 場景（疊在 Map 上方）：HUD、對話框、觸控按鈕、提示訊息，以及鍵盤動作的統一分派。
import { WIDTH, HUD_H, PANEL_Y, HEIGHT, COLORS } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, Button } from '../ui/widgets.js';
import { DialogueBox } from '../ui/DialogueBox.js';
import { DEFAULT_ECHO_CHARGES } from '../core/state.js';
import { COLLAPSE_MAX } from '../core/echo.js';

const DIR_KEYS = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};

export class UIScene extends Phaser.Scene {
  constructor() { super('UI'); }

  create() {
    this.buildHud();
    this.buildPanel();
    this.dialogue = new DialogueBox(this);
    this.dialogue.root.setDepth(20);
    this.dialogue.catcher.setDepth(15);
    this.toastText = addText(this, WIDTH / 2, HUD_H + 26, '', {
      fontSize: '15px', color: '#ffe2b0', backgroundColor: '#1a1f28ee', padding: { x: 14, y: 8 },
    }).setOrigin(0.5).setDepth(40).setVisible(false);

    this.input.keyboard.on('keydown', (ev) => this.onKey(ev));
    const onState = () => this.refreshHud();
    session.events.on('state', onState);
    this.events.once('shutdown', () => session.events.off('state', onState));
    this.refreshHud();
  }

  get map() { return this.scene.get('Map'); }

  // ---------- HUD ----------
  buildHud() {
    const g = this.add.graphics().setDepth(10);
    g.fillStyle(0x0d1015, 0.92);
    g.fillRect(0, 0, WIDTH, HUD_H);
    g.lineStyle(1, COLORS.gasDeep, 1);
    g.lineBetween(0, HUD_H - 0.5, WIDTH, HUD_H - 0.5);
    this.mapName = addText(this, 10, HUD_H / 2, '', { fontSize: '14px', color: '#f0d2a0' }).setOrigin(0, 0.5).setDepth(11);
    this.echoText = addText(this, WIDTH - 10, 12, '', { fontSize: '13px', color: COLORS.text }).setOrigin(1, 0.5).setDepth(11);
    this.collapseText = addText(this, WIDTH - 10, 31, '', { fontSize: '11px', color: COLORS.textDim }).setOrigin(1, 0.5).setDepth(11);
    this.collapseBar = this.add.graphics().setDepth(11);
  }

  refreshHud() {
    const s = session.state;
    if (!s) return;
    this.mapName.setText(session.mapName(s.location.map));
    const n = s.echo?.charges ?? 0;
    const max = Math.max(DEFAULT_ECHO_CHARGES, n);
    this.echoText.setText(`殘響 ${'●'.repeat(n)}${'○'.repeat(max - n)}`);
    const c = s.collapse ?? 0;
    this.collapseText.setText(`崩解 ${c}/${COLLAPSE_MAX}`);
    // 崩解條：放在文字左邊
    const bw = 64;
    const bx = WIDTH - 10 - this.collapseText.width - 6 - bw;
    const by = 27;
    const g = this.collapseBar;
    g.clear();
    g.fillStyle(0x222832, 1);
    g.fillRect(bx, by, bw, 8);
    g.fillStyle(c >= 60 ? COLORS.danger : COLORS.gas, 1);
    g.fillRect(bx + 1, by + 1, Math.round(((bw - 2) * c) / COLLAPSE_MAX), 6);
    g.lineStyle(1, COLORS.line, 1);
    g.strokeRect(bx, by, bw, 8);
    // 地圖名稱太長時避免壓到右邊
    const room = bx - 16;
    this.mapName.setScale(this.mapName.width > room ? room / this.mapName.width : 1);
  }

  // ---------- 觸控操作區 ----------
  buildPanel() {
    this.panel = this.add.container(0, 0).setDepth(5);
    const g = this.add.graphics();
    g.fillStyle(0x0d1015, 0.88);
    g.fillRect(0, PANEL_Y, WIDTH, HEIGHT - PANEL_Y);
    g.lineStyle(1, COLORS.line, 1);
    g.lineBetween(0, PANEL_Y + 0.5, WIDTH, PANEL_Y + 0.5);
    this.panel.add(g);

    const cx = 92;
    const cy = 552;
    const d = 54;
    const size = 50;
    const pads = [['up', '▲', cx, cy - d], ['down', '▼', cx, cy + d], ['left', '◀', cx - d, cy], ['right', '▶', cx + d, cy]];
    this.heldDir = null;
    for (const [dir, label, x, y] of pads) {
      const b = new Button(this, x, y, size, size, label, { fontSize: 18 });
      b.hit.on('pointerdown', () => { this.heldDir = dir; this.map?.queueDir(dir); });
      const release = () => { if (this.heldDir === dir) this.heldDir = null; };
      b.hit.on('pointerup', release);
      b.hit.on('pointerout', release);
      this.panel.add(b);
    }
    this.input.on('pointerup', () => { this.heldDir = null; });

    const rx = 276;
    const btns = [
      ['調查', 'investigate', 498],
      ['殘響', 'echo', 552],
      ['選單', 'menu', 606],
    ];
    for (const [label, action, y] of btns) {
      const b = new Button(this, rx, y, 140, 48, label, { fontSize: 17, onClick: () => this.action(action) });
      this.panel.add(b);
    }
  }

  onDialogueVisible(v) {
    this.panel.setVisible(!v);
    this.heldDir = null;
  }

  // ---------- 提示 ----------
  toast(msg) {
    this.toastText.setText(msg).setVisible(true).setAlpha(1);
    this.toastTween?.remove();
    this.toastTimer?.remove();
    this.toastTimer = this.time.delayedCall(1600, () => {
      this.toastTween = this.tweens.add({ targets: this.toastText, alpha: 0, duration: 300, onComplete: () => this.toastText.setVisible(false) });
    });
  }

  // ---------- 輸入分派 ----------
  action(name) {
    if (this.dialogue.active) return;
    this.map?.onAction(name);
  }

  onKey(ev) {
    if (ev.repeat && !DIR_KEYS[ev.code]) return;
    if (this.dialogue.active) {
      if (claimKey(ev) && !this.dialogue.handleKey(ev.code)) { /* 對話中其他按鍵忽略 */ }
      return;
    }
    const dir = DIR_KEYS[ev.code];
    if (dir) { this.map?.queueDir(dir); return; }
    if (ev.code === 'Space' || ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.code === 'KeyZ') {
      if (claimKey(ev)) this.action('investigate');
    } else if (ev.code === 'KeyE' || ev.code === 'KeyX') {
      if (claimKey(ev)) this.action('echo');
    } else if (ev.code === 'Escape' || ev.code === 'KeyM') {
      if (claimKey(ev)) this.action('menu');
    }
  }
}
