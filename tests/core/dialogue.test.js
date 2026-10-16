import { describe, it, expect } from 'vitest';
import { startDialogue, MAX_AUTO_STEPS } from '../../web/src/core/dialogue.js';

const st = (over = {}) => ({
  player: { name: '艾琳' }, flags: {}, items: {}, echo: { charges: 1 }, collapse: 0,
  resonance: {}, chapter_done: [], lineage: null, ...over,
});
const dlg = (nodes, start = nodes[0].id) => ({ id: 'dlg_t', start, nodes });

describe('對話執行器：基本流程', () => {
  it('依 next 前進、代入名字、到 END 結束', () => {
    const r = startDialogue(dlg([
      { id: 'n1', speaker: null, text: '桌上有一個空藥瓶。', next: 'n2' },
      { id: 'n2', speaker: '{name}', text: '{name}喝的？', next: 'END' },
    ]), st());
    expect(r.current()).toEqual({ id: 'n1', speaker: null, text: '桌上有一個空藥瓶。', choices: null });
    expect(r.done).toBe(false);
    r.advance();
    expect(r.current()).toMatchObject({ speaker: '艾琳', text: '艾琳喝的？' });
    r.advance();
    expect(r.done).toBe(true);
    expect(r.current()).toBeNull();
  });
  it('沒寫 speaker 視為旁白 null', () => {
    const r = startDialogue(dlg([{ id: 'n1', text: 'x', next: 'END' }]), st());
    expect(r.current().speaker).toBeNull();
  });
  it('進入節點時套用 effects，且不修改原始 state', () => {
    const s0 = st();
    const r = startDialogue(dlg([{ id: 'n1', text: 'x', effects: [{ set_flag: 'saw' }], next: 'END' }]), s0);
    expect(r.state.flags.saw).toBe(true);
    expect(s0.flags.saw).toBeUndefined();
  });
  it('結束後再 advance／choose 丟錯', () => {
    const r = startDialogue(dlg([{ id: 'n1', text: 'x', next: 'END' }]), st());
    r.advance();
    expect(() => r.advance()).toThrow(/結束/);
    expect(() => r.choose(0)).toThrow(/結束/);
  });
  it('dlg 不存在或 start 節點不存在 → 丟錯', () => {
    expect(() => startDialogue(null, st())).toThrow();
    expect(() => startDialogue({ id: 'd', start: 'nope', nodes: [] }, st())).toThrow(/nope/);
  });
  it('next 指向不存在的節點 → 丟錯', () => {
    const r = startDialogue(dlg([{ id: 'n1', text: 'x', next: 'ghost' }]), st());
    expect(() => r.advance()).toThrow(/ghost/);
  });
});

describe('選項', () => {
  const choiceDlg = () => dlg([
    { id: 'n3', text: '要怎麼回答，{name}？', choices: [
      { text: '說實話', next: 'n4', effects: [{ set_flag: 'told_truth' }] },
      { text: '看穿她', if: { echo_gte: 1 }, next: 'n5', effects: [{ use_echo: true }] },
    ] },
    { id: 'n4', text: '你說了實話。', next: 'END' },
    { id: 'n5', text: '你看穿了她。', next: 'END' },
  ]);
  it('只顯示 if 成立的選項', () => {
    expect(startDialogue(choiceDlg(), st()).current().choices).toEqual([{ index: 0, text: '說實話' }, { index: 1, text: '看穿她' }]);
    const r = startDialogue(choiceDlg(), st({ echo: { charges: 0 } }));
    expect(r.current().choices).toEqual([{ index: 0, text: '說實話' }]);
    expect(r.current().text).toBe('要怎麼回答，艾琳？');
  });
  it('choose 依「可見選項」的索引，套用選項效果後前進', () => {
    const r = startDialogue(choiceDlg(), st());
    r.choose(1);
    expect(r.state.echo.charges).toBe(0);
    expect(r.state.collapse).toBe(5);
    expect(r.current().text).toBe('你看穿了她。');
  });
  it('選項節點不能 advance；非選項節點不能 choose；索引越界丟錯', () => {
    const r = startDialogue(choiceDlg(), st({ echo: { charges: 0 } }));
    expect(() => r.advance()).toThrow(/選項/);
    expect(() => r.choose(1)).toThrow(/索引/);
    expect(() => r.choose(-1)).toThrow();
    r.choose(0);
    expect(r.state.flags.told_truth).toBe(true);
    expect(() => r.choose(0)).toThrow(/選項/);
  });
  it('選項節點沒有 text 仍要顯示（不能自動跳過）', () => {
    const r = startDialogue(dlg([{ id: 'c', choices: [{ text: '走', next: 'END' }] }]), st());
    expect(r.current()).toEqual({ id: 'c', speaker: null, text: null, choices: [{ index: 0, text: '走' }] });
  });
});

