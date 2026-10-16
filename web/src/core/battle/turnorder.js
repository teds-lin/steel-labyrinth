// 行動順序（DATA-FORMAT「公式」的 CTB）：每位行動者的 ct 從 0 開始；每一跳所有存活者 ct ＋＝ spd，
// 最先達到 100 的人行動，行動後 ct −＝ 100（由 engine 扣）。
// 同時有多人 ≥ 100：ct 高者先；再平手時我方先於敵方；同陣營依 units 陣列順序（＝隊伍順序／遭遇順序）。
// 睡眠中的人照樣累積 ct（輪到時由 engine 跳過）。純函式，不修改輸入。
import { effectiveStat } from './stat.js';

export const CT_THRESHOLD = 100;
/** 一次預覽／推進最多跳幾次（防呆：速度至少 1，所以 100 跳內必定有人達標）。 */
const MAX_TICKS = CT_THRESHOLD + 1;

/** CTB 用的速度（含增益／減益），最少 1。 */
export const ctbSpeed = (unit) => Math.max(1, effectiveStat(unit, 'spd'));

const sideRank = (u) => (u.side === 'party' ? 0 : 1);

/** 已達門檻的存活者中，該先行動的那一位的索引；沒有回 -1。 */
function readyIndex(units) {
  let best = -1;
  units.forEach((u, i) => {
    if (!u.alive || u.ct < CT_THRESHOLD) return;
    if (best < 0) { best = i; return; }
    const b = units[best];
    if (u.ct > b.ct || (u.ct === b.ct && sideRank(u) < sideRank(b))) best = i;
  });
  return best;
}

/**
 * 找出下一位行動者：已有人 ≥ 100 時直接選；否則一跳一跳推進。
 * 回傳 { uid（沒有存活者時 null）, units（ct 已推進的新陣列） }。
 */
export function nextActor(units) {
  let cur = units.map((u) => ({ ...u }));
  if (!cur.some((u) => u.alive)) return { uid: null, units: cur };
  for (let t = 0; t <= MAX_TICKS; t++) {
    const i = readyIndex(cur);
    if (i >= 0) return { uid: cur[i].uid, units: cur };
    cur = cur.map((u) => (u.alive ? { ...u, ct: u.ct + ctbSpeed(u) } : u));
  }
  throw new Error('行動順序推進失敗（不應發生）');
}

/**
 * 預覽接下來 n 位行動者的 uid（第一位是目前行動者，若有）。不改變戰鬥狀態。
 * 只依目前的速度推算（增益到期、睡眠跳過、倒下等未來變化不納入）。
 */
export function previewOrder(battle, n) {
  const out = [];
  let units = battle.units.map((u) => ({ ...u }));
  const consume = (uid) => {
    out.push(uid);
    units = units.map((u) => (u.uid === uid ? { ...u, ct: u.ct - CT_THRESHOLD } : u));
  };
  if (battle.actor && units.some((u) => u.uid === battle.actor && u.alive) && out.length < n) consume(battle.actor);
  while (out.length < n) {
    const r = nextActor(units);
    if (r.uid === null) break;
    units = r.units;
    consume(r.uid);
  }
  return out;
}
