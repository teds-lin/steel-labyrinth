// M2 戰鬥與第一、二章 E2E。桌機用鍵盤、手機全程用 tap（選指令、選目標、選技能都用點的）。
// 戰鬥亂數用 ?seed=N 固定，結果可重現。期望值一律從資料讀，不寫死。
import { readFileSync } from 'node:fs';
import { test, expect, game, TEST_URL, makeSave, seedSaves } from './helpers.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const readData = (rel) => JSON.parse(readFileSync(new URL(`../../web/data/${rel}`, import.meta.url), 'utf8'));
const STORY = Object.fromEntries(['prologue', 'chapter1', 'chapter2'].map((id) => [id, readData(`story/${id}.json`)]));
const sl = (page, fn, arg) => page.evaluate(fn, arg);

/**
 * 一般策略（自成一體、不引用外部變數：同一份原始碼也拿到頁面裡給 simulate 找種子用）。
 * view：{ actor:{uid}, units:[{uid, side, alive, hp, maxHp}], collapse, commands }（＝__SL.battle() 的子集）。
 * 生命低就用繃帶；崩解高就鎮魂；主角有子彈就開槍；其他人攻擊生命比例最低的敵人。
 */
function basicPolicy(view) {
  const lowest = (list) => list.reduce((a, u) => (a === null || u.hp / u.maxHp < a.hp / a.maxHp ? u : a), null);
  const usable = (id) => view.commands.skills.find((s) => s.id === id && s.usable);
  const party = view.units.filter((u) => u.side === 'party' && u.alive);
  const hurt = lowest(party.filter((u) => u.hp / u.maxHp < 0.35));
  if (hurt && view.commands.items.some((i) => i.id === 'bandage')) return { item: 'bandage', target: hurt.uid };
  if (view.collapse >= 60 && usable('requiem')) return { skill: 'requiem', target: view.actor.uid };
  const target = lowest(view.units.filter((u) => u.side === 'enemy' && u.alive)).uid;
  if (usable('shoot')) return { skill: 'shoot', target };
  return { skill: 'attack', target };
}

/**
 * 用遊戲自己的 simulate（同一套引擎、同一個策略）從目前 state 找一個結果在 want 裡的種子，
 * 再用 history.replaceState 把它放進網址（battleSeed() 每場戰鬥都重新讀網址）。
 * 數值調整後固定種子的勝負會變，所以不寫死種子。
 */
async function useSeedFor(page, enc, want = ['victory'], policy = basicPolicy) {
  const seed = await page.evaluate(async ({ enc, src, want }) => {
    const { simulate } = await import('./src/core/battle/engine.js');
    const { session } = await import('./src/session.js');
    const pol = new Function(`return (${src});`)();
    const state = window.__SL.getState();
    const toCmd = (c) => (c.flee ? { type: 'flee' } : c.item ? { type: 'item', item: c.item, target: c.target } : { type: 'skill', skill: c.skill, target: c.target });
    for (let seed = 1; seed <= 400; seed++) {
      const r = simulate(enc, state, session.data, seed, (b, cmds) => toCmd(pol({
        actor: { uid: cmds.actor },
        units: b.units.map((u) => ({ uid: u.uid, side: u.side, alive: u.alive, hp: u.hp, maxHp: u.stats.hp })),
        collapse: b.collapse,
        commands: cmds,
      })));
      if (want.includes(r.outcome)) return seed;
    }
    return null;
  }, { enc, src: policy.toString(), want });
  expect(seed, `找不到 ${enc} 結果為 ${want} 的種子`).not.toBeNull();
  await page.evaluate((n) => history.replaceState(null, '', `${location.pathname}?test=1&seed=${n}`), seed);
  return seed;
}

/** 序章結束時的 v1 存檔（M1 格式）：站在街上的結局觸發點，序章已完成。 */
function prologueDoneSave() {
  return makeSave({
    location: { map: 'street', x: 6, y: 3, dir: 'down' },
    flags: {
      'enter:attic': true, 'enter:hallway': true, 'enter:street': true, door_open: true, talked_landlady: true, told_truth: true,
      'trigger:street:trg_prologue_end': true,
    },
    items: { attic_key: 1, pocket_watch: 1 },
    chapter: 'prologue',
    chapter_done: ['prologue'],
    playtime_s: 600,
  });
}

