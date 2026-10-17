// 夢客自由交談（鐘塔之夢，M4）：直向 360×640，手機可完整操作。
// 上方：夢客名字與頭像、今日剩餘句數、「離開」；中間：對話紀錄（DOM，可捲動）；下方：輸入框（最多 120 字）＋「送出」。
// 第一次交談前沒有有效通行證 → 顯示 Turnstile（action dream_pass）→ POST /api/dream/pass → 通行證存在記憶體。
// 名字與回覆只經 Phaser Text 或 DOM textContent 顯示，絕不使用 innerHTML。
// 修訂 1（M4 第一輪對抗審查）：
// - 每次開啟是一個新的 session（sid）；請求回來時先把結果寫進該夢客的紀錄，畫面只在同一個 session 才更新。
//   離開後立刻重進、上一次的請求還在路上 → 維持鎖定與等待泡泡，回覆到了才解鎖（不會亂序、不會兩句同時在等）。
// - 一次送出最多重新驗證通行證 1 次，之後顯示錯誤並停止（防止裝置時鐘不準等情況下無限重新驗證）。
// - 今日剩餘句數是 0（通行證回應或上一次 chat）→ 開啟時就鎖住並顯示額度用完。
// - 夢客回覆的 sig 原樣存進紀錄，送 history 時帶上（buildHistory 只送有 sig 的夢客回覆）。
import { WIDTH, HEIGHT, TEST_MODE } from '../config.js';
import { session } from '../session.js';
import { addText, Button, fitText } from '../ui/widgets.js';
import { spriteKey } from '../textures.js';
import { guestById, pickScripted } from '../core/dream.js';
import { cloud, dream } from '../cloud-client.js';
import { mountTurnstile } from '../ui/turnstile-panel.js';
import { TURNSTILE_ACTIONS } from '../cloud/turnstile-config.js';
import {
  MAX_INPUT_CHARS, cleanChatInput, charCount, clampInput, buildHistory, scriptedKindFor, cleanReply, DREAM_MSG, chatQuotaView,
} from '../cloud/dream.js';
import { waitText } from '../cloud/sync.js';

const CHAR_MS = 32;
const LOG = { x: 8, y: 76, w: WIDTH - 16, h: 410 };
const INPUT_Y = 556;
/** 對話紀錄只在記憶體（重新整理就沒了）：夢客 id → 訊息陣列。 */
const chatLogs = new Map();
/** 還在路上的 chat 請求：夢客 id → Promise（結果寫進紀錄後 resolve）。跨 session（離開再重進）共用。 */
const inflight = new Map();
/** 開啟聊天的次數：每次開啟一個新的 session 編號。 */
let sessionSeq = 0;

const VERIFY_NOTE = '第一次交談前，請先完成人機驗證（防止濫用）。';
/** 429（每分鐘超過上限，不扣句數）時狀態列的提示。 */
const rateLimitedNote = (sec) => {
  const w = waitText(sec);
  return w ? `說得太快了，請等${w.startsWith('約') ? '' : ' '}${w}後再試。` : '說得太快了，請稍後再試。';
};
/** 畫面上顯示的文字：夢客回覆移除 Cc／Cf（紀錄裡的 text 保持原文，送 history 時簽章才對得上；修訂 1a 4）。 */
const shownText = (m) => (m.role === 'guest' ? cleanReply(m.text) : m.text);

export class DreamChatScene extends Phaser.Scene {
  constructor() { super('DreamChat'); }

  init(data) {
    this.guestId = data?.guest ?? null;
    this.onClose = typeof data?.onClose === 'function' ? data.onClose : null;
  }

