// 與物件互動：面前目標、【調查】、【殘響】、解鎖（DATA-FORMAT「lock」與「探索標籤」）。
import { DIRS, objectsAt, isUnlocked } from './grid.js';
import { ECHO_TAG, hasEcho, spendEcho, echoCharges } from './echo.js';
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
  if (typeof loc?.dir !== 'string' || !Object.hasOwn(DIRS, loc.dir)) return null;
  const d = DIRS[loc.dir];
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

const ownStr = (obj, k) => (obj !== null && typeof obj === 'object' && Object.hasOwn(obj, k) && typeof obj[k] === 'string' ? obj[k] : null);

/**
 * 嘗試解鎖：tryUnlock(obj, state, data, { method?, tag?, allowCost? })。
 * - method 可指定 'tag'（可再指定 tag）或 'item'；不指定時自動選。
 * - allowCost 預設 false：只考慮免費解法（譜系標籤、道具），沒有就回 locked 對話、不扣殘響。
 *   true 時才允許用暫時殘響的 trace（扣 1 次、崩解 +5）。道具不會被消耗。
 * 回傳 { state, dialogue, unlocked, via: 'tag'|'item'|'already'|null, tag?, item? }。
 */
export function tryUnlock(obj, state, data, opts = {}) {
  const lock = obj?.lock;
  if (!lock) throw new Error(`物件「${obj?.id}」沒有 lock`);
  if (isUnlocked(obj, state)) {
    return { state, dialogue: typeof obj.look === 'string' ? obj.look : null, unlocked: true, via: 'already' };
  }
  let candidates = unlockOptions(obj, state, data);
  if (opts.allowCost !== true) candidates = candidates.filter((o) => o.cost === null);
  if (opts.method) candidates = candidates.filter((o) => o.method === opts.method && (opts.tag === undefined || o.tag === opts.tag));
  const pick = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
  if (!pick) return { state, dialogue: lock.locked ?? null, unlocked: false, via: null };

  let next = pick.cost === 'echo' ? spendEcho(state) : state;
  next = { ...next, flags: { ...next.flags, [lock.flag]: true } };
  if (pick.method === 'tag') {
    return { state: next, dialogue: ownStr(lock.on_tag, pick.tag), unlocked: true, via: 'tag', tag: pick.tag };
  }
  return { state: next, dialogue: lock.on_item ?? null, unlocked: true, via: 'item', item: pick.item };
}

/** 譜系本身是否已提供 trace（此時【殘響】免費）。 */
const traceIsFree = (state, data) => lineageFieldTags(state, data).includes(ECHO_TAG);

/** HUD 用：{ free:譜系已提供 trace, charges:剩餘暫時殘響次數, usable:現在按【殘響】有沒有用 }。 */
export function echoAvailable(state, data) {
  const free = traceIsFree(state, data);
  const charges = echoCharges(state);
  return { free, charges, usable: free || charges > 0 };
}

/**
 * 【殘響】：echo(obj, state, data)
 * - 譜系已提供 trace → 免費（不扣次數、不加崩解）。
 * - 否則次數為 0 → NO_CHARGE_MESSAGE，不改 state。
 * - 對尚未解開、且 solvable_by 含 trace 的 lock 物件 → 以 trace 標籤解開（暫時殘響時扣 1 次）。
 * - 物件有 echo 對話 → 回傳該對話（暫時殘響時扣 1 次）。
 * - 否則 →「沒有殘留痕跡」，不扣次數。
 */
export function echo(obj, state, data) {
  const free = traceIsFree(state, data);
  if (!free && !hasEcho(state)) return { state, dialogue: null, message: NO_CHARGE_MESSAGE };
  if (obj.lock && !isUnlocked(obj, state) && (obj.lock.solvable_by ?? []).includes(ECHO_TAG)) {
    return tryUnlock(obj, state, data, { method: 'tag', tag: ECHO_TAG, allowCost: true });
  }
  if (typeof obj.echo === 'string') return { state: free ? state : spendEcho(state), dialogue: obj.echo };
  return { state, dialogue: null, message: NO_TRACE_MESSAGE };
}

/**
 * 【調查】：investigate(obj, state, data) → { state, dialogues, unlocked }
 * 調查絕不消耗殘響。dialogues 是依序要播的對話 id（畫面層依序播放，每段用前一段結束後的 state）。
 * - 一般物件：[look]（沒有 look 則空陣列），unlocked 為 null。
 * - 已解開的 lock 物件：[look]，unlocked true。
 * - 鎖著：先 look，再嘗試免費解法（譜系標籤、道具）；成功接 on_tag／on_item，失敗接 locked。
 *   locked 只在沒有 look 時代替它（也就是 [locked]）——有 look 時是 [look, locked]。
 * 注意：回傳的 state 已含解鎖旗標；look 對話若以 lock.flag 分歧，解鎖成功那一輪會看到「已開」分支，
 *   內容請改用 on_tag／on_item 對話自己設的旗標分歧（序章用 door_seen_open）。
 */
export function investigate(obj, state, data) {
  const lookId = typeof obj?.look === 'string' ? obj.look : null;
  if (!obj?.lock) return { state, dialogues: lookId ? [lookId] : [], unlocked: null };
  if (isUnlocked(obj, state)) return { state, dialogues: lookId ? [lookId] : [], unlocked: true };
  const r = tryUnlock(obj, state, data, { allowCost: false });
  const dialogues = [lookId, r.dialogue].filter((d) => typeof d === 'string');
  return { state: r.state, dialogues, unlocked: r.unlocked };
}
