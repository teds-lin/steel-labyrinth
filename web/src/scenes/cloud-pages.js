// 選單（MenuScene）的雲端存檔頁面：雲端存檔總覽、上傳／下載、衝突比較、轉移碼、設定、存檔後上傳詢問、
// 標題畫面的「用轉移碼接續」。以 mixin 方式裝到 MenuScene.prototype（this 是 MenuScene）。
// 所有玩家可見的字串（名字、轉移碼）只經 Phaser Text 或 DOM input.value 顯示，不經過 HTML。
import { WIDTH, COLORS } from '../config.js';
import { session, formatPlaytime } from '../session.js';
import { addText, fitText } from '../ui/widgets.js';
import { cloud, formatStamp } from '../cloud-client.js';
import { MSG, normalizeTransferCode } from '../cloud/sync.js';

const SLOTS = [1, 2, 3];
const INTRO = '把存檔放到雲端，換一台裝置也能用轉移碼接續遊玩。\n不需要註冊，也不會收集個人資料。\n本機存檔照常使用，不受雲端影響。';
const CODE_FORMAT_HINT = '轉移碼是 8 個英文字母或數字（例如 ABCD-EFGH）';

/** 雲端總覽的版面（邏輯座標）。 */
const BLOCK = { top: 146, h: 108, step: 112, x: 24, w: WIDTH - 48 };
const COL = { local: 32, cloud: 186, w: 142 };

/** 摘要欄位可能是 null（版本較新的雲端存檔，API.md 補充 4）：一律顯示「—」。 */
const mapLabel = (id) => (typeof id === 'string' && id !== '' ? session.mapName(id) : '—');
const nameLabel = (n) => (typeof n === 'string' && n !== '' ? n : '—');
const timeLabel = (s) => (Number.isFinite(s) ? formatPlaytime(s) : '—');

/** 本機摘要 → 顯示用的 3 行。 */
function localLines(ls) {
  if (ls.empty) return ['（空）'];
  if (ls.broken) return ['無法上傳（存檔有誤）', ls.reason ?? ''];
  return [mapLabel(ls.map), `${nameLabel(ls.name)}　${timeLabel(ls.playtime_s)}`, `存檔 ${formatStamp(ls.updated_at)}`];
}
/** 雲端槽 → 顯示用的 3 行；slot 為 null 表示讀不到雲端。 */
function cloudLines(cs) {
  if (!cs) return ['無法取得'];
  if (cs.empty) return ['（空）'];
  return [mapLabel(cs.summary.map), `${nameLabel(cs.summary.name)}　${timeLabel(cs.summary.playtime_s)}`, `更新 ${formatStamp(cs.updated_at)}`];
}

