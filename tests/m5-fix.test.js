// M5 第一輪對抗審查後的修正輪：用正式資料（web/data/）逐項把關。
// 結局規則（使用者拍板）：依序 fog_walker（回應潮水，或階 8、階 7 都硬喝）→ lamp_kept（信任馬洛）→ dawn（無條件），不再看崩解。
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../tools/lib/bundle.mjs';
import { newGame } from '../web/src/core/state.js';
import { resolveEnding } from '../web/src/core/ending.js';
import { Sim } from './lib/sim.js';

const DATA_DIR = fileURLToPath(new URL('../web/data/', import.meta.url));
let data;
let dialogues;
beforeAll(() => {
  const { bundle, errors } = loadBundle(DATA_DIR);
  expect(errors).toEqual([]);
  data = bundle;
  dialogues = new Map(data.story.flatMap((s) => s.dialogues).map((d) => [d.id, d]));
});

const story = (id) => data.story.find((s) => s.id === id);
const promo = (rank, forced) => ({ lineage: 'trace', rank, forced, chapter: rank === 8 ? 'chapter4' : 'chapter7' });
/** 終章的 state：flags、promotions（預設兩次都穩穩喝下）、崩解。 */
const finaleState = ({ flags = {}, forced8 = false, forced7 = false, collapse = 0, party = ['hero', 'ada'] } = {}) => ({
  ...newGame({ name: '測試員', manifest: data.manifest, maps: data.maps }),
  chapter: 'finale', lineage: { id: 'trace', rank: 7 }, flags, collapse,
  promotions: [promo(8, forced8), promo(7, forced7)],
  party: party.map((id) => ({ id, hp: null, sp: null })),
});

/** 從某個 state 播一段對話；choices 依序挑含有該文字的選項（沒有命中就第 0 個）。回傳 sim。 */
function playFrom(state, dlgId, choices = []) {
  const sim = new Sim(data, { state, choiceRules: choices });
  sim.playOnly(dlgId);
  return sim;
}
const texts = (sim, dlgId) => sim.log.filter((l) => l.dialogue === dlgId);
/** 對話裡所有節點與選項的文字。 */
const allText = (dlgId) => dialogues.get(dlgId).nodes.flatMap((n) => [n.text, ...(n.choices ?? []).map((c) => c.text)]).join('\n');

/** 條件裡讀到的旗標。 */
function readFlags(cond, out = new Set()) {
  if (!cond || typeof cond !== 'object') return out;
  for (const [k, v] of Object.entries(cond)) {
    if ((k === 'flag' || k === 'not_flag') && typeof v === 'string') out.add(v);
    else if ((k === 'all' || k === 'any') && Array.isArray(v)) v.forEach((c) => readFlags(c, out));
    else if (k === 'not') readFlags(v, out);
  }
  return out;
}
/** 資料裡所有 set_flag（對話節點、選項、遭遇 on_win、道具）。 */
function setFlags() {
  const out = new Set();
  const eat = (effects) => { for (const e of effects ?? []) if (typeof e?.set_flag === 'string') out.add(e.set_flag); };
  for (const d of dialogues.values()) for (const n of d.nodes) { eat(n.effects); for (const c of n.choices ?? []) eat(c.effects); }
  for (const e of data.encounters) eat(e.on_win?.effects);
  return out;
}

