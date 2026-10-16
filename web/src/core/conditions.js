// 條件判斷（DATA-FORMAT「條件」一節）。
// 未知寫法一律丟錯，不可當成成立；先整棵檢查再求值，避免 any/all 短路藏住壞寫法。

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = (v) => typeof v === 'string' && v !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

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
}));
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

function evalChecked(cond, state) {
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
    case 'all': return v.every((c) => evalChecked(c, state));
    case 'any': return v.some((c) => evalChecked(c, state));
    case 'not': return !evalChecked(v, state);
    default: throw new Error(`未知的條件寫法「${k}」`); // checkCondition 已擋，保險
  }
}

/** 求值；寫法不合法時丟錯。 */
export function evalCondition(cond, state) {
  const errors = checkCondition(cond);
  if (errors.length) throw new Error(`條件不合法：${errors.join('；')}`);
  return evalChecked(cond, state);
}
