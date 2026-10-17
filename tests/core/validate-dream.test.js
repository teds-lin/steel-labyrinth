// validate.js：M4 夢境欄位（dream 地圖、dream 物件、guest、guests 預寫台詞、enter_dream／wake／open_chat）。
import { describe, it, expect } from 'vitest';
import { validateBundle } from '../../web/src/core/validate.js';

const SCRIPTED = () => ({
  greeting: ['又見面了。'], fallback: ['霧太濃了。'], quota: ['今天先到這裡。'], filtered: ['當我沒說。'], not_open: ['（啟用雲端存檔後可以交談。）'],
});
const one = (id, text, extra = {}) => ({ id, start: 'n1', nodes: [{ id: 'n1', text, next: 'END', ...extra }] });

function fixture() {
  return {
    manifest: {
      chapters: ['chapter3'],
      start: { map: 'room', spawn: 'default' },
      files: { maps: ['room', 'hall'], story: ['chapter3'] },
    },
    tiles: [{ id: 'wall', solid: true }, { id: 'floor', solid: false }],
    items: [],
    lineages: [],
    maps: [
      { id: 'room', name: '房間', tiles: ['....'], legend: { '.': 'floor' }, spawns: [{ id: 'default', x: 0, y: 0 }],
        objects: [{ id: 'bed', x: 1, y: 0, solid: true, look: 'dlg_bed', dream: { if: { flag: 'tired' }, map: 'hall', spawn: 'center' } }] },
      { id: 'hall', name: '夢中鐘塔', dream: true, tiles: ['....'], legend: { '.': 'floor' }, spawns: [{ id: 'center', x: 0, y: 0 }],
        objects: [
          { id: 'g3', x: 1, y: 0, solid: true, guest: 'three', look: 'dlg_three' },
          { id: 'exit', x: 2, y: 0, solid: true, look: 'dlg_wake' },
        ] },
    ],
    story: [{
      id: 'chapter3', title: '第三章', end_screen: { title: '完', subtitle: '待續' },
      guests: [{ id: 'three', name: '三點', sprite: 'landlady', scripted: SCRIPTED() }],
      dialogues: [
        { id: 'dlg_bed', start: 'n1', nodes: [{ id: 'n1', text: '床。', choices: [
          { text: '睡', effects: [{ enter_dream: { map: 'hall', spawn: 'center' } }], next: 'END' },
          { text: '不睡', next: 'END' },
        ] }] },
        { id: 'dlg_three', start: 'n1', nodes: [{ id: 'n1', text: '……', choices: [
          { text: '自由交談', effects: [{ open_chat: 'three' }], next: 'END' },
          { text: '離開', next: 'END' },
        ] }] },
        one('dlg_wake', '醒來。', { effects: [{ wake: { dialogue: 'dlg_after' } }] }),
        one('dlg_after', '天亮了。'),
        { id: 'dlg_node_chat', start: 'n1', nodes: [{ id: 'n1', text: '三點看著你。', effects: [{ open_chat: 'three' }], next: 'END' }] },
      ],
    }],
  };
}
const expectError = (b, re) => {
  const errs = validateBundle(b);
  expect(errs.some((e) => re.test(e)), `預期有錯誤符合 ${re}，實際：\n${errs.join('\n')}`).toBe(true);
};
const hall = (b) => b.maps[1];
const room = (b) => b.maps[0];
const story = (b) => b.story[0];
const dlg = (b, id) => story(b).dialogues.find((d) => d.id === id);

