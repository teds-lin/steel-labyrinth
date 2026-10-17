// M4 鐘塔之夢：入夢／醒來／夢客的核心邏輯（DATA-FORMAT「鐘塔之夢（M4 起）」）。
import { describe, it, expect } from 'vitest';
import { applyEffect, checkEffect, takePending } from '../../web/src/core/effects.js';
import { investigate } from '../../web/src/core/interact.js';
import { newGame } from '../../web/src/core/state.js';
import {
  isDreamMap, enterDream, wakeUp, dreamTarget, guestById, pickScripted, SCRIPTED_KINDS,
  dreamChoiceDialogue, notOpenDialogue, DREAM_CHOICE_ID, NOT_OPEN_ID, DREAM_PROMPT_DEFAULT,
} from '../../web/src/core/dream.js';
import { startDialogue } from '../../web/src/core/dialogue.js';

const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };

const guest = {
  id: 'three', name: '三點', sprite: 'landlady',
  scripted: {
    greeting: ['……又見面了。', '鐘聲還沒響完。'],
    fallback: ['霧太濃了。'],
    quota: ['今天先聊到這裡吧。'],
    filtered: ['當我沒說。'],
    not_open: ['（啟用雲端存檔後，可以和夢客自由交談。）'],
  },
};
const data = {
  manifest: { chapters: ['prologue'], start: { map: 'room', spawn: 'default' } },
  tiles: [{ id: 'floor', solid: false }, { id: 'wall', solid: true }],
  maps: [
    { id: 'room', name: '房間', tiles: ['....', '....'], legend: { '.': 'floor' },
      spawns: [{ id: 'default', x: 0, y: 0, dir: 'down' }],
      objects: [
        { id: 'bed', x: 1, y: 0, solid: true, look: 'dlg_bed', dream: { if: { flag: 'tired' }, map: 'hall', spawn: 'center' } },
        { id: 'flask', x: 2, y: 0, solid: true, look: 'dlg_flask', dream: { map: 'hall', spawn: 'side' } },
        { id: 'chair', x: 3, y: 0, solid: true, look: 'dlg_chair' },
      ] },
    { id: 'hall', name: '夢中鐘塔', dream: true, tiles: ['...', '...'], legend: { '.': 'floor' },
      on_enter: 'dlg_hall_enter',
      spawns: [{ id: 'center', x: 1, y: 1, dir: 'up' }, { id: 'side', x: 0, y: 1 }],
      objects: [{ id: 'g3', x: 1, y: 0, solid: true, guest: 'three', look: 'dlg_three' }] },
  ],
  story: [{ id: 'prologue', dialogues: [], guests: [guest] }],
};
const st = (over = {}) => ({
  player: { name: 'A' }, location: { map: 'room', x: 1, y: 1, dir: 'up' }, lineage: null,
  flags: {}, items: {}, echo: { charges: 0 }, collapse: 0, resonance: {}, chapter: 'prologue', chapter_done: [],
  party: [{ id: 'hero', hp: null, sp: null }], ammo: 0, pending: null, dream_return: null, ...over,
});

describe('效果：enter_dream／wake／open_chat', () => {
  it('寫法檢查', () => {
    expect(checkEffect({ enter_dream: { map: 'hall', spawn: 'center' } })).toEqual([]);
    expect(checkEffect({ enter_dream: { map: 'hall' } }).length).toBe(1);
    expect(checkEffect({ enter_dream: { map: 'hall', spawn: 'center', x: 1 } }).length).toBe(1);
    expect(checkEffect({ enter_dream: 'hall' }).length).toBe(1);
    expect(checkEffect({ wake: true })).toEqual([]);
    expect(checkEffect({ wake: { dialogue: 'dlg_x' } })).toEqual([]);
    expect(checkEffect({ wake: false }).length).toBe(1);
    expect(checkEffect({ wake: {} }).length).toBe(1);
    expect(checkEffect({ wake: { dialogue: '' } }).length).toBe(1);
    expect(checkEffect({ wake: { dialogue: 'a', x: 1 } }).length).toBe(1);
    expect(checkEffect({ open_chat: 'three' })).toEqual([]);
    expect(checkEffect({ open_chat: '' }).length).toBe(1);
    expect(checkEffect({ open_chat: 3 }).length).toBe(1);
  });
  it('寫進 pending（同 battle／goto），不直接改位置；takePending 取出', () => {
    const s0 = deepFreeze(st());
    let s = applyEffect({ enter_dream: { map: 'hall', spawn: 'center' } }, s0);
    s = applyEffect({ open_chat: 'three' }, s);
    s = applyEffect({ wake: true }, s);
    s = applyEffect({ wake: { dialogue: 'dlg_after' } }, s);
    expect(s.location).toEqual(s0.location);
    expect(s.dream_return).toBe(null);
    expect(s.pending).toEqual([
      { type: 'enter_dream', map: 'hall', spawn: 'center' },
      { type: 'open_chat', guest: 'three' },
      { type: 'wake', dialogue: null },
      { type: 'wake', dialogue: 'dlg_after' },
    ]);
    const r = takePending(s);
    expect(r.pending.length).toBe(4);
    expect(r.state.pending).toBe(null);
  });
});

