// 戰鬥畫面（直向 360×640）：上方行動順序、中間敵人、下方我方隊伍與指令選單。
// 規則全部在 core/battle/engine.js；這裡只負責「把 log 一個一個播出來」與「讓玩家選指令」。
//
// 流程：create → startBattle（開場 log）→ 迴圈 { 我方：選指令 → act；敵方：advanceEnemy（一次一個） }
//      → 結束：勝利／逃脫／教學戰戰敗（on_lose: continue）→ 結果畫面 →「繼續」回地圖；
//              戰敗／失控（retry）→ GameOver 場景。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, Button, panel, fitText } from '../ui/widgets.js';
import { DialogueBox } from '../ui/DialogueBox.js';
import {
  startBattle, currentActor, isPlayerTurn, commands, act, advanceEnemy, turnOrder, finishBattle, intentOf,
} from '../core/battle/engine.js';
import { battleSpriteKey, battleSpriteSize, bgKey, spriteKey, BG_H } from '../textures.js';
import {
  unitLabels, shortLabel, formatIntent, revealedIntent, describe, costText, reasonText, rewardLines, STATUS_NAMES, STAT_NAMES, OUTCOME_TITLE,
  commandPrompt,
} from '../battle-view.js';

// ---------- 版面（邏輯座標） ----------
const ORDER = { y: 22, x0: 52, w: 46, h: 30, gap: 5 };
const FIELD_TOP = 44;
const ENEMY_Y = 168;
const MSG_Y = 308;
const PARTY = { y0: 340, h: 34, x: 8, w: WIDTH - 16 };
const RES_Y = 446;
/** 指令區：3 列最底到 630，離畫面底邊留 10px 安全區（手機的 Home 指示條、圓角）。 */
const CMD = { top: 462, colX: [94, 266], w: 164, h: 52, gapY: 6 };
const LIST = { top: 330, w: WIDTH - 24, h: 50, gap: 6, perPage: 4 };
/** 技能是否放在第一層指令（資料的 menu: "root"）；其他技能放進「技能」子選單。 */
const isRootSkill = (id) => (session.data?.skills ?? []).find((s) => s?.id === id)?.menu === 'root';
/** 技能在 skills.json 的位置（第一層依這個順序排列）。 */
const skillIndex = (id) => (session.data?.skills ?? []).findIndex((s) => s?.id === id);
const HISTORY_MAX = 300;
const DEPTH = { field: 1, units: 5, fx: 20, ui: 30, overlay: 40, cmd: 45 };
const MS = (ms) => (TEST_MODE ? 0 : ms);

export class BattleScene extends Phaser.Scene {
  constructor() { super('Battle'); }

  init(data) {
    this.encounterId = data?.encounter ?? null;
    this.seed = Number.isFinite(data?.seed) ? data.seed : 1;
    this.notice = typeof data?.notice === 'string' && data.notice ? data.notice : null;
    // 重新挑戰的那場戰鬥：{ retry: true, preCollapse }（GameOver 用 core 的 retryOptions 產生；規格補充 3 第 1 條）
    this.retry = data?.retry?.retry === true ? data.retry : null;
  }

  create() {
    session.scene = 'Battle';
    // 場景物件會被重複使用（每場戰鬥都是同一個 BattleScene），所有狀態都要在這裡重設
    this.ended = false;
    this.leaving = false;
    this.turnResolve = null;
    this.cmdHidden = false;
    this.targetUids = null;
    this.targetPick = null;
    this.resultText = null;
    this.colLabel = null;
    this.toastTimer = null;
    this.mode = 'busy';
    this.menu = null;
    this.menuObjs = [];
    this.result = null;
    this.allLog = [];
    this.message = '';
    this.cursor = null;
    // 被預兆揭露的意圖：uid → 意圖（施放當下由 intent_revealed 事件寫入，該敵人行動或倒下時移除）
    this.revealed = new Map();
    // E2E 用的歷程：畫面出現過的訊息、敵人頭上出現過的意圖、提示
    this.msgHistory = [];
    this.intentHistory = [];
    this.notices = [];
    this.cameras.main.setBackgroundColor(COLORS.bg);
    const data = session.data;
    this.enc = (data.encounters ?? []).find((e) => e.id === this.encounterId) ?? null;

    try {
      this.b = startBattle(this.encounterId, session.state, data, this.seed, this.retry ?? undefined);
    } catch (e) {
      console.warn('無法開始戰鬥', e);
      this.b = null;
    }

    this.drawStatic();
    this.dialogue = new DialogueBox(this);
    this.toastText = addText(this, WIDTH / 2, FIELD_TOP + 8, '', {
      fontSize: '14px', color: '#ffe2b0', backgroundColor: '#1a1f28ee', padding: { x: 12, y: 6 },
    }).setOrigin(0.5, 0).setDepth(60).setVisible(false);

    this.input.keyboard.on('keydown', (ev) => this.onKey(ev));
    this.events.once('shutdown', () => { this.ended = true; });

    if (!this.b) {
      this.setMessage('戰鬥資料有問題，已略過這場戰鬥');
      this.time.delayedCall(MS(800), () => this.returnToMap({ state: session.state, outcome: 'fled', rewards: { items: [] }, next: null }));
      return;
    }
    this.labels = unitLabels(this.b);
    this.disp = {};
    for (const u of this.b.units) this.disp[u.uid] = { hp: u.hp, sp: u.sp };
    this.dispAmmo = this.b.ammo;
    this.dispCollapse = this.b.collapse;
    this.buildUnits();
    this.refreshAll();
    if (this.notice) this.toast(this.notice, 3200);
    this.cameras.main.fadeIn(MS(250), 0, 0, 0);
    this.run().catch((e) => {
      console.warn('戰鬥流程發生錯誤', e);
      this.setMessage('戰鬥流程發生錯誤，已結束戰鬥');
      this.returnToMap({ state: session.state, outcome: 'fled', rewards: { items: [] }, next: null });
    });
  }

