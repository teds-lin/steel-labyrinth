// M5 晉升：promote 效果、can_promote／resonance_gte／collapse_lte／collapse_gte 條件、共鳴計算、promotionStatus。
import { describe, it, expect } from 'vitest';
import { checkCondition, evalCondition } from '../../web/src/core/conditions.js';
import { applyEffect, applyEffects, checkEffect, takePending } from '../../web/src/core/effects.js';
import { startDialogue } from '../../web/src/core/dialogue.js';
import { resonanceTotal, promotionStatus } from '../../web/src/core/promotion.js';
import { deriveStats, availableSkills } from '../../web/src/core/stats.js';
import { availableFieldTags } from '../../web/src/core/state.js';
import { useFieldItem } from '../../web/src/core/items.js';

const POTION8 = { materials: [{ item: 'echo_moss', count: 2 }, { item: 'choir_wax', count: 1 }], resonance: 12, forced_collapse: 40 };
const data = () => ({
  items: [{ id: 'echo_moss', name: '回聲苔' }, { id: 'choir_wax', name: '唱詩蠟' }, { id: 'tonic', name: '提神劑', field_effects: [{ promote: { lineage: 'trace', rank: 8 } }] }],
  lineages: [{
    id: 'trace',
    ranks: [
      { rank: 9, name: '讀痕者', field: ['trace'], skills: ['omen'], stats: { hp: 10, sp: 10, will: 4 } },
      { rank: 8, name: '借聲者', field: ['voice'], skills: ['whisper'], stats: { hp: 5, will: 2 }, potion: POTION8 },
      { rank: 7, name: '換影者', field: ['shadow'], skills: ['swap'], stats: { hp: 5 }, potion: { materials: [{ item: 'echo_moss', count: 1 }], resonance: 20, forced_collapse: 30 } },
    ],
  }],
  characters: [{ id: 'hero', name: '{name}', base: { hp: 50, sp: 20, atk: 10, def: 5, spd: 10, will: 5, eva: 5 }, skills: ['attack'] }],
});
const base = (over = {}) => ({
  flags: {}, items: { echo_moss: 2, choir_wax: 1 }, collapse: 10, resonance: { lie_exposed: 8, truth_seen: 5 },
  lineage: { id: 'trace', rank: 9 }, chapter: 'chapter4', party: [{ id: 'hero', hp: null, sp: null }], pending: null, promotions: [], ...over,
});
const PROMOTE8 = { promote: { lineage: 'trace', rank: 8 } };

describe('共鳴計算', () => {
  it('resonanceTotal＝state.resonance 各事件數加總；沒有或壞值當 0', () => {
    expect(resonanceTotal(base())).toBe(13);
    expect(resonanceTotal({ resonance: {} })).toBe(0);
    expect(resonanceTotal({})).toBe(0);
    expect(resonanceTotal({ resonance: { a: 2, b: 'x', c: -1, d: 1.5 } })).toBe(2);
  });
});