describe('enterDream／wakeUp', () => {
  it('入夢：記住現實位置到 dream_return，移到夢境地圖的 spawn，第一次回傳 on_enter', () => {
    const s0 = deepFreeze(st({ location: { map: 'room', x: 0, y: 1, dir: 'right' } }));
    const r = enterDream(s0, data, 'hall', 'center');
    expect(r.state.dream_return).toEqual({ map: 'room', x: 0, y: 1, dir: 'right' });
    expect(r.state.location).toEqual({ map: 'hall', x: 1, y: 1, dir: 'up' });
    expect(r.dialogue).toBe('dlg_hall_enter');
    const again = enterDream({ ...s0, flags: r.state.flags }, data, 'hall', 'side');
    expect(again.dialogue).toBe(null);
    expect(again.state.location.dir).toBe('down');
  });
  it('目標不是夢境地圖、地圖或 spawn 不存在 → 丟錯', () => {
    expect(() => enterDream(st(), data, 'room', 'default')).toThrow(/夢境/);
    expect(() => enterDream(st(), data, 'nope', 'center')).toThrow();
    expect(() => enterDream(st(), data, 'hall', 'nope')).toThrow();
  });
  it('已在夢中再入夢：保留最初的現實位置', () => {
    const inDream = st({ location: { map: 'hall', x: 1, y: 1, dir: 'up' }, dream_return: { map: 'room', x: 3, y: 1, dir: 'left' } });
    const r = enterDream(inDream, data, 'hall', 'side');
    expect(r.state.dream_return).toEqual({ map: 'room', x: 3, y: 1, dir: 'left' });
  });
  it('醒來：回到 dream_return 並清除；不改旗標、不回傳 on_enter', () => {
    const s0 = deepFreeze(st({ location: { map: 'hall', x: 1, y: 1, dir: 'up' }, dream_return: { map: 'room', x: 3, y: 1, dir: 'left' } }));
    const r = wakeUp(s0, data);
    expect(r.state.location).toEqual({ map: 'room', x: 3, y: 1, dir: 'left' });
    expect(r.state.dream_return).toBe(null);
    expect(r.state.flags).toBe(s0.flags);
    expect(r.relocated).toBe(false);
  });
  it('醒來但 dream_return 壞掉或地圖不存在 → 回到 manifest 的起點並標示 relocated', () => {
    for (const ret of [null, { map: 'gone', x: 0, y: 0, dir: 'up' }, { map: 'room', x: 99, y: 0, dir: 'up' }]) {
      const r = wakeUp(st({ location: { map: 'hall', x: 1, y: 1, dir: 'up' }, dream_return: ret }), data);
      expect(r.state.location).toEqual({ map: 'room', x: 0, y: 0, dir: 'down' });
      expect(r.state.dream_return).toBe(null);
      expect(r.relocated).toBe(true);
    }
  });
  it('DATA-FORMAT 補充（2026-10-18）2：醒來位置不合法時退回「該章起點」（前一章 end_screen.continue），不是序章的 manifest.start', () => {
    const d2 = {
      ...data,
      manifest: { chapters: ['prologue', 'chapter1', 'chapter2'], start: { map: 'room', spawn: 'default' } },
      maps: [...data.maps, { id: 'office', name: '辦公室', tiles: ['....', '....'], legend: { '.': 'floor' }, spawns: [{ id: 'first', x: 0, y: 1 }, { id: 'door', x: 3, y: 1, dir: 'left' }] }],
      story: [
        { id: 'prologue', guests: [guest], end_screen: { title: 'a', subtitle: 'b', continue: { map: 'office', spawn: 'door' } } },
        { id: 'chapter1', end_screen: { title: 'a', subtitle: 'b', continue: { map: 'office', spawn: 'nope' } } },
        { id: 'chapter2', end_screen: { title: 'a', subtitle: 'b' } },
      ],
    };
    const inDream = (chapter, ret) => st({ chapter, location: { map: 'hall', x: 1, y: 1, dir: 'up' }, dream_return: ret });
    for (const ret of [null, { map: 'hall', x: 1, y: 1, dir: 'up' }, { map: 'gone', x: 0, y: 0, dir: 'up' }, 'room', [1, 2], { map: 'room', x: '1', y: 0.5, dir: 'up' }]) {
      const r = wakeUp(inDream('chapter1', ret), d2);
      expect(r.state.location).toEqual({ map: 'office', x: 3, y: 1, dir: 'left' }); // 序章 end_screen.continue
      expect(r.state.dream_return).toBe(null);
      expect(r.relocated).toBe(true);
    }
    // spawn 找不到 → 該地圖第一個 spawn（與讀檔校正相同）
    expect(wakeUp(inDream('chapter2', null), d2).state.location).toEqual({ map: 'office', x: 0, y: 1, dir: 'down' });
    // 序章、不認得的章節 → manifest.start
    expect(wakeUp(inDream('prologue', null), d2).state.location).toEqual({ map: 'room', x: 0, y: 0, dir: 'down' });
    expect(wakeUp(inDream('nope', null), d2).state.location).toEqual({ map: 'room', x: 0, y: 0, dir: 'down' });
    // 前一章的 continue 指向不存在或夢境地圖 → manifest.start
    const d3 = { ...d2, story: [{ ...d2.story[0], end_screen: { title: 'a', subtitle: 'b', continue: { map: 'hall', spawn: 'center' } } }, ...d2.story.slice(1)] };
    expect(wakeUp(inDream('chapter1', null), d3).state.location).toEqual({ map: 'room', x: 0, y: 0, dir: 'down' });
    // 連起點都找不到 → 丟錯
    expect(() => wakeUp(inDream('chapter1', null), { ...d3, manifest: { ...d3.manifest, start: { map: 'zzz', spawn: 'x' } } })).toThrow();
  });
  it('isDreamMap', () => {
    expect(isDreamMap(data.maps[1])).toBe(true);
    expect(isDreamMap(data.maps[0])).toBe(false);
    expect(isDreamMap(null)).toBe(false);
  });
});

