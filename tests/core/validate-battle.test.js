// validate.js 的 M2 擴充：角色、技能、敵人、遭遇、新對話效果、免費可達性（goto／set_lineage）。
import { describe, it, expect } from 'vitest';
import { validateBundle } from '../../web/src/core/validate.js';
import { battleData } from './battle/fixture.js';

const room = ['#####', '#...#', '#...#', '#####'];
const legend = { '#': 'wall', '.': 'floor' };
const dlg = (id, nodes) => ({ id, start: 'n1', nodes });
const say = (id, effects) => dlg(id, [{ id: 'n1', text: id, ...(effects ? { effects } : {}), next: 'END' }]);

/** 序章（attic）→ chapter_end → 第一章（office，喝下讀痕者）→ goto 碼頭（dock）。office 沒有回 attic 的路。 */
function m2() {
  const bd = battleData();
  return {
    manifest: { chapters: ['prologue', 'chapter1'], start: { map: 'attic', spawn: 'default', dialogue: 'dlg_opening' } },
    tiles: [{ id: 'wall', solid: true }, { id: 'floor', solid: false }],
    items: [...bd.items, { id: 'attic_key', name: '鑰匙', desc: 'x' }, { id: 'office_key', name: '櫃子鑰匙', desc: 'x' }, { id: 'dock_key', name: '倉庫鑰匙', desc: 'x' }],
    lineages: bd.lineages, characters: bd.characters, skills: bd.skills, enemies: bd.enemies, encounters: bd.encounters,
    maps: [
      { id: 'attic', name: '閣樓', tiles: room, legend, spawns: [{ id: 'default', x: 1, y: 1, dir: 'down' }],
        objects: [
          { id: 'obj_drawer', x: 3, y: 1, solid: true, look: 'dlg_drawer' },
          { id: 'obj_door', x: 3, y: 2, solid: true, lock: { flag: 'door_open', solvable_by: ['trace'], fallback: 'item:attic_key', on_tag: { trace: 'dlg_door_trace' }, on_item: 'dlg_door_key', locked: 'dlg_locked' } },
        ],
        exits: [], triggers: [{ id: 'trg_end', x: 1, y: 2, dialogue: 'dlg_end', once: true }] },
      { id: 'office', name: '辦公室', tiles: room, legend, spawns: [{ id: 'door', x: 1, y: 1, dir: 'down' }],
        objects: [
          { id: 'obj_potion', x: 3, y: 1, solid: true, look: 'dlg_potion' },
          { id: 'obj_cabinet', x: 3, y: 2, solid: true, lock: { flag: 'cab_open', solvable_by: ['trace'], fallback: 'item:office_key', on_tag: { trace: 'dlg_cab_trace' }, locked: 'dlg_locked' } },
          { id: 'obj_foe', x: 2, y: 2, solid: true, look: 'dlg_foe', battle: 'enc_one' },
        ],
        exits: [], triggers: [{ id: 'trg_fight', x: 1, y: 2, battle: 'enc_two', once: true }] },
      { id: 'dock', name: '碼頭', tiles: room, legend, spawns: [{ id: 'in', x: 1, y: 1, dir: 'down' }], on_enter: 'dlg_dock_enter',
        objects: [{ id: 'obj_shed', x: 3, y: 1, solid: true, lock: { flag: 'shed_open', fallback: 'item:dock_key', on_item: 'dlg_door_key', locked: 'dlg_locked' } }],
        exits: [], triggers: [] },
    ],
    story: [
      { id: 'prologue', title: '序章', end_screen: { title: '序章　完', subtitle: '第一章', continue: { map: 'office', spawn: 'door', dialogue: 'dlg_ch1_start' } },
        dialogues: [
          say('dlg_opening'), say('dlg_drawer', [{ give_item: 'attic_key' }]), say('dlg_door_trace'), say('dlg_door_key'), say('dlg_locked'),
          say('dlg_end', [{ chapter_end: 'prologue' }]),
        ] },
      { id: 'chapter1', title: '第一章', end_screen: { title: '第一章　完', subtitle: '第二章　製作中' },
        dialogues: [
          say('dlg_ch1_start'),
          dlg('dlg_potion', [
            { id: 'n1', text: '喝嗎？', choices: [{ text: '喝', next: 'n2', effects: [{ set_lineage: { id: 'trace', rank: 9 } }] }, { text: '等等', next: 'END' }] },
            { id: 'n2', text: '好。', effects: [{ join_party: 'ada' }, { give_ammo: 6 }, { heal_party: true }, { goto: { map: 'dock', spawn: 'in' } }], next: 'END' },
          ]),
          say('dlg_cab_trace'), say('dlg_foe'), say('dlg_after'), say('dlg_phase'),
          say('dlg_dock_enter', [{ give_item: 'dock_key' }]),
          dlg('dlg_party', [{ id: 'n1', text: 'x', branches: [{ if: { in_party: 'ada' }, next: 'n2' }, { if: { ammo_gte: 1 }, next: 'n2' }], next: 'END' },
            { id: 'n2', text: 'y', effects: [{ leave_party: 'ada' }, { battle: 'enc_boss' }], next: 'END' }]),
        ] },
    ],
  };
}
const find = (b, kind, id) => b[kind].find((x) => x.id === id);
const mapOf = (b, id) => find(b, 'maps', id);
const dlgOf = (b, id) => b.story.flatMap((s) => s.dialogues).find((d) => d.id === id);
const expectError = (b, re) => {
  const errs = validateBundle(b);
  expect(errs.some((e) => re.test(e)), `預期有錯誤符合 ${re}，實際：\n${errs.join('\n')}`).toBe(true);
  return errs;
};
const mut = (fn) => { const b = m2(); fn(b); return b; };

