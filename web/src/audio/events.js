// 遊戲事件 → 事件鍵（純函式，node 可測）。事件鍵 → cue 的對應放在資料：web/audio/catalog.json 的 events，
// 程式只查表（AudioDirector.event）。要換音效、或讓某個事件安靜（對應 null），改資料就好。
//
// 掛點（全部只有這幾處，場景裡不散落 audio.sfx）：
//   - 戰鬥：BattleScene.playLog 每個事件播放前 → battleEventKey
//   - 探索：session.setState 的 'state' 事件（audio/index.js 統一監聽）→ exploreEventKeys（prev → next 的差異＋觸發原因）
//   - 存檔成功：MenuScene.doSave → 'save.ok'

/** 程式會用到的所有事件鍵；catalog 的 events 必須剛好涵蓋這些（tests/audio/assets.test.js）。 */
export const EVENT_KEYS = Object.freeze([
  'map.investigate', 'map.echo', 'map.change', 'map.unlock', 'item.get', 'save.ok',
  'battle.shot', 'battle.crit', 'battle.hit', 'battle.hurt', 'battle.miss',
  'battle.heal', 'battle.buff', 'battle.debuff', 'battle.status', 'battle.down',
  'battle.victory', 'battle.defeat', 'battle.lost_control',
]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 一律響固定事件鍵的戰鬥事件。 */
const SIMPLE = {
  crit: 'battle.crit', miss: 'battle.miss', heal: 'battle.heal', buff: 'battle.buff', debuff: 'battle.debuff', status: 'battle.status',
  victory: 'battle.victory', defeat: 'battle.defeat', lost_control: 'battle.lost_control',
};

/**
 * 戰鬥事件（core/battle 的 log）→ 事件鍵或 null。ctx：{ sideOf(uid) → 'party'|'enemy'|null, skillOf(id) → 技能資料|null }。
 * - action：消耗子彈的技能＝開槍；其他行動本身不響（之後的傷害、治療等事件會響）。
 * - damage：打到敵人 hit、我方受傷 hurt；爆擊的傷害不響（前一個 crit 事件已響）。
 * - defeated：敵人倒下響；我方倒下不另外響。
 */
export function battleEventKey(ev, ctx) {
  if (!isObj(ev) || typeof ev.type !== 'string') return null;
  if (Object.hasOwn(SIMPLE, ev.type)) return SIMPLE[ev.type];
  const side = (uid) => (typeof ctx?.sideOf === 'function' ? ctx.sideOf(uid) : null);
  switch (ev.type) {
    case 'action': {
      const sk = typeof ev.skill === 'string' && typeof ctx?.skillOf === 'function' ? ctx.skillOf(ev.skill) : null;
      return (sk?.cost?.ammo ?? 0) > 0 ? 'battle.shot' : null;
    }
    case 'damage': {
      if (ev.crit) return null;
      const s = side(ev.target);
      return s === 'enemy' ? 'battle.hit' : s === 'party' ? 'battle.hurt' : null;
    }
    case 'defeated':
      return side(ev.uid) === 'enemy' ? 'battle.down' : null;
    default:
      return null;
  }
}

const mapOf = (data, id) => (Array.isArray(data?.maps) ? data.maps.find((m) => isObj(m) && m.id === id) : null) ?? null;

/**
 * 探索：一次狀態變化（prev → next）＋觸發原因（meta：{ cause:'investigate'|'echo', hit }）→ 依序的事件鍵（不重複）。
 * - 調查／殘響：有對象（hit）才響。同一下開了鎖時，調查／殘響音讓位給開鎖音。
 * - 換地圖：map.change；入夢與醒來（dream_return 變化，已有鐘聲）、換章（章節結束畫面的「繼續」）不響。
 * - 開鎖：目前地圖上某個物件的 lock.flag 由非 true 變成 true。
 * - 取得道具：任何道具數量增加（對話的 give_item、交換、戰利品）。
 * prev 為 null（新遊戲、讀檔）或 next 為 null（回標題）、meta.cause 為 'restore'（Game Over 的重新挑戰）時不響。
 */
export function exploreEventKeys(prev, next, meta, data) {
  if (!isObj(prev) || !isObj(next)) return [];
  const cause = isObj(meta) ? meta.cause : null;
  if (cause === 'restore') return []; // 回到較早的狀態（重新挑戰）：差異不是玩家這一刻做的事
  const out = [];
  const hit = isObj(meta) && meta.hit === true;
  const pm = prev.location?.map;
  const nm = next.location?.map;
  const dreamFlip = (prev.dream_return ?? null) === null ? (next.dream_return ?? null) !== null : (next.dream_return ?? null) === null;
  if (pm && nm && pm !== nm && !dreamFlip && prev.chapter === next.chapter) out.push('map.change');
  const objs = mapOf(data, nm)?.objects;
  if (Array.isArray(objs)) {
    const opened = objs.some((o) => isObj(o?.lock) && typeof o.lock.flag === 'string'
      && prev.flags?.[o.lock.flag] !== true && next.flags?.[o.lock.flag] === true);
    if (opened) out.push('map.unlock');
  }
  // 調查／殘響音：同一下開了鎖時讓位給開鎖音（不疊兩聲）
  if ((cause === 'investigate' || cause === 'echo') && hit && !out.includes('map.unlock')) out.unshift(cause === 'echo' ? 'map.echo' : 'map.investigate');
  const pi = isObj(prev.items) ? prev.items : {};
  const ni = isObj(next.items) ? next.items : {};
  if (Object.keys(ni).some((k) => (Number(ni[k]) || 0) > (Number(pi[k]) || 0))) out.push('item.get');
  return out;
}
