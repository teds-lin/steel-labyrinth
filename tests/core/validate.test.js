import { describe, it, expect } from 'vitest';
import { validateBundle } from '../../web/src/core/validate.js';

// 最小但完整的合法 bundle：閣樓（有門）→ 樓梯間。
function fixture() {
  return {
    manifest: {
      chapters: ['prologue'],
      start: { map: 'attic', spawn: 'default', dialogue: 'dlg_opening' },
      files: { maps: ['attic', 'stairs'], story: ['prologue'], lineages: ['trace'] },
    },
    tiles: [{ id: 'wall', solid: true, color: '#000' }, { id: 'floor', solid: false, color: '#555' }],
    items: [{ id: 'attic_key', name: '閣樓鑰匙', desc: '生鏽的鑰匙' }],
    lineages: [{ id: 'trace', ranks: [{ rank: 9, field: ['trace'] }] }],
    maps: [
      {
        id: 'attic', name: '閣樓',
        tiles: ['#####', '#...#', '#...#', '##.##', '##.##'],
        legend: { '#': 'wall', '.': 'floor' },
        spawns: [{ id: 'default', x: 1, y: 1, dir: 'down' }, { id: 'from_stairs', x: 2, y: 2, dir: 'up' }],
        on_enter: 'dlg_enter',
        objects: [
          { id: 'obj_vial', x: 3, y: 1, solid: true, look: 'dlg_vial_look', echo: 'dlg_vial_echo', if: { not_flag: 'vial_broken' } },
          { id: 'obj_door', x: 2, y: 3, solid: true, look: 'dlg_door_look', lock: {
            flag: 'door_open', solvable_by: ['trace'], fallback: 'item:attic_key',
            on_tag: { trace: 'dlg_door_echo' }, on_item: 'dlg_door_key', locked: 'dlg_door_locked' } },
        ],
        exits: [{ x: 2, y: 4, to: 'stairs', spawn: 'from_attic', requires: { flag: 'door_open' }, blocked: 'dlg_door_locked' }],
        triggers: [{ id: 'trg_window', x: 1, y: 2, dialogue: 'dlg_enter', once: true }, { id: 'trg_end', x: 3, y: 2, dialogue: 'dlg_end', once: true }],
      },
      {
        id: 'stairs', name: '樓梯間',
        tiles: ['#.#', '#.#'], legend: { '#': 'wall', '.': 'floor' },
        spawns: [{ id: 'from_attic', x: 1, y: 1, dir: 'down' }],
        objects: [], exits: [{ x: 1, y: 0, to: 'attic', spawn: 'from_stairs' }], triggers: [],
      },
    ],
    story: [{
      id: 'prologue', title: '序章', end_screen: { title: '序章　完', subtitle: '第一章　製作中' }, dialogues: [
        { id: 'dlg_opening', start: 'n1', nodes: [{ id: 'n1', speaker: null, text: '醒來。', next: 'END' }] },
        { id: 'dlg_enter', start: 'n1', nodes: [{ id: 'n1', text: '閣樓。', next: 'END' }] },
        { id: 'dlg_vial_look', start: 'gate', nodes: [
          { id: 'gate', branches: [{ if: { flag: 'got_key' }, next: 'again' }], next: 'n1' },
          { id: 'n1', speaker: '{name}', text: '瓶底有鑰匙。', effects: [{ give_item: 'attic_key' }, { set_flag: 'got_key' }], next: 'END' },
          { id: 'again', text: '空瓶。', next: 'END' },
        ] },
        { id: 'dlg_vial_echo', start: 'n1', nodes: [
          { id: 'n1', text: '要怎麼做？', choices: [
            { text: '算了', next: 'END' },
            { text: '看穿', if: { echo_gte: 1 }, next: 'n2', effects: [{ resonance: 'lie' }] },
          ] },
          { id: 'n2', text: '你看見了。', effects: [{ collapse: 5 }], next: 'END' },
        ] },
        { id: 'dlg_door_look', start: 'n1', nodes: [{ id: 'n1', text: '門。', next: 'END' }] },
        { id: 'dlg_door_echo', start: 'n1', nodes: [{ id: 'n1', text: '門鎖記得。', next: 'END' }] },
        { id: 'dlg_door_key', start: 'n1', nodes: [{ id: 'n1', text: '鑰匙轉動。', next: 'END' }] },
        { id: 'dlg_door_locked', start: 'n1', nodes: [{ id: 'n1', text: '鎖著。', next: 'END' }] },
        { id: 'dlg_end', start: 'n1', nodes: [{ id: 'n1', text: '完。', effects: [{ chapter_end: 'prologue' }], next: 'END' }] },
      ],
    }],
  };
}
const dlgOf = (b, id) => b.story[0].dialogues.find((d) => d.id === id);
const attic = (b) => b.maps[0];
const expectError = (b, re) => {
  const errs = validateBundle(b);
  expect(errs.some((e) => re.test(e)), `預期有錯誤符合 ${re}，實際：\n${errs.join('\n')}`).toBe(true);
  return errs;
};