describe('條件：can_promote／resonance_gte／collapse_lte／collapse_gte', () => {
  it('寫法檢查：值必須是整數（resonance／collapse 非負）', () => {
    for (const c of [{ can_promote: 8 }, { resonance_gte: 12 }, { resonance_gte: 0 }, { collapse_lte: 40 }, { collapse_gte: 60 }]) expect(checkCondition(c)).toEqual([]);
    for (const c of [{ can_promote: '8' }, { can_promote: 8.5 }, { resonance_gte: -1 }, { resonance_gte: 1.5 }, { collapse_lte: 'x' }, { collapse_gte: null }, { collapse_gte: -3 }]) {
      expect(checkCondition(c).length, JSON.stringify(c)).toBeGreaterThan(0);
    }
  });

  it('resonance_gte 用目前階位期間的共鳴合計', () => {
    expect(evalCondition({ resonance_gte: 13 }, base())).toBe(true);
    expect(evalCondition({ resonance_gte: 14 }, base())).toBe(false);
  });

  it('collapse_lte／collapse_gte', () => {
    expect(evalCondition({ collapse_lte: 10 }, base())).toBe(true);
    expect(evalCondition({ collapse_lte: 9 }, base())).toBe(false);
    expect(evalCondition({ collapse_gte: 10 }, base())).toBe(true);
    expect(evalCondition({ collapse_gte: 11 }, base())).toBe(false);
    expect(evalCondition({ collapse_gte: 0 }, { })).toBe(true); // 沒有 collapse 當 0
  });

  it('can_promote：目前階位是 n＋1、同譜系有階位 n、材料齊全', () => {
    const d = data();
    expect(evalCondition({ can_promote: 8 }, base(), d)).toBe(true);
    expect(evalCondition({ can_promote: 8 }, base({ items: { echo_moss: 1, choir_wax: 1 } }), d)).toBe(false); // 材料不足
    expect(evalCondition({ can_promote: 8 }, base({ items: { echo_moss: 2 } }), d)).toBe(false);
    expect(evalCondition({ can_promote: 8 }, base({ lineage: { id: 'trace', rank: 8 } }), d)).toBe(false); // 已經是 8
    expect(evalCondition({ can_promote: 7 }, base(), d)).toBe(false); // 跳階
    expect(evalCondition({ can_promote: 8 }, base({ lineage: null }), d)).toBe(false);
    expect(evalCondition({ can_promote: 6 }, base({ lineage: { id: 'trace', rank: 7 } }), d)).toBe(false); // 沒有開放的階位
    // 共鳴不足不影響 can_promote（可以硬喝）
    expect(evalCondition({ can_promote: 8 }, base({ resonance: {} }), d)).toBe(true);
  });

  it('can_promote 沒有提供 data 時丟出明確錯誤（不可當成成立或不成立）', () => {
    expect(() => evalCondition({ can_promote: 8 }, base())).toThrow(/can_promote.*data/);
    expect(() => evalCondition({ any: [{ flag: 'x' }, { can_promote: 8 }] }, base())).toThrow(/data/);
  });
});

