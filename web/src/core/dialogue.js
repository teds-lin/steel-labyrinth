// 對話執行器（DATA-FORMAT「story」一節）。
// 進入節點 → 套用 effects → 有 text 或 choices 就停下來顯示；
// 純分歧節點（沒有 text 也沒有 choices）自動依 branches/next 前進，不顯示。
import { evalCondition } from './conditions.js';
import { applyEffects } from './effects.js';
import { fill } from './name.js';

export const END = 'END';
export const MAX_AUTO_STEPS = 100;

const hasText = (node) => node.text !== undefined && node.text !== null;
const isDisplayed = (node) => hasText(node) || Array.isArray(node.choices);

/**
 * 開始一段對話。回傳執行器；更新後的 state 由 runner.state 取得。
 * data（選填，M5）：遊戲資料 bundle，交給條件與效果（can_promote、promote 需要；沒有時用到它們會丟錯）。
 */
export function startDialogue(dlg, initialState, data) {
  if (!dlg || !Array.isArray(dlg.nodes)) throw new Error('對話不存在或格式錯誤');
  const nodes = new Map(dlg.nodes.map((n) => [n.id, n]));
  let state = initialState;
  let node = null; // 目前顯示中的節點；null 表示已結束
  let autoSteps = 0;

  const lookup = (id) => {
    const n = nodes.get(id);
    if (!n) throw new Error(`對話 ${dlg.id}：找不到節點「${id}」`);
    return n;
  };

  // 文字與效果處理完後：依序檢查 branches，第一個成立的勝出；否則走 next。
  const resolveNext = (n) => {
    for (const b of n.branches ?? []) {
      if (evalCondition(b.if, state, data)) return b.next;
    }
    return n.next;
  };

  const goTo = (id) => {
    let target = id;
    for (;;) {
      if (target === END) { node = null; return; }
      const n = lookup(target);
      state = applyEffects(n.effects, state, data);
      if (isDisplayed(n)) { node = n; autoSteps = 0; return; }
      autoSteps += 1;
      if (autoSteps > MAX_AUTO_STEPS) {
        throw new Error(`對話 ${dlg.id}：純分歧節點連續超過 ${MAX_AUTO_STEPS} 次，疑似無窮迴圈（最後在「${n.id}」）`);
      }
      target = resolveNext(n);
    }
  };

  const visibleChoices = (n) => (n.choices ?? [])
    .map((c, raw) => ({ c, raw }))
    .filter(({ c }) => c.if === undefined || evalCondition(c.if, state, data));

  const ensureActive = () => { if (!node) throw new Error(`對話 ${dlg.id} 已結束`); };

  const runner = {
    get state() { return state; },
    get done() { return node === null; },
    /** 目前要顯示的節點；已結束回 null。choices 只含可見選項，index 用於 choose()。 */
    current() {
      if (!node) return null;
      return {
        id: node.id,
        speaker: fill(node.speaker ?? null, state),
        text: hasText(node) ? fill(node.text, state) : null,
        choices: Array.isArray(node.choices)
          ? visibleChoices(node).map(({ c }, index) => ({ index, text: fill(c.text, state) }))
          : null,
      };
    },
    /** 一般節點：前往下一個。 */
    advance() {
      ensureActive();
      if (Array.isArray(node.choices)) throw new Error(`節點「${node.id}」有選項，請用 choose()`);
      goTo(resolveNext(node));
      return runner;
    },
    /** 選項節點：index 是 current().choices 的索引。 */
    choose(index) {
      ensureActive();
      if (!Array.isArray(node.choices)) throw new Error(`節點「${node.id}」沒有選項，請用 advance()`);
      const vis = visibleChoices(node);
      if (!Number.isInteger(index) || index < 0 || index >= vis.length) {
        throw new Error(`選項索引 ${index} 超出範圍（可見選項 ${vis.length} 個）`);
      }
      const { c } = vis[index];
      state = applyEffects(c.effects, state, data);
      goTo(c.next);
      return runner;
    },
  };

  if (!nodes.has(dlg.start)) throw new Error(`對話 ${dlg.id}：找不到起始節點「${dlg.start}」`);
  goTo(dlg.start);
  return runner;
}
