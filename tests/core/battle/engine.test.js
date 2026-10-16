import { describe, it, expect } from 'vitest';
import {
  startBattle, currentActor, isPlayerTurn, commands, act, advanceEnemy, intentOf, finishBattle, simulate, basicPolicy, turnOrder,
} from '../../../web/src/core/battle/engine.js';
import { battleData, battleState } from './fixture.js';

const data = battleData();
const byUid = (b, uid) => b.units.find((u) => u.uid === uid);
const heroState = (over = {}) => battleState({ lineage: { id: 'trace', rank: 9 }, ammo: 3, items: { bandage: 2 }, ...over });
/** 把敵人回合跑完，直到輪到我方或戰鬥結束；回傳 { battle, logs }。 */
function runEnemies(battle) {
  const logs = [];
  let b = battle;
  while (b.outcome === null && !isPlayerTurn(b)) {
    const r = advanceEnemy(b, data);
    logs.push(r.log);
    b = r.battle;
  }
  return { battle: b, logs };
}
/** 找一個「一開始就輪到我方」的種子。 */
const playerFirst = (enc, state, from = 1) => {
  for (let s = from; s < from + 500; s++) {
    const b = startBattle(enc, state, data, s);
    if (isPlayerTurn(b)) return b;
  }
  throw new Error('找不到種子');
};

describe('startBattle', () => {
  it('依隊伍與遭遇建立行動者；hp/sp 的 null＝滿值；崩解、子彈、道具帶進戰鬥', () => {
    const s = heroState({ party: [{ id: 'hero', hp: null, sp: 7 }, { id: 'ada', hp: 12, sp: null }], collapse: 20 });
    const before = JSON.stringify(s);
    const b = startBattle('enc_two', s, data, 42);
    expect(JSON.stringify(s)).toBe(before);
    expect(b.units.map((u) => [u.uid, u.side, u.id, u.hp, u.sp])).toEqual([
      ['p0', 'party', 'hero', 70, 7], ['p1', 'party', 'ada', 12, 35], ['e0', 'enemy', 'fogwalker', 40, 0], ['e1', 'enemy', 'fogwalker', 40, 0],
    ]);
    expect(byUid(b, 'p0').name).toBe('艾琳');
    expect(byUid(b, 'p0').skills).toEqual(['attack', 'guard', 'shoot', 'omen']);
    expect(b).toMatchObject({ encounter: 'enc_two', collapse: 20, ammo: 3, items: { bandage: 2 }, outcome: null, canFlee: false });
    expect(JSON.parse(JSON.stringify(b))).toEqual(b); // 純資料
  });
  it('戰鬥開始時所有敵人都已決定意圖；目前行動者已決定', () => {
    const b = startBattle('enc_two', heroState(), data, 1);
    for (const u of b.units.filter((x) => x.side === 'enemy')) expect(u.intent).toMatchObject({ skill: 'attack', target: 'p0' });
    expect(currentActor(b)).not.toBe(null);
  });
  it('同 seed 結果相同；未知遭遇丟錯', () => {
    expect(startBattle('enc_two', heroState(), data, 5)).toEqual(startBattle('enc_two', heroState(), data, 5));
    expect(() => startBattle('enc_ghost', heroState(), data, 1)).toThrow(/enc_ghost/);
    expect(() => startBattle('toString', heroState(), data, 1)).toThrow(/toString/);
  });
  it('崩解已達 100 → 立即 lost_control', () => {
    expect(startBattle('enc_one', heroState({ collapse: 100 }), data, 1).outcome).toBe('lost_control');
  });
});

describe('commands', () => {
  it('列出目前行動者的技能（是否可用與原因、可選目標）、道具、能否逃跑', () => {
    const b = playerFirst('enc_one', heroState({ ammo: 0, party: [{ id: 'hero', hp: null, sp: 2 }] }));
    const c = commands(b, data);
    expect(c.actor).toBe('p0');
    expect(c.skills.map((s) => [s.id, s.usable, s.reason])).toEqual([
      ['attack', true, null], ['guard', true, null], ['shoot', false, 'ammo'], ['omen', false, 'sp'],
    ]);
    expect(c.skills[0]).toMatchObject({ name: '攻擊', target: 'enemy', targets: ['e0'], cost: { sp: 0, ammo: 0 } });
    expect(c.skills[1].targets).toEqual(['p0']);
    expect(c.items).toEqual([{ id: 'bandage', name: '繃帶', count: 2, target: 'ally', targets: ['p0'] }]);
    expect(c.canFlee).toBe(true);
  });
  it('不是我方回合 → null（敵人比較快時敵人先手；CTB 不靠亂數）', () => {
    const d = structuredClone(data);
    d.enemies[0].stats.spd = 20;
    const b = startBattle('enc_one', heroState(), d, 1);
    expect(currentActor(b)).toMatchObject({ uid: 'e0', side: 'enemy' });
    expect(commands(b, d)).toBe(null);
  });
});

