// 鐘塔之夢（DATA-FORMAT「鐘塔之夢（M4 起）」）：入夢、醒來、夢客的預寫台詞。純函式，不修改輸入。
import { DIRS, enterMap, mapSize, canMove } from './grid.js';
import { END } from './dialogue.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const findById = (list, id) => (Array.isArray(list) ? list.find((x) => isObj(x) && x.id === id) : undefined);

/** 預寫台詞的種類（story 檔 guests[].scripted 的鍵）。 */
export const SCRIPTED_KINDS = Object.freeze(['greeting', 'fallback', 'quota', 'filtered', 'not_open']);
/** 執行時產生的對話 id（以 __ 開頭，不會和資料撞名）。 */
export const DREAM_CHOICE_ID = '__dream_choice';
export const NOT_OPEN_ID = '__guest_not_open';
export const NOT_OPEN_NOTE = '（在「選單 → 雲端存檔」啟用雲端存檔後，就可以和夢客自由交談。）';

export const isDreamMap = (map) => isObj(map) && map.dream === true;

/** 「入夢」選項的預設文字（物件的 dream 沒寫 prompt／yes／no 時使用；DATA-FORMAT 鐘塔之夢補充 5）。 */
export const DREAM_PROMPT_DEFAULT = Object.freeze({ prompt: '一陣倦意湧上來。遠處好像有鐘聲。', yes: '入夢', no: '留在現實' });
const DREAM_TEXT_KEYS = Object.keys(DREAM_PROMPT_DEFAULT);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 物件 dream 的入夢目標（DATA-FORMAT 補充 1：必須寫明 map、spawn）。地圖不是夢境地圖或 spawn 不存在回 null。
 * 選填的 prompt／yes／no（補充 5）是非空字串時一併帶出，給 dreamChoiceDialogue 用。
 */
export function dreamTarget(obj, data) {
  const d = isObj(obj?.dream) ? obj.dream : {};
  if (typeof d.map !== 'string' || typeof d.spawn !== 'string') return null;
  const map = findById(data?.maps, d.map);
  if (!isDreamMap(map) || !findById(map.spawns, d.spawn)) return null;
  const out = { map: map.id, spawn: d.spawn };
  for (const k of DREAM_TEXT_KEYS) if (isText(d[k])) out[k] = d[k];
  return out;
}

const cleanLocation = (loc) => ({ map: loc.map, x: loc.x, y: loc.y, dir: typeof loc.dir === 'string' && Object.hasOwn(DIRS, loc.dir) ? loc.dir : 'down' });

/**
 * 入夢：記住目前的現實位置到 dream_return，移到夢境地圖（enterMap：第一次進入時回傳 on_enter）。
 * 已經在夢中（dream_return 有值）再入夢時保留最初的現實位置。回傳 { state, dialogue }。
 */
export function enterDream(state, data, mapId, spawnId) {
  const target = findById(data?.maps, mapId);
  if (!target) throw new Error(`找不到地圖「${mapId}」`);
  if (!isDreamMap(target)) throw new Error(`地圖「${mapId}」不是夢境地圖，不能入夢`);
  const ret = isObj(state.dream_return) ? state.dream_return : cleanLocation(state.location);
  const r = enterMap(state, data, mapId, spawnId);
  return { state: { ...r.state, dream_return: { ...ret } }, dialogue: r.dialogue };
}

/** dream_return 是否指向存在、而且站得上去的格子。 */
function validReturn(ret, state, data) {
  if (!isObj(ret) || typeof ret.map !== 'string') return null;
  const map = findById(data?.maps, ret.map);
  if (!map || isDreamMap(map)) return null;
  const { width, height } = mapSize(map);
  if (!Number.isInteger(ret.x) || !Number.isInteger(ret.y) || ret.x < 0 || ret.y < 0 || ret.x >= width || ret.y >= height) return null;
  if (!canMove(map, state, ret.x, ret.y, data)) return null;
  return cleanLocation(ret);
}

/** 地圖的 spawn → { map, x, y, dir }；spawnId 找不到時用第一個 spawn（與讀檔校正相同）；沒有 spawn → null。 */
function spawnPlace(map, spawnId) {
  const list = Array.isArray(map?.spawns) ? map.spawns.filter(isObj) : [];
  const sp = list.find((x) => x.id === spawnId) ?? list[0];
  if (!sp) return null;
  return { map: map.id, x: sp.x, y: sp.y, dir: Object.hasOwn(DIRS, sp.dir ?? '') ? sp.dir : 'down' };
}

/** 目的地 { map, spawn } → 位置；地圖不存在或是夢境地圖 → null。 */
function placeOf(target, data) {
  if (!isObj(target) || typeof target.map !== 'string') return null;
  const map = findById(data?.maps, target.map);
  return map && !isDreamMap(map) ? spawnPlace(map, target.spawn) : null;
}

