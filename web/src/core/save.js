// 存檔：序列化、版本遷移、3 個存檔槽＋自動存檔槽。只存 DATA-FORMAT「遊戲狀態」「存檔 v2」「鐘塔之夢（存檔 v3）」裡的事實。
// 拒絕原因與警告都帶 code（給畫面判斷用），訊息字串照舊。
// 存取層（backend，通常是 localStorage）出錯時一律回 { ok:false, reason }，不讓遊戲當機。
// 讀檔分兩關（DATA-FORMAT「讀檔驗證」）：deserialize 檢查格式；sanitizeLoadedState 對照內容資料檢查語意並修復位置。
import { sanitizeName } from './name.js';
import { DIRS, canMove, mapSize } from './grid.js';
import { HERO_ID, MAX_AMMO, MAX_PARTY, characterDef, deriveStats } from './stats.js';

export { MAX_AMMO, MAX_PARTY };

export const CURRENT_VERSION = 3;
export const SLOT_COUNT = 3;
export const KEY_PREFIX = 'steel-labyrinth:save:';
export const AUTO_KEY = `${KEY_PREFIX}auto`;
/** v1→v2 遷移時，持有這個道具就給 3 發子彈。 */
export const REVOLVER_ITEM = 'revolver';
export const REVOLVER_START_AMMO = 3;

/** 帶 code 的錯誤（deserialize 丟出；createStorage 轉成 { ok:false, reason, code }）。 */
function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** 讀檔警告：{ code, message }；String(warning) 仍是原本的訊息字串（舊畫面程式碼照舊可用）。 */
function warning(code, message) {
  const w = { code, message };
  Object.defineProperty(w, 'toString', { value: () => message, enumerable: false });
  return w;
}
const reject = (code, reason) => ({ ok: false, reason, code });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const intIn = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isCount = (v) => Number.isInteger(v) && v >= 0;
const valuesOk = (pred) => (v) => isObj(v) && Object.values(v).every(pred);
/** items／resonance 的鍵格式（API 修訂 2 F）。 */
export const SAVE_KEY_RE = /^[a-z0-9_]{1,32}$/;
const keyedCounts = (pred) => (v) => isObj(v) && Object.entries(v).every(([k, n]) => SAVE_KEY_RE.test(k) && pred(n));
/** flags 的值只能是布林或整數（鍵不限格式：遊戲本身用 enter:attic 這類鍵）。 */
const isFlagValue = (v) => typeof v === 'boolean' || Number.isInteger(v);
/** 整份存檔 JSON 的巢狀深度上限（根物件算第 1 層）。 */
export const MAX_JSON_DEPTH = 8;

/** 不解析、只掃描字串，回傳 JSON 文字的最大巢狀深度（字串內的括號不算）；超過 limit 就提早停止。 */
function jsonDepthExceeds(str, limit) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++; // 反斜線：跳過下一個字元
      else if (c === 34) inStr = false;
    } else if (c === 34) {
      inStr = true;
    } else if (c === 123 || c === 91) {
      if (++depth > limit) return true;
    } else if (c === 125 || c === 93) {
      depth--;
    }
  }
  return false;
}

export const MAX_ECHO_CHARGES = 99;

/**
 * 版本遷移：migrations[n] 把 vn 轉成 v(n+1)。
 * v0（示範用的舊格式）：名字放在頂層 name，沒有 echo 與 resonance。
 */
export const migrations = {
  0(old) {
    const { name, ...rest } = old;
    return {
      ...rest,
      schema_version: 1,
      player: { name: typeof name === 'string' ? name : '' },
      echo: isObj(old.echo) ? old.echo : { charges: 3 },
      resonance: isObj(old.resonance) ? old.resonance : {},
    };
  },
  /** v1 → v2：只有主角、hp/sp 記 null（讀檔時由 sanitizeLoadedState 補成上限）；持有左輪時 3 發子彈。 */
  1(old) {
    const hasRevolver = isObj(old.items) && Object.hasOwn(old.items, REVOLVER_ITEM) && old.items[REVOLVER_ITEM] > 0;
    return {
      ...old,
      schema_version: 2,
      party: [{ id: HERO_ID, hp: null, sp: null }],
      ammo: hasRevolver ? REVOLVER_START_AMMO : 0,
      pending: null,
    };
  },
  /** v2 → v3（鐘塔之夢）：補 dream_return＝null（v2 沒有夢境；誤帶的值一律丟掉）。 */
  2(old) {
    return { ...old, schema_version: 3, dream_return: null };
  },
};

