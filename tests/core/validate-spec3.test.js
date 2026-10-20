// 規格補充 3 第 3、4 條：隊伍上限要算進 leave_party（輪替隊友不誤報）、一次性觸發點不能接可逃跑的戰鬥。
// 用真實資料（web/data）改一小處，對應審查者的重現腳本 val.mjs。
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadBundle } from '../../tools/lib/bundle.mjs';
import { validateBundle } from '../../web/src/core/validate.js';

const DATA_DIR = fileURLToPath(new URL('../../web/data/', import.meta.url));
const base = loadBundle(DATA_DIR).bundle;
const fresh = () => structuredClone(base);
const dlgOf = (b, chapter, id) => b.story.find((s) => s.id === chapter).dialogues.find((d) => d.id === id);
const partyErrors = (b) => validateBundle(b).filter((e) => /隊伍上限/.test(e));

describe('第 3 條：隊伍上限（可能同時在隊的人數）', () => {
  it('真實資料沒有錯誤', () => {
    expect(validateBundle(fresh())).toEqual([]);
  });
  it('輪替（審查者 val.mjs 情境 A）：艾妲離隊 → 馬洛入隊 → 賀伯入隊，任何時刻 ≤ 3 人，不報錯', () => {
    const b = fresh();
    const d = dlgOf(b, 'chapter2', 'dlg_rest');
    d.nodes[0].effects = [{ leave_party: 'ada' }, { join_party: 'marlo' }];
    d.nodes[1].effects = [{ join_party: 'herb' }];
    expect(validateBundle(b)).toEqual([]);
  });
  it('反例：艾妲沒離隊，馬洛、賀伯又入隊（同時 4 人）→ 報錯', () => {
    const b = fresh();
    const d = dlgOf(b, 'chapter2', 'dlg_rest');
    d.nodes[0].effects = [{ join_party: 'marlo' }];
    d.nodes[1].effects = [{ join_party: 'herb' }];
    expect(partyErrors(b)).toHaveLength(1);
    expect(partyErrors(b)[0]).toMatch(/4 人/);
  });
  it('反例：離隊在入隊之後（賀伯入隊的當下是 4 人）→ 報錯', () => {
    const b = fresh();
    const d = dlgOf(b, 'chapter2', 'dlg_rest');
    d.nodes[0].effects = [{ join_party: 'marlo' }, { join_party: 'herb' }];
    d.nodes[1].effects = [{ leave_party: 'ada' }];
    expect(partyErrors(b)).toHaveLength(1);
  });
  it('反例：離隊只在其中一個選項（另一條路艾妲還在）→ 報錯', () => {
    const b = fresh();
    const d = dlgOf(b, 'chapter2', 'dlg_rest');
    d.nodes[0].next = undefined;
    d.nodes[0].choices = [
      { text: '請艾妲先回去', effects: [{ leave_party: 'ada' }], next: d.nodes[1].id },
      { text: '一起走', next: d.nodes[1].id },
    ];
    d.nodes[1].effects = [{ join_party: 'marlo' }, { join_party: 'herb' }];
    expect(partyErrors(b)).toHaveLength(1);
  });
  it('反例：離隊後艾妲又回來（之後還有 join_party ada）→ 報錯', () => {
    const b = fresh();
    const d = dlgOf(b, 'chapter2', 'dlg_rest');
    d.nodes[0].effects = [{ leave_party: 'ada' }, { join_party: 'marlo' }];
    d.nodes[1].effects = [{ join_party: 'herb' }];
    d.nodes[2].effects = [{ join_party: 'ada' }];
    expect(partyErrors(b)).toHaveLength(1);
  });
  it('反例：離隊放在同一章的另一段對話（不保證先播）→ 保守報錯', () => {
    const b = fresh();
    dlgOf(b, 'chapter2', 'dlg_rest').nodes[0].effects = [{ join_party: 'marlo' }, { join_party: 'herb' }];
    // M5：改挑地圖物件直接引用的對話（玩家可以在任何時候調查）；章節開場對話（end_screen.continue）一定先播，見下一個測試
    const lookIds = new Set(b.maps.flatMap((m) => (m.objects ?? []).map((o) => o.look)));
    const other = b.story.find((s) => s.id === 'chapter2').dialogues.find((x) => x.id !== 'dlg_rest' && x.nodes.length > 1 && lookIds.has(x.id));
    other.nodes[0].effects = [...(other.nodes[0].effects ?? []), { leave_party: 'ada' }];
    expect(partyErrors(b)).toHaveLength(1);
  });
  it('M5：離隊放在本章的開場對話（上一章 end_screen.continue，一定先播）→ 不報錯', () => {
    const b = fresh();
    dlgOf(b, 'chapter2', 'dlg_rest').nodes[0].effects = [{ join_party: 'marlo' }, { join_party: 'herb' }];
    const opening = b.story.find((s) => s.id === 'chapter1').end_screen.continue.dialogue;
    const d = dlgOf(b, 'chapter2', opening);
    d.nodes[0].effects = [...(d.nodes[0].effects ?? []), { leave_party: 'ada' }];
    expect(partyErrors(b)).toEqual([]);
  });
});

