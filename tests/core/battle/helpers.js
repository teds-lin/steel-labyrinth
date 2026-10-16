// 戰鬥單元測試用：手工組一個最小戰鬥狀態。
import { createRng } from '../../../web/src/core/rng.js';

export const unit = (uid, side, stats = {}, over = {}) => {
  const st = { hp: 50, sp: 10, atk: 10, def: 4, spd: 10, will: 0, eva: 0, ...stats };
  return {
    uid, side, id: over.id ?? (side === 'party' ? (uid === 'p0' ? 'hero' : 'ada') : 'fogwalker'), name: uid,
    stats: st, hp: st.hp, sp: st.sp, ct: 0, mods: {}, status: {}, alive: true, acted: 0,
    skills: [], intent: null, revealed: false, phasesDone: [], extraAi: [],
    ...over,
  };
};

export const mkBattle = (units, over = {}) => ({
  version: 1, encounter: 'enc_test', rng: createRng(1), seq: 0, units, actor: null,
  collapse: 0, ammo: 0, items: {}, drops: [], outcome: null, nextUid: units.length, canFlee: false,
  ...over,
});

export const byUid = (battle, uid) => battle.units.find((u) => u.uid === uid);
