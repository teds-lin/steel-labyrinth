// validate.js：M5（晉升 potion／promote／can_promote、交換 trades／open_trade、結局 endings／resolve_ending）。
import { describe, it, expect } from 'vitest';
import { validateBundle } from '../../web/src/core/validate.js';

const SCRIPTED = () => ({
  greeting: ['又見面了。'], fallback: ['霧太濃了。'], quota: ['今天先到這裡。'], filtered: ['當我沒說。'], not_open: ['（啟用雲端存檔後可以交談。）'],
});
const one = (id, text, extra = {}) => ({ id, start: 'n1', nodes: [{ id: 'n1', text, next: 'END', ...extra }] });
const POTION = () => ({ materials: [{ item: 'echo_moss', count: 2 }, { item: 'choir_wax', count: 1 }], resonance: 12, forced_collapse: 40 });

function fixture() {
  return {
    manifest: {
      chapters: ['chapter4', 'finale'],
      start: { map: 'room', spawn: 'default', dialogue: 'dlg_start' },
      files: { maps: ['room', 'dream'], story: ['chapter4', 'finale'], lineages: ['trace'] },
    },
    tiles: [{ id: 'wall', solid: true }, { id: 'floor', solid: false }],
    items: [{ id: 'echo_moss', name: '回聲苔' }, { id: 'choir_wax', name: '唱詩蠟' }, { id: 'sedative', name: '鎮靜香' }, { id: 'old_key', name: '舊鑰匙' }],
    lineages: [{ id: 'trace', ranks: [
      { rank: 9, name: '讀痕者', field: ['trace'] },
      { rank: 8, name: '借聲者', field: ['voice'], potion: POTION() },
    ] }],
    maps: [
      { id: 'room', name: '房間', tiles: ['......'], legend: { '.': 'floor' }, spawns: [{ id: 'default', x: 0, y: 0 }],
        objects: [
          { id: 'altar', x: 1, y: 0, solid: true, look: 'dlg_altar' },
          { id: 'bed', x: 2, y: 0, solid: true, look: 'dlg_bed', dream: { map: 'dream', spawn: 'center' } },
          { id: 'choir_door', x: 3, y: 0, solid: true, look: 'dlg_door', lock: { flag: 'choir_open', solvable_by: ['voice'], fallback: 'item:old_key', locked: 'dlg_door' } },
        ] },
      { id: 'dream', name: '夢中鐘塔', dream: true, tiles: ['....'], legend: { '.': 'floor' }, spawns: [{ id: 'center', x: 0, y: 0 }],
        objects: [{ id: 'g9', x: 1, y: 0, solid: true, guest: 'nine', look: 'dlg_nine' }] },
    ],
    story: [
      {
        id: 'chapter4', title: '第四章', end_screen: { title: '第四章　完', subtitle: '待續' },
        guests: [{ id: 'nine', name: '九點', scripted: SCRIPTED(), trades: [
          { id: 'nine_moss', label: '鎮靜香換回聲苔', give: [{ item: 'sedative', count: 1 }], get: [{ item: 'echo_moss', count: 1 }], if: { flag: 'met_nine' }, once: false },
          { id: 'nine_wax', label: '回聲苔換唱詩蠟', give: [{ item: 'echo_moss', count: 1 }], get: [{ item: 'choir_wax', count: 1 }], once: true },
        ] }],
        dialogues: [
          one('dlg_start', '醒來。', { effects: [{ set_lineage: { id: 'trace', rank: 9 } }, { give_item: 'echo_moss' }, { give_item: 'choir_wax' }, { give_item: 'sedative' }, { set_flag: 'met_nine' }] }),
          { id: 'dlg_altar', start: 'n1', nodes: [{ id: 'n1', text: '祭壇上有一瓶靈劑。', choices: [
            { text: '喝下', if: { can_promote: 8 }, effects: [{ promote: { lineage: 'trace', rank: 8 } }], next: 'END' },
            { text: '硬喝（共鳴不足）', if: { all: [{ can_promote: 8 }, { not: { resonance_gte: 12 } }] }, next: 'END' },
            { text: '離開', next: 'END' },
          ] }] },
          { id: 'dlg_bed', start: 'n1', nodes: [{ id: 'n1', text: '床。', choices: [
            { text: '睡', effects: [{ enter_dream: { map: 'dream', spawn: 'center' } }], next: 'END' }, { text: '不睡', next: 'END' }] }] },
          { id: 'dlg_nine', start: 'n1', nodes: [{ id: 'n1', text: '九點看著你。', choices: [
            { text: '交換', effects: [{ open_trade: 'nine' }], next: 'END' }, { text: '離開', next: 'END' }] }] },
          one('dlg_door', '門。'),
        ],
      },
      {
        id: 'finale', title: '終章', end_screen: { title: '第一部　完', subtitle: '感謝遊玩' },
        endings: [
          { id: 'lamp_kept', title: '燈火未熄', if: { all: [{ flag: 'trusted_marlo' }, { collapse_lte: 40 }] }, dialogue: 'dlg_end_a' },
          { id: 'fog_walker', title: '霧中行者', if: { collapse_gte: 70 }, dialogue: 'dlg_end_c' },
          { id: 'dawn', title: '黎明之前', dialogue: 'dlg_end_b' },
        ],
        dialogues: [
          one('dlg_final', '霧散了。', { effects: [{ resolve_ending: true }] }),
          one('dlg_end_a', '燈還亮著。', { effects: [{ chapter_end: 'finale' }] }),
          one('dlg_end_b', '天快亮了。', { effects: [{ chapter_end: 'finale' }] }),
          one('dlg_end_c', '你走進霧裡。', { effects: [{ chapter_end: 'finale' }] }),
        ],
      },
    ],
  };
}
const ch4 = (b) => b.story[0];
const fin = (b) => b.story[1];
const dlg = (b, id) => [...ch4(b).dialogues, ...fin(b).dialogues].find((d) => d.id === id);
const rank8 = (b) => b.lineages[0].ranks[1];
const nine = (b) => ch4(b).guests[0];
const expectError = (b, re) => {
  const errs = validateBundle(b);
  expect(errs.some((e) => re.test(e)), `預期有錯誤符合 ${re}，實際：\n${errs.join('\n')}`).toBe(true);
  return errs;
};
const expectOk = (b) => expect(validateBundle(b)).toEqual([]);