describe('M2 合法資料', () => {
  it('fixture 沒有錯誤；不修改輸入', () => {
    const b = m2();
    const before = JSON.stringify(b);
    expect(validateBundle(b)).toEqual([]);
    expect(JSON.stringify(b)).toBe(before);
  });
  it('沒有戰鬥資料（序章）照樣合法：四個新檔案都可以省略', () => {
    const b = m2();
    for (const k of ['characters', 'skills', 'enemies', 'encounters']) delete b[k];
    const errs = validateBundle(b);
    expect(errs.every((e) => /遭遇|角色|技能|enc_|ada/.test(e)), errs.join('\n')).toBe(true); // 只剩引用不到戰鬥資料的錯
  });
});

describe('id 唯一', () => {
  it('characters／skills／enemies／encounters 的 id 重複', () => {
    for (const kind of ['characters', 'skills', 'enemies', 'encounters']) {
      const b = m2();
      b[kind].push(structuredClone(b[kind][0]));
      expectError(b, new RegExp(`${kind}\\.json.*「${b[kind][0].id}」重複`));
    }
  });
});

describe('characters.json', () => {
  it('必須有主角 hero；主角不可寫 lineage（來自遊戲狀態）', () => {
    expectError(mut((b) => { b.characters = b.characters.filter((c) => c.id !== 'hero'); }), /characters\.json.*hero/);
    expectError(mut((b) => { find(b, 'characters', 'hero').lineage = { id: 'trace', rank: 9 }; }), /characters\.json.*hero.*lineage/);
  });
  it('base 必須有全部 7 個能力值（非負數，hp ≥ 1）；name 必填', () => {
    expectError(mut((b) => { delete find(b, 'characters', 'ada').base.spd; }), /ada.*base\.spd/);
    expectError(mut((b) => { find(b, 'characters', 'ada').base.hp = 0; }), /ada.*base\.hp/);
    expectError(mut((b) => { find(b, 'characters', 'ada').base.atk = '7'; }), /ada.*base\.atk/);
    expectError(mut((b) => { find(b, 'characters', 'ada').base.luck = 3; }), /ada.*luck/);
    expectError(mut((b) => { delete find(b, 'characters', 'ada').name; }), /ada.*name/);
  });
  it('技能與譜系引用必須存在', () => {
    expectError(mut((b) => { find(b, 'characters', 'ada').skills.push('fireball'); }), /ada.*fireball/);
    expectError(mut((b) => { find(b, 'characters', 'ada').lineage = { id: 'ghost', rank: 9 }; }), /ada.*ghost/);
    expectError(mut((b) => { find(b, 'characters', 'ada').lineage = { id: 'dream', rank: 1 }; }), /ada.*dream.*1/);
  });
});

