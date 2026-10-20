// M5 部署前最後的小修正（第二輪審查後）：用正式資料（web/data/）逐項把關。
// 2：一擊打倒時，只有標了 on_kill 的階段（潮兆的第十三響）仍補播；歐斯華剩 28% 被一擊打倒不播「他在叫人」。
// 3：黎明之前——沒有信任馬洛、但陳述時替隊長作證（covered_marlo）的玩家，馬洛回應這件事。
// 4：燈火未熄——艾妲「明天見」與老賀伯「喝茶別太慢」的道別所有人都看得到；只有潮聲那句留在硬喝分支。
// 5：第四章藥櫃／第七章十二號椅子：共鳴不足時，在選項前多一句提醒，不新增回頭選項。
// 6：老賀伯藥櫃材料不足的台詞與實際給的道具一致（他只給了一份回聲苔）。
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../tools/lib/bundle.mjs';
import { newGame } from '../web/src/core/state.js';
import { validateBundle } from '../web/src/core/validate.js';
import { applyBattleEffect } from '../web/src/core/battle/effects.js';
import { makeEnemyUnit } from '../web/src/core/battle/units.js';
import { enemyDef } from '../web/src/core/battle/stat.js';
import { Sim } from './lib/sim.js';
import { unit, mkBattle } from './core/battle/helpers.js';

const DATA_DIR = fileURLToPath(new URL('../web/data/', import.meta.url));
let data;
let dialogues;
beforeAll(() => {
  const { bundle, errors } = loadBundle(DATA_DIR);
  expect(errors).toEqual([]);
  data = bundle;
  dialogues = new Map(data.story.flatMap((s) => s.dialogues).map((d) => [d.id, d]));
});

const base = (chapter, over = {}) => ({
  ...newGame({ name: '測試員', manifest: data.manifest, maps: data.maps }), chapter, ...over,
});
function playFrom(state, dlgId, choices = []) {
  const sim = new Sim(data, { state, choiceRules: choices });
  sim.playOnly(dlgId);
  return sim;
}
const lines = (sim, dlgId) => sim.log.filter((l) => l.dialogue === dlgId);

// ───────────── 2. 階段的 on_kill ─────────────
describe('2. 一擊打倒時，只有 on_kill 的階段補播', () => {
  /** 敵人生命剩 pct% 時被一擊打倒，回傳 phase／defeated 事件。 */
  function oneShot(enemyId, pct) {
    const e = makeEnemyUnit(enemyDef(data, enemyId), 'e0');
    e.hp = Math.max(1, Math.floor((e.stats.hp * pct) / 100));
    const b = mkBattle([unit('p0', 'party'), e]);
    const r = applyBattleEffect(b, { type: 'damage', fixed: 99999 }, 'p0', 'e0', data);
    return r.log.filter((x) => x.type === 'phase' || x.type === 'defeated');
  }

  it('歐斯華剩 28% 時被一擊打倒：不播「他在叫人」（dlg_ch5_boss_phase3），直接倒下', () => {
    expect(oneShot('brother_oswald', 28)).toEqual([{ type: 'defeated', uid: 'e0' }]);
  });

  it.each(['tide_omen', 'tide_omen_nocap'])('%s 剩 30% 時被一擊打倒：仍先播第十三響，再倒下', (id) => {
    const seq = oneShot(id, 30);
    expect(seq.map((x) => x.dialogue ?? x.type)).toEqual(['dlg_ch7_thirteenth', 'defeated']);
  });

  it('沒有被一擊打倒時，所有階段照舊依門檻觸發', () => {
    const e = makeEnemyUnit(enemyDef(data, 'brother_oswald'), 'e0');
    const b = mkBattle([unit('p0', 'party'), e]);
    const dmg = Math.ceil(e.stats.hp * 0.8); // 100% → 20%
    const r = applyBattleEffect(b, { type: 'damage', fixed: dmg }, 'p0', 'e0', data);
    expect(r.log.filter((x) => x.type === 'phase').map((x) => x.dialogue)).toEqual(['dlg_ch5_boss_phase2', 'dlg_ch5_boss_phase3']);
  });

  it('原稿只有潮兆（含 _nocap）的第十三響階段標 on_kill: true', () => {
    const marked = data.enemies.flatMap((en) => (en.phases ?? []).filter((p) => p.on_kill !== undefined).map((p) => [en.id, p.dialogue, p.on_kill]));
    expect(marked.sort()).toEqual([
      ['tide_omen', 'dlg_ch7_thirteenth', true],
      ['tide_omen_nocap', 'dlg_ch7_thirteenth', true],
    ]);
  });

  it('validate：on_kill 必須是 true/false', () => {
    const bad = structuredClone(data);
    bad.enemies.find((e) => e.id === 'brother_oswald').phases[0].on_kill = 'yes';
    expect(validateBundle(bad).join('\n')).toMatch(/brother_oswald.*phases\[0\].*on_kill 必須是 true\/false/);
    const ok = structuredClone(data);
    ok.enemies.find((e) => e.id === 'brother_oswald').phases[0].on_kill = false;
    expect(validateBundle(ok)).toEqual([]);
  });
});

// ───────────── 3～4. 結局台詞 ─────────────
const promo = (rank, forced) => ({ lineage: 'trace', rank, forced, chapter: rank === 8 ? 'chapter4' : 'chapter7' });
const finale = ({ flags = {}, forced8 = false, forced7 = false } = {}) => base('finale', {
  lineage: { id: 'trace', rank: 7 }, flags, promotions: [promo(8, forced8), promo(7, forced7)],
  party: ['hero', 'ada'].map((id) => ({ id, hp: null, sp: null })),
});

