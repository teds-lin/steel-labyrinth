// M5 平衡模擬（P8）：照劇情從新遊戲一路走到第七章，每遇到一場戰鬥就用當下的戰前狀態打 N 次（固定種子），
// 再把「最差四分位」的戰後狀態接回劇情（方法同 tests/lib/balance.js 的 runChain，見 tests/balance.test.js 頂端註解）。
import { simulate, finishBattle } from '../../web/src/core/battle/engine.js';
import { runEncounter, worstQuartileState, SEED_BASE } from './balance.js';
import {
  Sim, playPrologue, playChapter1, playChapter2, playChapter3, playChapter4, playChapter5, playChapter6, playChapter7,
} from './sim.js';

/**
 * 平衡用的路線（保守）：序章殘響線（崩解 +10）、第二章對妻子隱瞞（+3）、第四章不入夢（不在鐘塔回復）、
 * 第六章借卡爾的聲音（+4）、不入夢。team：'marlo'（第六章照實陳述 → 第七章主角＋艾妲＋馬洛）
 * 或 'herb'（簽下陳述舉報隊長 → 第七章主角＋老賀伯＋艾妲）。最後的潮兆戰選「摀住耳朵」（回應潮水的版本另外算）。
 */
export const M5_ROUTES = Object.freeze({
  marlo: { ch6: { statement: 'trust', owen: 'borrow', dream: false } },
  herb: { ch6: { statement: 'report', owen: 'borrow', dream: false } },
});

/**
 * 走完序章～第七章。回傳 { stats: Map encId → 統計, preStates: Map encId → 戰前狀態, sim }。
 * opts：seedBase、statesFrom（別條鏈的 preStates；給了就直接用它當戰前狀態）、team（'marlo'｜'herb'）。
 */
export function runChainM5(data, policy, n, opts = {}) {
  const stats = new Map();
  const preStates = new Map();
  const team = opts.team ?? 'marlo';
  const battle = (encId, state) => {
    const pre = opts.statesFrom?.get(encId) ?? state;
    preStates.set(encId, pre);
    const st = runEncounter(encId, pre, data, policy, n, opts.seedBase);
    stats.set(encId, st);
    const goOn = st.results.filter((r) => r.finish.next?.type !== 'retry');
    const ref = goOn.length ? goOn[0].finish : finishBattle({ ...simulate(encId, pre, data, SEED_BASE, policy).battle, outcome: 'victory' }, pre, data);
    const next = goOn.length ? worstQuartileState(goOn.map((r) => r.finish.state)) : ref.state;
    return { state: { ...next, pending: null }, outcome: goOn.length ? 'victory' : 'forced', next: ref.next };
  };
  const sim = new Sim(data, { battle });
  playPrologue(sim, 'echo');
  sim.continueChapter();
  playChapter1(sim);
  sim.continueChapter();
  playChapter2(sim, { wife: 'lie' });
  sim.continueChapter();
  playChapter3(sim);
  sim.continueChapter();
  playChapter4(sim, { dream: false });
  sim.continueChapter();
  playChapter5(sim);
  sim.continueChapter();
  playChapter6(sim, M5_ROUTES[team].ch6);
  sim.continueChapter();
  playChapter7(sim);
  if (!sim.state.chapter_done.includes('chapter7')) throw new Error('平衡模擬的路線沒有走到第七章完');
  return { stats, preStates, sim };
}