  update(_t, delta) {
    session.elapsed += delta / 1000; // 戰鬥時間也算遊戲時間（回地圖後由 Map 併入）
  }

  // ---------- 靜態版面 ----------
  drawStatic() {
    const bg = this.enc?.bg && this.textures.exists(bgKey(this.enc.bg)) ? bgKey(this.enc.bg) : bgKey('__default');
    this.add.image(0, FIELD_TOP, bg).setOrigin(0).setDepth(DEPTH.field);
    const g = this.add.graphics().setDepth(DEPTH.field);
    // 行動順序列
    g.fillStyle(0x0d1015, 0.95);
    g.fillRect(0, 0, WIDTH, FIELD_TOP);
    g.lineStyle(1, COLORS.gasDeep, 1);
    g.lineBetween(0, FIELD_TOP - 0.5, WIDTH, FIELD_TOP - 0.5);
    addText(this, 8, ORDER.y, '順序', { fontSize: '12px', color: COLORS.textDim }).setOrigin(0, 0.5).setDepth(DEPTH.ui);
    // 下半部底板
    const lowTop = FIELD_TOP + BG_H;
    g.fillStyle(0x0d1015, 0.97);
    g.fillRect(0, lowTop, WIDTH, HEIGHT - lowTop);
    g.lineStyle(1, COLORS.line, 1);
    g.lineBetween(0, lowTop + 0.5, WIDTH, lowTop + 0.5);
    g.lineBetween(0, CMD.top - 8.5, WIDTH, CMD.top - 8.5);
    this.msgText = addText(this, WIDTH / 2, MSG_Y, '', {
      fontSize: '14px', color: '#f0d2a0', align: 'center', wordWrap: { width: WIDTH - 24, useAdvancedWrap: true },
    }).setOrigin(0.5).setDepth(DEPTH.ui);
    this.orderObjs = [];
    this.resText = addText(this, 12, RES_Y, '', { fontSize: '13px', color: COLORS.text }).setOrigin(0, 0.5).setDepth(DEPTH.ui);
    this.colText = addText(this, WIDTH - 12, RES_Y, '', { fontSize: '13px', color: COLORS.text }).setOrigin(1, 0.5).setDepth(DEPTH.ui);
    this.colBar = this.add.graphics().setDepth(DEPTH.ui);
    this.vignette = this.add.image(WIDTH / 2, HEIGHT / 2, 'fx:vignette').setDisplaySize(WIDTH, HEIGHT).setAlpha(0).setDepth(DEPTH.fx);
  }

  // ---------- 單位（敵人立繪、我方列） ----------
  buildUnits() {
    this.unitViews = new Map();
    let pi = 0;
    for (const u of this.b.units) {
      if (u.side === 'party') this.makePartyRow(u, pi++);
      else this.makeEnemyView(u);
    }
    this.layoutEnemies(false);
  }

  makeEnemyView(u) {
    const size = battleSpriteSize(u.sprite);
    const key = this.textures.exists(battleSpriteKey(u.sprite)) ? battleSpriteKey(u.sprite) : spriteKey('unknown');
    const c = this.add.container(WIDTH / 2, ENEMY_Y).setDepth(DEPTH.units);
    const shadow = this.add.ellipse(0, size / 2 - 2, size * 0.8, 10, 0x000000, 0.35);
    const img = this.add.image(0, 0, key).setDisplaySize(size, size);
    const name = addText(this, 0, -size / 2 - 24, '', { fontSize: '12px', color: COLORS.text, stroke: '#0d1015', strokeThickness: 3 }).setOrigin(0.5);
    const bar = this.add.graphics();
    const status = addText(this, 0, size / 2 + 8, '', { fontSize: '11px', color: '#b4c8e0', stroke: '#0d1015', strokeThickness: 3 }).setOrigin(0.5);
    const intent = addText(this, 0, size / 2 + 24, '', {
      fontSize: '12px', color: '#ffd08a', align: 'center', stroke: '#0d1015', strokeThickness: 3, wordWrap: { width: 112, useAdvancedWrap: true },
    }).setOrigin(0.5, 0);
    const cursor = addText(this, 0, -size / 2 - 42, '▼', { fontSize: '16px', color: '#ffd08a', stroke: '#0d1015', strokeThickness: 3 }).setOrigin(0.5).setVisible(false);
    const hitW = Math.max(size, 72);
    const hit = this.add.rectangle(0, -6, hitW, size + 40, 0x000000, 0).setInteractive({ useHandCursor: true });
    hit.on('pointerup', () => this.onUnitTap(u.uid));
    c.add([shadow, img, name, bar, status, intent, cursor, hit]);
    this.unitViews.set(u.uid, { side: 'enemy', c, img, name, bar, status, intent, cursor, hit, size, hitW });
  }

