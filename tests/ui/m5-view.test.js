// 畫面層 M5 純邏輯（web/src/ui/m5-view.js）：晉升進度與演出、晉升失敗說明、交換清單、結局畫面、讀檔後的畫面、探索標籤名稱。
import { describe, it, expect } from 'vitest';
import { loadDir, M5_FIXTURE_DIR } from './load-fixture.js';
import { validateBundle } from '../../web/src/core/validate.js';
import { applyEffect } from '../../web/src/core/effects.js';
import { applyTrade } from '../../web/src/core/trade.js';
import {
  promotionProgress, promotionFxView, promoteFailedDialogue, tradeRows, tradeConfirm, tradeDoneText,
  endingScreen, resumeScene, fieldTagLabel, CREDITS,
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
    expect(v.credits[0]).toBe('致謝');
    expect(CREDITS.length).toBeGreaterThan(1);
    expect(v.credits.join('\n')).toContain('艾琳');
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
  it('終章還沒完結 → 地圖；有 continue 的章節結尾 → 章節結束畫面', () => {
    expect(resumeScene(base({ chapter: 'fx_finale', chapter_done: ['fx_ch4'] }), data)).toEqual({ scene: 'Map' });
    const withContinue = structuredClone(data);
    withContinue.story[0].end_screen.continue = { map: 'fx_room', spawn: 'default' };
    expect(resumeScene(base({ chapter: 'fx_ch4', chapter_done: ['fx_ch4'] }), withContinue)).toEqual({ scene: 'ChapterEnd', chapter: 'fx_ch4' });
  });
});

describe('fieldTagLabel', () => {
  it('voice＝借聲、shadow＝換影；不認得的照原樣', () => {
    expect(fieldTagLabel('voice')).toBe('借聲');
    expect(fieldTagLabel('shadow')).toBe('換影');
    expect(fieldTagLabel('zzz')).toBe('zzz');
  });
});
