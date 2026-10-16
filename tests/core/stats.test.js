import { describe, it, expect } from 'vitest';
import { deriveStats, availableSkills, characterLineage, partyStatus, STAT_KEYS, HERO_ID } from '../../web/src/core/stats.js';
import { battleData, battleState } from './battle/fixture.js';

const data = battleData();

describe('deriveStats（基礎＋已達到的所有階位成長）', () => {
  it('常數', () => {
    expect(STAT_KEYS).toEqual(['hp', 'sp', 'atk', 'def', 'spd', 'will', 'eva']);
    expect(HERO_ID).toBe('hero');
  });
  it('序章主角（沒有譜系）＝基礎值', () => {
    expect(deriveStats('hero', battleState(), data)).toEqual({ hp: 60, sp: 20, atk: 10, def: 6, spd: 10, will: 10, eva: 5 });
  });
  it('喝下讀痕者（9 階）後加上 9 階成長', () => {
    const s = battleState({ lineage: { id: 'trace', rank: 9 } });
    expect(deriveStats('hero', s, data)).toEqual({ hp: 70, sp: 30, atk: 10, def: 6, spd: 10, will: 14, eva: 5 });
  });
  it('8 階＝9 階＋8 階成長的加總', () => {
    const s = battleState({ lineage: { id: 'trace', rank: 8 } });
    expect(deriveStats('hero', s, data)).toMatchObject({ hp: 70, sp: 30, atk: 12, will: 14 });
  });
  it('隊友的譜系固定寫在 characters.json，不看 state.lineage', () => {
    const s = battleState({ lineage: { id: 'trace', rank: 8 } });
    expect(deriveStats('ada', s, data)).toEqual({ hp: 50, sp: 35, atk: 7, def: 5, spd: 12, will: 16, eva: 5 });
    expect(deriveStats('herb', s, data)).toEqual({ hp: 40, sp: 10, atk: 6, def: 4, spd: 8, will: 8, eva: 0 });
  });
  it('不修改資料；回傳新物件', () => {
    const before = JSON.stringify(data);
    const st = deriveStats('hero', battleState({ lineage: { id: 'trace', rank: 9 } }), data);
    st.hp = 999;
    expect(JSON.stringify(data)).toBe(before);
  });
  it('未知角色丟錯；主角沒有寫在 characters.json 時以 0 為基礎（序章資料沒有 characters.json）', () => {
    expect(() => deriveStats('ghost', battleState(), data)).toThrow(/ghost/);
    expect(() => deriveStats('toString', battleState(), data)).toThrow(/toString/);
    expect(deriveStats('hero', battleState({ lineage: { id: 'trace', rank: 9 } }), { lineages: data.lineages }))
      .toEqual({ hp: 10, sp: 10, atk: 0, def: 0, spd: 0, will: 4, eva: 0 });
  });
  it('未知譜系不加成長（不丟錯）', () => {
    expect(deriveStats('hero', battleState({ lineage: { id: 'ghost', rank: 9 } }), data).hp).toBe(60);
  });
});

describe('characterLineage', () => {
  it('主角來自 state.lineage，隊友來自 characters.json', () => {
    expect(characterLineage('hero', battleState(), data)).toBe(null);
    expect(characterLineage('hero', battleState({ lineage: { id: 'trace', rank: 9 } }), data)).toEqual({ id: 'trace', rank: 9 });
    expect(characterLineage('ada', battleState(), data)).toEqual({ id: 'dream', rank: 8 });
    expect(characterLineage('herb', battleState(), data)).toBe(null);
  });
});

describe('availableSkills（共通技能 ∪ 譜系已達到階位的技能）', () => {
  it('序章主角只有共通技能', () => {
    expect(availableSkills('hero', battleState(), data)).toEqual(['attack', 'guard', 'shoot']);
  });
  it('讀痕者 9 階多了預兆；8 階再多深擊（依階位取得順序、不重複）', () => {
    expect(availableSkills('hero', battleState({ lineage: { id: 'trace', rank: 9 } }), data)).toEqual(['attack', 'guard', 'shoot', 'omen']);
    expect(availableSkills('hero', battleState({ lineage: { id: 'trace', rank: 8 } }), data)).toEqual(['attack', 'guard', 'shoot', 'omen', 'deep']);
  });
  it('隊友的技能來自自己的譜系', () => {
    expect(availableSkills('ada', battleState(), data)).toEqual(['attack', 'guard', 'lull', 'mend']);
  });
  it('未知角色丟錯', () => {
    expect(() => availableSkills('ghost', battleState(), data)).toThrow(/ghost/);
  });
});

describe('partyStatus（畫面用：隊伍目前值與上限，null＝滿值）', () => {
  it('null 解析為上限；名字代入主角名', () => {
    const s = battleState({ party: [{ id: 'hero', hp: null, sp: 3 }, { id: 'ada', hp: 20, sp: null }] });
    expect(partyStatus(s, data)).toEqual([
      { id: 'hero', name: '艾琳', hp: 60, sp: 3, max: deriveStats('hero', s, data) },
      { id: 'ada', name: '艾妲・費恩', hp: 20, sp: 35, max: deriveStats('ada', s, data) },
    ]);
  });
  it('目前值超過上限時夾到上限；沒有 party 回空陣列', () => {
    expect(partyStatus(battleState({ party: [{ id: 'hero', hp: 999, sp: 999 }] }), data)[0]).toMatchObject({ hp: 60, sp: 20 });
    expect(partyStatus({ ...battleState(), party: undefined }, data)).toEqual([]);
  });
});