describe('validateBundle：合法資料', () => {
  it('fixture 沒有錯誤', () => {
    expect(validateBundle(fixture())).toEqual([]);
  });
  it('不修改輸入', () => {
    const b = fixture();
    const before = JSON.stringify(b);
    validateBundle(b);
    expect(JSON.stringify(b)).toBe(before);
  });
  it('完全壞掉的輸入不丟例外，而是回報錯誤', () => {
    expect(validateBundle(null).length).toBeGreaterThan(0);
    expect(validateBundle({}).length).toBeGreaterThan(0);
    expect(validateBundle({ manifest: 1, tiles: 'x', items: {}, maps: [null, 3], story: [{ dialogues: [null, { nodes: 'x' }] }] }).length).toBeGreaterThan(0);
  });
});

describe('id 唯一', () => {
  it('tiles／items／lineages／maps 重複 id', () => {
    let b = fixture(); b.tiles.push({ id: 'wall', solid: true }); expectError(b, /tiles\.json.*wall.*重複/);
    b = fixture(); b.items.push({ id: 'attic_key', name: 'x' }); expectError(b, /items\.json.*attic_key.*重複/);
    b = fixture(); b.lineages.push({ id: 'trace', ranks: [] }); expectError(b, /lineages.*trace.*重複/);
    b = fixture(); b.maps.push({ ...structuredClone(b.maps[1]) }); expectError(b, /maps.*stairs.*重複/);
  });
  it('對話 id 跨檔案重複', () => {
    const b = fixture();
    b.story.push({ id: 'chapter1', dialogues: [{ id: 'dlg_enter', start: 'n1', nodes: [{ id: 'n1', text: 'x', next: 'END' }] }] });
    expectError(b, /dlg_enter.*重複/);
  });
  it('同一對話內節點 id 重複；節點 id 不可為 END', () => {
    let b = fixture(); dlgOf(b, 'dlg_door_look').nodes.push({ id: 'n1', text: 'x', next: 'END' });
    expectError(b, /dlg_door_look.*n1.*重複/);
    b = fixture(); dlgOf(b, 'dlg_door_look').nodes.push({ id: 'END', text: 'x', next: 'END' });
    expectError(b, /END/);
  });
  it('同一地圖內物件 id 重複；spawn id 重複；觸發點 id 重複', () => {
    let b = fixture(); attic(b).objects.push({ id: 'obj_vial', x: 1, y: 2, look: 'dlg_door_look' });
    expectError(b, /maps\/attic\.json.*obj_vial.*重複/);
    b = fixture(); attic(b).spawns.push({ id: 'default', x: 2, y: 1, dir: 'up' });
    expectError(b, /maps\/attic\.json.*spawn.*default.*重複/);
    b = fixture(); attic(b).triggers.push({ id: 'trg_window', x: 3, y: 2, dialogue: 'dlg_enter' });
    expectError(b, /trg_window.*重複/);
  });
  it('不同地圖可以有同名物件', () => {
    const b = fixture();
    b.maps[1].objects.push({ id: 'obj_vial', x: 1, y: 1, look: 'dlg_door_look' });
    expect(validateBundle(b)).toEqual([]);
  });
});

