// 對話框：說話者名牌、逐字顯示、選項按鈕。對話執行器（core/dialogue.js）由這裡驅動。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { session } from '../session.js';
import { startDialogue } from '../core/dialogue.js';
import { graphemes } from '../core/name.js';
import { addText, ButtonList, fitText } from './widgets.js';
import { promotionFxView } from './m5-view.js';

const BOX = { x: 8, y: 462, w: WIDTH - 16, h: 170 };
const CHAR_MS = 28;
/** 名牌文字最大寬度（超過以「…」截斷）。 */
export const NAMEPLATE_MAX = 220;
/** 圖層：點擊攔截層在對話框下面，選項按鈕在最上面（Phaser 的 topOnly 只把點擊交給最上層物件）。 */
const DEPTH = { catcher: 15, box: 20, choices: 25 };
const SPEAKER_STYLE = { fontSize: '15px', fontStyle: 'bold', color: '#1a1206' };

export class DialogueBox {
  constructor(scene) {
    this.scene = scene;
    this.runner = null;
    this.resolve = null;
    this.typing = false;
    this.chars = [];
    this.shown = 0;
    this.choiceList = null;

    // 對話中點擊畫面任何地方＝快轉／下一句。選項按鈕的 depth 比它高，點選項時只有選項收到；
    // 選項節點時點這裡不做任何事（要選一個選項）。
    this.catcher = scene.add.zone(0, 0, WIDTH, HEIGHT).setOrigin(0).setInteractive().setDepth(DEPTH.catcher);
    this.catcher.on('pointerup', () => this.onPointerConfirm());
    /** 最後一次「選了選項」的畫格：同一個輸入不可以再被當成「下一句」。 */
    this.choseFrame = -1;

    this.root = scene.add.container(0, 0).setDepth(DEPTH.box);
    const g = scene.add.graphics();
    g.fillStyle(0x12161d, 0.96);
    g.fillRoundedRect(BOX.x, BOX.y, BOX.w, BOX.h, 8);
    g.lineStyle(2, COLORS.gas, 1);
    g.strokeRoundedRect(BOX.x, BOX.y, BOX.w, BOX.h, 8);
    g.lineStyle(1, COLORS.line, 1);
    g.strokeRoundedRect(BOX.x + 4, BOX.y + 4, BOX.w - 8, BOX.h - 8, 6);
    this.plate = scene.add.graphics();
    this.speaker = addText(scene, BOX.x + 20, BOX.y - 2, '', SPEAKER_STYLE).setOrigin(0, 0.5);
    // 量寬度用（不顯示）：讓 E2E 與排版共用同一套截斷邏輯
    this.measure = addText(scene, -1000, -1000, '', SPEAKER_STYLE).setVisible(false);
    this.text = addText(scene, BOX.x + 16, BOX.y + 20, '', {
      fontSize: '17px', lineSpacing: 8, color: COLORS.text,
      wordWrap: { width: BOX.w - 32, useAdvancedWrap: true },
    });
    this.next = addText(scene, BOX.x + BOX.w - 22, BOX.y + BOX.h - 18, '▼', { fontSize: '13px', color: COLORS.textGas }).setOrigin(0.5);
    this.root.add([g, this.plate, this.speaker, this.text, this.next]);
    this.blink = scene.tweens.add({ targets: this.next, alpha: 0.2, duration: 450, yoyo: true, repeat: -1 });
    this.setVisible(false);
  }

  get active() { return this.runner !== null; }

  setVisible(v) {
    this.root.setVisible(v);
    this.catcher.input.enabled = v;
    this.catcher.setVisible(v);
  }

  /** 播放對話（id，或執行時產生的對話物件，例如「入夢」選項）；回傳 Promise，對話結束時 resolve。 */
  play(dialogueId) {
    return new Promise((resolve) => {
      const dlg = dialogueId !== null && typeof dialogueId === 'object' ? dialogueId : session.dialogueById(dialogueId);
      if (!dlg) {
        console.error(`找不到對話「${dialogueId}」`);
        resolve();
        return;
      }
      let runner;
      try {
        runner = startDialogue(dlg, session.state, session.data);
      } catch (e) {
        console.error(e);
        this.scene.toast('對話資料有問題，已略過');
        resolve();
        return;
      }
      const before = session.state;
      this.resolve = resolve;
      this.runner = runner;
      session.dialogueBusy = true;
      session.setState(runner.state);
      this.afterStep(before, true);
    });
  }

  /**
   * 執行器前進之後：對話中喝下靈劑（state.promotions 多了一筆）時，先暫停對話播晉升演出，關掉演出後才繼續。
   * first：對話第一個節點（對話框還沒顯示過）。
   */
  afterStep(before, first = false) {
    const fx = promotionFxView(before, this.runner.state, session.data);
    const go = () => {
      if (!this.runner) return;
      if (this.runner.done) { this.finish(); return; }
      if (first || !this.root.visible) { this.setVisible(true); this.scene.onDialogueVisible(true); }
      this.show();
    };
    if (!fx || typeof this.scene.promotionFx !== 'function') { go(); return; }
    this.pausedFx = true;
    this.clearChoices();
    this.setVisible(false);
    this.scene.promotionFx(fx).then(() => {
      this.pausedFx = false;
      first = true; // 演出後重新顯示對話框
      go();
    });
  }

