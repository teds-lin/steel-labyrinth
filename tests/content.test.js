// 內容測試：用真實資料（web/data/）＋ core 引擎模擬遊玩，證明序章可以通關、而且可以一路玩到第二章結束。
// 座標與 id 一律從載入的資料動態查，不寫死，地圖改版時仍有效。模擬器在 tests/lib/sim.js（平衡測試共用）。
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../tools/lib/bundle.mjs';
import { NO_CHARGE_MESSAGE } from '../web/src/core/interact.js';
import { simulate, finishBattle, prepareRetry, RETRY_COLLAPSE_CAP } from '../web/src/core/battle/engine.js';
import { migrations, sanitizeLoadedState, serialize, deserialize, CURRENT_VERSION } from '../web/src/core/save.js';
import { DREAM_CHOICE_ID } from '../web/src/core/dream.js';
import { deriveStats } from '../web/src/core/stats.js';
import { Sim as BaseSim, DEFAULT_NAME, playPrologue, playChapter1, playChapter2, playChapter3 } from './lib/sim.js';
import { makeSmartPolicy, smartPolicy } from './lib/policies.js';

const DATA_DIR = fileURLToPath(new URL('../web/data/', import.meta.url));
const NAME = DEFAULT_NAME;

// ───────────── 資料查詢 ─────────────
let data;
let dialogues; // id -> dialogue
beforeAll(() => {
  const { bundle, errors } = loadBundle(DATA_DIR);
  expect(errors).toEqual([]);
  data = bundle;
  dialogues = new Map(data.story.flatMap((s) => s.dialogues).map((d) => [d.id, d]));
});

const allObjects = () => data.maps.flatMap((m) => (m.objects ?? []).map((o) => ({ map: m, obj: o })));
const dialogueHasEffect = (dlg, pred) => dlg.nodes.some((n) => [...(n.effects ?? []), ...(n.choices ?? []).flatMap((c) => c.effects ?? [])].some(pred));

/** 序章測試用的模擬器（data 由 beforeAll 載入）。 */
class Sim extends BaseSim {
  constructor(opts = {}) { super(data, opts); }
}

// ───────────── 從資料找出關鍵物件 ─────────────
function findKeyLayout() {
  const doorEntry = allObjects().find(({ obj }) => obj.lock && dialogues.get(obj.look) && data.story.find((st) => st.id === 'prologue').dialogues.some((d) => d.id === obj.look));
  expect(doorEntry, '資料裡必須有 lock 物件').toBeTruthy();
  const keyId = doorEntry.obj.lock.fallback.replace(/^item:/, '');
  // 提供鑰匙的對話：給 keyId 的對話中，被某物件當 look 的那段（不是 lock 的 on_tag）
  const keyDialogues = [...dialogues.values()].filter((d) => dialogueHasEffect(d, (e) => e.give_item === keyId)).map((d) => d.id);
  const drawerEntry = allObjects().find(({ obj }) => keyDialogues.includes(obj.look));
  expect(drawerEntry, '必須有物件的 look 對話會給鑰匙').toBeTruthy();
  const endingMap = data.maps.find((m) => (m.triggers ?? []).some((t) => t.dialogue && dialogueHasEffect(dialogues.get(t.dialogue), (e) => e.chapter_end)));
  expect(endingMap, '必須有觸發 chapter_end 的觸發點').toBeTruthy();
  const endingTrigger = endingMap.triggers.find((t) => t.dialogue && dialogueHasEffect(dialogues.get(t.dialogue), (e) => e.chapter_end));
  const chapterId = [...dialogues.get(endingTrigger.dialogue).nodes.flatMap((n) => n.effects ?? [])].find((e) => e.chapter_end).chapter_end;
  return { door: doorEntry.obj, doorMap: doorEntry.map, keyId, drawer: drawerEntry.obj, drawerMap: drawerEntry.map, endingMap, endingTrigger, chapterId };
}

/** 從街道（結尾所在地圖）的觸發點走完結尾。 */
function finishChapter(sim, L) {
  sim.travelTo(L.endingMap.id);
  if (sim.state.chapter_done.length === 0) sim.walkTo(L.endingTrigger.x, L.endingTrigger.y);
}