describe('validate M5：合法 fixture', () => {
  it('沒有錯誤', () => expectOk(fixture()));
});

describe('validate M5：rank 的 potion', () => {
  it.each([
    ['不是物件', () => 5, /potion 必須是物件/],
    ['多餘欄位', (p) => ({ ...p, color: 'red' }), /potion.*不認得的欄位「color」/],
    ['materials 不是陣列', (p) => ({ ...p, materials: {} }), /potion\.materials 必須是陣列/],
    ['材料道具不存在', (p) => ({ ...p, materials: [{ item: 'ghost', count: 1 }] }), /potion\.materials\[0\].*不存在的道具「ghost」/],
    ['材料數量 0', (p) => ({ ...p, materials: [{ item: 'echo_moss', count: 0 }] }), /potion\.materials\[0\].*count 必須是正整數/],
    ['材料數量小數', (p) => ({ ...p, materials: [{ item: 'echo_moss', count: 1.5 }] }), /count 必須是正整數/],
    ['材料項目多欄位', (p) => ({ ...p, materials: [{ item: 'echo_moss', count: 1, x: 1 }] }), /potion\.materials\[0\].*只能有 item、count/],
    ['同一道具重複', (p) => ({ ...p, materials: [{ item: 'echo_moss', count: 1 }, { item: 'echo_moss', count: 1 }] }), /重複/],
    ['resonance 負數', (p) => ({ ...p, resonance: -1 }), /potion\.resonance 必須是非負整數/],
    ['resonance 小數', (p) => ({ ...p, resonance: 1.5 }), /potion\.resonance 必須是非負整數/],
    ['resonance 缺少', ({ resonance, ...p }) => p, /potion\.resonance 必須是非負整數/],
    ['forced_collapse 負數', (p) => ({ ...p, forced_collapse: -5 }), /potion\.forced_collapse 必須是 0～100 的整數/],
    ['forced_collapse 超過 100', (p) => ({ ...p, forced_collapse: 101 }), /forced_collapse 必須是 0～100 的整數/],
    ['forced_collapse 缺少', ({ forced_collapse, ...p }) => p, /forced_collapse/],
  ])('%s → 報錯', (_, mut, re) => {
    const b = fixture();
    rank8(b).potion = mut(rank8(b).potion);
    expectError(b, re);
  });

  it('門檻 0、空材料陣列可以接受', () => {
    const b = fixture();
    rank8(b).potion = { materials: [], resonance: 0, forced_collapse: 0 };
    expectOk(b);
  });
});