describe('lineages 的 rank 擴充', () => {
  it('rank.skills 引用必須存在；rank.stats 只能用 7 個能力值鍵、值為數字', () => {
    expectError(mut((b) => { find(b, 'lineages', 'trace').ranks[0].skills = ['ghost_skill']; }), /trace.*ghost_skill/);
    expectError(mut((b) => { find(b, 'lineages', 'trace').ranks[0].stats = { luck: 1 }; }), /trace.*luck/);
    expectError(mut((b) => { find(b, 'lineages', 'trace').ranks[0].stats = { hp: 'x' }; }), /trace.*hp/);
  });
});

describe('skills.json', () => {
  it('target、cost、效果積木的寫法', () => {
    expectError(mut((b) => { find(b, 'skills', 'attack').target = 'everyone'; }), /skills\.json.*attack.*target/);
    expectError(mut((b) => { find(b, 'skills', 'attack').cost = { mp: 1 }; }), /attack.*cost/);
    expectError(mut((b) => { find(b, 'skills', 'attack').cost = { sp: -1 }; }), /attack.*cost/);
    expectError(mut((b) => { find(b, 'skills', 'attack').effects = []; }), /attack.*effects/);
    expectError(mut((b) => { find(b, 'skills', 'attack').effects = [{ type: 'explode' }]; }), /attack.*explode/);
    expectError(mut((b) => { delete find(b, 'skills', 'attack').name; }), /attack.*name/);
    expectError(mut((b) => { find(b, 'skills', 'attack').tags = 'whisper'; }), /attack.*tags/);
  });
  it('summon 引用的敵人必須存在；reveal_intent 只能用在以敵人為目標的技能', () => {
    expectError(mut((b) => { find(b, 'skills', 'call_fog').effects[0].enemy = 'ghost'; }), /call_fog.*ghost/);
    expectError(mut((b) => { find(b, 'skills', 'guard').effects.push({ type: 'reveal_intent' }); }), /guard.*reveal_intent/);
  });
  it('道具：target 與 battle_effects 一起寫、積木合法；field_effects 是合法的對話效果（不可 use_echo）', () => {
    expectError(mut((b) => { delete find(b, 'items', 'bandage').target; }), /items\.json.*bandage.*target/);
    expectError(mut((b) => { find(b, 'items', 'bandage').target = 'world'; }), /items\.json.*bandage.*target/);
    expectError(mut((b) => { find(b, 'items', 'bandage').battle_effects = [{ type: 'explode' }]; }), /bandage.*explode/);
    expectError(mut((b) => { find(b, 'items', 'bandage').battle_effects = []; }), /bandage.*battle_effects/);
    expectError(mut((b) => { find(b, 'items', 'incense').field_effects = [{ teleport: 1 }]; }), /incense.*teleport/);
    expectError(mut((b) => { find(b, 'items', 'incense').field_effects = [{ give_item: 'gem' }]; }), /incense.*gem/);
    expectError(mut((b) => { find(b, 'items', 'incense').field_effects = [{ use_echo: true }]; }), /incense.*use_echo/);
  });
});