describe('調查：dream 物件與 guest', () => {
  const room = data.maps[0];
  it('dream.if 成立 → 多一個 dream 目標（物件寫明的 map／spawn）', () => {
    const r = investigate(room.objects[0], st({ flags: { tired: true } }), data);
    expect(r.dialogues).toEqual(['dlg_bed']);
    expect(r.dream).toEqual({ map: 'hall', spawn: 'center' });
  });
  it('dream.if 不成立 → 沒有 dream', () => {
    expect(investigate(room.objects[0], st(), data).dream).toBeUndefined();
  });
  it('dream 沒有 if → 一律出現；一般物件沒有', () => {
    expect(investigate(room.objects[1], st(), data).dream).toEqual({ map: 'hall', spawn: 'side' });
    expect(investigate(room.objects[2], st(), data).dream).toBeUndefined();
  });
  it('已經在夢境地圖時不提供入夢', () => {
    const r = investigate(room.objects[1], st({ location: { map: 'hall', x: 1, y: 1, dir: 'up' } }), data);
    expect(r.dream).toBeUndefined();
  });
  it('guest 物件 → 回傳 guest id', () => {
    const r = investigate(data.maps[1].objects[0], st({ location: { map: 'hall', x: 1, y: 1, dir: 'up' } }), data);
    expect(r.guest).toBe('three');
    expect(r.dialogues).toEqual(['dlg_three']);
  });
  it('dreamTarget：取物件寫明的 map／spawn；缺少或地圖不是夢境 → null', () => {
    expect(dreamTarget({ dream: { map: 'hall', spawn: 'side' } }, data)).toEqual({ map: 'hall', spawn: 'side' });
    expect(dreamTarget({ dream: {} }, data)).toBe(null);
    expect(dreamTarget({ dream: { map: 'room', spawn: 'default' } }, data)).toBe(null);
    expect(dreamTarget({ dream: { map: 'hall', spawn: 'nope' } }, data)).toBe(null);
  });
  it('dreamTarget：prompt／yes／no（選填）是非空字串時一併帶出；其他型別、空字串一律略過', () => {
    expect(dreamTarget({ dream: { map: 'hall', spawn: 'side', prompt: '眼皮好重。', yes: '睡吧', no: '再撐一下' } }, data))
      .toEqual({ map: 'hall', spawn: 'side', prompt: '眼皮好重。', yes: '睡吧', no: '再撐一下' });
    expect(dreamTarget({ dream: { map: 'hall', spawn: 'side', prompt: '眼皮好重。' } }, data)).toEqual({ map: 'hall', spawn: 'side', prompt: '眼皮好重。' });
    expect(dreamTarget({ dream: { map: 'hall', spawn: 'side', prompt: '', yes: 5, no: null } }, data)).toEqual({ map: 'hall', spawn: 'side' });
  });
  it('調查：dream 物件寫了 prompt／yes／no → investigate 的 dream 目標帶著它們', () => {
    const obj = { ...room.objects[1], dream: { ...room.objects[1].dream, prompt: '瓶子還溫溫的。', yes: '喝一口', no: '蓋上蓋子' } };
    expect(investigate(obj, st(), data).dream).toEqual({ map: 'hall', spawn: 'side', prompt: '瓶子還溫溫的。', yes: '喝一口', no: '蓋上蓋子' });
  });
});

