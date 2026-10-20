// 晉升（DATA-FORMAT「第一部完結（M5 起）」的「晉升」）。純函式，不修改輸入。
// - 共鳴：主角在目前階位期間累積的 state.resonance 各事件數加總；晉升後歸零重新累積。
// - promote 效果：只能升到目前階位的下一階（數字減 1）；材料不足 → 不執行，pending 加入 promote_failed。
//   共鳴足夠 → 晉升；共鳴不足 → 晉升並增加 potion.forced_collapse（硬喝）。
// - 晉升紀錄 state.promotions：[{ lineage, rank, forced, chapter }]（存檔 v4，結局判定用）。
// - 晉升成功時 pending 加入 { type:'promoted', lineage, rank, forced }（畫面播演出用；存檔時 pending 一律為 null）。
import { clampCollapse } from './echo.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const findById = (list, id) => (Array.isArray(list) ? list.find((x) => isObj(x) && x.id === id) : undefined);
const countOf = (state, id) => (isObj(state?.items) && Object.hasOwn(state.items, id) && Number.isInteger(state.items[id]) && state.items[id] > 0 ? state.items[id] : 0);
const pushPending = (state, action) => ({ ...state, pending: [...(Array.isArray(state.pending) ? state.pending : []), action] });

/** 目前階位期間的共鳴合計（非負整數以外的值當 0）。 */
export function resonanceTotal(state) {
  const r = isObj(state?.resonance) ? state.resonance : {};
  return Object.values(r).reduce((sum, n) => sum + (Number.isInteger(n) && n > 0 ? n : 0), 0);
}

const lineageDef = (id, data) => findById(data?.lineages, id);
const rankDef = (lin, rank) => (Array.isArray(lin?.ranks) ? lin.ranks.find((r) => isObj(r) && r.rank === rank) : undefined);
const potionOf = (r) => (isObj(r?.potion) ? r.potion : null);
const materialsOf = (potion) => (Array.isArray(potion?.materials) ? potion.materials.filter((m) => isObj(m) && typeof m.item === 'string') : []);
const needOf = (potion) => (Number.isInteger(potion?.resonance) ? potion.resonance : 0);
const forcedOf = (potion) => (Number.isInteger(potion?.forced_collapse) ? potion.forced_collapse : 0);

function requireData(data, what) {
  if (!isObj(data)) throw new Error(`${what} 需要遊戲資料（data）：請用 startDialogue(dlg, state, data)／applyEffects(effects, state, data)`);
}

/** 材料檢查：[{ item, have, need }]。 */
const materialRows = (potion, state) => materialsOf(potion).map((m) => ({ item: m.item, have: countOf(state, m.item), need: m.count }));

/**
 * 條件 { can_promote: n }：目前階位是 n＋1、同譜系有階位 n、材料齊全（共鳴不足也算，可以硬喝）。
 * conditions.js 呼叫；沒有 data 時丟錯（不可當成成立或不成立）。
 */
export function canPromoteTo(rank, state, data) {
  requireData(data, '條件 can_promote');
  const lin = state?.lineage;
  if (!isObj(lin) || lin.rank !== rank + 1) return false;
  const target = rankDef(lineageDef(lin.id, data), rank);
  if (!target) return false;
  return materialRows(potionOf(target), state).every((m) => m.have >= m.need);
}

/**
 * 效果 { promote: { lineage, rank } }。回傳新 state。
 * 資料錯誤（譜系或目標階位不存在）丟錯；玩家狀態不符（沒有／不同譜系、不是下一階、材料不足）不丟錯，
 * 改在 pending 加入 { type:'promote_failed', promote_failed:'lineage'|'rank'|'materials', lineage, rank, missing:[{ item, have, need }] }。
 */
export function applyPromote(v, state, data) {
  requireData(data, '效果 promote');
  const lin = lineageDef(v.lineage, data);
  if (!lin) throw new Error(`promote：找不到譜系「${v.lineage}」`);
  const target = rankDef(lin, v.rank);
  if (!target) throw new Error(`promote：譜系「${v.lineage}」沒有開放階位 ${v.rank}`);
  const fail = (reason, missing = []) => pushPending(state, { type: 'promote_failed', promote_failed: reason, lineage: v.lineage, rank: v.rank, missing });
  const cur = state?.lineage;
  if (!isObj(cur) || cur.id !== v.lineage) return fail('lineage');
  if (cur.rank !== v.rank + 1) return fail('rank');
  const potion = potionOf(target);
  const rows = materialRows(potion, state);
  const missing = rows.filter((m) => m.have < m.need);
  if (missing.length) return fail('materials', missing);

  const items = { ...state.items };
  for (const m of rows) {
    const left = m.have - m.need;
    if (left > 0) items[m.item] = left; else delete items[m.item];
  }
  const forced = resonanceTotal(state) < needOf(potion);
  const collapse = forced ? clampCollapse((Number.isInteger(state.collapse) ? state.collapse : 0) + forcedOf(potion)) : state.collapse;
  const promotions = [...(Array.isArray(state.promotions) ? state.promotions : []).map((p) => ({ ...p })),
    { lineage: v.lineage, rank: v.rank, forced, chapter: typeof state.chapter === 'string' ? state.chapter : null }];
  // M5 整合：畫面用 pending 的 promoted 播晉升演出（不再比對 promotions 長度）
  return pushPending({ ...state, items, collapse, resonance: {}, lineage: { id: cur.id, rank: v.rank }, promotions },
    { type: 'promoted', lineage: v.lineage, rank: v.rank, forced });
}

/**
 * 晉升畫面用：目前譜系的下一階與條件。
 * 回傳 { next:{ lineage, rank, name }|null, materials:[{ item, name, have, need }], resonance:{ have, need },
 *        canPromote（材料齊全）, forced（現在喝會是硬喝：材料齊全但共鳴不足）, forcedCollapse（硬喝增加的崩解） }。
 */
export function promotionStatus(state, data) {
  const have = resonanceTotal(state);
  const none = { next: null, materials: [], resonance: { have, need: 0 }, canPromote: false, forced: false, forcedCollapse: 0 };
  const cur = state?.lineage;
  if (!isObj(cur) || !Number.isInteger(cur.rank)) return none;
  const lin = lineageDef(cur.id, data);
  const target = rankDef(lin, cur.rank - 1);
  if (!target) return none;
  const potion = potionOf(target);
  const materials = materialRows(potion, state).map((m) => ({ item: m.item, name: findById(data?.items, m.item)?.name ?? m.item, have: m.have, need: m.need }));
  const canPromote = materials.every((m) => m.have >= m.need);
  const need = needOf(potion);
  return {
    next: { lineage: lin.id, rank: target.rank, name: typeof target.name === 'string' ? target.name : '' },
    materials,
    resonance: { have, need },
    canPromote,
    forced: canPromote && have < need,
    forcedCollapse: forcedOf(potion),
  };
}
