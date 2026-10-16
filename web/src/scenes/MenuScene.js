// 選單（疊在其他場景上方）：存檔（3 槽，覆蓋前確認）、讀取、回標題。
// mode：'game'（遊戲中 Esc）、'load'（標題的「繼續」）、'save'（章節結束後的存檔提示）。
import { WIDTH, HEIGHT, COLORS } from '../config.js';
import { session, claimKey, formatPlaytime } from '../session.js';
import { addText, ButtonList, panel } from '../ui/widgets.js';

const BLOCKED_MSG = '目前無法存檔（瀏覽器封鎖了儲存空間），\n遊戲仍可繼續';

export class MenuScene extends Phaser.Scene {
  constructor() { super('Menu'); }

  init(data) {
    this.mode = data?.mode ?? 'game';
    this.from = data?.from ?? 'Map';
  }

  create() {
    session.scene = 'Menu';
    // 擋住下層的點擊
    this.add.rectangle(0, 0, WIDTH, HEIGHT, 0x05070a, 0.72).setOrigin(0).setInteractive();
    panel(this, 16, 70, WIDTH - 32, HEIGHT - 140);
    this.title = addText(this, WIDTH / 2, 104, '', { fontSize: '20px', fontStyle: 'bold', color: '#f0d2a0' }).setOrigin(0.5);
    this.note = addText(this, WIDTH / 2, 136, '', {
      fontSize: '13px', color: COLORS.textDim, align: 'center', wordWrap: { width: WIDTH - 72, useAdvancedWrap: true },
    }).setOrigin(0.5, 0);
    this.list = null;
    this.extra = [];
    this.input.keyboard.on('keydown', (ev) => {
      if (ev.repeat || !claimKey(ev)) return;
      if (ev.code === 'Escape') { this.back(); return; }
      this.list?.handleKey(ev.code);
    });
    if (this.mode === 'load') this.showSlots('load');
    else if (this.mode === 'save') this.showSlots('save');
    else this.showMain();
  }

  setPage(page, title, note, items, { y = 200, h = 52, fontSize = 17 } = {}) {
    this.page = page;
    this.list?.destroy();
    this.extra.forEach((o) => o.destroy());
    this.extra = [];
    this.title.setText(title);
    this.note.setText(note ?? '');
    const top = this.note.text ? Math.max(y, 136 + this.note.height + 24) : y;
    this.list = new ButtonList(this, { x: WIDTH / 2, y: top + h / 2, w: WIDTH - 72, h, gap: 10, items, align: 'left', fontSize });
  }

  showMain(note = null) {
    const blocked = !session.storageAvailable;
    this.setPage('main', '選單', note ?? (blocked ? BLOCKED_MSG : null), [
      { label: '存檔', enabled: !blocked, onSelect: () => this.showSlots('save') },
      { label: '讀取', enabled: !blocked, onSelect: () => this.showSlots('load') },
      { label: '回標題', onSelect: () => this.confirmTitle() },
      { label: '返回遊戲', onSelect: () => this.close() },
    ]);
  }

  slotItems(kind) {
    const slots = session.storage.listSlots();
    return slots.map((s) => {
      if (s.ok && s.empty) {
        return { label: `存檔 ${s.slot}　（空）`, sub: '尚未使用', enabled: kind === 'save', onSelect: () => this.saveTo(s.slot, false) };
      }
      if (s.ok) {
        return {
          label: `存檔 ${s.slot}　${session.mapName(s.map)}`,
          sub: `${s.name}｜遊戲時間 ${formatPlaytime(s.playtime_s)}`,
          onSelect: () => (kind === 'save' ? this.saveTo(s.slot, true) : this.loadFrom(s.slot)),
        };
      }
      return {
        label: `存檔 ${s.slot}　無法讀取`,
        sub: String(s.reason ?? '存檔損壞').slice(0, 40),
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
    if (r.ok) this.showSlots('save', `已存檔到存檔 ${slot}`);
    else this.showSlots('save', `${BLOCKED_MSG}\n（${r.reason}）`);
  }

  loadFrom(slot) {
    const r = session.storage.load(slot);
    if (!r.ok) {
      this.showSlots('load', `無法讀取存檔 ${slot}：${r.reason}`);
      return;
    }
    if (!session.mapById(r.state.location?.map)) {
      this.showSlots('load', `存檔 ${slot} 的地點「${r.state.location?.map}」不存在，無法讀取`);
      return;
    }
    session.reset();
    session.setState(r.state);
    this.scene.stop('UI');
    if (this.from !== 'Map') this.scene.stop(this.from);
    this.scene.stop('Map');
    this.scene.start('Map', {});
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
    if (this.page === 'confirm') {
      if (this.title.text === '回標題') this.showMain(); else this.showSlots('save');
      return;
    }
    if ((this.page === 'save' || this.page === 'load') && this.mode === 'game') { this.showMain(); return; }
    this.close();
  }

  close() {
    if (this.from === 'Map') {
      this.scene.resume('UI');
      this.scene.resume('Map');
    } else {
      this.scene.resume(this.from);
    }
    this.scene.stop();
  }
}
