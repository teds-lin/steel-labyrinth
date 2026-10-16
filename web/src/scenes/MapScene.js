// 地圖：繪製地形與物件、主角格子移動（補間）、鏡頭跟隨、出口／觸發點／互動。
import { TILE, MAP_ZOOM, MAP_VIEW, COLORS } from '../config.js';
import { session } from '../session.js';
import { step, enterMap, mapSize, tileIdAt, objectVisible, isUnlocked } from '../core/grid.js';
import { tileKey, spriteKey, heroKey } from '../textures.js';
import { investigate, useEcho } from '../adapters.js';

const MOVE_MS = 150;

export class MapScene extends Phaser.Scene {
  constructor() { super('Map'); }

  init(data) {
    this.intro = Array.isArray(data?.intro) ? data.intro : [];
  }

  create() {
    session.scene = 'Map';
    this.moving = false;
    this.busy = false;
    this.queued = null;
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
    this.events.on('resume', () => { session.scene = 'Map'; });

    // 新遊戲的開場對話（UI 場景要等它 create 完）
    if (this.intro.length) {
      const list = this.intro;
      this.intro = [];
      this.busy = true;
      this.time.delayedCall(0, async () => {
        for (const id of list) {
          if (this.ended) return;
          await this.runDialogue(id);
        }
        this.busy = false;
      });
    }
  }

  get ui() { return this.scene.get('UI'); }

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
    // 煤氣燈／壁燈的光暈
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const id = tileIdAt(map, x, y);
        if (id === 'gas_lamp' || id === 'wall_lamp') {
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
    return !this.moving && !this.busy && !this.ended && !session.inDialogue && session.state !== null;
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
        this.handleEvent(r.event);
      },
    });
  }

  async handleEvent(ev) {
    if (!ev) return;
    if (ev.type === 'trigger' && ev.dialogue) {
      await this.runDialogue(ev.dialogue);
    } else if (ev.type === 'exit') {
      this.busy = true;
      const cam = this.cameras.main;
      await new Promise((res) => { cam.fadeOut(160, 0, 0, 0); cam.once('camerafadeoutcomplete', res); });
      const r = enterMap(session.state, session.data, ev.to, ev.spawn);
      session.setState(r.state);
      this.buildMap();
      await new Promise((res) => { cam.fadeIn(160, 0, 0, 0); cam.once('camerafadeincomplete', res); });
      if (r.dialogue) await this.runDialogue(r.dialogue);
      this.busy = false;
    }
  }

  // ---------- 互動 ----------
  onAction(name) {
    if (name === 'menu') {
      if (!this.canAct()) return;
      this.openMenu();
      return;
    }
    if (!this.canAct()) return;
    const fn = name === 'echo' ? useEcho : investigate;
    let r;
    try {
      r = fn(this.mapDef, session.state, session.data);
    } catch (e) {
      console.error(e);
      this.ui.toast('這裡好像出了點問題');
      return;
    }
    session.setState(r.state);
    if (r.dialogue) this.runDialogue(r.dialogue);
    else if (r.message) this.ui.toast(r.message);
  }

  /** 播放對話；結束後若發生 chapter_end 就進章節結束畫面。 */
  async runDialogue(id) {
    const before = new Set(session.state.chapter_done ?? []);
    this.busy = true;
    await this.waitUi();
    await this.ui.dialogue.play(id);
    this.busy = false;
    this.refreshObjects();
    const ended = (session.state.chapter_done ?? []).find((c) => !before.has(c));
    if (ended && !this.ended) {
      this.ended = true;
      session.foldPlaytime();
      this.cameras.main.fadeOut(600, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => this.leave('ChapterEnd', { chapter: ended }));
    }
  }

  openMenu() {
    session.foldPlaytime();
    this.scene.pause('UI');
    this.scene.pause();
    this.scene.launch('Menu', { mode: 'game', from: 'Map' });
  }
}
