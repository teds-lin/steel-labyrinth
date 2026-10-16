// 與物件互動：面前目標、【調查】、【殘響】、解鎖（DATA-FORMAT「lock」與「探索標籤」）。
import { DIRS, objectsAt, isUnlocked } from './grid.js';
import { ECHO_TAG, hasEcho, spendEcho } from './echo.js';
import { availableFieldTags, lineageFieldTags } from './state.js';

export const NO_TRACE_MESSAGE = '沒有殘留痕跡';
export const NO_CHARGE_MESSAGE = '殘響次數已用盡';

/** 解析 lock.fallback；目前只支援 item:<id>。 */
export function parseFallback(fallback) {
  const m = typeof fallback === 'string' ? /^item:(.+)$/.exec(fallback) : null;
  if (!m) throw new Error(`不支援的 fallback 寫法：${JSON.stringify(fallback)}（目前只支援 item:<id>）`);
  return { kind: 'item', id: m[1] };
}

/** 玩家面前那一格存在的物件（if 成立）；沒有回 null。 */
export function facingTarget(map, state, data) {
  const loc = state.location;
  const d = DIRS[loc.dir];
  if (!d) return null;
  return objectsAt(map, state, loc.x + d.dx, loc.y + d.dy)[0] ?? null;
}

/** 【調查】：回傳要播放的對話 id（沒有則 null），不改 state。 */
export function look(obj, state) {
  return { state, dialogue: typeof obj.look === 'string' ? obj.look : null };
}

/**
 * 目前可用的解法（不含已解開的情況）。
 * 標籤解法依 solvable_by 順序，cost 為 'echo' 表示要消耗殘響；最後是 fallback 道具。
 */
export function unlockOptions(obj, state, data) {
  const lock = obj.lock;
  if (!lock) return [];
  const all = new Set(availableFieldTags(state, data));
  const free = new Set(lineageFieldTags(state, data));
  const opts = [];
  for (const tag of lock.solvable_by ?? []) {
    if (!all.has(tag)) continue;
    opts.push({ method: 'tag', tag, cost: free.has(tag) ? null : (tag === ECHO_TAG ? 'echo' : null) });
  }
  const fb = parseFallback(lock.fallback);
  if ((state.items?.[fb.id] ?? 0) > 0) opts.push({ method: 'item', item: fb.id, cost: null });
  return opts;
}

// 預設偏好：不花代價的標籤 > 道具 > 要花殘響的標籤（避免玩家有鑰匙還被扣殘響）。
const rank = (o) => (o.method === 'tag' && o.cost === null ? 0 : o.method === 'item' ? 1 : 2);

/**
 * 嘗試解鎖。opts.method 可指定 'tag'（可再指定 tag）或 'item'；不指定時自動選。
 * 回傳 { state, dialogue, unlocked, via: 'tag'|'item'|'already'|null, tag?, item? }。
 * 用標籤且代價為殘響時，引擎會自動扣 1 次殘響（崩解 +5）；道具不會被消耗。
 */
export function tryUnlock(obj, state, data, opts = {}) {
  const lock = obj?.lock;
  if (!lock) throw new Error(`物件「${obj?.id}」沒有 lock`);
  if (isUnlocked(obj, state)) {
    return { state, dialogue: typeof obj.look === 'string' ? obj.look : null, unlocked: true, via: 'already' };
  }
  let candidates = unlockOptions(obj, state, data);
  if (opts.method) candidates = candidates.filter((o) => o.method === opts.method && (opts.tag === undefined || o.tag === opts.tag));
  const pick = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
  if (!pick) return { state, dialogue: lock.locked ?? null, unlocked: false, via: null };

  let next = pick.cost === 'echo' ? spendEcho(state) : state;
  next = { ...next, flags: { ...next.flags, [lock.flag]: true } };
  if (pick.method === 'tag') {
    return { state: next, dialogue: lock.on_tag?.[pick.tag] ?? null, unlocked: true, via: 'tag', tag: pick.tag };
  }
  return { state: next, dialogue: lock.on_item ?? null, unlocked: true, via: 'item', item: pick.item };
}

/**
 * 【殘響】：
 * - 次數為 0 → 訊息，不改 state。
 * - 對尚未解開、且 solvable_by 含 trace 的 lock 物件 → 以 trace 標籤解開。
 * - 物件有 echo 對話 → 扣 1 次並回傳該對話。
 * - 否則 →「沒有殘留痕跡」，不扣次數。
 */
export function echo(obj, state, data) {
  if (!hasEcho(state)) return { state, dialogue: null, message: NO_CHARGE_MESSAGE };
  if (obj.lock && !isUnlocked(obj, state) && (obj.lock.solvable_by ?? []).includes(ECHO_TAG)) {
    return tryUnlock(obj, state, data, { method: 'tag', tag: ECHO_TAG });
  }
  if (typeof obj.echo === 'string') return { state: spendEcho(state), dialogue: obj.echo };
  return { state, dialogue: null, message: NO_TRACE_MESSAGE };
}