  makePartyRow(u, i) {
    const y = PARTY.y0 + i * PARTY.h;
    const c = this.add.container(0, y).setDepth(DEPTH.units);
    const frame = this.add.graphics();
    const icon = this.add.image(PARTY.x + 18, 0, this.textures.exists(spriteKey(u.sprite)) ? spriteKey(u.sprite) : spriteKey('unknown'));
    const name = addText(this, PARTY.x + 36, -7, '', { fontSize: '13px', color: COLORS.text }).setOrigin(0, 0.5);
    const status = addText(this, PARTY.x + 36, 9, '', { fontSize: '10px', color: '#b4c8e0' }).setOrigin(0, 0.5);
    const bar = this.add.graphics();
    const hpText = addText(this, 236, -6, '', { fontSize: '12px', color: COLORS.text }).setOrigin(0, 0.5);
    const spText = addText(this, 236, 9, '', { fontSize: '11px', color: '#9ec3e6' }).setOrigin(0, 0.5);
    const cursor = addText(this, PARTY.x + PARTY.w - 10, 0, '◀', { fontSize: '14px', color: '#ffd08a' }).setOrigin(1, 0.5).setVisible(false);
    const hit = this.add.rectangle(WIDTH / 2, 0, PARTY.w, PARTY.h - 2, 0x000000, 0).setInteractive({ useHandCursor: true });
    hit.on('pointerup', () => this.onUnitTap(u.uid));
    c.add([frame, icon, name, status, bar, hpText, spText, cursor, hit]);
    this.unitViews.set(u.uid, { side: 'party', c, frame, icon, name, status, bar, hpText, spText, cursor, hit, y });
  }

  /** 敵人依目前存活者平均排開。 */
  layoutEnemies(animate = true) {
    const alive = this.b.units.filter((u) => u.side === 'enemy' && (u.alive || this.unitViews.get(u.uid)?.fading));
    const n = alive.length;
    alive.forEach((u, i) => {
      const v = this.unitViews.get(u.uid);
      if (!v) return;
      const x = Math.round((WIDTH * (i + 1)) / (n + 1));
      v.intent.setWordWrapWidth(n >= 3 ? 104 : 150);
      if (animate && !TEST_MODE) this.tweens.add({ targets: v.c, x, duration: 220 });
      else v.c.x = x;
    });
  }

  unitById(uid) { return this.b.units.find((u) => u.uid === uid); }

  // ---------- 重畫 ----------
  refreshAll() {
    if (!this.b) return;
    this.labels = unitLabels(this.b);
    for (const u of this.b.units) this.refreshUnit(u);
    this.refreshOrder();
    this.refreshResources();
  }

  statusLine(u) {
    const parts = Object.entries(u.status ?? {}).filter(([, t]) => t > 0).map(([k, t]) => `${STATUS_NAMES[k] ?? k}${t}`);
    for (const [key, m] of Object.entries(u.mods ?? {})) {
      const [kind, stat] = key.split(':');
      parts.push(`${STAT_NAMES[stat] ?? stat}${kind === 'buff' ? '↑' : '↓'}`);
    }
    return parts.join(' ');
  }

  refreshUnit(u) {
    const v = this.unitViews.get(u.uid);
    if (!v) return;
    const d = this.disp[u.uid] ?? { hp: u.hp, sp: u.sp };
    const max = Math.max(1, u.stats.hp);
    const ratio = Math.max(0, Math.min(1, d.hp / max));
    const actor = this.b.actor === u.uid && this.b.outcome === null;
    if (v.side === 'enemy') {
      v.name.setText(`${this.labels[u.uid]}　${d.hp}/${u.stats.hp}`);
      const bw = 72;
      const by = -v.size / 2 - 12;
      v.bar.clear();
      v.bar.fillStyle(0x0d1015, 0.9).fillRect(-bw / 2 - 1, by - 1, bw + 2, 8);
      v.bar.fillStyle(ratio > 0.5 ? 0xc0563a : 0xe0703a, 1).fillRect(-bw / 2, by, Math.round(bw * ratio), 6);
      v.status.setText(u.alive ? this.statusLine(u) : '');
      const rv = u.alive ? this.revealed.get(u.uid) : null;
      const it = rv ? formatIntent(rv, session.data, this.labels) : null;
      if (it && it !== v.intentStr) this.pushHistory(this.intentHistory, { uid: u.uid, text: it });
      v.intentStr = it;
      v.intent.setText(it ? `◆ ${it}` : '');
      v.img.setTint(actor ? 0xffe2b0 : 0xffffff);
      v.cursor.setVisible(this.mode === 'target' && this.cursor === u.uid);
      if (!u.alive && !v.fading && v.c.visible) v.c.setVisible(false);
    } else {
      const g = v.frame;
      g.clear();
      g.fillStyle(actor ? 0x2a2418 : 0x161a21, 0.95).fillRoundedRect(PARTY.x, -PARTY.h / 2 + 1, PARTY.w, PARTY.h - 2, 5);
      g.lineStyle(actor ? 2 : 1, actor ? COLORS.gas : COLORS.line, 1).strokeRoundedRect(PARTY.x, -PARTY.h / 2 + 1, PARTY.w, PARTY.h - 2, 5);
      fitText(v.name, this.labels[u.uid], 92);
      v.name.setColor(u.alive ? (actor ? '#ffe2b0' : COLORS.text) : COLORS.textDisabled);
      v.status.setText(u.alive ? this.statusLine(u) : '倒下');
      const bx = 136;
      const bw = 94;
      v.bar.clear();
      v.bar.fillStyle(0x222832, 1).fillRect(bx, -10, bw, 8);
      v.bar.fillStyle(ratio > 0.35 ? 0x6fa86a : 0xc0563a, 1).fillRect(bx + 1, -9, Math.round((bw - 2) * ratio), 6);
      const spMax = Math.max(1, u.stats.sp);
      v.bar.fillStyle(0x222832, 1).fillRect(bx, 5, bw, 6);
      v.bar.fillStyle(0x5a8ec0, 1).fillRect(bx + 1, 6, Math.round((bw - 2) * Math.max(0, Math.min(1, d.sp / spMax))), 4);
      v.hpText.setText(`${d.hp}/${u.stats.hp}`);
      v.spText.setText(`靈 ${d.sp}/${u.stats.sp}`);
      v.icon.setAlpha(u.alive ? 1 : 0.35);
      v.cursor.setVisible(this.mode === 'target' && this.cursor === u.uid);
    }
  }

