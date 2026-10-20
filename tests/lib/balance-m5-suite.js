// M5 平衡（P8）的測試本體：tests/balance-m5-marlo.test.js、tests/balance-m5-herb.test.js 各跑一種第七章隊伍（兩個檔案平行執行）。
//
// ■ 方法同 tests/balance.test.js（B9）：照劇情從新遊戲走到第七章（tests/lib/balance-m5.js 的 runChainM5），每場戰鬥用當下的
//   戰前狀態打 BALANCE_RUNS 次 × 5 組種子基底，再把最差四分位的戰後狀態接回劇情。每種策略各走一條自己的鏈。
// ■ 策略（tests/lib/policies.js 的 M5 版）
//   smart        合理策略：B9 的合理策略＋Boss 睡著或被影縛時先打小怪、有小怪才催眠（艾妲保留一次鎮魂的靈性）、
//                老賀伯【查閱】、馬洛隊友危險時【嘲諷】、換影者【影縛】。
//   noItemNoOmen 同上但不用道具、主角不用預兆（自己一條鏈）。
//   noOmen／noHypnosis 同 smart 但不用預兆／不催眠（Boss 戰前狀態相同、種子相同）。
//   hypnosis（催眠單一）、hypnosisSmart（聰明催眠）、basic、mash：只用來檢查「最強策略」上限。
// ■ Boss 情境：低血量（主角 30%、隊友 1 HP）→ prepareRetry 重新挑戰 ≥ 60%。
// ■ 回應潮水（enc_ch7_omen_heeded*）：戰前狀態＝潮兆戰的戰前狀態＋崩解 20（劇情效果），也照 Boss 的規則檢查。
// ■ B9 規則：一般戰 ≥ 95%；Boss 60%～90%；最強策略 ≤ 90%（每組 ≤ 95%）；不用道具不用預兆 ≥ 30%；
//   用預兆 ≥ 不用 +5%；用催眠 ≥ 不用（艾妲在隊上的 Boss 戰）；低血重試 ≥ 60%。區間＝5 組平均在區間內、每組在 ±5% 內。
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../../tools/lib/bundle.mjs';
import { deriveStats } from '../../web/src/core/stats.js';
import { prepareRetry } from '../../web/src/core/battle/engine.js';
import { runEncounter, SEED_BASES } from './balance.js';
import { runChainM5 } from './balance-m5.js';
import {
  smartM5Policy, noItemNoOmenM5Policy, noOmenM5Policy, noHypnosisM5Policy, hypnosisPolicy, hypnosisSmartPolicy,
  basicPolicy, mashPolicy, isBossEncounter,
} from './policies.js';

const DATA_DIR = fileURLToPath(new URL('../../web/data/', import.meta.url));
const BALANCE_RUNS = Number(process.env.BALANCE_RUNS) || 200;
const SLACK = 0.05;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function expectBand(values, lo, hi, label) {
  const msg = `${label}：各組 ${values.map(pct).join('、')}，平均 ${pct(avg(values))}`;
  expect(avg(values), msg).toBeGreaterThanOrEqual(lo);
  expect(avg(values), msg).toBeLessThanOrEqual(hi);
  for (const v of values) {
    expect(v, msg).toBeGreaterThanOrEqual(lo - SLACK);
    expect(v, msg).toBeLessThanOrEqual(hi + SLACK);
  }
}

/**
 * team：'marlo'｜'herb'。encounters：這個檔案要檢查的遭遇（依劇情順序；Boss 由資料判定）。
 * 回應潮水的版本另外用 heeded: [潮兆戰 id, 回應版 id]。
 */