/** 第二章 Boss 前的 v2 存檔：倉庫裡、面向沉默的搬運工。 */
function bossSave(over = {}) {
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

/** 標題 →「繼續」→ 讀第 slot 個存檔。 */
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

const unitSnapshot = (b) => ({
  units: b.units.filter((u) => u.side === 'party').map((u) => ({ id: u.id, hp: u.hp, sp: u.sp })),
  ammo: b.ammo,
  collapse: b.collapse,
});

test.describe('M2 戰鬥', () => {
  test('主線：序章存檔 → 第一章（靈劑、教學戰、艾妲入隊）→ 第二章霧行者 → 存檔', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: prologueDoneSave() });
    const g = game(page, { touch });
    await page.goto(`${TEST_URL}&seed=7`);

    // 讀入序章完成的 v1 存檔 → 章節結束畫面（有「繼續」）
    await loadSlot(g, 1);
    await g.waitScene('ChapterEnd');
    let ce = (await sl(page, () => window.__SL.debug())).chapterEnd;
    expect(ce.title).toBe(STORY.prologue.end_screen.title);
    expect(ce.subtitle).toBe(STORY.prologue.end_screen.subtitle);
    expect(ce.continue).toEqual(STORY.prologue.end_screen.continue);
    let s = await g.st();
    expect(s.schema_version).toBe(2);
    expect(s.party.map((m) => m.id)).toEqual(['hero']);

    // 繼續 → 第一章開頭
    await g.pickChapterEnd('繼續');
    await g.waitScene('Map');
    await g.waitDialogue();
    s = await g.st();
    expect(s.chapter).toBe('chapter1');
    expect(s.location.map).toBe(STORY.prologue.end_screen.continue.map);
    await g.finishDialogue([0]);
    // goto 辦公室 → 抵達對話
    await g.waitDialogue();
    expect((await g.st()).location.map).toBe('office');
    await g.finishDialogue();

    // 喝下靈劑：HUD 變「回溯 ∞」
    expect((await sl(page, () => window.__SL.hud())).echo).not.toContain('∞');
    await g.useOn('obj_cabinet');
    await g.finishDialogue([0]);
    s = await g.st();
    expect(s.lineage).toEqual({ id: 'trace', rank: 9 });
    let hud = await sl(page, () => window.__SL.hud());
    expect(hud.echo).toBe('回溯 ∞');
    expect(hud.resonance).toMatch(/^共鳴 \d+$/);
    expect(hud.party.length).toBe(1);

    // 練習室 → 教學戰
    await g.takeExit('training');
    await g.waitDialogue();
    await g.finishDialogue();
    // 教學戰：開戰前的對話會給左輪與子彈，所以無法事先模擬種子；on_lose 是 continue，輸贏都接劇情
    await g.useOn('obj_marlo_train');
    await g.finishDialogue();
    await g.waitScene('Battle');
    const auto = await sl(page, () => JSON.parse(localStorage.getItem('steel-labyrinth:save:auto')));
    expect(auto.auto_battle).toBe('enc_sparring');
    expect(auto.items.revolver).toBe(1);
    const tut = await g.fightBattle(basicPolicy);
    expect(['victory', 'defeat']).toContain(tut.last.result.outcome);
    // 教學戰的階段對話（phase.dialogue）在戰鬥中用對話框播放過
    const phases = tut.last.log.filter((e) => e.type === 'phase' && e.dialogue);
    expect(phases.length).toBeGreaterThan(0);
    expect(tut.scene).toBe('Map');
    // 回到原位置，接著播 on_win 對話 → goto 辦公室 → 補給、艾妲入隊 → 第一章結束
    await g.waitDialogue();
    expect((await g.st()).location.map).toBe('training');
    expect((await g.st()).flags.sparred).toBe(true);
    await g.finishDialogue();
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('ChapterEnd');
    s = await g.st();
    expect(s.party.map((m) => m.id)).toEqual(['hero', 'ada']);
    expect(s.ammo).toBe(9);
    expect(s.items.bandage).toBeGreaterThanOrEqual(2);
    ce = (await sl(page, () => window.__SL.debug())).chapterEnd;
    expect(ce.title).toBe(STORY.chapter1.end_screen.title);
    expect(ce.continue).toEqual(STORY.chapter1.end_screen.continue);

    // 第二章：碼頭 → 霧行者
    await g.pickChapterEnd('繼續');
    await g.waitScene('Map');
    await g.waitDialogue();
    expect((await g.st()).chapter).toBe('chapter2');
    await g.finishDialogue();
    hud = await sl(page, () => window.__SL.hud());
    expect(hud.party.length).toBe(2);
    expect(hud.ammo).toBe('子彈 9');
    const dock = await g.mapData('dock');
    const trg = dock.triggers.find((t) => t.dialogue === 'dlg_fog1_start');
    const before = (await g.st()).location;
    await useSeedFor(page, 'enc_dock_1');
    await g.goTo(trg.x, trg.y);
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    const pos = (await g.st()).location;
    const fog = await g.fightBattle(basicPolicy);
    expect(fog.last.result.outcome).toBe('victory');
    // 戰鬥中至少有一位敵人與我方都行動過（log 有雙方的 action）
    const actions = fog.last.log.filter((e) => e.type === 'action');
    expect(actions.some((e) => e.uid.startsWith('e'))).toBe(true);
    expect(actions.some((e) => e.uid.startsWith('p'))).toBe(true);
    await g.waitDialogue();
    s = await g.st();
    expect(s.location).toEqual(pos); // 回到原地圖原位置
    expect(before.map).toBe('dock');
    await g.finishDialogue();
    expect((await g.st()).flags.fog1_done).toBe(true);

    // 存檔到第 2 格並確認內容
    await g.act('menu');
    await g.waitScene('Menu');
    await g.pickMenu('存檔');
    await g.pickMenu('存檔 2');
    await page.waitForFunction(() => /已存檔到存檔 2/.test(window.__SL.menu()?.note ?? ''), null, { timeout: 5_000 });
    const saved = await sl(page, () => JSON.parse(localStorage.getItem('steel-labyrinth:save:2')));
    expect(saved.schema_version).toBe(2);
    expect(saved.chapter).toBe('chapter2');
    expect(saved.party.map((m) => m.id)).toEqual(['hero', 'ada']);
    expect(saved.flags.fog1_done).toBe(true);
    expect(saved.pending).toBeNull();
  });

  test('Boss：失敗 →「重新挑戰」回到戰前狀態 → 再打一次獲勝；預兆顯示的意圖必定成真', async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: bossSave() });
    const g = game(page, { touch });
    await page.goto(`${TEST_URL}&seed=11`);
    await loadSlot(g, 1);
    await g.waitScene('Map');
    expect((await sl(page, () => window.__SL.hud())).resonance).toBe('共鳴 4');
    await useSeedFor(page, 'enc_boss');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');

    // 第一次：預兆看穿搬運工的下一步，之後全隊只防禦 → 輸
    let b = await g.battleWait();
    const start1 = unitSnapshot(b);
    const boss = b.units.find((u) => u.side === 'enemy');
    // 輪到主角、而且下一位不是搬運工時施放（這樣施放後回到我方輸入時，意圖還顯示在畫面上）
    while (b.actor.id !== 'hero' || b.order[1] === boss.uid) {
      await g.battleCommand({ skill: 'guard' });
      b = await g.battleWait();
    }
    const logBefore = b.log.length;
    await g.battleCommand({ skill: 'omen', target: boss.uid });
    b = await g.battleWait();
    const seen = b.units.find((u) => u.uid === boss.uid);
    expect(seen.intent).not.toBeNull();
    const omenLog = b.log.slice(logBefore);
    const revealed = omenLog.find((e) => e.type === 'intent_revealed' && e.target === boss.uid);
    expect(revealed).toBeTruthy();
    expect({ skill: revealed.skill, target: revealed.intent_target }).toEqual(seen.intent);
    // 畫面上的文字：「下一步：技能名 → 目標」
    const skills = readData('skills.json');
    const skillName = skills.find((x) => x.id === seen.intent.skill).name;
    expect(seen.intentText).toContain(`下一步：${skillName}`);
    if (seen.intent.target && seen.intent.target !== boss.uid) {
      expect(seen.intentText).toContain(b.units.find((u) => u.uid === seen.intent.target).label);
    }
    // 之後一直防禦，直到搬運工行動：它的 action 必須與預兆一致
    let bossAction = null;
    for (let i = 0; i < 20 && !bossAction; i++) {
      bossAction = b.log.slice(logBefore).find((e) => e.type === 'action' && e.uid === boss.uid) ?? null;
      if (bossAction) break;
      await g.battleCommand({ skill: 'guard' });
      b = await g.battleWait();
    }
    expect(bossAction).toBeTruthy();
    expect(bossAction.skill).toBe(seen.intent.skill);
    const retarget = b.log.slice(logBefore).find((e) => e.type === 'retarget' && e.uid === boss.uid);
    expect(retarget ? retarget.from : bossAction.target).toBe(seen.intent.target);

    const lose = await g.fightBattle(() => ({ skill: 'guard' }), { maxTurns: 400 });
    expect(lose.scene).toBe('GameOver');
    const go = await sl(page, () => window.__SL.gameOver());
    expect(['戰敗', '失控']).toContain(go.title);
    expect(go.items.map((i) => i.label)).toEqual(['重新挑戰', '回標題']);
    if (testInfo.project.name === 'mobile') await page.screenshot({ path: testInfo.outputPath('gameover-mobile.png') });

    // 重新挑戰：戰前狀態經 prepareRetry——全隊生命、靈性回滿，崩解 min(戰前, 60)，子彈與戰前相同
    if (touch) {
      const r = go.items[0];
      await g.tap(r.x + r.w / 2, r.y + r.h / 2);
    } else {
      await g.key('Enter');
    }
    await g.waitScene('Battle');
    b = await g.battleWait();
    expect(b.encounter).toBe('enc_boss');
    for (const u of b.units.filter((x) => x.side === 'party')) {
      expect(u.hp).toBe(u.maxHp);
      expect(u.sp).toBe(u.maxSp);
    }
    expect(b.ammo).toBe(start1.ammo);
    expect(b.collapse).toBe(Math.min(start1.collapse, 60));

    // 第二次：認真打
    const win = await g.fightBattle(basicPolicy, { maxTurns: 300 });
    expect(win.last.result.outcome).toBe('victory');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('ChapterEnd');
    const ce = (await sl(page, () => window.__SL.debug())).chapterEnd;
    expect(ce.title).toBe(STORY.chapter2.end_screen.title);
    expect(ce.subtitle).toBe(STORY.chapter2.end_screen.subtitle);
    expect(ce.continue).toBeNull();
    expect((await g.st()).flags.boss_done).toBe(true);
  });

  test('教學戰輸了（on_lose: continue）不會 Game Over，直接接劇情', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    const enc = readData('encounters.json').find((e) => e.id === 'enc_sparring');
    expect(enc.on_lose).toBe('continue');
    await seedSaves(page, {
      1: bossSave({
        location: { map: 'training', x: 5, y: 2, dir: 'down' },
        flags: { 'enter:office': true, 'enter:training': true, drank_potion: true, ch1_briefed: true },
        chapter: 'chapter1', chapter_done: ['prologue'],
        party: [{ id: 'hero', hp: 4, sp: null }], ammo: 3, items: { revolver: 1 }, collapse: 5,
      }),
    });
    const g = game(page, { touch });
    await page.goto(`${TEST_URL}&seed=2`);
    await loadSlot(g, 1);
    await g.waitScene('Map');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    const r = await g.fightBattle(() => ({ skill: 'guard' }));
    expect(r.last.result.outcome).toBe('defeat');
    expect(r.last.result.next).toEqual({ type: 'dialogue', dialogue: enc.on_win.dialogue });
    expect(r.scene).toBe('Map');
    await g.waitDialogue();
    const s = await g.st();
    expect(s.flags.sparred).toBe(true);   // on_win 的效果照樣執行
    expect(s.party[0].hp).toBe(1);        // 倒下的隊友以 1 點生命歸隊
  });

  test('地圖選單：道具（field_effects 可用、其他只列出）與隊伍（能力值、技能）', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: bossSave({ location: { map: 'warehouse', x: 7, y: 9, dir: 'down' }, collapse: 40 }) });
    const g = game(page, { touch });
    await page.goto(TEST_URL);
    // 鎮靜香的 field_effects 用真實資料（不在頁面記憶體裡改資料）；期望的崩解從資料算
    const incense0 = readData('items.json').find((x) => x.id === 'sedative_incense');
    const drop = incense0.field_effects.reduce((a, e) => a + (e.collapse ?? 0), 0);
    expect(drop).toBeLessThan(0);
    const after = Math.max(0, 40 + drop);
    await loadSlot(g, 1);
    await g.waitScene('Map');
    await g.act('menu');
    await g.waitScene('Menu');
    await g.pickMenu('道具');
    let m = await sl(page, () => window.__SL.menu());
    expect(m.page).toBe('items');
    const incense = m.items.find((i) => i.label.startsWith('鎮靜香'));
    expect(incense.enabled).toBe(true);
    expect(m.items.find((i) => i.label.startsWith('繃帶')).enabled).toBe(false);
    expect(m.items.find((i) => i.label.startsWith('繃帶')).sub).toBe('戰鬥中才能使用');
    await g.pickMenu('鎮靜香');
    await page.waitForFunction(() => /使用了/.test(window.__SL.menu()?.note ?? ''));
    let s = await g.st();
    expect(s.collapse).toBe(after);
    expect(s.items.sedative_incense).toBeUndefined();
    m = await sl(page, () => window.__SL.menu());
    expect(m.items.some((i) => i.label.startsWith('鎮靜香'))).toBe(false);
    await g.pickMenu('返回');

    await g.pickMenu('隊伍');
    m = await sl(page, () => window.__SL.menu());
    expect(m.page).toBe('party');
    expect(m.items.length).toBe(3); // 主角、艾妲、返回
    expect(m.items[1].label).toContain('艾妲');
    await g.pickMenu('艾妲');
    m = await sl(page, () => window.__SL.menu());
    expect(m.page).toBe('member');
    const skills = readData('skills.json');
    for (const id of ['hypnosis', 'requiem']) expect(m.note).toContain(skills.find((x) => x.id === id).name);
    expect(m.note).toContain('安眠師');
    s = await g.st();
    expect(s.collapse).toBe(after);
  });

  test('資料裡出現的 sprite／tile／戰鬥背景都有專屬貼圖', async ({ page }) => {
    await page.goto(TEST_URL);
    await game(page).waitScene('Title', 15_000);
    const art = await sl(page, () => window.__SL.art());
    expect(art.sprites, '缺專屬點陣圖的 sprite').toEqual([]);
    expect(art.tiles, '缺專屬畫法的 tile').toEqual([]);
    expect(art.bgs, '缺專屬畫法的戰鬥背景').toEqual([]);
    expect(art.missingTextures).toEqual([]);
    // 資料清單與 web/data 一致（掃描所有地圖物件、角色、敵人）
    const manifest = readData('manifest.json');
    const sprites = new Set();
    for (const id of manifest.files.maps) for (const o of readData(`maps/${id}.json`).objects ?? []) sprites.add(o.sprite);
    for (const c of [...readData('characters.json'), ...readData('enemies.json')]) sprites.add(c.sprite);
    expect(art.counts.sprites).toBe(sprites.size);
    expect(art.counts.tiles).toBe(readData('tiles.json').length);
    expect(art.counts.bgs).toBe(new Set(readData('encounters.json').map((e) => e.bg)).size);
  });

  test('戰鬥畫面版面：按鈕至少 44px、不超出畫面；技能選單顯示消耗與不可用原因；可返回上一層', async ({ page }, testInfo) => {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: bossSave({ party: [{ id: 'hero', hp: null, sp: 2 }, { id: 'ada', hp: null, sp: null }] }) });
    const g = game(page, { touch });
    await page.goto(`${TEST_URL}&seed=3`);
    await loadSlot(g, 1);
    await g.waitScene('Map');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    let b = await g.battleWait();
    // 輪到主角（靈性 2，預兆要 4）
    while (b.actor.id !== 'hero') {
      await g.battleCommand({ skill: 'guard' });
      b = await g.battleWait();
    }
    const check = (bb) => {
      for (const x of bb.menu.buttons) {
        expect(x.h, `${x.label} 高度`).toBeGreaterThanOrEqual(44);
        expect(x.x).toBeGreaterThanOrEqual(0);
        expect(x.y).toBeGreaterThanOrEqual(0);
        expect(x.x + x.w).toBeLessThanOrEqual(360);
        expect(x.y + x.h, `${x.label} 距底邊至少 8px（安全區）`).toBeLessThanOrEqual(632);
      }
    };
    check(b);
    expect(b.menu.buttons.map((x) => x.label)).toEqual(expect.arrayContaining(['攻擊', '技能', '開槍', '道具', '防禦']));
    expect(b.menu.buttons.map((x) => x.label)).not.toContain('逃跑'); // Boss 戰不能逃
    expect(b.order.length).toBe(6);
    if (testInfo.project.name === 'mobile') await page.screenshot({ path: testInfo.outputPath('battle-main-mobile.png') });

    await g.battleButton('技能');
    b = await g.battleWait();
    check(b);
    const omen = b.menu.buttons.find((x) => x.label === '預兆');
    expect(omen.enabled).toBe(false);
    expect(omen.sub).toContain('靈性 4');
    expect(omen.sub).toContain('靈性不足');
    if (testInfo.project.name === 'mobile') await page.screenshot({ path: testInfo.outputPath('battle-skills-mobile.png') });
    await g.battleButton('返回');
    b = await g.battleWait();
    expect(b.mode).toBe('root');

    // 攻擊 → 選目標畫面 → 返回 → 根選單
    await g.battleButton('攻擊');
    b = await g.battleWait();
    expect(b.mode).toBe('target');
    check(b);
    if (testInfo.project.name === 'mobile') await page.screenshot({ path: testInfo.outputPath('battle-target-mobile.png') });
    await g.battleButton('返回');
    b = await g.battleWait();
    expect(b.mode).toBe('root');
    await g.noHScroll();
  });
});