// ───────────── 測試 ─────────────
describe('序章內容：用真實資料模擬遊玩', () => {
  it('殘響次數來自 manifest.start.echo_charges（序章為 3）', () => {
    expect(data.manifest.start.echo_charges).toBe(3);
    expect(new Sim().state.echo.charges).toBe(data.manifest.start.echo_charges);
  });

  it('鎖著調查門：依序播放 look 與 locked 兩段、文字不重複，且不扣殘響', () => {
    const L = findKeyLayout();
    const sim = new Sim().start();
    const before = { charges: sim.state.echo.charges, collapse: sim.state.collapse };
    sim.dialoguesPlayed = [];
    const r = sim.investigate(L.door.id);
    expect(r.unlocked).toBe(false);
    expect(sim.dialoguesPlayed).toEqual([L.door.look, L.door.lock.locked]);
    expect(sim.state.echo.charges).toBe(before.charges);
    expect(sim.state.collapse).toBe(before.collapse);
    const lookTexts = sim.textsOf(L.door.look);
    const lockedTexts = sim.textsOf(L.door.lock.locked);
    expect(lookTexts.length).toBeGreaterThan(0);
    expect(lockedTexts.length).toBeGreaterThan(0);
    for (const t of lookTexts) expect(lockedTexts).not.toContain(t);
    // look 是描述、locked 才說打不開：「鎖得死死的」這類句子只出現在 locked
    // look 只描述門；「鎖」「鑰匙」等打不開的資訊只在 locked 說，避免描述與打不開重複
    expect(lookTexts.join('')).not.toMatch(/鎖|鑰匙|轉不動/);
    expect(lockedTexts.join('')).toMatch(/鎖/);
  });

  it('有鑰匙調查門：先播「關著」的描述再播開門；開門後再調查只播「開著」的描述', () => {
    const L = findKeyLayout();
    const sim = new Sim({ choiceRules: ['撬'] }).start();
    sim.investigate(L.drawer.id);
    sim.log = [];
    sim.dialoguesPlayed = [];
    const r = sim.investigate(L.door.id);
    expect(r.unlocked).toBe(true);
    expect(sim.dialoguesPlayed).toEqual([L.door.look, L.door.lock.on_item]);
    const closedLook = sim.textsOf(L.door.look);
    sim.log = [];
    sim.dialoguesPlayed = [];
    sim.investigate(L.door.id);
    expect(sim.dialoguesPlayed).toEqual([L.door.look]);
    const openLook = sim.textsOf(L.door.look);
    expect(openLook.join('')).toMatch(/開著/);
    expect(closedLook.join('')).not.toMatch(/開著/);
    for (const t of openLook) expect(closedLook).not.toContain(t);
  });

  it('殘響開門後再調查門：只播「開著」的描述', () => {
    const L = findKeyLayout();
    const sim = new Sim().start();
    sim.echoOn(L.door.id);
    sim.log = [];
    sim.dialoguesPlayed = [];
    sim.investigate(L.door.id);
    expect(sim.dialoguesPlayed).toEqual([L.door.look]);
    expect(sim.textsOf(L.door.look).join('')).toMatch(/開著/);
  });

  it('資料載入無誤，且開局能播完開場對話', () => {
    const sim = new Sim().start();
    expect(sim.dialoguesPlayed).toEqual([data.manifest.start.dialogue]);
    expect(sim.state.location.map).toBe(data.manifest.start.map);
  });

  it('1b. 有殘響時【調查】鎖著的門也不會偷用殘響', () => {
    const L = findKeyLayout();
    const sim = new Sim().start();
    const r = sim.investigate(L.door.id);
    expect(r.unlocked).toBe(false);
    expect(sim.state.echo.charges).toBe(3);
    expect(sim.state.flags[L.door.lock.flag]).toBeUndefined();
  });

  it('1. 完全不用殘響也能通關：找鑰匙 → 開門 → 下樓 → 房東 → 街道結尾', () => {
    const L = findKeyLayout();
    const sim = new Sim({ charges: 0 }).start();
    expect(sim.state.echo.charges).toBe(0);

    // 門還打不開（沒鑰匙也沒殘響）
    const locked = sim.investigate(L.door.id);
    expect(locked.unlocked).toBe(false);
    expect(sim.state.flags[L.door.lock.flag]).toBeUndefined();

    // 找鑰匙
    sim.choiceRules = ['撬'];
    sim.investigate(L.drawer.id);
    expect(sim.state.items[L.keyId]).toBe(1);

    // 開門
    const opened = sim.investigate(L.door.id);
    expect(opened.unlocked).toBe(true);
    expect(sim.dialoguesPlayed.at(-1)).toBe(L.door.lock.on_item);
    expect(sim.state.flags[L.door.lock.flag]).toBe(true);

    // 下樓、處理房東、到街道結尾
    sim.choiceRules = [];
    finishChapter(sim, L);
    expect(sim.state.chapter_done).toContain(L.chapterId);
    expect(sim.state.location.map).toBe(L.endingMap.id);
    expect(sim.state.echo.charges).toBe(0);
    expect(sim.state.collapse).toBe(0);
    expect(sim.state.resonance.lie_exposed ?? 0).toBe(0);
    expect(sim.dialoguesPlayed).toContain(L.endingTrigger.dialogue);
  });

  it('2. 用殘響的路線：殘響開門、對房東說謊後看穿，通關且崩解／次數／共鳴正確', () => {
    const L = findKeyLayout();
    const sim = new Sim({ choiceRules: ['說謊', '看穿'] }).start();
    const start = sim.state.echo.charges;
    expect(start).toBe(3);

    // 殘響開門（同時順便拿到鑰匙）
    const r = sim.echoOn(L.door.id);
    expect(r.unlocked).toBe(true);
    expect(r.via).toBe('tag');
    expect(sim.state.flags[L.door.lock.flag]).toBe(true);
    expect(sim.state.items[L.keyId]).toBe(1);
    expect(sim.state.echo.charges).toBe(start - 1);
    expect(sim.state.collapse).toBe(5);

    finishChapter(sim, L);

    expect(sim.usedRules.has('看穿')).toBe(true);
    expect(sim.state.resonance.lie_exposed).toBe(1);
    expect(sim.state.flags.lie_exposed).toBe(true);
    expect(sim.state.echo.charges).toBe(start - 2);
    expect(sim.state.collapse).toBe(10);
    expect(sim.state.chapter_done).toContain(L.chapterId);
  });

  it('3. 重複調查抽屜不會拿到第二把鑰匙，也不會被殘響開門重複給鑰匙', () => {
    const L = findKeyLayout();
    const sim = new Sim({ choiceRules: ['撬'] }).start();
    for (let i = 0; i < 4; i++) {
      sim.investigate(L.drawer.id);
      expect(sim.state.items[L.keyId]).toBe(1);
    }
    // 有鑰匙之後再用殘響開門：也不會多一把
    sim.echoOn(L.door.id);
    expect(sim.state.items[L.keyId]).toBe(1);
    // 先用殘響拿鑰匙，再調查抽屜：同樣只有一把
    const sim2 = new Sim({ choiceRules: ['撬'] }).start();
    sim2.echoOn(L.door.id);
    sim2.investigate(L.drawer.id);
    expect(sim2.state.items[L.keyId]).toBe(1);
  });

  it('4. 殘響最多 3 次，用完再殘響回傳提示訊息、次數不為負', () => {
    const entry = allObjects().find(({ obj }) => typeof obj.echo === 'string' && !obj.lock);
    expect(entry, '需要一個有 echo 對話的一般物件').toBeTruthy();
    const sim = new Sim().start();
    expect(sim.state.echo.charges).toBe(3);
    for (let i = 1; i <= 3; i++) {
      const r = sim.echoOn(entry.obj.id);
      expect(r.message).toBeUndefined();
      expect(sim.state.echo.charges).toBe(3 - i);
      expect(sim.state.collapse).toBe(5 * i);
    }
    const r = sim.echoOn(entry.obj.id);
    expect(r.message).toBe(NO_CHARGE_MESSAGE);
    expect(r.dialogue).toBeNull();
    expect(sim.state.echo.charges).toBe(0);
    expect(sim.state.collapse).toBe(15);
    expect(sim.messages).toEqual([NO_CHARGE_MESSAGE]);
    // 再多按幾次也不會變負
    sim.echoOn(entry.obj.id);
    expect(sim.state.echo.charges).toBe(0);
  });

  it('5. 名字代入：自訂名字時，所有播放過的對話文字不殘留 {name}', () => {
    const L = findKeyLayout();
    // 兩條完整路線（鑰匙線＋殘響線）
    const keyRun = new Sim({ name: NAME, charges: 0, choiceRules: ['撬'] }).start();
    keyRun.investigate(L.drawer.id);
    keyRun.investigate(L.door.id);
    keyRun.choiceRules = [];
    finishChapter(keyRun, L);

    const echoRun = new Sim({ name: NAME, choiceRules: ['說謊', '看穿'] }).start();
    echoRun.echoOn(L.door.id);
    finishChapter(echoRun, L);

    // 另外把每一段對話都播一遍（選第 0 個）
    const all = new Sim({ name: NAME, charges: 5 });
    for (const id of dialogues.keys()) all.playOnly(id, () => 0);

    for (const sim of [keyRun, echoRun, all]) {
      expect(sim.log.length).toBeGreaterThan(0);
      for (const l of sim.log) {
        const fields = [l.speaker ?? '', l.text ?? '', ...(l.choices ?? [])];
        for (const f of fields) {
          expect(f, `${l.dialogue}：${f}`).not.toContain('{name}');
          expect(f, `${l.dialogue}：${f}`).not.toMatch(/\{[^}]*\}/);
        }
      }
      expect(sim.log.some((l) => (l.text ?? '').includes(NAME) || (l.speaker ?? '').includes(NAME))).toBe(true);
    }
  });

  describe('6. 所有對話都能從頭跑到結束（200 步內、不丟錯）', () => {
    const strategies = {
      '每個選項節點都選第 0 個': () => 0,
      '每個選項節點都選最後一個': (cur) => cur.choices.length - 1,
    };
    for (const [label, picker] of Object.entries(strategies)) {
      it(label, () => {
        expect(dialogues.size).toBeGreaterThan(0);
        for (const id of dialogues.keys()) {
          const sim = new Sim({ charges: 5 });
          let steps;
          expect(() => { steps = sim.playOnly(id, picker, 200); }, `對話 ${id}`).not.toThrow();
          expect(steps, `對話 ${id}`).toBeLessThanOrEqual(200);
        }
      });
    }
  });
});

