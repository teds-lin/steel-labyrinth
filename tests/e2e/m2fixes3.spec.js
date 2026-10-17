// M2 第二輪對抗審查修正（規格補充 3）的畫面層迴歸測試。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, game, TEST_URL, makeSave, seedSaves } from './helpers.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const readData = (rel) => JSON.parse(readFileSync(new URL(`../../web/data/${rel}`, import.meta.url), 'utf8'));
const sl = (page, fn, arg) => page.evaluate(fn, arg);

/** 審查者的攻擊存檔：碼頭過橋前、全隊 1 HP、崩解 95、沒有子彈。 */
function dockSave(over = {}) {
  return {
    ...makeSave(),
    schema_version: 2,
    lineage: { id: 'trace', rank: 9 },
    location: { map: 'dock', x: 9, y: 5, dir: 'right' },
    flags: { 'enter:office': true, 'enter:training': true, 'enter:dock': true, drank_potion: true, sparred: true },
    items: { revolver: 1 },
    echo: { charges: 0 },
    collapse: 95,
    resonance: {},
    chapter: 'chapter2',
    chapter_done: ['prologue', 'chapter1'],
    party: [{ id: 'hero', hp: 1, sp: 0 }, { id: 'ada', hp: 1, sp: 0 }],
    ammo: 0,
    pending: null,
    ...over,
  };
}

/** 第二章倉庫、面向沉默的搬運工的存檔。 */
function whSave(over = {}) {
  return dockSave({
    location: { map: 'warehouse', x: 7, y: 3, dir: 'up' },
    flags: {
      'enter:office': true, 'enter:training': true, 'enter:dock': true, 'enter:warehouse': true, drank_potion: true, sparred: true,
      fog1_done: true, fog2_done: true, fog3_done: true, boss_warned: true, ch2_deduced: true, wh_door_open: true,
    },
    items: { revolver: 1, bandage: 2, warehouse_key: 1 },
    collapse: 10,
    party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }],
    ammo: 6,
    ...over,
  });
}

async function loadSlot(g) {
  await g.waitScene('Title', 15_000);
  await g.sleep(300);
  await g.key('ArrowDown');
  await g.key('Enter');
  await g.waitScene('Menu');
  await g.sleep(100);
  await g.key('Enter');
}

/** 一律攻擊生命最少的敵人。 */
const attackWeakest = (b) => {
  const foes = b.units.filter((u) => u.side === 'enemy' && u.alive).sort((x, y) => x.hp - y.hp);
  return { skill: 'attack', target: foes[0].uid };
};

test.describe('規格補充 3（畫面層）', () => {
  test('N1 重新挑戰不能撈好處：故意全滅 → 重新挑戰 → 沒有「逃跑」，打贏後崩解仍 ≥ 戰前 95', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: dockSave() });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await loadSlot(g);
    await g.waitScene('Map');
    await g.press('right');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    const first = await g.battleWait();
    expect(first.commands.canFlee, '第一次（不是重試戰）可以逃').toBe(true);
    const lose = await g.fightBattle(() => ({ skill: 'guard' }), { maxTurns: 200 });
    expect(lose.scene).toBe('GameOver');
    await page.waitForFunction(() => window.__SL.gameOver() !== null);
    await g.key('Enter'); // 重新挑戰
    await g.waitScene('Battle');
    const b = await g.battleWait();
    expect(b.retry).toEqual({ preCollapse: 95 });
    expect(b.collapse).toBe(60); // prepareRetry：min(95, 60)，讓這場打得下去
    expect(b.commands.canFlee).toBe(false);
    expect(b.menu.buttons.map((x) => x.label)).not.toContain('逃跑');
    const win = await g.fightBattle(attackWeakest, { maxTurns: 200 });
    expect(win.last.result.outcome).toBe('victory');
    expect(win.scene).toBe('Map');
    await g.sleep(200);
    const after = await g.st();
    expect(after.collapse, '重試戰結束時崩解取 max(戰後, 戰前)').toBeGreaterThanOrEqual(95);
  });

  test('N5 戰鬥第一層：menu: root 的技能依 skills.json 順序，接著「技能」「道具」；wake 有訊息', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: whSave() });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await loadSlot(g);
    await g.waitScene('Map');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    let b = await g.battleWait();
    for (let i = 0; i < 10 && b.actor?.id !== 'hero'; i++) {
      await g.battleCommand(attackWeakest(b));
      b = await g.battleWait();
    }
    expect(b.actor?.id).toBe('hero');
    const skills = readData('skills.json');
    const heroSkills = readData('characters.json').find((c) => c.id === 'hero').skills;
    const roots = skills.filter((s) => s.menu === 'root' && heroSkills.includes(s.id)).map((s) => s.name);
    const labels = b.menu.buttons.map((x) => x.label);
    expect(labels).toEqual([...roots, '技能', '道具']); // Boss 戰不能逃，沒有「逃跑」
    // 攻擊、開槍、防禦都在畫面內、不重疊（375 寬的手機也一樣）
    for (const id of ['attack', 'shoot', 'guard']) {
      const bt = b.menu.buttons.find((x) => x.label === skills.find((s) => s.id === id).name);
      expect(bt.x).toBeGreaterThanOrEqual(0);
      expect(bt.x + bt.w).toBeLessThanOrEqual(360);
      expect(bt.y + bt.h).toBeLessThanOrEqual(640);
    }
    const shot = testInfo.outputPath(`battle-root-${testInfo.project.name}.png`);
    await page.screenshot({ path: shot });
    if (process.env.SL_SHOT_DIR) await page.screenshot({ path: join(process.env.SL_SHOT_DIR, `battle-root-${testInfo.project.name}.png`) });

    const msg = await page.evaluate(async () => (await import('./src/battle-view.js')).describe({ type: 'wake', uid: 'e0' }, { e0: '沉默的搬運工' }, {}));
    expect(msg).toBe('沉默的搬運工醒過來了！');
  });
});
