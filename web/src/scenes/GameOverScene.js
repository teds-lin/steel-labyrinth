// Game Over：戰敗或失控。「重新挑戰」＝戰前狀態經 core 的 prepareRetry（全隊生命靈性回滿、崩解 ≤ 60）後重打同一場；
// 「回標題」結束這次遊戲。地圖與 UI 場景在戰鬥期間是睡眠狀態，重新挑戰時維持睡眠，回標題時一併停止。
import { WIDTH, COLORS, TEST_MODE, battleSeed } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, ButtonList } from '../ui/widgets.js';
import { sanitizeLoadedState } from '../core/save.js';
import { prepareRetry } from '../core/battle/engine.js';

const TEXTS = {
  defeat: { title: '戰敗', body: '隊伍全滅了。\n霧氣慢慢掩蓋了倒下的身影……' },
  lost_control: { title: '失控', body: '崩解到達了極限。\n腦中的聲音蓋過了你自己的聲音……' },
};
const NO_RETRY = '無法重新挑戰，請讀取存檔';

export class GameOverScene extends Phaser.Scene {
  constructor() { super('GameOver'); }

  init(data) {
    this.outcome = data?.outcome === 'lost_control' ? 'lost_control' : 'defeat';
    this.encounterId = typeof data?.encounter === 'string' ? data.encounter : null;
  }

  create() {
    session.scene = 'GameOver';
    // 已選擇旗標：同一幀連按（Enter、↓、Enter）或連點時只採用第一次選擇
    this.chosen = false;
    this.cameras.main.setBackgroundColor(0x07090c);
    const t = TEXTS[this.outcome];
    this.texts = t;
    this.title = addText(this, WIDTH / 2, 200, t.title, { fontSize: '40px', fontStyle: 'bold', color: this.outcome === 'lost_control' ? '#d080d0' : '#e07a5a' }).setOrigin(0.5);
    addText(this, WIDTH / 2, 268, t.body, { fontSize: '15px', color: COLORS.textDim, align: 'center', lineSpacing: 6 }).setOrigin(0.5);
    this.note = addText(this, WIDTH / 2, 340, '', { fontSize: '13px', color: '#ffe2b0', align: 'center', wordWrap: { width: WIDTH - 48, useAdvancedWrap: true } }).setOrigin(0.5);
    this.list = new ButtonList(this, {
      x: WIDTH / 2, y: 410, w: 240, h: 54, gap: 14,
      items: [
        { label: '重新挑戰', sub: '全隊恢復後重新挑戰', onSelect: () => this.choose(() => this.retry()) },
        { label: '回標題', onSelect: () => this.choose(() => this.toTitle()) },
      ],
    });
    this.input.keyboard.on('keydown', (ev) => {
      if (ev.repeat || !claimKey(ev)) return;
      if (this.chosen) return;
      this.list.handleKey(ev.code);
    });
    this.cameras.main.fadeIn(TEST_MODE ? 0 : 500, 0, 0, 0);
  }

  choose(fn) {
    if (this.chosen) return;
    this.chosen = true;
    this.list.buttons.forEach((b) => b.setEnabled(false));
    fn();
  }

  /**
   * 戰前狀態：記憶體備份（session.preBattle）優先；沒有時（例如重新整理後）才讀自動存檔，
   * 而且自動存檔的 auto_battle 必須是存在的遭遇、並與這場戰鬥一致，否則回 null。
   */
  preBattle() {
    const want = this.encounterId;
    const known = (id) => typeof id === 'string' && (session.data?.encounters ?? []).some((e) => e?.id === id);
    const mem = session.preBattle;
    if (mem && mem.state && known(mem.encounter) && (want === null || mem.encounter === want)) {
      return { state: mem.state, encounter: mem.encounter };
    }
    const r = session.storage.loadAuto();
    if (!r.ok) {
      if (r.code !== 'empty' && r.code !== 'unavailable') console.warn(`讀取自動存檔失敗（${r.code}）：${r.reason}`);
      return null;
    }
    if (!known(r.battle) || (want !== null && r.battle !== want)) {
      console.warn(`自動存檔的戰鬥「${r.battle}」與這場戰鬥「${want}」不一致，不使用`);
      return null;
    }
    const s = sanitizeLoadedState(r.state, session.data);
    if (!s.ok) {
      console.warn(`自動存檔內容有誤（${s.code}）：${s.reason}`);
      return null;
    }
    return { state: s.state, encounter: r.battle };
  }

  retry() {
    const pre = this.preBattle();
    let next = null;
    if (pre) {
      try {
        next = prepareRetry(pre.state, session.data);
      } catch (e) {
        console.warn('無法準備重新挑戰', e);
      }
    }
    if (!next) {
      this.note.setText(NO_RETRY);
      this.time.delayedCall(TEST_MODE ? 400 : 1800, () => this.toTitle());
      return;
    }
    // 備份保留「戰前」狀態（不是回滿後的），之後再輸還是從同一個戰前狀態計算
    session.preBattle = { state: pre.state, encounter: pre.encounter };
    session.setState(next);
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
      chosen: this.chosen,
      items: this.list.buttons.map((b) => ({ label: b.label.text, sub: b.sub?.text ?? null, enabled: b.enabled, x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h })),
    };
  }
}