describe('懸空引用', () => {
  it('legend 指向不存在的 tile；地圖用到 legend 沒有的字元', () => {
    let b = fixture(); attic(b).legend['#'] = 'lava'; expectError(b, /attic.*legend.*lava/);
    b = fixture(); attic(b).tiles[1] = '#.?.#'; expectError(b, /attic.*字元.*\?/);
  });
  it('look／echo／on_enter／trigger／blocked／lock 對話不存在', () => {
    const cases = [
      [(b) => { attic(b).objects[0].look = 'dlg_ghost'; }, /obj_vial.*look.*dlg_ghost/],
      [(b) => { attic(b).objects[0].echo = 'dlg_ghost'; }, /obj_vial.*echo.*dlg_ghost/],
      [(b) => { attic(b).on_enter = 'dlg_ghost'; }, /on_enter.*dlg_ghost/],
      [(b) => { attic(b).triggers[0].dialogue = 'dlg_ghost'; }, /trg_window.*dlg_ghost/],
      [(b) => { attic(b).exits[0].blocked = 'dlg_ghost'; }, /blocked.*dlg_ghost/],
      [(b) => { attic(b).objects[1].lock.on_tag.trace = 'dlg_ghost'; }, /on_tag.*dlg_ghost/],
      [(b) => { attic(b).objects[1].lock.on_item = 'dlg_ghost'; }, /on_item.*dlg_ghost/],
      [(b) => { attic(b).objects[1].lock.locked = 'dlg_ghost'; }, /locked.*dlg_ghost/],
    ];
    for (const [mutate, re] of cases) { const b = fixture(); mutate(b); expectError(b, re); }
  });
  it('出口的地圖或 spawn 不存在', () => {
    let b = fixture(); attic(b).exits[0].to = 'roof'; expectError(b, /exits.*roof/);
    b = fixture(); attic(b).exits[0].spawn = 'nowhere'; expectError(b, /stairs.*nowhere/);
  });
  it('give_item／take_item／item 條件／fallback 道具不存在', () => {
    let b = fixture(); dlgOf(b, 'dlg_door_key').nodes[0].effects = [{ take_item: 'gem' }]; expectError(b, /dlg_door_key.*gem/);
    b = fixture(); dlgOf(b, 'dlg_door_key').nodes[0].effects = [{ give_item: 'gem' }]; expectError(b, /gem/);
    b = fixture(); attic(b).exits[0].requires = { item: 'gem' }; expectError(b, /gem/);
    b = fixture(); attic(b).objects[1].lock.fallback = 'item:gem'; expectError(b, /obj_door.*fallback.*gem/);
  });
  it('manifest.start 的地圖、spawn、對話不存在；files 列的檔案沒載入', () => {
    let b = fixture(); b.manifest.start.map = 'roof'; expectError(b, /manifest\.json.*roof/);
    b = fixture(); b.manifest.start.spawn = 'nowhere'; expectError(b, /manifest\.json.*nowhere/);
    b = fixture(); b.manifest.start.dialogue = 'dlg_ghost'; expectError(b, /manifest\.json.*dlg_ghost/);
    b = fixture(); b.manifest.files.maps.push('roof'); expectError(b, /manifest\.json.*files\.maps.*roof/);
  });
});

describe('地圖幾何', () => {
  it('每列等長', () => {
    const b = fixture(); attic(b).tiles[2] = '#..#'; expectError(b, /attic.*第 2 列.*長度/);
  });
  it('座標超出範圍或不是整數', () => {
    let b = fixture(); attic(b).objects[0].x = 99; expectError(b, /obj_vial.*範圍/);
    b = fixture(); attic(b).spawns[0].y = -1; expectError(b, /spawn.*default.*範圍/);
    b = fixture(); attic(b).triggers[0].x = 1.5; expectError(b, /trg_window.*範圍|trg_window.*整數/);
  });
  it('物件／出口／觸發點／spawn 不可在 solid 地形', () => {
    let b = fixture(); attic(b).objects[0].x = 0; expectError(b, /obj_vial.*solid 地形/);
    b = fixture(); attic(b).exits[0].x = 1; expectError(b, /exits\[0\].*solid 地形/);
    b = fixture(); attic(b).triggers[0].x = 0; expectError(b, /trg_window.*solid 地形/);
    b = fixture(); attic(b).spawns[0].x = 0; expectError(b, /default.*solid 地形/);
  });
  it('出口不可與 solid 物件重疊', () => {
    const b = fixture(); attic(b).exits[0].y = 3; expectError(b, /exits\[0\].*obj_door.*重疊/);
  });
  it('spawn 的 dir 必須是 up/down/left/right', () => {
    const b = fixture(); attic(b).spawns[0].dir = 'north'; expectError(b, /default.*dir/);
  });
});

