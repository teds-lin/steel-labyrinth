// Game Over：戰敗或失控。「重新挑戰」回到戰前自動存檔重打同一場戰鬥；「回標題」結束這次遊戲。
// 地圖與 UI 場景在戰鬥期間是睡眠狀態，重新挑戰時維持睡眠，回標題時一併停止。
import { WIDTH, HEIGHT, COLORS, TEST_MODE, battleSeed } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, ButtonList } from '../ui/widgets.js';
import { sanitizeLoadedState } from '../core/save.js';

const TEXTS = {
  defeat: { title: '戰敗', body: '隊伍全滅了。\n霧氣慢慢掩蓋了倒下的身影……' },
  lost_control: { title: '失控', body: '崩解到達了極限。\n腦中的聲音蓋過了你自己的聲音……' },
};

export class GameOverScene extends Phaser.Scene {
  constructor() { super('GameOver'); }

  init(data) {
    this.outcome = data?.outcome === 'lost_control' ? 'lost_control' : 'defeat';
    this.encounterId = data?.encounter ?? null;
  }

  create() {
    session.scene = 'GameOver';
    this.cameras.main.setBackgroundColor(0x07090c);
    const t = TEXTS[this.outcome];
    this.texts = t;
    this.title = addText(this, WIDTH / 2, 200, t.title, { fontSize: '40px', fontStyle: 'bold', color: this.outcome === 'lost_control' ? '#d080d0' : '#e07a5a' }).setOrigin(0.5);
    addText(this, WIDTH / 2, 268, t.body, { fontSize: '15px', color: COLORS.textDim, align: 'center', lineSpacing: 6 }).setOrigin(0.5);
    this.note = addText(this, WIDTH / 2, 340, '', { fontSize: '13px', color: '#ffe2b0', align: 'center', wordWrap: { width: WIDTH - 48, useAdvancedWrap: true } }).setOrigin(0.5);
    this.list = new ButtonList(this, {
      x: WIDTH / 2, y: 410, w: 240, h: 54, gap: 14,
      items: [
        { label: '重新挑戰', sub: '回到這場戰鬥開始之前', onSelect: () => this.retry() },
        { label: '回標題', onSelect: () => this.toTitle() },
      ],
    });
    this.input.keyboard.on('keydown', (ev) => {
      if (ev.repeat || !claimKey(ev)) return;
      this.list.handleKey(ev.code);
    });
    this.cameras.main.fadeIn(TEST_MODE ? 0 : 500, 0, 0, 0);
  }

  /** 戰前狀態：優先用自動存檔（loadAuto → sanitizeLoadedState），儲存空間不能用時退回記憶體裡的備份。 */
  preBattle() {
    const r = session.storage.loadAuto();
    if (r.ok && typeof r.battle === 'string') {
      const s = sanitizeLoadedState(r.state, session.data);
      if (s.ok) return { state: s.state, encounter: r.battle };
      console.warn('自動存檔內容有誤，改用記憶體中的戰前狀態', s.code, s.reason);
    } else if (!r.ok && r.code !== 'empty' && r.code !== 'unavailable') {
      console.warn('讀取自動存檔失敗，改用記憶體中的戰前狀態', r.code, r.reason);
    }
    const mem = session.preBattle;
    if (mem && typeof mem.encounter === 'string') return { state: mem.state, encounter: mem.encounter };
    return null;
  }

  retry() {
    const pre = this.preBattle();
    if (!pre) {
      this.note.setText('找不到戰前的自動存檔，只能回到標題畫面');
      this.list.buttons[0].setEnabled(false);
      this.list.focus(1);
      return;
    }
    session.setState(pre.state);
    session.preBattle = { state: pre.state, encounter: pre.encounter };
    this.scene.start('Battle', { encounter: pre.encounter, seed: battleSeed() });
  }

  toTitle() {
    session.battleReturn = null;
    session.preBattle = null;
    this.scene.stop('UI');
    this.scene.stop('Map');
    this.scene.start('Title');
  }

  /** E2E 用的唯讀資訊。 */
  debugInfo() {
    return {
      outcome: this.outcome,
      title: this.title.text,
      note: this.note.text,
      items: this.list.buttons.map((b) => ({ label: b.label.text, enabled: b.enabled, x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h })),
    };
  }
}