export function balanceSuite({ team, encounters, heeded }) {
  const { bundle: data, errors } = loadBundle(DATA_DIR);
  const bosses = encounters.filter((e) => isBossEncounter(data, e));
  const normals = encounters.filter((e) => !isBossEncounter(data, e));
  const bossAll = heeded ? [...bosses, heeded[1]] : bosses;
  const chains = { smart: [], noItemNoOmen: [] };
  /** bossStats[enc][策略] = 5 組統計 */
  const bossStats = {};
  const rows = [];

  beforeAll(() => {
    expect(errors).toEqual([]);
    for (const seedBase of SEED_BASES) {
      chains.smart.push(runChainM5(data, smartM5Policy, BALANCE_RUNS, { seedBase, team }));
      chains.noItemNoOmen.push(runChainM5(data, noItemNoOmenM5Policy, BALANCE_RUNS, { seedBase, team }));
    }
    for (const enc of bossAll) {
      const isHeeded = heeded && enc === heeded[1];
      const preOf = (i) => {
        const pre = chains.smart[i].preStates.get(isHeeded ? heeded[0] : enc);
        return isHeeded ? { ...pre, collapse: Math.min(100, pre.collapse + 20) } : pre;
      };
      const run = (policy, f = (s) => s) => SEED_BASES.map((sb, i) => runEncounter(enc, f(preOf(i)), data, policy, BALANCE_RUNS, sb));
      const s = {
        smart: isHeeded ? run(smartM5Policy) : chains.smart.map((c) => c.stats.get(enc)),
        noItemNoOmen: isHeeded
          ? SEED_BASES.map((sb, i) => {
            const pre = chains.noItemNoOmen[i].preStates.get(heeded[0]);
            return runEncounter(enc, { ...pre, collapse: Math.min(100, pre.collapse + 20) }, data, noItemNoOmenM5Policy, BALANCE_RUNS, sb);
          })
          : chains.noItemNoOmen.map((c) => c.stats.get(enc)),
        noOmen: run(noOmenM5Policy),
        noHypnosis: run(noHypnosisM5Policy),
        hypnosis: run(hypnosisPolicy),
        hypnosisSmart: run(hypnosisSmartPolicy),
        basic: run(basicPolicy),
        mash: run(mashPolicy),
        retry: run(smartM5Policy, (pre) => prepareRetry({
          ...pre, party: pre.party.map((m) => ({ ...m, hp: m.id === 'hero' ? Math.round(deriveStats(m.id, pre, data).hp * 0.3) : 1 })),
        }, data)),
      };
      bossStats[enc] = s;
    }
    for (const enc of [...encounters, ...(heeded ? [heeded[1]] : [])]) {
      const b = bossStats[enc];
      const st = b ? b.smart : chains.smart.map((c) => c.stats.get(enc));
      const ni = b ? b.noItemNoOmen : chains.noItemNoOmen.map((c) => c.stats.get(enc));
      let line = `${enc.padEnd(28)} 合理 ${pct(avg(st.map((x) => x.victory))).padStart(6)}（最差 ${pct(Math.min(...st.map((x) => x.victory)))}）`
        + ` 不用道具不用預兆 ${pct(avg(ni.map((x) => x.victory)))}  回合 ${avg(st.map((x) => x.avgRounds)).toFixed(1)}  崩解 ${st[0].startCollapse} → ${avg(st.map((x) => x.avgCollapse)).toFixed(1)}`;
      if (b) line += `\n${' '.repeat(29)}${Object.entries(b).filter(([k]) => !['smart', 'noItemNoOmen'].includes(k)).map(([k, v]) => `${k} ${pct(avg(v.map((x) => x.victory)))}`).join('  ')}`;
      rows.push(line);
    }
    console.log(`M5 平衡模擬（第七章隊伍：${team === 'marlo' ? '主角＋艾妲＋馬洛' : '主角＋老賀伯＋艾妲'}；每場 ${BALANCE_RUNS} 次 × ${SEED_BASES.length} 組種子）\n${rows.join('\n')}`);
  }, 900_000);

  describe(`P8 戰前狀態照劇情推算（${team}）`, () => {
    it('路線依序遇到這個檔案要檢查的每一場戰鬥', () => {
      for (const c of chains.smart) for (const enc of encounters) expect(c.stats.has(enc), enc).toBe(true);
    });
    it('第七章的隊伍符合路線', () => {
      const pre = chains.smart[0].preStates.get(encounters.at(-1)).party.map((m) => m.id).sort();
      expect(pre).toEqual(team === 'marlo' ? ['ada', 'hero', 'marlo'] : ['ada', 'herb', 'hero']);
    });
  });

  describe(`P8 一般戰（${team}）：合理策略 ≥ 95%`, () => {
    for (const enc of normals) {
      it(enc, () => {
        expectBand(chains.smart.map((c) => c.stats.get(enc).victory), 0.95, 1, enc);
      });
    }
  });

  describe(`P8 Boss（${team}）`, () => {
    for (const enc of bossAll) {
      it(`${enc}：合理 60%～90%、不用道具不用預兆 ≥ 30%、低血重試 ≥ 60%`, () => {
        const b = bossStats[enc];
        expectBand(b.smart.map((s) => s.victory), 0.6, 0.9, `${enc} 合理策略`);
        expectBand(b.noItemNoOmen.map((s) => s.victory), 0.3, 1, `${enc} 不用道具不用預兆`);
        expectBand(b.retry.map((s) => s.victory), 0.6, 1, `${enc} 低血重試`);
      });
      it(`${enc}：用預兆 ≥ 不用 +5%；艾妲在隊上時用催眠 ≥ 不用；最強策略 ≤ 90%（每組 ≤ 95%）`, () => {
        const b = bossStats[enc];
        const v = (k) => avg(b[k].map((s) => s.victory));
        expect(v('smart'), `用預兆 ${pct(v('smart'))}，不用 ${pct(v('noOmen'))}`).toBeGreaterThanOrEqual(v('noOmen') + 0.05);
        const pre = chains.smart[0].preStates.get(heeded && enc === heeded[1] ? heeded[0] : enc);
        if (pre.party.some((m) => m.id === 'ada')) {
          expect(v('smart'), `催眠 ${pct(v('smart'))}，不催眠 ${pct(v('noHypnosis'))}`).toBeGreaterThanOrEqual(v('noHypnosis'));
        }
        const names = Object.keys(b).filter((k) => k !== 'retry');
        const best = names.reduce((a, k) => (v(k) > v(a) ? k : a));
        const msg = names.map((k) => `${k} ${pct(v(k))}`).join('、');
        expect(v(best), `最好的是 ${best}；${msg}`).toBeLessThanOrEqual(0.9);
        for (const k of names) for (const s of b[k]) expect(s.victory, `${k} 單組；${msg}`).toBeLessThanOrEqual(0.95);
      });
    }
  });
}