describe('夢客預寫台詞', () => {
  it('guestById 跨章節找', () => {
    expect(guestById(data, 'three')).toBe(guest);
    expect(guestById(data, 'nine')).toBe(null);
    expect(guestById(null, 'three')).toBe(null);
  });
  it('pickScripted：依種類隨機一句；種類不存在或空 → fallback；全沒有 → null', () => {
    expect(SCRIPTED_KINDS).toEqual(['greeting', 'fallback', 'quota', 'filtered', 'not_open']);
    expect(pickScripted(guest, 'greeting', () => 0)).toBe('……又見面了。');
    expect(pickScripted(guest, 'greeting', () => 0.99)).toBe('鐘聲還沒響完。');
    expect(pickScripted(guest, 'nope', () => 0)).toBe('霧太濃了。');
    expect(pickScripted({ scripted: {} }, 'quota', () => 0)).toBe(null);
    expect(pickScripted(null, 'quota')).toBe(null);
  });
  it('入夢選項對話：選「入夢」→ pending enter_dream；選「留在現實」→ 沒有 pending', () => {
    const dlg = dreamChoiceDialogue({ map: 'hall', spawn: 'center' });
    expect(dlg.id).toBe(DREAM_CHOICE_ID);
    let r = startDialogue(dlg, st());
    expect(r.current().choices.map((c) => c.text)).toEqual(['入夢', '留在現實']);
    r.choose(0);
    expect(r.done).toBe(true);
    expect(r.state.pending).toEqual([{ type: 'enter_dream', map: 'hall', spawn: 'center' }]);
    r = startDialogue(dlg, st());
    r.choose(1);
    expect(r.state.pending).toBe(null);
  });
  it('入夢選項對話：目標帶 prompt／yes／no 時改用資料的文字；只帶一部分時其餘用預設', () => {
    let r = startDialogue(dreamChoiceDialogue({ map: 'hall', spawn: 'center', prompt: '眼皮好重。', yes: '睡吧', no: '再撐一下' }), st());
    expect(r.current().text).toBe('眼皮好重。');
    expect(r.current().choices.map((c) => c.text)).toEqual(['睡吧', '再撐一下']);
    r.choose(0);
    expect(r.state.pending).toEqual([{ type: 'enter_dream', map: 'hall', spawn: 'center' }]);
    r = startDialogue(dreamChoiceDialogue({ map: 'hall', spawn: 'center', yes: '睡吧' }), st());
    expect(r.current().text).toBe(DREAM_PROMPT_DEFAULT.prompt);
    expect(r.current().choices.map((c) => c.text)).toEqual(['睡吧', DREAM_PROMPT_DEFAULT.no]);
    r.choose(1);
    expect(r.state.pending).toBe(null);
    expect(DREAM_PROMPT_DEFAULT).toEqual({ prompt: '一陣倦意湧上來。遠處好像有鐘聲。', yes: '入夢', no: '留在現實' });
  });
  it('入夢選項對話：文字裡的 {name} 和一般對話一樣代入', () => {
    const r = startDialogue(dreamChoiceDialogue({ map: 'hall', spawn: 'center', prompt: '{name}，睡吧。' }), st());
    expect(r.current().text).toBe(`${st().player.name}，睡吧。`);
  });
  it('未開放對話：夢客說 not_open 台詞，再加一句說明', () => {
    const dlg = notOpenDialogue(guest, () => 0);
    expect(dlg.id).toBe(NOT_OPEN_ID);
    const r = startDialogue(dlg, st());
    expect(r.current()).toMatchObject({ speaker: '三點', text: '（啟用雲端存檔後，可以和夢客自由交談。）' });
    r.advance();
    expect(r.current().speaker).toBe(null);
    expect(r.current().text).toMatch(/雲端存檔/);
    r.advance();
    expect(r.done).toBe(true);
  });
});

describe('newGame', () => {
  it('新遊戲的 dream_return 是 null', () => {
    const s = newGame({ name: 'A', manifest: data.manifest, maps: data.maps });
    expect(s.dream_return).toBe(null);
  });
});
