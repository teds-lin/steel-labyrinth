// 效果（DATA-FORMAT「效果」一節）。一律回傳新 state，不原地修改。未知寫法丟錯。
import { spendEcho, clampCollapse } from './echo.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = (v) => typeof v === 'string' && v !== '';

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
    default:
      throw new Error(`未知的效果寫法「${k}」`);
  }
}

/** 依序套用效果陣列；undefined 視為沒有效果。 */
export function applyEffects(effects, state) {
  if (effects === undefined) return state;
  if (!Array.isArray(effects)) throw new Error('effects 必須是陣列');
  return effects.reduce((s, e) => applyEffect(e, s), state);
}
