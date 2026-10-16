// M2 第一輪對抗審查修正輪（畫面層）的迴歸測試：每一項對應 docs/DATA-FORMAT.md「規格補充 2」或審查報告的一個問題。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, game, TEST_URL, makeSave, seedSaves } from './helpers.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const readData = (rel) => JSON.parse(readFileSync(new URL(`../../web/data/${rel}`, import.meta.url), 'utf8'));
const sl = (page, fn, arg) => page.evaluate(fn, arg);
const AUTO = 'steel-labyrinth:save:auto';

/** 第二章倉庫的 v2 存檔（面向沉默的搬運工）；over 淺層合併。 */
function whSave(over = {}) {
  return {
    ...makeSave(),
    schema_version: 2,
    lineage: { id: 'trace', rank: 9 },
    location: { map: 'warehouse', x: 7, y: 3, dir: 'up' },
    flags: {
      'enter:office': true, 'enter:training': true, 'enter:dock': true, 'enter:warehouse': true, drank_potion: true, sparred: true,
      fog1_done: true, fog2_done: true, fog3_done: true, boss_warned: true, ch2_deduced: true, wh_door_open: true,
    },
    items: { revolver: 1, bandage: 2, sedative_incense: 1, warehouse_key: 1 },
    echo: { charges: 0 },
    collapse: 10,
    resonance: { clue_found: 3, deduction_correct: 1 },
    chapter: 'chapter2',
    chapter_done: ['prologue', 'chapter1'],
    party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }],
    ammo: 12,
    pending: null,
    ...over,
  };
}

/** 瀕死、崩解 80 的 Boss 前存檔：只防禦很快就會 Game Over。 */
const dyingBossSave = () => whSave({ party: [{ id: 'hero', hp: 1, sp: 2 }, { id: 'ada', hp: 1, sp: 3 }], collapse: 80, ammo: 5 });

async function loadSlot(g, slot = 1) {
  await g.waitScene('Title', 15_000);
  await g.sleep(300);
  await g.key('ArrowDown');
  await g.key('Enter');
  await g.waitScene('Menu');
  await g.sleep(100);
  for (let i = 1; i < slot; i++) await g.key('ArrowDown');
  await g.key('Enter');
}

/** 讀檔 → 調查搬運工 → 開戰；回傳開戰時的戰鬥摘要。 */
async function startBoss(page, g) {
  await loadSlot(g, 1);
  await g.waitScene('Map');
  await g.act('investigate');
  await g.waitDialogue();
  await g.finishDialogue();
  await g.waitScene('Battle');
  return g.battleWait();
}

/** 用「攻擊」讓其他隊友行動，直到輪到主角（隊友速度可能比主角快）。 */
async function heroTurn(g, b) {
  for (let i = 0; i < 10 && b.actor?.id !== 'hero'; i++) {
    const enemy = b.units.find((u) => u.side === 'enemy' && u.alive);
    await g.battleCommand({ skill: 'attack', target: enemy.uid });
    b = await g.battleWait();
  }
  expect(b.actor?.id).toBe('hero');
  return b;
}

/** 一直防禦直到 Game Over。 */
async function loseToGameOver(page, g) {
  const r = await g.fightBattle(() => ({ skill: 'guard' }), { maxTurns: 200 });
  expect(r.scene).toBe('GameOver');
  await page.waitForFunction(() => window.__SL.gameOver() !== null);
  return sl(page, () => window.__SL.gameOver());
}

/** 選 Game Over 的第 i 個按鈕（手機點、桌機 Enter）。 */
async function pickGameOver(page, g, i, touch) {
  const go = await sl(page, () => window.__SL.gameOver());
  if (touch) {
    const r = go.items[i];
    await g.tap(r.x + r.w / 2, r.y + r.h / 2);
  } else {
    for (let k = 0; k < i; k++) await g.key('ArrowDown');
    await g.key('Enter');
  }
}

/** 隊伍滿血滿靈性、崩解 min(戰前, 60)：由 prepareRetry 計算的結果。 */
function expectRetryState(b, preCollapse, preAmmo) {
  for (const u of b.units.filter((x) => x.side === 'party')) {
    expect(u.hp, `${u.id} 生命`).toBe(u.maxHp);
    expect(u.sp, `${u.id} 靈性`).toBe(u.maxSp);
  }
  expect(b.collapse).toBe(Math.min(preCollapse, 60));
  expect(b.ammo).toBe(preAmmo);
}

