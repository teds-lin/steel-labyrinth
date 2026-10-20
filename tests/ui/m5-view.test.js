// 畫面層 M5 純邏輯（web/src/ui/m5-view.js）：晉升進度與演出、晉升失敗說明、交換清單、結局畫面、讀檔後的畫面、探索標籤名稱。
import { describe, it, expect } from 'vitest';
import { loadDir, M5_FIXTURE_DIR } from './load-fixture.js';
import { validateBundle } from '../../web/src/core/validate.js';
import { applyEffect } from '../../web/src/core/effects.js';
import { applyTrade } from '../../web/src/core/trade.js';
import {
  promotionProgress, promotionFxView, promoteFailedDialogue, tradeRows, tradeConfirm, tradeDoneText,
  endingScreen, resumeScene, fieldTagLabel,
} from '../../web/src/ui/m5-view.js';

const data = loadDir(M5_FIXTURE_DIR);
const base = (o = {}) => ({
  schema_version: 4, player: { name: '艾琳' }, lineage: { id: 'trace', rank: 9 },
  location: { map: 'fx_room', x: 4, y: 3, dir: 'down' }, flags: {}, items: {}, echo: { charges: 0 }, collapse: 0,
  resonance: {}, chapter: 'fx_ch4', chapter_done: [], playtime_s: 0, party: [{ id: 'hero', hp: null, sp: null }],
  ammo: 0, pending: null, dream_return: null, promotions: [], ending: null, ...o,
});

describe('M5 測試 fixture', () => {
  it('通過 validateBundle（Boot 會擋）', () => {
    expect(validateBundle(data)).toEqual([]);
  });
});

describe('promotionProgress（選單「隊伍 → 晉升進度」）', () => {
  it('列出目前階位、下一階、材料 有／需要、共鳴 有／需要', () => {
    const v = promotionProgress(base({ items: { echo_moss: 2 }, resonance: { a: 3, b: 2 } }), data);
    expect(v.current).toEqual({ name: '讀痕者', rank: 9 });
    expect(v.next).toEqual({ name: '借聲者', rank: 8 });
    expect(v.materials).toEqual([
      { name: '回聲苔', have: 2, need: 2, ok: true },
      { name: '唱詩蠟', have: 0, need: 1, ok: false },
    ]);
    expect(v.resonance).toEqual({ have: 5, need: 12, ok: false });
    expect(v.canPromote).toBe(false);
    expect(v.lines).toContain('下一階：借聲者（階 8）');
    expect(v.lines).toContain('・回聲苔　2／2　已備齊');
    expect(v.lines).toContain('・唱詩蠟　0／1　還缺 1');
    expect(v.lines.some((l) => l.startsWith('共鳴　5／12'))).toBe(true);
  });
  it('材料齊、共鳴不足 → 提醒硬喝會增加崩解', () => {
    const v = promotionProgress(base({ items: { echo_moss: 2, choir_wax: 1 }, resonance: { a: 1 } }), data);
    expect(v.canPromote).toBe(true);
    expect(v.forced).toBe(true);
    expect(v.lines.join('\n')).toMatch(/硬喝.*崩解 \+40/);
  });
  it('材料與共鳴都齊 → 可以喝下', () => {
    const v = promotionProgress(base({ items: { echo_moss: 2, choir_wax: 1 }, resonance: { a: 12 } }), data);
    expect(v.forced).toBe(false);
    expect(v.lines.join('\n')).toMatch(/可以喝下靈劑/);
  });
  it('沒有下一階（已開放的最高階）或沒有譜系', () => {
    const top = promotionProgress(base({ lineage: { id: 'trace', rank: 7 } }), data);
    expect(top.next).toBeNull();
    expect(top.lines.join('\n')).toMatch(/目前沒有可以晉升的下一階/);
    const none = promotionProgress(base({ lineage: null }), data);
    expect(none.current).toBeNull();
    expect(none.lines.join('\n')).toMatch(/還沒有喝下任何靈劑/);
  });
});

