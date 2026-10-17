// 夢客自由交談（鐘塔之夢，M4）：直向 360×640，手機可完整操作。
// 上方：夢客名字與頭像、今日剩餘句數、「離開」；中間：對話紀錄（DOM，可捲動）；下方：輸入框（最多 120 字）＋「送出」。
// 第一次交談前沒有有效通行證 → 顯示 Turnstile（action dream_pass）→ POST /api/dream/pass → 通行證存在記憶體。
// 名字與回覆只經 Phaser Text 或 DOM textContent 顯示，絕不使用 innerHTML。
import { WIDTH, HEIGHT, TEST_MODE } from '../config.js';
import { session } from '../session.js';
import { addText, Button, fitText } from '../ui/widgets.js';
import { spriteKey } from '../textures.js';
import { guestById, pickScripted } from '../core/dream.js';
import { cloud, dream } from '../cloud-client.js';
import { mountTurnstile } from '../ui/turnstile-panel.js';
import { TURNSTILE_ACTIONS } from '../cloud/turnstile-config.js';
import {
  MAX_INPUT_CHARS, cleanChatInput, charCount, clampInput, buildHistory, scriptedKindFor, DREAM_MSG,
} from '../cloud/dream.js';

const CHAR_MS = 32;
const LOG = { x: 8, y: 76, w: WIDTH - 16, h: 410 };
const INPUT_Y = 556;
/** 對話紀錄只在記憶體（重新整理就沒了）：夢客 id → 訊息陣列。 */
const chatLogs = new Map();

const QUOTA_NOTE = '今天的交談次數已經用完了，明天再來吧。';
const VERIFY_NOTE = '第一次交談前，請先完成人機驗證（防止濫用）。';

export class DreamChatScene extends Phaser.Scene {
  constructor() { super('DreamChat'); }

  init(data) {
    this.guestId = data?.guest ?? null;
    this.onClose = typeof data?.onClose === 'function' ? data.onClose : null;
  }

  create() {
    session.scene = 'DreamChat';
    this.scene.bringToTop();
    this.closed = false;
    this.busy = false;
    this.verifying = false;
    this.verifyError = null;
    this.locked = false; // 額度用完或雲端失效：不能再送
    this.pendingText = null; // 等通行證時暫存的那一句
    this.typing = null;
    this.guest = guestById(session.data, this.guestId) ?? { id: this.guestId, name: this.guestId ?? '？', scripted: {} };
    if (!chatLogs.has(this.guest.id)) chatLogs.set(this.guest.id, []);
    this.log = chatLogs.get(this.guest.id);

    this.input.keyboard.disableGlobalCapture(); // 輸入框要能打空白、WASD
    this.events.once('shutdown', () => {
      this.typing?.remove();
      this.input.keyboard.enableGlobalCapture();
      this.closed = true;
    });

    this.drawBackdrop();
    this.buildHeader();
    this.buildLog();
    this.buildInput();
    this.buildVerify();

    this.input.keyboard.on('keydown', (ev) => {
      if (ev.code === 'Escape') { ev.preventDefault?.(); this.leave(); }
    });

    if (this.log.length === 0) {
      const hello = pickScripted(this.guest, 'greeting');
      if (hello) this.log.push({ role: 'guest', text: hello, source: 'greeting' });
    }
    this.renderLog();
    this.refresh();
    if (!dream.hasPass()) this.startVerify();
  }

