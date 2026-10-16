// 對話框：說話者名牌、逐字顯示、選項按鈕。對話執行器（core/dialogue.js）由這裡驅動。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { session } from '../session.js';
import { startDialogue } from '../core/dialogue.js';
import { graphemes } from '../core/name.js';
import { addText, ButtonList } from './widgets.js';

const BOX = { x: 8, y: 462, w: WIDTH - 16, h: 170 };
const CHAR_MS = 28;

export class DialogueBox {
  constructor(scene) {
    this.scene = scene;
    this.runner = null;
    this.resolve = null;
    this.typing = false;
    this.chars = [];
    this.shown = 0;
    this.choiceList = null;

    // 對話中點擊畫面任何地方＝快轉／下一句（選項按鈕在它上面，會先收到點擊）
    this.catcher = scene.add.zone(0, 0, WIDTH, HEIGHT).setOrigin(0).setInteractive();
    this.catcher.on('pointerup', () => this.onConfirm());

    this.root = scene.add.container(0, 0);
    const g = scene.add.graphics();
    g.fillStyle(0x12161d, 0.96);
    g.fillRoundedRect(BOX.x, BOX.y, BOX.w, BOX.h, 8);
    g.lineStyle(2, COLORS.gas, 1);
    g.strokeRoundedRect(BOX.x, BOX.y, BOX.w, BOX.h, 8);
    g.lineStyle(1, COLORS.line, 1);
    g.strokeRoundedRect(BOX.x + 4, BOX.y + 4, BOX.w - 8, BOX.h - 8, 6);
    this.plate = scene.add.graphics();
    this.speaker = addText(scene, BOX.x + 20, BOX.y - 2, '', { fontSize: '15px', fontStyle: 'bold', color: '#1a1206' }).setOrigin(0, 0.5);
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

  /** 播放對話；回傳 Promise，對話結束時 resolve。 */
  play(dialogueId) {
    return new Promise((resolve) => {
      const dlg = session.dialogueById(dialogueId);
      if (!dlg) {
        console.error(`找不到對話「${dialogueId}」`);
        resolve();
        return;
      }
      let runner;
      try {
        runner = startDialogue(dlg, session.state);
      } catch (e) {
        console.error(e);
        this.scene.toast('對話資料有問題，已略過');
        resolve();
        return;
      }
      this.resolve = resolve;
      this.runner = runner;
      session.dialogueBusy = true;
      session.setState(runner.state);
      if (runner.done) { this.finish(); return; }
      this.setVisible(true);
      this.scene.onDialogueVisible(true);
      this.show();
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
      this.speaker.setText(node.speaker);
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
  }

  clearChoices() {
    this.choiceList?.destroy();
    this.choiceList = null;
  }

  /** 點擊或確認鍵：逐字中先快轉，否則下一句。 */
  onConfirm() {
    if (!this.runner) return;
    if (this.typing) { this.finishTyping(); return; }
    if (this.choiceList) return; // 選項節點要選一個，不能 advance()
    this.step(() => this.runner.advance());
  }

  choose(index) {
    if (!this.runner || this.typing) return;
    this.step(() => this.runner.choose(index));
  }

  step(fn) {
    try {
      fn();
    } catch (e) {
      console.error(e);
      this.scene.toast('對話資料有問題，已中止這段對話');
      this.finish();
      return;
    }
    session.setState(this.runner.state);
    if (this.runner.done) this.finish();
    else this.show();
  }

  finish() {
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
