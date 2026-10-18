// 章節結束：story 的 end_screen（標題、副標）→「繼續」（end_screen.continue，進下一章）／存檔／回標題。
// M5：終章判定了結局（state.ending）時改成結局畫面：結局名稱、end_screen.title（第一部完）、副標、致謝 → 存檔／回標題。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { session, claimKey } from '../session.js';
import { addText, ButtonList } from '../ui/widgets.js';
import { enterMap } from '../core/grid.js';
import { cloud } from '../cloud-client.js';
import { endingScreen } from '../ui/m5-view.js';

export class ChapterEndScene extends Phaser.Scene {
  constructor() { super('ChapterEnd'); }

  init(data) {
    this.chapter = data?.chapter ?? session.data?.manifest?.chapters?.[0] ?? null;
    this.notices = Array.isArray(data?.notices) ? data.notices : [];
    // 讀檔回到章節結束畫面（resumed）時不再回報通關
    this.resumed = data?.resumed === true;
  }

  /** 已啟用雲端時回報章節完成；失敗只記 console，不打擾玩家。 */
  reportClear() {
    if (this.resumed || !cloud.enabled()) return;
    const s = session.snapshot();
    if (!s || typeof this.chapter !== 'string') return;
    // M5：判定了結局的章節送結局 id（Worker 以 vars ENDINGS 白名單驗證）；沒有結局的章節送 null
    const ending = typeof s.ending === 'string' && endingScreen(this.chapter, s, session.data) ? s.ending : null;
    const rec = { chapter: this.chapter, ending, play_seconds: s.playtime_s ?? 0, collapse: s.collapse ?? 0 };
    this.clearReport = { status: 'pending', record: rec };
    cloud.reportClear(rec).then((r) => {
      this.clearReport = { status: r.ok ? 'ok' : 'failed', record: rec };
      if (!r.ok) console.warn(`通關紀錄回報失敗（${r.kind}）：${r.message ?? ''}`);
    }).catch((e) => {
      this.clearReport = { status: 'failed', record: rec };
      console.warn('通關紀錄回報失敗', e);
    });
  }

  /** 章節結束畫面的文字：story.end_screen，沒寫時用「<章名>　完」、無副標。 */
  screenTexts() {
    const story = session.data?.story?.find((c) => c?.id === this.chapter);
    const name = story?.title ?? this.chapter ?? '';
    const es = story?.end_screen;
    const c = es?.continue;
    let ending = null;
    try {
      ending = endingScreen(this.chapter, session.state, session.data);
    } catch (e) {
      console.warn('結局畫面資料有問題', e);
    }
    return {
      title: typeof es?.title === 'string' ? es.title : `${name}　完`,
      subtitle: typeof es?.subtitle === 'string' ? es.subtitle : '',
      // 結局畫面不提供「繼續」（第一部已完結）
      continue: !ending && c && typeof c.map === 'string' && typeof c.spawn === 'string' ? { ...c } : null,
      ending: ending ? { id: ending.id, title: ending.title, partTitle: ending.partTitle } : null,
      credits: ending ? ending.credits : [],
    };
  }

  /** E2E 用的唯讀資訊。 */
  debugInfo() {
    if (!this.texts) return null;
    return {
      ...this.texts,
      clearReport: this.clearReport ?? null,
      items: (this.list?.buttons ?? []).map((b, i) => ({
        label: b.label.text, enabled: b.enabled, focused: i === this.list.index, x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h,
      })),
    };
  }

  create() {
    session.scene = 'ChapterEnd';
    this.cameras.main.setBackgroundColor(0x07090c);
    this.list = null;
    this.clearReport = null;
    this.reportClear();
    const fade = TEST_MODE ? 150 : 900;

    this.texts = this.screenTexts();
    if (this.texts.ending) { this.createEnding(fade); return; }
    const t1 = addText(this, WIDTH / 2, 230, this.texts.title, {
      fontSize: '34px', fontStyle: 'bold', color: '#f0d2a0',
    }).setOrigin(0.5).setAlpha(0);
    if (t1.width > WIDTH - 32) t1.setScale((WIDTH - 32) / t1.width);
    const t2 = addText(this, WIDTH / 2, 290, this.texts.subtitle, {
      fontSize: '18px', color: COLORS.textDim, align: 'center', wordWrap: { width: WIDTH - 48, useAdvancedWrap: true },
    }).setOrigin(0.5).setAlpha(0);
    const prompt = this.texts.continue ? '要先存檔，再繼續下一章嗎？' : '要把目前的進度存檔嗎？';
    const t3 = addText(this, WIDTH / 2, 360, prompt, { fontSize: '15px', color: COLORS.text }).setOrigin(0.5).setAlpha(0);

    this.tweens.chain({
      tweens: [
        { targets: t1, alpha: 1, duration: fade },
        { targets: t2, alpha: 1, duration: fade, delay: fade / 2 },
        { targets: t3, alpha: 1, duration: fade / 2, delay: fade / 2, onComplete: () => this.showButtons() },
      ],
    });

    this.input.keyboard.on('keydown', (ev) => {
      if (ev.repeat || !claimKey(ev)) return;
      this.list?.handleKey(ev.code);
    });
    this.events.on('resume', this.onResume, this);
    this.events.once('shutdown', () => this.events.off('resume', this.onResume, this));
  }

