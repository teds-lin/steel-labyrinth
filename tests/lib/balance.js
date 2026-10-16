// 平衡模擬（B9）：照實際劇情走一遍，每遇到一場戰鬥就用同一個戰前狀態打 N 次（固定種子），
// 再把「最差四分位」的戰後狀態接回劇情，繼續走到下一場。詳細推算方式見 tests/balance.test.js 頂端註解。
import { simulate, finishBattle } from '../../web/src/core/battle/engine.js';
import { Sim, playPrologue, playChapter1, playChapter2 } from './sim.js';

export const SEED_BASE = 20261016;
/** 規格補充 2 後的 B9：多組種子基底（每組各自走一條劇情鏈），取平均並要求每組都在區間 ±5% 內。 */
export const SEED_BASES = Object.freeze([0, 1, 2, 3, 4].map((i) => SEED_BASE + i * 100003));

/** 「回合數」＝我方行動次數最多的那個人的行動次數（CTB 沒有整齊的回合，取玩家感受到的指令次數）。 */
export const roundsOf = (battle) => Math.max(...battle.units.filter((u) => u.side === 'party').map((u) => u.acted));

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

/**
 * 把多場戰後狀態合成一個「最差四分位」狀態：每位隊員的生命／靈性、子彈、每種道具數取第 25 百分位，崩解取第 75 百分位。
 * 其他欄位（旗標等劇情效果）每場都相同，取第一場的。
 */
export function worstQuartileState(states) {
  const first = states[0];
  const party = first.party.map((m, i) => ({
    id: m.id,
    hp: quantile(states.map((s) => s.party[i].hp), 0.25),
    sp: quantile(states.map((s) => s.party[i].sp), 0.25),
  }));
  const ids = [...new Set(states.flatMap((s) => Object.keys(s.items)))];
  const items = {};
  for (const id of ids) {
    const n = quantile(states.map((s) => s.items[id] ?? 0), 0.25);
    if (n > 0) items[id] = n;
  }
  return {
    ...first, party, items,
    ammo: quantile(states.map((s) => s.ammo), 0.25),
    collapse: quantile(states.map((s) => s.collapse), 0.75),
  };
}

/** 同一個戰前狀態打 n 場；回傳統計與每場結算。 */
export function runEncounter(encId, state, data, policy, n, seedBase = SEED_BASE) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const r = simulate(encId, state, data, seedBase + i, policy);
    results.push({ outcome: r.outcome, rounds: roundsOf(r.battle), collapse: r.battle.collapse, finish: finishBattle(r.battle, state, data) });
  }
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const avg = (f) => results.reduce((a, r) => a + f(r), 0) / n;
  return {
    encounter: encId, n,
    victory: count('victory') / n, defeat: count('defeat') / n, lostControl: count('lost_control') / n,
    avgRounds: avg((r) => r.rounds), maxRounds: Math.max(...results.map((r) => r.rounds)),
    avgCollapse: avg((r) => r.collapse),
    startCollapse: state.collapse,
    results,
  };
}

/**
 * 照劇情走到第二章完（序章 echo 路線、對妻子隱瞞：保守地多吃崩解），每場戰鬥打 n 次。
 * opts.statesFrom：別條鏈的 preStates（Map encId → state）；給了就直接用它當戰前狀態（亂按策略用）。
 * 回傳 { stats: Map encId → 統計, preStates: Map encId → 戰前狀態 }。
 */
export function runChain(data, policy, n, opts = {}) {
  const stats = new Map();
  const preStates = new Map();
  const battle = (encId, state) => {
    const pre = opts.statesFrom?.get(encId) ?? state;
    preStates.set(encId, pre);
    const st = runEncounter(encId, pre, data, policy, n, opts.seedBase);
    stats.set(encId, st);
    // 接回劇情：可以繼續劇情的結果（勝利；教學戰連敗北也算）合成最差四分位狀態。沒有任何一場可繼續時，用勝利的劇情效果硬接（只為了走完路線）。
    const goOn = st.results.filter((r) => r.finish.next?.type !== 'retry');
    const pool = goOn.length ? goOn : null;
    const ref = pool ? pool[0].finish : finishBattle({ ...simulate(encId, pre, data, SEED_BASE, policy).battle, outcome: 'victory' }, pre, data);
    const next = pool ? worstQuartileState(pool.map((r) => r.finish.state)) : ref.state;
    return { state: { ...next, pending: null }, outcome: pool ? 'victory' : 'forced', next: ref.next };
  };
  const sim = new Sim(data, { battle });
  playPrologue(sim, 'echo');
  sim.continueChapter();
  playChapter1(sim);
  sim.continueChapter();
  playChapter2(sim, { wife: 'lie' });
  if (!sim.state.chapter_done.includes('chapter2')) throw new Error('平衡模擬的路線沒有走到第二章完');
  return { stats, preStates, sim };
}