describe('validate M5：promote 效果與 can_promote 條件', () => {
  const setPromote = (b, v) => { dlg(b, 'dlg_altar').nodes[0].choices[0].effects = [{ promote: v }]; };

  it('譜系不存在 → 報錯', () => {
    const b = fixture();
    setPromote(b, { lineage: 'ghost', rank: 8 });
    expectError(b, /promote 引用不存在的譜系「ghost」/);
  });

  it('目標階位不存在 → 報錯', () => {
    const b = fixture();
    setPromote(b, { lineage: 'trace', rank: 7 });
    expectError(b, /promote.*譜系「trace」沒有開放階位 7/);
  });

  it('只能升一階：目標的上一階（數字＋1）必須存在', () => {
    const b = fixture();
    b.lineages[0].ranks.push({ rank: 6, name: '跳階', potion: POTION() });
    setPromote(b, { lineage: 'trace', rank: 6 });
    expectError(b, /promote.*只能晉升一階.*rank 7/);
  });

  it('目標階位沒有 potion → 報錯', () => {
    const b = fixture();
    delete rank8(b).potion;
    expectError(b, /promote.*rank 8 沒有 potion/);
  });

  it('寫法錯誤 → 報錯', () => {
    const b = fixture();
    setPromote(b, { lineage: 'trace' });
    expectError(b, /「promote」的值不合法/);
  });

  it('can_promote：沒有任何譜系同時有階位 n 與 n＋1 → 報錯', () => {
    const b = fixture();
    dlg(b, 'dlg_altar').nodes[0].choices[0].if = { can_promote: 7 };
    expectError(b, /can_promote 7.*沒有任何譜系/);
  });

  it('can_promote 需要遊戲資料：不可用在地圖的物件 if／出口 requires／觸發點 if／入夢 if', () => {
    const cases = [
      (b) => { b.maps[0].objects[0].if = { can_promote: 8 }; },
      (b) => { b.maps[0].exits = [{ x: 5, y: 0, to: 'dream', spawn: 'center', requires: { any: [{ can_promote: 8 }] } }]; },
      (b) => { b.maps[0].triggers = [{ id: 't', x: 4, y: 0, dialogue: 'dlg_door', if: { not: { can_promote: 8 } } }]; },
      (b) => { b.maps[0].objects[1].dream.if = { can_promote: 8 }; },
    ];
    for (const mut of cases) {
      const b = fixture();
      mut(b);
      expectError(b, /can_promote 只能用在對話（選項、branches）、交換與結局的條件/);
    }
  });

  it('resonance_gte／collapse_lte／collapse_gte 在地圖條件可以用', () => {
    const b = fixture();
    b.maps[0].objects[0].if = { any: [{ resonance_gte: 3 }, { collapse_lte: 50 }, { collapse_gte: 0 }] };
    expectOk(b);
  });
});

describe('validate M5：晉升材料必須能從免費入口取得', () => {
  it('材料只在不可能成立的分支 → 報錯', () => {
    const b = fixture();
    const start = dlg(b, 'dlg_start').nodes[0];
    start.effects = start.effects.filter((e) => !e.give_item || e.give_item === 'sedative');
    // 回聲苔還能從九點換到（鎮靜香是免費的），但唱詩蠟要用回聲苔換——回聲苔可得，所以兩者都可得：先確認合法
    expectOk(b);
    // 拿掉鎮靜香 → 回聲苔、唱詩蠟都拿不到
    start.effects = start.effects.filter((e) => !e.give_item);
    const errs = expectError(b, /rank 8 的 potion 材料「echo_moss」無法從免費入口取得/);
    expect(errs.some((e) => /材料「choir_wax」無法從免費入口取得/.test(e))).toBe(true);
  });

  it('交換的 if 不可能成立時，不算免費取得', () => {
    const b = fixture();
    const start = dlg(b, 'dlg_start').nodes[0];
    start.effects = start.effects.filter((e) => e.give_item !== 'echo_moss' && e.give_item !== 'choir_wax' && !e.set_flag);
    expectError(b, /材料「echo_moss」無法從免費入口取得/);
  });

  it('沒有人開啟交換介面（沒有 open_trade）時，交換不算免費取得', () => {
    const b = fixture();
    const start = dlg(b, 'dlg_start').nodes[0];
    start.effects = start.effects.filter((e) => e.give_item !== 'echo_moss' && e.give_item !== 'choir_wax');
    dlg(b, 'dlg_nine').nodes[0].choices[0].effects = [];
    expectError(b, /材料「echo_moss」無法從免費入口取得/);
  });

  it('晉升之後，新階位的探索標籤（voice）可以當 lock 的免費解法（舊鑰匙拿不到也合法）', () => {
    expectOk(fixture()); // old_key 從來沒給過
    const b = fixture();
    rank8(b).potion.materials.push({ item: 'old_key', count: 1 }); // 喝不到 → voice 不免費、old_key 也不免費
    const errs = expectError(b, /choir_door.*lock\.fallback 道具「old_key」無法從免費入口取得/);
    expect(errs.some((e) => /材料「old_key」無法從免費入口取得/.test(e))).toBe(true);
  });

  it('collapse_gte 的分支：沒有任何增加崩解的來源時不算可能成立', () => {
    const b = fixture();
    const start = dlg(b, 'dlg_start').nodes[0];
    start.effects = start.effects.filter((e) => e.give_item !== 'choir_wax');
    b.story[0].dialogues.push({ id: 'dlg_wax', start: 'g', nodes: [
      { id: 'g', branches: [{ if: { collapse_gte: 60 }, next: 'give' }], next: 'END' },
      { id: 'give', text: '蠟。', effects: [{ give_item: 'choir_wax' }], next: 'END' },
    ] });
    b.maps[0].objects.push({ id: 'shelf', x: 4, y: 0, solid: true, look: 'dlg_wax' });
    ch4(b).guests[0].trades = [ch4(b).guests[0].trades[0]]; // 拿掉「回聲苔換唱詩蠟」
    expectError(b, /材料「choir_wax」無法從免費入口取得/);
    start.effects.push({ collapse: 60 });
    expectOk(b);
  });
});

