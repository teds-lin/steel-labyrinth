// B9 平衡模擬：每場戰鬥 × 每種策略打 BALANCE_RUNS 次（固定種子 SEED_BASE＋0…N−1），檢查勝率、回合數與崩解。
//
// ■ 戰前狀態怎麼推算（tests/lib/balance.js 的 runChain）
//   不手組狀態，而是用真實資料照劇情走一遍（tests/lib/sim.js：走地圖、播對話、處理 battle／goto）：
//   序章（殘響開門、對房東說謊後看穿：崩解 +10）→ end_screen.continue → 第一章（喝下靈劑：崩解 +5、
//   拿到左輪與 3 發子彈 → 教學戰）→ 補給（全隊回滿、子彈補到 9、繃帶×2、鎮靜香×1、艾妲入隊）→ 第二章
//   （工頭給鑰匙、對妻子隱瞞：崩解 +3、小屋補給箱繃帶×1、線索用【回溯】）→ 過橋遭遇 enc_dock_1 → 拖痕
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
//   basic        engine 的 basicPolicy（普攻＋生命低時繃帶），只記錄。
//   mash         亂按：只用普攻、目標亂選，只記錄（確認一般戰不會因為策略差就全滅）。
//
// ■ 「回合數」＝我方行動次數最多的那個人的行動次數（roundsOf）。
// ■ 執行時間：4 條鏈 × 5 場 × 200 次約 2～3 秒（vitest 預設逾時 5 秒；beforeAll 另給 60 秒）。
//   場數可用環境變數 BALANCE_RUNS 調整，CI 用預設的 200。
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../tools/lib/bundle.mjs';
import { deriveStats } from '../web/src/core/stats.js';
import { runChain, runEncounter } from './lib/balance.js';
import { smartPolicy, noItemNoOmenPolicy, basicPolicy, mashPolicy, isBossEncounter } from './lib/policies.js';

const DATA_DIR = fileURLToPath(new URL('../web/data/', import.meta.url));
const BALANCE_RUNS = Number(process.env.BALANCE_RUNS) || 200;

const TUTORIAL = 'enc_sparring';
const NORMAL = ['enc_dock_1', 'enc_dock_2', 'enc_warehouse'];
const BOSS = 'enc_boss';
const ORDER = [TUTORIAL, ...NORMAL, BOSS];

let data;
const chains = {};
const pct = (x) => `${(x * 100).toFixed(1)}%`;

beforeAll(() => {
  const { bundle, errors } = loadBundle(DATA_DIR);
  expect(errors).toEqual([]);
  data = bundle;
  chains.smart = runChain(data, smartPolicy, BALANCE_RUNS);
  chains.noItemNoOmen = runChain(data, noItemNoOmenPolicy, BALANCE_RUNS);
  chains.basic = runChain(data, basicPolicy, BALANCE_RUNS);
  chains.mash = runChain(data, mashPolicy, BALANCE_RUNS, { statesFrom: chains.smart.preStates });
  const rows = [];
  for (const [name, c] of Object.entries(chains)) {
    for (const enc of ORDER) {
      const s = c.stats.get(enc);
      rows.push(`${name.padEnd(12)} ${enc.padEnd(14)} 勝 ${pct(s.victory).padStart(6)}  失控 ${pct(s.lostControl).padStart(5)}  回合 ${s.avgRounds.toFixed(1).padStart(4)}（最多 ${s.maxRounds}）  崩解 ${s.startCollapse} → ${s.avgCollapse.toFixed(1)}`);
    }
  }
  console.log(`B9 平衡模擬（每場 ${BALANCE_RUNS} 次）\n${rows.join('\n')}`);
}, 60_000);