/** 把 state 轉成存檔字串（固定寫入目前版本；pending 一律寫成 null；沒有 dream_return 時寫成 null）。 */
export function serialize(state) {
  return JSON.stringify({ ...state, schema_version: CURRENT_VERSION, pending: null, dream_return: state?.dream_return ?? null });
}

const isStatValue = (v) => v === null || (Number.isInteger(v) && v >= 0);
const isMember = (m) => isObj(m) && typeof m.id === 'string' && m.id !== ''
  && Object.hasOwn(m, 'hp') && Object.hasOwn(m, 'sp') && isStatValue(m.hp) && isStatValue(m.sp);

// [欄位路徑, 檢查函式]：缺漏或型別錯誤時錯誤訊息會指出路徑。
const REQUIRED = [
  ['player', isObj],
  ['player.name', (v) => typeof v === 'string'],
  ['lineage', (v) => v === null || (isObj(v) && typeof v.id === 'string' && Number.isInteger(v.rank))],
  ['location', isObj],
  ['location.map', (v) => typeof v === 'string'],
  ['flags', valuesOk(isFlagValue)],     // 值只能是布林或整數
  ['items', keyedCounts(isPosInt)],     // 鍵 [a-z0-9_]{1,32}；道具數量為正整數
  ['echo', isObj],
  ['echo.charges', intIn(0, MAX_ECHO_CHARGES)],
  ['collapse', intIn(0, 100)],
  ['resonance', keyedCounts(isCount)],
  ['chapter', (v) => v === null || typeof v === 'string'],
  ['chapter_done', (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')],
  ['playtime_s', (v) => isNum(v) && v >= 0],
  ['party', (v) => Array.isArray(v) && v.every(isMember)],
  ['ammo', intIn(0, MAX_AMMO)],
  ['pending', (v) => v === null || Array.isArray(v)],
  // v3：入夢前的現實位置（醒來時回到這裡）。x／y／dir 的型別交給 sanitizeLoadedState 修復（同 location）。
  ['dream_return', (v) => v === null || (isObj(v) && typeof v.map === 'string')],
];

function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split('.')) {
    if (!isObj(cur) || !Object.hasOwn(cur, k)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

/** 檢查必要欄位；有問題就丟錯。 */
function assertShape(obj) {
  for (const [path, ok] of REQUIRED) {
    const r = getPath(obj, path);
    if (!r.found) throw codedError('corrupt', `存檔缺少欄位：${path}`);
    if (!ok(r.value)) throw codedError('corrupt', `存檔欄位型別錯誤：${path}`);
  }
}

/** 從字串還原 state；損壞、未來版本、缺欄位都丟出明確錯誤。 */
export function deserialize(str) {
  if (typeof str === 'string' && jsonDepthExceeds(str, MAX_JSON_DEPTH)) {
    throw codedError('corrupt', `存檔損壞：JSON 巢狀超過 ${MAX_JSON_DEPTH} 層`);
  }
  let obj;
  try {
    obj = JSON.parse(str);
  } catch {
    throw codedError('corrupt', '存檔損壞：JSON 無法解析');
  }
  if (!isObj(obj)) throw codedError('corrupt', '存檔損壞：內容不是物件');
  const v = obj.schema_version;
  if (!Object.hasOwn(obj, 'schema_version')) throw codedError('corrupt', '存檔缺少欄位：schema_version');
  if (!Number.isInteger(v)) throw codedError('corrupt', '存檔欄位型別錯誤：schema_version');
  if (v > CURRENT_VERSION) {
    throw codedError('newer', `存檔版本 ${v} 較新，目前遊戲只支援到版本 ${CURRENT_VERSION}，請更新遊戲`);
  }
  let cur = obj;
  for (let ver = v; ver < CURRENT_VERSION; ver++) {
    const fn = Object.hasOwn(migrations, ver) ? migrations[ver] : undefined;
    if (typeof fn !== 'function') throw codedError('corrupt', `沒有從版本 ${ver} 遷移的方法`);
    cur = fn(cur);
  }
  assertShape(cur);
  return cur;
}

const findById = (list, id) => (Array.isArray(list) ? list.find((x) => isObj(x) && x.id === id) : undefined);

/** 位置 { x, y, dir } 在地圖上合法：整數座標、在範圍內、可以站、方向合法。 */
function validPlace(map, place, state, data) {
  const { width, height } = mapSize(map);
  const dirOk = typeof place.dir === 'string' && Object.hasOwn(DIRS, place.dir);
  return dirOk && Number.isInteger(place.x) && Number.isInteger(place.y)
    && place.x >= 0 && place.y >= 0 && place.x < width && place.y < height
    && canMove(map, state, place.x, place.y, data);
}

/** spawn → { map, x, y, dir }；spawnId 找不到時用第一個 spawn；沒有 spawn → null。 */
function spawnPlace(map, spawnId) {
  const list = Array.isArray(map.spawns) ? map.spawns.filter(isObj) : [];
  const sp = list.find((x) => x.id === spawnId) ?? list[0];
  if (!sp) return null;
  return { map: map.id, x: sp.x, y: sp.y, dir: Object.hasOwn(DIRS, sp.dir ?? '') ? sp.dir : 'down' };
}
const firstSpawn = (map) => spawnPlace(map, undefined);

/**
 * 該章的預設起點（{ map, x, y, dir } 或 null）：第一章（manifest.chapters[0]）與找不到的章節用 manifest.start；
 * 其他章用前一章 end_screen.continue（接續進入這一章的位置）。
 */
function chapterStart(chapter, data) {
  const chapters = Array.isArray(data?.manifest?.chapters) ? data.manifest.chapters : [];
  const i = chapters.indexOf(chapter);
  const prev = i > 0 ? findById(data?.story, chapters[i - 1]) : undefined;
  const target = isObj(prev?.end_screen?.continue) ? prev.end_screen.continue : data?.manifest?.start;
  if (!isObj(target)) return null;
  const map = findById(data?.maps, target.map);
  return map ? spawnPlace(map, target.spawn) : null;
}

/**
 * 讀檔的語意檢查與修復（畫面層在 storage.load 成功後呼叫）。不修改輸入。
 * 回傳 { ok:true, state, warnings:[] } 或 { ok:false, reason }。
 * - 名字重新經過 sanitizeName。
 * - lineage：null，或 id 存在且 rank 是該譜系已開放的階位；否則拒絕。
 * - location：地圖不存在 → 拒絕；座標不合法、超出範圍、站在 solid 地形／solid 物件上、方向不合法 → 改放第一個 spawn 並警告。
 */
export function sanitizeLoadedState(state, data) {
  try {
    if (!isObj(state)) return reject('corrupt', '存檔損壞：內容不是物件');
    // 舊程式在記憶體中建立的 state（例如還沒有 dream_return 的 newGame）視為 null
    if (!Object.hasOwn(state, 'dream_return')) state = { ...state, dream_return: null };
    try {
      assertShape(state);
    } catch (e) {
      return reject('corrupt', e.message);
    }
    const warnings = [];
    let next = state;

    const name = sanitizeName(state.player.name);
    if (name !== state.player.name) {
      warnings.push(warning('name_sanitized', '存檔的名字含有不合法的字元或過長，已重新整理'));
      next = { ...next, player: { ...next.player, name } };
    }

    const lin = state.lineage;
    if (lin !== null) {
      const def = findById(data?.lineages, lin.id);
      if (!def) return reject('unknown_lineage', `存檔的譜系「${lin.id}」不存在`);
      if (!Array.isArray(def.ranks) || !def.ranks.some((r) => isObj(r) && r.rank === lin.rank)) {
        return reject('unknown_lineage', `存檔的譜系「${lin.id}」沒有開放階位 ${lin.rank}`);
      }
    }

    // 隊伍：成員存在於 characters.json（主角例外：序章資料沒有 characters.json）、主角第一位、不重複、最多 3 人。
    const party = state.party;
    if (party.length === 0 || party.length > MAX_PARTY) return reject('party_invalid', `存檔的隊伍人數不合法（${party.length} 人，必須是 1～${MAX_PARTY} 人）`);
    if (party[0].id !== HERO_ID) return reject('party_invalid', '存檔的隊伍第一位必須是主角');
    const seen = new Set();
    for (const m of party) {
      if (seen.has(m.id)) return reject('party_invalid', `存檔的隊伍成員「${m.id}」重複`);
      seen.add(m.id);
      if (m.id !== HERO_ID && !characterDef(m.id, data)) return reject('party_invalid', `存檔的隊伍成員「${m.id}」不存在`);
    }
    let clamped = false;
    const fixedParty = party.map((m) => {
      if (!characterDef(m.id, data)) return { id: m.id, hp: m.hp, sp: m.sp }; // 主角沒有定義：無法算上限，維持原值
      const max = deriveStats(m.id, next, data);
      const fix = (v, hi) => {
        if (v === null) return hi;
        if (v > hi) { clamped = true; return hi; }
        return v;
      };
      return { id: m.id, hp: fix(m.hp, max.hp), sp: fix(m.sp, max.sp) };
    });
    if (clamped) warnings.push(warning('party_clamped', '存檔的隊伍生命或靈性超過上限，已調整為上限'));
    next = { ...next, party: fixedParty, pending: null };

    // v3：dream_return（入夢前的現實位置）。地圖不存在 → 改成該章的預設起點；位置不合法 → 該地圖第一個 spawn。
    const dr = state.dream_return;
    if (dr !== null) {
      const drMap = findById(data?.maps, dr.map);
      if (!drMap) {
        const start = chapterStart(state.chapter, data);
        if (!start) return reject('no_spawn', `存檔的醒來位置地圖「${dr.map}」不存在，也找不到這一章的預設起點`);
        warnings.push(warning('dream_return_reset', `存檔的醒來位置地圖「${dr.map}」不存在，已改成這一章的起點（${start.map}）`));
        next = { ...next, dream_return: start };
      } else if (!validPlace(drMap, dr, next, data)) {
        const sp = firstSpawn(drMap);
        if (!sp) return reject('no_spawn', `存檔的醒來位置不合法，而地圖「${drMap.id}」沒有可用的 spawn`);
        warnings.push(warning('dream_return_relocated', `存檔的醒來位置不合法，已移到地圖「${drMap.id}」的起始點`));
        next = { ...next, dream_return: sp };
      } else if (Object.keys(dr).some((k) => !['map', 'x', 'y', 'dir'].includes(k))) {
        next = { ...next, dream_return: { map: dr.map, x: dr.x, y: dr.y, dir: dr.dir } };
      }
    }

    const loc = state.location;
    const map = findById(data?.maps, loc.map);
    if (!map) {
      // 夢境地圖不存在（例如改名）但知道醒來的位置 → 直接醒來
      if (next.dream_return !== null) {
        warnings.push(warning('woke_up', `存檔所在的地圖「${loc.map}」不存在，已從夢中醒來`));
        return { ok: true, state: { ...next, location: next.dream_return, dream_return: null }, warnings };
      }
      return reject('unknown_map', `存檔所在的地圖「${loc.map}」不存在`);
    }
    const tidy = { map: map.id, x: loc.x, y: loc.y, dir: loc.dir };
    if (!validPlace(map, loc, next, data)) {
      const sp = Array.isArray(map.spawns) ? map.spawns.find(isObj) : undefined;
      if (!sp) return reject('no_spawn', `存檔位置不合法，而地圖「${map.id}」沒有可用的 spawn`);
      warnings.push(warning('relocated', `存檔位置不合法（${JSON.stringify({ x: loc.x, y: loc.y, dir: loc.dir })}），已移到地圖「${map.id}」的起始點「${sp.id}」`));
      next = { ...next, location: firstSpawn(map) };
    } else if (Object.keys(loc).some((k) => !Object.hasOwn(tidy, k))) {
      next = { ...next, location: tidy }; // 去掉多餘欄位（例如 newGame 未解析時的 spawn）
    }
    return { ok: true, state: next, warnings };
  } catch (e) {
    return reject('check_failed', `存檔檢查失敗：${e?.message ?? e}`);
  }
}

const reasonOf = (e) => (e && e.message ? `${e.name && e.name !== 'Error' ? e.name + ': ' : ''}${e.message}` : String(e));
const validSlot = (slot) => Number.isInteger(slot) && slot >= 1 && slot <= SLOT_COUNT;

/**
 * 包裝 backend（getItem/setItem/removeItem）成 3 個存檔槽（編號 1～3）＋自動存檔槽（steel-labyrinth:save:auto）。
 * 失敗一律回 { ok:false, reason, code }；code：empty／corrupt／newer／invalid_slot／unavailable／storage_error。
 */
export function createStorage(backend) {
  const keyOf = (slot) => `${KEY_PREFIX}${slot}`;
  const attempt = (fn) => {
    if (!backend) return reject('unavailable', '無法使用儲存空間');
    try {
      return fn();
    } catch (e) {
      return reject(typeof e?.code === 'string' ? e.code : 'storage_error', reasonOf(e));
    }
  };
  const guard = (slot, fn) => {
    if (!validSlot(slot)) return reject('invalid_slot', `不合法的存檔槽：${String(slot)}（只能是 1～${SLOT_COUNT}）`);
    return attempt(fn);
  };
  const readKey = (key) => {
    const raw = backend.getItem(key);
    if (raw === null || raw === undefined) return reject('empty', 'empty');
    return { ok: true, raw };
  };

  const save = (slot, state) => guard(slot, () => {
    backend.setItem(keyOf(slot), serialize(state));
    return { ok: true };
  });

  const load = (slot) => guard(slot, () => {
    const r = readKey(keyOf(slot));
    return r.ok ? { ok: true, state: deserialize(r.raw) } : r;
  });

  const remove = (slot) => guard(slot, () => {
    backend.removeItem(keyOf(slot));
    return { ok: true };
  });

  /**
   * 戰鬥開始前的自動存檔（給「重新挑戰」用）。meta.battle：要重新開始的遭遇 id。
   * 遭遇 id 記在存檔字串的 auto_battle 欄位，loadAuto 會把它拿掉再回傳 state。
   */
  const saveAuto = (state, meta = {}) => attempt(() => {
    const battle = typeof meta?.battle === 'string' ? meta.battle : null;
    const obj = JSON.parse(serialize(state));
    backend.setItem(AUTO_KEY, JSON.stringify({ ...obj, auto_battle: battle }));
    return { ok: true };
  });

  /** 回傳 { ok:true, state, battle } 或 { ok:false, reason, code }。state 仍需經過 sanitizeLoadedState。 */
  const loadAuto = () => attempt(() => {
    const r = readKey(AUTO_KEY);
    if (!r.ok) return r;
    const { auto_battle: battle, ...state } = deserialize(r.raw);
    return { ok: true, state, battle: typeof battle === 'string' ? battle : null };
  });

  /** 標題畫面用：每個槽的摘要（不含自動存檔槽）。 */
  const listSlots = () => {
    const out = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot++) {
      const r = load(slot);
      if (r.ok) {
        const s = r.state;
        out.push({ slot, ok: true, empty: false, name: s.player.name, map: s.location.map, chapter: s.chapter, playtime_s: s.playtime_s });
      } else if (r.reason === 'empty') {
        out.push({ slot, ok: true, empty: true });
      } else {
        out.push({ slot, ok: false, empty: false, reason: r.reason, code: r.code });
      }
    }
    return out;
  };

  return { save, load, remove, saveAuto, loadAuto, listSlots };
}
