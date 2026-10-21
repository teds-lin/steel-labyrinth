// 選單（疊在其他場景上方）：存檔（3 槽，覆蓋前確認）、讀取、雲端存檔、道具、隊伍、回標題。
// mode：'game'（遊戲中 Esc）、'load'（標題的「繼續」）、'save'（章節結束後的存檔提示）、'transfer'（標題的「用轉移碼接續」）、
//       'trade'（M5：夢客的交換；地圖的 open_trade 開啟，關閉時呼叫 onClose）、
//       'feedback'（標題的「意見回饋」：只有提示頁，關閉後回到標題）。
// 雲端存檔的各頁面在 cloud-pages.js（mixin）。
import { WIDTH, HEIGHT, COLORS, GAME_VERSION } from '../config.js';
import { session, claimKey, formatPlaytime } from '../session.js';
import { addText, ButtonList, panel, fitPart, fitText } from '../ui/widgets.js';
import { fieldItems, useFieldItem } from '../core/items.js';
import { partyStatus, availableSkills } from '../core/stats.js';
import { cloudPages } from './cloud-pages.js';
import { applyTrade } from '../core/trade.js';
import { guestFor } from '../core/dream.js';
import { promotionProgress, tradeRows, tradeConfirm, tradeDoneText } from '../ui/m5-view.js';
import {
  FEEDBACK_LABEL, FEEDBACK_TITLE, FEEDBACK_BODY, FEEDBACK_GO, FEEDBACK_CANCEL, feedbackBlockedText, feedbackNoteForDisplay, openFeedback,
  REPORT_COPY_LABEL, REPORT_COPIED, REPORT_COPY_FAILED, REPORT_PRIVACY,
} from '../ui/feedback.js';
import { buildReportInfo, collectCloudSecrets, readLastSave, rememberLastSlot, copyText } from '../ui/report-info.js';
import { cloud } from '../cloud-client.js';

/** 交換頁一頁最多幾項（再加「下一頁」「離開」）。 */
const TRADES_PER_PAGE = 3;

const STAT_LABELS = [['atk', '攻擊'], ['def', '防禦'], ['spd', '速度'], ['will', '意志'], ['eva', '閃避']];
/** 道具頁一頁最多幾項（再加「下一頁」「返回」）。 */
const ITEMS_PER_PAGE = 4;

const BLOCKED_MSG = '目前無法存檔（瀏覽器封鎖了儲存空間），\n遊戲仍可繼續';

