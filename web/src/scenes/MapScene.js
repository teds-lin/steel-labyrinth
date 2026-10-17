// 地圖：繪製地形與物件、主角格子移動（補間）、鏡頭跟隨、出口／觸發點／互動。
// 劇情流程（對話 → pending 的 battle／goto → 戰鬥 → on_win 對話 → …）都在這裡依序 await。
import { TILE, MAP_ZOOM, MAP_VIEW, COLORS, TEST_MODE, battleSeed } from '../config.js';
import { session } from '../session.js';
import { step, enterMap, mapSize, tileIdAt, objectVisible, isUnlocked, fleeBackLocation } from '../core/grid.js';
import { takePending } from '../core/effects.js';
import { tileKey, spriteKey, heroKey } from '../textures.js';
import { investigateFacing, echoFacing, loadNotice } from '../adapters.js';

const MOVE_MS = 150;

export class MapScene extends Phaser.Scene {
  constructor() { super('Map'); }

  init(data) {
    this.intro = Array.isArray(data?.intro) ? data.intro : [];
    this.notice = loadNotice(data?.notices);
  }

  create() {
    session.scene = 'Map';
    this.moving = false;
    this.busy = false;
    this.flow = 0;
    this.queued = null;
    this.triggerFrom = null;
    this.ended = false;
    const cam = this.cameras.main;
    cam.setViewport(MAP_VIEW.x, MAP_VIEW.y, MAP_VIEW.w, MAP_VIEW.h);
    cam.setZoom(MAP_ZOOM);
    cam.setBackgroundColor(COLORS.bg);
    cam.setRoundPixels(true);

    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys('W,A,S,D', false);

    this.layer = this.add.container(0, 0);
    this.objLayer = this.add.container(0, 0);
    this.player = this.add.image(0, 0, heroKey('down')).setDepth(10);
    this.buildMap();

    if (!this.scene.isActive('UI')) this.scene.launch('UI');
    this.scene.bringToTop('UI');

    const onState = () => this.refreshObjects();
    session.events.on('state', onState);
    this.events.once('shutdown', () => {
      session.events.off('state', onState);
    });
    // resume 監聽器：場景的 events 跨 restart 保留，所以要在 shutdown 時拿掉，否則每次讀檔多一個
    this.events.on('resume', this.onResume, this);
    this.events.on('wake', this.onResume, this);
    this.events.once('shutdown', () => {
      this.events.off('resume', this.onResume, this);
      this.events.off('wake', this.onResume, this);
    });

    if (this.notice) {
      const msg = this.notice;
      this.notice = null;
      this.waitUi().then(() => { if (!this.ended) this.ui.toast(msg, 2600); });
    }

    // 新遊戲的開場對話（UI 場景要等它 create 完）
    if (this.intro.length) {
      const list = this.intro;
      this.intro = [];
      this.flow += 1; // 開場對話開始前就鎖住移動
      this.time.delayedCall(0, () => {
        this.flow -= 1;
        this.runDialogues(list);
      });
    }
  }

  onResume() { session.scene = 'Map'; }

  get ui() { return this.scene.get('UI'); }

  /** E2E 用的唯讀資訊。 */
  debugInfo() {
    return { glows: this.glowCount ?? 0, map: this.currentMapId ?? null };
  }

  /** UI 場景是在本場景 create 時 launch 的，第一個畫格可能還沒建好。 */
  waitUi() {
    return new Promise((res) => {
      const check = () => {
        if (this.ui?.dialogue && this.scene.isActive('UI')) res();
        else this.time.delayedCall(16, check);
      };
      check();
    });
  }

  /** 離開地圖（章節結束、回標題、讀檔重進）：先停 UI 再切場景。 */
  leave(target, data) {
    this.ended = true;
    this.scene.stop('UI');
    this.scene.start(target, data);
  }

  get mapDef() { return session.mapById(session.state.location.map); }