// ───────────── M2：序章 → 第一章 → 第二章 ─────────────

const MAX_RETRIES = 10;
const CONTENT_SEED = 7100;

/**
 * 戰鬥解析器：用 simulate＋合理策略（不用任何道具；預兆可以用）、固定種子打；
 * 輸了（retry）就換下一個種子重打，模擬「重新挑戰」，最多 10 次。用了道具就直接失敗。
 */
function noItemResolver(record) {
  const smart = makeSmartPolicy({ useItems: false });
  const policy = (battle, cmds, d) => {
    const cmd = smart(battle, cmds, d);
    if (cmd.type === 'item') throw new Error(`策略用了道具：${JSON.stringify(cmd)}`);
    return cmd;
  };
  return (encId, state) => {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const r = simulate(encId, state, data, CONTENT_SEED + attempt, policy);
      const f = finishBattle(r.battle, state, data);
      if (f.next?.type !== 'retry') {
        record.push({ encounter: encId, attempts: attempt + 1, outcome: f.outcome });
        return f;
      }
    }
    throw new Error(`戰鬥「${encId}」重新挑戰 ${MAX_RETRIES} 次仍然過不了`);
  };
}

const ENCOUNTER_ORDER = ['enc_sparring', 'enc_dock_1', 'enc_dock_2', 'enc_warehouse', 'enc_boss'];
const itemsTotal = (s) => Object.values(s.items).reduce((a, b) => a + b, 0);

