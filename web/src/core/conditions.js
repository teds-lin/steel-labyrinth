// 條件判斷（DATA-FORMAT「條件」一節）。
// 未知寫法一律丟錯，不可當成成立；先整棵檢查再求值，避免 any/all 短路藏住壞寫法。
// M5：evalCondition(cond, state, data)。can_promote 需要遊戲資料（譜系的 potion），沒有 data 時丟錯；其他條件不需要 data。
import { canPromoteTo, resonanceTotal } from './promotion.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = (v) => typeof v === 'string' && v !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

// 用 null 原型＋Object.hasOwn 查表：避免 toString／constructor／__proto__ 這類原型鍵被當成合法寫法。
const LEAF = Object.freeze(Object.assign(Object.create(null), {
  flag: isNonEmptyStr,
  not_flag: isNonEmptyStr,
  item: isNonEmptyStr,
  lineage: isNonEmptyStr,
  echo_gte: isNum,
  rank_lte: isNum,
  in_party: isNonEmptyStr,
  ammo_gte: isNum,
  // M5 晉升與結局
  can_promote: Number.isInteger,
  resonance_gte: isNonNegInt,
  collapse_lte: isNonNegInt,
  collapse_gte: isNonNegInt,
  promoted_forced: Number.isInteger, // 補充（依故事聖經）2：晉升到 N 的那一次是硬喝
}));
/** 求值時需要遊戲資料（data）的條件；validate 用它限制這些條件只能放在求值時有 data 的地方。 */
export const DATA_CONDITIONS = Object.freeze(['can_promote']);
/** 只讀自有屬性（不吃原型鏈）。 */
const own = (obj, k) => (isObj(obj) && Object.hasOwn(obj, k) ? obj[k] : undefined);

/** 靜態檢查條件寫法，回傳錯誤字串陣列（空陣列＝合法）。 */
export function checkCondition(cond, path = 'if') {
  if (!isObj(cond)) return [`${path}：條件必須是物件`];
  const keys = Object.keys(cond);
  if (keys.length !== 1) return [`${path}：條件必須剛好一個鍵，實際為 ${JSON.stringify(keys)}`];
  const [k] = keys;
  const v = cond[k];
  if (Object.hasOwn(LEAF, k)) {
    return LEAF[k](v) ? [] : [`${path}：「${k}」的值不合法：${JSON.stringify(v)}`];
  }
  if (k === 'all' || k === 'any') {
    if (!Array.isArray(v)) return [`${path}：「${k}」必須是陣列`];
    return v.flatMap((c, i) => checkCondition(c, `${path}.${k}[${i}]`));
  }
  if (k === 'not') {
    if (!isObj(v)) return [`${path}：「not」必須是條件物件`];
    return checkCondition(v, `${path}.not`);
  }
  return [`${path}：未知的條件寫法「${k}」`];
}

const collapseOf = (state) => (isNum(state?.collapse) ? state.collapse : 0);

function evalChecked(cond, state, data) {
  const [k] = Object.keys(cond);
  const v = cond[k];
  switch (k) {
    case 'flag': return own(state?.flags, v) === true;
    case 'not_flag': return own(state?.flags, v) !== true;
    case 'item': { const n = own(state?.items, v); return typeof n === 'number' && n > 0; }
    case 'echo_gte': return (state?.echo?.charges ?? 0) >= v;
    case 'lineage': return state?.lineage?.id === v;
    case 'rank_lte': return state?.lineage != null && isNum(state.lineage.rank) && state.lineage.rank <= v;
    case 'in_party': return Array.isArray(state?.party) && state.party.some((m) => m?.id === v);
    case 'ammo_gte': return (isNum(state?.ammo) ? state.ammo : 0) >= v;
    case 'can_promote': return canPromoteTo(v, state, data);
    case 'resonance_gte': return resonanceTotal(state) >= v;
    case 'collapse_lte': return collapseOf(state) <= v;
    case 'collapse_gte': return collapseOf(state) >= v;
    case 'promoted_forced': {
      const list = Array.isArray(state?.promotions) ? state.promotions : [];
      const last = list.findLast((p) => isObj(p) && p.rank === v); // 同一階有多筆（理論上不會）以最後一筆為準
      return last?.forced === true;
    }
    case 'all': return v.every((c) => evalChecked(c, state, data));
    case 'any': return v.some((c) => evalChecked(c, state, data));
    case 'not': return !evalChecked(v, state, data);
    default: throw new Error(`未知的條件寫法「${k}」`); // checkCondition 已擋，保險
  }
}

/** 條件裡有沒有用到需要 data 的寫法（can_promote）。 */
export function conditionNeedsData(cond) {
  if (!isObj(cond)) return false;
  return Object.entries(cond).some(([k, v]) => DATA_CONDITIONS.includes(k)
    || ((k === 'all' || k === 'any') && Array.isArray(v) && v.some(conditionNeedsData))
    || (k === 'not' && conditionNeedsData(v)));
}

/** 求值；寫法不合法時丟錯。data（選填）：can_promote 需要，沒有時丟錯（先整棵檢查，不會因 any/all 短路而漏掉）。 */
export function evalCondition(cond, state, data) {
  const errors = checkCondition(cond);
  if (errors.length) throw new Error(`條件不合法：${errors.join('；')}`);
  if (data == null && conditionNeedsData(cond)) throw new Error('條件 can_promote 需要遊戲資料（data）：請用 evalCondition(cond, state, data)');
  return evalChecked(cond, state, data);
}
