// M6 P2：遊戲事件 → 事件鍵（純函式）。事件鍵 → cue 的對應放在資料（web/audio/catalog.json 的 events），程式只查表。
import { describe, it, expect } from 'vitest';
import { EVENT_KEYS, battleEventKey, exploreEventKeys } from '../../web/src/audio/events.js';

const sides = { p1: 'party', p2: 'party', e1: 'enemy', e2: 'enemy' };
const skills = { attack: { id: 'attack', cost: {} }, shoot: { id: 'shoot', cost: { ammo: 1 } }, omen: { id: 'omen', cost: { sp: 4 } } };
const ctx = { sideOf: (uid) => sides[uid] ?? null, skillOf: (id) => skills[id] ?? null };
const key = (ev) => battleEventKey(ev, ctx);

describe('EVENT_KEYS', () => {
  it('列出所有程式會用到的事件鍵（catalog 必須全部對應，見 assets.test.js）', () => {
    expect([...EVENT_KEYS].sort()).toEqual([
      'battle.buff', 'battle.crit', 'battle.debuff', 'battle.defeat', 'battle.down', 'battle.heal', 'battle.hit', 'battle.hurt',
      'battle.lost_control', 'battle.miss', 'battle.shot', 'battle.status', 'battle.victory',
      'item.get', 'map.change', 'map.echo', 'map.investigate', 'map.unlock', 'save.ok',
    ]);
  });
});

describe('battleEventKey：BattleScene.playEvent 的事件型別 → 事件鍵', () => {
  it('行動：消耗子彈的技能是開槍；其他行動本身不響（由之後的傷害、治療等事件發聲）', () => {
    expect(key({ type: 'action', uid: 'p1', skill: 'shoot' })).toBe('battle.shot');
    expect(key({ type: 'action', uid: 'p1', skill: 'attack' })).toBeNull();
    expect(key({ type: 'action', uid: 'p1', skill: null, item: 'bandage' })).toBeNull();
    expect(key({ type: 'action', uid: 'e1', skill: 'unknown_skill' })).toBeNull();
  });
  it('傷害：打到敵人是 hit、我方受傷是 hurt；爆擊的傷害不再響（前一個 crit 事件已經響過）', () => {
    expect(key({ type: 'damage', source: 'p1', target: 'e1', amount: 5, crit: false })).toBe('battle.hit');
    expect(key({ type: 'damage', source: 'e1', target: 'p2', amount: 5, crit: false })).toBe('battle.hurt');
    expect(key({ type: 'crit', source: 'p1', target: 'e1' })).toBe('battle.crit');
    expect(key({ type: 'damage', source: 'p1', target: 'e1', amount: 9, crit: true })).toBeNull();
  });
  it('未命中、治療、增益、減益、狀態', () => {
    expect(key({ type: 'miss', source: 'p1', target: 'e1' })).toBe('battle.miss');
    expect(key({ type: 'heal', target: 'p1', amount: 3 })).toBe('battle.heal');
    expect(key({ type: 'buff', target: 'p1', stat: 'atk' })).toBe('battle.buff');
    expect(key({ type: 'debuff', target: 'e1', stat: 'def' })).toBe('battle.debuff');
    expect(key({ type: 'status', target: 'e1', status: 'sleep' })).toBe('battle.status');
  });
  it('倒下：敵人倒下響；我方倒下不另外響（受傷音已響）', () => {
    expect(key({ type: 'defeated', uid: 'e2' })).toBe('battle.down');
    expect(key({ type: 'defeated', uid: 'p1' })).toBeNull();
  });
  it('勝利、戰敗、失控', () => {
    expect(key({ type: 'victory' })).toBe('battle.victory');
    expect(key({ type: 'defeat' })).toBe('battle.defeat');
    expect(key({ type: 'lost_control' })).toBe('battle.lost_control');
  });
  it('其他事件（回合開始、消耗、揭露意圖、召喚、階段、逃跑…）與壞資料：null', () => {
    for (const type of ['turn_start', 'cost', 'sp', 'expire', 'intent_revealed', 'collapse', 'summon', 'summon_failed', 'phase', 'drop',
      'fled', 'flee_failed', 'sleep_skip', 'confused', 'retarget', 'status_resisted', 'item_used', 'nope']) {
      expect(key({ type }), type).toBeNull();
    }
    expect(battleEventKey(null, ctx)).toBeNull();
    expect(battleEventKey({ type: 'damage', target: 'zz' }, ctx)).toBeNull();
  });
});