describe('效果：promote', () => {
  it('寫法檢查：{ lineage, rank }，rank 整數', () => {
    expect(checkEffect(PROMOTE8)).toEqual([]);
    for (const e of [{ promote: { lineage: 'trace' } }, { promote: { rank: 8 } }, { promote: { lineage: 'trace', rank: '8' } },
      { promote: { lineage: '', rank: 8 } }, { promote: { lineage: 'trace', rank: 8, extra: 1 } }, { promote: true }]) {
      expect(checkEffect(e).length, JSON.stringify(e)).toBeGreaterThan(0);
    }
  });

  it('共鳴足夠：晉升、消耗材料、共鳴歸零、記錄 promotions（forced false）、崩解不變', () => {
    const s0 = base({ resonance: { lie_exposed: 12 } });
    const s = applyEffect(PROMOTE8, s0, data());
    expect(s.lineage).toEqual({ id: 'trace', rank: 8 });
    expect(s.items).toEqual({});
    expect(s.resonance).toEqual({});
    expect(s.collapse).toBe(10);
    expect(s.promotions).toEqual([{ lineage: 'trace', rank: 8, forced: false, chapter: 'chapter4' }]);
    expect(s.pending).toEqual([{ type: 'promoted', lineage: 'trace', rank: 8, forced: false }]); // M5 整合：晉升演出用
    // 不修改輸入
    expect(s0.items).toEqual({ echo_moss: 2, choir_wax: 1 });
    expect(s0.lineage).toEqual({ id: 'trace', rank: 9 });
  });

  it('共鳴不足：仍晉升，但崩解增加 forced_collapse（夾在 100），forced true', () => {
    const s = applyEffect(PROMOTE8, base(), data()); // 共鳴 13 ≥ 12 → 正常
    expect(s.promotions[0].forced).toBe(false);
    const f = applyEffect(PROMOTE8, base({ resonance: { a: 11 } }), data());
    expect(f.lineage.rank).toBe(8);
    expect(f.collapse).toBe(50);
    expect(f.promotions).toEqual([{ lineage: 'trace', rank: 8, forced: true, chapter: 'chapter4' }]);
    expect(f.resonance).toEqual({});
    const g = applyEffect(PROMOTE8, base({ resonance: {}, collapse: 80 }), data());
    expect(g.collapse).toBe(100);
  });

  it('材料多於所需時只扣所需數量', () => {
    const s = applyEffect(PROMOTE8, base({ items: { echo_moss: 5, choir_wax: 1, other: 2 } }), data());
    expect(s.items).toEqual({ echo_moss: 3, other: 2 });
  });

  it('材料不足：效果不執行（state 其餘不變），pending 加入 promote_failed（含缺少的材料）', () => {
    const s0 = base({ items: { echo_moss: 1 }, pending: [{ type: 'battle', encounter: 'enc_x' }] });
    const s = applyEffect(PROMOTE8, s0, data());
    expect(s.lineage).toEqual({ id: 'trace', rank: 9 });
    expect(s.items).toEqual({ echo_moss: 1 });
    expect(s.resonance).toEqual(s0.resonance);
    expect(s.promotions).toEqual([]);
    expect(s.pending).toEqual([
      { type: 'battle', encounter: 'enc_x' },
      { type: 'promote_failed', promote_failed: 'materials', lineage: 'trace', rank: 8,
        missing: [{ item: 'echo_moss', have: 1, need: 2 }, { item: 'choir_wax', have: 0, need: 1 }] },
    ]);
  });

  it('不是下一階（跳階、已晉升、沒有譜系、不同譜系）：不執行，pending 記原因 rank／lineage', () => {
    const d = data();
    const jump = applyEffect({ promote: { lineage: 'trace', rank: 7 } }, base(), d);
    expect(jump.lineage.rank).toBe(9);
    expect(takePending(jump).pending).toEqual([{ type: 'promote_failed', promote_failed: 'rank', lineage: 'trace', rank: 7, missing: [] }]);
    const again = applyEffect(PROMOTE8, base({ lineage: { id: 'trace', rank: 8 } }), d);
    expect(again.lineage.rank).toBe(8);
    expect(takePending(again).pending[0].promote_failed).toBe('rank');
    const none = applyEffect(PROMOTE8, base({ lineage: null }), d);
    expect(none.lineage).toBeNull();
    expect(takePending(none).pending[0].promote_failed).toBe('lineage');
    const other = applyEffect(PROMOTE8, base({ lineage: { id: 'watch', rank: 9 } }), d);
    expect(takePending(other).pending[0].promote_failed).toBe('lineage');
  });

  it('沒有 promotions 欄位的舊 state 也能晉升（補成陣列）', () => {
    const { promotions, ...old } = base();
    expect(applyEffect(PROMOTE8, old, data()).promotions).toHaveLength(1);
  });

  it('沒有提供 data → 丟出明確錯誤', () => {
    expect(() => applyEffect(PROMOTE8, base())).toThrow(/promote.*data/);
  });

  it('找不到目標階位（資料錯誤）→ 丟錯', () => {
    expect(() => applyEffect({ promote: { lineage: 'trace', rank: 6 } }, base({ lineage: { id: 'trace', rank: 7 } }), data())).toThrow(/階位/);
    expect(() => applyEffect({ promote: { lineage: 'ghost', rank: 8 } }, base({ lineage: { id: 'ghost', rank: 9 } }), data())).toThrow(/譜系/);
  });

  it('連續兩次晉升：9→8→7，共鳴各自重新累積', () => {
    const d = data();
    let s = applyEffect(PROMOTE8, base({ items: { echo_moss: 3, choir_wax: 1 }, resonance: { a: 12 } }), d);
    s = applyEffect({ resonance: 'x' }, s);
    s = applyEffect({ promote: { lineage: 'trace', rank: 7 } }, { ...s, chapter: 'chapter7' }, d);
    expect(s.lineage.rank).toBe(7);
    expect(s.promotions).toEqual([
      { lineage: 'trace', rank: 8, forced: false, chapter: 'chapter4' },
      { lineage: 'trace', rank: 7, forced: true, chapter: 'chapter7' },
    ]);
    expect(s.collapse).toBe(40);
  });

  it('晉升後能力值、技能、探索標籤依新階位計算', () => {
    const d = data();
    const before = base();
    const after = applyEffect(PROMOTE8, before, d);
    expect(deriveStats('hero', before, d).hp).toBe(60);
    expect(deriveStats('hero', after, d).hp).toBe(65);
    expect(deriveStats('hero', after, d).will).toBe(11);
    expect(availableSkills('hero', after, d)).toEqual(['attack', 'omen', 'whisper']);
    expect(availableFieldTags(after, d)).toEqual(['trace', 'voice']);
  });

  it('applyEffects 會把 data 傳給每一個效果', () => {
    const s = applyEffects([{ set_flag: 'drank' }, PROMOTE8], base(), data());
    expect(s.flags.drank).toBe(true);
    expect(s.lineage.rank).toBe(8);
  });

  it('道具的 field_effects 也可以用 promote（useFieldItem 帶 data）', () => {
    const s = useFieldItem('tonic', base({ items: { tonic: 1, echo_moss: 2, choir_wax: 1 } }), data());
    expect(s.lineage.rank).toBe(8);
    expect(s.items).toEqual({});
  });
});

