// DATA-FORMAT「補充（2026-10-18，依故事聖經）」：通用 can_promote、promoted_forced、夢客依章節讀取、戰鬥狀態 bind。
import { describe, it, expect } from 'vitest';
import { checkCondition, evalCondition } from '../../web/src/core/conditions.js';
import { applyEffect } from '../../web/src/core/effects.js';
import { availableTrades, applyTrade, tradeFlag } from '../../web/src/core/trade.js';
import { guestById, guestFor } from '../../web/src/core/dream.js';
import { validateBundle } from '../../web/src/core/validate.js';
import { checkBattleEffect, applyBattleEffect, BATTLE_STATUSES } from '../../web/src/core/battle/effects.js';
import { act, advanceEnemy, isPlayerTurn, startBattle } from '../../web/src/core/battle/engine.js';
import { checkBattleCondition } from '../../web/src/core/battle/ai.js';
import { createRng } from '../../web/src/core/rng.js';
import { battleData, battleState } from './battle/fixture.js';
import { unit, mkBattle, byUid } from './battle/helpers.js';

// ---------- 1. can_promote 通用寫法 ----------
const linData = () => ({
  items: [{ id: 'moss', name: '回聲苔' }, { id: 'shard', name: '影片' }],
  lineages: [{ id: 'trace', ranks: [
    { rank: 9, name: '讀痕者' },
    { rank: 8, name: '借聲者', potion: { materials: [{ item: 'moss', count: 1 }], resonance: 12, forced_collapse: 40 } },
    { rank: 7, name: '換影者', potion: { materials: [{ item: 'shard', count: 2 }], resonance: 20, forced_collapse: 30 } },
  ] }],
});

describe('補充 1：can_promote: N ＝ 目前階位 N＋1，且晉升到 N 的材料齊全', () => {
  it('階 8 → 7：看階 7 的材料（不是寫死 9）', () => {
    const d = linData();
    const s = { lineage: { id: 'trace', rank: 8 }, items: { shard: 2 } };
    expect(evalCondition({ can_promote: 7 }, s, d)).toBe(true);
    expect(evalCondition({ can_promote: 7 }, { ...s, items: { shard: 1, moss: 5 } }, d)).toBe(false);
    expect(evalCondition({ can_promote: 8 }, s, d)).toBe(false); // 目前已是 8
    expect(evalCondition({ can_promote: 8 }, { lineage: { id: 'trace', rank: 9 }, items: { moss: 1 } }, d)).toBe(true);
  });
});

// ---------- 2. promoted_forced ----------
describe('補充 2：promoted_forced: N', () => {
  const s = (promotions) => ({ promotions });
  it('寫法：整數', () => {
    expect(checkCondition({ promoted_forced: 8 })).toEqual([]);
    for (const v of ['8', 8.5, null, true]) expect(checkCondition({ promoted_forced: v }).length).toBeGreaterThan(0);
  });
  it('晉升到 N 的那一筆是硬喝 → 成立；正常喝、沒晉升過 → 不成立', () => {
    const p = [{ lineage: 'trace', rank: 8, forced: true, chapter: 'chapter4' }, { lineage: 'trace', rank: 7, forced: false, chapter: 'chapter7' }];
    expect(evalCondition({ promoted_forced: 8 }, s(p))).toBe(true);
    expect(evalCondition({ promoted_forced: 7 }, s(p))).toBe(false);
    expect(evalCondition({ promoted_forced: 6 }, s(p))).toBe(false);
    expect(evalCondition({ promoted_forced: 8 }, {})).toBe(false); // 舊 state 沒有 promotions
    expect(evalCondition({ not: { promoted_forced: 8 } }, s([]))).toBe(true);
  });
  it('不需要 data；和 promote 效果寫的紀錄一致', () => {
    const d = linData();
    const st = applyEffect({ promote: { lineage: 'trace', rank: 8 } }, { lineage: { id: 'trace', rank: 9 }, items: { moss: 1 }, resonance: {}, collapse: 0, chapter: 'chapter4', promotions: [] }, d);
    expect(evalCondition({ promoted_forced: 8 }, st)).toBe(true);
  });
});