describe('act（我方行動）', () => {
  it('攻擊：扣敵人生命、送出 action／damage 事件；不修改輸入；推進到下一位行動者', () => {
    const b = playerFirst('enc_one', heroState());
    const before = JSON.stringify(b);
    const r = act(b, { type: 'skill', skill: 'attack', target: 'e0' }, data);
    expect(JSON.stringify(b)).toBe(before);
    expect(r.log[0]).toEqual({ type: 'action', uid: 'p0', skill: 'attack', target: 'e0', targets: ['e0'] });
    const dmg = r.log.find((e) => e.type === 'damage');
    expect(byUid(r.battle, 'e0').hp).toBe(40 - dmg.amount);
    expect(byUid(r.battle, 'p0').ct).toBeLessThan(100);
    expect(r.battle.actor).not.toBe(null);
  });
  it('消耗：靈性與子彈扣在戰鬥狀態；開槍固定 25 傷害', () => {
    const b = playerFirst('enc_one', heroState());
    const r = act(b, { type: 'skill', skill: 'shoot', target: 'e0' }, data);
    expect(r.battle.ammo).toBe(2);
    expect(r.log).toContainEqual({ type: 'cost', uid: 'p0', sp: 0, ammo: 1 });
    expect(r.log.find((e) => e.type === 'damage').amount).toBe(25);
    const r2 = act(b, { type: 'skill', skill: 'omen', target: 'e0' }, data);
    expect(byUid(r2.battle, 'p0').sp).toBe(26);
  });
  it('道具：消耗 1 個並套用道具的 battle_effects；沒有 battle_effects 的道具不出現在清單、不能用', () => {
    const b = playerFirst('enc_one', heroState({ party: [{ id: 'hero', hp: 10, sp: null }], items: { bandage: 2, revolver: 1, incense: 1 }, collapse: 30 }));
    expect(commands(b, data).items.map((i) => i.id)).toEqual(['bandage', 'incense']);
    const r = act(b, { type: 'item', item: 'bandage', target: 'p0' }, data);
    expect(r.battle.items).toEqual({ bandage: 1, revolver: 1, incense: 1 });
    expect(r.log[0]).toEqual({ type: 'action', uid: 'p0', skill: null, item: 'bandage', target: 'p0', targets: ['p0'] });
    const r2 = act(b, { type: 'item', item: 'incense' }, data);
    expect(r2.battle.collapse).toBe(15); // 負值不受意志縮放
    expect(r2.battle.items.incense).toBe(undefined);
    expect(r.log).toContainEqual({ type: 'item_used', uid: 'p0', item: 'bandage' });
    expect(byUid(r.battle, 'p0').hp).toBe(30);
  });
  it('不合法的指令丟錯', () => {
    const b = playerFirst('enc_one', heroState({ ammo: 0 }));
    const bad = [
      { type: 'skill', skill: 'lull', target: 'e0' }, { type: 'skill', skill: 'shoot', target: 'e0' }, { type: 'skill', skill: 'attack' },
      { type: 'skill', skill: 'attack', target: 'p0' }, { type: 'skill', skill: 'attack', target: 'e9' },
      { type: 'item', item: 'revolver', target: 'p0' }, { type: 'item', item: 'pocket_watch', target: 'p0' }, { type: 'dance' }, null,
    ];
    for (const c of bad) expect(() => act(b, c, data), JSON.stringify(c)).toThrow();
    const noFlee = playerFirst('enc_two', heroState());
    expect(() => act(noFlee, { type: 'flee' }, data)).toThrow(/逃/);
  });
  it('不是我方回合時丟錯；advanceEnemy 在我方回合時丟錯', () => {
    const b = playerFirst('enc_one', heroState());
    expect(() => advanceEnemy(b, data)).toThrow();
    const e = runEnemies(act(b, { type: 'skill', skill: 'guard' }, data).battle);
    if (e.battle.outcome === null) expect(isPlayerTurn(e.battle)).toBe(true);
  });
});

