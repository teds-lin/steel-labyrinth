// B9 平衡模擬：每場戰鬥 × 每種策略打 BALANCE_RUNS 次，檢查勝率、回合數與崩解。
// 規格補充 2 起改用多組種子基底（SEED_BASES，5 組；每組各自從序章走一條劇情鏈、每場打 N 次＝種子 基底＋0…N−1）：
// 勝率區間的斷言＝5 組的平均落在區間內，而且每一組都落在 [下限−5%, 上限+5%]（避免靠單一幸運種子過關）。
//
// ■ 戰前狀態怎麼推算（tests/lib/balance.js 的 runChain）
//   不手組狀態，而是用真實資料照劇情走一遍（tests/lib/sim.js：走地圖、播對話、處理 battle／goto）：
//   序章（殘響開門、對房東說謊後看穿：崩解 +10）→ end_screen.continue → 第一章（喝下靈劑：崩解 +5、
//   拿到左輪與 3 發子彈 → 教學戰）→ 補給（全隊回滿、子彈補到 9、繃帶×2、鎮靜香×1、艾妲入隊）→ 第二章
//   （工頭給鑰匙、對妻子隱瞞：崩解 +3、工寮補給箱繃帶×1＋子彈 3 發、線索用【回溯】）→ 過橋遭遇 enc_dock_1 → 拖痕
//   → 霧影 enc_dock_2 → 柱子 → 推理 → 倉庫：貨箱（繃帶、鎮靜香）→ enc_warehouse → 休息點（全隊回滿）→ enc_boss。
//   路線刻意選「保守」的一條：會加崩解的選項都選、碼頭小屋的爐子（回復點）在過橋前，過橋後不回頭，
//   所以 enc_dock_1 → enc_dock_2 → enc_warehouse 之間沒有回復；Boss 前有倉庫的休息點（生命靈性回滿，崩解不回）。
//   每遇到一場戰鬥：用當下的狀態打 N 場，再把「可以繼續劇情」的戰後狀態合成一個最差四分位狀態接回劇情：
//   每位隊員的生命／靈性、子彈、每種道具數取第 25 百分位，崩解取第 75 百分位（worstQuartileState）。
//   所以下一場的戰前狀態包含上一場的消耗（受傷、用掉的子彈與道具、累積的崩解、掉落的繃帶）。
//   每種策略各走一條自己的鏈（不用道具的策略，道具就一直留在背包裡）；亂按策略用合理策略那條鏈的戰前狀態。
//
// ■ 策略（tests/lib/policies.js）
//   smart        簡單合理策略：崩解 ≥ 40 艾妲鎮魂、≥ 55 鎮靜香；生命 < 40% 用繃帶；Boss 戰主角預兆＋開槍、
//                艾妲催眠；預兆看到重擊要打自己就防禦；一般戰只普攻（子彈留給 Boss）。← B9 的「合理策略」
//   noItemNoOmen 同上，但不用道具、不用預兆（Boss ≥ 30% 的下限）。
//   noOmen       合理策略但不用預兆（只在 Boss 戰前狀態上比較：預兆要有實質價值，至少多 5% 勝率）。
//   hypnosis     催眠單一策略：艾妲一有靈性就催眠 Boss，其餘普攻（睡眠受傷就醒，不該比合理策略強）。
//   smartNoHypnosis 合理策略但完全不催眠（規格補充 3 第 2 條：催眠要有正收益 → 合理策略 ≥ 它）。
//   hypnosisSmart   聰明催眠（審查者 hyp2.mjs）：有小怪時催眠 Boss、Boss 睡著時改打小怪。只用來檢查「最強策略」上限。
//   basic        engine 的 basicPolicy（普攻＋生命低時繃帶），只記錄（只跑第一組種子）。
//   mash         亂按：只用普攻、目標亂選，只記錄（只跑第一組種子；確認一般戰不會因為策略差就全滅）。
//
// ■ 額外的 Boss 情境（都用合理策略那條鏈的 Boss 戰前狀態）
//   窮途：子彈 0、沒有道具 → 合理策略 ≥ 40%。
//   重新挑戰：主角 30% 生命、艾妲 1 HP 進 Boss（只記錄）→ prepareRetry 後的狀態 → 合理策略 ≥ 60%。
//   最強策略上限（規格補充 3 第 2 條）：smart、smartNoHypnosis、hypnosisSmart、noOmen、hypnosis、basic、mash 在同一個
//   Boss 戰前狀態，加上 noItemNoOmen 自己那條鏈；每種策略 5 組種子平均的最大值 ≤ 90%，每一組 ≤ 95%。
//
// ■ 「回合數」＝我方行動次數最多的那個人的行動次數（roundsOf）。
// ■ 執行時間：（2 條鏈 × 5 組種子＋2 條鏈）× 5 場 × 200 次＋Boss 情境，約 10～15 秒（beforeAll 另給 180 秒）。
//   場數可用環境變數 BALANCE_RUNS 調整，CI 用預設的 200。
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../tools/lib/bundle.mjs';
import { deriveStats } from '../web/src/core/stats.js';
import { prepareRetry } from '../web/src/core/battle/engine.js';
import { runChain, runEncounter, SEED_BASES } from './lib/balance.js';
import {
  smartPolicy, noItemNoOmenPolicy, basicPolicy, mashPolicy, hypnosisPolicy, makeSmartPolicy, isBossEncounter,
  smartNoHypnosisPolicy, hypnosisSmartPolicy,
} from './lib/policies.js';

