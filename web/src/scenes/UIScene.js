// UI 場景（疊在 Map 上方）：HUD、對話框、觸控按鈕、提示訊息，以及鍵盤動作的統一分派。
import { WIDTH, HUD_H, PANEL_Y, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, Button } from '../ui/widgets.js';
import { DialogueBox } from '../ui/DialogueBox.js';
import { COLLAPSE_MAX } from '../core/echo.js';
import { echoAvailable } from '../core/interact.js';
import { echoHud, collapseHud, ammoHud, resonanceHud, partyHud } from '../ui/hud.js';
import { partyStatus } from '../core/stats.js';
import { isDreamMap } from '../core/dream.js';
import { playBell } from '../ui/bell.js';

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
    this.toastText = addText(this, WIDTH / 2, HUD_H + 8, '', {
      fontSize: '15px', color: '#ffe2b0', backgroundColor: '#1a1f28ee', padding: { x: 14, y: 8 },
      align: 'center', wordWrap: { width: WIDTH - 60, useAdvancedWrap: true },
    }).setOrigin(0.5, 0).setDepth(40).setVisible(false);

    this.input.keyboard.on('keydown', (ev) => this.onKey(ev));
    const onState = () => this.refreshHud();
    session.events.on('state', onState);
    this.events.once('shutdown', () => session.events.off('state', onState));
    this.refreshHud();
  }

  get map() { return this.scene.get('Map'); }

  // ---------- HUD ----------
  // 第一列：地圖名稱｜殘響（或「回溯 ∞」）；第二列：子彈、共鳴｜崩解；第三列：隊伍生命（精簡）。
  buildHud() {
    const g = this.add.graphics().setDepth(10);
    g.fillStyle(0x0d1015, 0.92);
    g.fillRect(0, 0, WIDTH, HUD_H);
    g.lineStyle(1, COLORS.gasDeep, 1);
    g.lineBetween(0, HUD_H - 0.5, WIDTH, HUD_H - 0.5);
    this.mapName = addText(this, 10, 12, '', { fontSize: '14px', color: '#f0d2a0' }).setOrigin(0, 0.5).setDepth(11);
    // 夢境中：地圖名稱旁的標籤
    this.dreamTag = addText(this, 0, 12, '夢境中', {
      fontSize: '11px', color: '#dfe8ff', backgroundColor: '#34477a', padding: { x: 5, y: 2 },
    }).setOrigin(0, 0.5).setDepth(11).setVisible(false);
    this.echoText = addText(this, WIDTH - 10, 12, '', { fontSize: '13px', color: COLORS.text }).setOrigin(1, 0.5).setDepth(11);
    this.infoText = addText(this, 10, 31, '', { fontSize: '12px', color: COLORS.textDim }).setOrigin(0, 0.5).setDepth(11);
    this.collapseText = addText(this, WIDTH - 10, 31, '', { fontSize: '11px', color: COLORS.textDim }).setOrigin(1, 0.5).setDepth(11);
    this.collapseBar = this.add.graphics().setDepth(11);
    this.partyBars = this.add.graphics().setDepth(11);
    this.partyTexts = [0, 1, 2].map((i) => addText(this, 10 + i * 118, 50, '', { fontSize: '11px', color: COLORS.text }).setOrigin(0, 0.5).setDepth(11));
  }

  refreshHud() {
    const s = session.state;
    if (!s) return;
    this.mapName.setText(session.mapName(s.location?.map));
    this.inDream = isDreamMap(session.mapById(s.location?.map));
    this.mapName.setColor(this.inDream ? '#c8d8ff' : '#f0d2a0');
    // 殘響：依 core 的 echoAvailable（譜系提供 trace 時免費）；數值異常時由 echoHud 防呆
    let view;
    try {
      view = echoAvailable(s, session.data);
    } catch (e) {
      console.warn('echoAvailable 失敗，HUD 改用 state 數值', e);
      view = { free: false, charges: s.echo?.charges };
    }
    this.echoView = echoHud({ free: view?.free, charges: view?.charges, max: session.data?.manifest?.start?.echo_charges ?? 0 });
    this.echoText.setText(this.echoView.text);
    const col = collapseHud(s.collapse, COLLAPSE_MAX);
    this.collapseText.setText(col.text);
    // 崩解條：放在文字左邊
    const bw = 64;
    const bx = WIDTH - 10 - this.collapseText.width - 6 - bw;
    const by = 27;
    const g = this.collapseBar;
    g.clear();
    g.fillStyle(0x222832, 1);
    g.fillRect(bx, by, bw, 8);
    g.fillStyle(col.danger ? COLORS.danger : COLORS.gas, 1);
    g.fillRect(bx + 1, by + 1, Math.round((bw - 2) * col.ratio), 6);
    g.lineStyle(1, COLORS.line, 1);
    g.strokeRect(bx, by, bw, 8);
    // 子彈與共鳴度（主角的譜系有 show_resonance 時才顯示共鳴度）
    const ammo = ammoHud(s.ammo, { hasGun: (s.items?.revolver ?? 0) > 0 });
    const lineageDef = (session.data?.lineages ?? []).find((l) => l?.id === s.lineage?.id);
    const reso = lineageDef?.show_resonance === true ? resonanceHud(s.resonance) : null;
    this.hudInfo = { ammo: ammo.show ? ammo.text : null, resonance: reso ? reso.text : null };
    this.infoText.setText([this.hudInfo.ammo, this.hudInfo.resonance].filter(Boolean).join('　'));
    // 隊伍生命
    let party = [];
    try {
      party = (session.data?.characters ?? []).length ? partyHud(partyStatus(s, session.data)) : [];
    } catch (e) {
      console.warn('partyStatus 失敗，HUD 不顯示隊伍', e);
    }
    this.partyView = party;
    const pg = this.partyBars;
    pg.clear();
    this.partyTexts.forEach((t, i) => {
      const m = party[i];
      t.setText(m ? m.text : '');
      if (!m) return;
      const x = 10 + i * 118;
      const w = 108;
      pg.fillStyle(0x222832, 1).fillRect(x, 57, w, 3);
      pg.fillStyle(m.ratio > 0.35 ? 0x6fa86a : COLORS.danger, 1).fillRect(x, 57, Math.round(w * m.ratio), 3);
    });
    // 地圖名稱太長時避免壓到右邊
    const tagW = this.inDream ? this.dreamTag.width + 6 : 0;
    const room = WIDTH - 10 - this.echoText.width - 16 - 10 - tagW;
    this.mapName.setScale(this.mapName.width > room ? room / this.mapName.width : 1);
    this.dreamTag.setVisible(this.inDream).setX(10 + this.mapName.displayWidth + 6);
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

  /** E2E 用的 HUD 唯讀資訊。 */
  debugInfo() {
    return {
      echo: this.echoText.text,
      echoFilled: this.echoView?.filled ?? 0,
      collapse: this.collapseText.text,
      ammo: this.hudInfo?.ammo ?? null,
      resonance: this.hudInfo?.resonance ?? null,
      party: (this.partyView ?? []).map((m) => m.text),
      toast: this.toastText.visible ? this.toastText.text : null,
      map: this.mapName.text,
      dream: this.dreamTag.visible ? this.dreamTag.text : null,
      veil: this.veil?.visible ? this.veil.alpha : 0,
    };
  }

  // ---------- 入夢與醒來的過場 ----------
  /**
   * cover true：霧色淡入蓋住畫面、鐘聲與擴散的鐘聲波紋；false：霧淡出。回傳 Promise（動畫結束）。
   * 測試模式時間縮短、不出聲。
   */
  dreamVeil(cover) {
    if (!this.veil) {
      this.veil = this.add.rectangle(0, 0, WIDTH, HEIGHT, 0xaab6c6, 1).setOrigin(0).setDepth(60).setAlpha(0).setVisible(false);
      this.veilFog = this.add.image(WIDTH / 2, HEIGHT / 2, 'fx:fog').setScale(4, 8).setDepth(61).setAlpha(0).setVisible(false);
      this.bellText = addText(this, WIDTH / 2, HEIGHT / 2, '——噹。', { fontSize: '22px', color: '#2a3550', fontStyle: 'bold' })
        .setOrigin(0.5).setDepth(62).setAlpha(0).setVisible(false);
    }
    const d = TEST_MODE ? 60 : (cover ? 700 : 900);
    const targets = [this.veil, this.veilFog];
    this.tweens.killTweensOf([...targets, this.bellText]);
    for (const t of [...targets, this.bellText]) t.setVisible(true);
    if (cover) {
      playBell({ muted: TEST_MODE });
      for (let i = 0; i < 3; i++) {
        const ring = this.add.circle(WIDTH / 2, HEIGHT / 2, 20, 0x000000, 0).setStrokeStyle(2, 0x6f86b8, 0.9).setDepth(63);
        this.tweens.add({ targets: ring, radius: 260, alpha: 0, delay: TEST_MODE ? 0 : i * 260, duration: TEST_MODE ? 60 : 1100, onComplete: () => ring.destroy() });
      }
      this.tweens.add({ targets: this.bellText, alpha: { from: 0, to: 1 }, duration: d });
    } else {
      this.tweens.add({ targets: this.bellText, alpha: 0, duration: d / 2 });
    }
    return new Promise((res) => {
      this.tweens.add({
        targets, alpha: cover ? 1 : 0, duration: d, ease: 'Sine.easeInOut',
        onComplete: () => {
          if (!cover) for (const t of [...targets, this.bellText]) t.setVisible(false);
          res();
        },
      });
    });
  }

  // ---------- 提示 ----------
  toast(msg, ms = 1600) {
    this.toastText.setText(msg).setVisible(true).setAlpha(1);
    this.toastTween?.remove();
    this.toastTimer?.remove();
    this.toastTimer = this.time.delayedCall(ms, () => {
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
