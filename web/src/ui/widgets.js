// 共用介面元件：文字、按鈕、可用鍵盤操作的按鈕清單。
// 所有字串一律經 Phaser Text 的 setText 顯示（不經過 HTML）。
import { FONT, COLORS, TEXT_RESOLUTION } from '../config.js';
import { graphemes } from '../core/name.js';

export const ELLIPSIS = '…';

/**
 * 把 render(part) 的結果放進 textObj，寬度超過 maxW 時從 part 尾端一個字（grapheme）一個字砍，
 * 補上「…」，直到放得下。只改顯示，不改資料。回傳最後顯示的字串。
 * part 連一個字都放不下時顯示 render('…')。
 */
export function fitPart(textObj, part, render, maxW) {
  const str = String(part ?? '');
  textObj.setText(render(str));
  if (textObj.width <= maxW) return textObj.text;
  const g = graphemes(str);
  // 二分搜尋可以保留的字數
  let lo = 0;
  let hi = g.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    textObj.setText(render(g.slice(0, mid).join('') + ELLIPSIS));
    if (textObj.width <= maxW) lo = mid; else hi = mid - 1;
  }
  textObj.setText(render(g.slice(0, lo).join('') + ELLIPSIS));
  return textObj.text;
}

/** 整段文字超出 maxW 時以「…」截斷。 */
export function fitText(textObj, str, maxW) {
  return fitPart(textObj, str, (x) => x, maxW);
}

/**
 * 建立文字。pixelArt 模式下 Phaser 每次重畫文字都會把貼圖設回 NEAREST，
 * 中文字會鋸齒化，所以包一層：每次 updateText 後改回 LINEAR。
 */
export function addText(scene, x, y, str, style = {}) {
  const t = scene.add.text(x, y, str, {
    fontFamily: FONT,
    fontSize: '16px',
    color: COLORS.text,
    resolution: TEXT_RESOLUTION,
    ...style,
  });
  const linear = () => {
    try { t.texture?.setFilter?.(Phaser.Textures.FilterMode.LINEAR); } catch { /* Canvas 模式不需要 */ }
  };
  const orig = t.updateText;
  t.updateText = function patchedUpdateText(...args) {
    const r = orig.apply(this, args);
    linear();
    return r;
  };
  linear();
  return t;
}

/** 按鈕：圓角底板＋文字（可有第二行小字）。onClick 在放開時觸發。 */
export class Button extends Phaser.GameObjects.Container {
  constructor(scene, x, y, w, h, label, { onClick, sub = null, fontSize = 17, align = 'center' } = {}) {
    super(scene, x, y);
    this.w = w;
    this.h = h;
    this.onClick = onClick;
    this.enabled = true;
    this.focused = false;
    this.pressed = false;
    this.align = align;
    this.bg = scene.add.graphics();
    this.hit = scene.add.rectangle(0, 0, w, h, 0x000000, 0).setInteractive({ useHandCursor: true });
    const tx = align === 'left' ? -w / 2 + 14 : 0;
    const ox = align === 'left' ? 0 : 0.5;
    this.label = addText(scene, tx, sub ? -9 : 0, label, { fontSize: `${fontSize}px` }).setOrigin(ox, 0.5);
    this.sub = sub !== null
      ? addText(scene, tx, 12, sub, { fontSize: '12px', color: COLORS.textDim }).setOrigin(ox, 0.5)
      : null;
    this.add([this.bg, this.hit, this.label]);
    if (this.sub) this.add(this.sub);
    this.fit();

    this.hit.on('pointerover', () => this.emit('hover', this));
    this.hit.on('pointerdown', () => { if (this.enabled) { this.pressed = true; this.redraw(); } });
    this.hit.on('pointerout', () => { this.pressed = false; this.redraw(); });
    this.hit.on('pointerup', () => {
      const was = this.pressed;
      this.pressed = false;
      this.redraw();
      if (was && this.enabled) this.activate();
    });
    this.redraw();
    scene.add.existing(this);
  }

