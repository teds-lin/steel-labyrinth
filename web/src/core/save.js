// 存檔：序列化、版本遷移、3 個存檔槽。只存 DATA-FORMAT「遊戲狀態」裡的事實。
// 存取層（backend，通常是 localStorage）出錯時一律回 { ok:false, reason }，不讓遊戲當機。

export const CURRENT_VERSION = 1;
export const SLOT_COUNT = 3;
export const KEY_PREFIX = 'steel-labyrinth:save:';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

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
};

/** 把 state 轉成存檔字串（固定寫入目前版本）。 */
export function serialize(state) {
  return JSON.stringify({ ...state, schema_version: CURRENT_VERSION });
}

// [欄位路徑, 檢查函式]：缺漏或型別錯誤時錯誤訊息會指出路徑。
const REQUIRED = [
  ['player', isObj],
  ['player.name', (v) => typeof v === 'string'],
  ['lineage', (v) => v === null || (isObj(v) && typeof v.id === 'string' && isNum(v.rank))],
  ['location', isObj],
  ['location.map', (v) => typeof v === 'string'],
  ['flags', isObj],
  ['items', isObj],
  ['echo', isObj],
  ['echo.charges', isNum],
  ['collapse', isNum],
  ['resonance', isObj],
  ['chapter', (v) => v === null || typeof v === 'string'],
  ['chapter_done', Array.isArray],
  ['playtime_s', isNum],
];

function getPath(obj, path) {
  let cur = obj;
  for (const k of path.split('.')) {
    if (!isObj(cur) || !(k in cur)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

/** 檢查必要欄位；有問題就丟錯。 */
function assertShape(obj) {
  for (const [path, ok] of REQUIRED) {
    const r = getPath(obj, path);
    if (!r.found) throw new Error(`存檔缺少欄位：${path}`);
    if (!ok(r.value)) throw new Error(`存檔欄位型別錯誤：${path}`);
  }
}

/** 從字串還原 state；損壞、未來版本、缺欄位都丟出明確錯誤。 */
export function deserialize(str) {
  let obj;
  try {
    obj = JSON.parse(str);
  } catch {
    throw new Error('存檔損壞：JSON 無法解析');
  }
  if (!isObj(obj)) throw new Error('存檔損壞：內容不是物件');
  const v = obj.schema_version;
  if (!('schema_version' in obj)) throw new Error('存檔缺少欄位：schema_version');
  if (!Number.isInteger(v)) throw new Error('存檔欄位型別錯誤：schema_version');
  if (v > CURRENT_VERSION) {
    throw new Error(`存檔版本 ${v} 較新，目前遊戲只支援到版本 ${CURRENT_VERSION}，請更新遊戲`);
  }
  let cur = obj;
  for (let ver = v; ver < CURRENT_VERSION; ver++) {
    const fn = migrations[ver];
    if (typeof fn !== 'function') throw new Error(`沒有從版本 ${ver} 遷移的方法`);
    cur = fn(cur);
  }
  assertShape(cur);
  return cur;
}

const reasonOf = (e) => (e && e.message ? `${e.name && e.name !== 'Error' ? e.name + ': ' : ''}${e.message}` : String(e));
const validSlot = (slot) => Number.isInteger(slot) && slot >= 1 && slot <= SLOT_COUNT;

/** 包裝 backend（getItem/setItem/removeItem）成 3 個存檔槽（編號 1～3）。 */
export function createStorage(backend) {
  const keyOf = (slot) => `${KEY_PREFIX}${slot}`;
  const guard = (slot, fn) => {
    if (!validSlot(slot)) return { ok: false, reason: `不合法的存檔槽：${String(slot)}（只能是 1～${SLOT_COUNT}）` };
    if (!backend) return { ok: false, reason: '無法使用儲存空間' };
    try {
      return fn();
    } catch (e) {
      return { ok: false, reason: reasonOf(e) };
    }
  };

  const save = (slot, state) => guard(slot, () => {
    backend.setItem(keyOf(slot), serialize(state));
    return { ok: true };
  });

  const load = (slot) => guard(slot, () => {
    const raw = backend.getItem(keyOf(slot));
    if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
    return { ok: true, state: deserialize(raw) };
  });

  const remove = (slot) => guard(slot, () => {
    backend.removeItem(keyOf(slot));
    return { ok: true };
  });

  /** 標題畫面用：每個槽的摘要。 */
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
        out.push({ slot, ok: false, empty: false, reason: r.reason });
      }
    }
    return out;
  };

  return { save, load, remove, listSlots };
}