export const cloudPages = {
  // ---------- 共用 ----------
  /** 非同步結果回來時，頁面是否還是同一頁（玩家可能已經離開）。 */
  isCurrent(ticket) {
    return ticket === this.pageSeq && this.sys.isActive();
  },

  /** 連線中的畫面（沒有按鈕）；回傳這一頁的 ticket。 */
  showBusy(title, msg) {
    this.setPage('cloud-busy', title, msg, []);
    this.backAction = () => {}; // 連線中不接受返回（最多等逾時 5 秒）
    this.cloudView = { page: 'busy' };
    return this.pageSeq;
  },

  /** 自訂物件：換頁時一併銷毀。 */
  keep(obj) {
    this.extra.push(obj);
    return obj;
  },

  /** 上傳結果 → 回到 done(note)，或進衝突比較／失效提示。 */
  handleUploadResult(r, done, okNote, failPrefix = '') {
    if (r.ok) { done(okNote); return; }
    if (r.kind === 'conflict') { this.showConflict(r.conflict, done); return; }
    if (r.relink) { this.showRelink(done); return; }
    done(`${failPrefix}${r.message}`);
  },

  showRelink(done) {
    // 修訂 2 G：遊戲內也能直接用轉移碼重新接續（不必回標題）
    this.setPage('cloud-relink', '雲端存檔', MSG.relink, [
      { id: 'relink-transfer', label: '用轉移碼接續', onSelect: () => this.showTransferInput() },
      { id: 'relink-ok', label: '確定', onSelect: () => done(null) },
    ], { y: 260 });
    this.list.focus(1);
    this.backAction = () => done(null);
    this.cloudView = { page: 'relink', message: MSG.relink };
  },

  /** 修訂 2 G：API 位址是空字串＝雲端存檔尚未開放。 */
  showCloudClosed() {
    const back = () => (this.mode === 'transfer' ? this.close() : this.showMain());
    this.setPage('cloud-closed', '雲端存檔', MSG.notOpen, [{ id: 'back', label: '返回', onSelect: back }], { y: 240 });
    this.backAction = back;
    this.cloudView = { page: 'closed', message: MSG.notOpen };
  },

  /** 轉移碼頁面「返回」：標題畫面進來的關掉選單，遊戲中進來的回雲端存檔。 */
  leaveTransfer() {
    if (this.mode === 'transfer') this.close();
    else this.showCloud();
  },

  // ---------- 雲端總覽 ----------
  showCloud(note = null) {
    if (!cloud.configured()) { this.showCloudClosed(); return; }
    if (!cloud.enabled()) {
      this.setPage('cloud-intro', '雲端存檔', note ? `${note}\n\n${INTRO}` : INTRO, [
        { id: 'enable', label: '啟用雲端存檔', onSelect: () => this.enableCloud() },
        { id: 'transfer', label: '用轉移碼接續', sub: '已經在別台裝置用過雲端存檔', onSelect: () => this.showTransferInput() },
        { id: 'back', label: '返回', onSelect: () => this.showMain() },
      ], { y: 316, h: 56, gap: 8 });
      this.backAction = () => this.showMain();
      this.cloudView = { page: 'intro', enabled: false, status: note };
      return;
    }
    const t = this.showBusy('雲端存檔', '正在讀取雲端存檔…');
    cloud.listCloud().then((r) => {
      if (!this.isCurrent(t)) return;
      if (!r.ok && r.relink) { this.showRelink((n) => this.showCloud(n)); return; }
      this.renderCloud(r.ok ? r.slots : null, note ?? (r.ok ? null : r.message));
    });
  },

  enableCloud() {
    const t = this.showBusy('雲端存檔', '正在啟用雲端存檔…');
    cloud.enable().then((r) => {
      if (!this.isCurrent(t)) return;
      this.showCloud(r.ok ? '已啟用雲端存檔' : r.message);
    });
  },

  renderCloud(slots, status) {
    const items = [];
    const view = [];
    const locals = SLOTS.map((slot) => cloud.localSummary(slot));
    SLOTS.forEach((slot, i) => {
      const top = BLOCK.top + i * BLOCK.step;
      const ls = locals[i];
      const cs = slots ? slots[i] : null;
      items.push({
        id: `up${slot}`, label: '上傳', x: 226, y: top + 26, w: 66, h: 44, fontSize: 15,
        enabled: ls.uploadable === true, onSelect: () => this.cloudUpload(slot),
      });
      items.push({
        id: `down${slot}`, label: '下載', x: 300, y: top + 26, w: 66, h: 44, fontSize: 15,
        enabled: !!cs && !cs.empty, onSelect: () => this.cloudDownload(slot),
      });
      view.push({ slot, local: ls, cloud: cs });
    });
    const by = BLOCK.top + 3 * BLOCK.step + 26;
    items.push(
      { id: 'code', label: '查看轉移碼', x: 76, y: by, w: 100, h: 44, fontSize: 14, onSelect: () => this.showCode() },
      { id: 'settings', label: '其他設定', x: 180, y: by, w: 100, h: 44, fontSize: 14, onSelect: () => this.showCloudSettings() },
      { id: 'back', label: '返回', x: 284, y: by, w: 100, h: 44, fontSize: 14, onSelect: () => this.showMain() },
    );
    // 上傳停用的原因（修訂 2 B：語意壞掉的本機存檔不可上傳）：沒有其他訊息時顯示在狀態列
    const blocked = locals.find((ls) => ls.broken);
    const blockedNote = blocked ? `存檔 ${blocked.slot} 無法上傳：${blocked.reason || '存檔有誤'}` : '';
    const statusText = status ?? (slots ? blockedNote : MSG.unavailable);
    this.setPage('cloud', '雲端存檔', '', items);
    this.list.buttons.forEach((b) => b.setDepth(3));
    const st = this.keep(addText(this, WIDTH / 2, 130, '', { fontSize: '12px', color: '#ffe2b0' }).setOrigin(0.5));
    fitText(st, statusText, WIDTH - 48);
    SLOTS.forEach((slot, i) => {
      const top = BLOCK.top + i * BLOCK.step;
      const g = this.keep(this.add.graphics().setDepth(1));
      g.fillStyle(COLORS.bg, 0.7).fillRoundedRect(BLOCK.x, top, BLOCK.w, BLOCK.h, 6);
      g.lineStyle(1, COLORS.line, 1).strokeRoundedRect(BLOCK.x, top, BLOCK.w, BLOCK.h, 6);
      g.lineBetween(181, top + 52, 181, top + BLOCK.h - 8);
      this.keep(addText(this, 36, top + 26, `存檔 ${slot}`, { fontSize: '16px', fontStyle: 'bold', color: '#f0d2a0' }).setOrigin(0, 0.5).setDepth(2));
      const col = (x, head, lines) => {
        this.keep(addText(this, x, top + 58, head, { fontSize: '11px', color: COLORS.textGas }).setOrigin(0, 0.5).setDepth(2));
        lines.forEach((line, j) => {
          const t = this.keep(addText(this, x, top + 74 + j * 15, '', { fontSize: '12px', color: COLORS.text }).setOrigin(0, 0.5).setDepth(2));
          fitText(t, line, COL.w);
        });
      };
      col(COL.local, '本機', localLines(locals[i]));
      col(COL.cloud, '雲端', cloudLines(slots ? slots[i] : null));
    });
    this.backAction = () => this.showMain();
    this.cloudView = { page: 'cloud', enabled: true, status: statusText, slots: view };
  },

  cloudUpload(slot) {
    const t = this.showBusy('雲端存檔', `正在上傳存檔 ${slot}…`);
    cloud.upload(slot).then((r) => {
      if (!this.isCurrent(t)) return;
      this.handleUploadResult(r, (n) => this.showCloud(n), `已上傳存檔 ${slot}`);
    });
  },

  cloudDownload(slot) {
    const done = (n) => this.showCloud(n);
    const ls = cloud.localSummary(slot);
    if (ls.empty) { this.doCloudDownload(slot, slot, done); return; }
    this.setPage('cloud-confirm', '下載雲端存檔', `下載會覆蓋本機的存檔 ${slot}，確定嗎？`, [
      { id: 'confirm-download', label: '下載並覆蓋', onSelect: () => this.doCloudDownload(slot, slot, done) },
      { id: 'cancel', label: '取消', onSelect: () => this.showCloud() },
    ], { y: 240 });
    this.list.focus(1);
    this.backAction = () => this.showCloud();
    this.cloudView = { page: 'confirm-download', slot };
  },

  /** 下載雲端槽到本機槽，完成後 done(note)。 */
  doCloudDownload(cloudSlot, localSlot, done) {
    const t = this.showBusy('雲端存檔', `正在下載雲端存檔 ${cloudSlot}…`);
    cloud.download(cloudSlot, localSlot).then((r) => {
      if (!this.isCurrent(t)) return;
      if (r.ok) { done(`已下載到存檔 ${localSlot}`); return; }
      if (r.relink) { this.showRelink(done); return; }
      done(r.message);
    });
  },

  // ---------- 衝突 ----------
  showConflict(c, done) {
    const cancelNote = '已取消，雲端與本機都沒有變更';
    const items = [
      { id: 'use-cloud', label: '用雲端的', enabled: !c.cloud.empty, onSelect: () => this.doCloudDownload(c.slot, c.slot, done) },
      { id: 'use-local', label: '用本機的（覆蓋雲端）', onSelect: () => this.forceUpload(c, done) },
      { id: 'cancel', label: '取消', onSelect: () => done(cancelNote) },
    ];
    this.setPage('cloud-conflict', `存檔 ${c.slot} 的雲端資料不一致`,
      '雲端上的存檔和這台裝置上次同步的不一樣（可能在別台裝置存過）。要保留哪一邊？', items, { y: 372, h: 50, gap: 10 });
    this.list.focus(2);
    const top = 136 + this.note.height + 14;
    const box = (x, head, rows) => {
      const g = this.keep(this.add.graphics());
      g.fillStyle(COLORS.bg, 0.7).fillRoundedRect(x, top, 150, 128, 6);
      g.lineStyle(1, COLORS.line, 1).strokeRoundedRect(x, top, 150, 128, 6);
      this.keep(addText(this, x + 10, top + 16, head, { fontSize: '14px', fontStyle: 'bold', color: COLORS.textGas }).setOrigin(0, 0.5));
      rows.forEach((row, j) => {
        const t = this.keep(addText(this, x + 10, top + 42 + j * 24, '', { fontSize: '12px', color: COLORS.text }).setOrigin(0, 0.5));
        fitText(t, row, 132);
      });
    };
    const rows = (s) => [
      `地點　${mapLabel(s.map)}`,
      `名字　${nameLabel(s.name)}`,
      `遊戲時間　${timeLabel(s.playtime_s)}`,
      `更新時間　${formatStamp(s.updated_at)}`,
    ];
    box(24, '雲端', c.cloud.empty ? ['雲端已是空的'] : rows(c.cloud));
    box(186, '本機', rows(c.local));
    this.backAction = () => done(cancelNote);
    this.cloudView = { page: 'conflict', conflict: c };
  },

  forceUpload(c, done) {
    const t = this.showBusy('雲端存檔', `正在用本機的存檔 ${c.slot} 覆蓋雲端…`);
    cloud.upload(c.slot, { force: true, cloudVersion: c.cloudVersion }).then((r) => {
      if (!this.isCurrent(t)) return;
      this.handleUploadResult(r, done, `已用本機的存檔 ${c.slot} 覆蓋雲端`);
    });
  },

  // ---------- 轉移碼 ----------
  showCode(note = null) {
    const confirmed = cloud.transferCode();
    const pending = cloud.pendingTransferCode();
    // 修訂 2 A：新碼送出後還沒收到伺服器確認時，標示「新轉移碼尚未確認」，重試用同一個碼
    const code = pending ?? confirmed ?? '—';
    const items = pending
      ? [
        { id: 'rotate-retry', label: '重試確認新轉移碼', onSelect: () => this.doRotate() },
        { id: 'back', label: '返回', onSelect: () => this.showCloud() },
      ]
      : [
        { id: 'rotate', label: '重新產生轉移碼', onSelect: () => this.confirmRotate() },
        { id: 'back', label: '返回', onSelect: () => this.showCloud() },
      ];
    this.setPage('cloud-code', '轉移碼', '', items, { y: 420 });
    this.list.focus(pending ? 0 : 1);
    this.keep(addText(this, WIDTH / 2, 196, code, {
      fontSize: '36px', fontStyle: 'bold', color: pending ? COLORS.textDim : '#ffe2b0', letterSpacing: 2,
    }).setOrigin(0.5));
    const warning = '轉移碼等同密碼，請勿分享';
    const pendingLabel = '新轉移碼尚未確認';
    this.keep(addText(this, WIDTH / 2, 254, pending ? pendingLabel : warning, {
      fontSize: '16px', fontStyle: 'bold', color: pending ? '#ffb08a' : COLORS.textGas,
    }).setOrigin(0.5));
    const explain = pending
      ? `新的轉移碼還沒有收到伺服器確認，請按「重試確認新轉移碼」。\n確認前請不要使用這組碼；原本的 ${confirmed ?? '—'} 可能仍然有效。`
      : '在新裝置的標題畫面選「用轉移碼接續」並輸入這組碼。\n接續後會換成新的轉移碼，這台裝置的雲端連結也會失效。';
    this.keep(addText(this, WIDTH / 2, 282, explain, {
      fontSize: '12px', color: COLORS.textDim, align: 'center', wordWrap: { width: WIDTH - 72, useAdvancedWrap: true }, lineSpacing: 4,
    }).setOrigin(0.5, 0));
    if (note) {
      const n = this.keep(addText(this, WIDTH / 2, 368, '', { fontSize: '13px', color: '#ffe2b0' }).setOrigin(0.5));
      fitText(n, note, WIDTH - 56);
    }
    this.backAction = () => this.showCloud();
    this.cloudView = {
      page: 'code', code, confirmed: !pending, pendingCode: pending, previousCode: pending ? confirmed : null,
      warning: pending ? pendingLabel : warning, status: note,
    };
  },

  confirmRotate() {
    this.setPage('cloud-confirm', '重新產生轉移碼', '重新產生後，舊的轉移碼會立即失效。確定嗎？', [
      { id: 'confirm-rotate', label: '重新產生', onSelect: () => this.doRotate() },
      { id: 'cancel', label: '取消', onSelect: () => this.showCode() },
    ], { y: 240 });
    this.list.focus(1);
    this.backAction = () => this.showCode();
    this.cloudView = { page: 'confirm-rotate' };
  },

  doRotate() {
    const t = this.showBusy('轉移碼', '正在重新產生轉移碼…');
    cloud.rotate().then((r) => {
      if (!this.isCurrent(t)) return;
      if (r.relink) { this.showRelink((n) => this.showCloud(n)); return; }
      this.showCode(r.ok ? '已產生新的轉移碼' : r.message);
    });
  },

  // ---------- 其他設定 ----------
  showCloudSettings() {
    const auto = cloud.autoUpload();
    this.setPage('cloud-settings', '雲端設定', null, [
      {
        id: 'auto', label: `存檔後自動上傳：${auto ? '開' : '關'}`, sub: '手動存檔後，自動把同一格上傳到雲端',
        onSelect: () => { cloud.setAutoUpload(!auto); this.showCloudSettings(); },
      },
      { id: 'disable', label: '停用此裝置的雲端', sub: '只清除這台裝置的連結，雲端存檔會保留', onSelect: () => this.confirmDisable() },
      { id: 'back', label: '返回', onSelect: () => this.showCloud() },
    ], { h: 58, fontSize: 15 });
    this.backAction = () => this.showCloud();
    this.cloudView = { page: 'settings', autoUpload: auto };
  },

  confirmDisable() {
    const code = cloud.transferCode();
    const note = [
      '停用後這台裝置不再連到雲端，雲端上的存檔不會刪除。',
      '之後要再使用，請在標題畫面選「用轉移碼接續」。',
      code ? `\n目前的轉移碼：${code}\n請先記下來（轉移碼等同密碼，請勿分享）。` : '',
    ].join('\n');
    this.setPage('cloud-confirm', '停用此裝置的雲端', note, [
      { id: 'confirm-disable', label: '停用', onSelect: () => { cloud.disable(); this.showCloud('已停用此裝置的雲端'); } },
      { id: 'cancel', label: '取消', onSelect: () => this.showCloudSettings() },
    ], { y: 340 });
    this.list.focus(1);
    this.backAction = () => this.showCloudSettings();
    this.cloudView = { page: 'confirm-disable' };
  },

  // ---------- 手動存檔後 ----------
  /** 手動存檔成功後：已啟用雲端時詢問（或依設定自動）上傳同一格。 */
  afterManualSave(slot) {
    const saved = `已存檔到存檔 ${slot}`;
    if (!cloud.enabled()) { this.showSlots('save', saved); return; }
    cloud.noteLocalSave(slot);
    if (cloud.autoUpload()) { this.uploadAfterSave(slot); return; }
    this.askUpload(slot, false);
  },

  askUpload(slot, auto, focus = 0) {
    const saved = `已存檔到存檔 ${slot}`;
    this.setPage('cloud-ask', '上傳到雲端', `${saved}。\n也要上傳到雲端嗎？`, [
      { id: 'ask-upload', label: '上傳', onSelect: () => { if (auto) cloud.setAutoUpload(true); this.uploadAfterSave(slot); } },
      { id: 'ask-auto', label: `以後自動上傳：${auto ? '是' : '否'}`, onSelect: () => this.askUpload(slot, !auto, 1) },
      { id: 'ask-skip', label: '不用', onSelect: () => this.showSlots('save', saved) },
    ], { y: 230 });
    this.list.focus(focus);
    this.backAction = () => this.showSlots('save', saved);
    this.cloudView = { page: 'ask-upload', slot, autoUpload: auto };
  },

  uploadAfterSave(slot) {
    const saved = `已存檔到存檔 ${slot}`;
    const t = this.showBusy('上傳到雲端', `正在上傳存檔 ${slot}…`);
    cloud.upload(slot).then((r) => {
      if (!this.isCurrent(t)) return;
      this.handleUploadResult(r, (n) => this.showSlots('save', n ?? saved), `${saved}，並已上傳到雲端`, `${saved}。\n`);
    });
  },

  // ---------- 標題畫面：用轉移碼接續 ----------
  showTransferInput(error = null, value = '') {
    if (!cloud.configured()) { this.showCloudClosed(); return; }
    const warn = cloud.enabled() ? '\n這台裝置目前連著一個雲端帳號，接續後會改連到新的帳號。' : '';
    this.setPage('transfer-input', '用轉移碼接續', `輸入原本裝置上「選單 → 雲端存檔 → 查看轉移碼」顯示的 8 碼轉移碼。${warn}`, [
      { id: 'transfer-go', label: '接續', onSelect: () => this.submitTransfer() },
      { id: 'transfer-back', label: '返回', onSelect: () => this.leaveTransfer() },
    ], { y: 330 });
    const inputY = Math.max(236, 136 + this.note.height + 40);
    const listY = inputY + 110;
    this.list.buttons.forEach((b, i) => b.setY(listY + i * 62));

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sl-name-input sl-code-input';
    input.maxLength = 24;
    input.value = value;
    input.placeholder = 'XXXX-XXXX';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'characters');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-label', '轉移碼');
    input.setAttribute('enterkeyhint', 'go');
    // 重新輸入時清掉上一次的錯誤訊息
    input.addEventListener('input', () => {
      if (this.codeInput !== input || !this.codeError?.text) return;
      this.codeError.setText('');
      this.cloudView = { page: 'transfer-input', error: null };
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.submitTransfer(); }
      if (e.key === 'Escape') { e.preventDefault(); this.leaveTransfer(); }
    });
    this.codeInput = input;
    this.keep(this.add.dom(WIDTH / 2, inputY, input));
    // 輸入框聚焦時不能讓 Phaser 吃掉空白鍵、WASD 等按鍵（同命名畫面）
    this.input.keyboard.disableGlobalCapture();
    this.pageCleanup.push(() => {
      this.codeInput = null;
      this.input.keyboard.enableGlobalCapture();
    });
    this.codeError = this.keep(addText(this, WIDTH / 2, inputY + 46, '', {
      fontSize: '13px', color: '#ffb08a', align: 'center', wordWrap: { width: WIDTH - 64, useAdvancedWrap: true },
    }).setOrigin(0.5, 0));
    this.codeError.setText(error ?? '');
    if (!this.sys.game.device.input.touch) setTimeout(() => { if (this.codeInput === input) input.focus(); }, 50);
    this.backAction = () => this.leaveTransfer();
    this.cloudView = { page: 'transfer-input', error };
  },

  submitTransfer() {
    if (this.page !== 'transfer-input' || !this.codeInput) return;
    const raw = this.codeInput.value ?? '';
    if (!normalizeTransferCode(raw)) {
      this.codeError?.setText(CODE_FORMAT_HINT);
      this.cloudView = { page: 'transfer-input', error: CODE_FORMAT_HINT };
      return;
    }
    this.codeInput.blur();
    const t = this.showBusy('用轉移碼接續', '連線中…');
    cloud.connect(raw).then((r) => {
      if (!this.isCurrent(t)) return;
      if (!r.ok) { this.showTransferInput(r.message, raw); return; }
      this.showTransferSlots('已接續雲端帳號，請選擇要使用的雲端存檔');
    });
  },

  showTransferSlots(note = null) {
    const t = this.showBusy('雲端存檔', '正在讀取雲端存檔…');
    cloud.listCloud().then((r) => {
      if (!this.isCurrent(t)) return;
      if (!r.ok) {
        this.setPage('transfer-error', '雲端存檔', r.message, [
          { id: 'retry', label: '重試', onSelect: () => this.showTransferSlots(note) },
          { id: 'back', label: this.mode === 'transfer' ? '返回標題' : '返回', onSelect: () => this.leaveTransfer() },
        ], { y: 260 });
        this.backAction = () => this.leaveTransfer();
        this.cloudView = { page: 'transfer-error', message: r.message };
        return;
      }
      this.renderTransferSlots(r.slots, note);
    });
  },

  renderTransferSlots(slots, note = null) {
    this.transferSlots = slots;
    const items = slots.map((cs) => {
      if (cs.empty) return { id: `cloud${cs.slot}`, label: `雲端 ${cs.slot}　（空）`, sub: '沒有存檔', enabled: false };
      const s = cs.summary;
      const tail = `｜遊戲時間 ${timeLabel(s.playtime_s)}｜更新 ${formatStamp(cs.updated_at)}`;
      const render = (name) => `${name}${tail}`;
      return {
        id: `cloud${cs.slot}`, label: `雲端 ${cs.slot}　${mapLabel(s.map)}`,
        sub: render(nameLabel(s.name)), subName: nameLabel(s.name), subRender: render,
        onSelect: () => this.showTransferTarget(cs),
      };
    });
    items.push({ id: 'done', label: '完成', onSelect: () => this.leaveTransfer() });
    const anything = slots.some((s) => !s.empty);
    this.setPage('transfer-slots', '雲端存檔', note ?? (anything ? '選擇要使用的雲端存檔' : '雲端上還沒有存檔'), items, { h: 58, fontSize: 15 });
    this.backAction = () => this.leaveTransfer();
    this.cloudView = { page: 'transfer-slots', slots };
  },

  showTransferTarget(cs, note = null) {
    const s = cs.summary;
    const items = SLOTS.map((n) => {
      const ls = cloud.localSummary(n);
      let sub;
      if (ls.empty) sub = '本機：（空）';
      else if (ls.broken) sub = '本機：無法讀取的存檔';
      else sub = `本機：${mapLabel(ls.map)}｜${nameLabel(ls.name)}｜${timeLabel(ls.playtime_s)}`;
      return { id: `to${n}`, label: `下載到存檔 ${n}`, sub, onSelect: () => this.transferDownload(cs, n, ls.empty) };
    });
    items.push(
      { id: 'direct', label: '直接讀取（不存到本機）', onSelect: () => this.transferDirect(cs) },
      { id: 'back', label: '返回', onSelect: () => this.renderTransferSlots(this.transferSlots) },
    );
    const head = `${mapLabel(s.map)}｜${nameLabel(s.name)}｜遊戲時間 ${timeLabel(s.playtime_s)}`;
    this.setPage('transfer-target', `雲端 ${cs.slot}`, `${note ? `${note}\n` : ''}${head}\n要下載到本機的哪一格？`, items, { h: 52, gap: 8, fontSize: 15 });
    this.backAction = () => this.renderTransferSlots(this.transferSlots);
    this.cloudView = { page: 'transfer-target', slot: cs.slot };
  },

  transferDownload(cs, localSlot, empty) {
    const go = () => this.doCloudDownload(cs.slot, localSlot, (n) => {
      if (n === `已下載到存檔 ${localSlot}`) this.showTransferDone(localSlot);
      else if (!cloud.enabled()) this.showTransferInput(n);
      else this.showTransferTarget(cs, n);
    });
    if (empty) { go(); return; }
    this.setPage('cloud-confirm', '覆蓋本機存檔', `下載會覆蓋本機的存檔 ${localSlot}，確定嗎？`, [
      { id: 'confirm-download', label: '下載並覆蓋', onSelect: go },
      { id: 'cancel', label: '取消', onSelect: () => this.showTransferTarget(cs) },
    ], { y: 240 });
    this.list.focus(1);
    this.backAction = () => this.showTransferTarget(cs);
    this.cloudView = { page: 'confirm-download', slot: localSlot };
  },

  showTransferDone(localSlot) {
    this.setPage('transfer-done', '下載完成', `已下載到存檔 ${localSlot}`, [
      { id: 'play', label: '開始遊玩', onSelect: () => this.loadFrom(localSlot) },
      { id: 'back', label: '返回清單', onSelect: () => this.renderTransferSlots(this.transferSlots) },
    ], { y: 240 });
    this.backAction = () => this.renderTransferSlots(this.transferSlots);
    this.cloudView = { page: 'transfer-done', slot: localSlot };
  },

  transferDirect(cs) {
    const t = this.showBusy('雲端存檔', `正在讀取雲端存檔 ${cs.slot}…`);
    cloud.fetchCloud(cs.slot).then((r) => {
      if (!this.isCurrent(t)) return;
      if (r.ok) { this.enterGame(r.state, r.warnings); return; }
      if (r.relink) { this.showTransferInput(r.message); return; }
      this.showTransferTarget(cs, r.message);
    });
  },
};