describe('enemies.json', () => {
  it('能力值、rank、技能引用', () => {
    expectError(mut((b) => { delete find(b, 'enemies', 'fogwalker').stats.eva; }), /fogwalker.*stats\.eva/);
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').rank = 'nine'; }), /fogwalker.*rank/);
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').skills.push('ghost'); }), /fogwalker.*ghost/);
  });
  it('AI：至少一條沒有 if 的規則；規則的技能存在、weight 為正數、if 是合法的戰鬥條件', () => {
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').ai = [{ skill: 'attack', weight: 1, if: { turn_gte: 2 } }]; }), /fogwalker.*沒有 if/);
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').ai = []; }), /fogwalker.*ai/);
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').ai[1].skill = 'ghost'; }), /fogwalker.*ai\[1\].*ghost/);
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').ai[1].weight = 0; }), /fogwalker.*ai\[1\].*weight/);
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').ai[0].if = { flag: 'x' }; }), /fogwalker.*ai\[0\].*flag/);
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').ai[0].extra = 1; }), /fogwalker.*ai\[0\].*extra/);
  });
  it('phases 與 drops', () => {
    expectError(mut((b) => { find(b, 'enemies', 'porter').phases[0].hp_lte_pct = 150; }), /porter.*phases\[0\].*hp_lte_pct/);
    expectError(mut((b) => { find(b, 'enemies', 'porter').phases[0].dialogue = 'dlg_ghost'; }), /porter.*dlg_ghost/);
    expectError(mut((b) => { find(b, 'enemies', 'porter').phases[0].add_ai[0].skill = 'ghost'; }), /porter.*phases\[0\].*ghost/);
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').drops[0].item = 'gem'; }), /fogwalker.*drops.*gem/);
    expectError(mut((b) => { find(b, 'enemies', 'fogwalker').drops[0].chance = 0; }), /fogwalker.*drops.*chance/);
  });
});

describe('encounters.json', () => {
  it('至少一名敵人、敵人存在、can_flee 布林、on_lose 只能是 retry／continue', () => {
    expectError(mut((b) => { find(b, 'encounters', 'enc_one').enemies = []; }), /enc_one.*至少一名敵人/);
    expectError(mut((b) => { find(b, 'encounters', 'enc_one').enemies = ['ghost']; }), /enc_one.*ghost/);
    expectError(mut((b) => { find(b, 'encounters', 'enc_one').can_flee = 'yes'; }), /enc_one.*can_flee/);
    expectError(mut((b) => { find(b, 'encounters', 'enc_one').on_lose = 'gameover'; }), /enc_one.*on_lose/);
  });
  it('on_win 的對話與效果（含引用）', () => {
    expectError(mut((b) => { find(b, 'encounters', 'enc_one').on_win.dialogue = 'dlg_ghost'; }), /enc_one.*dlg_ghost/);
    expectError(mut((b) => { find(b, 'encounters', 'enc_one').on_win.effects = [{ give_item: 'gem' }]; }), /enc_one.*gem/);
    expectError(mut((b) => { find(b, 'encounters', 'enc_one').on_win.effects = [{ teleport: 1 }]; }), /enc_one.*teleport/);
    expectError(mut((b) => { find(b, 'encounters', 'enc_one').on_win.extra = 1; }), /enc_one.*on_win.*extra/);
  });
});