const DATA_DIR = fileURLToPath(new URL('../web/data/', import.meta.url));
const BALANCE_RUNS = Number(process.env.BALANCE_RUNS) || 200;
/** 每一組種子允許偏離區間的幅度。 */
const SLACK = 0.05;

const TUTORIAL = 'enc_sparring';
const NORMAL = ['enc_dock_1', 'enc_dock_2', 'enc_warehouse'];
const BOSS = 'enc_boss';
const ORDER = [TUTORIAL, ...NORMAL, BOSS];

let data;
/** chains[策略] = 每組種子基底一條鏈（basic／mash 只有第一組）。 */
const chains = {};
/** boss[情境] = 每組種子基底一個 runEncounter 統計。 */
const boss = {};
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const victories = (name, enc) => chains[name].map((c) => c.stats.get(enc).victory);
/** 平均在 [lo, hi]，每一組在 [lo−5%, hi+5%]。 */
function expectBand(values, lo, hi, label) {
  const msg = `${label}：各組 ${values.map(pct).join('、')}，平均 ${pct(avg(values))}`;
  expect(avg(values), msg).toBeGreaterThanOrEqual(lo);
  expect(avg(values), msg).toBeLessThanOrEqual(hi);
  for (const v of values) {
    expect(v, msg).toBeGreaterThanOrEqual(lo - SLACK);
    expect(v, msg).toBeLessThanOrEqual(hi + SLACK);
  }
}

beforeAll(() => {
  const { bundle, errors } = loadBundle(DATA_DIR);
  expect(errors).toEqual([]);
  data = bundle;
  chains.smart = SEED_BASES.map((seedBase) => runChain(data, smartPolicy, BALANCE_RUNS, { seedBase }));
  chains.noItemNoOmen = SEED_BASES.map((seedBase) => runChain(data, noItemNoOmenPolicy, BALANCE_RUNS, { seedBase }));
  chains.basic = [runChain(data, basicPolicy, BALANCE_RUNS, { seedBase: SEED_BASES[0] })];
  chains.mash = [runChain(data, mashPolicy, BALANCE_RUNS, { seedBase: SEED_BASES[0], statesFrom: chains.smart[0].preStates })];

  const noOmen = makeSmartPolicy({ useOmen: false });
  for (const k of ['smart', 'noOmen', 'hypnosis', 'smartNoHypnosis', 'hypnosisSmart', 'basic', 'mash', 'broke', 'lowHp', 'retry']) boss[k] = [];
  SEED_BASES.forEach((seedBase, i) => {
    const pre = chains.smart[i].preStates.get(BOSS);
    const run = (state, policy) => runEncounter(BOSS, state, data, policy, BALANCE_RUNS, seedBase);
    boss.smart.push(chains.smart[i].stats.get(BOSS));
    boss.noOmen.push(run(pre, noOmen));
    boss.hypnosis.push(run(pre, hypnosisPolicy));
    boss.smartNoHypnosis.push(run(pre, smartNoHypnosisPolicy));
    boss.hypnosisSmart.push(run(pre, hypnosisSmartPolicy));
    boss.basic.push(run(pre, basicPolicy));
    boss.mash.push(run(pre, mashPolicy));
    boss.broke.push(run({ ...pre, ammo: 0, items: {} }, smartPolicy));
    const low = { ...pre, party: pre.party.map((m) => ({ ...m, hp: m.id === 'hero' ? Math.round(deriveStats(m.id, pre, data).hp * 0.3) : 1 })) };
    boss.lowHp.push(run(low, smartPolicy));
    boss.retry.push(run(prepareRetry(low, data), smartPolicy));
  });

  const rows = [];
  for (const [name, list] of Object.entries(chains)) {
    for (const enc of ORDER) {
      const st = list.map((c) => c.stats.get(enc));
      const v = st.map((s) => s.victory);
      rows.push(`${name.padEnd(12)} ${enc.padEnd(14)} 勝 平均 ${pct(avg(v)).padStart(6)} 最差 ${pct(Math.min(...v)).padStart(6)}  失控 ${pct(avg(st.map((s) => s.lostControl))).padStart(5)}  回合 ${avg(st.map((s) => s.avgRounds)).toFixed(1).padStart(4)}（最多 ${Math.max(...st.map((s) => s.maxRounds))}）  崩解 ${st[0].startCollapse} → ${avg(st.map((s) => s.avgCollapse)).toFixed(1)}`);
    }
  }
  for (const [k, list] of Object.entries(boss)) {
    const v = list.map((s) => s.victory);
    rows.push(`Boss 情境 ${k.padEnd(9)} 勝 平均 ${pct(avg(v)).padStart(6)} 最差 ${pct(Math.min(...v)).padStart(6)}  各組 ${v.map(pct).join(' ')}`);
  }
  console.log(`B9 平衡模擬（每場 ${BALANCE_RUNS} 次 × ${SEED_BASES.length} 組種子）\n${rows.join('\n')}`);
}, 180_000);