describe('validate M5：trades', () => {
  it.each([
    ['trades 不是陣列', (g) => { g.trades = {}; }, /trades 必須是陣列/],
    ['缺 id', (g) => { delete g.trades[0].id; }, /trades\[0\] 缺少 id/],
    ['id 格式', (g) => { g.trades[0].id = 'Bad-Id'; }, /trades\[0\].*id「Bad-Id」格式不合法/],
    ['id 重複', (g) => { g.trades[1].id = 'nine_moss'; }, /交換 id「nine_moss」重複/],
    ['缺 label', (g) => { delete g.trades[0].label; }, /交換「nine_moss」：label 必須是非空字串/],
    ['label 只有空白', (g) => { g.trades[0].label = '  '; }, /label 必須是非空字串/],
    ['give 空', (g) => { g.trades[0].give = []; }, /交換「nine_moss」：give 必須是至少一項的陣列/],
    ['get 不是陣列', (g) => { g.trades[0].get = 'echo_moss'; }, /交換「nine_moss」：get 必須是至少一項的陣列/],
    ['道具不存在', (g) => { g.trades[0].get[0].item = 'ghost'; }, /交換「nine_moss」：get\[0\].*不存在的道具「ghost」/],
    ['數量不是正整數', (g) => { g.trades[0].give[0].count = 0; }, /交換「nine_moss」：give\[0\].*count 必須是正整數/],
    ['if 不合法', (g) => { g.trades[0].if = { bogus: 1 }; }, /交換「nine_moss」.*未知的條件寫法「bogus」/],
    ['if 引用不存在的道具', (g) => { g.trades[0].if = { item: 'ghost' }; }, /交換「nine_moss」.*條件引用不存在的道具「ghost」/],
    ['once 不是布林', (g) => { g.trades[0].once = 'yes'; }, /once 必須是 true\/false/],
    ['多餘欄位', (g) => { g.trades[0].price = 3; }, /交換「nine_moss」：不認得的欄位「price」/],
  ])('%s → 報錯', (_, mut, re) => {
    const b = fixture();
    mut(nine(b));
    expectError(b, re);
  });

  it('交換 id 跨夢客也必須唯一（applyTrade 只用交換 id 查詢）', () => {
    const b = fixture();
    ch4(b).guests.push({ id: 'three', name: '三點', scripted: SCRIPTED(), trades: [{ ...nine(b).trades[0] }] });
    expectError(b, /交換 id「nine_moss」重複/);
  });

  it('trades 的 if 可以用 can_promote', () => {
    const b = fixture();
    nine(b).trades[0].if = { can_promote: 8 };
    expectOk(b);
  });

  it('open_trade：夢客不存在、或沒有 trades → 報錯', () => {
    const b = fixture();
    dlg(b, 'dlg_nine').nodes[0].choices[0].effects = [{ open_trade: 'ghost' }];
    expectError(b, /open_trade 引用不存在的夢客「ghost」/);
    const c = fixture();
    delete nine(c).trades;
    expectError(c, /open_trade.*夢客「nine」沒有 trades/);
  });
});