// ---------- 3. 夢客依章節讀取 ----------
const SCRIPTED = (tag) => ({ greeting: [`${tag}：你好。`], fallback: ['霧。'], quota: ['今天到這裡。'], filtered: ['當我沒說。'], not_open: ['（雲端）'] });
const guestData = () => ({
  manifest: { chapters: ['chapter3', 'chapter4', 'chapter5', 'chapter6'] },
  items: [{ id: 'sedative_incense', name: '鎮靜香' }, { id: 'echo_moss', name: '回聲苔' }, { id: 'bandage', name: '繃帶' }],
  story: [
    { id: 'chapter3', guests: [{ id: 'three', name: '三點', scripted: SCRIPTED('三點第三章') }] },
    { id: 'chapter4', guests: [{ id: 'nine', name: '九點', scripted: SCRIPTED('九點第四章'), trades: [
      { id: 'nine_moss', label: '鎮靜香換回聲苔', give: [{ item: 'sedative_incense', count: 2 }], get: [{ item: 'echo_moss', count: 1 }], once: true },
    ] }] },
    { id: 'chapter5', guests: [] },
    { id: 'chapter6', guests: [
      { id: 'nine', name: '九點', scripted: SCRIPTED('九點第六章'), trades: [
        { id: 'nine_moss', label: '鎮靜香換回聲苔', give: [{ item: 'sedative_incense', count: 2 }], get: [{ item: 'echo_moss', count: 1 }], once: true },
        { id: 'nine_bandage', label: '回聲苔換繃帶', give: [{ item: 'echo_moss', count: 1 }], get: [{ item: 'bandage', count: 3 }] },
      ] },
      { id: 'three', name: '三點', scripted: SCRIPTED('三點第六章') },
    ] },
  ],
});
const at = (chapter, over = {}) => ({ chapter, flags: {}, items: { sedative_incense: 4, echo_moss: 1 }, ...over });

describe('補充 3：夢客以目前章節為準，沒有就往前一章找', () => {
  it('guestFor：目前章節有定義就用它', () => {
    expect(guestFor('nine', at('chapter6'), guestData()).scripted.greeting).toEqual(['九點第六章：你好。']);
    expect(guestFor('three', at('chapter6'), guestData()).scripted.greeting).toEqual(['三點第六章：你好。']);
  });
  it('目前章節沒有 → 往前一章找，直到找到', () => {
    expect(guestFor('nine', at('chapter5'), guestData()).scripted.greeting).toEqual(['九點第四章：你好。']);
    expect(guestFor('three', at('chapter5'), guestData()).scripted.greeting).toEqual(['三點第三章：你好。']);
    expect(guestFor('three', at('chapter4'), guestData()).name).toBe('三點');
  });
  it('往前都找不到（例如第三章找九點）→ null；不往後找（防劇透）', () => {
    expect(guestFor('nine', at('chapter3'), guestData())).toBeNull();
    expect(guestFor('ghost', at('chapter6'), guestData())).toBeNull();
  });
  it('state.chapter 不在 manifest.chapters → 從最後一章往前找', () => {
    expect(guestFor('nine', at('nope'), guestData()).scripted.greeting).toEqual(['九點第六章：你好。']);
  });
  it('guestById(data, id, state)：帶 state 時照同一規則；不帶 state 維持舊行為（第一個找到的）', () => {
    expect(guestById(guestData(), 'three', at('chapter6')).scripted.greeting).toEqual(['三點第六章：你好。']);
    expect(guestById(guestData(), 'three').scripted.greeting).toEqual(['三點第三章：你好。']);
  });
  it('availableTrades 依目前章節的交換表', () => {
    expect(availableTrades('nine', at('chapter4'), guestData()).map((t) => t.id)).toEqual(['nine_moss']);
    expect(availableTrades('nine', at('chapter5'), guestData()).map((t) => t.id)).toEqual(['nine_moss']);
    expect(availableTrades('nine', at('chapter6'), guestData()).map((t) => t.id)).toEqual(['nine_moss', 'nine_bandage']);
    expect(availableTrades('nine', at('chapter3'), guestData())).toEqual([]);
  });
  it('applyTrade 依目前章節；once 旗標跨章節共用（第四章換過，第六章不再列出）', () => {
    expect(() => applyTrade('nine_bandage', at('chapter4'), guestData())).toThrow(/找不到交換/);
    const s = applyTrade('nine_moss', at('chapter4'), guestData());
    expect(s.flags[tradeFlag('nine', 'nine_moss')]).toBe(true);
    expect(availableTrades('nine', { ...s, chapter: 'chapter6' }, guestData()).map((t) => t.id)).toEqual(['nine_bandage']);
    expect(applyTrade('nine_bandage', { ...s, chapter: 'chapter6' }, guestData()).items.bandage).toBe(3);
  });
});