  refreshOrder() {
    this.orderObjs.forEach((o) => o.destroy());
    this.orderObjs = [];
    const order = this.b.outcome === null ? turnOrder(this.b, 6) : [];
    order.forEach((uid, i) => {
      const u = this.unitById(uid);
      if (!u) return;
      const x = ORDER.x0 + i * (ORDER.w + ORDER.gap);
      const g = this.add.graphics().setDepth(DEPTH.ui);
      const enemy = u.side === 'enemy';
      g.fillStyle(enemy ? 0x2a1716 : 0x16212c, 1).fillRoundedRect(x, ORDER.y - ORDER.h / 2, ORDER.w, ORDER.h, 4);
      g.lineStyle(i === 0 ? 2 : 1, i === 0 ? COLORS.gas : enemy ? 0x7a3b2e : 0x3e5a78, 1).strokeRoundedRect(x, ORDER.y - ORDER.h / 2, ORDER.w, ORDER.h, 4);
      const t = addText(this, x + ORDER.w / 2, ORDER.y, shortLabel(this.labels[uid]), {
        fontSize: '13px', color: i === 0 ? '#ffe2b0' : enemy ? '#f0b0a0' : '#b4d0ec',
      }).setOrigin(0.5).setDepth(DEPTH.ui);
      if (t.width > ORDER.w - 6) t.setScale((ORDER.w - 6) / t.width);
      this.orderObjs.push(g, t);
    });
  }

  refreshResources() {
    this.resText.setText(`子彈 ${this.dispAmmo}`);
    const col = Math.max(0, Math.min(100, this.dispCollapse));
    this.colText.setText(`${col}/100`);
    const bw = 120;
    const bx = WIDTH - 12 - this.colText.width - 8 - bw;
    const g = this.colBar;
    g.clear();
    g.fillStyle(0x222832, 1).fillRect(bx, RES_Y - 4, bw, 8);
    g.fillStyle(col >= 60 ? COLORS.danger : COLORS.gas, 1).fillRect(bx + 1, RES_Y - 3, Math.round((bw - 2) * (col / 100)), 6);
    g.lineStyle(1, COLORS.line, 1).strokeRect(bx, RES_Y - 4, bw, 8);
    this.colLabel?.destroy();
    this.colLabel = addText(this, bx - 6, RES_Y, '崩解', { fontSize: '13px', color: COLORS.textDim }).setOrigin(1, 0.5).setDepth(DEPTH.ui);
  }

  setMessage(str) {
    this.message = str ?? '';
    this.msgText.setText(this.message);
    if (this.message) this.pushHistory(this.msgHistory, this.message);
  }

  pushHistory(list, item) {
    list.push(item);
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  }

  /** 播完一段 log 後，以 core 的狀態校正揭露的意圖（例如睡著、被召喚取代等事件沒有逐一對應時）。 */
  syncRevealed() {
    for (const u of this.b.units) {
      if (u.side !== 'enemy') continue;
      const it = u.alive ? intentOf(this.b, u.uid, session.data) : null;
      if (it) this.revealed.set(u.uid, { uid: u.uid, skill: it.skill, skill_name: it.skill_name, target: it.target ?? null, target_name: this.revealed.get(u.uid)?.target_name ?? null });
      else this.revealed.delete(u.uid);
    }
  }

  toast(msg, ms = 1400) {
    this.pushHistory(this.notices, msg);
    this.toastText.setText(msg).setVisible(true).setAlpha(1);
    this.toastTimer?.remove();
    this.toastTimer = this.time.delayedCall(ms, () => this.toastText.setVisible(false));
  }

  onDialogueVisible(v) {
    this.cmdHidden = v;
    for (const o of this.menuObjs) o.setVisible(!v);
  }

  // ---------- 動畫小工具 ----------
  wait(ms) {
    return new Promise((res) => this.time.delayedCall(MS(ms), res));
  }

  /** 單位畫面上的位置（浮動數字用）。 */
  posOf(uid) {
    const v = this.unitViews.get(uid);
    if (!v) return { x: WIDTH / 2, y: ENEMY_Y };
    if (v.side === 'enemy') return { x: v.c.x, y: v.c.y - v.size / 4 };
    return { x: 190, y: v.y };
  }