describe('lock 規則', () => {
  it('沒有 fallback', () => {
    const b = fixture(); delete attic(b).objects[1].lock.fallback; expectError(b, /obj_door.*fallback.*必填/);
  });
  it('fallback 寫法不支援', () => {
    const b = fixture(); attic(b).objects[1].lock.fallback = 'skill:x'; expectError(b, /obj_door.*fallback/);
  });
  it('fallback 道具在任何 give_item 都拿不到', () => {
    const b = fixture();
    dlgOf(b, 'dlg_vial_look').nodes[1].effects = [{ set_flag: 'got_key' }];
    expectError(b, /obj_door.*attic_key.*取得/);
  });
  it('fallback 道具在（免費入口的）選項效果裡給也算', () => {
    const b = fixture();
    dlgOf(b, 'dlg_vial_look').nodes[1].effects = [{ set_flag: 'got_key' }];
    dlgOf(b, 'dlg_vial_look').nodes[1] = { id: 'n1', text: '要拿嗎？', choices: [{ text: '拿', next: 'END', effects: [{ give_item: 'attic_key' }] }, { text: '不', next: 'END' }] };
    expect(validateBundle(b)).toEqual([]);
  });
  it('缺 flag；solvable_by 不是字串陣列；on_tag 的標籤不在 solvable_by', () => {
    let b = fixture(); delete attic(b).objects[1].lock.flag; expectError(b, /obj_door.*flag/);
    b = fixture(); attic(b).objects[1].lock.solvable_by = 'trace'; expectError(b, /obj_door.*solvable_by/);
    b = fixture(); attic(b).objects[1].lock.on_tag.force = 'dlg_door_echo'; expectError(b, /obj_door.*on_tag.*force/);
  });
});

describe('對話結構', () => {
  const edit = (id, fn) => { const b = fixture(); fn(dlgOf(b, id)); return b; };
  it('start 節點不存在', () => {
    expectError(edit('dlg_door_look', (d) => { d.start = 'nx'; }), /dlg_door_look.*start.*nx/);
  });
  it('節點既沒有 next 也沒有 choices', () => {
    expectError(edit('dlg_door_look', (d) => { delete d.nodes[0].next; }), /dlg_door_look.*n1.*next 或 choices/);
  });
  it('next 指向不存在的節點', () => {
    expectError(edit('dlg_door_look', (d) => { d.nodes[0].next = 'n9'; }), /dlg_door_look.*n1.*n9/);
  });
  it('branches 必須搭配 next', () => {
    expectError(edit('dlg_vial_look', (d) => { delete d.nodes[0].next; }), /dlg_vial_look.*gate.*branches.*next/);
  });
  it('branches 與 choices 不可並存', () => {
    expectError(edit('dlg_vial_echo', (d) => { d.nodes[0].branches = [{ if: { flag: 'x' }, next: 'n2' }]; }), /dlg_vial_echo.*n1.*branches.*choices/);
  });
  it('choices 為空、選項缺 next、全部選項都有 if', () => {
    expectError(edit('dlg_vial_echo', (d) => { d.nodes[0].choices = []; }), /dlg_vial_echo.*n1.*至少一個選項/);
    expectError(edit('dlg_vial_echo', (d) => { delete d.nodes[0].choices[0].next; }), /dlg_vial_echo.*n1.*choices\[0\].*next/);
    expectError(edit('dlg_vial_echo', (d) => { d.nodes[0].choices[0].if = { flag: 'x' }; }), /dlg_vial_echo.*n1.*沒有 if/);
  });
  it('next 與 choices 並存（語意不明）', () => {
    expectError(edit('dlg_vial_echo', (d) => { d.nodes[0].next = 'n2'; }), /dlg_vial_echo.*n1.*next.*choices/);
  });
  it('有節點從 start 走不到', () => {
    expectError(edit('dlg_door_look', (d) => { d.nodes.push({ id: 'orphan', text: 'x', next: 'END' }); }), /dlg_door_look.*orphan.*走不到/);
  });
  it('死路：節點只能繞圈、走不到 END', () => {
    const b = edit('dlg_door_look', (d) => {
      d.nodes[0].next = 'a';
      d.nodes.push({ id: 'a', text: 'A', next: 'b' }, { id: 'b', text: 'B', next: 'a' });
    });
    const errs = expectError(b, /dlg_door_look.*a.*END/);
    expect(errs.some((e) => /dlg_door_look.*節點 b.*END/.test(e))).toBe(true);
  });
  it('走不到的自我迴圈節點：同時回報走不到與死路', () => {
    const b = edit('dlg_door_look', (d) => { d.nodes.push({ id: 'loop', next: 'loop' }); });
    const errs = validateBundle(b);
    expect(errs.some((e) => /節點 loop：從 start 走不到/.test(e))).toBe(true);
    expect(errs.some((e) => /節點 loop：無法走到 END/.test(e))).toBe(true);
  });
  it('有出口的迴圈是合法的（例如重問一次）', () => {
    const b = edit('dlg_door_look', (d) => {
      d.nodes[0] = { id: 'n1', text: '再問一次？', choices: [{ text: '好', next: 'n1' }, { text: '不', next: 'END' }] };
    });
    expect(validateBundle(b)).toEqual([]);
  });
  it('條件與效果寫法不合法', () => {
    expectError(edit('dlg_vial_look', (d) => { d.nodes[0].branches[0].if = { flagg: 'x' }; }), /dlg_vial_look.*gate.*flagg/);
    expectError(edit('dlg_vial_echo', (d) => { d.nodes[0].choices[1].if = {}; }), /dlg_vial_echo.*n1.*choices\[1\]/);
    expectError(edit('dlg_door_key', (d) => { d.nodes[0].effects = [{ teleport: 'x' }]; }), /dlg_door_key.*n1.*teleport/);
    expectError(edit('dlg_door_key', (d) => { d.nodes[0].effects = { set_flag: 'x' }; }), /dlg_door_key.*n1.*effects.*陣列/);
    let b = fixture(); attic(b).objects[0].if = { bogus: 1 }; expectError(b, /obj_vial.*bogus/);
    b = fixture(); attic(b).exits[0].requires = { bogus: 1 }; expectError(b, /exits\[0\].*bogus/);
    b = fixture(); attic(b).triggers[0].if = {}; expectError(b, /trg_window.*if/);
  });
});