describe('B9 戰前狀態照劇情推算', () => {
  it('路線依序遇到全部五場戰鬥，Boss 判定來自資料（不能逃、輸了要重來）', () => {
    expect([...chains.smart.stats.keys()]).toEqual(ORDER);
    expect(ORDER.filter((e) => isBossEncounter(data, e))).toEqual([BOSS]);
  });

  it('教學戰：只有主角、已喝下靈劑、有子彈；第二章起艾妲在隊上', () => {
    const pre = chains.smart.preStates;
    expect(pre.get(TUTORIAL).party.map((m) => m.id)).toEqual(['hero']);
    expect(pre.get(TUTORIAL).lineage).toEqual({ id: 'trace', rank: 9 });
    expect(pre.get(TUTORIAL).ammo).toBeGreaterThan(0);
    for (const enc of [...NORMAL, BOSS]) expect(pre.get(enc).party.map((m) => m.id)).toEqual(['hero', 'ada']);
  });

  it('連續戰鬥之間的消耗有算進去：碼頭第二場、倉庫那場帶著前一場的傷，崩解一路累積；Boss 前休息點回滿生命', () => {
    const pre = chains.smart.preStates;
    const hpOf = (s) => s.party.map((m) => m.hp ?? deriveStats(m.id, s, data).hp);
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    expect(sum(hpOf(pre.get('enc_dock_2')))).toBeLessThan(sum(hpOf(pre.get('enc_dock_1'))));
    expect(sum(hpOf(pre.get('enc_warehouse')))).toBeLessThan(sum(hpOf(pre.get('enc_dock_1'))));
    expect(pre.get(BOSS).collapse).toBeGreaterThan(pre.get('enc_dock_1').collapse);
    const boss = pre.get(BOSS);
    expect(hpOf(boss)).toEqual(boss.party.map((m) => deriveStats(m.id, boss, data).hp));
  });

  it('固定種子可重現：同一個戰前狀態再打一次，結果完全相同', () => {
    const pre = chains.smart.preStates.get(BOSS);
    const a = runEncounter(BOSS, pre, data, smartPolicy, 20);
    const b = runEncounter(BOSS, pre, data, smartPolicy, 20);
    expect(b.results.map((r) => [r.outcome, r.rounds, r.collapse])).toEqual(a.results.map((r) => [r.outcome, r.rounds, r.collapse]));
  });
});

describe('B9 勝率區間（合理策略）', () => {
  for (const enc of NORMAL) {
    it(`${enc}：一般戰勝率 ≥ 95%`, () => {
      expect(chains.smart.stats.get(enc).victory).toBeGreaterThanOrEqual(0.95);
    });
  }
  it(`${BOSS}：Boss 勝率 60%～90%`, () => {
    const v = chains.smart.stats.get(BOSS).victory;
    expect(v).toBeGreaterThanOrEqual(0.6);
    expect(v).toBeLessThanOrEqual(0.9);
  });
  it(`${BOSS}：不用道具、不用預兆仍有 ≥ 30%`, () => {
    expect(chains.noItemNoOmen.stats.get(BOSS).victory).toBeGreaterThanOrEqual(0.3);
  });
});

describe('教學戰（on_lose: continue）', () => {
  for (const name of ['smart', 'noItemNoOmen', 'basic', 'mash']) {
    it(`${name}：100% 打得完（勝或敗都繼續劇情），平均 ≤ 12 回合`, () => {
      const s = chains[name].stats.get(TUTORIAL);
      for (const r of s.results) {
        expect(['victory', 'defeat']).toContain(r.outcome);
        expect(r.finish.next).toEqual({ type: 'dialogue', dialogue: data.encounters.find((e) => e.id === TUTORIAL).on_win.dialogue });
      }
      expect(s.avgRounds).toBeLessThanOrEqual(12);
    });
  }
});

describe('回合數與崩解（合理策略、不用道具不用預兆）', () => {
  for (const name of ['smart', 'noItemNoOmen']) {
    for (const enc of NORMAL) {
      it(`${name} ${enc}：平均 ≤ 8 回合`, () => {
        expect(chains[name].stats.get(enc).avgRounds).toBeLessThanOrEqual(8);
      });
    }
    it(`${name} ${BOSS}：平均 ≤ 20 回合；平均最終崩解 < 70；失控 < 15%`, () => {
      const s = chains[name].stats.get(BOSS);
      expect(s.avgRounds).toBeLessThanOrEqual(20);
      expect(s.avgCollapse).toBeLessThan(70);
      expect(s.lostControl).toBeLessThan(0.15);
    });
  }
});

describe('只記錄：亂按與 basicPolicy', () => {
  it('每場都有結果（數字見上方表格；不設勝率門檻）', () => {
    for (const name of ['basic', 'mash']) {
      for (const enc of ORDER) expect(chains[name].stats.get(enc).results).toHaveLength(BALANCE_RUNS);
    }
  });
});