describe('地圖與對話的擴充引用', () => {
  it('物件與觸發點的 battle 必須引用存在的遭遇；有 battle 的觸發點可以沒有 dialogue', () => {
    expectError(mut((b) => { mapOf(b, 'office').objects[2].battle = 'enc_ghost'; }), /obj_foe.*enc_ghost/);
    expectError(mut((b) => { mapOf(b, 'office').triggers[0].battle = 'enc_ghost'; }), /trg_fight.*enc_ghost/);
    expectError(mut((b) => { delete mapOf(b, 'office').triggers[0].battle; }), /trg_fight.*dialogue/);
  });
  it('battle／set_lineage／join_party／leave_party／goto 效果的引用', () => {
    expectError(mut((b) => { dlgOf(b, 'dlg_party').nodes[1].effects = [{ battle: 'enc_ghost' }]; }), /dlg_party.*enc_ghost/);
    expectError(mut((b) => { dlgOf(b, 'dlg_potion').nodes[0].choices[0].effects = [{ set_lineage: { id: 'ghost', rank: 9 } }]; }), /dlg_potion.*ghost/);
    expectError(mut((b) => { dlgOf(b, 'dlg_potion').nodes[0].choices[0].effects = [{ set_lineage: { id: 'trace', rank: 3 } }]; }), /dlg_potion.*trace.*3/);
    expectError(mut((b) => { dlgOf(b, 'dlg_potion').nodes[1].effects = [{ join_party: 'mallow' }]; }), /dlg_potion.*mallow/);
    expectError(mut((b) => { dlgOf(b, 'dlg_party').nodes[1].effects = [{ leave_party: 'hero' }]; }), /dlg_party.*主角/);
    expectError(mut((b) => { dlgOf(b, 'dlg_potion').nodes[1].effects = [{ goto: { map: 'roof', spawn: 'in' } }]; }), /dlg_potion.*roof/);
    expectError(mut((b) => { dlgOf(b, 'dlg_potion').nodes[1].effects = [{ goto: { map: 'dock', spawn: 'nowhere' } }]; }), /dlg_potion.*nowhere/);
    expectError(mut((b) => { dlgOf(b, 'dlg_potion').nodes[1].effects = [{ goto: { map: 'dock', spawn: 'in', dialogue: 'dlg_ghost' } }]; }), /dlg_potion.*dlg_ghost/);
  });
  it('in_party 條件引用的角色必須存在', () => {
    expectError(mut((b) => { dlgOf(b, 'dlg_party').nodes[0].branches[0].if = { in_party: 'mallow' }; }), /dlg_party.*mallow/);
  });
  it('end_screen.continue 的目的地（地圖、spawn、對話）必須存在', () => {
    expectError(mut((b) => { b.story[0].end_screen.continue.map = 'roof'; }), /prologue.*continue.*roof/);
    expectError(mut((b) => { b.story[0].end_screen.continue.spawn = 'nowhere'; }), /prologue.*continue.*nowhere/);
    expectError(mut((b) => { b.story[0].end_screen.continue.dialogue = 'dlg_ghost'; }), /prologue.*continue.*dlg_ghost/);
    expectError(mut((b) => { b.story[0].end_screen.continue = 'office'; }), /prologue.*continue/);
  });
});