  buildMap() {
    const map = this.mapDef;
    this.currentMapId = map.id;
    this.layer.removeAll(true);
    this.objLayer.removeAll(true);
    const { width, height } = mapSize(map);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = tileIdAt(map, x, y);
        const key = id && this.textures.exists(tileKey(id)) ? tileKey(id) : null;
        if (key) this.layer.add(this.add.image(x * TILE, y * TILE, key).setOrigin(0));
      }
    }
    // 燈光光暈：tiles.json 裡 glow 為 true 的地形
    const glowIds = new Set((session.data.tiles ?? []).filter((t) => t?.glow === true).map((t) => t.id));
    this.glowCount = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = tileIdAt(map, x, y);
        if (glowIds.has(id)) {
          this.glowCount += 1;
          this.layer.add(this.add.image(x * TILE + TILE / 2, y * TILE + TILE / 3, 'fx:glow').setScale(1.3).setAlpha(0.7).setBlendMode(Phaser.BlendModes.ADD));
        }
      }
    }
    this.objSprites = new Map();
    for (const o of map.objects ?? []) {
      const img = this.add.image(o.x * TILE, o.y * TILE, spriteKey(o.sprite ?? 'unknown')).setOrigin(0);
      this.objLayer.add(img);
      this.objSprites.set(o.id, { obj: o, img });
    }
    this.refreshObjects();

    // 鏡頭：地圖比畫面小時置中，否則跟隨主角
    const cam = this.cameras.main;
    const mw = width * TILE;
    const mh = height * TILE;
    const vw = MAP_VIEW.w / MAP_ZOOM;
    const vh = MAP_VIEW.h / MAP_ZOOM;
    const bx = mw < vw ? -(vw - mw) / 2 : 0;
    const by = mh < vh ? -(vh - mh) / 2 : 0;
    cam.setBounds(bx, by, Math.max(mw, vw), Math.max(mh, vh));
    this.placePlayer();
    cam.startFollow(this.player, true, 1, 1);
    cam.centerOn(this.player.x, this.player.y);
  }

  placePlayer() {
    const loc = session.state.location;
    this.player.setPosition(loc.x * TILE + TILE / 2, loc.y * TILE + TILE / 2);
    this.player.setTexture(heroKey(loc.dir ?? 'down'));
  }

  /** 依 state 更新物件：if 不成立的不畫，已解開的門畫成開啟。 */
  refreshObjects() {
    const s = session.state;
    if (!s || !this.objSprites) return;
    for (const { obj, img } of this.objSprites.values()) {
      const vis = objectVisible(obj, s);
      img.setVisible(vis);
      if (vis && obj.lock) {
        const key = spriteKey(obj.sprite ?? 'unknown', isUnlocked(obj, s));
        if (img.texture.key !== key && this.textures.exists(key)) img.setTexture(key);
      }
    }
  }

  // ---------- 移動 ----------
  queueDir(dir) {
    if (this.canAct()) this.queued = dir;
  }

  canAct() {
    return !this.moving && !this.busy && this.flow === 0 && !this.ended && !session.inDialogue && session.state !== null;
  }

  heldDir() {
    const c = this.cursors;
    const k = this.wasd;
    if (c.up.isDown || k.W.isDown) return 'up';
    if (c.down.isDown || k.S.isDown) return 'down';
    if (c.left.isDown || k.A.isDown) return 'left';
    if (c.right.isDown || k.D.isDown) return 'right';
    return this.ui?.heldDir ?? null;
  }

  update(_t, delta) {
    // 遊戲時間：地圖場景執行中（含對話）都累加；選單開啟時本場景暫停，不累加
    session.elapsed += delta / 1000;
    if (session.elapsed >= 1 && !session.inDialogue) session.foldPlaytime();

    if (!this.canAct()) { this.queued = null; return; }
    const dir = this.queued ?? this.heldDir();
    this.queued = null;
    if (dir) this.tryStep(dir);
  }

  tryStep(dir) {
    const map = this.mapDef;
    const before = session.state.location;
    const r = step(map, session.state, dir, session.data);
    session.setState(r.state);
    this.player.setTexture(heroKey(dir));
    if (!r.moved) {
      if (r.event?.type === 'blocked' && r.event.dialogue) this.runDialogue(r.event.dialogue);
      return;
    }
    this.moving = true;
    const loc = r.state.location;
    this.tweens.add({
      targets: this.player,
      x: loc.x * TILE + TILE / 2,
      y: loc.y * TILE + TILE / 2,
      duration: MOVE_MS,
      onComplete: () => {
        this.moving = false;
        this.handleEvent(r.event, before);
      },
    });
  }

  /** before：踩上這一格之前的位置（core 的 trigger 事件有 from 時以它為準）。 */
  async handleEvent(ev, before = null) {
    if (!ev) return;
    if (ev.type === 'trigger' && (ev.dialogue || ev.battle)) {
      // 觸發點引發的戰鬥：逃跑成功後回到踩上觸發點之前的那一格（規格補充 2 第 9 條）
      const from = ev.from ?? before;
      this.triggerFrom = from && before ? { map: before.map, x: from.x, y: from.y, dir: from.dir ?? before.dir } : null;
      try {
        await this.locked(async () => {
          if (ev.dialogue) await this.runDialogue(ev.dialogue);
          if (ev.battle && !this.ended) await this.doBattle(ev.battle);
        });
      } finally {
        this.triggerFrom = null;
      }
    } else if (ev.type === 'exit') {
      await this.locked(async () => {
        await this.fade(false);
        const r = enterMap(session.state, session.data, ev.to, ev.spawn);
        session.setState(r.state);
        this.buildMap();
        await this.fade(true);
        if (r.dialogue) await this.runDialogue(r.dialogue);
      });
    }
  }

  /** 劇情流程鎖：流程進行中（含等待戰鬥結束）不能移動或開選單。 */
  async locked(fn) {
    this.flow += 1;
    try {
      await fn();
    } finally {
      this.flow -= 1;
    }
  }

  fade(fadeIn, ms = 160) {
    const cam = this.cameras.main;
    const d = TEST_MODE ? 60 : ms;
    return new Promise((res) => {
      if (fadeIn) { cam.fadeIn(d, 0, 0, 0); cam.once('camerafadeincomplete', res); } else { cam.fadeOut(d, 0, 0, 0); cam.once('camerafadeoutcomplete', res); }
    });
  }

  // ---------- 互動 ----------
  onAction(name) {
    if (name === 'menu') {
      if (!this.canAct()) return;
      this.openMenu();
      return;
    }
    if (!this.canAct()) return;
    const fn = name === 'echo' ? echoFacing : investigateFacing;
    let r;
    try {
      r = fn(this.mapDef, session.state, session.data);
    } catch (e) {
      console.warn(e);
      this.ui.toast('這裡好像出了點問題');
      return;
    }
    session.setState(r.state);
    if (r.dialogues.length || r.battle) this.runDialogues(r.dialogues, r.battle ?? null);
    else if (r.message) this.ui.toast(r.message);
  }

  /** 依序播放多段對話（例如調查上鎖的門：look → on_item／locked）；章節結束就停。battle：播完後開戰。 */
  async runDialogues(ids, battle = null) {
    await this.locked(async () => {
      for (const id of ids) {
        if (this.ended) return;
        await this.runDialogue(id);
      }
      if (battle && !this.ended) await this.doBattle(battle);
    });
  }

  /**
   * 播放對話；結束後若發生 chapter_end 就進章節結束畫面，否則依序處理對話留下的 pending（battle／goto）。
   */
  async runDialogue(id) {
    await this.locked(async () => {
      const before = new Set(session.state.chapter_done ?? []);
      await this.waitUi();
      if (this.ended) return;
      await this.ui.dialogue.play(id);
      this.refreshObjects();
      const ended = (session.state.chapter_done ?? []).find((c) => !before.has(c));
      if (ended && !this.ended) {
        this.ended = true;
        session.setState(takePending(session.state).state); // 章節結束後不再執行剩下的 pending
        session.foldPlaytime();
        this.cameras.main.fadeOut(TEST_MODE ? 150 : 600, 0, 0, 0);
        this.cameras.main.once('camerafadeoutcomplete', () => this.leave('ChapterEnd', { chapter: ended }));
        return;
      }
      await this.runPending();
    });
  }

  /** 取出 state.pending 依序執行：goto 移動地圖（再播 on_enter／dialogue），battle 開戰並等它結束。 */
  async runPending() {
    for (let guard = 0; guard < 50 && !this.ended; guard++) {
      const { state, pending } = takePending(session.state);
      if (pending.length === 0) return;
      session.setState(state);
      for (const p of pending) {
        if (this.ended) return;
        if (p.type === 'goto') await this.doGoto(p);
        else if (p.type === 'battle') await this.doBattle(p.encounter);
        else console.warn('不認得的 pending', p);
      }
    }
  }

  async doGoto(p) {
    this.triggerFrom = null; // 換了地圖，觸發點的「前一格」就不適用了
    await this.fade(false, 300);
    let r;
    try {
      r = enterMap(session.state, session.data, p.map, p.spawn);
    } catch (e) {
      console.warn('goto 失敗', e);
      await this.fade(true);
      return;
    }
    session.setState(r.state);
    this.buildMap();
    await this.fade(true, 300);
    for (const d of [...new Set([r.dialogue, p.dialogue].filter((x) => typeof x === 'string'))]) {
      if (this.ended) return;
      await this.runDialogue(d);
    }
  }

  /** 開戰（先自動存檔），等戰鬥結束回到地圖後播 on_win 的對話。 */
  async doBattle(encId) {
    const res = await this.battle(encId);
    if (this.ended || !res) return;
    if (res.next?.type === 'dialogue') await this.runDialogue(res.next.dialogue);
  }

  battle(encId) {
    session.foldPlaytime();
    const snap = session.snapshot();
    // 戰前自動存檔：給「重新挑戰」用；儲存空間不能用時，GameOver 改用記憶體中的備份
    const saved = session.saveBattleAuto(snap, encId);
    session.preBattle = { state: snap, encounter: encId };
    const notice = saved.ok ? null : saved.notice;
    const fleeBack = this.triggerFrom;
    this.triggerFrom = null; // 只套用在觸發點引發的第一場戰鬥
    return new Promise((resolve) => {
      session.battleReturn = (res) => {
        const loc = session.state?.location;
        if (res?.outcome === 'fled' && fleeBack && loc?.map === fleeBack.map) {
          // 前一格目前不能站（canMove false）時留在原地（規格補充 3 第 5 條）
          const map = session.mapById(loc.map);
          if (map) session.setState({ ...session.state, location: fleeBackLocation(map, session.state, fleeBack, session.data) });
        }
        this.scene.wake('UI');
        this.scene.wake();
        session.scene = 'Map';
        this.refreshObjects();
        this.placePlayer();
        this.cameras.main.fadeIn(TEST_MODE ? 0 : 250, 0, 0, 0);
        resolve(res);
      };
      const go = () => {
        if (this.ended) return;
        this.scene.sleep('UI');
        this.scene.sleep();
        this.scene.launch('Battle', { encounter: encId, seed: battleSeed(), notice });
      };
      if (TEST_MODE) { go(); return; }
      this.cameras.main.flash(180, 240, 240, 255);
      this.time.delayedCall(200, go);
    });
  }

  openMenu() {
    session.foldPlaytime();
    this.scene.pause('UI');
    this.scene.pause();
    this.scene.launch('Menu', { mode: 'game', from: 'Map' });
  }
}