/** 把頁面記憶體裡的戰前備份清掉（模擬重新整理後只剩 localStorage 的情況）。 */
const dropMemoryBackup = (page) => page.evaluate(async () => {
  const { session } = await import('./src/session.js');
  session.preBattle = null;
});

test.describe('M2 修正（畫面層）', () => {
  test('#1 重新挑戰：全隊恢復（生命靈性回滿、崩解 ≤ 60）後重打同一場', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: dyingBossSave() });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    const b0 = await startBoss(page, g);
    expect(b0.encounter).toBe('enc_boss');
    const go = await loseToGameOver(page, g);
    expect(go.items[0].label).toBe('重新挑戰');
    expect(go.items[0].sub).toBe('全隊恢復後重新挑戰');
    await page.screenshot({ path: testInfo.outputPath(`gameover-${testInfo.project.name}.png`) });
    await pickGameOver(page, g, 0, touch);
    await g.waitScene('Battle');
    const b = await g.battleWait();
    expect(b.encounter).toBe('enc_boss');
    expectRetryState(b, 80, 5);
  });

  test('#2 自動存檔是舊的另一場：以記憶體備份為準', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: dyingBossSave() });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await startBoss(page, g);
    // 模擬自動存檔寫入失敗、留著上一場（碼頭）的舊存檔
    await page.evaluate((k) => {
      const o = JSON.parse(localStorage.getItem(k));
      localStorage.setItem(k, JSON.stringify({ ...o, location: { map: 'dock', x: 9, y: 5, dir: 'right' }, auto_battle: 'enc_dock_1' }));
    }, AUTO);
    await loseToGameOver(page, g);
    await pickGameOver(page, g, 0, touch);
    await g.waitScene('Battle');
    const b = await g.battleWait();
    expect(b.encounter).toBe('enc_boss');
    expect((await g.st()).location.map).toBe('warehouse');
  });

  for (const [name, autoBattle] of [['別場戰鬥', 'enc_dock_1'], ['不存在的遭遇', 'enc_nope'], ['沒有 auto_battle', null]]) {
    test(`#2b 記憶體沒有備份、自動存檔是${name}：不開戰，提示並回標題`, async ({ page }, testInfo) => {
      const touch = isTouch(testInfo);
      await seedSaves(page, { 1: dyingBossSave() });
      const g = game(page, { touch });
      await page.goto(TEST_URL);
      await startBoss(page, g);
      await loseToGameOver(page, g);
      await dropMemoryBackup(page);
      await page.evaluate(([k, ab]) => {
        const o = JSON.parse(localStorage.getItem(k));
        const next = { ...o };
        if (ab === null) delete next.auto_battle; else next.auto_battle = ab;
        localStorage.setItem(k, JSON.stringify(next));
      }, [AUTO, autoBattle]);
      await pickGameOver(page, g, 0, touch);
      await page.waitForFunction(() => /無法重新挑戰，請讀取存檔/.test(window.__SL.gameOver()?.note ?? ''), null, { timeout: 3_000 });
      await g.waitScene('Title', 8_000);
      expect(await sl(page, () => window.__SL.battle())).toBeNull();
    });
  }

  test('#2c 記憶體沒有備份、自動存檔正確：用自動存檔重新挑戰', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: dyingBossSave() });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await startBoss(page, g);
    await loseToGameOver(page, g);
    await dropMemoryBackup(page);
    await pickGameOver(page, g, 0, touch);
    await g.waitScene('Battle');
    const b = await g.battleWait();
    expect(b.encounter).toBe('enc_boss');
    expectRetryState(b, 80, 5);
  });

  test('#2d 自動存檔寫入失敗：戰鬥畫面提示，舊的自動存檔不會留著被誤用', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, {
      1: dyingBossSave(),
      auto: JSON.stringify({ ...whSave({ location: { map: 'dock', x: 9, y: 5, dir: 'right' } }), auto_battle: 'enc_dock_1' }),
    });
    await page.addInitScript((k) => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (key === k) throw new DOMException('quota', 'QuotaExceededError');
        return orig.call(this, key, value);
      };
    }, AUTO);
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await startBoss(page, g);
    const b = await sl(page, () => window.__SL.battle());
    expect(b.notices.join('\n')).toMatch(/自動存檔失敗/);
    expect(await page.evaluate((k) => localStorage.getItem(k), AUTO)).toBeNull();
    // 記憶體備份仍然可以重新挑戰
    await loseToGameOver(page, g);
    await pickGameOver(page, g, 0, touch);
    await g.waitScene('Battle');
    expect((await g.battleWait()).encounter).toBe('enc_boss');
  });

  test('#3 Game Over：Enter、ArrowDown、Enter 同一幀連按只採用第一次選擇', async ({ page }) => {
    await seedSaves(page, { 1: dyingBossSave() });
    const g = game(page);
    await page.goto(TEST_URL);
    await startBoss(page, g);
    await loseToGameOver(page, g);
    await page.evaluate(() => {
      const fire = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
      fire('Enter'); fire('ArrowDown'); fire('Enter');
    });
    await g.waitScene('Battle');
    await g.sleep(500);
    expect(await g.scene()).toBe('Battle');
    const order = (await sl(page, () => window.__SL.debug())).sceneOrder;
    expect(order).not.toContain('Title');
    expect(await sl(page, () => window.__SL.battle())).not.toBeNull();
  });

  test('#3b Game Over：「回標題」之後再按 Enter 不會開戰', async ({ page }) => {
    await seedSaves(page, { 1: dyingBossSave() });
    const g = game(page);
    await page.goto(TEST_URL);
    await startBoss(page, g);
    await loseToGameOver(page, g);
    await page.evaluate(() => {
      const fire = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
      fire('ArrowDown'); fire('Enter'); fire('ArrowUp'); fire('Enter');
    });
    await g.waitScene('Title');
    await g.sleep(400);
    expect(await g.scene()).toBe('Title');
    expect((await sl(page, () => window.__SL.debug())).sceneOrder).not.toContain('Battle');
  });

  test('#4 觸發點引發的戰鬥逃跑成功：回到踩上觸發點之前的那一格', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, {
      1: whSave({
        location: { map: 'dock', x: 9, y: 5, dir: 'right' },
        flags: { 'enter:office': true, 'enter:training': true, 'enter:dock': true, drank_potion: true, sparred: true },
      }),
    });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await loadSlot(g, 1);
    await g.waitScene('Map');
    await g.press('right');
    await g.waitDialogue();
    expect((await g.st()).location).toMatchObject({ x: 10, y: 5 });
    await g.finishDialogue();
    await g.waitScene('Battle');
    const r = await g.fightBattle(() => ({ flee: true }), { maxTurns: 60 });
    expect(r.last.result.outcome).toBe('fled');
    expect(r.scene).toBe('Map');
    await g.sleep(200);
    expect((await g.st()).location).toEqual({ map: 'dock', x: 9, y: 5, dir: 'right' });
    // 回到原位後仍然可以移動（再走進觸發點會再遇到）
    await g.press('right');
    await g.waitDialogue();
  });

  test('#5 預兆：施放當下就顯示意圖（下一位剛好是該敵人也看得到）', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: whSave() });
    const g = game(page, { touch });
    await page.goto(`${TEST_URL}&seed=3`);
    let b = await startBoss(page, g);
    const boss = b.units.find((u) => u.side === 'enemy');
    // 找主角行動、而且下一位就是搬運工的時機
    for (let i = 0; i < 40 && !(b.actor.id === 'hero' && b.order[1] === boss.uid); i++) {
      await g.battleCommand({ skill: 'guard' });
      b = await g.battleWait();
    }
    expect(b.actor.id === 'hero' && b.order[1] === boss.uid, '找不到「施放後下一位是搬運工」的時機').toBe(true);
    const logBefore = b.log.length;
    const msgBefore = b.messages.length;
    const intentBefore = b.intentShown.length;
    await g.battleCommand({ skill: 'omen', target: boss.uid });
    b = await g.battleWait();
    const revealed = b.log.slice(logBefore).find((e) => e.type === 'intent_revealed' && e.target === boss.uid);
    expect(revealed).toBeTruthy();
    const skills = readData('skills.json');
    const skillName = skills.find((x) => x.id === revealed.skill).name;
    // 搬運工已經行動過了，但施放當下訊息列與頭上都出現過意圖
    expect(b.log.slice(logBefore).some((e) => e.type === 'action' && e.uid === boss.uid)).toBe(true);
    const msgs = b.messages.slice(msgBefore);
    expect(msgs.some((m) => m.includes(skillName)), JSON.stringify(msgs)).toBe(true);
    const shown = b.intentShown.slice(intentBefore).filter((x) => x.uid === boss.uid);
    expect(shown.some((x) => x.text.includes(`下一步：${skillName}`)), JSON.stringify(shown)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`omen-${testInfo.project.name}.png`) });
  });

  test('#5b 預兆：揭露的意圖在該敵人行動前一直顯示', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: whSave() });
    const g = game(page, { touch });
    await page.goto(`${TEST_URL}&seed=3`);
    let b = await startBoss(page, g);
    const boss = b.units.find((u) => u.side === 'enemy');
    for (let i = 0; i < 40 && !(b.actor.id === 'hero' && b.order[1] !== boss.uid); i++) {
      await g.battleCommand({ skill: 'guard' });
      b = await g.battleWait();
    }
    await g.battleCommand({ skill: 'omen', target: boss.uid });
    b = await g.battleWait();
    const skillName = readData('skills.json').find((x) => x.id === b.units.find((u) => u.uid === boss.uid).intent?.skill)?.name;
    expect(b.units.find((u) => u.uid === boss.uid).intentText).toContain(`下一步：${skillName}`);
    await page.screenshot({ path: testInfo.outputPath(`omen-pending-${testInfo.project.name}.png`) });
  });

  test('#6 根選單讀技能 menu、召喚訊息讀 summon_text、共鳴度讀 show_resonance', async ({ page }) => {
    await seedSaves(page, { 1: whSave({ lineage: { id: 'watch', rank: 9 } }) });
    const g = game(page);
    await page.goto(TEST_URL);
    await g.waitScene('Title', 15_000);
    // 召喚訊息（純函式）
    const msgs = await page.evaluate(async () => {
      const { describe } = await import('./src/battle-view.js');
      const data = { enemies: [{ id: 'a', name: '甲', summon_text: '從霧裡爬了出來！' }, { id: 'b', name: '乙' }, { id: 'c', name: '丙', summon_text: '{name}從地底冒出來！' }] };
      const labels = { e1: '甲', e2: '乙', e3: '丙' };
      return ['a', 'b', 'c'].map((enemy, i) => describe({ type: 'summon', uid: `e${i + 1}`, enemy }, labels, data));
    });
    expect(msgs).toEqual(['甲從霧裡爬了出來！', '乙出現了！', '丙從地底冒出來！']);

    // 共鳴度：譜系 show_resonance 決定（測試裡把「守望」設為顯示）
    await page.evaluate(async () => {
      const { session } = await import('./src/session.js');
      for (const l of session.data.lineages) l.show_resonance = l.id === 'watch';
      for (const s of session.data.skills) if (s.id === 'guard') s.menu = undefined;
    });
    await loadSlot(g, 1);
    await g.waitScene('Map');
    expect((await sl(page, () => window.__SL.hud())).resonance).toMatch(/^共鳴 \d+$/);
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    const b = await heroTurn(g, await g.battleWait());
    const labels = b.menu.buttons.map((x) => x.label);
    const name = (id) => readData('skills.json').find((s) => s.id === id).name;
    expect(labels).toContain(name('attack'));
    expect(labels).toContain(name('shoot'));
    expect(labels).not.toContain(name('guard'));
  });

  test('#6b 根選單：資料裡 menu: root 的技能（攻擊、開槍、防禦）在第一層', async ({ page }) => {
    const skills = readData('skills.json');
    const roots = skills.filter((s) => s.menu === 'root').map((s) => s.id);
    expect(roots).toEqual(expect.arrayContaining(['attack', 'guard', 'shoot']));
    await seedSaves(page, { 1: whSave() });
    const g = game(page);
    await page.goto(TEST_URL);
    const b = await heroTurn(g, await startBoss(page, g));
    const labels = b.menu.buttons.map((x) => x.label);
    for (const id of ['attack', 'guard', 'shoot']) expect(labels).toContain(skills.find((s) => s.id === id).name);
  });

  test('#7 地圖選單：鎮靜香（真實資料的 field_effects）讓崩解下降', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const incenseDef = readData('items.json').find((x) => x.id === 'sedative_incense');
    expect(Array.isArray(incenseDef.field_effects)).toBe(true);
    await seedSaves(page, { 1: whSave({ location: { map: 'warehouse', x: 7, y: 9, dir: 'down' }, collapse: 40 }) });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    await loadSlot(g, 1);
    await g.waitScene('Map');
    await g.act('menu');
    await g.waitScene('Menu');
    await g.pickMenu('道具');
    const m = await sl(page, () => window.__SL.menu());
    expect(m.items.find((i) => i.label.startsWith('鎮靜香')).enabled).toBe(true);
    await g.pickMenu('鎮靜香');
    await page.waitForFunction(() => /使用了/.test(window.__SL.menu()?.note ?? ''));
    const s = await g.st();
    expect(s.collapse).toBeLessThan(40);
    expect(s.items.sedative_incense).toBeUndefined();
  });

  test('#8 畫面層用「爆擊」，不用「暴擊」', async ({ page }) => {
    const root = fileURLToPath(new URL('../../web/', import.meta.url));
    const bad = [];
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (!p.endsWith(join('src', 'core'))) walk(p); continue; }
        if (/\.(js|html)$/.test(f) && readFileSync(p, 'utf8').includes('暴擊')) bad.push(p);
      }
    };
    walk(join(root, 'src'));
    if (readFileSync(join(root, 'index.html'), 'utf8').includes('暴擊')) bad.push('index.html');
    expect(bad).toEqual([]);
    await page.goto(TEST_URL);
    await game(page).waitScene('Title', 15_000);
    const t = await page.evaluate(async () => (await import('./src/battle-view.js')).describe({ type: 'crit' }, {}, {}));
    expect(t).toBe('爆擊！');
  });

  test('#9 遊戲中旋轉（375×667 → 667×375）畫布跟著重新縮放', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await seedSaves(page, { 1: whSave({ location: { map: 'warehouse', x: 7, y: 9, dir: 'down' } }) });
    const g = game(page);
    await page.goto(TEST_URL);
    await loadSlot(g, 1);
    await g.waitScene('Map');
    const fit = async (w, h) => {
      await page.setViewportSize({ width: w, height: h });
      const scale = Math.min(w / 360, h / 640);
      await page.waitForFunction(([ew, eh]) => {
        const r = document.querySelector('#game canvas').getBoundingClientRect();
        return Math.abs(r.width - ew) <= 2 && Math.abs(r.height - eh) <= 2;
      }, [360 * scale, 640 * scale], { timeout: 4_000 }).catch(() => {});
      const r = await page.locator('#game canvas').boundingBox();
      expect(r.width).toBeCloseTo(360 * scale, 0);
      expect(r.height).toBeCloseTo(640 * scale, 0);
      expect(r.x + r.width).toBeLessThanOrEqual(w + 1);
      expect(r.y + r.height).toBeLessThanOrEqual(h + 1);
    };
    await fit(375, 667);
    await fit(667, 375);
    await fit(375, 667);
  });

  test('#10 讀檔警告在 console 印出訊息內容，不是 [Object]', async ({ page }) => {
    const warns = [];
    page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
    await seedSaves(page, { 1: makeSave({ location: { map: 'attic', x: 999, y: -4, dir: 'down' } }) });
    const g = game(page);
    await page.goto(TEST_URL);
    await loadSlot(g, 1);
    await g.waitScene('Map');
    await g.sleep(200);
    const w = warns.find((x) => x.includes('讀檔時修正了存檔內容'));
    expect(w).toBeTruthy();
    expect(w).toContain('已移到地圖');
    expect(w).not.toMatch(/\[?Object\]?/);
  });
});