describe('敵人回合與預兆（B4）', () => {
  it('advanceEnemy 依照事先決定的意圖行動，之後立刻決定下一次意圖', () => {
    let b = startBattle('enc_two', heroState(), data, 3);
    if (isPlayerTurn(b)) b = act(b, { type: 'skill', skill: 'guard' }, data).battle;
    const uid = b.actor;
    const intent = structuredClone(byUid(b, uid).intent);
    const r = advanceEnemy(b, data);
    expect(r.log[0]).toMatchObject({ type: 'action', uid, skill: intent.skill, target: intent.target });
    expect(byUid(r.battle, uid).intent).not.toBe(null);
    expect(byUid(r.battle, uid).acted).toBe(1);
  });
  it('預兆揭露的意圖必定成真；intentOf 只回傳被揭露過的意圖', () => {
    for (let s = 1; s <= 30; s++) {
      let b = playerFirst('enc_one', heroState(), s);
      expect(intentOf(b, 'e0')).toBe(null);
      b = act(b, { type: 'skill', skill: 'omen', target: 'e0' }, data).battle;
      const shown = intentOf(b, 'e0', data);
      if (b.outcome !== null || isPlayerTurn(b)) continue;
      expect(shown).toMatchObject({ skill: expect.any(String), target: 'p0', skill_name: expect.any(String) });
      const r = advanceEnemy(b, data);
      expect(r.log[0]).toMatchObject({ type: 'action', uid: 'e0', skill: shown.skill, target: shown.target });
      expect(intentOf(r.battle, 'e0')).toBe(null); // 行動後重新決定，新的意圖尚未揭露
    }
  });
  it('意圖的目標在那之前倒下 → 改打隊伍中下一位存活者', () => {
    let b = startBattle('enc_one', heroState({ party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }] }), data, 8);
    b = structuredClone(b);
    const e0 = byUid(b, 'e0');
    e0.intent = { skill: 'attack', target: 'p0' };
    Object.assign(byUid(b, 'p0'), { hp: 0, alive: false });
    b.actor = 'e0';
    e0.ct = 100;
    const r = advanceEnemy(b, data);
    expect(r.log).toContainEqual({ type: 'retarget', uid: 'e0', from: 'p0', to: 'p1' });
    expect(r.log.find((e) => e.type === 'action')).toMatchObject({ target: 'p1' });
  });
  it('攻擊方是敵人時會被閃避（miss）：eva 100 的我方必定閃過', () => {
    const d = structuredClone(data);
    d.characters[0].base.eva = 100;
    let b = startBattle('enc_one', heroState(), d, 2);
    while (isPlayerTurn(b)) b = act(b, { type: 'skill', skill: 'guard' }, d).battle;
    const r = advanceEnemy(b, d);
    expect(r.log).toContainEqual({ type: 'miss', source: 'e0', target: 'p0' });
    expect(r.log.some((e) => e.type === 'damage')).toBe(false);
  });
  it('睡眠中的敵人輪到時跳過並減少睡眠回合（sleep_skip），意圖不變', () => {
    let b = structuredClone(playerFirst('enc_one', heroState()));
    byUid(b, 'e0').status.sleep = 1;
    const intent = byUid(b, 'e0').intent;
    const r = act(b, { type: 'skill', skill: 'guard' }, data);
    const all = [r.log, ...runEnemies(r.battle).logs].flat();
    expect(all).toContainEqual({ type: 'sleep_skip', uid: 'e0' });
    expect(byUid(r.battle, 'e0').intent).toEqual(intent);
  });
  it('防禦（guard）持續到自己的下一個回合開始', () => {
    const b = playerFirst('enc_one', heroState());
    const r = act(b, { type: 'skill', skill: 'guard' }, data);
    expect(byUid(r.battle, 'p0').status.guard).toBe(1);
    const e = runEnemies(r.battle);
    if (e.battle.outcome === null) {
      expect(byUid(e.battle, 'p0').status.guard).toBe(undefined);
      expect(e.logs.flat().concat(r.log)).toContainEqual({ type: 'expire', uid: 'p0', kind: 'status', key: 'guard' });
    }
  });
});