  activate() {
    if (this.enabled && typeof this.onClick === 'function') this.onClick(this);
  }

  setLabel(text, sub) {
    this.label.setText(text);
    if (this.sub && sub !== undefined) this.sub.setText(sub);
    this.fit();
    return this;
  }

  /** 文字太長時等比縮小，避免超出按鈕。 */
  fit() {
    const room = this.w - 24;
    for (const t of [this.label, this.sub]) {
      if (!t) continue;
      t.setScale(1);
      if (t.width > room) t.setScale(room / t.width);
    }
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.hit.input.cursor = this.enabled ? 'pointer' : 'default';
    this.redraw();
    return this;
  }

  setFocused(v) {
    this.focused = !!v;
    this.redraw();
    return this;
  }

  redraw() {
    const g = this.bg;
    const { w, h } = this;
    g.clear();
    const fill = !this.enabled ? 0x161a21 : this.pressed ? 0x3a3020 : this.focused ? COLORS.panelHi : COLORS.panel;
    const stroke = !this.enabled ? 0x2a303a : this.focused || this.pressed ? COLORS.gas : COLORS.line;
    g.fillStyle(fill, 0.94);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, 6);
    g.lineStyle(2, stroke, 1);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, 6);
    this.label.setColor(this.enabled ? (this.focused ? '#ffe2b0' : COLORS.text) : COLORS.textDisabled);
    if (this.sub) this.sub.setColor(this.enabled ? COLORS.textDim : COLORS.textDisabled);
  }
}

/**
 * 垂直按鈕清單：滑鼠移過去會聚焦，方向鍵上下移動、Enter/空白鍵確認。
 * items: [{ label, sub?, enabled?, onSelect }]
 */
export class ButtonList {
  constructor(scene, { x, y, w, h = 48, gap = 10, items, fontSize = 17, align = 'center' }) {
    this.y0 = y;
    this.scene = scene;
    this.buttons = items.map((it, i) => {
      const b = new Button(scene, x, y + i * (h + gap), w, h, it.label, {
        sub: it.sub ?? null, fontSize, align, onClick: () => it.onSelect?.(i),
      });
      b.setEnabled(it.enabled !== false);
      b.on('hover', () => { if (b.enabled) this.focus(i); });
      return b;
    });
    this.index = -1;
    const first = this.buttons.findIndex((b) => b.enabled);
    if (first >= 0) this.focus(first);
  }

  focus(i) {
    this.index = i;
    this.buttons.forEach((b, j) => b.setFocused(j === i));
  }

  move(delta) {
    const n = this.buttons.length;
    if (!n) return;
    let i = this.index;
    for (let step = 0; step < n; step++) {
      i = (i + delta + n) % n;
      if (this.buttons[i].enabled) { this.focus(i); return; }
    }
  }

  activate() {
    const b = this.buttons[this.index];
    if (b && b.enabled) b.activate();
  }

  /** 處理鍵盤；有用到回 true。 */
  handleKey(code) {
    if (code === 'ArrowUp' || code === 'KeyW') { this.move(-1); return true; }
    if (code === 'ArrowDown' || code === 'KeyS') { this.move(1); return true; }
    if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') { this.activate(); return true; }
    return false;
  }

  destroy() {
    this.buttons.forEach((b) => b.destroy());
    this.buttons = [];
  }
}

/** 半透明面板。 */
export function panel(scene, x, y, w, h, { alpha = 0.95, stroke = COLORS.gas, radius = 8 } = {}) {
  const g = scene.add.graphics();
  g.fillStyle(COLORS.panel, alpha);
  g.fillRoundedRect(x, y, w, h, radius);
  g.lineStyle(2, stroke, 1);
  g.strokeRoundedRect(x, y, w, h, radius);
  return g;
}