  floatText(uid, str, color = '#ffffff', size = 18) {
    const p = this.posOf(uid);
    const t = addText(this, p.x, p.y, str, {
      fontSize: `${size}px`, fontStyle: 'bold', color, stroke: '#0d1015', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(DEPTH.fx + 5);
    if (TEST_MODE) { this.time.delayedCall(0, () => t.destroy()); return; }
    this.tweens.add({ targets: t, y: p.y - 26, alpha: 0, duration: 700, ease: 'Cubic.easeOut', onComplete: () => t.destroy() });
  }

  shakeUnit(uid) {
    const v = this.unitViews.get(uid);
    if (!v || TEST_MODE) return;
    const target = v.side === 'enemy' ? v.img : v.c;
    const x0 = target.x;
    this.tweens.add({ targets: target, x: x0 + 4, duration: 40, yoyo: true, repeat: 2, onComplete: () => { target.x = x0; } });
  }

  // ---------- log 播放 ----------
  async playLog(log) {
    for (const ev of log) {
      if (this.ended) return;
      this.allLog.push(ev);
      await this.playEvent(ev);
    }
    this.syncDisplay();
    this.syncRevealed();
    this.refreshAll();
  }

  /** 播完一段 log 後，把顯示數值對齊實際戰鬥狀態（保險）。 */
  syncDisplay() {
    for (const u of this.b.units) this.disp[u.uid] = { hp: u.hp, sp: u.sp };
    this.dispAmmo = this.b.ammo;
    this.dispCollapse = this.b.collapse;
  }

  async playEvent(ev) {
    const msg = describe(ev, this.labels, session.data);
    switch (ev.type) {
      case 'turn_start':
        this.refreshAll();
        return;
      case 'action': {
        // 揭露的意圖一直顯示到該敵人真的行動
        if (this.revealed.delete(ev.uid)) this.refreshAll();
        this.setMessage(msg);
        const v = this.unitViews.get(ev.uid);
        if (v?.side === 'enemy' && !TEST_MODE) this.tweens.add({ targets: v.img, scale: v.img.scale * 1.12, duration: 110, yoyo: true });
        await this.wait(380);
        return;
      }
      case 'cost': {
        const d = this.disp[ev.uid];
        if (d) d.sp = Math.max(0, d.sp - (ev.sp ?? 0));
        this.dispAmmo = Math.max(0, this.dispAmmo - (ev.ammo ?? 0));
        this.refreshAll();
        return;
      }
      case 'miss':
        this.floatText(ev.target, '未命中', '#d0d4d8', 16);
        this.setMessage(msg);
        await this.wait(380);
        return;
      case 'crit':
        this.floatText(ev.target, '爆擊！', '#ffd870', 16);
        await this.wait(160);
        return;
      case 'damage': {
        const d = this.disp[ev.target];
        if (d) d.hp = ev.hp;
        this.floatText(ev.target, `-${ev.amount}`, ev.crit ? '#ffd870' : '#ff8a70', ev.crit ? 24 : 20);
        this.shakeUnit(ev.target);
        this.setMessage(msg);
        this.refreshAll();
        await this.wait(380);
        return;
      }
      case 'heal': {
        const d = this.disp[ev.target];
        if (d) d.hp = ev.hp;
        this.floatText(ev.target, `+${ev.amount}`, '#8fe08a');
        this.setMessage(msg);
        this.refreshAll();
        await this.wait(360);
        return;
      }
      case 'sp': {
        const d = this.disp[ev.target];
        if (d) d.sp = ev.sp;
        this.floatText(ev.target, `${ev.amount >= 0 ? '+' : ''}${ev.amount} 靈`, '#9ec3e6', 16);
        this.setMessage(msg);
        this.refreshAll();
        await this.wait(300);
        return;
      }
      case 'buff':
      case 'debuff':
        this.floatText(ev.target, `${STAT_NAMES[ev.stat] ?? ev.stat}${ev.type === 'buff' ? '↑' : '↓'}`, ev.type === 'buff' ? '#9ec3e6' : '#e0a0a0', 15);
        this.setMessage(msg);
        this.refreshAll();
        await this.wait(300);
        return;
      case 'status':
        this.floatText(ev.target, STATUS_NAMES[ev.status] ?? ev.status, '#b4c8e0', 15);
        this.setMessage(msg);
        this.refreshAll();
        await this.wait(320);
        return;
      case 'status_resisted':
        this.floatText(ev.target, '抵抗', '#d0d4d8', 15);
        this.setMessage(msg);
        await this.wait(320);
        return;
      case 'expire':
        this.refreshAll();
        return;
      case 'intent_revealed':
        // 施放當下就顯示（訊息列＋敵人頭上），不依賴之後再查詢 core
        this.revealed.set(ev.target, revealedIntent(ev));
        this.setMessage(msg);
        this.refreshAll();
        if (!TEST_MODE) {
          const v = this.unitViews.get(ev.target);
          if (v) this.tweens.add({ targets: v.intent, alpha: { from: 0, to: 1 }, duration: 300 });
        }
        await this.wait(520);
        return;
      case 'collapse':
        this.dispCollapse = ev.total;
        this.refreshResources();
        this.setMessage(msg);
        if (ev.amount > 0) {
          this.floatText(this.b.units.find((u) => u.side === 'party')?.uid, `崩解 +${ev.amount}`, '#d080d0', 15);
          if (!TEST_MODE) {
            this.cameras.main.shake(260, 0.006 + Math.min(0.01, ev.amount / 1000));
            this.vignette.setAlpha(0);
            this.tweens.add({ targets: this.vignette, alpha: Math.min(0.9, 0.35 + ev.total / 140), duration: 160, yoyo: true, hold: 220 });
          }
        }
        await this.wait(420);
        return;
      case 'summon': {
        const u = this.unitById(ev.uid);
        if (u && !this.unitViews.has(u.uid)) {
          this.disp[u.uid] = { hp: u.hp, sp: u.sp };
          this.labels = unitLabels(this.b);
          this.makeEnemyView(u);
          const v = this.unitViews.get(u.uid);
          this.layoutEnemies(false);
          if (!TEST_MODE) { v.c.setAlpha(0); this.tweens.add({ targets: v.c, alpha: 1, duration: 400 }); }
        }
        this.setMessage(describe(ev, this.labels, session.data));
        this.refreshAll();
        await this.wait(450);
        return;
      }
      case 'summon_failed':
        this.setMessage(msg);
        await this.wait(350);
        return;
      case 'phase':
        if (ev.dialogue) {
          this.refreshAll();
          await this.dialogue.play(ev.dialogue);
        }
        return;
      case 'defeated': {
        this.revealed.delete(ev.uid);
        const d = this.disp[ev.uid];
        if (d) d.hp = 0;
        this.setMessage(msg);
        const v = this.unitViews.get(ev.uid);
        if (v?.side === 'enemy') {
          if (TEST_MODE) {
            v.c.setVisible(false);
          } else {
            v.fading = true;
            await new Promise((res) => this.tweens.add({ targets: v.c, alpha: 0, y: v.c.y + 10, duration: 420, onComplete: res }));
            v.fading = false;
            v.c.setVisible(false);
          }
          this.layoutEnemies();
        }
        this.refreshAll();
        await this.wait(260);
        return;
      }
      case 'drop':
        this.setMessage(msg);
        await this.wait(300);
        return;
      case 'victory':
      case 'defeat':
      case 'lost_control':
      case 'fled':
      case 'flee_failed':
      case 'sleep_skip':
      case 'confused':
      case 'retarget':
        this.setMessage(msg);
        if (ev.type === 'lost_control' && !TEST_MODE) this.cameras.main.shake(500, 0.02);
        await this.wait(ev.type === 'retarget' || ev.type === 'confused' ? 360 : 520);
        return;
      default:
        if (msg) this.setMessage(msg);
    }
  }

  // ---------- 主迴圈 ----------
  async run() {
    await this.playLog(this.b.opening ?? []);
    while (!this.ended && this.b.outcome === null) {
      this.refreshAll();
      if (isPlayerTurn(this.b)) {
        await this.playerTurn();
      } else {
        await this.wait(200);
        const r = advanceEnemy(this.b, session.data);
        this.b = r.battle;
        await this.playLog(r.log);
      }
    }
    if (!this.ended) await this.finish();
  }

  playerTurn() {
    return new Promise((resolve) => {
      this.turnResolve = resolve;
      this.cmds = commands(this.b, session.data);
      const a = currentActor(this.b);
      this.setMessage(commandPrompt(this.labels[a.uid], this.cmds?.canFlee));
      this.showRoot();
    });
  }

  submit(cmd) {
    if (this.mode === 'busy' || !this.turnResolve) return;
    let r;
    try {
      r = act(this.b, cmd, session.data);
    } catch (e) {
      console.warn('指令不合法', e);
      this.toast('現在不能這樣做');
      this.showRoot();
      return;
    }
    this.clearMenu();
    this.mode = 'busy';
    this.cursor = null;
    this.b = r.battle;
    const done = this.turnResolve;
    this.turnResolve = null;
    this.playLog(r.log).then(done);
  }

  // ---------- 選單 ----------
  clearMenu() {
    this.menuObjs.forEach((o) => o.destroy());
    this.menuObjs = [];
    this.menu = null;
  }

  /**
   * 建立一組按鈕。entries: [{ label, sub, enabled, reason, onSelect }]；layout 'grid'（2 欄，指令區）或 'list'（單欄，蓋住隊伍區）。
   */
  buildMenu(mode, entries, { layout = 'grid', title = null, onBack = null } = {}) {
    this.clearMenu();
    this.mode = mode;
    const objs = [];
    let cols = 2;
    let positions;
    if (layout === 'list') {
      cols = 1;
      const top = LIST.top;
      const bg = this.add.graphics().setDepth(DEPTH.overlay);
      bg.fillStyle(0x0d1015, 1).fillRect(0, top - 14, WIDTH, HEIGHT - top + 14);
      bg.lineStyle(1, COLORS.gasDeep, 1).lineBetween(0, top - 13.5, WIDTH, top - 13.5);
      objs.push(bg);
      if (title) {
        objs.push(addText(this, WIDTH / 2, top + 6, title, { fontSize: '14px', color: '#f0d2a0' }).setOrigin(0.5).setDepth(DEPTH.cmd));
      }
      const y0 = top + 26 + LIST.h / 2;
      positions = entries.map((_, i) => [WIDTH / 2, y0 + i * (LIST.h + LIST.gap), LIST.w, LIST.h]);
    } else {
      positions = entries.map((_, i) => [CMD.colX[i % 2], CMD.top + CMD.h / 2 + Math.floor(i / 2) * (CMD.h + CMD.gapY), CMD.w, CMD.h]);
    }
    const buttons = entries.map((e, i) => {
      const [x, y, w, h] = positions[i];
      const b = new Button(this, x, y, w, h, e.label, {
        sub: e.sub ?? null, fontSize: layout === 'list' ? 16 : 17, align: layout === 'list' ? 'left' : 'center',
        onClick: () => this.pick(i),
      });
      b.setDepth(DEPTH.cmd);
      b.setEnabled(e.enabled !== false);
      if (b.sub) fitText(b.sub, e.sub, w - 24);
      b.hit.on('pointerup', () => { if (!b.enabled) this.pick(i); });
      b.on('hover', () => this.focusMenu(i));
      objs.push(b);
      return b;
    });
    this.menuObjs = objs;
    this.menu = { entries, buttons, cols, index: 0, onBack, layout, title };
    if (this.cmdHidden) objs.forEach((o) => o.setVisible(false));
    this.focusMenu(Math.max(0, entries.findIndex((e) => e.enabled !== false)));
  }

  focusMenu(i) {
    if (!this.menu) return;
    const n = this.menu.buttons.length;
    if (n === 0) return;
    this.menu.index = ((i % n) + n) % n;
    this.menu.buttons.forEach((b, j) => b.setFocused(j === this.menu.index));
    const e = this.menu.entries[this.menu.index];
    if (this.mode === 'target' && e?.uid) { this.cursor = e.uid; this.refreshAll(); }
  }

  pick(i) {
    if (!this.menu || this.mode === 'busy') return;
    const e = this.menu.entries[i];
    if (!e) return;
    if (e.enabled === false) {
      if (e.reason) this.toast(e.reason);
      return;
    }
    e.onSelect?.();
  }

  showRoot() {
    const c = this.cmds;
    const sk = (id) => c.skills.find((s) => s.id === id);
    const entries = [];
    const skillEntry = (id) => {
      const s = sk(id);
      if (!s) return;
      const sub = s.usable ? (s.cost.ammo > 0 ? `子彈 ${this.b.ammo}` : null) : reasonText(s.reason);
      entries.push({ label: s.name, sub, enabled: s.usable, reason: reasonText(s.reason), onSelect: () => this.chooseSkill(s, 'root') });
    };
    // 第一層（2 欄格子，由左而右、由上而下）：menu: root 的技能依 skills.json 的順序，接著「技能」「道具」「逃跑」。
    // 例如 攻擊｜防禦／開槍｜技能／道具｜逃跑。
    const roots = c.skills.filter((s) => isRootSkill(s.id)).map((s) => s.id).sort((a, b) => skillIndex(a) - skillIndex(b));
    const others = c.skills.filter((s) => !isRootSkill(s.id));
    roots.forEach(skillEntry);
    entries.push({
      label: '技能', sub: others.length ? null : '沒有技能', enabled: others.length > 0, reason: '沒有可以使用的技能',
      onSelect: () => this.showSkills(0),
    });
    entries.push({
      label: '道具', sub: c.items.length ? null : '沒有道具', enabled: c.items.length > 0, reason: '沒有可以使用的道具',
      onSelect: () => this.showItems(0),
    });
    if (c.canFlee) entries.push({ label: '逃跑', onSelect: () => this.submit({ type: 'flee' }) });
    this.buildMenu('root', entries);
  }

  /** 單欄清單的分頁：一頁最多 4 項＋「返回」；超過時每頁 3 項＋「下一頁」＋「返回」。 */
  pageEntries(list, page, make, reopen) {
    const per = LIST.perPage;
    let entries;
    if (list.length <= per) {
      entries = list.map(make);
    } else {
      const realPer = per - 1;
      const total = Math.ceil(list.length / realPer);
      const p = ((page % total) + total) % total;
      entries = list.slice(p * realPer, p * realPer + realPer).map(make);
      entries.push({ label: `下一頁（${p + 1}/${total}）`, onSelect: () => reopen((p + 1) % total) });
    }
    entries.push({ label: '返回', onSelect: () => this.showRoot() });
    return entries;
  }

  showSkills(page) {
    const a = this.unitById(this.b.actor);
    const list = this.cmds.skills.filter((s) => !isRootSkill(s.id));
    const entries = this.pageEntries(list, page, (s) => ({
      label: s.name,
      sub: s.usable ? `${costText(s.cost)}｜${s.desc}` : `${costText(s.cost)}｜${reasonText(s.reason)}`,
      enabled: s.usable,
      reason: reasonText(s.reason),
      onSelect: () => this.chooseSkill(s, 'skills', page),
    }), (p) => this.showSkills(p));
    this.buildMenu('skills', entries, { layout: 'list', title: `技能　靈性 ${a.sp}/${a.stats.sp}`, onBack: () => this.showRoot() });
  }

  showItems(page) {
    const list = this.cmds.items;
    const entries = this.pageEntries(list, page, (it) => {
      const def = (session.data.items ?? []).find((x) => x.id === it.id);
      const usable = it.targets.length > 0 || !['enemy', 'ally'].includes(it.target);
      return {
        label: `${it.name}　×${it.count}`,
        sub: usable ? (def?.desc ?? '') : '沒有可選的目標',
        enabled: usable,
        reason: '沒有可選的目標',
        onSelect: () => this.chooseItem(it, page),
      };
    }, (p) => this.showItems(p));
    this.buildMenu('items', entries, { layout: 'list', title: '道具', onBack: () => this.showRoot() });
  }

  chooseSkill(s, from, page = 0) {
    const back = from === 'skills' ? () => this.showSkills(page) : () => this.showRoot();
    if (s.target === 'enemy' || s.target === 'ally') {
      this.showTargets(s.targets, s.name, (uid) => this.submit({ type: 'skill', skill: s.id, target: uid }), back);
    } else {
      this.submit({ type: 'skill', skill: s.id });
    }
  }

  chooseItem(it, page) {
    if (it.target === 'enemy' || it.target === 'ally') {
      this.showTargets(it.targets, it.name, (uid) => this.submit({ type: 'item', item: it.id, target: uid }), () => this.showItems(page));
    } else {
      this.submit({ type: 'item', item: it.id });
    }
  }

  /** 選目標：指令區列出目標按鈕（也可以直接點敵人或隊伍列、或用左右鍵）。 */
  showTargets(uids, what, onPick, onBack) {
    const entries = uids.map((uid) => {
      const u = this.unitById(uid);
      return { uid, label: this.labels[uid], sub: `生命 ${u.hp}/${u.stats.hp}`, onSelect: () => onPick(uid) };
    });
    entries.push({ label: '返回', onSelect: () => { this.cursor = null; onBack(); } });
    this.targetPick = onPick;
    this.targetUids = uids;
    this.buildMenu('target', entries, { onBack: () => { this.cursor = null; onBack(); } });
    this.setMessage(`選擇「${what}」的目標`);
    this.refreshAll();
  }

  onUnitTap(uid) {
    if (this.mode !== 'target' || this.dialogue.active || !this.targetUids?.includes(uid)) return;
    const pick = this.targetPick;
    pick?.(uid);
  }

  // ---------- 鍵盤 ----------
  onKey(ev) {
    if (this.dialogue.active) {
      if (!ev.repeat && claimKey(ev)) this.dialogue.handleKey(ev.code);
      return;
    }
    if (ev.repeat) return;
    if (!this.menu || this.mode === 'busy') return;
    if (!claimKey(ev)) return;
    const m = this.menu;
    const n = m.buttons.length;
    const code = ev.code;
    if (code === 'ArrowLeft' || code === 'KeyA') this.focusMenu(m.index - 1);
    else if (code === 'ArrowRight' || code === 'KeyD') this.focusMenu(m.index + 1);
    else if (code === 'ArrowUp' || code === 'KeyW') this.focusMenu(m.cols === 1 ? m.index - 1 : (m.index - m.cols >= 0 ? m.index - m.cols : m.index));
    else if (code === 'ArrowDown' || code === 'KeyS') this.focusMenu(m.cols === 1 ? m.index + 1 : Math.min(n - 1, m.index + m.cols));
    else if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter' || code === 'KeyZ') this.pick(m.index);
    else if (code === 'Escape' || code === 'KeyX' || code === 'Backspace') m.onBack?.();
  }

  // ---------- 結束 ----------
  async finish() {
    this.clearMenu();
    this.mode = 'busy';
    this.refreshAll();
    let res;
    try {
      res = finishBattle(this.b, session.state, session.data);
    } catch (e) {
      console.warn('戰鬥結算失敗', e);
      res = { state: session.state, outcome: this.b.outcome, rewards: { items: [] }, next: null };
    }
    this.result = { outcome: res.outcome, rewards: res.rewards, next: res.next };
    if (res.next?.type === 'retry') {
      await this.wait(500);
      if (this.ended) return;
      this.cameras.main.fadeOut(MS(400), 0, 0, 0);
      await this.wait(420);
      if (!this.ended) this.scene.start('GameOver', { outcome: res.outcome, encounter: this.encounterId });
      return;
    }
    await this.showResult(res);
    if (this.ended) return;
    this.returnToMap(res);
  }

  showResult(res) {
    return new Promise((resolve) => {
      const objs = [];
      const dim = this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x05070a, 0.55).setOrigin(0).setDepth(DEPTH.overlay).setInteractive();
      objs.push(dim, panel(this, 40, 190, WIDTH - 80, 250).setDepth(DEPTH.overlay));
      const title = res.outcome === 'defeat' ? '戰鬥結束' : OUTCOME_TITLE[res.outcome] ?? '戰鬥結束';
      objs.push(addText(this, WIDTH / 2, 226, title, { fontSize: '26px', fontStyle: 'bold', color: '#f0d2a0' }).setOrigin(0.5).setDepth(DEPTH.overlay));
      const lines = rewardLines(res.rewards, session.data);
      let body;
      if (res.outcome === 'victory') body = lines.length ? `取得：\n${lines.join('\n')}` : '沒有取得任何東西';
      else if (res.outcome === 'fled') body = '順利脫離了戰鬥';
      else body = '雖然輸了，但還站得起來';
      this.resultText = body;
      objs.push(addText(this, WIDTH / 2, 300, body, { fontSize: '15px', color: COLORS.text, align: 'center', lineSpacing: 6 }).setOrigin(0.5).setDepth(DEPTH.overlay));
      this.clearMenu();
      this.mode = 'result';
      const btn = new Button(this, WIDTH / 2, 398, 200, 52, '繼續', { onClick: () => done() });
      btn.setDepth(DEPTH.cmd);
      btn.setFocused(true);
      objs.push(btn);
      this.menuObjs = [btn];
      this.menu = { entries: [{ label: '繼續', onSelect: () => done() }], buttons: [btn], cols: 1, index: 0, onBack: null };
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        objs.forEach((o) => o.destroy());
        this.menuObjs = [];
        this.menu = null;
        this.mode = 'busy';
        resolve();
      };
    });
  }

