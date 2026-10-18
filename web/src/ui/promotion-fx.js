// 喝下靈劑的演出（M5）：畫面暗下 → 鏡面浮現（映出主角）→ 霧氣 → 新階位名稱與獲得的能力。
// 硬喝（共鳴不足）時鏡面泛紅、出現裂痕、畫面震動，並顯示崩解提示。點畫面或按確認鍵關閉。
// 內容（文字）由 m5-view.js 的 promotionFxView 算好，這裡只負責畫。
import { WIDTH, HEIGHT, COLORS, TEST_MODE } from '../config.js';
import { addText } from './widgets.js';
import { heroKey } from '../textures.js';

const DEPTH = 70;
const MIRROR = { x: WIDTH / 2, y: 210, w: 150, h: 196 };
const CONFIRM_KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'KeyZ']);

/** 固定種子的亂數（裂痕每次都畫得一樣）。 */
function seeded(n) {
  let s = n;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

export class PromotionFx {
  constructor(scene, view) {
    this.scene = scene;
    this.view = view;
    this.ready = false;
    this.closing = false;
    this.cracks = 0;
    this.objs = [];
    this.done = new Promise((res) => { this.resolveDone = res; });
    const forced = view.forced === true;
    const add = (o) => { this.objs.push(o); return o; };
    const intro = TEST_MODE ? 120 : 1400;

    this.dim = add(scene.add.rectangle(0, 0, WIDTH, HEIGHT, forced ? 0x14060a : 0x020306, 1).setOrigin(0).setDepth(DEPTH).setAlpha(0));
    // 點擊攔截：蓋住下面的對話框與觸控按鈕
    this.hit = add(scene.add.zone(0, 0, WIDTH, HEIGHT).setOrigin(0).setDepth(DEPTH + 9).setInteractive());
    this.hit.on('pointerup', () => this.dismiss());

    // 霧（鏡子後面）
    const fogs = [];
    const rand = seeded(forced ? 11 : 5);
    for (let i = 0; i < 6; i++) {
      const f = add(scene.add.image(40 + rand() * 280, 120 + rand() * 260, 'fx:fog').setDepth(DEPTH + 1).setScale(2 + rand() * 1.5).setAlpha(0)
        .setTint(forced ? 0xd07080 : 0xb4c4dc));
      fogs.push(f);
    }

    // 鏡面：橢圓的鏡框、冷色的鏡面、映出主角、一道光掃過
    const m = MIRROR;
    const g = add(scene.add.graphics().setDepth(DEPTH + 2).setAlpha(0));
    g.fillStyle(forced ? 0x3a1018 : 0x1a2436, 1).fillEllipse(m.x, m.y, m.w, m.h);
    g.fillStyle(forced ? 0x8a3040 : 0x9fb8d8, 0.22).fillEllipse(m.x, m.y, m.w - 16, m.h - 16);
    g.lineStyle(4, forced ? 0xa04050 : 0xd8c8a0, 1).strokeEllipse(m.x, m.y, m.w, m.h);
    g.lineStyle(1, forced ? 0x602030 : 0x8a7a5a, 1).strokeEllipse(m.x, m.y, m.w - 12, m.h - 12);
    this.mirror = g;
    const hero = add(scene.add.image(m.x, m.y + 8, heroKey('down')).setDepth(DEPTH + 3).setScale(3).setAlpha(0)
      .setTint(forced ? 0xe0a0a8 : 0xc8d8f0));
    this.hero = hero;
    const shine = add(scene.add.rectangle(m.x - m.w, m.y, 18, m.h * 1.4, 0xffffff, 0.28).setDepth(DEPTH + 4).setAngle(18).setAlpha(0));
    const maskShape = scene.make.graphics({ x: 0, y: 0, add: false });
    maskShape.fillStyle(0xffffff).fillEllipse(m.x, m.y, m.w - 8, m.h - 8);
    shine.setMask(maskShape.createGeometryMask());
    this.maskShape = maskShape;

    // 硬喝：裂痕
    let cracks = null;
    if (forced) {
      cracks = add(scene.add.graphics().setDepth(DEPTH + 5).setAlpha(0));
      cracks.lineStyle(2, 0xffd0d8, 0.9);
      const r2 = seeded(23);
      const cx = m.x + 10;
      const cy = m.y - 20;
      for (let i = 0; i < 7; i++) {
        let x = cx;
        let y = cy;
        const a0 = (i / 7) * Math.PI * 2 + r2() * 0.6;
        for (let k = 0; k < 4; k++) {
          const a = a0 + (r2() - 0.5) * 0.7;
          const len = 10 + r2() * 14;
          const nx = x + Math.cos(a) * len;
          const ny = y + Math.sin(a) * len;
          // 只畫在鏡面裡面
          if (((nx - m.x) / (m.w / 2)) ** 2 + ((ny - m.y) / (m.h / 2)) ** 2 > 0.9) break;
          cracks.lineBetween(x, y, nx, ny);
          x = nx;
          y = ny;
        }
        this.cracks += 1;
      }
      add(scene.add.image(WIDTH / 2, HEIGHT / 2, 'fx:vignette').setDisplaySize(WIDTH, HEIGHT).setDepth(DEPTH + 1).setAlpha(0.9));
    }

    // 文字
    const head = add(addText(scene, WIDTH / 2, 82, view.title ?? '晉升', {
      fontSize: '15px', color: forced ? '#f0a0a8' : '#c8d8ff', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(DEPTH + 6).setAlpha(0));
    const name = add(addText(scene, WIDTH / 2, 342, view.name ?? '', {
      fontSize: '32px', fontStyle: 'bold', color: forced ? '#ffb0b8' : '#f0d2a0',
    }).setOrigin(0.5).setDepth(DEPTH + 6).setAlpha(0));
    if (name.width > WIDTH - 32) name.setScale((WIDTH - 32) / name.width);
    const rank = add(addText(scene, WIDTH / 2, 378, Number.isInteger(view.rank) ? `階 ${view.rank}` : '', {
      fontSize: '14px', color: COLORS.textDim,
    }).setOrigin(0.5).setDepth(DEPTH + 6).setAlpha(0));
    const body = add(addText(scene, WIDTH / 2, 408, (view.lines ?? []).join('\n'), {
      fontSize: '16px', color: COLORS.text, align: 'center', lineSpacing: 8, wordWrap: { width: WIDTH - 40, useAdvancedWrap: true },
    }).setOrigin(0.5, 0).setDepth(DEPTH + 6).setAlpha(0));
    const texts = [head, name, rank, body];
    if (view.warning) {
      const warn = add(addText(scene, WIDTH / 2, body.y + body.height + 14, view.warning, {
        fontSize: '14px', color: '#f08890', align: 'center', wordWrap: { width: WIDTH - 48, useAdvancedWrap: true },
      }).setOrigin(0.5, 0).setDepth(DEPTH + 6).setAlpha(0));
      texts.push(warn);
    }
    this.hint = add(addText(scene, WIDTH / 2, HEIGHT - 34, '點一下繼續', { fontSize: '13px', color: COLORS.textDim })
      .setOrigin(0.5).setDepth(DEPTH + 6).setAlpha(0));

    // 演出：暗下 → 霧與鏡面 → 光掃過 → 文字
    const tw = scene.tweens;
    tw.add({ targets: this.dim, alpha: forced ? 0.9 : 0.86, duration: intro * 0.3 });
    tw.add({ targets: fogs, alpha: 0.5, duration: intro * 0.5, delay: intro * 0.15 });
    tw.add({ targets: [g, cracks].filter(Boolean), alpha: 1, duration: intro * 0.4, delay: intro * 0.25 });
    tw.add({ targets: hero, alpha: 0.7, duration: intro * 0.4, delay: intro * 0.35 });
    tw.add({ targets: texts, alpha: 1, duration: intro * 0.3, delay: intro * 0.6 });
    if (!TEST_MODE) {
      tw.add({ targets: shine, alpha: 1, x: m.x + m.w, duration: 900, delay: intro * 0.5, repeat: -1, repeatDelay: 1600 });
      for (const f of fogs) tw.add({ targets: f, x: f.x + 24, duration: 4000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      if (forced) {
        scene.time.delayedCall(intro * 0.4, () => scene.cameras.main.shake(380, 0.012));
        tw.add({ targets: hero, alpha: 0.25, duration: 120, yoyo: true, repeat: -1, repeatDelay: 700, delay: intro });
      }
    }
    scene.time.delayedCall(intro, () => {
      if (this.closing) return;
      this.ready = true;
      this.hint.setAlpha(1);
      if (!TEST_MODE) tw.add({ targets: this.hint, alpha: 0.3, duration: 600, yoyo: true, repeat: -1 });
    });
  }

  handleKey(code) {
    if (CONFIRM_KEYS.has(code)) this.dismiss();
  }

  dismiss() {
    if (!this.ready || this.closing) return;
    this.closing = true;
    this.scene.tweens.add({
      targets: this.objs.filter((o) => o.alpha !== undefined && o !== this.hit),
      alpha: 0,
      duration: TEST_MODE ? 60 : 350,
      onComplete: () => { this.destroy(); this.resolveDone(); },
    });
  }

  destroy() {
    for (const o of this.objs) {
      this.scene.tweens.killTweensOf(o);
      o.destroy();
    }
    this.objs = [];
    this.maskShape?.destroy();
    this.maskShape = null;
  }

  debugInfo() {
    const v = this.view;
    return {
      ready: this.ready && !this.closing, forced: v.forced === true, title: v.title, name: v.name, rank: v.rank,
      lines: [...(v.lines ?? [])], warning: v.warning ?? null, collapseGain: v.collapseGain ?? 0,
      abilities: [...(v.abilities ?? [])], skills: [...(v.skills ?? [])],
      mirror: !!this.mirror, dim: this.dim?.alpha ?? 0, cracks: this.cracks,
    };
  }
}