/**
 * 該章的起點（DATA-FORMAT 補充（2026-10-18）2）：前一章的 end_screen.continue；
 * 序章（manifest.chapters[0]）、不認得的章節、前一章沒有可用的 continue → manifest.start。都找不到回 null。
 */
export function chapterStartPlace(chapter, data) {
  const chapters = Array.isArray(data?.manifest?.chapters) ? data.manifest.chapters : [];
  const i = chapters.indexOf(chapter);
  const prev = i > 0 ? findById(data?.story, chapters[i - 1]) : undefined;
  return placeOf(prev?.end_screen?.continue, data) ?? placeOf(data?.manifest?.start, data);
}

/**
 * 醒來：回到 dream_return（不重播 on_enter、不改旗標），並清除它。
 * dream_return 不合法時回到該章起點（chapterStartPlace；不是序章的閣樓），relocated 為 true（畫面提示玩家）。
 * 回傳 { state, relocated }。
 */
export function wakeUp(state, data) {
  const loc = validReturn(state.dream_return, state, data);
  if (loc) return { state: { ...state, location: loc, dream_return: null }, relocated: false };
  const start = chapterStartPlace(state.chapter, data);
  if (!start) throw new Error('醒來的位置不合法，而且找不到這一章的起點');
  return { state: { ...state, location: start, dream_return: null }, relocated: true };
}

/** 依 id 找夢客（所有章節的 guests）；沒有回 null。 */
/**
 * 夢客的定義（DATA-FORMAT 補充（依故事聖經）3）：以 state.chapter 的 story 為準；該章沒有定義這位夢客時往前一章找，
 * 直到找到為止（manifest.chapters 的順序；不往後找，避免讀到還沒開放章節的台詞與交換表）。
 * state.chapter 不在 manifest.chapters 時，從最後一章往前找。找不到回 null。
 */
export function guestFor(id, state, data) {
  const order = Array.isArray(data?.manifest?.chapters) ? data.manifest.chapters : (data?.story ?? []).map((s) => s?.id);
  let i = order.indexOf(state?.chapter);
  if (i < 0) i = order.length - 1;
  for (; i >= 0; i--) {
    const story = findById(data?.story, order[i]);
    const g = findById(story?.guests, id);
    if (g) return g;
  }
  return null;
}

/** 夢客的定義。帶 state 時照 guestFor 的章節規則；不帶 state 時（舊呼叫方式）回傳第一個找到的。 */
export function guestById(data, id, state) {
  if (state !== undefined && state !== null) return guestFor(id, state, data);
  for (const ch of data?.story ?? []) {
    const g = findById(ch?.guests, id);
    if (g) return g;
  }
  return null;
}

const lines = (guest, kind) => {
  const list = isObj(guest?.scripted) && Object.hasOwn(guest.scripted, kind) ? guest.scripted[kind] : null;
  return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s !== '') : [];
};

/** 從夢客的某組預寫台詞隨機挑一句；該組沒有時用 fallback；都沒有回 null。 */
export function pickScripted(guest, kind, rnd = Math.random) {
  let list = lines(guest, kind);
  if (list.length === 0) list = lines(guest, 'fallback');
  if (list.length === 0) return null;
  const r = Number(rnd());
  const i = Math.min(list.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * list.length)));
  return list[i];
}

/** 調查可以入夢的物件時，look 之後播的選項對話。文字取 target 的 prompt／yes／no（dreamTarget 帶出），沒有就用預設。 */
export function dreamChoiceDialogue(target) {
  const t = (k) => (isText(target?.[k]) ? target[k] : DREAM_PROMPT_DEFAULT[k]);
  return {
    id: DREAM_CHOICE_ID,
    start: 'ask',
    nodes: [{
      id: 'ask', speaker: null, text: t('prompt'),
      choices: [
        { text: t('yes'), effects: [{ enter_dream: { map: target.map, spawn: target.spawn } }], next: END },
        { text: t('no'), next: END },
      ],
    }],
  };
}

/** 未啟用雲端時「自由交談」改播的對話：夢客的 not_open 台詞＋說明。 */
export function notOpenDialogue(guest, rnd = Math.random) {
  const line = pickScripted(guest, 'not_open', rnd) ?? '……';
  return {
    id: NOT_OPEN_ID,
    start: 'line',
    nodes: [
      { id: 'line', speaker: typeof guest?.name === 'string' ? guest.name : null, text: line, next: 'note' },
      { id: 'note', speaker: null, text: NOT_OPEN_NOTE, next: END },
    ],
  };
}
