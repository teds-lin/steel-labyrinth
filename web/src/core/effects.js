// 效果（DATA-FORMAT「效果」「地圖與對話的擴充」）。一律回傳新 state，不原地修改。未知寫法丟錯。
// battle／goto／enter_dream／wake／open_chat 不在這裡執行：寫進 state.pending（陣列，依序累加），由畫面在對話結束後用 takePending 取出處理。
import { spendEcho, clampCollapse } from './echo.js';
import { HERO_ID, MAX_AMMO, MAX_PARTY } from './stats.js';

export { MAX_AMMO, MAX_PARTY };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = (v) => typeof v === 'string' && v !== '';
/** 物件剛好有 required 的鍵，其餘只能是 optional 的鍵。 */
function exactKeys(v, required, optional) {
  const keys = Object.keys(v);
  return required.every((k) => Object.hasOwn(v, k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}
const pushPending = (state, action) => ({ ...state, pending: [...(Array.isArray(state.pending) ? state.pending : []), action] });
const partyOf = (state) => (Array.isArray(state.party) ? state.party : []);

// null 原型＋Object.hasOwn：原型鍵（toString、constructor、__proto__…）一律視為未知寫法。
const RULES = Object.freeze(Object.assign(Object.create(null), {
  set_flag: isNonEmptyStr,
  clear_flag: isNonEmptyStr,
  give_item: isNonEmptyStr,
  take_item: isNonEmptyStr,
  resonance: isNonEmptyStr,
  chapter_end: isNonEmptyStr,
  collapse: (v) => Number.isInteger(v), // 必須是整數：存檔的 collapse 只接受 0～100 整數，小數會產生讀不回來的存檔
  use_echo: (v) => v === true,
  battle: isNonEmptyStr,
  set_lineage: (v) => isObj(v) && exactKeys(v, ['id', 'rank'], []) && isNonEmptyStr(v.id) && Number.isInteger(v.rank),
  join_party: isNonEmptyStr,
  leave_party: isNonEmptyStr,
  give_ammo: (v) => Number.isInteger(v) && v > 0,
  heal_party: (v) => v === true,
  goto: (v) => isObj(v) && exactKeys(v, ['map', 'spawn'], ['dialogue']) && isNonEmptyStr(v.map) && isNonEmptyStr(v.spawn)
    && (v.dialogue === undefined || isNonEmptyStr(v.dialogue)),
  // 鐘塔之夢（M4）：同 battle／goto，寫進 pending，由畫面在對話結束後處理
  enter_dream: (v) => isObj(v) && exactKeys(v, ['map', 'spawn'], []) && isNonEmptyStr(v.map) && isNonEmptyStr(v.spawn),
  wake: (v) => v === true || (isObj(v) && exactKeys(v, ['dialogue'], []) && isNonEmptyStr(v.dialogue)), // 補充：醒來後播的對話
  open_chat: isNonEmptyStr,
}));
/** 只讀自有屬性的計數（不吃原型鏈）；不是數字時當 0。 */
const count = (obj, k) => {
  const n = isObj(obj) && Object.hasOwn(obj, k) ? obj[k] : 0;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** 靜態檢查效果寫法，回傳錯誤字串陣列。 */
export function checkEffect(effect, path = 'effect') {
  if (!isObj(effect)) return [`${path}：效果必須是物件`];
  const keys = Object.keys(effect);
  if (keys.length !== 1) return [`${path}：效果必須剛好一個鍵，實際為 ${JSON.stringify(keys)}`];
  const [k] = keys;
  if (!Object.hasOwn(RULES, k)) return [`${path}：未知的效果寫法「${k}」`];
  return RULES[k](effect[k]) ? [] : [`${path}：「${k}」的值不合法：${JSON.stringify(effect[k])}`];
}

/** 套用單一效果，回傳新 state。 */
export function applyEffect(effect, state) {
  const errors = checkEffect(effect);
  if (errors.length) throw new Error(`效果不合法：${errors.join('；')}`);
  const [k] = Object.keys(effect);
  const v = effect[k];
  switch (k) {
    case 'set_flag':
      return { ...state, flags: { ...state.flags, [v]: true } };
    case 'clear_flag': {
      const flags = { ...state.flags };
      delete flags[v];
      return { ...state, flags };
    }
    case 'give_item':
      return { ...state, items: { ...state.items, [v]: count(state.items, v) + 1 } };
    case 'take_item': {
      const items = { ...state.items };
      if (!Object.hasOwn(items, v)) return { ...state, items };
      const n = count(items, v) - 1;
      if (n > 0) items[v] = n; else delete items[v]; // 沒有時不變（不丟錯，見回報）
      return { ...state, items };
    }
    case 'resonance':
      return { ...state, resonance: { ...state.resonance, [v]: count(state.resonance, v) + 1 } };
    case 'collapse':
      return { ...state, collapse: clampCollapse((state.collapse ?? 0) + v) };
    case 'use_echo':
      return spendEcho(state);
    case 'chapter_end': {
      const done = state.chapter_done ?? [];
      return done.includes(v) ? { ...state, chapter_done: [...done] } : { ...state, chapter_done: [...done, v] };
    }
    case 'battle':
      return pushPending(state, { type: 'battle', encounter: v });
    case 'goto':
      return pushPending(state, { type: 'goto', map: v.map, spawn: v.spawn, dialogue: v.dialogue ?? null });
    case 'enter_dream':
      return pushPending(state, { type: 'enter_dream', map: v.map, spawn: v.spawn });
    case 'wake':
      return pushPending(state, { type: 'wake', dialogue: v === true ? null : v.dialogue });
    case 'open_chat':
      return pushPending(state, { type: 'open_chat', guest: v });
    case 'set_lineage':
      return { ...state, lineage: { id: v.id, rank: v.rank } };
    case 'join_party': {
      const party = partyOf(state);
      if (party.some((m) => m?.id === v)) return { ...state, party: party.map((m) => ({ ...m })) };
      if (party.length >= MAX_PARTY) throw new Error(`隊伍最多 ${MAX_PARTY} 人，「${v}」無法加入`);
      return { ...state, party: [...party.map((m) => ({ ...m })), { id: v, hp: null, sp: null }] };
    }
    case 'leave_party':
      if (v === HERO_ID) throw new Error('主角不可以離開隊伍');
      return { ...state, party: partyOf(state).filter((m) => m?.id !== v).map((m) => ({ ...m })) };
    case 'give_ammo': {
      const cur = Number.isInteger(state.ammo) ? state.ammo : 0;
      return { ...state, ammo: Math.min(MAX_AMMO, cur + v) };
    }
    case 'heal_party':
      return { ...state, party: partyOf(state).map((m) => ({ ...m, hp: null, sp: null })) };
    default:
      throw new Error(`未知的效果寫法「${k}」`);
  }
}

/** 取出對話結束後要處理的事（battle／goto／enter_dream／wake／open_chat），回傳 { state（pending 清成 null）, pending:[…] }。 */
export function takePending(state) {
  const pending = Array.isArray(state?.pending) ? state.pending.map((p) => ({ ...p })) : [];
  return { state: { ...state, pending: null }, pending };
}

/** 依序套用效果陣列；undefined 視為沒有效果。 */
export function applyEffects(effects, state) {
  if (effects === undefined) return state;
  if (!Array.isArray(effects)) throw new Error('effects 必須是陣列');
  return effects.reduce((s, e) => applyEffect(e, s), state);
}