describe('補充 3：validate 允許同一位夢客在不同章節重新定義', () => {
  const bundle = () => {
    const d = guestData();
    return {
      manifest: { chapters: d.manifest.chapters, start: { map: 'room', spawn: 'd' }, files: { maps: ['room'], story: d.manifest.chapters } },
      tiles: [{ id: 'floor', solid: false }], items: d.items, lineages: [],
      maps: [{ id: 'room', name: '房間', tiles: ['..'], legend: { '.': 'floor' }, spawns: [{ id: 'd', x: 0, y: 0 }] }],
      story: d.story.map((s, i) => ({ ...s, title: `第${i + 3}章`, end_screen: { title: '完', subtitle: '續' }, dialogues: [] })),
    };
  };
  it('合法：nine 在第四、六章各一份；同一位夢客跨章節重用同一個交換 id', () => {
    expect(validateBundle(bundle())).toEqual([]);
  });
  it('同一章裡夢客 id 重複 → 報錯', () => {
    const b = bundle();
    b.story[3].guests.push({ ...b.story[3].guests[0] });
    expect(validateBundle(b).some((e) => /story\/chapter6\.json.*夢客 id「nine」重複/.test(e))).toBe(true);
  });
  it('不同夢客用同一個交換 id → 報錯（applyTrade 只用交換 id 查詢）', () => {
    const b = bundle();
    b.story[3].guests[1].trades = [{ ...b.story[3].guests[0].trades[1] }];
    expect(validateBundle(b).some((e) => /交換 id「nine_bandage」重複/.test(e))).toBe(true);
  });
});

// ---------- 4. 戰鬥狀態 bind ----------
describe('補充 4：bind（影縛）', () => {
  const data = battleData();
  it('是合法的狀態（效果積木與 AI 條件 target_has_status）', () => {
    expect(BATTLE_STATUSES).toContain('bind');
    expect(checkBattleEffect({ type: 'status', status: 'bind', turns: 2 })).toEqual([]);
    expect(checkBattleCondition({ target_has_status: 'bind' })).toEqual([]);
  });
  it('受到傷害不會解除（和 sleep 不同），也沒有睡眠的 1.5 倍', () => {
    const b = mkBattle([unit('p0', 'party'), unit('e0', 'enemy', { hp: 100 }, { status: { bind: 2 } })]);
    const r = applyBattleEffect(b, { type: 'damage', fixed: 10 }, 'p0', 'e0', data);
    expect(byUid(r.battle, 'e0').status.bind).toBe(2);
    expect(byUid(r.battle, 'e0').hp).toBe(90);
    expect(r.log.some((e) => e.type === 'wake')).toBe(false);
  });
  it('受意志減免（敵對效果）：chance × 50 ÷ (50＋will)', () => {
    let ok = 0;
    for (let s = 1; s <= 400; s++) {
      const b = mkBattle([unit('p0', 'party'), unit('e0', 'enemy', { will: 50 })], { rng: createRng(s) });
      if (byUid(applyBattleEffect(b, { type: 'status', status: 'bind', turns: 1 }, 'p0', 'e0', data).battle, 'e0').status.bind === 1) ok++;
    }
    expect(ok).toBeGreaterThan(160);
    expect(ok).toBeLessThan(240);
  });
  it('持續期間輪到時跳過行動（bind_skip），回合數減少，意圖不變', () => {
    const heroState = battleState({ lineage: { id: 'trace', rank: 9 }, ammo: 3, items: { bandage: 2 } });
    let b = null;
    for (let s = 1; s < 50 && !b; s++) {
      const x = startBattle('enc_one', heroState, data, s);
      if (isPlayerTurn(x)) b = structuredClone(x);
    }
    byUid(b, 'e0').status.bind = 1;
    const intent = byUid(b, 'e0').intent;
    let r = act(b, { type: 'skill', skill: 'guard' }, data);
    const logs = [...r.log];
    for (let i = 0; i < 10 && r.battle.outcome === null && !isPlayerTurn(r.battle); i++) { r = advanceEnemy(r.battle, data); logs.push(...r.log); }
    expect(logs).toContainEqual({ type: 'bind_skip', uid: 'e0' });
    expect(logs.some((e) => e.type === 'action' && e.uid === 'e0' && logs.indexOf(e) < logs.findIndex((x) => x.type === 'bind_skip'))).toBe(false);
    expect(byUid(r.battle, 'e0').status.bind).toBeUndefined();
    expect(byUid(r.battle, 'e0').intent).toEqual(intent);
  });
});
