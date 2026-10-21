// M2 戰鬥與第一、二章 E2E。桌機用鍵盤、手機全程用 tap（選指令、選目標、選技能都用點的）。
// 戰鬥亂數用 ?seed=N 固定，結果可重現。期望值一律從資料讀，不寫死。
import { readFileSync } from 'node:fs';
import { test, expect, game, TEST_URL, makeSave, seedSaves, rootSkillIds } from './helpers.js';

const isTouch = (testInfo) => testInfo.project.name === 'mobile';
const readData = (rel) => JSON.parse(readFileSync(new URL(`../../web/data/${rel}`, import.meta.url), 'utf8'));
const STORY = Object.fromEntries(['prologue', 'chapter1', 'chapter2'].map((id) => [id, readData(`story/${id}.json`)]));
// M5：下一階（借聲者）的靈劑門檻開放後，HUD 顯示「共鳴 目前／門檻」；門檻從資料讀
const RANK8_NEED = readData('lineages/trace.json').ranks.find((r) => r.rank === 8)?.potion?.resonance ?? null;
const resonanceText = (n) => (RANK8_NEED === null ? `共鳴 ${n}` : `共鳴 ${n}/${RANK8_NEED}`);
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


/** 第七章最終戰前的 v4 存檔（主角＋艾妲，譜系 階 7：預兆、耳語、換影、影縛）；用來開任意遭遇戰量版面。 */
function lateSave() {
  const enter = ['office_ch7', 'harbor_night', 'breakwater', 'clocktower_ch7', 'lighthouse', 'lighthouse_top'];
  return {
    schema_version: 4,
    player: { name: '艾琳' },
    lineage: { id: 'trace', rank: 7 },
    location: { map: 'lighthouse_top', x: 6, y: 3, dir: 'up' },
    flags: {
      ...Object.fromEntries(enter.map((m) => [`enter:${m}`, true])),
      dream_unlocked: true, marlo_trusted: true, inspector_convinced: true, owen_spoke: true, ch6_mirror_heard: true,
      ch7_started: true, ch7_foreman: true, ch7_gate_open: true, ch7_procession: true, ch7_harbor1_done: true, ch7_harbor2_done: true,
      ch7_deduced: true, ch7_breakwater_done: true, ch7_drowned: true, ch7_promoted: true, ch7_chair_done: true, ch7_woke: true,
      ch7_outer_open: true, ch7_lh1_done: true, ch7_got_lantern_key: true, ch7_inner_open: true, ch7_rest_landing: true,
    },
    items: { sedative_incense: 2, tonic: 1, bandage: 2 },
    echo: { charges: 0 },
    collapse: 20,
    resonance: {},
    chapter: 'chapter7',
    chapter_done: ['prologue', 'chapter1', 'chapter2', 'chapter3', 'chapter4', 'chapter5', 'chapter6'],
    playtime_s: 7200,
    party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }],
    ammo: 0,
    pending: null,
    dream_return: null,
    promotions: [
      { lineage: 'trace', rank: 8, forced: false, chapter: 'chapter4' },
      { lineage: 'trace', rank: 7, forced: false, chapter: 'chapter7' },
    ],
    ending: null,
  };
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