  // ---------- 版面 ----------
  drawBackdrop() {
    this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x0a0e18, 1).setOrigin(0).setInteractive(); // 擋住下層（不透明）
    const g = this.add.graphics();
    const cx = WIDTH / 2;
    const cy = 290;
    g.lineStyle(2, 0x2e3a56, 0.6).strokeCircle(cx, cy, 150);
    g.lineStyle(1, 0x2e3a56, 0.4).strokeCircle(cx, cy, 136);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r1 = i % 3 === 0 ? 120 : 128;
      g.lineStyle(i % 3 === 0 ? 3 : 1, 0x3a4868, 0.6);
      g.lineBetween(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1, cx + Math.sin(a) * 136, cy - Math.cos(a) * 136);
    }
    // 頂部標題列
    g.fillStyle(0x111829, 1).fillRect(0, 0, WIDTH, 68);
    g.lineStyle(1, 0x6f86b8, 1).lineBetween(0, 67.5, WIDTH, 67.5);
  }

  buildHeader() {
    const sprite = typeof this.guest.sprite === 'string' && this.textures.exists(spriteKey(this.guest.sprite)) ? spriteKey(this.guest.sprite) : spriteKey('unknown');
    this.add.circle(34, 34, 24, 0x1d2840).setStrokeStyle(2, 0x6f86b8);
    this.avatar = this.add.image(34, 34, sprite).setScale(1.6);
    this.nameText = addText(this, 66, 22, '', { fontSize: '18px', fontStyle: 'bold', color: '#d8e4ff' }).setOrigin(0, 0.5);
    fitText(this.nameText, this.guest.name, 150);
    this.remainText = addText(this, 66, 48, '', { fontSize: '12px', color: '#9fb0cf' }).setOrigin(0, 0.5);
    this.leaveBtn = new Button(this, 306, 34, 84, 42, '離開', { fontSize: 16, onClick: () => this.leave() });
  }

  buildLog() {
    const box = document.createElement('div');
    box.className = 'sl-chat-log';
    box.setAttribute('role', 'log');
    box.setAttribute('aria-live', 'polite');
    box.style.width = `${LOG.w}px`;
    box.style.height = `${LOG.h}px`;
    this.logEl = box;
    this.add.dom(LOG.x + LOG.w / 2, LOG.y + LOG.h / 2, box);
  }

  buildInput() {
    this.statusText = addText(this, 12, 506, '', {
      fontSize: '12px', color: '#9fb0cf', wordWrap: { width: 250, useAdvancedWrap: true },
    }).setOrigin(0, 0.5);
    this.countText = addText(this, WIDTH - 12, 506, '', { fontSize: '12px', color: '#9fb0cf' }).setOrigin(1, 0.5);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sl-chat-input';
    input.maxLength = MAX_INPUT_CHARS * 2; // 以字元計的上限由 clampInput 把關（emoji 等佔 2 個 UTF-16）
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = '想說什麼？';
    input.setAttribute('aria-label', `對${this.guest.name}說的話`);
    input.setAttribute('enterkeyhint', 'send');
    input.addEventListener('input', () => {
      const v = clampInput(input.value);
      if (v !== input.value) input.value = v;
      this.refreshCount();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.submit(); }
      if (e.key === 'Escape') { e.preventDefault(); this.leave(); }
    });
    this.inputEl = input;
    this.add.dom(8 + 128, INPUT_Y, input);
    this.sendBtn = new Button(this, 308, INPUT_Y, 88, 46, '送出', { fontSize: 17, onClick: () => this.submit() });
    this.hint = addText(this, WIDTH / 2, 606, '按 Enter 或「送出」。對話內容不會被保存。', { fontSize: '11px', color: '#6c7a96' }).setOrigin(0.5);
  }

  /** 人機驗證面板（蓋在對話紀錄中間）。 */
  buildVerify() {
    const c = this.add.container(0, 0).setDepth(30);
    const g = this.add.graphics();
    g.fillStyle(0x121a2c, 0.98).fillRoundedRect(20, 200, WIDTH - 40, 220, 10);
    g.lineStyle(2, 0x6f86b8, 1).strokeRoundedRect(20, 200, WIDTH - 40, 220, 10);
    this.verifyTitle = addText(this, WIDTH / 2, 226, '人機驗證', { fontSize: '17px', fontStyle: 'bold', color: '#d8e4ff' }).setOrigin(0.5);
    this.verifyText = addText(this, WIDTH / 2, 252, '', {
      fontSize: '13px', color: '#b8c4dc', align: 'center', wordWrap: { width: WIDTH - 72, useAdvancedWrap: true },
    }).setOrigin(0.5, 0);
    c.add([g, this.verifyTitle, this.verifyText]);
    this.retryBtn = new Button(this, WIDTH / 2, 384, 180, 44, '再試一次', { fontSize: 16, onClick: () => this.startVerify() });
    c.add(this.retryBtn);
    this.verifyPanel = c;
    c.setVisible(false);
  }

  /** 驗證面板是 Phaser 物件，DOM 的對話紀錄會蓋在它上面：面板顯示時先藏起紀錄。 */
  showVerifyPanel(v) {
    this.verifyPanel.setVisible(v);
    this.logEl.style.visibility = v ? 'hidden' : 'visible';
  }

  // ---------- 狀態 ----------
  get canSend() {
    return !this.busy && !this.verifying && !this.locked && !this.closed && this.verifyError === null;
  }

  refresh() {
    const rem = dream.remaining();
    this.remainText.setText(`今日剩餘 ${rem === null ? '—' : rem} 句`);
    const enabled = this.canSend;
    this.inputEl.disabled = !enabled;
    this.sendBtn.setEnabled(enabled);
    this.refreshCount();
  }

  refreshCount() {
    const n = charCount(this.inputEl.value);
    this.countText.setText(`剩 ${MAX_INPUT_CHARS - n} 字`).setColor(n >= MAX_INPUT_CHARS ? '#f0a848' : '#9fb0cf');
  }

  setStatus(msg) { this.statusText.setText(msg ?? ''); }

  // ---------- 對話紀錄（DOM，只用 textContent） ----------
  messageEl(m) {
    const el = document.createElement('div');
    el.className = `sl-msg sl-msg-${m.role}${m.source === 'scripted' ? ' sl-msg-scripted' : ''}${m.source === 'greeting' ? ' sl-msg-greeting' : ''}`;
    if (m.role === 'guest') {
      const who = document.createElement('div');
      who.className = 'sl-msg-who';
      who.textContent = this.guest.name;
      el.appendChild(who);
    }
    const body = document.createElement('div');
    body.className = 'sl-msg-text';
    body.textContent = m.text;
    el.appendChild(body);
    return { el, body };
  }

  renderLog() {
    this.logEl.replaceChildren(...this.log.map((m) => this.messageEl(m).el));
    this.scrollLog();
  }

  scrollLog() { this.logEl.scrollTop = this.logEl.scrollHeight; }

  /** 加一則訊息；guest 的回覆逐字顯示（測試模式瞬間顯示）。回傳 Promise（顯示完畢）。 */
  addMessage(m) {
    this.log.push(m);
    const { el, body } = this.messageEl(m);
    this.logEl.appendChild(el);
    this.scrollLog();
    if (m.role !== 'guest' || TEST_MODE) return Promise.resolve();
    const chars = Array.from(m.text);
    body.textContent = '';
    let n = 0;
    return new Promise((res) => {
      this.typing?.remove();
      this.typing = this.time.addEvent({
        delay: CHAR_MS, loop: true,
        callback: () => {
          n += 1;
          body.textContent = chars.slice(0, n).join('');
          this.scrollLog();
          if (n >= chars.length) { this.typing.remove(); this.typing = null; res(); }
        },
      });
    });
  }

  showWaiting(v) {
    this.waitingEl?.remove();
    this.waitingEl = null;
    if (!v) return;
    const el = document.createElement('div');
    el.className = 'sl-msg sl-msg-guest sl-msg-waiting';
    el.textContent = '……';
    el.setAttribute('aria-label', `${this.guest.name}正在想`);
    this.logEl.appendChild(el);
    this.waitingEl = el;
    this.scrollLog();
  }

  // ---------- 人機驗證與通行證 ----------
  startVerify(note = null) {
    if (this.closed) return;
    this.turnstileHandle?.cancel();
    this.verifying = true;
    this.verifyError = null;
    this.showVerifyPanel(true);
    this.retryBtn.setVisible(false);
    this.verifyText.setText(note ?? VERIFY_NOTE);
    this.setStatus('等待人機驗證…');
    this.refresh();
    this.turnstileHandle = mountTurnstile(this, WIDTH / 2, 330, {
      action: TURNSTILE_ACTIONS.dreamPass,
      onResult: (r) => this.onTurnstile(r),
    });
  }

  async onTurnstile(r) {
    this.turnstileHandle = null;
    if (this.closed) return;
    if (!r.ok) { this.verifyFailed(r.message); return; }
    this.verifyText.setText('驗證中…');
    const p = await dream.obtainPass(r.token);
    if (this.closed) return;
    if (!p.ok) {
      if (p.kind === 'unauthorized') {
        cloud.invalidate();
        this.verifyFailed(DREAM_MSG.relink, { retry: false });
        return;
      }
      this.verifyFailed(p.message);
      return;
    }
    this.verifying = false;
    this.showVerifyPanel(false);
    this.setStatus('');
    this.refresh();
    const queued = this.pendingText;
    this.pendingText = null;
    if (queued) this.ask(queued);
    else if (!this.sys.game.device.input.touch) this.inputEl.focus();
  }

  verifyFailed(message, { retry = true } = {}) {
    this.verifying = false;
    this.verifyError = message;
    this.showVerifyPanel(true);
    this.verifyText.setText(message);
    this.retryBtn.setVisible(retry);
    this.setStatus(message);
    this.refresh();
  }

  // ---------- 送出 ----------
  submit() {
    if (!this.canSend) return;
    const text = clampInput(cleanChatInput(this.inputEl.value));
    if (text === '') { this.setStatus('請先輸入想說的話'); return; }
    this.inputEl.value = '';
    this.addMessage({ role: 'player', text });
    this.ask(text);
  }

  /** 送出一句（玩家的訊息已經在紀錄裡）。 */
  async ask(text) {
    if (!dream.hasPass()) {
      this.pendingText = text;
      this.startVerify('夢境通行證過期了，請重新完成人機驗證。');
      return;
    }
    this.busy = true;
    this.setStatus('');
    this.refresh();
    this.showWaiting(true);
    const idx = this.log.findLastIndex((m) => m.role === 'player' && m.text === text);
    const history = buildHistory(this.log.slice(0, Math.max(0, idx))); // 這一句之前的紀錄
    const chapter = typeof session.state?.chapter === 'string' ? session.state.chapter : (session.data?.manifest?.chapters?.[0] ?? 'prologue');
    const r = await dream.chat({ guest: this.guest.id, chapter, history, input: text });
    if (this.closed) return;
    this.showWaiting(false);
    if (r.type === 'pass_invalid') {
      this.busy = false;
      this.pendingText = text;
      this.startVerify('夢境通行證過期了，請重新完成人機驗證。');
      return;
    }
    if (r.type === 'reply') {
      await this.addMessage({ role: 'guest', text: r.text, source: r.source });
      if (r.reason === 'quota' || r.reason === 'budget' || r.remaining === 0) {
        this.locked = true;
        this.setStatus(QUOTA_NOTE);
      }
    } else {
      // 網路錯誤、逾時、429、5xx、雲端失效：播預寫台詞，不中斷遊戲
      await this.addMessage({ role: 'guest', text: pickScripted(this.guest, scriptedKindFor(null)) ?? '……', source: 'scripted' });
      if (r.type === 'unauthorized') {
        cloud.invalidate();
        this.locked = true;
        this.setStatus(DREAM_MSG.relink);
      }
    }
    if (this.closed) return;
    this.busy = false;
    this.refresh();
    if (!this.locked && !this.sys.game.device.input.touch) this.inputEl.focus();
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    this.inputEl.blur();
    this.turnstileHandle?.cancel();
    const cb = this.onClose;
    this.onClose = null;
    if (cb) cb(); else this.scene.stop();
  }

  /** E2E 用的唯讀資訊（邏輯座標）。 */
  debugInfo() {
    const rect = (b) => ({ x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h, enabled: b.enabled, visible: b.visible });
    return {
      guest: this.guest.id,
      name: this.nameText.text,
      remaining: this.remainText.text,
      messages: this.log.map((m) => ({ role: m.role, text: m.text, source: m.source ?? null })),
      shown: [...this.logEl.querySelectorAll('.sl-msg')].map((el) => ({ cls: el.className, text: el.querySelector('.sl-msg-text')?.textContent ?? el.textContent })),
      waiting: this.waitingEl !== null && this.waitingEl !== undefined,
      typing: this.typing !== null && this.typing !== undefined,
      busy: this.busy,
      locked: this.locked,
      inputEnabled: !this.inputEl.disabled,
      count: this.countText.text,
      status: this.statusText.text,
      verify: { visible: this.verifyPanel.visible, verifying: this.verifying, error: this.verifyError, text: this.verifyText.text, retry: this.retryBtn.visible },
      buttons: { send: rect(this.sendBtn), leave: rect(this.leaveBtn), retry: rect(this.retryBtn) },
    };
  }
}