describe('promotionFxView（喝下靈劑的演出）', () => {
  it('正常晉升：新階位名稱、獲得的探索能力與技能', () => {
    const before = base({ items: { echo_moss: 2, choir_wax: 1 }, resonance: { a: 12 } });
    const after = applyEffect({ promote: { lineage: 'trace', rank: 8 } }, before, data);
    const v = promotionFxView(before, after, data);
    expect(v).toMatchObject({ forced: false, rank: 8, name: '借聲者', collapseGain: 0 });
    expect(v.abilities).toEqual(['借聲']);
    expect(v.skills).toEqual(['借來的聲音']);
    expect(v.lines).toContain('獲得探索能力【借聲】');
    expect(v.lines).toContain('新技能：借來的聲音');
  });
  it('硬喝：forced、崩解增加量與崩解提示', () => {
    const before = base({ items: { echo_moss: 2, choir_wax: 1 }, collapse: 10 });
    const after = applyEffect({ promote: { lineage: 'trace', rank: 8 } }, before, data);
    const v = promotionFxView(before, after, data);
    expect(v.forced).toBe(true);
    expect(v.collapseGain).toBe(40);
    expect(v.lines.join('\n')).toMatch(/崩解 \+40（目前 50／100）/);
    expect(v.warning).toMatch(/共鳴不足/);
  });
  it('沒有新的晉升紀錄 → null', () => {
    const s = base();
    expect(promotionFxView(s, { ...s, flags: { x: true } }, data)).toBeNull();
    expect(promotionFxView(null, s, data)).toBeNull();
  });
  it('M5 整合：依 pending 的 promoted 判斷，不比對 promotions 長度', () => {
    const s = base();
    // promotions 多了一筆、但沒有 promoted pending（例如讀檔換了存檔）→ 不演出
    expect(promotionFxView(s, { ...s, promotions: [{ lineage: 'trace', rank: 8, forced: false, chapter: 'fx_ch4' }] }, data)).toBeNull();
    // 只有 promoted pending（promotions 長度不變）→ 演出，內容取自 pending
    const after = { ...s, lineage: { id: 'trace', rank: 7 }, pending: [{ type: 'promoted', lineage: 'trace', rank: 7, forced: true }] };
    expect(promotionFxView(s, after, data)).toMatchObject({ rank: 7, name: '換影者', forced: true, abilities: ['換影'] });
    // 對話開始前就已經在 pending 裡的 promoted 不重播
    expect(promotionFxView(after, { ...after, flags: { y: true } }, data)).toBeNull();
  });
});

describe('promoteFailedDialogue（pending 的 promote_failed）', () => {
  it('材料不足：列出缺少的材料（名稱 有／需要）', () => {
    const s = applyEffect({ promote: { lineage: 'trace', rank: 8 } }, base({ items: { echo_moss: 1 } }), data);
    const p = s.pending.find((x) => x.type === 'promote_failed');
    const d = promoteFailedDialogue(p, data);
    const texts = d.nodes.map((n) => n.text).join('\n');
    expect(texts).toMatch(/材料不足/);
    expect(texts).toMatch(/回聲苔 1／2/);
    expect(texts).toMatch(/唱詩蠟 0／1/);
    expect(d.id.startsWith('__')).toBe(true);
  });
  it('階位不符、譜系不合各有說明', () => {
    const t = (reason) => promoteFailedDialogue({ type: 'promote_failed', promote_failed: reason, lineage: 'trace', rank: 7, missing: [] }, data).nodes.map((n) => n.text).join('');
    expect(t('rank')).toMatch(/換影者.*還喝不了|階位/);
    expect(t('lineage')).toMatch(/途徑|譜系/);
  });
});

describe('tradeRows／tradeConfirm（交換介面）', () => {
  const dream = (o) => base({ location: { map: 'fx_dream', x: 4, y: 2, dir: 'up' }, dream_return: { map: 'fx_room', x: 3, y: 5, dir: 'left' }, ...o });
  it('列出 label、給出／得到與目前持有數；付不起的灰掉並說明', () => {
    const rows = tradeRows('nine', dream({ items: { sedative_incense: 3 } }), data);
    expect(rows.map((r) => r.id)).toEqual(['fx5_moss', 'fx5_wax']); // fx5_ink 要階 8 才開放
    expect(rows[0]).toMatchObject({ label: '兩包鎮靜香換一份回聲苔', enabled: true });
    expect(rows[0].sub).toBe('給出：鎮靜香×2（持有 3）\n得到：回聲苔×1（持有 0）');
    expect(rows[1].enabled).toBe(false);
    expect(rows[1].sub).toBe('材料不足｜給出：回聲苔×1（持有 0）\n得到：唱詩蠟×1（持有 0）');
  });
  it('once 的交換做完不再列出', () => {
    let s = dream({ items: { echo_moss: 1 } });
    s = applyTrade('fx5_wax', s, data, 'nine');
    expect(tradeRows('nine', s, data).map((r) => r.id)).toEqual(['fx5_moss']);
  });
  it('目前章節的夢客（guestFor）：終章換成終章的交換表', () => {
    const rows = tradeRows('nine', dream({ chapter: 'fx_finale', items: { shade_ink: 1 } }), data);
    expect(rows.map((r) => r.id)).toEqual(['fx5_final']);
  });
  it('確認頁的文字：持有數的變化、只能交換一次', () => {
    const s = dream({ items: { echo_moss: 1, sedative_incense: 1 } });
    const c = tradeConfirm('nine', 'fx5_wax', s, data);
    expect(c.lines).toEqual(['給出：回聲苔 ×1（持有 1 → 0）', '得到：唱詩蠟 ×1（持有 0 → 1）', '這個交換只能做一次。']);
    expect(tradeDoneText(c)).toBe('交換完成：得到 唱詩蠟 ×1');
  });
});

