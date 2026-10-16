// 輸入主角名字：DOM <input> 覆蓋在畫布上，即時顯示 sanitizeName 後的結果與字數。
import { WIDTH, COLORS } from '../config.js';
import { session } from '../session.js';
import { addText, Button } from '../ui/widgets.js';
import { DEFAULT_NAME, MAX_NAME_LENGTH, sanitizeName, nameLength } from '../core/name.js';
import { newGame } from '../core/state.js';
import { enterMap } from '../core/grid.js';

export class NameScene extends Phaser.Scene {
  constructor() { super('Name'); }

  create() {
    session.scene = 'Name';
    this.confirmed = false;
    this.cameras.main.setBackgroundColor(COLORS.bg);
    // 輸入框聚焦時不能讓 Phaser 吃掉空白鍵、WASD 等按鍵
    this.input.keyboard.disableGlobalCapture();
    this.events.once('shutdown', () => this.input.keyboard.enableGlobalCapture());

    addText(this, WIDTH / 2, 120, '你的名字是？', { fontSize: '24px', fontStyle: 'bold', color: '#f0d2a0' }).setOrigin(0.5);
    addText(this, WIDTH / 2, 160, `最多 ${MAX_NAME_LENGTH} 個字，不能使用 < > 等符號`, {
      fontSize: '13px', color: COLORS.textDim,
    }).setOrigin(0.5);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sl-name-input';
    input.maxLength = 32; // 允許貼上後由 sanitizeName 截到 8 個字；字數以 grapheme 計
    input.value = DEFAULT_NAME;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '主角名字');
    input.setAttribute('enterkeyhint', 'done');
    this.inputEl = input;
    this.dom = this.add.dom(WIDTH / 2, 230, input);

    addText(this, WIDTH / 2, 290, '遊戲中顯示為', { fontSize: '13px', color: COLORS.textDim }).setOrigin(0.5);
    this.preview = addText(this, WIDTH / 2, 320, '', { fontSize: '22px', color: '#ffe2b0' }).setOrigin(0.5);
    this.count = addText(this, WIDTH / 2, 352, '', { fontSize: '13px', color: COLORS.textDim }).setOrigin(0.5);

    this.ok = new Button(this, WIDTH / 2, 430, 220, 52, '確定', { onClick: () => this.confirm() });
    this.back = new Button(this, WIDTH / 2, 496, 220, 48, '返回標題', { onClick: () => this.scene.start('Title') });

    const refresh = () => this.refresh();
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); this.scene.start('Title'); }
    });
    this.refresh();
    // 桌機自動聚焦並全選；觸控裝置不自動跳出鍵盤
    if (!this.sys.game.device.input.touch) {
      setTimeout(() => { input.focus(); input.select(); }, 50);
    }
  }

  refresh() {
    const raw = this.inputEl.value;
    const name = sanitizeName(raw);
    this.preview.setText(name);
    const rawLen = nameLength(raw.trim());
    const over = rawLen > MAX_NAME_LENGTH;
    const empty = raw.trim() === '';
    let note = `${nameLength(name)} / ${MAX_NAME_LENGTH} 字`;
    if (empty) note += '（空白時使用預設名字）';
    else if (over) note += '（超過的部分會被省略）';
    this.count.setText(note).setColor(over ? '#f0a848' : COLORS.textDim);
  }

  confirm() {
    if (this.confirmed) return;
    this.confirmed = true;
    const { manifest, maps } = session.data;
    const name = sanitizeName(this.inputEl.value);
    let state = newGame({ name, manifest, maps });
    // 新遊戲：先播 start.dialogue，再處理起始地圖的 on_enter（enterMap 只會回傳一次）
    const entered = enterMap(state, session.data, manifest.start.map, manifest.start.spawn);
    state = entered.state;
    session.reset();
    session.setState(state);
    const intro = [...new Set([manifest.start.dialogue, entered.dialogue].filter((d) => typeof d === 'string'))];
    this.inputEl.blur();
    this.scene.start('Map', { intro });
  }
}