describe('validate M5：endings 與 resolve_ending', () => {
  it.each([
    ['endings 不是陣列', (s) => { s.endings = {}; }, /endings 必須是至少一筆的陣列/],
    ['endings 空', (s) => { s.endings = []; }, /endings 必須是至少一筆的陣列/],
    ['最後一筆有 if', (s) => { s.endings[2].if = { flag: 'x' }; }, /endings 的最後一筆（「dawn」）必須沒有 if/],
    ['中間一筆沒有 if', (s) => { delete s.endings[1].if; }, /endings\[1\]（「fog_walker」）沒有 if，後面的結局永遠不會被選到/],
    ['id 重複', (s) => { s.endings[1].id = 'lamp_kept'; }, /結局 id「lamp_kept」重複/],
    ['id 格式', (s) => { s.endings[0].id = 'Lamp Kept'; }, /結局 id「Lamp Kept」格式不合法/],
    ['缺 title', (s) => { delete s.endings[0].title; }, /結局「lamp_kept」：title 必須是非空字串/],
    ['對話不存在', (s) => { s.endings[0].dialogue = 'dlg_nope'; }, /結局「lamp_kept」：dialogue 引用不存在的對話「dlg_nope」/],
    ['缺對話', (s) => { delete s.endings[0].dialogue; }, /結局「lamp_kept」：缺少 dialogue/],
    ['if 不合法', (s) => { s.endings[0].if = { nope: 1 }; }, /結局「lamp_kept」.*未知的條件寫法「nope」/],
    ['多餘欄位', (s) => { s.endings[0].art = 'x'; }, /結局「lamp_kept」：不認得的欄位「art」/],
  ])('%s → 報錯', (_, mut, re) => {
    const b = fixture();
    mut(fin(b));
    expectError(b, re);
  });

  it('結局對話必須有 chapter_end（該章）', () => {
    const b = fixture();
    dlg(b, 'dlg_end_b').nodes[0].effects = [];
    expectError(b, /結局「dawn」：結局對話「dlg_end_b」必須有 \{ "chapter_end": "finale" \}/);
  });

  it('結局 id 跨章節唯一', () => {
    const b = fixture();
    ch4(b).endings = [{ id: 'dawn', title: '又一個黎明', dialogue: 'dlg_end_b' }];
    expectError(b, /結局 id「dawn」重複/);
  });

  it('endings 的 if 可以用 can_promote', () => {
    const b = fixture();
    fin(b).endings[0].if = { can_promote: 8 };
    expectOk(b);
  });

  it('resolve_ending 只能出現在有 endings 的章節', () => {
    const b = fixture();
    ch4(b).dialogues.push(one('dlg_bad', '提早結束？', { effects: [{ resolve_ending: true }] }));
    expectError(b, /對話「dlg_bad」.*resolve_ending 只能用在有 endings 的章節（這裡是「chapter4」）/);
  });

  it('resolve_ending 不能放在道具 field_effects 或遭遇 on_win', () => {
    const b = fixture();
    b.items[0].field_effects = [{ resolve_ending: true }];
    expectError(b, /道具「echo_moss」.*resolve_ending 只能用在有 endings 的章節/);
    const c = fixture();
    c.characters = [{ id: 'hero', name: '{name}', base: { hp: 10, sp: 0, atk: 1, def: 0, spd: 1, will: 0, eva: 0 }, skills: ['attack'] }];
    c.skills = [{ id: 'attack', name: '攻擊', target: 'enemy', effects: [{ type: 'damage', power: 100 }] }];
    c.enemies = [{ id: 'rat', name: '老鼠', rank: 9, stats: { hp: 1, sp: 0, atk: 1, def: 0, spd: 1, will: 0, eva: 0 }, skills: ['attack'], ai: [{ skill: 'attack', weight: 1 }] }];
    c.encounters = [{ id: 'enc', enemies: ['rat'], on_win: { effects: [{ resolve_ending: true }] } }];
    expectError(c, /遭遇「enc」.*resolve_ending 只能用在有 endings 的章節/);
  });

  it('resolve_ending 寫法：只能是 true', () => {
    const b = fixture();
    dlg(b, 'dlg_final').nodes[0].effects = [{ resolve_ending: 'dawn' }];
    expectError(b, /「resolve_ending」的值不合法/);
  });
});
