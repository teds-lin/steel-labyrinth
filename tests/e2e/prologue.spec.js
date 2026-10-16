// 《鋼鐵迷都》序章 E2E：desktop 用鍵盤、mobile 用觸控按鈕操作移動與調查。
import { test, expect, game, TEST_URL, START_ECHO } from './helpers.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';

test.describe('序章', () => {
  test('(a) 不用殘響的通關路線 + 存檔 → 回標題 → 繼續讀檔', async ({ page }, testInfo) => {
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await g.newGame('艾琳');

    // 開場對話
    const opening = await g.finishDialogue();
    expect(opening.length).toBeGreaterThan(0);
    let s = await g.st();
    expect(s.flags['enter:attic']).toBe(true);
    expect(s.echo.charges).toBe(START_ECHO);
    expect(s.collapse).toBe(0);

    // 對空地按殘響：不該扣次數、也不該開對話
    await g.stepDir('right');
    await g.act('echo');
    await g.sleep(250);
    expect(await g.dlg()).toBeNull();
    expect((await g.st()).echo.charges).toBe(START_ECHO);

    // 沒有鑰匙先調查門：locked 對話，門不開、不扣殘響
    await g.useOn('obj_door');
    await g.finishDialogue();
    s = await g.st();
    expect(s.flags.door_open).toBeFalsy();
    expect(s.echo.charges).toBe(START_ECHO);

    // 五斗櫃撬出鑰匙（選項 0：把底板撬起來）
    await g.useOn('obj_drawer');
    await g.finishDialogue([0]);
    expect((await g.st()).items.attic_key).toBe(1);

    // 用鑰匙開門
    await g.useOn('obj_door');
    await g.finishDialogue();
    s = await g.st();
    expect(s.flags.door_open).toBe(true);
    expect(s.echo.charges).toBe(START_ECHO);
    expect(s.collapse).toBe(0);

    // 走廊：對房東說實話
    await g.takeExit('hallway');
    expect((await g.st()).location.map).toBe('hallway');
    await g.waitDialogue();
    await g.finishDialogue([0]);
    s = await g.st();
    expect(s.flags.told_truth).toBe(true);
    expect(s.flags.talked_landlady).toBe(true);
    expect(s.flags.lie_exposed).toBeFalsy();
    expect(s.echo.charges).toBe(START_ECHO);

    // 樓梯下到街上，走進觸發點，結局對話
    await g.takeExit('street');
    expect((await g.st()).location.map).toBe('street');
    await g.waitDialogue();
    await g.finishDialogue();
    const street = await g.mapData('street');
    const trg = street.triggers.find((t) => t.id === 'trg_prologue_end');
    await g.goTo(trg.x, trg.y);
    await g.waitDialogue();
    await g.finishDialogue([0]);
    s = await g.st();
    expect(s.chapter_done).toContain('prologue');
    await g.waitScene('ChapterEnd');
    await g.sleep(1200);

    // 存檔（章節結束畫面 → 存檔 → 槽 1）
    await g.key('Enter');
    await g.waitScene('Menu');
    await g.sleep(100);
    await g.key('Enter');
    await g.sleep(200);
    await g.key('Escape');
    await g.waitScene('ChapterEnd');

    // 回標題 → 繼續 → 讀取槽 1
    await g.key('ArrowDown');
    await g.key('Enter');
    await g.waitScene('Title');
    await g.sleep(250);
    await g.key('ArrowDown');
    await g.key('Enter');
    await g.waitScene('Menu');
    await g.sleep(100);
    await g.key('Enter');
    await g.waitScene('Map');
    const loaded = await g.st();
    expect(loaded.location.map).toBe('street');
    expect(loaded.chapter_done).toContain('prologue');
    expect(loaded.player.name).toBe('艾琳');
    expect(loaded.items.attic_key).toBe(1);
    expect(loaded.flags.told_truth).toBe(true);

    // 讀檔後還能移動、能開選單
    await g.stepDir('right');
    expect((await g.st()).location.x).toBe(loaded.location.x + 1);
    await g.act('menu');
    await g.waitScene('Menu');
    await g.key('Escape');
    await g.waitScene('Map');
  });

  test('(b) 用殘響的路線：藥瓶殘響、殘響開門、房東說謊後看穿', async ({ page }, testInfo) => {
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await g.newGame('艾琳');
    await g.finishDialogue();

    // 藥瓶殘響
    await g.useOn('obj_vial', 'echo');
    await g.finishDialogue();
    let s = await g.st();
    expect(s.echo.charges).toBe(START_ECHO - 1);
    expect(s.collapse).toBe(5);
    expect(s.flags.echo_vial).toBe(true);

    // 殘響開門（同時取得鑰匙）
    await g.useOn('obj_door', 'echo');
    await g.finishDialogue();
    s = await g.st();
    expect(s.echo.charges).toBe(START_ECHO - 2);
    expect(s.collapse).toBe(10);
    expect(s.flags.door_open).toBe(true);
    expect(s.items.attic_key).toBe(1);

    // 房東：說謊（選項 1），再用殘響看穿（選項 1）
    await g.takeExit('hallway');
    await g.waitDialogue();
    await g.finishDialogue([1, 1]);
    s = await g.st();
    expect(s.flags.told_lie).toBe(true);
    expect(s.flags.lie_exposed).toBe(true);
    expect(s.resonance.lie_exposed).toBe(1);
    expect(s.echo.charges).toBe(START_ECHO - 3);
    expect(s.collapse).toBe(15);

    // 殘響用完：再按殘響只會提示，不開對話、不扣到負數
    await g.act('echo');
    await g.sleep(250);
    s = await g.st();
    expect(await g.dlg()).toBeNull();
    expect(s.echo.charges).toBe(0);
    expect(s.collapse).toBe(15);
  });

  test('(c) 名字含 <b> 時被清理', async ({ page }, testInfo) => {
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await g.newGame('艾琳<b>・測試');
    const s = await g.st();
    expect(s.player.name).toBe('艾琳b・測試');
    expect(s.player.name).not.toMatch(/[<>]/);
    // 對話裡的 {name} 顯示的也是清理後的名字
    const lines = await g.finishDialogue();
    expect(lines.join('\n')).not.toMatch(/<b>/);
  });

  test('(d) localStorage 被封鎖時遊戲仍可玩、「繼續」停用', async ({ page, context }, testInfo) => {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    const g = game(page, { touch: isTouch(testInfo) });
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(300);

    // 「繼續」停用：游標跳過它，往下再按 Enter 選到的仍是「新遊戲」，進不了讀檔畫面（Menu）
    await g.key('ArrowDown');
    await g.key('Enter');
    await g.waitScene('Name');
    expect(await g.scene()).not.toBe('Menu');

    // 新遊戲照常可玩：開場、移動、開選單
    await page.press('.sl-name-input', 'Enter');
    await g.waitScene('Map');
    await g.waitDialogue();
    await g.finishDialogue();
    const before = (await g.st()).location;
    await g.stepDir('right');
    expect((await g.st()).location.x).toBe(before.x + 1);
    await g.act('menu');
    await g.waitScene('Menu');
  });

  test('(e) 正常模式（不帶 test 參數）下 window.__SL 不存在', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(2500); // 讓遊戲完成載入
    expect(await page.evaluate(() => typeof window.__SL)).toBe('undefined');
    expect(await page.evaluate(() => 'window' in globalThis && Object.getOwnPropertyNames(window).includes('__SL'))).toBe(false);
    // test=0 也不暴露
    await page.goto('/?test=0');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => typeof window.__SL)).toBe('undefined');
  });

  test.describe('375x667 版面', () => {
    test.use({ viewport: { width: 375, height: 667 } });
    test('(g) 標題、命名、地圖、對話中都沒有橫向捲軸', async ({ page }, testInfo) => {
      const g = game(page, { touch: isTouch(testInfo) });
      await page.goto(TEST_URL);
      await g.waitScene('Title', 15_000);
      await g.sleep(300);
      await g.noHScroll();
      await g.key('Enter');
      await g.waitScene('Name');
      await page.fill('.sl-name-input', '艾琳');
      await g.noHScroll();
      await page.press('.sl-name-input', 'Enter');
      await g.waitScene('Map');
      await g.waitDialogue();
      await g.noHScroll();
      await g.finishDialogue();
      await g.noHScroll();
      await g.act('menu');
      await g.waitScene('Menu');
      await g.noHScroll();
    });
  });
});