describe('對話：startDialogue(dlg, state, data) 把 data 交給條件與效果', () => {
  const dlg = {
    id: 'dlg_drink', start: 'ask', nodes: [
      { id: 'ask', text: '要喝下靈劑嗎？', choices: [
        { text: '喝下', if: { can_promote: 8 }, effects: [PROMOTE8], next: 'check' },
        { text: '還不要', next: 'END' },
      ] },
      { id: 'check', branches: [{ if: { rank_lte: 8 }, next: 'ok' }], next: 'fail' },
      { id: 'ok', text: '聲音湧進來了。', next: 'END' },
      { id: 'fail', text: '什麼也沒發生。', next: 'END' },
    ],
  };

  it('can_promote 成立時看得到選項，喝下後分歧到 ok', () => {
    const r = startDialogue(dlg, base(), data());
    expect(r.current().choices.map((c) => c.text)).toEqual(['喝下', '還不要']);
    r.choose(0);
    expect(r.current().text).toBe('聲音湧進來了。');
    expect(r.state.lineage.rank).toBe(8);
  });

  it('材料不足時選項不出現', () => {
    const r = startDialogue(dlg, base({ items: {} }), data());
    expect(r.current().choices.map((c) => c.text)).toEqual(['還不要']);
  });

  it('舊呼叫方式（不帶 data）照舊可用；用到 can_promote 時丟出明確錯誤', () => {
    const plain = { id: 'd', start: 'n', nodes: [{ id: 'n', text: '嗨', effects: [{ set_flag: 'a' }], next: 'END' }] };
    expect(startDialogue(plain, base()).state.flags.a).toBe(true);
    expect(() => startDialogue(dlg, base()).current()).toThrow(/data/);
  });
});

describe('promotionStatus(state, data)：給晉升畫面用', () => {
  it('材料、共鳴、可否晉升、是否會硬喝', () => {
    const st = promotionStatus(base({ items: { echo_moss: 1, choir_wax: 3 } }), data());
    expect(st).toEqual({
      next: { lineage: 'trace', rank: 8, name: '借聲者' },
      materials: [{ item: 'echo_moss', name: '回聲苔', have: 1, need: 2 }, { item: 'choir_wax', name: '唱詩蠟', have: 3, need: 1 }],
      resonance: { have: 13, need: 12 },
      canPromote: false,
      forced: false,
      forcedCollapse: 40,
    });
  });

  it('材料齊、共鳴不足 → canPromote true、forced true', () => {
    const st = promotionStatus(base({ resonance: { a: 3 } }), data());
    expect(st.canPromote).toBe(true);
    expect(st.forced).toBe(true);
    expect(st.resonance).toEqual({ have: 3, need: 12 });
  });

  it('沒有譜系、或已經是最高開放階位 → next null', () => {
    for (const s of [base({ lineage: null }), base({ lineage: { id: 'trace', rank: 7 } }), base({ lineage: { id: 'ghost', rank: 9 } })]) {
      expect(promotionStatus(s, data())).toEqual({ next: null, materials: [], resonance: { have: 13, need: 0 }, canPromote: false, forced: false, forcedCollapse: 0 });
    }
  });

  it('下一階沒有 potion → 不需要材料、共鳴門檻 0', () => {
    const d = data();
    delete d.lineages[0].ranks[1].potion;
    const st = promotionStatus(base({ items: {} }), d);
    expect(st).toMatchObject({ next: { rank: 8 }, materials: [], resonance: { have: 13, need: 0 }, canPromote: true, forced: false, forcedCollapse: 0 });
  });

  it('和 promote 效果一致：canPromote 為 true 時 promote 一定成功；forced 與紀錄一致', () => {
    const d = data();
    for (const s of [base(), base({ resonance: {} }), base({ items: { echo_moss: 2 } }), base({ items: {} })]) {
      const st = promotionStatus(s, d);
      const after = applyEffect(PROMOTE8, s, d);
      expect(after.lineage.rank === 8).toBe(st.canPromote);
      if (st.canPromote) expect(after.promotions.at(-1).forced).toBe(st.forced);
      expect(evalCondition({ can_promote: 8 }, s, d)).toBe(st.canPromote);
    }
  });
});