describe('B9 戰前狀態照劇情推算', () => {
  it('路線依序遇到全部五場戰鬥，Boss 判定來自資料（不能逃、輸了要重來）', () => {
    for (const c of chains.smart) expect([...c.stats.keys()]).toEqual(ORDER);
    expect(ORDER.filter((e) => isBossEncounter(data, e))).toEqual([BOSS]);
  });

  it('教學戰：只有主角、已喝下靈劑、有子彈；第二章起艾妲在隊上', () => {
    const pre = chains.smart[0].preStates;
    expect(pre.get(TUTORIAL).party.map((m) => m.id)).toEqual(['hero']);
    expect(pre.get(TUTORIAL).lineage).toEqual({ id: 'trace', rank: 9 });
    expect(pre.get(TUTORIAL).ammo).toBeGreaterThan(0);
    for (const enc of [...NORMAL, BOSS]) expect(pre.get(enc).party.map((m) => m.id)).toEqual(['hero', 'ada']);
  });

  it('連續戰鬥之間的消耗有算進去：碼頭第二場、倉庫那場帶著前一場的傷，崩解一路累積；Boss 前休息點回滿生命', () => {
    const pre = chains.smart[0].preStates;
    const hpOf = (s) => s.party.map((m) => m.hp ?? deriveStats(m.id, s, data).hp);
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    expect(sum(hpOf(pre.get('enc_dock_2')))).toBeLessThan(sum(hpOf(pre.get('enc_dock_1'))));
    expect(sum(hpOf(pre.get('enc_warehouse')))).toBeLessThan(sum(hpOf(pre.get('enc_dock_1'))));
    expect(pre.get(BOSS).collapse).toBeGreaterThan(pre.get('enc_dock_1').collapse);
    const b = pre.get(BOSS);
    expect(hpOf(b)).toEqual(b.party.map((m) => deriveStats(m.id, b, data).hp));
  });

  it('固定種子可重現：同一個戰前狀態再打一次，結果完全相同', () => {
    const pre = chains.smart[0].preStates.get(BOSS);
    const a = runEncounter(BOSS, pre, data, smartPolicy, 20);
    const b = runEncounter(BOSS, pre, data, smartPolicy, 20);
    expect(b.results.map((r) => [r.outcome, r.rounds, r.collapse])).toEqual(a.results.map((r) => [r.outcome, r.rounds, r.collapse]));
  });

  it(`多組種子基底：${SEED_BASES.length} 組（≥ 5），各組的鏈各自推算`, () => {
    expect(SEED_BASES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(SEED_BASES).size).toBe(SEED_BASES.length);
  });
});

describe('B9 勝率區間（合理策略；多組種子平均，且每組 ±5%）', () => {
  for (const enc of NORMAL) {
    it(`${enc}：一般戰勝率 ≥ 95%`, () => {
      expectBand(victories('smart', enc), 0.95, 1, enc);
    });
  }
  it(`${BOSS}：Boss 勝率 60%～90%`, () => {
    expectBand(victories('smart', BOSS), 0.6, 0.9, 'smart Boss');
  });
  it(`${BOSS}：不用道具、不用預兆仍有 ≥ 30%`, () => {
    expectBand(victories('noItemNoOmen', BOSS), 0.3, 1, 'noItemNoOmen Boss');
  });
  it(`${BOSS}：子彈 0、沒有道具進 Boss，合理策略 ≥ 40%`, () => {
    expectBand(boss.broke.map((s) => s.victory), 0.4, 1, '子彈 0、沒有道具');
  });
  it(`${BOSS}：低血量進 Boss（主角 30%、艾妲 1 HP）→ prepareRetry 重新挑戰，合理策略 ≥ 60%`, () => {
    expectBand(boss.retry.map((s) => s.victory), 0.6, 1, '重新挑戰');
  });
});

