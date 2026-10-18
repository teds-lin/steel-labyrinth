// M5 結局：resolve_ending 效果、resolveEnding(state, data)、state.ending。
import { describe, it, expect } from 'vitest';
import { applyEffect, checkEffect, takePending } from '../../web/src/core/effects.js';
import { resolveEnding, endingsOf } from '../../web/src/core/ending.js';
import { newGame } from '../../web/src/core/state.js';

const ENDINGS = [
  { id: 'lamp_kept', title: '燈火未熄', if: { all: [{ flag: 'trusted_marlo' }, { collapse_lte: 40 }] }, dialogue: 'dlg_end_a' },
  { id: 'fog_walker', title: '霧中行者', if: { collapse_gte: 70 }, dialogue: 'dlg_end_c' },
  { id: 'dawn', title: '黎明之前', dialogue: 'dlg_end_b' },
];
const data = () => ({
  lineages: [],
  story: [
    { id: 'chapter7', title: '第七章', dialogues: [] },
    { id: 'finale', title: '終章', endings: ENDINGS, dialogues: [] },
  ],
});
const base = (over = {}) => ({ flags: {}, collapse: 30, chapter: 'finale', ending: null, pending: null, ...over });

describe('resolve_ending 效果', () => {
  it('只接受 true；寫進 pending（畫面在對話結束後判定並播結局對話）', () => {
    expect(checkEffect({ resolve_ending: true })).toEqual([]);
    for (const v of [false, 'finale', 1, {}]) expect(checkEffect({ resolve_ending: v }).length).toBeGreaterThan(0);
    const s = applyEffect({ resolve_ending: true }, base());
    expect(takePending(s).pending).toEqual([{ type: 'resolve_ending' }]);
    expect(s.ending).toBeNull(); // 判定在 resolveEnding 才做（用對話結束時的 state）
  });
});

describe('resolveEnding(state, data)', () => {
  it('依序比對，第一個成立的就是結局；回傳結局資訊並寫入 state.ending', () => {
    const r = resolveEnding(base({ flags: { trusted_marlo: true } }), data());
    expect(r.ending).toEqual({ id: 'lamp_kept', title: '燈火未熄', dialogue: 'dlg_end_a' });
    expect(r.state.ending).toBe('lamp_kept');
  });

  it('前面都不成立 → 下一個；最後一筆無條件', () => {
    expect(resolveEnding(base({ flags: { trusted_marlo: true }, collapse: 80 }), data()).ending.id).toBe('fog_walker');
    expect(resolveEnding(base({ collapse: 50 }), data()).ending.id).toBe('dawn');
  });

  it('不修改輸入', () => {
    const s0 = base();
    resolveEnding(s0, data());
    expect(s0.ending).toBeNull();
  });

  it('state.chapter 沒有 endings 時，用唯一一個有 endings 的章節', () => {
    expect(resolveEnding(base({ chapter: 'chapter7' }), data()).ending.id).toBe('dawn');
    expect(resolveEnding(base({ chapter: null }), data()).ending.id).toBe('dawn');
  });

  it('可以用 opts.chapter 指定章節；指定的章節沒有 endings → 丟錯', () => {
    expect(resolveEnding(base(), data(), { chapter: 'finale' }).ending.id).toBe('dawn');
    expect(() => resolveEnding(base(), data(), { chapter: 'chapter7' })).toThrow(/endings/);
  });

  it('沒有任何章節有 endings、或有多個而 state.chapter 無法決定 → 丟錯', () => {
    expect(() => resolveEnding(base(), { story: [{ id: 'finale' }] })).toThrow(/endings/);
    const two = data();
    two.story.push({ id: 'finale2', endings: [{ id: 'x', title: 'X', dialogue: 'd' }] });
    expect(() => resolveEnding(base({ chapter: 'chapter7' }), two)).toThrow(/多個/);
    expect(resolveEnding(base({ chapter: 'finale2' }), two).ending.id).toBe('x');
  });

  it('全部都不成立（資料錯誤：最後一筆有 if）→ 丟錯', () => {
    const d = data();
    d.story[1].endings = [ENDINGS[0]];
    expect(() => resolveEnding(base(), d)).toThrow(/沒有成立的結局/);
  });

  it('endingsOf 回傳該章的 endings 陣列（找不到回空陣列）', () => {
    expect(endingsOf('finale', data()).map((e) => e.id)).toEqual(['lamp_kept', 'fog_walker', 'dawn']);
    expect(endingsOf('chapter7', data())).toEqual([]);
  });
});

describe('state.ending／promotions 的初始值', () => {
  it('newGame 帶 ending null、promotions []', () => {
    const s = newGame({ name: '雷恩', manifest: { chapters: ['prologue'], start: { map: 'attic', spawn: 'd' } } });
    expect(s.ending).toBeNull();
    expect(s.promotions).toEqual([]);
  });
});