/** 第一章、第二章走完後共同的檢查。 */
function expectChapter2Done(sim, record) {
  const s = sim.state;
  expect(s.chapter_done).toEqual(['prologue', 'chapter1', 'chapter2']);
  expect(s.lineage).toEqual({ id: 'trace', rank: 9 });
  expect(s.party.map((m) => m.id)).toEqual(['hero', 'ada']);
  expect(s.flags).toMatchObject({ drank_potion: true, sparred: true, fog1_done: true, fog2_done: true, fog3_done: true, boss_done: true, ch2_deduced: true });
  expect(s.flags).toMatchObject({ clue_glove: true, clue_drag: true, clue_mark: true });
  expect(s.items.mouth_cloth).toBe(1);
  expect(record.map((r) => r.encounter)).toEqual(ENCOUNTER_ORDER);
  for (const r of record) expect(r.attempts).toBeLessThanOrEqual(MAX_RETRIES);
  expect(record.filter((r) => r.encounter !== 'enc_sparring').every((r) => r.outcome === 'victory')).toBe(true);
  // 第二章的結束畫面：第三章已開放 → continue 接第三章開場、副標是第三章的標題；未開放 → 沒有 continue、「第三章　製作中」
  const ch2 = data.story.find((st) => st.id === 'chapter2');
  expect(ch2.end_screen.title).toBe('第二章　完');
  const ch3 = data.story.find((st) => st.id === 'chapter3');
  if (data.manifest.chapters.includes('chapter3')) {
    expect(ch3, '第三章已開放，story 必須有 chapter3').toBeTruthy();
    const cont = ch2.end_screen.continue;
    expect(cont).toEqual({ map: 'office_ch3', spawn: 'door', dialogue: 'dlg_ch3_opening' });
    expect(data.maps.find((m) => m.id === cont.map)?.spawns.some((sp) => sp.id === cont.spawn)).toBe(true);
    expect(ch3.dialogues.some((d) => d.id === cont.dialogue)).toBe(true);
    expect(ch2.end_screen.subtitle).toBe(ch3.title);
  } else {
    expect(ch3).toBeUndefined();
    expect(ch2.end_screen.continue).toBeUndefined();
    expect(ch2.end_screen.subtitle).toBe('第三章　製作中');
  }
  // 存檔仍然合法
  expect(sanitizeLoadedState(JSON.parse(serialize(s)), data).ok).toBe(true);
}

