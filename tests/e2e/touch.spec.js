// 純觸控、正常模式（不加 ?test=1：打字機開啟、霧氣動畫開啟）的全程通關。只在 mobile project 跑。
// 正常模式不暴露 window.__SL，所以用 dynamic import 取得與遊戲同一個模組實例，裝一個與 __SL 相容的唯讀觀測墊片，
// 讓 helpers.js 的 game()（finishDialogue／useOn／takeExit…）照常可用。所有輸入都只用 tap。
import { test, expect, game } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 正常模式的觀測墊片：__SL（getState／currentScene／dialogue／choiceRects）與 __btns（列出某場景的按鈕）。 */
async function installProbe(page) {
  await page.waitForFunction(() => document.querySelector('canvas'));
  await page.evaluate(async () => {
    const { session } = await import('./src/session.js');
    const { game: phaserGame } = await import('./src/main.js');
    const act = (k) => {
      const sc = phaserGame.scene.getScene(k);
      return sc && (sc.sys.isActive() || sc.sys.isPaused()) ? sc : null;
    };
    Object.defineProperty(window, '__SL', {
      configurable: true,
      value: {
        getState: () => structuredClone(session.snapshot()),
        currentScene: () => session.scene,
        dialogue: () => (session.dialogueView ? structuredClone(session.dialogueView) : null),
        choiceRects: () => act('UI')?.dialogue?.choiceRects() ?? [],
      },
    });
    // 列出某場景所有 Button（邏輯座標中心、是否可見）
    window.__btns = (key) => {
      const sc = act(key);
      if (!sc) return [];
      const out = [];
      const walk = (list) => {
        for (const o of list) {
          if (o.hit && o.label && o.activate) {
            const b = o.hit.getBounds();
            out.push({ label: o.label.text, enabled: o.enabled, visible: o.visible && (!o.parentContainer || o.parentContainer.visible), cx: b.centerX, cy: b.centerY });
          }
          if (o.list) walk(o.list);
        }
      };
      walk(sc.children.list);
      return out;
    };
  });
}

/** 等某場景出現指定文字的可見按鈕，點它。 */
async function tapLabel(page, g, scene, label, timeout = 8_000) {
  const t0 = Date.now();
  for (;;) {
    const bs = await page.evaluate((s) => window.__btns(s), scene);
    const b = bs.find((x) => x.label === label && x.visible);
    if (b) { await g.tap(b.cx, b.cy); return b; }
    if (Date.now() - t0 > timeout) throw new Error(`找不到按鈕 ${scene}/${label}：${JSON.stringify(bs)}`);
    await sleep(100);
  }
}

test('正常模式（打字機開啟）只用 tap 全程通關：新遊戲 → 鑰匙開門 → 序章結束 → 存檔 → 回標題 → 讀檔', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', '純觸控流程只在 mobile project 跑');
  await page.goto('./');
  await page.waitForFunction(() => document.querySelector('canvas'));
  expect(await page.evaluate(() => window.__SL), '正常模式不應暴露 __SL').toBeUndefined();
  await installProbe(page);

  const g = game(page, { touch: true });
  await g.waitScene('Title', 15_000);
  await sleep(400);
  await tapLabel(page, g, 'Title', '新遊戲');
  await g.waitScene('Name');
  await page.locator('.sl-name-input').tap();
  await page.fill('.sl-name-input', '小明');
  await tapLabel(page, g, 'Name', '確定');
  await g.waitScene('Map');
  await g.waitDialogue();

  // 打字中點對話框：快轉而非跳句
  const d0 = await g.dlg();
  await g.tap(180, 560);
  expect((await g.dlg()).text).toBe(d0.text);
  await g.finishDialogue();

  // 鑰匙路線（全觸控）
  await g.useOn('obj_drawer');
  const ask = await g.advanceToChoice();
  await page.waitForFunction(() => window.__SL.choiceRects().length > 0);
  // 選項節點：點對話框空白、畫面其他地方都不會誤選
  await g.tap(180, 560);
  await g.tap(30, 100);
  await sleep(200);
  expect((await g.dlg()).choices).toEqual(ask.choices);

  // 快速雙擊第一個選項（撬開）：只選一次，不會連跳過「拿到鑰匙」那一句
  const rects = await page.evaluate(() => window.__SL.choiceRects());
  const box = await page.locator('canvas').boundingBox();
  const px = box.x + ((rects[0].x + rects[0].w / 2) * box.width) / 360;
  const py = box.y + ((rects[0].y + rects[0].h / 2) * box.height) / 640;
  await page.touchscreen.tap(px, py);
  await page.touchscreen.tap(px, py);
  await sleep(300);
  expect((await g.dlg())?.text ?? '').toContain('夾層裡躺著一把黃銅鑰匙');
  expect((await g.st()).items.attic_key).toBe(1);
  await g.finishDialogue([]);

  await g.useOn('obj_door');
  await g.finishDialogue();
  expect((await g.st()).flags.door_open).toBe(true);
  await g.takeExit('hallway');
  await g.waitDialogue();
  await g.finishDialogue([1, 1]);
  await g.takeExit('street');
  await g.waitDialogue();
  await g.finishDialogue();
  const street = await g.mapData('street');
  const trg = street.triggers.find((t) => t.id === 'trg_prologue_end');
  await g.goTo(trg.x, trg.y);
  await g.waitDialogue();
  await g.finishDialogue([1]);

  // 章節結束 → 存檔（第一格）→ 返回 → 回標題 → 繼續 → 讀第一格
  await g.waitScene('ChapterEnd');
  await tapLabel(page, g, 'ChapterEnd', '存檔', 10_000);
  await g.waitScene('Menu');
  await sleep(200);
  const saveSlots = await page.evaluate(() => window.__btns('Menu'));
  await tapLabel(page, g, 'Menu', saveSlots[0].label);
  await sleep(300);
  await tapLabel(page, g, 'Menu', '返回');
  await g.waitScene('ChapterEnd');
  await tapLabel(page, g, 'ChapterEnd', '回標題');
  await g.waitScene('Title');
  await sleep(300);
  await tapLabel(page, g, 'Title', '繼續');
  await g.waitScene('Menu');
  await sleep(200);
  const loadSlots = await page.evaluate(() => window.__btns('Menu'));
  await tapLabel(page, g, 'Menu', loadSlots[0].label);
  await g.waitScene('Map');

  const s = await g.st();
  expect(s.chapter_done).toContain('prologue');
  expect(s.player.name).toBe('小明');
  await g.noHScroll();
});
