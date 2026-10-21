// 字串匯出（tools/lib/strings.mjs）：M5 新欄位（trades.label、endings.title）與 M4 留下的待辦
// （章節 title、end_screen 的 title／subtitle、guests 的 name 與全部 scripted 台詞），以及「所有玩家看得到的欄位都被匯出」的守門測試。
import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { loadBundle } from '../../tools/lib/bundle.mjs';
import { collectStrings, assertUniqueIds } from '../../tools/lib/strings.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

const fixture = () => ({
  manifest: { chapters: ['chapter6', 'finale'], start: { map: 'room', spawn: 'd' } },
  tiles: [{ id: 'floor', solid: false, color: '#000' }],
  items: [{ id: 'echo_moss', name: '回聲苔', desc: '會發出低語的苔。' }],
  lineages: [{ id: 'trace', source: 'mirror', nature: '看穿真相', ranks: [
    { rank: 9, name: '讀痕者', field: ['trace'] },
    { rank: 8, name: '借聲者', field: ['voice'], field_labels: { voice: '借聲' }, potion: { materials: [{ item: 'echo_moss', count: 2 }], resonance: 12, forced_collapse: 40 } },
  ] }],
  maps: [{ id: 'room', name: '房間', tiles: ['..'], legend: { '.': 'floor' }, spawns: [{ id: 'd', x: 0, y: 0, dir: 'down' }],
    objects: [{ id: 'bed', x: 1, y: 0, dream: { map: 'room', spawn: 'd', prompt: '睏了。', yes: '睡', no: '不睡' } }] }],
  story: [
    { id: 'chapter6', title: '隊長的祕密', end_screen: { title: '第六章　完', subtitle: '第七章　最濃的霧夜', continue: { map: 'room', spawn: 'd' } },
      guests: [{ id: 'nine', name: '九點', sprite: 'guest_nine', scripted: {
        greeting: ['……你來了。', '鐘還在走。'], fallback: ['霧太濃了。'], quota: ['今天先到這裡。'], filtered: ['當我沒說。'], not_open: ['（啟用雲端存檔後可以交談。）'] },
        trades: [{ id: 'nine_moss', label: '兩包鎮靜香換一份回聲苔', give: [{ item: 'echo_moss', count: 2 }], get: [{ item: 'echo_moss', count: 1 }], if: { flag: 'x' }, once: true }] }],
      dialogues: [{ id: 'dlg_a', start: 'n1', nodes: [{ id: 'n1', speaker: '九點', text: '要換嗎？', effects: [{ open_trade: 'nine' }], next: 'END' }] }] },
    { id: 'finale', title: '霧散之後', end_screen: { title: '第一部　完', subtitle: '感謝遊玩', credits: ['致謝', '謝謝遊玩'] },
      endings: [{ id: 'lamp_kept', title: '燈火未熄', if: { collapse_lte: 40 }, dialogue: 'dlg_a' }, { id: 'dawn', title: '黎明之前', dialogue: 'dlg_a' }],
      dialogues: [] },
  ],
});

describe('collectStrings：M5 新欄位與 M4 待辦', () => {
  const rows = collectStrings(fixture());
  const byId = new Map(rows.map((r) => [r.unique_id, r.text]));

  it.each([
    ['story/chapter6.json#title', '隊長的祕密'],
    ['story/chapter6.json#end_screen.title', '第六章　完'],
    ['story/chapter6.json#end_screen.subtitle', '第七章　最濃的霧夜'],
    ['story/chapter6.json#guests.nine.name', '九點'],
    ['story/chapter6.json#guests.nine.scripted.greeting[0]', '……你來了。'],
    ['story/chapter6.json#guests.nine.scripted.greeting[1]', '鐘還在走。'],
    ['story/chapter6.json#guests.nine.scripted.fallback[0]', '霧太濃了。'],
    ['story/chapter6.json#guests.nine.scripted.quota[0]', '今天先到這裡。'],
    ['story/chapter6.json#guests.nine.scripted.filtered[0]', '當我沒說。'],
    ['story/chapter6.json#guests.nine.scripted.not_open[0]', '（啟用雲端存檔後可以交談。）'],
    ['story/chapter6.json#guests.nine.trades.nine_moss.label', '兩包鎮靜香換一份回聲苔'],
    ['story/finale.json#title', '霧散之後'],
    ['story/finale.json#endings.lamp_kept.title', '燈火未熄'],
    ['story/finale.json#endings.dawn.title', '黎明之前'],
    ['lineages/trace.json#nature', '看穿真相'],
    ['lineages/trace.json#ranks.9.name', '讀痕者'],
    ['lineages/trace.json#ranks.8.name', '借聲者'],
    ['lineages/trace.json#ranks.8.field_labels.voice', '借聲'],
    ['story/finale.json#end_screen.credits[0]', '致謝'],
    ['story/finale.json#end_screen.credits[1]', '謝謝遊玩'],
  ])('%s', (id, text) => {
    expect(byId.get(id)).toBe(text);
  });

  it('unique_id 唯一', () => {
    expect(() => assertUniqueIds(rows)).not.toThrow();
  });
});

// ---------- 守門：bundle 裡每一個字串欄位都必須「匯出」或「明確標記為不是玩家看得到的」 ----------