describe('M2 內容：從新遊戲一路玩到第二章結束（不使用任何道具）', () => {
  for (const route of ['key', 'echo']) {
    it(`序章（${route === 'key' ? '鑰匙' : '殘響'}路線）→ 第一章 → 第二章完；戰鬥用合理策略，輸了換種子重新挑戰（最多 ${MAX_RETRIES} 次）`, () => {
      const record = [];
      const sim = new BaseSim(data, { battle: noItemResolver(record) });
      playPrologue(sim, route);
      expect(sim.state.chapter_done).toEqual(['prologue']);

      // end_screen.continue → 第一章
      sim.continueChapter();
      expect(sim.state.location.map).toBe('office');
      expect(sim.state.flags.ch1_briefed).toBe(true);
      const before = itemsTotal(sim.state);
      playChapter1(sim);
      expect(sim.state.chapter_done).toEqual(['prologue', 'chapter1']);
      expect(sim.state.lineage).toEqual({ id: 'trace', rank: 9 });
      expect(sim.state.party.map((m) => m.id)).toEqual(['hero', 'ada']);
      expect(sim.state.party.every((m) => m.hp === null && m.sp === null)).toBe(true); // 補給：全隊回滿
      expect(sim.state.ammo).toBe(9);
      expect(itemsTotal(sim.state)).toBeGreaterThan(before); // 拿到繃帶、鎮靜香
      expect(sim.state.items.bandage).toBe(2);
      expect(sim.state.items.sedative_incense).toBe(1);

      // end_screen.continue → 第二章
      sim.continueChapter();
      expect(sim.state.location.map).toBe('dock');
      playChapter2(sim);
      expectChapter2Done(sim, record);
      // 一個道具都沒用：補給與撿到的繃帶、鎮靜香全部還在（戰鬥掉落只會多不會少）
      expect(sim.state.items.bandage).toBeGreaterThanOrEqual(4);
      expect(sim.state.items.sedative_incense).toBe(2);
    });
  }

  it('序章 v1 存檔（M1 格式）用 migrations[1] 遷移後，可以接著進入第一章並玩到第二章完', () => {
    // M1 的存檔樣本：序章通關時的狀態，只留 v1 的欄位
    const prologue = playPrologue(new BaseSim(data), 'key').state;
    const { party, ammo, pending, dream_return: _dreamReturn, promotions: _promotions, ending: _ending, ...v1Fields } = prologue; // dream_return 是 v3 欄位；promotions、ending 是 v4 欄位
    const v1 = { ...JSON.parse(JSON.stringify(v1Fields)), schema_version: 1 };
    expect(Object.keys(v1).sort()).toEqual(['chapter', 'chapter_done', 'collapse', 'echo', 'flags', 'items', 'lineage', 'location', 'player', 'playtime_s', 'resonance', 'schema_version']);
    expect(v1.chapter_done).toEqual(['prologue']);

    const v2 = migrations[1](structuredClone(v1));
    expect(v2.schema_version).toBe(2); // migrations[1] 只做 v1→v2（v3 由 migrations[2] 接手）
    expect(v2.party).toEqual([{ id: 'hero', hp: null, sp: null }]);
    expect(v2.ammo).toBe(v1.items.revolver ? 3 : 0);
    const loaded = sanitizeLoadedState(v2, data);
    expect(loaded.ok, loaded.reason).toBe(true);
    expect(loaded.state.party).toEqual([{ id: 'hero', ...(({ hp, sp }) => ({ hp, sp }))(deriveStats('hero', loaded.state, data)) }]);

    const record = [];
    const sim = new BaseSim(data, { state: loaded.state, battle: noItemResolver(record) });
    sim.continueChapter();
    expect(sim.state.location.map).toBe('office');
    playChapter1(sim);
    expect(sim.state.chapter_done).toEqual(['prologue', 'chapter1']);
    expect(sim.state.party.map((m) => m.id)).toEqual(['hero', 'ada']);
    sim.continueChapter();
    playChapter2(sim);
    expectChapter2Done(sim, record);
  });
});

// ───────────── M2 修正輪（規格補充 2）：子彈一致、重新挑戰 ─────────────

/** 記下每場戰鬥的戰前狀態，再交給 inner 解析。 */
const recordingResolver = (pre, inner) => (encId, state, sim) => { pre.set(encId, structuredClone(state)); return inner(encId, state, sim); };