describe('validate：夢境', () => {
  it('合法 fixture 沒有錯誤', () => {
    expect(validateBundle(fixture())).toEqual([]);
  });
  it('地圖的 dream 必須是 true/false', () => {
    const b = fixture();
    hall(b).dream = 'yes';
    expectError(b, /dream 必須是 true\/false/);
  });
  it('enter_dream：目標地圖必須存在、是夢境地圖、有該 spawn', () => {
    let b = fixture();
    dlg(b, 'dlg_bed').nodes[0].choices[0].effects = [{ enter_dream: { map: 'nope', spawn: 'center' } }];
    expectError(b, /enter_dream.*不存在的地圖/);
    b = fixture();
    dlg(b, 'dlg_bed').nodes[0].choices[0].effects = [{ enter_dream: { map: 'room', spawn: 'default' } }];
    expectError(b, /enter_dream.*不是夢境地圖/);
    b = fixture();
    dlg(b, 'dlg_bed').nodes[0].choices[0].effects = [{ enter_dream: { map: 'hall', spawn: 'x' } }];
    expectError(b, /沒有 spawn「x」/);
  });
  it('enter_dream 只能從非夢境地圖（對話被夢境地圖引用時報錯）', () => {
    const b = fixture();
    hall(b).objects[1].look = 'dlg_bed';
    expectError(b, /enter_dream 只能在現實地圖/);
  });
  it('wake 只能在夢境地圖（對話被現實地圖引用時報錯）', () => {
    const b = fixture();
    room(b).objects[0].look = 'dlg_wake';
    expectError(b, /wake 只能在夢境地圖/);
  });
  it('wake 的 dialogue 必須存在', () => {
    const b = fixture();
    dlg(b, 'dlg_wake').nodes[0].effects = [{ wake: { dialogue: 'dlg_nope' } }];
    expectError(b, /wake 的 dialogue 引用不存在的對話「dlg_nope」/);
  });
  it('open_chat 引用不存在的夢客', () => {
    const b = fixture();
    dlg(b, 'dlg_three').nodes[0].choices[0].effects = [{ open_chat: 'nine' }];
    expectError(b, /open_chat 引用不存在的夢客「nine」/);
  });
  it('guest 物件：夢客必須有預寫台詞、只能放在夢境地圖', () => {
    let b = fixture();
    hall(b).objects[0].guest = 'nine';
    expectError(b, /guest 引用不存在的夢客「nine」/);
    b = fixture();
    room(b).objects.push({ id: 'g9', x: 3, y: 0, solid: true, guest: 'three', look: 'dlg_three' });
    expectError(b, /guest 只能放在夢境地圖/);
    b = fixture();
    hall(b).objects[0].guest = '';
    expectError(b, /guest 必須是非空字串/);
  });
  it('dream 物件的 prompt／yes／no（選填）：非空字串合法；其他型別或空字串報錯', () => {
    let b = fixture();
    room(b).objects[0].dream = { if: { flag: 'tired' }, map: 'hall', spawn: 'center', prompt: '眼皮好重。', yes: '睡吧', no: '再撐一下' };
    expect(validateBundle(b)).toEqual([]);
    b = fixture();
    room(b).objects[0].dream = { map: 'hall', spawn: 'center', yes: '睡吧' };
    expect(validateBundle(b)).toEqual([]);
    for (const [k, v] of [['prompt', ''], ['yes', 5], ['no', null], ['prompt', ['眼皮好重。']], ['yes', '   ']]) {
      b = fixture();
      room(b).objects[0].dream = { map: 'hall', spawn: 'center', [k]: v };
      expectError(b, new RegExp(`dream\\.${k} 必須是非空字串`));
    }
  });
  it('dream 物件：if 合法、只能在現實地圖、要有夢境地圖可去', () => {
    let b = fixture();
    room(b).objects[0].dream = { if: { flagz: 'x' }, map: 'hall', spawn: 'center' };
    expectError(b, /bed.*if/);
    b = fixture();
    room(b).objects[0].dream = true;
    expectError(b, /dream 必須是物件/);
    b = fixture();
    room(b).objects[0].dream = { if: { flag: 'x' }, map: 'hall', spawn: 'center', extra: 1 };
    expectError(b, /dream 只能有 if、map、spawn/);
    b = fixture();
    hall(b).objects[1].dream = { map: 'hall', spawn: 'center' };
    expectError(b, /dream 只能放在現實地圖/);
    b = fixture();
    room(b).objects[0].dream = { map: 'room', spawn: 'default' };
    expectError(b, /dream\.map.*不是夢境地圖/);
    b = fixture();
    room(b).objects[0].dream = { if: { flag: 'x' } };
    expectError(b, /dream 必須寫明 map 與 spawn/);
    b = fixture();
    room(b).objects[0].dream = { map: 'hall' };
    expectError(b, /dream 必須寫明 map 與 spawn/);
    b = fixture();
    room(b).objects[0].dream = { map: 'hall', spawn: 'nope' };
    expectError(b, /沒有 spawn「nope」/);
  });
  it('guests：格式、id 唯一、五組預寫台詞都要有且每組非空', () => {
    let b = fixture();
    story(b).guests = 'x';
    expectError(b, /guests 必須是陣列/);
    b = fixture();
    story(b).guests.push({ ...story(b).guests[0] });
    expectError(b, /夢客 id「three」重複/);
    b = fixture();
    story(b).guests[0].id = 'Three!';
    expectError(b, /夢客 id「Three!」格式/);
    b = fixture();
    story(b).guests[0].name = '';
    expectError(b, /name 必須是非空字串/);
    for (const k of ['greeting', 'fallback', 'quota', 'filtered', 'not_open']) {
      b = fixture();
      story(b).guests[0].scripted[k] = [];
      expectError(b, new RegExp(`scripted\\.${k} 必須是非空的字串陣列`));
      b = fixture();
      delete story(b).guests[0].scripted[k];
      expectError(b, new RegExp(`scripted\\.${k} 必須是非空的字串陣列`));
    }
    b = fixture();
    story(b).guests[0].scripted.quota = ['好', ''];
    expectError(b, /scripted\.quota 必須是非空的字串陣列/);
    b = fixture();
    story(b).guests[0].scripted = null;
    expectError(b, /scripted 必須是物件/);
  });
});