describe('3. 黎明之前：替隊長作證的玩家有回應', () => {
  const marloOn = (flags) => lines(playFrom(finale({ flags }), 'dlg_end_dawn'), 'dlg_end_dawn')
    .filter((l) => l.speaker === '馬洛').map((l) => l.text).join('\n');
  it('covered_marlo（沒有信任馬洛）：馬洛提到你替他作證', () => {
    expect(marloOn({ covered_marlo: true })).toMatch(/作證|說謊/);
  });
  it('拒簽／沒有任何陳述旗標：沒有這句', () => {
    expect(marloOn({ ch6_refused_statement: true })).not.toMatch(/作證|說謊/);
    expect(marloOn({})).not.toMatch(/作證|說謊/);
  });
});

describe('4. 燈火未熄：明天見的道別所有人都看得到', () => {
  const tail = (opts) => lines(playFrom(finale({ ...opts, flags: { marlo_trusted: true } }), 'dlg_end_lamp_kept'), 'dlg_end_lamp_kept');
  it.each([
    ['沒有硬喝', {}, false],
    ['硬喝階 8', { forced8: true }, true],
    ['硬喝階 7', { forced7: true }, true],
  ])('%s：艾妲「明天見」＋老賀伯「喝茶別太慢」；潮聲只在硬喝時', (_w, opts, tide) => {
    const ls = tail(opts);
    expect(ls.some((l) => l.speaker === '艾妲' && /明天見/.test(l.text))).toBe(true);
    expect(ls.some((l) => l.speaker === '老賀伯' && /喝茶別太慢/.test(l.text))).toBe(true);
    expect(ls.some((l) => /潮聲/.test(l.text))).toBe(tide);
  });
});

// ───────────── 5～6. 晉升前的提醒 ─────────────
/** 播到選項節點為止的紀錄（選項前一句＝提醒）。 */
function beforeAsk(state, dlgId) {
  const sim = playFrom(state, dlgId, ['再等一下']);
  const ls = lines(sim, dlgId);
  const i = ls.findIndex((l) => l.choices);
  return { prev: ls[i - 1], ask: ls[i], before: ls.slice(0, i) };
}

describe('5. 第四章藥櫃：共鳴不足時老賀伯先提醒一句', () => {
  const ch4 = (resonance) => base('chapter4', {
    lineage: { id: 'trace', rank: 9 }, flags: { ch4_night: true },
    items: { echo_moss: 2, choir_wax: 1 }, resonance: { test: resonance },
  });
  it('共鳴不足（7 < 8）：選項前老賀伯提醒崩解；不新增回頭選項', () => {
    const low = beforeAsk(ch4(7), 'dlg_ch4_cabinet');
    const ok = beforeAsk(ch4(8), 'dlg_ch4_cabinet');
    expect(low.prev.speaker).toBe('老賀伯');
    expect(low.prev.text).toMatch(/崩解/);
    expect(low.before.length).toBe(ok.before.length + 1);
    expect(low.ask.choices).toEqual(ok.ask.choices);
    expect(ok.prev.text).not.toMatch(/崩解/);
  });
  it('提醒用的共鳴門檻＝譜系 potion 的門檻', () => {
    const need = data.lineages.find((l) => l.id === 'trace').ranks.find((r) => r.rank === 8).potion.resonance;
    expect(JSON.stringify(dialogues.get('dlg_ch4_cabinet'))).toContain(`{"resonance_gte":${need}}`);
  });
});

describe('5. 第七章十二號椅子：共鳴不足時夢客先提醒一句', () => {
  const ch7 = (resonance, forced8 = false) => base('chapter7', {
    lineage: { id: 'trace', rank: 8 }, items: { shade_ink: 2, lagging_glass: 1 }, resonance: { test: resonance },
    promotions: [promo(8, forced8)], location: { map: 'dream_tower_ch7', x: 0, y: 0, facing: 'down' },
  });
  it.each([[false], [true]])('共鳴不足（11 < 12，階 8 硬喝：%s）：選項前多一句夢客的提醒；選項不變', (forced8) => {
    const low = beforeAsk(ch7(11, forced8), 'dlg_ch7_chair_twelve');
    const ok = beforeAsk(ch7(12, forced8), 'dlg_ch7_chair_twelve');
    expect(['三點', '九點']).toContain(low.prev.speaker);
    expect(low.prev.text).toMatch(/崩解/);
    expect(ok.prev.text).not.toMatch(/崩解/);
    expect(low.before.length).toBe(ok.before.length + 1);
    expect(low.ask.choices).toEqual(ok.ask.choices);
  });
  it('提醒用的共鳴門檻＝譜系 potion 的門檻', () => {
    const need = data.lineages.find((l) => l.id === 'trace').ranks.find((r) => r.rank === 7).potion.resonance;
    expect(JSON.stringify(dialogues.get('dlg_ch7_chair_twelve'))).toContain(`{"resonance_gte":${need}}`);
  });
});

describe('6. 藥櫃材料不足：老賀伯的說法和他實際給的一致（只給了一份回聲苔）', () => {
  it('不再說「明明都交給你了」', () => {
    const nm = dialogues.get('dlg_ch4_cabinet').nodes.find((n) => n.id === 'nm');
    expect(nm.text).not.toMatch(/都交給你/);
    expect(nm.text).toMatch(/一份/);
  });
});