describe('M2 修正輪：子彈與重新挑戰', () => {
  it('新遊戲在序章撿起左輪（帶在身上）→ 子彈 3 發（與 v1 遷移一致）；教學戰時子彈 ≥ 1', () => {
    const pre = new Map();
    const sim = new BaseSim(data, { battle: recordingResolver(pre, noItemResolver([])) });
    sim.start();
    sim.choiceRules = ['帶在身上'];
    sim.investigate('obj_bed');
    expect(sim.state.items.revolver).toBe(1);
    expect(sim.state.ammo).toBe(3);
    sim.choiceRules = [];
    sim.investigate('obj_bed'); // 再調查一次不會重複給子彈
    expect(sim.state.ammo).toBe(3);
    playPrologue(Object.assign(sim, { start: () => sim }), 'key');
    sim.continueChapter();
    playChapter1(sim);
    expect(pre.get('enc_sparring').items.revolver).toBe(1);
    expect(pre.get('enc_sparring').ammo).toBeGreaterThanOrEqual(1);
    expect(pre.get('enc_sparring').ammo).toBe(3);
  });

  it('有槍但 0 發（例如修正前的存檔）→ 教學戰前馬洛補子彈，教學戰時子彈 ≥ 1', () => {
    const prologue = playPrologue(new BaseSim(data), 'key').state;
    const state = { ...prologue, items: { ...prologue.items, revolver: 1 }, ammo: 0 };
    const pre = new Map();
    const sim = new BaseSim(data, { state, battle: recordingResolver(pre, noItemResolver([])) });
    sim.continueChapter();
    playChapter1(sim);
    expect(pre.get('enc_sparring').ammo).toBeGreaterThanOrEqual(1);
  });

  it('第二章工寮的補給箱：一次性給子彈 3 發（過橋前）', () => {
    const pre = new Map();
    const sim = new BaseSim(data, { battle: recordingResolver(pre, noItemResolver([])) });
    playPrologue(sim, 'key');
    sim.continueChapter();
    playChapter1(sim);
    sim.continueChapter();
    const ammo0 = sim.state.ammo;
    sim.investigate('obj_shed_box');
    expect(sim.state.ammo).toBe(ammo0 + 3);
    sim.investigate('obj_shed_box');
    expect(sim.state.ammo).toBe(ammo0 + 3);
  });

  it('Boss 刻意輸一次 → prepareRetry（全隊回滿、崩解 ≤ 60）→ 重新挑戰後打完第二章', () => {
    const record = [];
    const retries = [];
    const loser = (battle, cmds) => ({ type: 'skill', skill: 'guard' }); // 只防禦：一定打不贏
    const resolver = (encId, state) => {
      if (encId !== 'enc_boss') return noItemResolver(record)(encId, state);
      const lost = simulate(encId, state, data, CONTENT_SEED, loser);
      const f = finishBattle(lost.battle, state, data);
      expect(['defeat', 'lost_control']).toContain(f.outcome);
      expect(f.next).toEqual({ type: 'retry' });
      expect(f.state).toBe(state); // 戰敗不改變狀態：重新挑戰從戰前狀態算
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const retry = prepareRetry(state, data);
        retries.push(retry);
        const r = simulate(encId, retry, data, CONTENT_SEED + attempt, smartPolicy);
        const g = finishBattle(r.battle, retry, data);
        if (g.next?.type !== 'retry') { record.push({ encounter: encId, attempts: attempt + 1, outcome: g.outcome }); return g; }
      }
      throw new Error('重新挑戰仍然過不了');
    };
    const sim = new BaseSim(data, { battle: resolver });
    playPrologue(sim, 'echo');
    sim.continueChapter();
    playChapter1(sim);
    sim.continueChapter();
    playChapter2(sim, { wife: 'lie' });
    expect(retries.length).toBeGreaterThanOrEqual(1);
    for (const s of retries) {
      expect(s.collapse).toBeLessThanOrEqual(RETRY_COLLAPSE_CAP);
      for (const m of s.party) expect([m.hp, m.sp]).toEqual([deriveStats(m.id, s, data).hp, deriveStats(m.id, s, data).sp]);
    }
    expect(record.find((r) => r.encounter === 'enc_boss').attempts).toBeGreaterThanOrEqual(2);
    expect(sim.state.flags.boss_done).toBe(true);
    expect(sim.state.chapter_done).toContain('chapter2');
  });
});

// ───────────── M4：第三章（鐘塔之夢） ─────────────

/** 新遊戲（鑰匙路線）一路玩到第二章完，回傳模擬器。 */
function playToChapter2End(route = 'key') {
  const sim = new BaseSim(data, { battle: noItemResolver([]) });
  playPrologue(sim, route);
  sim.continueChapter();
  playChapter1(sim);
  sim.continueChapter();
  playChapter2(sim);
  expect(sim.state.chapter_done).toEqual(['prologue', 'chapter1', 'chapter2']);
  return sim;
}

/** 存檔字串 → deserialize（含遷移）→ sanitizeLoadedState：讀檔的完整路徑。 */
function reload(str) {
  const loaded = sanitizeLoadedState(deserialize(str), data);
  expect(loaded.ok, loaded.reason).toBe(true);
  return loaded;
}

/** 第三章完的共同檢查。 */
function expectChapter3Done(sim) {
  const s = sim.state;
  expect(s.chapter_done).toEqual(['prologue', 'chapter1', 'chapter2', 'chapter3']);
  expect(s.chapter).toBe('chapter3');
  expect(s.flags).toMatchObject({ ch3_briefed: true, ch3_slept: true, met_guests: true, dream_unlocked: true, ch3_woke: true, ch3_marlo_day: true, told_marlo_dream: true });
  expect(s.dream_return).toBeNull();
  expect(s.location.map).toBe('office_ch3');
  expect(sim.dialoguesPlayed.at(-1)).toBe('dlg_ch3_marlo_day');
  const ch3 = data.story.find((st) => st.id === 'chapter3');
  expect(ch3.end_screen.title).toBe('第三章　完');
  if (!data.manifest.chapters.includes('chapter4')) expect(ch3.end_screen.continue).toBeUndefined();
  expect(sanitizeLoadedState(JSON.parse(serialize(s)), data).ok).toBe(true);
}