describe('免費可達性：goto 與 set_lineage', () => {
  const fallbackErr = (id) => new RegExp(`${id}.*fallback.*取得`);
  it('goto 的目的地圖算進可達地圖：碼頭的鑰匙由碼頭 on_enter 給 → 合法；拿掉 goto → 碼頭到不了 → 報錯', () => {
    expect(validateBundle(m2())).toEqual([]);
    expectError(mut((b) => { dlgOf(b, 'dlg_potion').nodes[1].effects = [{ join_party: 'ada' }]; }), fallbackErr('obj_shed'));
  });
  it('end_screen.continue 也算：拿掉 chapter_end → 第一章到不了', () => {
    expectError(mut((b) => { dlgOf(b, 'dlg_end').nodes[0].effects = []; }), fallbackErr('obj_shed'));
  });
  it('第一章以後：喝下讀痕者後 trace 免費，櫃子的 fallback 道具拿不到也合法；拿掉 set_lineage → 報錯', () => {
    expectError(mut((b) => { dlgOf(b, 'dlg_potion').nodes[0].choices[0].effects = []; }), fallbackErr('obj_cabinet'));
  });
  it('序章的 lock 仍必須有免費 fallback：閣樓鑰匙拿不到 → 報錯（即使之後會喝下讀痕者）', () => {
    expectError(mut((b) => { dlgOf(b, 'dlg_drawer').nodes[0].effects = []; }), fallbackErr('obj_door'));
  });
  it('喝下之後還能回到的地圖，才算可以用 trace 解（辦公室有路回閣樓 → 閣樓的門也算免費可解）', () => {
    const b = mut((x) => {
      dlgOf(x, 'dlg_drawer').nodes[0].effects = [];
      mapOf(x, 'office').exits = [{ x: 2, y: 1, to: 'attic', spawn: 'default' }];
    });
    expect(validateBundle(b)).toEqual([]);
  });
  it('喝下之後才能用的 trace 不能拿來解「通往喝下靈劑之路」上的鎖（不動點不會循環證明）', () => {
    const b = mut((x) => {
      dlgOf(x, 'dlg_drawer').nodes[0].effects = [];
      mapOf(x, 'office').exits = [{ x: 2, y: 1, to: 'attic', spawn: 'default' }];
      mapOf(x, 'attic').triggers[0].if = { flag: 'door_open' }; // 章節結束需要先開門
    });
    expectError(b, fallbackErr('obj_door'));
  });
  it('喝下之後，物件的【殘響】對話也算免費入口', () => {
    const b = mut((x) => {
      mapOf(x, 'dock').on_enter = undefined;
      mapOf(x, 'office').objects[0].echo = 'dlg_dock_enter'; // 喝了之後對藥瓶用殘響拿到碼頭鑰匙
    });
    expect(validateBundle(b)).toEqual([]);
  });
  it('遭遇 on_win 的效果與對話算免費入口（假設戰鬥打得贏）', () => {
    const b = mut((x) => {
      mapOf(x, 'dock').on_enter = undefined;
      find(x, 'encounters', 'enc_one').on_win = { effects: [{ give_item: 'dock_key' }] };
    });
    expect(validateBundle(b)).toEqual([]);
  });
});

// ───────────── 規格補充 2（2026-10-17）：新欄位與 validate 新規則，每條各一組反例 ─────────────
const noErrorLike = (b, re) => {
  const errs = validateBundle(b);
  expect(errs.filter((e) => re.test(e)), errs.join('\n')).toEqual([]);
};

describe('規格補充 2：新欄位（menu／summon_text／show_resonance）', () => {
  it('合法寫法不報錯', () => {
    const b = mut((x) => {
      find(x, 'skills', 'attack').menu = 'root';
      find(x, 'enemies', 'fogwalker').summon_text = '從霧裡出現了！';
      find(x, 'lineages', 'trace').show_resonance = true;
    });
    expect(validateBundle(b)).toEqual([]);
  });
  it('技能 menu 只能是 "root"', () => {
    expectError(mut((x) => { find(x, 'skills', 'attack').menu = 'skill'; }), /技能「attack」.*menu/);
  });
  it('敵人 summon_text 必須是非空字串', () => {
    expectError(mut((x) => { find(x, 'enemies', 'fogwalker').summon_text = ''; }), /敵人「fogwalker」.*summon_text/);
  });
  it('譜系 show_resonance 必須是 true/false', () => {
    expectError(mut((x) => { find(x, 'lineages', 'trace').show_resonance = 'yes'; }), /譜系「trace」.*show_resonance/);
  });
});

describe('規格補充 2 第 5 條：phases[].dialogue 只能有 set_flag／clear_flag', () => {
  it('階段對話用 set_flag／clear_flag 合法', () => {
    const b = mut((x) => { dlgOf(x, 'dlg_phase').nodes[0].effects = [{ set_flag: 'a' }, { clear_flag: 'a' }]; });
    expect(validateBundle(b)).toEqual([]);
  });
  it('節點效果有其他效果 → 報錯', () => {
    expectError(mut((x) => { dlgOf(x, 'dlg_phase').nodes[0].effects = [{ give_ammo: 3 }]; }), /dlg_phase.*階段.*give_ammo/);
  });
  it('選項效果有其他效果 → 報錯', () => {
    expectError(mut((x) => {
      dlgOf(x, 'dlg_phase').nodes = [{ id: 'n1', text: 'x', choices: [{ text: 'a', next: 'END', effects: [{ collapse: 5 }] }] }];
    }), /dlg_phase.*階段.*collapse/);
  });
});