// ───────────── 結局規則 ─────────────
describe('結局判定：看選擇＋硬喝紀錄，不看崩解', () => {
  it('終章 endings 的判定表（依序）', () => {
    expect(story('finale').endings.map(({ id, if: cond }) => ({ id, if: cond }))).toEqual([
      { id: 'fog_walker', if: { any: [{ flag: 'heeded_tide' }, { all: [{ promoted_forced: 8 }, { promoted_forced: 7 }] }] } },
      { id: 'lamp_kept', if: { flag: 'marlo_trusted' } },
      { id: 'dawn', if: undefined },
    ]);
  });

  it.each([
    ['回應潮水', { flags: { heeded_tide: true } }, 'fog_walker'],
    ['回應潮水＋信任馬洛', { flags: { heeded_tide: true, marlo_trusted: true } }, 'fog_walker'],
    ['兩次都硬喝（崩解 0）', { forced8: true, forced7: true }, 'fog_walker'],
    ['兩次都硬喝＋信任馬洛', { forced8: true, forced7: true, flags: { marlo_trusted: true } }, 'fog_walker'],
    ['只硬喝階 8＋信任馬洛', { forced8: true, flags: { marlo_trusted: true } }, 'lamp_kept'],
    ['只硬喝階 7＋信任馬洛、崩解 95', { forced7: true, collapse: 95, flags: { marlo_trusted: true } }, 'lamp_kept'],
    ['信任馬洛、崩解 90（舊規則會是霧中行者）', { collapse: 90, flags: { marlo_trusted: true } }, 'lamp_kept'],
    ['信任馬洛、崩解 55（舊規則會是黎明之前）', { collapse: 55, flags: { marlo_trusted: true } }, 'lamp_kept'],
    ['沒有信任馬洛、崩解 0', {}, 'dawn'],
    ['只硬喝階 8、沒有信任馬洛、崩解 99', { forced8: true, collapse: 99 }, 'dawn'],
    ['舉報隊長', { flags: { marlo_reported: true } }, 'dawn'],
    ['舊的快照旗標不再有作用', { flags: { final_frayed: true, final_calm: true } }, 'dawn'],
  ])('%s → %s', (_why, opts, expected) => {
    expect(resolveEnding(finaleState(opts), data).ending.id).toBe(expected);
  });

  it('資料裡不再有崩解快照旗標（final_calm／final_frayed 不設也不讀）；結局條件讀的旗標都有地方設', () => {
    const all = JSON.stringify(data.story) + JSON.stringify(data.encounters) + JSON.stringify(data.maps);
    expect(all).not.toMatch(/final_calm|final_frayed/);
    const read = new Set();
    for (const e of story('finale').endings) readFlags(e.if, read);
    const set = setFlags();
    for (const f of read) expect(set.has(f), `結局讀的旗標「${f}」沒有任何地方設定`).toBe(true);
    // 第七章勝利對話第一個節點不再做崩解判斷
    const v = dialogues.get('dlg_ch7_victory');
    expect(JSON.stringify(v)).not.toMatch(/collapse_(gte|lte)/);
  });
});

describe('三段結局台詞與新規則一致', () => {
  it('黎明之前只給沒有信任馬洛的人：不再分支 marlo_trusted／inspector_convinced（照實陳述的前提是信任馬洛）', () => {
    const d = dialogues.get('dlg_end_dawn');
    const read = new Set();
    for (const n of d.nodes) for (const b of n.branches ?? []) readFlags(b.if, read);
    expect(read.has('marlo_trusted')).toBe(false);
    expect(read.has('inspector_convinced')).toBe(false);
    expect(allText('dlg_end_dawn')).not.toMatch(/站在你這邊|報告收到/);
  });

  it.each([
    ['回應潮水、信任馬洛', { flags: { heeded_tide: true, marlo_trusted: true, inspector_convinced: true } }],
    ['回應潮水、舉報隊長', { flags: { heeded_tide: true, marlo_reported: true }, party: ['hero', 'herb', 'ada'] }],
    ['兩次硬喝、信任馬洛', { forced8: true, forced7: true, flags: { marlo_trusted: true, inspector_convinced: true } }],
    ['兩次硬喝、沒有和解', { forced8: true, forced7: true, flags: { ch6_marlo_unresolved: true } }],
  ])('霧中行者（%s）：兩條成因各有自己的獨白，信任馬洛的人有對應的一句', (_why, opts) => {
    const st = finaleState(opts);
    const sim = playFrom(st, 'dlg_end_fog_walker');
    const lines = texts(sim, 'dlg_end_fog_walker').map((l) => l.text).join('\n');
    if (st.flags.heeded_tide) expect(lines).toMatch(/它說，我聽得見/);
    else expect(lines).toMatch(/兩劑/); // 硬喝兩次的人：不是「崩解壓不住」，而是兩劑都喝得太急
    expect(lines).not.toMatch(/壓不住/);
    if (st.flags.marlo_trusted) expect(lines).toMatch(/站在他那邊/);
    else expect(lines).not.toMatch(/站在他那邊/);
    expect(sim.state.chapter_done).toContain('finale');
  });

  it('燈火未熄：不依賴崩解；艾妲不知道信寫了九年（她讀信時昏迷）；不再有「妳的手不抖了」', () => {
    const t = allText('dlg_end_lamp_kept');
    expect(t).not.toMatch(/九年/);
    expect(t).not.toMatch(/不抖/);
    for (const opts of [{ collapse: 0 }, { collapse: 95, forced8: true }]) {
      const sim = playFrom(finaleState({ ...opts, flags: { marlo_trusted: true, inspector_convinced: true, owen_spoke: true } }), 'dlg_end_lamp_kept');
      expect(sim.state.chapter_done).toContain('finale');
    }
    const d = dialogues.get('dlg_end_lamp_kept');
    expect(JSON.stringify(d)).not.toMatch(/collapse_(gte|lte)/);
  });
});