export class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  init(data) {
    this.mode = data?.mode ?? 'game';
    this.from = data?.from ?? 'Map';
    this.guestId = typeof data?.guest === 'string' ? data.guest : null;
    this.onClose = typeof data?.onClose === 'function' ? data.onClose : null;
  }

  create() {
    session.scene = 'Menu';
    // 選單一定在最上層（UI 場景會被 Map bringToTop，ChapterEnd 在場景清單裡排在後面）
    this.scene.bringToTop();
    // 壓暗並擋住下層（HUD、觸控區、地圖）的點擊
    this.dim = this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x05070a, 0.78).setOrigin(0).setInteractive();
    panel(this, 16, 70, WIDTH - 32, HEIGHT - 140);
    this.title = addText(this, WIDTH / 2, 104, '', { fontSize: '20px', fontStyle: 'bold', color: '#f0d2a0' }).setOrigin(0.5);
    this.note = addText(this, WIDTH / 2, 136, '', {
      fontSize: '13px', color: COLORS.textDim, align: 'center', wordWrap: { width: WIDTH - 72, useAdvancedWrap: true },
    }).setOrigin(0.5, 0);
    this.list = null;
    this.extra = [];
    this.pageSeq = 0;
    this.pageCleanup = [];
    this.backAction = null;
    this.cloudView = null;
    this.events.once('shutdown', () => this.runPageCleanup());
    this.input.keyboard.on('keydown', (ev) => {
      // 輸入框（轉移碼）與回報文字框裡的按鍵由它們自己處理，不當成選單操作
      if (typeof HTMLInputElement !== 'undefined' && ev.target instanceof HTMLInputElement) return;
      if (typeof HTMLTextAreaElement !== 'undefined' && ev.target instanceof HTMLTextAreaElement) return;
      if (ev.repeat || !claimKey(ev)) return;
      if (ev.code === 'Escape') { this.back(); return; }
      this.list?.handleKey(ev.code);
    });
    if (this.mode === 'load') this.showSlots('load');
    else if (this.mode === 'save') this.showSlots('save');
    else if (this.mode === 'transfer') this.showTransferInput();
    else if (this.mode === 'trade') this.showTrade(0);
    else if (this.mode === 'feedback') this.showFeedback();
    else this.showMain();
  }

  runPageCleanup() {
    const fns = this.pageCleanup ?? [];
    this.pageCleanup = [];
    for (const fn of fns) {
      try { fn(); } catch (e) { console.warn('選單頁面清理失敗', e); }
    }
  }

  /**
   * maxBottom：按鈕清單最下緣不能超過的 y（說明文字把清單往下推時，先縮間距、再縮按鈕高度，最矮 44）。
   */
  setPage(page, title, note, items, { y = 200, h = 52, fontSize = 17, gap = 10, noteAlign = 'center', maxBottom = null } = {}) {
    this.page = page;
    this.pageSeq += 1; // 進行中的雲端請求回來時，用這個判斷頁面是否已經換掉
    this.backAction = null;
    this.cloudView = null;
    this.runPageCleanup();
    this.list?.destroy();
    this.extra.forEach((o) => o.destroy());
    this.extra = [];
    this.title.setText(title);
    // 說明文字：一般置中；隊伍成員的詳細資料（多行清單）靠左
    if (noteAlign === 'left') this.note.setAlign('left').setOrigin(0, 0).setX(32).setWordWrapWidth(WIDTH - 64, true);
    else this.note.setAlign('center').setOrigin(0.5, 0).setX(WIDTH / 2).setWordWrapWidth(WIDTH - 72, true);
    this.note.setText(note ?? '');
    const top = this.note.text ? Math.max(y, 136 + this.note.height + 24) : y;
    if (maxBottom !== null && items.length > 0) {
      const n = items.length;
      const over = () => top + n * h + (n - 1) * gap > maxBottom;
      if (over() && n > 1) gap = Math.max(4, Math.floor((maxBottom - top - n * h) / (n - 1)));
      if (over()) h = Math.max(44, Math.floor((maxBottom - top - (n - 1) * gap) / n));
    }
    this.pageItems = items;
    this.list = new ButtonList(this, { x: WIDTH / 2, y: top + h / 2, w: WIDTH - 72, h, gap, items, align: 'left', fontSize });
    // 副標（名字、損壞原因）太長時以「…」截斷：只截名字／原因的部分
    this.list.buttons.forEach((b, i) => {
      const it = items[i];
      if (!b.sub) return;
      const room = b.w - 24;
      if (it.subName !== undefined) fitPart(b.sub, it.subName, it.subRender, room);
      else if (String(it.sub).includes('\n')) { /* 多行副標（交換清單）：不截斷，太寬時由 b.fit() 等比縮小 */ }
      else fitText(b.sub, it.sub, room);
      b.fit();
    });
  }

  /** E2E 用的唯讀資訊。 */
  debugInfo() {
    return {
      page: this.page,
      title: this.title.text,
      note: this.note.text,
      dimmed: this.dim.visible && this.dim.fillAlpha >= 0.5,
      items: (this.list?.buttons ?? []).map((b, i) => ({
        id: this.pageItems?.[i]?.id ?? null,
        label: b.label.text, sub: b.sub?.text ?? null, enabled: b.enabled, focused: i === this.list.index, x: b.x, y: b.y, w: b.w, h: b.h,
        subWidth: b.sub ? b.sub.displayWidth : 0, room: b.w - 24,
      })),
      cloud: this.cloudView ?? null,
    };
  }

  /**
   * E2E 用：意見回饋提示頁是否開著、是否被瀏覽器擋下、從哪裡開的（Title／Menu）、複製回報資訊的結果
   * （copy：null｜'copied'｜'fallback'；status：提示文字；fallback：備援文字框）與各段文字的位置（邏輯座標，中心＋寬高）。沒開時為 null。
   */
  feedbackInfo() {
    if (this.page !== 'feedback') return null;
    const rect = (t, label) => (t ? { label, x: t.x, y: t.y + t.displayHeight * (0.5 - t.originY), w: t.displayWidth, h: t.displayHeight } : null);
    const box = this.reportBox;
    return {
      open: true, blocked: !!this.feedbackBlocked, origin: this.mode === 'feedback' ? this.from : 'Menu',
      copy: this.reportCopy ?? null,
      status: this.reportStatus?.text || null,
      statusRect: this.reportStatus?.text ? rect(this.reportStatus, '複製結果') : null,
      privacy: this.reportPrivacy?.text ?? null,
      privacyRect: rect(this.reportPrivacy, '隱私提示'),
      fallback: box ? { label: '回報文字框', tag: box.el.tagName, readOnly: box.el.readOnly, x: box.x, y: box.y, w: box.w, h: box.h } : null,
    };
  }

  showMain(note = null) {
    const blocked = !session.storageAvailable;
    const hasParty = (session.data?.characters ?? []).length > 0;
    const items = [
      { label: '存檔', enabled: !blocked, onSelect: () => this.showSlots('save') },
      { label: '讀取', enabled: !blocked, onSelect: () => this.showSlots('load') },
      { label: '雲端存檔', enabled: !blocked, onSelect: () => this.showCloud() },
      { label: '道具', onSelect: () => this.showItems(0) },
    ];
    if (hasParty) items.push({ label: '隊伍', onSelect: () => this.showParty() });
    items.push(
      { id: 'feedback', label: FEEDBACK_LABEL, onSelect: () => this.showFeedback() },
      { label: '回標題', onSelect: () => this.confirmTitle() },
      { label: '返回遊戲', onSelect: () => this.close() },
    );
    // 最多 8 項：從標題下方開始排，最下緣留在面板（y 70～570）內
    this.setPage('main', '選單', note ?? (blocked ? BLOCKED_MSG : null), items, { y: 136, h: 46, gap: 8, maxBottom: 562 });
  }

  // ---------- 意見回饋 ----------
  /**
   * 提示頁：「複製回報資訊」把回報文字複製到剪貼簿（失敗時改顯示唯讀文字框讓玩家手動複製）；
   * 「前往討論區」開新分頁（在按鍵／點擊的同步處理中呼叫 window.open）；「取消」或 Esc 回到原畫面。
   * copy：null｜{ kind:'copied' }｜{ kind:'fallback', text }。
   */
  showFeedback(blocked = false, copy = null) {
    this.setPage('feedback', FEEDBACK_TITLE, feedbackNoteForDisplay(blocked ? feedbackBlockedText() : FEEDBACK_BODY), [
      { id: 'feedback-copy', label: REPORT_COPY_LABEL, onSelect: () => this.copyReport() },
      { id: 'feedback-go', label: FEEDBACK_GO, onSelect: () => this.goFeedback() },
      { id: 'feedback-cancel', label: FEEDBACK_CANCEL, onSelect: () => this.leaveFeedback() },
    ], { y: 228, h: 48, gap: 8 });
    this.feedbackBlocked = blocked;
    this.reportCopy = copy?.kind ?? null;
    this.reportBox = null;
    this.backAction = () => this.leaveFeedback();

    const last = this.list.buttons.at(-1);
    let y = last.y + last.h / 2 + 10;
    this.reportStatus = addText(this, WIDTH / 2, y, copy ? (copy.kind === 'copied' ? REPORT_COPIED : REPORT_COPY_FAILED) : '', {
      fontSize: '13px', color: COLORS.textGas, align: 'center', wordWrap: { width: WIDTH - 72, useAdvancedWrap: true },
    }).setOrigin(0.5, 0);
    this.extra.push(this.reportStatus);
    // 隱私提示：固定在面板最下方
    this.reportPrivacy = addText(this, WIDTH / 2, 552, REPORT_PRIVACY, { fontSize: '11px', color: COLORS.textDim }).setOrigin(0.5);
    this.extra.push(this.reportPrivacy);
    if (copy?.kind === 'fallback') {
      y += this.reportStatus.height + 8;
      this.showReportBox(copy.text, y, 552 - this.reportPrivacy.height / 2 - 8);
    }
  }

  /** 剪貼簿不能用時的備援：唯讀的 textarea（只設 value，不經 HTML），點一下就全選。 */
  showReportBox(text, top, bottom) {
    const w = WIDTH - 72;
    const h = Math.max(48, Math.floor(bottom - top));
    const el = document.createElement('textarea');
    el.className = 'sl-report-text';
    el.readOnly = true;
    el.value = text;
    el.spellcheck = false;
    el.setAttribute('aria-label', '回報資訊');
    el.setAttribute('wrap', 'soft');
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    const selectAll = () => { try { el.focus({ preventScroll: true }); el.setSelectionRange(0, el.value.length); } catch { /* 少數瀏覽器不支援：玩家可手動選取 */ } };
    el.addEventListener('focus', selectAll);
    el.addEventListener('click', selectAll);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.leaveFeedback(); }
    });
    const dom = this.add.dom(WIDTH / 2, top + h / 2, el);
    this.extra.push(dom);
    this.reportBox = { el, x: WIDTH / 2, y: top + h / 2, w, h };
    // 文字框聚焦時不能讓 Phaser 吃掉按鍵（全選、複製的快捷鍵）
    this.input.keyboard.disableGlobalCapture();
    this.pageCleanup.push(() => {
      this.reportBox = null;
      this.input.keyboard.enableGlobalCapture();
    });
  }

  /** 回報資訊：遊戲中附目前進度與存檔；標題畫面附最近一次讀取或存檔的槽位。不含雲端權杖或轉移碼（見 ui/report-info.js）。 */
  reportText() {
    const backend = session.backend;
    const inGame = this.mode !== 'feedback' && session.state;
    let cloudEnabled = false;
    try { cloudEnabled = cloud.enabled(); } catch { /* 讀不到雲端資訊＝未啟用 */ }
    return buildReportInfo({
      state: inGame ? session.snapshot() : null,
      data: session.data,
      env: {
        version: GAME_VERSION,
        now: new Date(),
        userAgent: navigator.userAgent,
        screen: { width: window.innerWidth, height: window.innerHeight },
        cloudEnabled,
        lastSave: inGame ? null : readLastSave(backend),
        secrets: collectCloudSecrets(backend),
      },
    });
  }

  /** 複製回報資訊：writeText 在按鍵／點擊的同步處理中送出；結果回來時頁面沒換才更新。 */
  copyReport() {
    let text;
    try {
      text = this.reportText();
    } catch (e) {
      console.warn('無法產生回報資訊', e);
      return;
    }
    const ticket = this.pageSeq;
    const blocked = !!this.feedbackBlocked;
    copyText(text).then((ok) => {
      if (this.page !== 'feedback' || this.pageSeq !== ticket || !this.sys.isActive()) return;
      this.showFeedback(blocked, ok ? { kind: 'copied' } : { kind: 'fallback', text });
    });
  }

  goFeedback() {
    if (openFeedback(window)) this.leaveFeedback();
    else this.showFeedback(true);
  }

  /** 回到開啟提示的畫面：標題（關閉選單）或遊戲中選單的主頁；遊戲狀態不動。 */
  leaveFeedback() {
    this.feedbackBlocked = false;
    this.reportCopy = null;
    if (this.mode === 'feedback') this.close();
    else this.showMain();
  }

  // ---------- 道具 ----------
  /** 持有的道具：地圖上能用的（field_effects）可以選，其他（戰鬥用、劇情道具）只列出來。 */
  itemRows() {
    const s = session.state;
    const usable = new Map(fieldItems(s, session.data).map((it) => [it.id, it]));
    const rows = [];
    for (const [id, count] of Object.entries(s?.items ?? {})) {
      if (!Number.isInteger(count) || count <= 0) continue;
      const def = (session.data?.items ?? []).find((x) => x.id === id);
      const name = def?.name ?? id;
      if (usable.has(id)) rows.push({ id, label: `${name}　×${count}`, sub: def?.desc ?? '', usable: true });
      else rows.push({ id, label: `${name}　×${count}`, sub: Array.isArray(def?.battle_effects) ? '戰鬥中才能使用' : '劇情道具', usable: false });
    }
    return rows.sort((a, b) => Number(b.usable) - Number(a.usable));
  }

  showItems(page = 0, note = null) {
    const rows = this.itemRows();
    const pages = Math.max(1, Math.ceil(rows.length / ITEMS_PER_PAGE));
    const p = Math.min(Math.max(0, page), pages - 1);
    const items = rows.slice(p * ITEMS_PER_PAGE, (p + 1) * ITEMS_PER_PAGE).map((r) => ({
      label: r.label, sub: r.sub, enabled: r.usable, onSelect: () => this.useItem(r.id, p),
    }));
    if (pages > 1) items.push({ label: `下一頁（${p + 1}/${pages}）`, onSelect: () => this.showItems((p + 1) % pages) });
    items.push({ label: '返回', onSelect: () => this.showMain() });
    const msg = note ?? (rows.length === 0 ? '沒有任何道具' : (rows.some((r) => r.usable) ? '選擇要使用的道具' : '目前沒有可以在這裡使用的道具'));
    this.itemPage = p;
    this.setPage('items', '道具', msg, items, { h: 56, fontSize: 15 });
  }

  useItem(id, page) {
    let next;
    try {
      next = useFieldItem(id, session.state, session.data);
    } catch (e) {
      console.warn('無法使用道具', e);
      this.showItems(page, '這個道具現在不能使用');
      return;
    }
    const def = (session.data?.items ?? []).find((x) => x.id === id);
    session.setState(next);
    this.showItems(page, `使用了${def?.name ?? id}`);
  }

  // ---------- 隊伍 ----------
  showParty() {
    let list = [];
    try {
      list = partyStatus(session.state, session.data);
    } catch (e) {
      console.warn('partyStatus 失敗', e);
    }
    const items = list.map((m) => ({
      label: `${m.name}　生命 ${m.hp}/${m.max.hp}　靈性 ${m.sp}/${m.max.sp}`,
      sub: STAT_LABELS.map(([k, n]) => `${n} ${m.max[k]}`).join('　'),
      onSelect: () => this.showMember(m.id),
    }));
    if (session.state?.lineage) {
      let next = null;
      try { next = promotionProgress(session.state, session.data).next; } catch (e) { console.warn('promotionProgress 失敗', e); }
      items.push({ label: '晉升進度', sub: next ? `下一階：${next.name}（階 ${next.rank}）` : '目前沒有可以晉升的下一階', onSelect: () => this.showPromotion() });
    }
    items.push({ label: '返回', onSelect: () => this.showMain() });
    this.setPage('party', '隊伍', `子彈 ${session.state?.ammo ?? 0}　崩解 ${session.state?.collapse ?? 0}/100`, items, { h: 58, fontSize: 15 });
  }

  showMember(id) {
    const m = partyStatus(session.state, session.data).find((x) => x.id === id);
    if (!m) { this.showParty(); return; }
    const skills = availableSkills(id, session.state, session.data).map((sid) => {
      const sk = (session.data?.skills ?? []).find((x) => x.id === sid);
      // 數字前用不換行空白，避免自動換行把「（靈性」和「6）」拆到兩行
      const cost = [sk?.cost?.sp ? `靈性\u00a0${sk.cost.sp}` : null, sk?.cost?.ammo ? `子彈\u00a0${sk.cost.ammo}` : null].filter(Boolean).join('・');
      return `・${sk?.name ?? sid}${cost ? `（${cost}）` : ''}：${sk?.desc ?? ''}`;
    });
    const lin = this.lineageName(id);
    const note = [
      lin ? `譜系：${lin}` : null,
      `生命 ${m.hp}/${m.max.hp}　靈性 ${m.sp}/${m.max.sp}`,
      STAT_LABELS.map(([k, n]) => `${n} ${m.max[k]}`).join('　'),
      '',
      '技能',
      ...skills,
    ].filter((x) => x !== null).join('\n');
    this.memberSkills = skills;
    this.setPage('member', m.name, note, [{ label: '返回', onSelect: () => this.showParty() }], { y: 420, noteAlign: 'left' });
  }

  // ---------- 晉升進度（M5） ----------
  showPromotion() {
    let v;
    try {
      v = promotionProgress(session.state, session.data);
    } catch (e) {
      console.warn('promotionProgress 失敗', e);
      v = { lines: ['晉升資料有問題，暫時無法顯示。'] };
    }
    this.setPage('promotion', '晉升進度', v.lines.join('\n'), [{ label: '返回', onSelect: () => this.showParty() }], { y: 440, noteAlign: 'left' });
  }

  // ---------- 交換（M5） ----------
  guestName() {
    const g = this.guestId ? guestFor(this.guestId, session.state, session.data) : null;
    return typeof g?.name === 'string' ? g.name : '夢客';
  }

  showTrade(page = 0, note = null) {
    let rows = [];
    try {
      rows = tradeRows(this.guestId, session.state, session.data);
    } catch (e) {
      console.warn('交換清單有問題', e);
    }
    const pages = Math.max(1, Math.ceil(rows.length / TRADES_PER_PAGE));
    const p = Math.min(Math.max(0, page), pages - 1);
    const items = rows.slice(p * TRADES_PER_PAGE, (p + 1) * TRADES_PER_PAGE).map((r) => ({
      id: r.id, label: r.label, sub: r.sub, enabled: r.enabled, onSelect: () => this.confirmTrade(r.id, p),
    }));
    if (pages > 1) items.push({ label: `下一頁（${p + 1}/${pages}）`, onSelect: () => this.showTrade((p + 1) % pages) });
    items.push({ label: '離開', onSelect: () => this.close() });
    const name = this.guestName();
    const msg = note ?? (rows.length === 0 ? `${name}現在沒有東西可以和你交換。` : '選擇要交換的項目');
    this.tradePage = p;
    this.setPage('trade', `與${name}交換`, msg, items, { h: 66, fontSize: 15, gap: 6 });
  }

  confirmTrade(tradeId, page) {
    const c = tradeConfirm(this.guestId, tradeId, session.state, session.data);
    if (!c) { this.showTrade(page, '這個交換已經不能做了'); return; }
    this.setPage('trade_confirm', c.label, c.lines.join('\n'), [
      { label: '交換', enabled: c.affordable, onSelect: () => this.doTrade(c, page) },
      { label: '取消', onSelect: () => this.showTrade(page) },
    ], { y: 240 });
    this.backAction = () => this.showTrade(page);
  }

  doTrade(c, page) {
    let next;
    try {
      next = applyTrade(c.id, session.state, session.data, this.guestId);
    } catch (e) {
      console.warn('交換失敗', e);
      this.showTrade(page, `無法交換：${e?.message ?? e}`);
      return;
    }
    session.setState(next);
    this.showTrade(page, tradeDoneText(c));
  }

  lineageName(id) {
    const lin = id === 'hero' ? session.state?.lineage : (session.data?.characters ?? []).find((c) => c.id === id)?.lineage;
    if (!lin) return null;
    const def = (session.data?.lineages ?? []).find((l) => l.id === lin.id);
    const rank = def?.ranks?.find((r) => r.rank === lin.rank);
    return rank ? `${rank.name}（階 ${lin.rank}）` : null;
  }

  slotItems(kind) {
    return session.slotSummaries().map((s) => {
      if (s.kind === 'empty') {
        return { label: `存檔 ${s.slot}　（空）`, sub: '尚未使用', enabled: kind === 'save', onSelect: () => this.saveTo(s.slot, false) };
      }
      if (s.kind === 'ok') {
        const time = formatPlaytime(s.playtime_s);
        const render = (name) => `${name}｜遊戲時間 ${time}`;
        return {
          label: `存檔 ${s.slot}　${session.mapName(s.map)}`,
          sub: render(s.name), subName: s.name, subRender: render,
          onSelect: () => (kind === 'save' ? this.saveTo(s.slot, true) : this.loadFrom(s.slot)),
        };
      }
      // 損壞或版本較新：不能讀，只能（在存檔模式）覆蓋
      return {
        label: s.kind === 'newer' ? `存檔 ${s.slot}　版本較新，請更新遊戲` : `存檔 ${s.slot}　已損壞`,
        sub: s.reason || '存檔損壞',
        enabled: kind === 'save',
        onSelect: () => this.saveTo(s.slot, true),
      };
    });
  }

  showSlots(kind, note = null) {
    if (!session.storageAvailable) {
      this.setPage(kind, kind === 'save' ? '存檔' : '讀取', BLOCKED_MSG, [{ label: '返回', onSelect: () => this.back() }]);
      return;
    }
    const items = this.slotItems(kind);
    items.push({ label: '返回', onSelect: () => this.back() });
    this.setPage(kind, kind === 'save' ? '存檔' : '讀取', note ?? (kind === 'save' ? '選擇要存檔的位置' : '選擇要讀取的存檔'), items, { h: 58, fontSize: 15 });
  }

  saveTo(slot, occupied) {
    if (occupied) {
      this.setPage('confirm', '覆蓋存檔', `存檔 ${slot} 已經有資料，確定要覆蓋嗎？`, [
        { label: '覆蓋', onSelect: () => this.doSave(slot) },
        { label: '取消', onSelect: () => this.showSlots('save') },
      ], { y: 220 });
      this.list.focus(1);
      return;
    }
    this.doSave(slot);
  }

  doSave(slot) {
    session.foldPlaytime();
    const r = session.storage.save(slot, session.snapshot());
    if (r.ok) rememberLastSlot(session.backend, slot); // 標題畫面的回報資訊附上這一格
    if (r.ok) this.afterManualSave(slot);
    else this.showSlots('save', `${BLOCKED_MSG}\n（${r.reason}）`);
  }

  /** 讀檔：deserialize → sanitizeLoadedState；拒絕時留在選單顯示原因，有警告時進地圖後提示。 */
  loadFrom(slot) {
    const r = session.loadSlot(slot);
    if (!r.ok) {
      this.showSlots('load', `無法讀取存檔 ${slot}：${r.reason}`);
      return;
    }
    rememberLastSlot(session.backend, slot); // 標題畫面的回報資訊附上這一格
    this.enterGame(r.state, r.warnings);
  }

  /** 以讀到的 state 進入遊戲（讀檔、雲端「直接讀取」）。 */
  enterGame(state, warnings = []) {
    session.reset();
    session.setState(state);
    this.scene.stop('UI');
    if (this.from !== 'Map') this.scene.stop(this.from);
    this.scene.stop('Map');
    const target = session.resumeTarget(state, warnings);
    // resumed：讀檔回到章節結束畫面時不再回報通關
    this.scene.start(target.scene, { ...target.data, resumed: true });
  }

  confirmTitle() {
    this.setPage('confirm', '回標題', '尚未存檔的進度會遺失，確定要回到標題畫面嗎？', [
      { label: '回標題', onSelect: () => this.toTitle() },
      { label: '取消', onSelect: () => this.showMain() },
    ], { y: 220 });
    this.list.focus(1);
  }

  toTitle() {
    this.scene.stop('UI');
    this.scene.stop('Map');
    if (this.from !== 'Map') this.scene.stop(this.from);
    this.scene.start('Title');
  }

  back() {
    if (this.backAction) { this.backAction(); return; }
    if (this.page === 'confirm') {
      if (this.title.text === '回標題') this.showMain(); else this.showSlots('save');
      return;
    }
    if ((this.page === 'save' || this.page === 'load' || this.page === 'items' || this.page === 'party') && this.mode === 'game') { this.showMain(); return; }
    if (this.page === 'member' || this.page === 'promotion') { this.showParty(); return; }
    this.close();
  }

  close() {
    if (this.mode === 'transfer' && this.from === 'Title') {
      // 轉移後本機存檔可能變了：重新開始標題畫面（更新「繼續」是否可用）
      this.scene.start('Title');
      return;
    }
    if (this.from === 'Map') {
      this.scene.resume('UI');
      this.scene.resume('Map');
    } else {
      this.scene.resume(this.from);
    }
    const cb = this.onClose;
    this.onClose = null;
    this.scene.stop();
    cb?.();
  }
}

Object.assign(MenuScene.prototype, cloudPages);