// ───────────── M1 審查修正：補檢查 ─────────────
describe('補檢查（M1 審查）', () => {
  it('lineage.ranks 必須是陣列；rank 必須是整數且不重複', () => {
    let b = fixture(); b.lineages[0].ranks = { 9: {} }; expectError(b, /lineages.*trace.*ranks.*陣列/);
    b = fixture(); b.lineages[0].ranks.push({ rank: 9, field: [] }); expectError(b, /trace.*rank 9.*重複/);
    b = fixture(); b.lineages[0].ranks.push({ rank: 'x' }); expectError(b, /trace.*rank/);
  });
  it('tile 的 solid 必填且為布林；glow 選填但必須是布林', () => {
    let b = fixture(); delete b.tiles[1].solid; expectError(b, /floor.*solid/);
    b = fixture(); b.tiles[1].solid = 'no'; expectError(b, /floor.*solid/);
    b = fixture(); b.tiles[1].glow = 1; expectError(b, /floor.*glow/);
    b = fixture(); b.tiles[1].glow = true; expect(validateBundle(b)).toEqual([]);
  });
  it('物件的 solid 必須是布林（選填）', () => {
    const b = fixture(); attic(b).objects[0].solid = 'yes'; expectError(b, /obj_vial.*solid/);
  });
  it('spawn 不可放在 solid 物件上', () => {
    const b = fixture(); attic(b).spawns[0].x = 3; expectError(b, /spawn「default」.*obj_vial/);
  });
  it('條件 {lineage} 必須引用存在的譜系', () => {
    const b = fixture(); attic(b).exits[0].requires = { any: [{ flag: 'door_open' }, { lineage: 'ghost' }] };
    expectError(b, /exits\[0\].*譜系.*ghost/);
  });
  it('chapter_end 必須是已載入的 story id', () => {
    const b = fixture(); dlgOf(b, 'dlg_end').nodes[0].effects = [{ chapter_end: 'chapter9' }];
    expectError(b, /dlg_end.*chapter_end.*chapter9/);
  });
  it('manifest.chapters 必須是陣列，每一項都有對應 story', () => {
    let b = fixture(); b.manifest.chapters.push('chapter1'); expectError(b, /manifest\.json.*chapters.*chapter1/);
    b = fixture(); delete b.manifest.chapters; expectError(b, /manifest\.json.*chapters/);
  });
  it('story 的 title、end_screen.title／subtitle 必須是非空字串', () => {
    let b = fixture(); delete b.story[0].title; expectError(b, /story\/prologue\.json.*title/);
    b = fixture(); b.story[0].title = ''; expectError(b, /story\/prologue\.json.*title/);
    b = fixture(); delete b.story[0].end_screen; expectError(b, /story\/prologue\.json.*end_screen/);
    b = fixture(); b.story[0].end_screen.subtitle = 3; expectError(b, /end_screen\.subtitle/);
  });
  it('manifest.start.echo_charges 若存在必須是 0～99 整數', () => {
    for (const v of [-1, 100, 1.5, '3', null]) {
      const b = fixture(); b.manifest.start.echo_charges = v; expectError(b, /echo_charges/);
    }
    const b = fixture(); b.manifest.start.echo_charges = 3; expect(validateBundle(b)).toEqual([]);
  });
  it('原型鍵：spawn dir「toString」、條件／效果的原型鍵都要報錯', () => {
    let b = fixture(); attic(b).spawns[0].dir = 'toString'; expectError(b, /default.*dir/);
    b = fixture(); attic(b).exits[0].requires = JSON.parse('{"constructor":"x"}'); expectError(b, /exits\[0\].*未知的條件/);
    b = fixture(); dlgOf(b, 'dlg_door_key').nodes[0].effects = [JSON.parse('{"__proto__":"x"}')]; expectError(b, /dlg_door_key.*未知的效果/);
  });
});