// ───────────── 輕微項目 ─────────────
describe('第四章', () => {
  it('4. 夜裡藥櫃沒有「再去看看」這種假出路（共鳴來源都在白天）', () => {
    const t = allText('dlg_ch4_cabinet');
    expect(t).not.toMatch(/再去看看|再回來|去把看見的事想清楚/);
  });

  it('5. 第四章的交換沒有「付出物只能在晉升後拿到」的項目（nine_t4_moss 移除）', () => {
    const trades = story('chapter4').guests?.nine?.trades ?? [];
    expect(trades.map((t) => t.id)).not.toContain('nine_t4_moss');
    for (const t of trades) for (const g of t.give) expect(g.item, t.id).not.toBe('hush_thread');
  });
});

describe('第六章', () => {
  const ch6 = (over = {}) => ({
    ...newGame({ name: '測試員', manifest: data.manifest, maps: data.maps }),
    chapter: 'chapter6', lineage: { id: 'trace', rank: 8 },
    party: [{ id: 'hero', hp: null, sp: null }, { id: 'herb', hp: null, sp: null }], ...over,
  });

  it('11.「所有人先回家」：出門時老賀伯離隊；深夜他敲門時回到隊伍', () => {
    for (const pick of ['回鐵橋街', '先去碼頭']) {
      const s = playFrom(ch6(), 'dlg_ch6_door', [pick]);
      expect(s.state.party.map((m) => m.id), pick).toEqual(['hero']);
    }
    const s = playFrom(ch6({ party: [{ id: 'hero', hp: null, sp: null }] }), 'dlg_ch6_mirror', ['借它的聲音']);
    expect(s.state.flags.ch6_marlo_missing).toBe(true);
    expect(s.state.party.map((m) => m.id)).toEqual(['hero', 'herb']);
  });

  it('13. 已經撿到鏡片（ch6_got_glass）再借聲音：不重演「裂開、掉下一片鏡片」', () => {
    const s = playFrom(ch6({ flags: { ch6_got_glass: true }, items: { lagging_glass: 1 }, party: [{ id: 'hero', hp: null, sp: null }, { id: 'herb', hp: null, sp: null }] }), 'dlg_ch6_mirror', ['借它的聲音']);
    const lines = texts(s, 'dlg_ch6_mirror').map((l) => l.text).join('\n');
    expect(lines).toMatch(/十二之後，還有一響/);
    expect(lines).not.toMatch(/掉在地板上|掉下一片|掉在你的腳邊/);
    expect(s.state.flags.ch6_mirror_heard).toBe(true);
    expect(s.state.items.lagging_glass).toBe(1);
  });
});

describe('第七章', () => {
  it('10. 開場不提可能沒見過的「沒有舌的鐘」，也不把只會哼聲的蘿絲算成說話的人', () => {
    const d = dialogues.get('dlg_ch7_opening');
    const t = ['o2', 'o3'].map((id) => d.nodes.find((n) => n.id === id).text).join('\n');
    expect(t).not.toMatch(/沒有舌|沒舌/);
    expect(t).not.toMatch(/蘿絲的夢話|她們都說/);
  });

  it('12. 舉報分支（老賀伯在隊上）：落海與醒來時老賀伯有台詞', () => {
    const st = {
      ...newGame({ name: '測試員', manifest: data.manifest, maps: data.maps }),
      chapter: 'chapter7', lineage: { id: 'trace', rank: 7 }, flags: { marlo_reported: true },
      party: ['hero', 'herb', 'ada'].map((id) => ({ id, hp: null, sp: null })),
    };
    for (const id of ['dlg_ch7_drown', 'dlg_ch7_wake']) {
      const s = playFrom(st, id);
      expect(texts(s, id).some((l) => l.speaker === '老賀伯'), id).toBe(true);
    }
    // 沒有老賀伯的隊伍不播他的台詞
    const two = { ...st, flags: {}, party: ['hero', 'ada'].map((id) => ({ id, hp: null, sp: null })) };
    for (const id of ['dlg_ch7_drown', 'dlg_ch7_wake']) {
      expect(texts(playFrom(two, id), id).some((l) => l.speaker === '老賀伯'), id).toBe(false);
    }
  });
});
