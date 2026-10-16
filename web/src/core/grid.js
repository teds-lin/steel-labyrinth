// 格子移動（DATA-FORMAT「maps」一節）。純函式，回傳新 state 與事件。
import { evalCondition } from './conditions.js';

export const DIRS = Object.freeze({
  up: Object.freeze({ dx: 0, dy: -1 }),
  down: Object.freeze({ dx: 0, dy: 1 }),
  left: Object.freeze({ dx: -1, dy: 0 }),
  right: Object.freeze({ dx: 1, dy: 0 }),
});

const findById = (list, id) => (Array.isArray(list) ? list.find((x) => x?.id === id) : undefined);

/** 一次性觸發點使用的旗標名稱（存在 state.flags）。 */
export const onceFlag = (mapId, triggerId) => `trigger:${mapId}:${triggerId}`;
/** 第一次進入地圖時記的旗標。 */
export const enterFlag = (mapId) => `enter:${mapId}`;

export function mapSize(map) {
  const rows = Array.isArray(map?.tiles) ? map.tiles : [];
  return { width: rows.length ? Array.from(rows[0]).length : 0, height: rows.length };
}

/** (x, y) 的地形 id；地圖外或 legend 沒定義回 null。 */
export function tileIdAt(map, x, y) {
  const rows = map?.tiles;
  if (!Array.isArray(rows) || !Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= rows.length) return null;
  const row = Array.from(rows[y]);
  if (x < 0 || x >= row.length) return null;
  const id = map.legend?.[row[x]];
  return typeof id === 'string' ? id : null;
}

/** 地形是否可通行；未知地形一律當作不可通行。 */
function tileWalkable(map, x, y, data) {
  const id = tileIdAt(map, x, y);
  if (id === null) return false;
  const tile = findById(data?.tiles, id);
  return !!tile && tile.solid !== true;
}

export const objectVisible = (obj, state) => obj.if === undefined || evalCondition(obj.if, state);

export const isUnlocked = (obj, state) => !!obj.lock && state?.flags?.[obj.lock.flag] === true;

/** 物件是否擋路：存在、solid、且不是已解開的 lock 物件。 */
export const blocksMovement = (obj, state) => objectVisible(obj, state) && obj.solid === true && !isUnlocked(obj, state);

/** (x, y) 上目前存在（if 成立）的物件。 */
export function objectsAt(map, state, x, y) {
  return (map.objects ?? []).filter((o) => o.x === x && o.y === y && objectVisible(o, state));
}

export function canMove(map, state, x, y, data) {
  if (!tileWalkable(map, x, y, data)) return false;
  return !(map.objects ?? []).some((o) => o.x === x && o.y === y && blocksMovement(o, state));
}

/**
 * 往 dir 走一格。回傳 { state, moved, event }。
 * event：null｜{type:'bump',x,y[,object]}｜{type:'blocked',x,y,dialogue}｜{type:'exit',to,spawn}｜{type:'trigger',id,dialogue[,battle]}
 * 觸發點有 battle 時事件帶 battle（遭遇 id）：畫面先播 dialogue（可能為 null），再開始戰鬥。
 * 走進出口後，畫面層應呼叫 enterMap(state, data, event.to, event.spawn)。
 */
export function step(map, state, dir, data) {
  if (typeof dir !== 'string' || !Object.hasOwn(DIRS, dir)) throw new Error(`未知的方向「${dir}」`);
  const d = DIRS[dir];
  const { x, y } = state.location;
  const nx = x + d.dx;
  const ny = y + d.dy;
  const turned = { ...state, location: { ...state.location, dir } };

  if (!canMove(map, state, nx, ny, data)) {
    const blocker = (map.objects ?? []).find((o) => o.x === nx && o.y === ny && blocksMovement(o, state));
    const event = { type: 'bump', x: nx, y: ny };
    if (blocker) event.object = blocker.id;
    return { state: turned, moved: false, event };
  }

  const exit = (map.exits ?? []).find((e) => e.x === nx && e.y === ny);
  if (exit && exit.requires !== undefined && !evalCondition(exit.requires, state)) {
    return { state: turned, moved: false, event: { type: 'blocked', x: nx, y: ny, dialogue: exit.blocked ?? null } };
  }

  let moved = { ...turned, location: { ...turned.location, x: nx, y: ny } };
  if (exit) return { state: moved, moved: true, event: { type: 'exit', to: exit.to, spawn: exit.spawn } };

  const trg = (map.triggers ?? []).find((t) => t.x === nx && t.y === ny);
  if (trg) {
    const flag = onceFlag(map.id, trg.id);
    const spent = trg.once === true && moved.flags?.[flag] === true;
    if (!spent && (trg.if === undefined || evalCondition(trg.if, moved))) {
      if (trg.once === true) moved = { ...moved, flags: { ...moved.flags, [flag]: true } };
      const event = { type: 'trigger', id: trg.id, dialogue: trg.dialogue ?? null };
      if (typeof trg.battle === 'string') event.battle = trg.battle;
      return { state: moved, moved: true, event };
    }
  }
  return { state: moved, moved: true, event: null };
}

/**
 * 進入地圖並放到 spawn。第一次進入時記 enter:<id>，若有 on_enter 則回傳要播的對話 id。
 * 回傳 { state, dialogue }。
 */
export function enterMap(state, data, mapId, spawnId) {
  const map = findById(data?.maps, mapId);
  if (!map) throw new Error(`找不到地圖「${mapId}」`);
  const sp = findById(map.spawns, spawnId);
  if (!sp) throw new Error(`地圖「${mapId}」找不到 spawn「${spawnId}」`);
  const flag = enterFlag(map.id);
  const first = state.flags?.[flag] !== true;
  const next = {
    ...state,
    location: { map: map.id, x: sp.x, y: sp.y, dir: sp.dir ?? 'down' },
    flags: first ? { ...state.flags, [flag]: true } : state.flags,
  };
  return { state: next, dialogue: first && typeof map.on_enter === 'string' ? map.on_enter : null };
}