describe('fallback 可達性（R6）：鑰匙必須能從免費入口拿到', () => {
  // 把 fixture 改成：抽屜（look）給鑰匙；門的殘響（on_tag）也給鑰匙
  const withDrawer = () => {
    const b = fixture();
    dlgOf(b, 'dlg_vial_look').nodes[1].effects = [{ set_flag: 'got_key' }];
    attic(b).objects.push({ id: 'obj_drawer', x: 1, y: 2, solid: true, look: 'dlg_drawer' });
    attic(b).triggers = attic(b).triggers.filter((t) => t.id !== 'trg_window');
    b.story[0].dialogues.push({ id: 'dlg_drawer', start: 'n1', nodes: [{ id: 'n1', text: '抽屜裡有鑰匙。', effects: [{ give_item: 'attic_key' }], next: 'END' }] });
    dlgOf(b, 'dlg_door_echo').nodes[0].effects = [{ give_item: 'attic_key' }];
    return b;
  };
  it('抽屜給鑰匙 → 合法', () => {
    expect(validateBundle(withDrawer())).toEqual([]);
  });
  it('把抽屜的 give_item 拿掉、只剩殘響開門對話會給鑰匙 → 報錯', () => {
    const b = withDrawer();
    delete dlgOf(b, 'dlg_drawer').nodes[0].effects;
    expectError(b, /obj_door.*attic_key.*取得/);
  });
  it('物件 echo 對話給的不算', () => {
    const b = withDrawer();
    delete dlgOf(b, 'dlg_drawer').nodes[0].effects;
    dlgOf(b, 'dlg_vial_echo').nodes[1].effects = [{ give_item: 'attic_key' }];
    expectError(b, /obj_door.*attic_key.*取得/);
  });
  it('孤兒對話（沒人引用）給的不算', () => {
    const b = withDrawer();
    delete dlgOf(b, 'dlg_drawer').nodes[0].effects;
    b.story[0].dialogues.push({ id: 'dlg_orphan', start: 'n1', nodes: [{ id: 'n1', text: '撿到鑰匙。', effects: [{ give_item: 'attic_key' }], next: 'END' }] });
    expectError(b, /obj_door.*attic_key.*取得/);
  });
  it('免費入口都算：start.dialogue、on_enter、trigger、lock.on_item／locked', () => {
    const entries = [
      (b) => { b.manifest.start.dialogue = 'dlg_give'; },
      (b) => { attic(b).on_enter = 'dlg_give'; },
      (b) => { attic(b).triggers[0].dialogue = 'dlg_give'; },
      (b) => { attic(b).objects[1].lock.locked = 'dlg_give'; },
      (b) => { attic(b).objects[1].lock.on_item = 'dlg_give'; },
    ];
    for (const [i, hook] of entries.entries()) {
      const b = withDrawer();
      delete dlgOf(b, 'dlg_drawer').nodes[0].effects;
      b.story[0].dialogues.push({ id: 'dlg_give', start: 'n1', nodes: [{ id: 'n1', text: '給你。', effects: [{ give_item: 'attic_key' }], next: 'END' }] });
      hook(b);
      expect(validateBundle(b), `入口 ${i}`).toEqual([]);
    }
  });
  it('只能經過「要花殘響的選項」才拿得到 → 不算', () => {
    const b = withDrawer();
    dlgOf(b, 'dlg_drawer').nodes[0] = { id: 'n1', text: '要看穿嗎？', choices: [
      { text: '算了', next: 'END' },
      { text: '看穿', if: { echo_gte: 1 }, effects: [{ use_echo: true }, { give_item: 'attic_key' }], next: 'END' },
    ] };
    expectError(b, /obj_door.*attic_key.*取得/);
  });
});