describe('勝敗', () => {
  it('全部敵人倒下 → victory；之後不能再行動', () => {
    const d = structuredClone(data);
    d.skills[0].effects = [{ type: 'damage', fixed: 999 }];
    const b = playerFirst('enc_one', heroState());
    const r = act(b, { type: 'skill', skill: 'attack', target: 'e0' }, d);
    expect(r.battle.outcome).toBe('victory');
    expect(r.log.at(-1)).toEqual({ type: 'victory' });
    expect(r.battle.actor).toBe(null);
    expect(currentActor(r.battle)).toBe(null);
    expect(() => act(r.battle, { type: 'skill', skill: 'attack', target: 'e0' }, d)).toThrow();
  });
  it('全隊生命 0 → defeat', () => {
    const d = structuredClone(data);
    d.skills[0].effects = [{ type: 'damage', fixed: 999 }];
    d.characters[0].base.eva = 0;
    let b = startBattle('enc_one', heroState(), d, 4);
    let guard = 0;
    while (b.outcome === null && guard++ < 10) {
      b = isPlayerTurn(b) ? act(b, { type: 'skill', skill: 'guard' }, d).battle : advanceEnemy(b, d).battle;
    }
    expect(b.outcome).toBe('defeat');
  });
  it('崩解達 100 → 立即 lost_control', () => {
    const d = structuredClone(data);
    d.enemies[0].ai = [{ skill: 'whisper_minor', weight: 1 }];
    d.enemies[0].stats.atk = 1;
    d.characters[0].base.eva = 0;
    let b = startBattle('enc_one', heroState({ collapse: 95 }), d, 6);
    let log = [];
    while (b.outcome === null) {
      const r = isPlayerTurn(b) ? act(b, { type: 'skill', skill: 'guard' }, d) : advanceEnemy(b, d);
      b = r.battle;
      log = r.log;
    }
    expect(b.outcome).toBe('lost_control');
    expect(log.at(-1)).toEqual({ type: 'lost_control' });
    expect(b.collapse).toBe(100);
  });
  it('逃跑成功率約 50%（PRNG）；失敗會用掉這個回合', () => {
    let fled = 0;
    for (let s = 1; s <= 200; s++) {
      const b = playerFirst('enc_one', heroState(), s);
      const r = act(b, { type: 'flee' }, data);
      if (r.battle.outcome === 'fled') { fled++; expect(r.log.at(-1)).toEqual({ type: 'fled' }); }
      else { expect(r.log).toContainEqual({ type: 'flee_failed', uid: 'p0' }); expect(byUid(r.battle, 'p0').ct).toBeLessThan(100); }
    }
    expect(fled).toBeGreaterThan(70);
    expect(fled).toBeLessThan(130);
  });
});

describe('turnOrder（畫面上方的行動順序）', () => {
  it('預覽 6 位，不改變戰鬥狀態；第一位是目前行動者', () => {
    const b = startBattle('enc_two', heroState(), data, 9);
    const before = JSON.stringify(b);
    const order = turnOrder(b, 6);
    expect(order).toHaveLength(6);
    expect(order[0]).toBe(b.actor);
    expect(JSON.stringify(b)).toBe(before);
  });
});

