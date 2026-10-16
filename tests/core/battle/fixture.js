// 戰鬥相關測試共用的小型資料（不是正式內容）。
export function battleData() {
  return {
    items: [
      { id: 'bandage', name: '繃帶', desc: '止血用。', target: 'ally', battle_effects: [{ type: 'heal', amount: 20 }] },
      { id: 'incense', name: '鎮靜香', desc: '降低崩解。', field_effects: [{ collapse: -15 }],
        target: 'self', battle_effects: [{ type: 'collapse', amount: -15 }] },
      { id: 'revolver', name: '左輪手槍', desc: '舊式左輪。' },
      { id: 'pocket_watch', name: '懷錶', desc: '停住的懷錶。' },
    ],
    lineages: [
      { id: 'trace', ranks: [
        { rank: 9, name: '讀痕者', field: ['trace'], skills: ['omen'], stats: { hp: 10, sp: 10, will: 4 } },
        { rank: 8, name: '深痕者', field: ['deep_trace'], skills: ['deep'], stats: { atk: 2 } },
      ] },
      { id: 'dream', ranks: [
        { rank: 9, name: '入夢者', skills: ['lull'], stats: { sp: 5 } },
        { rank: 8, name: '織夢者', skills: ['mend'], stats: { will: 2 } },
      ] },
    ],
    characters: [
      { id: 'hero', name: '{name}', sprite: 'hero',
        base: { hp: 60, sp: 20, atk: 10, def: 6, spd: 10, will: 10, eva: 5 },
        skills: ['attack', 'guard', 'shoot'] },
      { id: 'ada', name: '艾妲・費恩', sprite: 'ada', lineage: { id: 'dream', rank: 8 },
        base: { hp: 50, sp: 30, atk: 7, def: 5, spd: 12, will: 14, eva: 5 },
        skills: ['attack', 'guard'] },
      { id: 'herb', name: '老賀伯', sprite: 'herb',
        base: { hp: 40, sp: 10, atk: 6, def: 4, spd: 8, will: 8, eva: 0 },
        skills: ['attack'] },
    ],
    skills: [
      { id: 'attack', name: '攻擊', desc: '普通攻擊。', target: 'enemy', effects: [{ type: 'damage', power: 100 }] },
      { id: 'guard', name: '防禦', desc: '受到的傷害減半。', target: 'self', effects: [{ type: 'status', status: 'guard', turns: 1 }] },
      { id: 'shoot', name: '開槍', desc: '固定傷害。', cost: { ammo: 1 }, target: 'enemy', effects: [{ type: 'damage', fixed: 25, ignore_def: true }] },
      { id: 'omen', name: '預兆', desc: '看穿下一步。', cost: { sp: 4 }, target: 'enemy',
        effects: [{ type: 'reveal_intent' }, { type: 'buff', stat: 'eva', pct: 30, turns: 2, on: 'self' }] },
      { id: 'deep', name: '深擊', desc: '重擊。', cost: { sp: 5 }, target: 'enemy', effects: [{ type: 'damage', power: 150 }] },
      { id: 'lull', name: '催眠', desc: '使敵人睡著。', cost: { sp: 5 }, target: 'enemy', effects: [{ type: 'status', status: 'sleep', chance: 80, turns: 2 }] },
      { id: 'mend', name: '縫補', desc: '回復同伴。', cost: { sp: 6 }, target: 'ally', effects: [{ type: 'heal', pct: 30 }] },
      { id: 'whisper_minor', name: '低語', desc: '耳語。', target: 'enemy', tags: ['whisper'],
        effects: [{ type: 'damage', power: 50 }, { type: 'collapse', amount: 10 }] },
      { id: 'call_fog', name: '喚霧', desc: '呼喚霧行者。', target: 'self', effects: [{ type: 'summon', enemy: 'fogwalker', max: 2 }] },
    ],
    enemies: [
      { id: 'fogwalker', name: '霧行者', sprite: 'fogwalker', rank: 9,
        stats: { hp: 40, sp: 0, atk: 9, def: 4, spd: 9, will: 5, eva: 5 },
        skills: ['attack', 'whisper_minor'],
        ai: [{ skill: 'whisper_minor', weight: 1, if: { turn_gte: 2 } }, { skill: 'attack', weight: 3 }],
        drops: [{ item: 'bandage', chance: 30 }] },
      { id: 'porter', name: '沉默的搬運工', sprite: 'porter', rank: 8,
        stats: { hp: 120, sp: 0, atk: 12, def: 6, spd: 8, will: 10, eva: 0 },
        skills: ['attack', 'whisper_minor', 'call_fog'],
        ai: [{ skill: 'attack', weight: 1 }],
        phases: [{ hp_lte_pct: 50, add_ai: [{ skill: 'call_fog', weight: 100, if: { allies_lte: 1 } }], dialogue: 'dlg_phase' }],
        drops: [{ item: 'pocket_watch', chance: 100 }] },
    ],
    encounters: [
      { id: 'enc_one', enemies: ['fogwalker'], bg: 'dock', can_flee: true,
        on_win: { effects: [{ set_flag: 'won_one' }], dialogue: 'dlg_after' }, on_lose: 'retry' },
      { id: 'enc_two', enemies: ['fogwalker', 'fogwalker'], can_flee: false },
      { id: 'enc_boss', enemies: ['porter'], can_flee: false, on_win: { dialogue: 'dlg_after' }, on_lose: 'continue' },
    ],
  };
}

/** 有主角（可選帶譜系與隊友）的 v2 遊戲狀態。 */
export function battleState(over = {}) {
  return {
    schema_version: 2,
    player: { name: '艾琳' },
    lineage: null,
    location: { map: 'dock', x: 1, y: 1, dir: 'down' },
    flags: {}, items: {}, echo: { charges: 0 }, collapse: 0, resonance: {},
    chapter: 'chapter1', chapter_done: [], playtime_s: 0,
    party: [{ id: 'hero', hp: null, sp: null }],
    ammo: 0,
    pending: null,
    ...over,
  };
}