describe('B9 策略價值（Boss 戰前狀態相同、種子相同）', () => {
  it('用預兆的合理策略勝率 ≥ 不用預兆的同策略 + 5%（預兆要有實質價值）', () => {
    const withOmen = avg(boss.smart.map((s) => s.victory));
    const without = avg(boss.noOmen.map((s) => s.victory));
    expect(withOmen, `用預兆 ${pct(withOmen)}，不用 ${pct(without)}`).toBeGreaterThanOrEqual(without + 0.05);
  });
  it('催眠要有正收益：合理策略勝率 ≥ 同策略但不催眠（5 組種子平均）', () => {
    const smart = avg(boss.smart.map((s) => s.victory));
    const noHyp = avg(boss.smartNoHypnosis.map((s) => s.victory));
    expect(smart, `合理 ${pct(smart)}，不催眠 ${pct(noHyp)}`).toBeGreaterThanOrEqual(noHyp);
  });
  it('所有我方策略中最好的 Boss 勝率 ≤ 90%（5 組種子平均），每組 ≤ 95%', () => {
    const all = {
      smart: boss.smart, smartNoHypnosis: boss.smartNoHypnosis, hypnosisSmart: boss.hypnosisSmart, noOmen: boss.noOmen,
      hypnosis: boss.hypnosis, basic: boss.basic, mash: boss.mash, noItemNoOmen: chains.noItemNoOmen.map((c) => c.stats.get(BOSS)),
    };
    const rows = Object.entries(all).map(([name, list]) => ({ name, v: list.map((s) => s.victory) }));
    const best = rows.reduce((a, b) => (avg(b.v) > avg(a.v) ? b : a));
    const msg = rows.map((r) => `${r.name} ${pct(avg(r.v))}（最高 ${pct(Math.max(...r.v))}）`).join('、');
    expect(avg(best.v), `最好的是 ${best.name}；${msg}`).toBeLessThanOrEqual(0.9);
    for (const r of rows) for (const v of r.v) expect(v, `${r.name} 單組 ${pct(v)}；${msg}`).toBeLessThanOrEqual(0.95);
  });
  it('催眠單一策略勝率 ≤ 合理策略', () => {
    const hyp = avg(boss.hypnosis.map((s) => s.victory));
    const smart = avg(boss.smart.map((s) => s.victory));
    expect(hyp, `催眠單一 ${pct(hyp)}，合理 ${pct(smart)}`).toBeLessThanOrEqual(smart);
  });
});

describe('教學戰（on_lose: continue）', () => {
  for (const name of ['smart', 'noItemNoOmen', 'basic', 'mash']) {
    it(`${name}：100% 打得完（勝或敗都繼續劇情），平均 ≤ 12 回合`, () => {
      for (const c of chains[name]) {
        const s = c.stats.get(TUTORIAL);
        for (const r of s.results) {
          expect(['victory', 'defeat']).toContain(r.outcome);
          expect(r.finish.next).toEqual({ type: 'dialogue', dialogue: data.encounters.find((e) => e.id === TUTORIAL).on_win.dialogue });
        }
        expect(s.avgRounds).toBeLessThanOrEqual(12);
      }
    });
  }
});

describe('回合數與崩解（合理策略、不用道具不用預兆；每組種子）', () => {
  for (const name of ['smart', 'noItemNoOmen']) {
    for (const enc of NORMAL) {
      it(`${name} ${enc}：平均 ≤ 8 回合`, () => {
        for (const c of chains[name]) expect(c.stats.get(enc).avgRounds).toBeLessThanOrEqual(8);
      });
    }
    it(`${name} ${BOSS}：平均 ≤ 20 回合；平均最終崩解 < 70；失控 < 15%`, () => {
      for (const c of chains[name]) {
        const s = c.stats.get(BOSS);
        expect(s.avgRounds).toBeLessThanOrEqual(20);
        expect(s.avgCollapse).toBeLessThan(70);
        expect(s.lostControl).toBeLessThan(0.15);
      }
    });
  }
});

describe('只記錄：亂按與 basicPolicy', () => {
  it('每場都有結果（數字見上方表格；不設勝率門檻）', () => {
    for (const name of ['basic', 'mash']) {
      for (const enc of ORDER) expect(chains[name][0].stats.get(enc).results).toHaveLength(BALANCE_RUNS);
    }
  });
});