  create() {
    session.scene = 'DreamChat';
    this.scene.bringToTop();
    this.sid = ++sessionSeq;
    const sid = this.sid;
    this.closed = false;
    this.busy = false;
    this.verifying = false;
    this.verifyError = null;
    this.locked = false; // 額度用完或雲端失效：不能再送
    this.pendingText = null; // 等通行證時暫存的那一句
    this.typing = null;
    this.typingDone = null;
    this.guest = guestById(session.data, this.guestId) ?? { id: this.guestId, name: this.guestId ?? '？', scripted: {} };
    if (!chatLogs.has(this.guest.id)) chatLogs.set(this.guest.id, []);
    this.log = chatLogs.get(this.guest.id);

    this.input.keyboard.disableGlobalCapture(); // 輸入框要能打空白、WASD
    this.events.once('shutdown', () => {
      this.stopTyping();
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
    // 上一次開啟時送出的請求還在路上：維持鎖定與等待泡泡，結果寫進紀錄後再更新畫面
    const pending = inflight.get(this.guest.id);
    if (pending) {
      this.busy = true;
      this.showWaiting(true);
      pending.then(() => this.afterInflight(sid));
    }
    this.refresh();
    if (this.quotaUsedUp) this.setStatus(this.quotaView.note);
    if (!dream.hasPass()) this.startVerify();
  }

  /** 開啟時還在路上的請求完成了（結果已經在紀錄裡）：重畫紀錄、解除等待。 */
  afterInflight(sid) {
    if (!this.isLive(sid)) return;
    this.busy = false;
    this.showWaiting(false);
    this.renderLog();
    if (this.quotaUsedUp) this.setStatus(this.quotaView.note);
    this.refresh();
  }

  /** 是否還是同一次開啟（離開後重進就是新的 session）。 */
  isLive(sid) { return !this.closed && this.sid === sid; }

  /**
   * 額度顯示（最後一輪修正）：剩餘句數是 0 → 「次數用完」；伺服器回過 reason quota／budget 但還有句數 → 剩餘「—」＋「夢境今天變得模糊了」。
   */
  get quotaView() { return chatQuotaView({ remaining: dream.remaining(), quotaHit: dream.quotaHit() }); }

  /** 今日不能再說：剩餘句數已知是 0（通行證回應或上一次 chat），或伺服器回過 reason quota／budget（修訂 1a 3）。 */
  get quotaUsedUp() { return this.quotaView.locked; }

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
    return !this.busy && !this.verifying && !this.locked && !this.quotaUsedUp && !this.closed && this.verifyError === null;
  }

  refresh() {
    this.remainText.setText(this.quotaView.remainingLabel);
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
    body.textContent = shownText(m);
    el.appendChild(body);
    if (m.unsent) this.markUnsent(el);
    return { el, body };
  }

  /** 被每分鐘上限擋下、沒有送到夢客那裡的玩家訊息：畫面保留，標示「沒有送出」（不放進 history）。 */
  markUnsent(el) {
    el.classList.add('sl-msg-unsent');
    if (el.querySelector('.sl-msg-note')) return;
    const note = document.createElement('div');
    note.className = 'sl-msg-note';
    note.textContent = DREAM_MSG.unsent;
    el.appendChild(note);
  }

  renderLog() {
    this.logEl.replaceChildren(...this.log.map((m) => this.messageEl(m).el));
    this.scrollLog();
  }

  scrollLog() { this.logEl.scrollTop = this.logEl.scrollHeight; }

  /** 加一則訊息到紀錄並顯示。 */
  addMessage(m) {
    this.log.push(m);
    return this.showMessage(m);
  }

  /** 顯示一則（已經在紀錄裡的）訊息；guest 的回覆逐字顯示（測試模式瞬間顯示）。回傳 Promise（顯示完畢）。 */
  showMessage(m) {
    const { el, body } = this.messageEl(m);
    this.logEl.appendChild(el);
    this.scrollLog();
    if (m.role !== 'guest' || TEST_MODE) return Promise.resolve();
    const chars = Array.from(shownText(m));
    body.textContent = '';
    let n = 0;
    return new Promise((res) => {
      this.stopTyping();
      this.typingDone = res;
      this.typing = this.time.addEvent({
        delay: CHAR_MS, loop: true,
        callback: () => {
          n += 1;
          body.textContent = chars.slice(0, n).join('');
          this.scrollLog();
          if (n >= chars.length) this.stopTyping();
        },
      });
    });
  }

  /** 停止逐字顯示（顯示完、或離開畫面），讓等它的 Promise 結束。 */
  stopTyping() {
    this.typing?.remove();
    this.typing = null;
    const done = this.typingDone;
    this.typingDone = null;
    done?.();
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
    const sid = this.sid;
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
      onResult: (r) => this.onTurnstile(r, sid),
    });
  }

  async onTurnstile(r, sid) {
    if (!this.isLive(sid)) return;
    this.turnstileHandle = null;
    if (!r.ok) { this.verifyFailed(r.message); return; }
    this.verifyText.setText('驗證中…');
    const p = await dream.obtainPass(r.token);
    if (!this.isLive(sid)) return;
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
    this.setStatus(this.quotaUsedUp ? this.quotaView.note : '');
    this.refresh();
    const queued = this.pendingText;
    this.pendingText = null;
    // 等通行證的那一句：這次送出已經重新驗證過 1 次了
    if (queued) this.ask(queued, { reverified: true });
    else if (this.canSend && !this.sys.game.device.input.touch) this.inputEl.focus();
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

  /**
   * 需要（新的）通行證才能送這一句：這次送出還沒重新驗證過 → 重新驗證後自動重送；
   * 已經重新驗證過 1 次 → 顯示錯誤並停止（修訂 1 B）。
   */
  needPass(text, reverified) {
    if (reverified) {
      this.busy = false;
      this.pendingText = null;
      this.setStatus(DREAM_MSG.passRejected);
      this.refresh();
      return;
    }
    this.pendingText = text;
    this.startVerify('夢境通行證過期了，請重新完成人機驗證。');
  }

  /**
   * 送出一句（玩家的訊息已經在紀錄裡）。reverified：這次送出是否已經重新驗證過通行證。
   * 結果一律先寫進該夢客的紀錄（即使玩家已經離開畫面），畫面只在同一個 session 才更新。
   */
  async ask(text, { reverified = false } = {}) {
    const sid = this.sid;
    if (!dream.hasPass()) { this.needPass(text, reverified); return; }
    const guest = this.guest;
    const guestId = guest.id;
    const log = this.log;
    this.busy = true;
    this.setStatus('');
    this.refresh();
    this.showWaiting(true);
    const idx = log.findLastIndex((m) => m.role === 'player' && m.text === text);
    const sent = idx >= 0 ? log[idx] : null;
    if (sent) delete sent.unsent; // 重送（例如通行證重新驗證後）
    const history = buildHistory(log.slice(0, Math.max(0, idx))); // 這一句之前的紀錄
    const chapter = typeof session.state?.chapter === 'string' ? session.state.chapter : (session.data?.manifest?.chapters?.[0] ?? 'prologue');

    let finish;
    const finished = new Promise((res) => { finish = res; });
    inflight.set(guestId, finished);
    let r;
    let msg = null;
    try {
      r = await dream.chat({ guest: guestId, chapter, history, input: text });
      // 先寫紀錄（不管畫面還在不在）
      if (r.type === 'reply') {
        msg = { role: 'guest', text: r.text, source: r.source }; // text＝reply 原文（不 trim、不清字元）
        if (r.sig) msg.sig = r.sig;
      } else if (r.type !== 'pass_invalid' && r.type !== 'rate_limited') {
        // 網路錯誤、逾時、429、5xx、雲端失效：播預寫台詞（沒有 sig，不會送進之後的 history）
        msg = { role: 'guest', text: pickScripted(guest, scriptedKindFor(null)) ?? '……', source: 'scripted' };
      }
      if (msg) log.push(msg);
      if (r.type === 'rate_limited' && sent) sent.unsent = true; // 伺服器沒收到：之後的 history 不送這句
      if (r.type === 'unauthorized') cloud.invalidate();
    } finally {
      if (inflight.get(guestId) === finished) inflight.delete(guestId);
      finish();
    }

    if (!this.isLive(sid)) return;
    this.showWaiting(false);
    if (r.type === 'pass_invalid') {
      this.busy = false;
      this.needPass(text, reverified);
      return;
    }
    if (msg) await this.showMessage(msg);
    if (!this.isLive(sid)) return;
    if (r.type === 'reply' && (r.reason === 'quota' || r.reason === 'budget' || r.remaining === 0)) {
      this.locked = true;
      this.setStatus(this.quotaView.note ?? DREAM_MSG.dreamBlurred);
    }
    if (r.type === 'unauthorized') {
      this.locked = true;
      this.setStatus(DREAM_MSG.relink);
    }
    if (r.type === 'rate_limited') {
      this.setStatus(rateLimitedNote(r.retryAfter));
      const el = sent ? [...this.logEl.querySelectorAll('.sl-msg-player')].at(-1) : null;
      if (el) this.markUnsent(el);
    }
    this.busy = false;
    this.refresh();
    if (this.canSend && !this.sys.game.device.input.touch) this.inputEl.focus();
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
      messages: this.log.map((m) => ({ role: m.role, text: m.text, source: m.source ?? null, ...(m.unsent ? { unsent: true } : {}) })),
      shown: [...this.logEl.querySelectorAll('.sl-msg')].map((el) => ({
        cls: el.className, text: el.querySelector('.sl-msg-text')?.textContent ?? el.textContent, ...(el.querySelector('.sl-msg-note') ? { note: el.querySelector('.sl-msg-note').textContent } : {}),
      })),
      waiting: this.waitingEl !== null && this.waitingEl !== undefined,
      typing: this.typing !== null && this.typing !== undefined,
      busy: this.busy,
      locked: this.locked || this.quotaUsedUp,
      inputEnabled: !this.inputEl.disabled,
      count: this.countText.text,
      status: this.statusText.text,
      verify: { visible: this.verifyPanel.visible, verifying: this.verifying, error: this.verifyError, text: this.verifyText.text, retry: this.retryBtn.visible },
      buttons: { send: rect(this.sendBtn), leave: rect(this.leaveBtn), retry: rect(this.retryBtn) },
    };
  }
}