describe('規格補充 2 第 10 條：validate 新增', () => {
  it('每名角色至少有一個不消耗資源的技能', () => {
    expectError(mut((x) => { find(x, 'characters', 'herb').skills = ['shoot']; }), /角色「herb」.*不消耗/);
  });
  it('只看 characters.skills：譜系技能免費不算（例：隊友只有花費技能）', () => {
    noErrorLike(m2(), /不消耗/);
  });
  it('join_party 的隊伍人數靜態上限 ≤ 3', () => {
    const b = mut((x) => {
      x.characters.push({ ...find(x, 'characters', 'herb'), id: 'zed', name: '傑德' });
      dlgOf(x, 'dlg_ch1_start').nodes[0].effects = [{ join_party: 'herb' }, { join_party: 'zed' }];
    });
    expectError(b, /join_party.*隊伍.*3/);
  });
  it('join_party 加到剛好 3 人合法', () => {
    noErrorLike(mut((x) => { dlgOf(x, 'dlg_ch1_start').nodes[0].effects = [{ join_party: 'herb' }]; }), /join_party/);
  });
  it('敵人 ai（含 phases.add_ai）只能引用自己 skills 裡的技能', () => {
    expectError(mut((x) => { find(x, 'enemies', 'fogwalker').ai.push({ skill: 'deep', weight: 1 }); }), /敵人「fogwalker」.*ai\[2\].*skills/);
    expectError(mut((x) => { find(x, 'enemies', 'porter').skills = ['attack', 'whisper_minor']; }), /敵人「porter」.*add_ai\[0\].*skills/);
  });
  it('我方技能（characters.skills、譜系技能）不能有 summon', () => {
    expectError(mut((x) => { find(x, 'characters', 'herb').skills = ['attack', 'call_fog']; }), /call_fog.*我方.*summon/);
    expectError(mut((x) => { find(x, 'lineages', 'dream').ranks[0].skills = ['call_fog']; }), /call_fog.*我方.*summon/);
  });
  it('角色在任何已開放階位的能力值：hp、spd 至少 1，其他不得為負', () => {
    expectError(mut((x) => { find(x, 'lineages', 'trace').ranks[1].stats = { spd: -10 }; }), /主角.*trace.*rank 8.*spd/);
    expectError(mut((x) => { find(x, 'lineages', 'dream').ranks[1].stats = { hp: -50 }; }), /角色「ada」.*dream.*rank 8.*hp/);
    expectError(mut((x) => { find(x, 'lineages', 'dream').ranks[0].stats = { will: -30 }; }), /角色「ada」.*rank 8.*will/);
  });
  it('遭遇最多 3 名敵人', () => {
    expectError(mut((x) => { find(x, 'encounters', 'enc_two').enemies = ['fogwalker', 'fogwalker', 'fogwalker', 'fogwalker']; }), /遭遇「enc_two」.*最多 3/);
  });
  it('含召喚上限，同時在場的敵人合計不超過 4', () => {
    // porter ＋ 霧行者 ×2（初始）＋ porter 會召喚霧行者（max 3）→ 最多 1＋3＝4：合法；max 4 → 5 名：報錯
    noErrorLike(mut((x) => {
      find(x, 'encounters', 'enc_boss').enemies = ['porter', 'fogwalker', 'fogwalker'];
      find(x, 'skills', 'call_fog').effects[0].max = 3;
    }), /同時在場/);
    expectError(mut((x) => {
      find(x, 'encounters', 'enc_boss').enemies = ['porter', 'fogwalker', 'fogwalker'];
      find(x, 'skills', 'call_fog').effects[0].max = 4;
    }), /遭遇「enc_boss」.*同時在場.*5/);
  });
});