const map = (id, objects = []) => ({ id, objects });
const data = {
  maps: [
    map('attic', [{ id: 'obj_door', lock: { flag: 'door_open' } }, { id: 'obj_bed' }]),
    map('hall'),
    map('fx_tower'),
  ],
};
const st = (over = {}) => ({
  location: { map: 'attic', x: 1, y: 1, dir: 'up' }, flags: {}, items: {}, chapter: 'prologue', dream_return: null, echo: { charges: 2 }, ...over,
});

describe('exploreEventKeys：狀態變化（＋觸發原因）→ 探索事件鍵', () => {
  it('調查／殘響：有對象（hit）才響；沒有對象不響', () => {
    expect(exploreEventKeys(st(), st(), { cause: 'investigate', hit: true }, data)).toEqual(['map.investigate']);
    expect(exploreEventKeys(st(), st(), { cause: 'investigate', hit: false }, data)).toEqual([]);
    expect(exploreEventKeys(st(), st({ echo: { charges: 1 } }), { cause: 'echo', hit: true }, data)).toEqual(['map.echo']);
    expect(exploreEventKeys(st(), st(), { cause: 'echo', hit: false }, data)).toEqual([]);
  });
  it('換地圖（出口、goto）：map.change；入夢與醒來（dream_return 變化）不響門聲（已有鐘聲）；換章不響', () => {
    expect(exploreEventKeys(st(), st({ location: { map: 'hall', x: 0, y: 0, dir: 'down' } }), null, data)).toEqual(['map.change']);
    const enter = st({ location: { map: 'fx_tower', x: 0, y: 0, dir: 'up' }, dream_return: { map: 'attic', x: 1, y: 1, dir: 'up' } });
    expect(exploreEventKeys(st(), enter, null, data)).toEqual([]);
    expect(exploreEventKeys(enter, st(), null, data)).toEqual([]);
    expect(exploreEventKeys(st(), st({ chapter: 'chapter1', location: { map: 'hall', x: 0, y: 0, dir: 'down' } }), null, data)).toEqual([]);
  });
  it('開鎖：目前地圖上某個鎖的 flag 由非 true 變 true → map.unlock；調查音讓位（同一下只響開鎖）', () => {
    expect(exploreEventKeys(st(), st({ flags: { door_open: true } }), null, data)).toEqual(['map.unlock']);
    expect(exploreEventKeys(st(), st({ flags: { door_open: true } }), { cause: 'investigate', hit: true }, data)).toEqual(['map.unlock']);
    expect(exploreEventKeys(st({ flags: { door_open: true } }), st({ flags: { door_open: true } }), null, data)).toEqual([]);
    expect(exploreEventKeys(st(), st({ flags: { unrelated: true } }), null, data)).toEqual([]);
  });
  it('取得道具：任何道具數量增加 → item.get（一次）；減少（使用、交出）不響', () => {
    expect(exploreEventKeys(st({ items: { a: 1 } }), st({ items: { a: 2, b: 1 } }), null, data)).toEqual(['item.get']);
    expect(exploreEventKeys(st({ items: { a: 2 } }), st({ items: { a: 1 } }), null, data)).toEqual([]);
    expect(exploreEventKeys(st({ items: { a: 2 } }), st({ items: { b: 1 } }), null, data)).toEqual(['item.get']); // 交換：給出 a、得到 b
  });
  it('殘響開鎖比照調查開鎖：只響開鎖（門）音，殘響音讓位；同時得到道具照樣響', () => {
    const k = exploreEventKeys(st(), st({ flags: { door_open: true }, items: { key: 1 }, echo: { charges: 1 } }), { cause: 'echo', hit: true }, data);
    expect(k).toEqual(['map.unlock', 'item.get']);
  });
  it('回到較早的狀態（cause: restore，例如 Game Over 的「重新挑戰」）：不響（道具數量變多不是取得道具）', () => {
    expect(exploreEventKeys(st({ items: {} }), st({ items: { bandage: 2 }, location: { map: 'hall', x: 0, y: 0, dir: 'down' } }), { cause: 'restore' }, data)).toEqual([]);
  });
  it('開新遊戲或讀檔（prev 為 null）、回標題（next 為 null）、壞資料：不響', () => {
    expect(exploreEventKeys(null, st({ items: { a: 1 } }), null, data)).toEqual([]);
    expect(exploreEventKeys(st(), null, null, data)).toEqual([]);
    expect(exploreEventKeys({}, {}, null, null)).toEqual([]);
  });
});