  show() {
    const node = this.runner.current();
    session.dialogueView = {
      speaker: node.speaker ?? null,
      text: node.text ?? null,
      choices: node.choices ? node.choices.map((c) => c.text) : null,
    };
    // 名牌
    this.plate.clear();
    if (node.speaker) {
      fitText(this.speaker, node.speaker, NAMEPLATE_MAX);
      const w = Math.max(64, this.speaker.width + 28);
      this.plate.fillStyle(COLORS.gas, 1);
      this.plate.fillRoundedRect(BOX.x + 8, BOX.y - 15, w, 28, 6);
      this.speaker.setVisible(true);
    } else {
      this.speaker.setVisible(false);
    }
    // 文字
    this.chars = graphemes(node.text ?? '');
    this.clearChoices();
    if (TEST_MODE || this.chars.length === 0) {
      this.shown = this.chars.length;
      this.finishTyping();
    } else {
      this.shown = 0;
      this.text.setText('');
      this.typing = true;
      this.next.setVisible(false);
      this.typeTimer?.remove();
      this.typeTimer = this.scene.time.addEvent({
        delay: CHAR_MS, loop: true,
        callback: () => {
          this.shown += 1;
          this.text.setText(this.chars.slice(0, this.shown).join(''));
          if (this.shown >= this.chars.length) this.finishTyping();
        },
      });
    }
  }

  finishTyping() {
    this.typeTimer?.remove();
    this.typeTimer = null;
    this.typing = false;
    this.text.setText(this.chars.join(''));
    const node = this.runner.current();
    if (node.choices) {
      this.next.setVisible(false);
      this.showChoices(node.choices);
    } else {
      this.next.setVisible(true);
    }
  }

  showChoices(choices) {
    const h = 48;
    const gap = 8;
    const bottom = BOX.y - 26;
    const top = bottom - choices.length * h - (choices.length - 1) * gap;
    this.choiceList = new ButtonList(this.scene, {
      x: WIDTH / 2, y: top + h / 2, w: WIDTH - 40, h, gap, fontSize: 16,
      items: choices.map((c) => ({ label: c.text, onSelect: () => this.choose(c.index) })),
    });
    this.choiceList.buttons.forEach((b) => b.setDepth(DEPTH.choices));
  }

  /** 名牌排版結果（E2E 用）：{ text, width, max }。 */
  nameplateLayout(name) {
    const text = fitText(this.measure, name, NAMEPLATE_MAX);
    return { text, width: this.measure.width, max: NAMEPLATE_MAX };
  }

  /** 目前選項按鈕的位置（邏輯座標，左上角＋寬高）。 */
  choiceRects() {
    return (this.choiceList?.buttons ?? []).map((b) => ({ label: b.label.text, x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h }));
  }

  clearChoices() {
    this.choiceList?.destroy();
    this.choiceList = null;
  }

  /** 點擊攔截層：同一畫格剛選過選項（同一次點擊）就忽略。 */
  onPointerConfirm() {
    if (this.pausedFx) return;
    if (this.scene.game.loop.frame === this.choseFrame) return;
    this.onConfirm();
  }

  /** 點擊或確認鍵：逐字中先快轉，否則下一句。 */
  onConfirm() {
    if (!this.runner || this.pausedFx) return;
    if (this.typing) { this.finishTyping(); return; }
    if (this.choiceList) return; // 選項節點要選一個，不能 advance()
    this.step(() => this.runner.advance());
  }

  choose(index) {
    if (!this.runner || this.pausedFx || this.typing || !this.choiceList) return;
    if (this.scene.game.loop.frame === this.choseFrame) return; // 同一次輸入不選兩次
    this.choseFrame = this.scene.game.loop.frame;
    this.step(() => this.runner.choose(index));
  }

  step(fn) {
    const before = this.runner.state;
    try {
      fn();
    } catch (e) {
      console.error(e);
      this.scene.toast('對話資料有問題，已中止這段對話');
      this.finish();
      return;
    }
    session.setState(this.runner.state);
    this.afterStep(before);
  }

  finish() {
    this.pausedFx = false;
    this.typeTimer?.remove();
    this.typeTimer = null;
    this.typing = false;
    this.clearChoices();
    if (this.runner) session.setState(this.runner.state);
    this.runner = null;
    session.dialogueView = null;
    session.dialogueBusy = false;
    this.setVisible(false);
    this.scene.onDialogueVisible(false);
    const r = this.resolve;
    this.resolve = null;
    r?.();
  }

  /** 鍵盤：回傳是否處理。 */
  handleKey(code) {
    if (!this.runner) return false;
    if (this.pausedFx) return true; // 晉升演出中：按鍵交給演出（UIScene 先處理）
    if (this.choiceList && !this.typing) {
      if (/^Digit[1-9]$/.test(code)) {
        const i = Number(code.slice(5)) - 1;
        if (i < this.choiceList.buttons.length) this.choiceList.buttons[i].activate();
        return true;
      }
      return this.choiceList.handleKey(code);
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter' || code === 'KeyZ') {
      this.onConfirm();
      return true;
    }
    return false;
  }
}