  onResume() { session.scene = 'ChapterEnd'; }

  /** 結局畫面（第一部完結）：「結局」→ 結局名稱 → 第一部　…　完 → 副標 → 致謝 → 按鈕。 */
  createEnding(fade) {
    const t = this.texts;
    const slow = TEST_MODE ? fade : fade * 1.6;
    const label = addText(this, WIDTH / 2, 92, '結局', { fontSize: '14px', color: COLORS.textDim }).setOrigin(0.5).setAlpha(0);
    const name = addText(this, WIDTH / 2, 140, t.ending.title, { fontSize: '36px', fontStyle: 'bold', color: '#f0d2a0' }).setOrigin(0.5).setAlpha(0);
    if (name.width > WIDTH - 32) name.setScale((WIDTH - 32) / name.width);
    const line = this.add.rectangle(WIDTH / 2, 182, 200, 1, COLORS.gas, 0.8).setAlpha(0).setScale(0, 1);
    const part = addText(this, WIDTH / 2, 214, t.title, { fontSize: '20px', color: '#e8e2d4' }).setOrigin(0.5).setAlpha(0);
    if (part.width > WIDTH - 32) part.setScale((WIDTH - 32) / part.width);
    const sub = addText(this, WIDTH / 2, 250, t.subtitle, {
      fontSize: '14px', color: COLORS.textDim, align: 'center', wordWrap: { width: WIDTH - 48, useAdvancedWrap: true },
    }).setOrigin(0.5, 0).setAlpha(0);
    const [head, ...rest] = t.credits;
    const credY = Math.max(318, sub.y + sub.height + 26);
    const ch = addText(this, WIDTH / 2, credY, head ?? '', { fontSize: '15px', fontStyle: 'bold', color: '#f0a848' }).setOrigin(0.5, 0).setAlpha(0);
    const cb = addText(this, WIDTH / 2, credY + 28, rest.join('\n'), {
      fontSize: '13px', color: COLORS.text, align: 'center', lineSpacing: 6, wordWrap: { width: WIDTH - 48, useAdvancedWrap: true },
    }).setOrigin(0.5, 0).setAlpha(0);
    this.endingButtonsY = Math.max(cb.y + cb.height + 40, 500);
    this.tweens.chain({
      tweens: [
        { targets: label, alpha: 1, duration: fade / 2 },
        { targets: name, alpha: 1, duration: slow },
        { targets: line, alpha: 1, scaleX: 1, duration: fade / 2 },
        { targets: [part, sub], alpha: 1, duration: fade, delay: fade / 3 },
        { targets: [ch, cb], alpha: 1, duration: fade, delay: fade / 2, onComplete: () => this.showEndingButtons() },
      ],
    });
    this.input.keyboard.on('keydown', (ev) => {
      if (ev.repeat || !claimKey(ev)) return;
      this.list?.handleKey(ev.code);
    });
    this.events.on('resume', this.onResume, this);
    this.events.once('shutdown', () => this.events.off('resume', this.onResume, this));
  }

  showEndingButtons() {
    const y = Math.min(this.endingButtonsY, HEIGHT - 110);
    this.list = new ButtonList(this, {
      x: WIDTH / 2, y, w: 220, h: 50, gap: 10,
      items: [{ label: '存檔', onSelect: () => this.openSave() }, { label: '回標題', onSelect: () => this.scene.start('Title') }],
    });
  }

  showButtons() {
    const items = [];
    if (this.texts.continue) items.push({ label: '繼續', onSelect: () => this.continueNext() });
    items.push({ label: '存檔', onSelect: () => this.openSave() });
    items.push({ label: '回標題', onSelect: () => this.scene.start('Title') });
    this.list = new ButtonList(this, { x: WIDTH / 2, y: 418, w: 220, h: 52, gap: 12, items });
    addText(this, WIDTH / 2, HEIGHT - 40, '感謝遊玩', { fontSize: '12px', color: COLORS.textDisabled }).setOrigin(0.5);
  }

  /** 進下一章：移到 continue 的地圖與 spawn，章節改成 manifest 的下一章，播 on_enter 與 continue.dialogue。 */
  continueNext() {
    const c = this.texts.continue;
    const s = session.state;
    if (!c || !s) return;
    let r;
    try {
      r = enterMap(s, session.data, c.map, c.spawn);
    } catch (e) {
      console.warn('無法進入下一章', e);
      return;
    }
    const chapters = session.data?.manifest?.chapters ?? [];
    const i = chapters.indexOf(this.chapter);
    const next = i >= 0 && i + 1 < chapters.length ? chapters[i + 1] : s.chapter;
    session.setState({ ...r.state, chapter: next });
    const intro = [...new Set([r.dialogue, c.dialogue].filter((d) => typeof d === 'string'))];
    this.scene.start('Map', { intro, notices: this.notices });
  }

  openSave() {
    this.scene.pause();
    this.scene.launch('Menu', { mode: 'save', from: 'ChapterEnd' });
  }
}