  /** 回地圖原位置：寫回 state，喚醒地圖，交給地圖播 next 對話。 */
  returnToMap(res) {
    if (this.leaving) return;
    this.leaving = true;
    session.setState(res.state);
    session.preBattle = null;
    const back = session.battleReturn;
    session.battleReturn = null;
    this.scene.stop();
    back?.(res);
  }

  /** E2E 用的唯讀摘要（__SL.battle()）。 */
  debugInfo() {
    if (!this.b) return { encounter: this.encounterId, error: true };
    const b = this.b;
    const actor = currentActor(b);
    const labels = this.labels ?? unitLabels(b);
    return {
      encounter: this.encounterId,
      seed: this.seed,
      retry: b.retry ?? null,
      mode: this.mode,
      outcome: b.outcome,
      actor: actor ? { ...actor, label: labels[actor.uid] } : null,
      playerTurn: isPlayerTurn(b) && this.mode !== 'busy',
      order: b.outcome === null ? turnOrder(b, 6) : [],
      ammo: b.ammo,
      collapse: b.collapse,
      message: this.message,
      messages: this.msgHistory,
      intentShown: this.intentHistory,
      notices: this.notices,
      units: b.units.map((u) => {
        const v = this.unitViews?.get(u.uid);
        const hit = v?.hit;
        let rect = null;
        if (hit && v.c.visible) {
          const r = hit.getBounds();
          rect = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
        return {
          uid: u.uid, side: u.side, id: u.id, name: u.name, label: labels[u.uid], hp: u.hp, maxHp: u.stats.hp, sp: u.sp, maxSp: u.stats.sp,
          alive: u.alive, status: { ...u.status }, intent: u.side === 'enemy' && u.revealed && u.intent ? { ...u.intent } : null,
          intentText: v?.intentStr ?? null, rect,
        };
      }),
      commands: isPlayerTurn(b) ? commands(b, session.data) : null,
      menu: this.menu ? {
        layout: this.menu.layout ?? 'grid',
        title: this.menu.title ?? null,
        index: this.menu.index,
        buttons: this.menu.buttons.map((bt, i) => ({
          label: bt.label.text, sub: bt.sub?.text ?? null, enabled: bt.enabled, focused: i === this.menu.index,
          uid: this.menu.entries[i]?.uid ?? null, x: bt.x - bt.w / 2, y: bt.y - bt.h / 2, w: bt.w, h: bt.h,
        })),
      } : null,
      cursor: this.mode === 'target' ? this.cursor : null,
      result: this.result,
      resultText: this.mode === 'result' ? this.resultText : null,
      log: this.allLog,
    };
  }
}