const SKILL_DEFS = readData('skills.json');
const ITEM_DEFS = readData('items.json');
const skillDesc = (name) => SKILL_DEFS.find((x) => x.name === name)?.desc;
const itemDesc = (label) => ITEM_DEFS.find((x) => label.startsWith(x.name))?.desc;

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
    expect(s.schema_version).toBe(4); // 存檔 v4（M5：promotions、ending）
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
    expect((await sl(page, () => window.__SL.hud())).abilityButton, '喝靈劑前：能力鍵是暫時的殘響').toBe('殘響');
    await g.useOn('obj_cabinet');
    await g.finishDialogue([0]);
    s = await g.st();
    expect(s.lineage).toEqual({ id: 'trace', rank: 9 });
    let hud = await sl(page, () => window.__SL.hud());
    expect(hud.echo).toBe('回溯 ∞');
    expect(hud.abilityButton, '喝下靈劑後：能力鍵與 HUD 一致，顯示回溯').toBe('回溯');
    expect(hud.resonance).toMatch(RANK8_NEED === null ? /^共鳴 \d+$/ : new RegExp(`^共鳴 \\d+/${RANK8_NEED}$`));
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
    expect(saved.schema_version).toBe(4); // 存檔 v4（M5）
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
    expect((await sl(page, () => window.__SL.hud())).resonance).toBe(resonanceText(4));
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
    // 第三章開放後，第二章結束畫面有「繼續」接第三章（未開放時沒有 continue）
    expect(ce.continue).toEqual(STORY.chapter2.end_screen.continue ?? null);
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
    expect(m.items.map((it) => it.label.split('　')[0])).toEqual([expect.any(String), '艾妲・費恩', '晉升進度', '返回']); // 主角、艾妲、晉升進度（M5：主角有譜系時）、返回
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
    // 夢客的頭像（story 的 guests[].sprite）也要有專屬圖
    for (const id of manifest.files.story) for (const gst of readData(`story/${id}.json`).guests ?? []) if (gst.sprite) sprites.add(gst.sprite);
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
    expect(b.message, '不能逃跑的戰鬥要在提示上明講').toMatch(/要怎麼做？（無法逃跑）$/);
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

  /** 進入第二章 Boss 戰並輪到主角；items 可覆寫。回傳 { g, b }。 */
  async function enterBossBattle(page, testInfo, items = { revolver: 1, bandage: 2, sedative_incense: 1, tonic: 1, warehouse_key: 1 }) {
    const touch = isTouch(testInfo);
    await seedSaves(page, { 1: bossSave({ items, party: [{ id: 'hero', hp: null, sp: 10 }, { id: 'ada', hp: null, sp: null }] }) });
    const g = game(page, { touch });
    await page.goto(`${TEST_URL}&seed=3`);
    await loadSlot(g, 1);
    await g.waitScene('Map');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    let b = await g.battleWait();
    while (b.actor.id !== 'hero') {
      await g.battleCommand({ skill: 'guard' });
      b = await g.battleWait();
    }
    return { g, b, touch };
  }

  const PANEL_TOP = 316;
  const rectsOverlap = (a, c) => a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
  /** 說明框的幾何：在面板內、不與標題與任何按鈕相交、字級 ≥15、框高放得下實際文字高度（不被裁掉）。 */
  function expectHelpGeometry(b, what) {
    const h = b.menu.help;
    expect(h.visible, `${what}：說明框可見`).toBe(true);
    expect(h.fontSize, `${what}：字級`).toBeGreaterThanOrEqual(15);
    expect(h.box.y, `${what}：框頂在面板內（≥${PANEL_TOP}）`).toBeGreaterThanOrEqual(PANEL_TOP);
    expect(h.box.h, `${what}：框高放得下文字（含上下內距）`).toBeGreaterThanOrEqual(h.textHeight + 16);
    expect(h.textHeight, `${what}：文字高度離容量至少留 2px 餘裕`).toBeLessThanOrEqual(h.capacity - 2);
    expect(b.menu.titleRect, `${what}：標題矩形`).toBeTruthy();
    expect(rectsOverlap(h.box, b.menu.titleRect), `${what}：不與標題相交`).toBe(false);
    for (const x of b.menu.buttons) expect(rectsOverlap(h.box, x), `${what}：不與按鈕「${x.label}」相交`).toBe(false);
    for (const x of b.menu.buttons) {
      expect(x.h, `${x.label} 高度`).toBeGreaterThanOrEqual(44);
      expect(x.y + x.h, `${x.label} 距底邊至少 8px`).toBeLessThanOrEqual(632);
    }
  }

  test('技能子選單的說明框：完整描述、標題帶行動者名字、幾何不重疊、方向鍵／滑鼠 hover 切換、離開後消失', async ({ page }, testInfo) => {
    const { g, b: b0, touch } = await enterBossBattle(page, testInfo);
    let b = b0;
    expect(b.menu.help, '第一層（grid）沒有說明框').toBeNull();

    await g.battleButton('技能');
    b = await g.battleWait();
    const me = b.units.find((u) => u.uid === b.actor.uid);
    expect(b.menu.title).toBe(`技能　靈性 ${me.sp}/${me.maxSp}`);
    const skillBtns = b.menu.buttons.filter((x) => skillDesc(x.label));
    expect(skillBtns.length).toBeGreaterThanOrEqual(1);
    const first = skillBtns[0];
    expect(b.menu.help.text).toBe(skillDesc(first.label));
    expect(first.sub, '按鈕副標只放短資訊').not.toContain(skillDesc(first.label));
    for (const x of skillBtns) expect(x.sub, `${x.label} 副標不含「…」`).not.toContain('…');
    expectHelpGeometry(b, '技能清單');
    if (testInfo.project.name === 'mobile') await page.screenshot({ path: testInfo.outputPath('battle-skills-help-mobile.png') });
    if (!touch) {
      await g.key('ArrowDown');
      b = await g.battleWait();
      expect(b.menu.buttons[b.menu.index].label).toBe('返回');
      expect(b.menu.help.visible).toBe(false);
      expect(b.menu.help.text).toBe('');
      await g.key('ArrowUp');
      b = await g.battleWait();
      expect(b.menu.help.text).toBe(skillDesc(first.label));
    }
    await g.battleButton('返回');
    b = await g.battleWait();
    expect(b.mode).toBe('root');
    expect(b.menu.help, '回到第一層後說明框消失').toBeNull();
  });

  test('道具子選單：方向鍵下移與滑鼠 hover 都會換說明；標題帶行動者名字', async ({ page }, testInfo) => {
    const { g, b: b0, touch } = await enterBossBattle(page, testInfo);
    await g.battleButton('道具');
    let b = await g.battleWait();
    expect(b.menu.title).toBe('道具');
    const itemBtns = b.menu.buttons.filter((x) => itemDesc(x.label));
    expect(itemBtns.length).toBeGreaterThanOrEqual(3);
    expect(b.menu.help.text).toBe(itemDesc(itemBtns[0].label));
    expectHelpGeometry(b, '道具清單');
    if (touch) return; // 觸控沒有 hover 與方向鍵；觸控行為見下一個測試
    await g.key('ArrowDown');
    b = await g.battleWait();
    expect(b.menu.help.text, '方向鍵下移後變成下一個道具的描述').toBe(itemDesc(itemBtns[1].label));
    // 滑鼠 hover 到第三項（不點）
    const r = b.menu.buttons.find((x) => x.label === itemBtns[2].label);
    const box = await page.locator('canvas').boundingBox();
    await page.mouse.move(box.x + ((r.x + r.w / 2) * box.width) / 360, box.y + ((r.y + r.h / 2) * box.height) / 640);
    await page.waitForFunction((t) => window.__SL.battle()?.menu?.help?.text === t, itemDesc(itemBtns[2].label), { timeout: 3_000 });
    b = await g.battleWait();
    expect(b.mode).toBe('items');
    expect(b.menu.index).toBe(b.menu.buttons.findIndex((x) => x.label === itemBtns[2].label));
  });

  test('觸控：第一次點未聚焦的項目只聚焦（顯示說明），再點一次才使用；返回後聚焦回原項目', async ({ page }, testInfo) => {
    const { g, b: b0, touch } = await enterBossBattle(page, testInfo);
    await g.battleButton('道具');
    let b = await g.battleWait();
    const itemBtns = b.menu.buttons.filter((x) => itemDesc(x.label));
    const tonic = itemBtns.find((x) => x.label.startsWith(ITEM_DEFS.find((d) => d.id === 'tonic').name));
    expect(tonic, '清單有補藥').toBeTruthy();
    const tonicIdx = b.menu.buttons.findIndex((x) => x.label === tonic.label);
    expect(tonicIdx).toBeGreaterThan(0);
    expect(b.menu.buttons[tonicIdx].confirm, '有說明的清單項目需要二次確認（觸控）').toBe(true);
    expect(b.menu.buttons.find((x) => x.label === '返回').confirm).toBe(false);
    if (touch) {
      expect(b.menu.buttons[b.menu.index].sub, '已聚焦的項目提示再點一次').toContain('點一下使用');
      const r = tonic;
      const lx = r.x + r.w / 2;
      const ly = r.y + r.h / 2;
      // 第一次點：只聚焦
      const box = await page.locator('canvas').boundingBox();
      await page.touchscreen.tap(box.x + (lx * box.width) / 360, box.y + (ly * box.height) / 640);
      await page.waitForFunction((i) => window.__SL.battle()?.menu?.index === i, tonicIdx, { timeout: 3_000 });
      await page.waitForTimeout(200);
      b = await g.battleWait();
      expect(b.mode, '第一次點沒有使用').toBe('items');
      expect(b.menu.help.text).toBe(itemDesc(tonic.label));
      expect(b.menu.buttons[tonicIdx].sub).toContain('點一下使用');
      expect(b.menu.buttons[0].sub ?? '').not.toContain('點一下使用');
      // 第二次點：使用（補藥要選目標）
      await page.touchscreen.tap(box.x + (lx * box.width) / 360, box.y + (ly * box.height) / 640);
      await page.waitForFunction(() => window.__SL.battle()?.mode === 'target', null, { timeout: 3_000 });
    } else {
      await g.battleButton((x) => x.label === tonic.label);
      await page.waitForFunction(() => window.__SL.battle()?.mode === 'target', null, { timeout: 3_000 });
      expect((await g.battleWait()).menu.help, '桌機：目標選單沒有說明框').toBeNull();
    }
    // 從選目標按返回 → 回到道具清單，聚焦在補藥
    await g.battleButton('返回');
    b = await g.battleWait();
    expect(b.mode).toBe('items');
    expect(b.menu.index, '返回後聚焦回原本那一項').toBe(tonicIdx);
    expect(b.menu.help.text).toBe(itemDesc(tonic.label));
    expect(b0.actor.id).toBe('hero');
  });

  test('滑鼠：點未聚焦的清單項目一次就使用（不需點兩下）', async ({ page }, testInfo) => {
    const { g, touch } = await enterBossBattle(page, testInfo);
    if (touch) return; // 觸控的二次點見上一個測試
    await g.battleButton('道具');
    const b = await g.battleWait();
    const tonic = b.menu.buttons.find((x) => x.label.startsWith(ITEM_DEFS.find((d) => d.id === 'tonic').name));
    expect(b.menu.buttons.indexOf(tonic)).toBeGreaterThan(b.menu.index);
    const box = await page.locator('canvas').boundingBox();
    await page.mouse.click(box.x + ((tonic.x + tonic.w / 2) * box.width) / 360, box.y + ((tonic.y + tonic.h / 2) * box.height) / 640);
    await page.waitForFunction(() => window.__SL.battle()?.mode === 'target', null, { timeout: 3_000 });
  });

  test('技能與道具描述：用真 Phaser Text 量測，玩家選單的每一項在框內放得下（不截斷、不長出面板）', async ({ page }, testInfo) => {
    await enterBossBattle(page, testInfo);
    // 玩家拿得到的技能＝角色技能＋譜系各階技能（敵人專用技能不會出現在玩家選單，不納入）
    const lineageSkills = ['archive', 'dream', 'trace', 'watch'].flatMap((f) => readData(`lineages/${f}.json`).ranks.flatMap((r) => r.skills ?? []));
    const rootIds = rootSkillIds();
    const ids = new Set([...readData('characters.json').flatMap((c) => c.skills ?? []), ...lineageSkills]);
    const descs = [
      ...SKILL_DEFS.filter((x) => ids.has(x.id) && !rootIds.has(x.id)).map((x) => x.desc),
      ...ITEM_DEFS.map((x) => x.desc),
    ];
    expect(descs.length).toBeGreaterThanOrEqual(12);
    const m = await page.evaluate((t) => window.__SL.measureHelp(t), descs);
    expect(m.length).toBe(descs.length);
    for (const r of m) {
      expect(r.textHeight, `${r.text} 文字高度離容量至少留 2px 餘裕`).toBeLessThanOrEqual(r.capacity - 2);
      expect(r.fits, `${r.text} 放不下（${r.lines} 行，文字高 ${r.textHeight}，可用 ${r.capacity}）`).toBe(true);
      expect(r.fontSize, r.text).toBeGreaterThanOrEqual(15);
      expect(r.y, r.text).toBeGreaterThanOrEqual(PANEL_TOP);
      expect(r.lines, r.text).toBeLessThanOrEqual(2);
    }
    testInfo.annotations.push({ type: 'help-max-lines', description: String(Math.max(...m.map((r) => r.lines))) });
  });

  /** 以 Phaser 的 Map 場景開指定遭遇戰（測試用；不改遊戲程式）。 */
  async function startEncounter(page, enc) {
    await page.evaluate(async (e) => {
      const { game } = await import('./src/main.js');
      game.scene.getScene('Map').doBattle(e);
    }, enc);
  }

  for (const enc of ['enc_ch7_omen', 'enc_ch5_canal_2']) {
    test(`說明框不蓋敵人的名稱、狀態與揭露的意圖（${enc}）`, async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const touch = isTouch(testInfo);
      await seedSaves(page, { 1: lateSave() });
      const g = game(page, { touch });
      await page.goto(`${TEST_URL}&seed=5`);
      await loadSlot(g, 1);
      await g.waitScene('Map');
      await startEncounter(page, enc);
      await g.waitScene('Battle');
      // 用預兆揭露一個敵人的意圖，再在還沒被消耗掉前打開道具清單量版面
      let b = await g.battleWait();
      let revealed = null;
      if (process.env.SL_SHOT_DIR && enc === 'enc_ch7_omen') {
        // 截圖用（不影響斷言）：主角回合打開技能清單，電腦 1280×800、手機 390×844
        b = await g.battleWait();
        while (b.actor.id !== 'hero') { await g.battleCommand({ skill: 'guard' }); b = await g.battleWait(); }
        await g.battleButton('技能');
        await page.setViewportSize(touch ? { width: 390, height: 844 } : { width: 1280, height: 800 });
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${process.env.SL_SHOT_DIR}/skills-${enc}-${touch ? '390x844' : '1280x800'}.png` });
        await page.setViewportSize(touch ? { width: 375, height: 667 } : { width: 1280, height: 720 });
        await g.battleButton('返回');
      }
      for (let guard = 0; guard < 12 && !revealed; guard++) {
        b = await g.battleWait();
        if (b.mode !== 'root') { await g.battleButton('返回'); continue; }
        const foes = b.units.filter((u) => u.side === 'enemy' && u.alive);
        const omen = b.commands.skills.find((x) => x.id === 'omen' && x.usable);
        if (b.actor.id === 'hero' && omen && !foes.some((u) => u.intentText)) {
          await g.battleCommand({ skill: 'omen', target: foes[0].uid });
          continue;
        }
        if (foes.some((u) => u.intentText)) { revealed = foes.find((u) => u.intentText); break; }
        await g.battleCommand({ skill: 'guard' });
      }
      expect(revealed, '揭露到至少一個意圖').toBeTruthy();
      b = await g.battleWait();
      await g.battleButton('道具');
      b = await g.battleWait();
      expectHelpGeometry(b, `${enc} 道具清單`);
      const box = b.menu.help.box;
      let checked = 0;
      for (const u of b.units.filter((x) => x.side === 'enemy' && x.alive)) {
        for (const [k, r] of Object.entries(u.textRects ?? {})) {
          if (!r) continue;
          checked += 1;
          expect(rectsOverlap(box, r), `${enc}：說明框不與 ${u.label} 的 ${k} 文字相交 ${JSON.stringify(r)} vs ${JSON.stringify(box)}`).toBe(false);
        }
        if (u.rect) expect(rectsOverlap(box, u.rect), `${enc}：說明框不蓋 ${u.label} 的立繪`).toBe(false);
      }
      expect(checked, "至少量到名稱與意圖文字").toBeGreaterThanOrEqual(2);
      expect(b.units.some((u) => u.textRects?.intent), '有量到意圖文字的矩形').toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`help-${enc}.png`) });
      if (process.env.SL_SHOT_DIR) await page.screenshot({ path: `${process.env.SL_SHOT_DIR}/help-${enc}-${testInfo.project.name}.png` });
    });
  }
});