describe('endingScreen（結局畫面）', () => {
  it('有結局：結局名稱＋end_screen.title＋致謝', () => {
    const v = endingScreen('fx_finale', base({ chapter: 'fx_finale', ending: 'fx_fog', chapter_done: ['fx_finale'] }), data);
    expect(v).toMatchObject({ id: 'fx_fog', title: '霧中行者', partTitle: '第一部　霧中鐘聲　完' });
    expect(v.credits).toEqual(['致謝', '（測試）謝謝艾琳陪我們走到這裡。']); // end_screen.credits，{name} 代入
  });
  it('M5 整合：end_screen 沒有 credits → 致謝是空陣列（畫面不再寫死致謝）', () => {
    const d = structuredClone(data);
    delete d.story.find((s) => s.id === 'fx_finale').end_screen.credits;
    expect(endingScreen('fx_finale', base({ chapter: 'fx_finale', ending: 'fx_fog', chapter_done: ['fx_finale'] }), d).credits).toEqual([]);
  });
  it('沒有結局或結局 id 不在該章 → null', () => {
    expect(endingScreen('fx_finale', base({ ending: null }), data)).toBeNull();
    expect(endingScreen('fx_ch4', base({ ending: 'fx_fog' }), data)).toBeNull();
    expect(endingScreen('fx_finale', base({ ending: 'nope' }), data)).toBeNull();
  });
});

describe('resumeScene（讀檔後的畫面）', () => {
  it('已完結的存檔（chapter_done＋ending）→ 結局畫面', () => {
    expect(resumeScene(base({ chapter: 'fx_finale', chapter_done: ['fx_ch4', 'fx_finale'], ending: 'fx_dawn' }), data)).toEqual({ scene: 'ChapterEnd', chapter: 'fx_finale' });
  });
  // M5 修正輪（惡意玩家回報）：已完結的存檔 ending 是 null 或非法 → 用 resolveEnding 重新判定，回結局畫面（不落在終章地圖）
  it.each([
    ['null', null],
    ['不存在的結局 id', 'true_end'],
    ['別章的 id（不是終章的結局）', 'fx_ch4'],
    ['不是字串', 42],
  ])('已完結但 ending 是 %s → 重新判定結局，回結局畫面並帶回判定後的 state', (_why, ending) => {
    const calm = base({ chapter: 'fx_finale', chapter_done: ['fx_ch4', 'fx_finale'], ending, flags: { fx5_trusted: true }, collapse: 10 });
    const r = resumeScene(calm, data);
    expect(r).toMatchObject({ scene: 'ChapterEnd', chapter: 'fx_finale' });
    expect(r.state.ending).toBe('fx_lamp');
    expect(endingScreen('fx_finale', r.state, data).id).toBe('fx_lamp');
    const frayed = resumeScene(base({ chapter: 'fx_finale', chapter_done: ['fx_finale'], ending, collapse: 80 }), data);
    expect(frayed.state.ending).toBe('fx_fog');
    expect(calm.ending).toBe(ending); // 純函式：不改輸入
  });
  it('合法 ending 不重新判定（不帶 state）', () => {
    const r = resumeScene(base({ chapter: 'fx_finale', chapter_done: ['fx_finale'], ending: 'fx_dawn', flags: { fx5_trusted: true } }), data);
    expect(r).toEqual({ scene: 'ChapterEnd', chapter: 'fx_finale' });
  });
  it('終章還沒完結 → 地圖；有 continue 的章節結尾 → 章節結束畫面', () => {
    expect(resumeScene(base({ chapter: 'fx_finale', chapter_done: ['fx_ch4'] }), data)).toEqual({ scene: 'Map' });
    const withContinue = structuredClone(data);
    withContinue.story[0].end_screen.continue = { map: 'fx_room', spawn: 'default' };
    expect(resumeScene(base({ chapter: 'fx_ch4', chapter_done: ['fx_ch4'] }), withContinue)).toEqual({ scene: 'ChapterEnd', chapter: 'fx_ch4' });
  });
});

describe('fieldTagLabel', () => {
  it('M5 整合：名稱來自資料（lineage rank 的 field_labels）；沒有就用標籤 id', () => {
    expect(fieldTagLabel('voice', data)).toBe('借聲');
    expect(fieldTagLabel('shadow', data)).toBe('換影');
    expect(fieldTagLabel('trace', data)).toBe('trace'); // fixture 的 rank 9 沒有 field_labels
    expect(fieldTagLabel('zzz', data)).toBe('zzz');
    expect(fieldTagLabel('voice')).toBe('voice'); // 沒有資料
  });
  it('正式資料：trace.json 每個階位的探索標籤都有顯示名稱', async () => {
    const { loadDir: ld, WEB_DATA_DIR } = await import('./load-fixture.js');
    const web = ld(WEB_DATA_DIR);
    expect(['trace', 'voice', 'shadow'].map((t) => fieldTagLabel(t, web))).toEqual(['讀痕', '借聲', '換影']);
  });
});