describe('finishBattle（回寫遊戲狀態）', () => {
  const won = (state, enc = 'enc_one') => {
    const d = structuredClone(data);
    d.skills[0].effects = [{ type: 'damage', fixed: 999 }];
    const b = playerFirst(enc, state);
    return act(b, { type: 'skill', skill: 'attack', target: 'e0' }, d).battle;
  };
  it('勝利：回寫 hp/sp/子彈/崩解/道具、發放掉落、套用 on_win.effects、回傳接下來的對話', () => {
    const s = heroState({ party: [{ id: 'hero', hp: 33, sp: 9 }], collapse: 4 });
    const b = structuredClone(won(s));
    b.drops = [{ item: 'bandage', count: 1 }];
    b.ammo = 1;
    b.items = { bandage: 1 };
    const before = JSON.stringify(s);
    const r = finishBattle(b, s, data);
    expect(JSON.stringify(s)).toBe(before);
    expect(r.outcome).toBe('victory');
    expect(r.state.party).toEqual([{ id: 'hero', hp: 33, sp: 9 }]);
    expect(r.state).toMatchObject({ ammo: 1, collapse: 4, items: { bandage: 2 }, flags: { won_one: true } });
    expect(r.rewards).toEqual({ items: [{ item: 'bandage', count: 1 }] });
    expect(r.next).toEqual({ type: 'dialogue', dialogue: 'dlg_after' });
  });
  it('勝利時倒下的隊友以 1 點生命歸隊；沒有 on_win 時 next 為 null', () => {
    const s = heroState({ party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }] });
    const b = structuredClone(won(s, 'enc_two'));
    Object.assign(byUid(b, 'p1'), { hp: 0, alive: false });
    b.outcome = 'victory';
    const r = finishBattle(b, s, data);
    expect(r.state.party[1]).toEqual({ id: 'ada', hp: 1, sp: 35 });
    expect(r.next).toBe(null);
  });
  it('失敗＋on_lose retry（預設）→ 不改 state，next 為 retry；失控同樣 retry', () => {
    const s = heroState();
    const b = { ...startBattle('enc_one', s, data, 1), outcome: 'defeat' };
    expect(finishBattle(b, s, data)).toEqual({ state: s, outcome: 'defeat', rewards: { items: [] }, next: { type: 'retry' } });
    const lc = { ...startBattle('enc_boss', s, data, 1), outcome: 'lost_control' };
    expect(finishBattle(lc, s, data).next).toEqual({ type: 'retry' });
  });
  it('失敗＋on_lose continue（教學戰）→ 照樣執行 on_win 的劇情，隊伍以 1 點生命繼續', () => {
    const s = heroState();
    const b = structuredClone(startBattle('enc_boss', s, data, 1));
    Object.assign(byUid(b, 'p0'), { hp: 0, alive: false });
    b.outcome = 'defeat';
    const r = finishBattle(b, s, data);
    expect(r.outcome).toBe('defeat');
    expect(r.state.party[0].hp).toBe(1);
    expect(r.next).toEqual({ type: 'dialogue', dialogue: 'dlg_after' });
  });
  it('逃跑：回寫狀態，沒有獎勵與劇情；戰鬥未結束時丟錯', () => {
    const s = heroState();
    const b = { ...startBattle('enc_one', s, data, 1), outcome: 'fled' };
    const r = finishBattle(b, s, data);
    expect(r).toMatchObject({ outcome: 'fled', next: null, rewards: { items: [] } });
    expect(r.state.flags.won_one).toBe(undefined);
    expect(() => finishBattle(startBattle('enc_one', s, data, 1), s, data)).toThrow(/尚未結束/);
  });
});

describe('一場完整戰鬥＋重播一致（B10）', () => {
  it('simulate：用簡單策略打完整場，回傳結果與全部事件', () => {
    const s = heroState({ party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }] });
    const r = simulate('enc_two', s, data, 2024, basicPolicy);
    expect(['victory', 'defeat', 'lost_control']).toContain(r.outcome);
    expect(r.battle.outcome).toBe(r.outcome);
    expect(r.log.at(-1).type).toBe(r.outcome);
    expect(r.log.filter((e) => e.type === 'action').length).toBeGreaterThan(2);
    expect(r.log.filter((e) => e.type === 'defeated').length).toBeGreaterThanOrEqual(2);
  });
  it('同 seed＋同指令序列 → 完全相同的 log 與最終狀態；不同 seed 不同', () => {
    const s = heroState({ party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }] });
    const a = simulate('enc_two', s, data, 77, basicPolicy);
    const b = simulate('enc_two', s, data, 77, basicPolicy);
    expect(b.log).toEqual(a.log);
    expect(b.battle).toEqual(a.battle);
    expect(simulate('enc_two', s, data, 78, basicPolicy).log).not.toEqual(a.log);
  });
  it('重播：記下指令序列，從同一個 seed 重新執行得到同樣的 log', () => {
    const s = heroState();
    const cmds = [];
    const recorder = (b, c, d) => { const cmd = basicPolicy(b, c, d); cmds.push(cmd); return cmd; };
    const first = simulate('enc_boss', s, data, 31, recorder);
    let i = 0;
    const replay = simulate('enc_boss', s, data, 31, () => cmds[i++]);
    expect(replay.log).toEqual(first.log);
    expect(i).toBe(cmds.length);
  });
  it('Boss 進入第二階段會送出 phase 事件並呼喚霧行者', () => {
    const s = heroState({ party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }] });
    const r = simulate('enc_boss', s, data, 5, basicPolicy);
    expect(r.log).toContainEqual({ type: 'phase', uid: 'e0', index: 0, dialogue: 'dlg_phase' });
    expect(r.log.some((e) => e.type === 'summon')).toBe(true);
  });
  it('simulate 是純函式：不修改 state 與 data', () => {
    const s = heroState();
    const before = JSON.stringify([s, data]);
    simulate('enc_one', s, data, 1, basicPolicy);
    expect(JSON.stringify([s, data])).toBe(before);
  });
});