describe('branches 與純分歧節點', () => {
  const branchDlg = () => dlg([
    { id: 'gate', branches: [{ if: { flag: 'got_key' }, next: 'again' }], next: 'first' },
    { id: 'first', text: '你撿起鑰匙。', effects: [{ give_item: 'key' }, { set_flag: 'got_key' }], next: 'END' },
    { id: 'again', text: '這裡什麼都沒有了。', next: 'END' },
  ]);
  it('純分歧節點自動跳過、不顯示', () => {
    const r = startDialogue(branchDlg(), st());
    expect(r.current().id).toBe('first');
    r.advance();
    expect(r.state.items.key).toBe(1);
    const r2 = startDialogue(branchDlg(), r.state);
    expect(r2.current().id).toBe('again');
    r2.advance();
    expect(r2.state.items.key).toBe(1);
  });
  it('有文字的節點：文字與效果處理完後才依序檢查 branches，第一個成立的勝出', () => {
    const r = startDialogue(dlg([
      { id: 'n1', text: 'x', effects: [{ set_flag: 'b' }], branches: [
        { if: { flag: 'a' }, next: 'na' }, { if: { flag: 'b' }, next: 'nb' }, { if: { flag: 'b' }, next: 'na' },
      ], next: 'nz' },
      { id: 'na', text: 'A', next: 'END' }, { id: 'nb', text: 'B', next: 'END' }, { id: 'nz', text: 'Z', next: 'END' },
    ]), st());
    r.advance();
    expect(r.current().id).toBe('nb');
  });
  it('純分歧節點的 effects 也會套用', () => {
    const r = startDialogue(dlg([
      { id: 'p', effects: [{ set_flag: 'x' }], next: 'q' },
      { id: 'q', text: 'q', next: 'END' },
    ]), st());
    expect(r.state.flags.x).toBe(true);
    expect(r.current().id).toBe('q');
  });
  it('整段都是純分歧時，開始即結束', () => {
    const r = startDialogue(dlg([{ id: 'p', effects: [{ set_flag: 'x' }], next: 'END' }]), st());
    expect(r.done).toBe(true);
    expect(r.state.flags.x).toBe(true);
  });
  it('純分歧節點連續超過 100 次就丟錯（防無窮迴圈）', () => {
    expect(MAX_AUTO_STEPS).toBe(100);
    expect(() => startDialogue(dlg([
      { id: 'a', next: 'b' }, { id: 'b', branches: [{ if: { flag: 'never' }, next: 'END' }], next: 'a' },
    ]), st())).toThrow(/100/);
  });
  it('100 次以內的純分歧鏈可以通過', () => {
    const nodes = [];
    for (let i = 0; i < 100; i++) nodes.push({ id: `p${i}`, next: i === 99 ? 't' : `p${i + 1}` });
    nodes.push({ id: 't', text: 'ok', next: 'END' });
    expect(startDialogue(dlg(nodes), st()).current().id).toBe('t');
  });
  it('未知條件寫法在 branches 裡也會丟錯', () => {
    expect(() => startDialogue(dlg([{ id: 'p', branches: [{ if: { bogus: 1 }, next: 'END' }], next: 'END' }]), st())).toThrow();
  });
});