/** 走訪所有字串葉節點，路徑正規化：陣列索引 → []、legend 的鍵 → legend.*。 */
function stringLeaves(bundle) {
  const out = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, `${path}[]`));
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, /\.legend$/.test(path) ? `${path}.*` : `${path}.${k}`);
    } else if (typeof v === 'string') out.push({ path, text: v });
  };
  for (const [k, v] of Object.entries(bundle)) walk(v, k);
  return out;
}

/** 玩家看得到、必須匯出的欄位（正規化路徑）。 */
const VISIBLE = [
  /^maps\[\]\.name$/, /^maps\[\]\.objects\[\]\.dream\.(prompt|yes|no)$/,
  /^items\[\]\.(name|desc)$/,
  /^lineages\[\]\.nature$/, /^lineages\[\]\.ranks\[\]\.name$/,
  /^characters\[\]\.name$/, /^skills\[\]\.(name|desc)$/, /^enemies\[\]\.(name|summon_text)$/,
  /^story\[\]\.title$/, /^story\[\]\.end_screen\.(title|subtitle)$/, /^story\[\]\.end_screen\.credits\[\]$/,
  /^lineages\[\]\.ranks\[\]\.field_labels\.[a-z_]+$/,
  /^story\[\]\.guests\[\]\.name$/, /^story\[\]\.guests\[\]\.scripted\.[a-z_]+\[\]$/, /^story\[\]\.guests\[\]\.trades\[\]\.label$/,
  /^story\[\]\.endings\[\]\.title$/,
  /^manifest\.title_footer$/, // 標題畫面底部的版本名稱
  /^story\[\]\.dialogues\[\]\.nodes\[\]\.(speaker|text)$/, /^story\[\]\.dialogues\[\]\.nodes\[\]\.choices\[\]\.text$/,
];
/** 不是玩家看得到的字串（id、引用、條件、效果、地形字元、顏色……）。 */
const HIDDEN = [
  /(^|\.)id$/, /^manifest\.(?!title_footer$)/, /^tiles\[\]\.color$/,
  /\.(if|requires|not|all|any)(\.|\[|$)/, // 條件子樹
  /\.(effects|field_effects|battle_effects|add_ai)\[\]/, // 效果、AI 規則
  /^items\[\]\.target$/,
  /^lineages\[\]\.source$/, /^lineages\[\]\.ranks\[\]\.(field|skills)\[\]$/, /^lineages\[\]\.ranks\[\]\.potion\.materials\[\]\.item$/,
  /^maps\[\]\.(tiles\[\]|legend\.\*|on_enter)$/, /^maps\[\]\.spawns\[\]\.dir$/,
  /^maps\[\]\.objects\[\]\.(sprite|look|echo|guest|battle)$/, /^maps\[\]\.objects\[\]\.lock\./, /^maps\[\]\.objects\[\]\.dream\.(map|spawn)$/,
  /^maps\[\]\.exits\[\]\.(to|spawn|blocked)$/, /^maps\[\]\.triggers\[\]\.(dialogue|battle)$/,
  /^characters\[\]\.(sprite|skills\[\]|lineage\.id)$/,
  /^skills\[\]\.(target|menu|tags\[\])$/,
  /^enemies\[\]\.(sprite|skills\[\]|ai\[\]\.skill|phases\[\]\.dialogue|drops\[\]\.item)$/,
  /^encounters\[\]\./,
  /^story\[\]\.end_screen\.continue\./, /^story\[\]\.guests\[\]\.sprite$/,
  /^story\[\]\.guests\[\]\.trades\[\]\.(give|get)\[\]\.item$/, /^story\[\]\.endings\[\]\.dialogue$/,
  /^story\[\]\.dialogues\[\]\.start$/, /^story\[\]\.dialogues\[\]\.nodes\[\]\.(next|branches\[\]\.next|choices\[\]\.next)$/,
];

function checkComplete(bundle, label) {
  const leaves = stringLeaves(bundle);
  const unknown = [...new Set(leaves.filter((l) => !VISIBLE.some((re) => re.test(l.path)) && !HIDDEN.some((re) => re.test(l.path))).map((l) => l.path))];
  expect(unknown, `${label}：這些字串欄位還沒決定要不要匯出（玩家看得到 → 加進 tools/lib/strings.mjs 與這裡的 VISIBLE；看不到 → 加進 HIDDEN）`).toEqual([]);
  const visible = leaves.filter((l) => VISIBLE.some((re) => re.test(l.path)) && !HIDDEN.some((re) => re.test(l.path))).map((l) => l.text).sort();
  const rows = collectStrings(bundle);
  assertUniqueIds(rows);
  expect(rows.map((r) => r.text).sort(), `${label}：匯出的字串必須剛好是所有玩家看得到的字串`).toEqual(visible);
}

describe('守門：所有玩家看得到的欄位都被匯出', () => {
  it('M5 fixture', () => checkComplete(fixture(), 'M5 fixture'));

  it('目前的公開資料（web/data）', () => {
    const { bundle, errors } = loadBundle(join(ROOT, 'web', 'data'));
    expect(errors).toEqual([]);
    checkComplete(bundle, 'web/data');
  });
});