describe('M4 內容：第三章（鐘塔之夢）', () => {
  it('第三章已開放：manifest 有 chapter3，鐘塔是夢境地圖，沙發與保溫瓶是入夢點', () => {
    expect(data.manifest.chapters).toEqual(['prologue', 'chapter1', 'chapter2', 'chapter3']);
    expect(data.maps.find((m) => m.id === 'clocktower').dream).toBe(true);
    const office = data.maps.find((m) => m.id === 'office_ch3');
    for (const id of ['obj_ch3_sofa', 'obj_ch3_thermos']) {
      expect(office.objects.find((o) => o.id === id).dream).toMatchObject({ map: 'clocktower', spawn: 'center' });
    }
  });

  it('新遊戲 → 第二章完 → 第三章：第一次入夢、鐘塔存檔與讀檔、醒來回到原位、從沙發再次入夢、第三章完', () => {
    const sim = playToChapter2End('key');
    const office = data.maps.find((m) => m.id === 'office_ch3');
    const sofa = office.objects.find((o) => o.id === 'obj_ch3_sofa');

    // 第二章結束畫面 → 第三章開場（辦公室傍晚）
    sim.continueChapter();
    expect(sim.state.chapter).toBe('chapter3');
    expect(sim.state.location.map).toBe('office_ch3');
    expect(sim.state.flags.ch3_briefed).toBe(true);
    expect(sim.dialoguesPlayed.at(-1)).toBe('dlg_ch3_opening');

    // 第一次入夢：沙發的 look 對話選「躺下睡覺」（dream_unlocked 之前引擎不問「入夢」）
    sim.faceObject('obj_ch3_sofa');
    const sofaSpot = { ...sim.state.location };
    sim.choiceRules = ['躺下'];
    const r1 = sim.investigate('obj_ch3_sofa');
    expect(r1.dream).toBeUndefined();
    expect(sim.state.location.map).toBe('clocktower');
    expect(sim.state.dream_return).toEqual(sofaSpot);
    expect(sim.dialoguesPlayed.slice(-2)).toEqual(['dlg_ch3_sofa', 'dlg_dream_arrive']);
    expect(sim.state.flags).toMatchObject({ ch3_slept: true, met_guests: true, dream_unlocked: true, code_accepted: true });
    expect(sim.log.some((l) => l.dialogue === DREAM_CHOICE_ID)).toBe(false);
    sim.choiceRules = [];

    // 十二點的椅子：全隊回滿、崩解下降（每次入夢一次）
    sim.state = { ...sim.state, collapse: 30, party: sim.state.party.map((m) => ({ ...m, hp: 1 })) };
    sim.investigate('obj_chair_twelve');
    expect(sim.state.collapse).toBe(20);
    expect(sim.state.party.every((m) => m.hp === null && m.sp === null)).toBe(true);
    expect(sim.state.flags.dream_rested).toBe(true);
    sim.investigate('obj_chair_twelve');
    expect(sim.state.collapse).toBe(20); // 同一趟夢不能再休息

    // 夢客：未開雲端的模擬器只記下 open_chat
    sim.choiceRules = ['自由交談'];
    sim.investigate('obj_guest_three');
    sim.investigate('obj_guest_nine');
    expect(sim.chats).toEqual(['three', 'nine']);
    sim.choiceRules = [];

    // 在鐘塔存檔 → 讀檔：仍在夢中，dream_return 不變
    const saved = serialize(sim.state);
    expect(JSON.parse(saved)).toMatchObject({ schema_version: CURRENT_VERSION, dream_return: sofaSpot, location: { map: 'clocktower' } });
    const loaded = reload(saved);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.state.location).toEqual(sim.state.location);
    expect(loaded.state.dream_return).toEqual(sofaSpot);
    const sim2 = new BaseSim(data, { state: loaded.state });

    // 南邊的門醒來：回到入夢前的位置與方向
    sim2.choiceRules = ['推開門'];
    sim2.investigate('obj_tower_door');
    expect(sim2.wakes).toEqual([{ relocated: false }]);
    expect(sim2.state.location).toEqual(sofaSpot);
    expect(sim2.state.dream_return).toBeNull();
    expect(sim2.state.flags.ch3_woke).toBe(true);
    sim2.choiceRules = [];

    // 從現實的沙發再次入夢：look（again）之後，引擎問「入夢」，提示文字由沙發的 dream 欄位提供
    sim2.log = [];
    const r2 = sim2.investigate('obj_ch3_sofa');
    expect(r2.dream).toMatchObject({ map: 'clocktower', spawn: 'center' });
    const ask = sim2.log.find((l) => l.dialogue === DREAM_CHOICE_ID);
    expect(ask, '再次調查沙發時要問「入夢」').toBeTruthy();
    expect(ask.text).toBe(sofa.dream.prompt);
    expect(ask.choices).toEqual([sofa.dream.yes, sofa.dream.no]);
    expect(sim2.state.location.map).toBe('clocktower');
    expect(sim2.state.dream_return).toEqual(sofaSpot);
    expect(sim2.dialoguesPlayed.filter((d) => d === 'dlg_dream_arrive')).toEqual([]); // on_enter 只在第一次播
    expect(sim2.state.flags.dream_rested).toBeUndefined(); // 沙發的 again 清掉了 → 這趟可以再休息
    sim2.state = { ...sim2.state, collapse: 5 };
    sim2.investigate('obj_chair_twelve');
    expect(sim2.state.collapse).toBe(0);

    // 再次醒來（已醒過一次的分歧）→ 回到原位
    sim2.choiceRules = ['醒來'];
    sim2.investigate('obj_tower_door');
    expect(sim2.state.location).toEqual(sofaSpot);
    expect(sim2.state.dream_return).toBeNull();
    expect(sim2.wakes).toEqual([{ relocated: false }, { relocated: false }]);

    // 白天：艾妲、馬洛 → 第三章完
    sim2.choiceRules = ['鐘聲'];
    sim2.investigate('obj_ch3_ada');
    expect(sim2.state.flags.ch3_ada_talked).toBe(true);
    sim2.choiceRules = ['說實話', '走吧'];
    sim2.investigate('obj_ch3_marlo_day');
    expectChapter3Done(sim2);
  });

  it('保溫瓶也能再次入夢，提示文字與沙發不同（各自的語氣）；選「留在現實」不入夢', () => {
    const sim = playToChapter2End('echo');
    sim.continueChapter();
    playChapter3(sim);
    expectChapter3Done(sim);
    const office = data.maps.find((m) => m.id === 'office_ch3');
    const [sofa, thermos] = ['obj_ch3_sofa', 'obj_ch3_thermos'].map((id) => office.objects.find((o) => o.id === id));
    for (const o of [sofa, thermos]) for (const k of ['prompt', 'yes', 'no']) expect(typeof o.dream[k], `${o.id}.dream.${k}`).toBe('string');
    expect(thermos.dream.prompt).not.toBe(sofa.dream.prompt);

    // 第三章完之後（結束畫面前）的狀態直接拿來測：保溫瓶 → 留在現實
    const here = { ...sim.state };
    sim.log = [];
    sim.choiceRules = [thermos.dream.no];
    sim.investigate('obj_ch3_thermos');
    const ask = sim.log.find((l) => l.dialogue === DREAM_CHOICE_ID);
    expect(ask.text).toBe(thermos.dream.prompt);
    expect(ask.choices).toEqual([thermos.dream.yes, thermos.dream.no]);
    expect(sim.state.location.map).toBe('office_ch3');
    expect(sim.state.dream_return).toBeNull();
    // 保溫瓶 → 入夢 → 醒來回到保溫瓶旁
    sim.faceObject('obj_ch3_thermos');
    const spot = { ...sim.state.location };
    sim.choiceRules = [thermos.dream.yes];
    sim.investigate('obj_ch3_thermos');
    expect(sim.state.location.map).toBe('clocktower');
    expect(sim.state.dream_return).toEqual(spot);
    sim.choiceRules = ['醒來'];
    sim.investigate('obj_tower_door');
    expect(sim.state.location).toEqual(spot);
    expect(here.chapter_done).toEqual(sim.state.chapter_done);
  });

  it('v2 存檔（第二章完）遷移到 v3 後，可以接著從第二章結束畫面進入第三章並玩到第三章完', () => {
    const ch2 = playToChapter2End('key').state;
    // v2 的存檔樣本：第二章完時的狀態，沒有 dream_return
    const { dream_return: _dr, ...v2Fields } = ch2;
    const v2 = { ...JSON.parse(JSON.stringify(v2Fields)), schema_version: 2, pending: null };
    expect(Object.hasOwn(v2, 'dream_return')).toBe(false);
    expect(v2.chapter_done).toEqual(['prologue', 'chapter1', 'chapter2']);

    const v3 = migrations[2](structuredClone(v2));
    expect(v3.schema_version).toBe(3);
    expect(v3.dream_return).toBeNull();
    const loaded = reload(JSON.stringify(v2)); // deserialize 會自動跑 migrations[2]
    expect(loaded.state.schema_version).toBe(CURRENT_VERSION);
    expect(loaded.state.dream_return).toBeNull();
    expect(loaded.state.location).toEqual(ch2.location);

    const sim = new BaseSim(data, { state: loaded.state });
    sim.continueChapter();
    expect(sim.state.location.map).toBe('office_ch3');
    playChapter3(sim, { redream: true });
    expectChapter3Done(sim);
    expect(sim.wakes).toEqual([{ relocated: false }, { relocated: false }]);
  });
});