describe('M5：隊伍上限依劇情順序追蹤（章節順序、對話裡 join／leave 的先後、旗標分歧）', () => {
  const dlg = (b, ch, id) => dlgOf(b, ch, id);
  const strip = (d, pred) => { for (const n of d.nodes) { if (n.effects) n.effects = n.effects.filter((e) => !pred(e)); } };
  it('真實資料（第四章～終章已開放）：艾妲、賀伯、馬洛三人輪替，任何時刻 ≤ 3 人 → 不報錯', () => {
    expect(partyErrors(fresh())).toEqual([]);
  });
  it('反例：第五章艾妲沒有離隊 → 第六章馬洛入隊時 4 人 → 報錯', () => {
    const b = fresh();
    strip(dlg(b, 'chapter5', 'dlg_ch5_bracelet_echo'), (e) => e.leave_party === 'ada');
    expect(partyErrors(b)).toHaveLength(1);
    expect(partyErrors(b)[0]).toMatch(/ada.*herb.*marlo.*4 人/);
  });
  it('反例：第六章舉報後馬洛沒有離隊 → 第七章艾妲入隊（賀伯同行那條路）時 4 人 → 報錯', () => {
    const b = fresh();
    strip(dlg(b, 'chapter6', 'dlg_ch6_statement'), (e) => e.leave_party === 'marlo');
    expect(partyErrors(b)).toHaveLength(1);
  });
  it('反例：第七章兵分兩路時賀伯沒有離隊 → 馬洛在燈塔歸隊時 4 人 → 報錯', () => {
    const b = fresh();
    strip(dlg(b, 'chapter7', 'dlg_ch7_opening'), (e) => e.leave_party === 'herb');
    expect(partyErrors(b)).toHaveLength(1);
  });
  it('反例：第七章賀伯同行那條路的分歧條件跟馬洛離隊無關（不保證馬洛已離隊）→ 報錯', () => {
    const b = fresh();
    const n = dlg(b, 'chapter7', 'dlg_ch7_opening').nodes.find((x) => x.branches?.some((br) => br.next === 'r1'));
    n.branches = n.branches.map((br) => (br.next === 'r1' ? { ...br, if: { flag: 'ch6_mirror_heard' } } : br));
    expect(partyErrors(b)).toHaveLength(1);
  });
  it('反例：第六章馬洛的離隊放在另一段不保證先播的對話 → 保守報錯', () => {
    const b = fresh();
    strip(dlg(b, 'chapter6', 'dlg_ch6_statement'), (e) => e.leave_party === 'marlo');
    // 閣樓的鏡子：玩家可以在鐘匠巷之前或之後去，順序不保證
    const mirrorLook = b.maps.find((m) => m.id === 'attic_ch6').objects.find((o) => o.id === 'obj_ch6_mirror').look;
    const other = b.story.find((s) => s.id === 'chapter6').dialogues.find((x) => x.id === mirrorLook);
    other.nodes[0].effects = [...(other.nodes[0].effects ?? []), { leave_party: 'marlo' }];
    expect(partyErrors(b)).toHaveLength(1);
  });
});

describe('第 4 條：once 的觸發點不能接可逃跑的戰鬥', () => {
  const trg = (b, map, id) => b.maps.find((m) => m.id === map).triggers.find((t) => t.id === id);
  it('觸發點對話裡有 battle（enc_dock_1 can_flee）＋ once: true → 報錯', () => {
    const b = fresh();
    trg(b, 'dock', 'trg_fog1_1').once = true;
    const errs = validateBundle(b);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/trg_fog1_1.*once.*逃跑/);
  });
  it('觸發點本身的 battle（can_flee）＋ once: true → 報錯', () => {
    const b = fresh();
    Object.assign(trg(b, 'dock', 'trg_fog1_2'), { once: true, battle: 'enc_dock_2' });
    // 觸發點本身的 enc_dock_2 與對話裡的 enc_dock_1 各報一次
    const errs = validateBundle(b).filter((e) => /trg_fog1_2/.test(e));
    expect(errs.some((e) => /enc_dock_2/.test(e))).toBe(true);
    expect(errs.every((e) => /once.*逃跑/.test(e))).toBe(true);
  });
  it('不能逃跑的戰鬥（enc_boss）＋ once: true → 合法', () => {
    const b = fresh();
    Object.assign(trg(b, 'warehouse', 'trg_boss_warn_a'), { once: true, battle: 'enc_boss' });
    expect(validateBundle(b)).toEqual([]);
  });
});

describe('技能說明寫出關鍵規則（N5）', () => {
  const desc = (id) => base.skills.find((s) => s.id === id).desc;
  it('預兆：該次行動對我方的傷害與崩解減半', () => {
    expect(desc('omen')).toMatch(/傷害與崩解減半/);
  });
  it('催眠：受到攻擊會醒來，但第一下傷害提高', () => {
    expect(desc('hypnosis')).toMatch(/受到攻擊會醒來.*第一下傷害提高/);
  });
});
