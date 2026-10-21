// 戰鬥選單的說明框與清單版面（web/src/battle-view.js）：技能／道具按鈕只放短資訊，完整描述放在說明框，且不截斷。
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  skillSub, itemSub, helpText, HELP_BOX, costText, listLayout, menuTitle, shouldFocusFirst, subWithHint, TAP_AGAIN_HINT,
  estimateHelpLines,
} from '../../web/src/battle-view.js';

const readData = (rel) => JSON.parse(readFileSync(new URL(`../../web/data/${rel}`, import.meta.url), 'utf8'));
const SKILLS = readData('skills.json');
const ITEMS = readData('items.json');
const CHARACTERS = readData('characters.json');
const WRAP = 360 - 32;
const SCREEN_H = 640;
const SAFE_BOTTOM = 632; // 離畫面底邊至少 8px（手機 Home 指示條）

describe('按鈕短資訊', () => {
  it('技能：可用只放消耗，不可用接上原因，不含描述', () => {
    const s = { cost: { sp: 4 }, desc: '很長的描述', usable: true };
    expect(skillSub(s)).toBe('靈性 4');
    expect(skillSub({ ...s, usable: false, reason: 'sp' })).toBe('靈性 4｜靈性不足');
    expect(skillSub({ ...s, cost: {} })).toBe('不消耗');
    expect(skillSub(s)).toBe(costText(s.cost));
  });
  it('道具：可用沒有副標，不可用說明原因', () => {
    expect(itemSub(true)).toBeNull();
    expect(itemSub(false)).toBe('沒有可選的目標');
  });
});

describe('helpText', () => {
  it('取 detail 完整字串，不截斷', () => {
    const long = '字'.repeat(200);
    expect(helpText({ detail: long })).toBe(long);
  });
  it('沒有 detail（下一頁、返回、空項目）回空字串', () => {
    expect(helpText({ label: '返回' })).toBe('');
    expect(helpText(undefined)).toBe('');
    expect(helpText({ detail: '   ' })).toBe('');
  });
});

describe('listLayout：說明框在清單面板內，不往戰場長', () => {
  const L = listLayout();
  const buttonsTop = L.buttons.firstCenter - L.buttons.h / 2;
  const buttonsBottom = (n) => buttonsTop + n * L.buttons.h + (n - 1) * L.buttons.gap;
  it('面板頂在 316，說明框完全在面板內', () => {
    expect(L.panelTop).toBe(316);
    expect(L.help.y).toBeGreaterThanOrEqual(316);
  });
  it('標題、說明框、按鈕由上而下互不重疊', () => {
    expect(L.title.bottom).toBeLessThanOrEqual(L.help.y);
    expect(L.help.y + L.help.h).toBeLessThanOrEqual(buttonsTop);
  });
  it('一頁最多 5 個條目也放得下，且離底邊至少 8px', () => {
    expect(buttonsBottom(5)).toBeLessThanOrEqual(SAFE_BOTTOM);
    expect(SAFE_BOTTOM).toBeLessThan(SCREEN_H);
  });
  it('按鈕高度至少 44px', () => {
    expect(L.buttons.h).toBeGreaterThanOrEqual(44);
  });
  it('文字區預留行高有餘裕：Linux Chromium 兩行實測 43px，其他平台字型可能再高，至少留 3px', () => {
    expect(L.help.textCap).toBeGreaterThanOrEqual(43 + 3);
  });
  it('說明框的文字區容得下預留行數（15px）', () => {
    expect(HELP_BOX.fontSize).toBeGreaterThanOrEqual(15);
    expect(L.help.h - HELP_BOX.padY * 2).toBeGreaterThanOrEqual(HELP_BOX.lines * HELP_BOX.fontSize + (HELP_BOX.lines - 1) * HELP_BOX.lineSpacing);
  });
});

describe('玩家選單的描述都放得下預留行數', () => {
  // 玩家拿得到的技能＝角色本身的技能＋各譜系每一階解鎖的技能（敵人專用技能如 silence 不會出現在玩家選單，不納入）。
  const lineageSkills = readdirSync(new URL('../../web/data/lineages/', import.meta.url))
    .flatMap((f) => readData(`lineages/${f}`).ranks.flatMap((r) => r.skills ?? []));
  const playerIds = new Set([...CHARACTERS.flatMap((c) => c.skills ?? []), ...lineageSkills]);
  const rootIds = new Set(SKILLS.filter((s) => s.menu === 'root').map((s) => s.id));
  const all = [
    ...SKILLS.filter((s) => playerIds.has(s.id) && !rootIds.has(s.id)).map((s) => ({ id: `skill:${s.id}`, desc: s.desc })),
    ...ITEMS.map((i) => ({ id: `item:${i.id}`, desc: i.desc })),
  ];
  it('有納入玩家技能（資料判斷沒有退化成空集合）', () => {
    expect(all.filter((x) => x.id.startsWith('skill:')).length).toBeGreaterThanOrEqual(8);
    expect(all.some((x) => x.id === 'skill:silence')).toBe(false);
  });
  it('每一項都有描述', () => {
    for (const x of all) expect(typeof x.desc === 'string' && x.desc.length > 0, x.id).toBe(true);
  });
  it(`以 ${HELP_BOX.fontSize}px、寬 ${WRAP}px（中文＝字級寬、逐字換行）估算，不超過 ${HELP_BOX.lines} 行；日後加長描述會在這裡擋下`, () => {
    for (const x of all) expect(estimateHelpLines(x.desc, WRAP), `${x.id}：${x.desc}`).toBeLessThanOrEqual(HELP_BOX.lines);
  });
});

describe('menuTitle：子選單標題（行動者名字已在上方提示句，不重複）', () => {
  it('技能：技能　靈性 42/42', () => {
    expect(menuTitle('skills', { sp: 42, maxSp: 42 })).toBe('技能　靈性 42/42');
  });
  it('道具：道具', () => {
    expect(menuTitle('items')).toBe('道具');
  });
});

describe('觸控：第一次點未聚焦的清單項目只聚焦', () => {
  const base = { touch: true, layout: 'list', focused: false, hasDetail: true };
  it('觸控＋清單＋未聚焦＋有說明 → 只聚焦', () => {
    expect(shouldFocusFirst(base)).toBe(true);
  });
  it('已聚焦、滑鼠、第一層格子、下一頁／返回（沒有說明）都直接生效', () => {
    expect(shouldFocusFirst({ ...base, focused: true })).toBe(false);
    expect(shouldFocusFirst({ ...base, touch: false })).toBe(false);
    expect(shouldFocusFirst({ ...base, layout: 'grid' })).toBe(false);
    expect(shouldFocusFirst({ ...base, hasDetail: false })).toBe(false);
  });
  it('提示字是「點一下使用」', () => {
    expect(TAP_AGAIN_HINT).toBe('點一下使用');
  });
  it('提示字接在副標後面；沒有副標時只有提示', () => {
    expect(subWithHint('靈性 4', true)).toBe(`靈性 4｜${TAP_AGAIN_HINT}`);
    expect(subWithHint(null, true)).toBe(TAP_AGAIN_HINT);
    expect(subWithHint('靈性 4', false)).toBe('靈性 4');
    expect(subWithHint(null, false)).toBe('');
  });
});
