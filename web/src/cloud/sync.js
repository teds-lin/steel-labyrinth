// 雲端同步邏輯（純邏輯，不碰 Phaser／DOM）：雲端資訊存取、上傳、下載、衝突整理、401 處理、轉移碼格式。
// 規格：docs/API.md「客戶端行為」。本機存檔是主體：任何雲端錯誤都只回傳訊息，不改本機存檔。
import { serialize, deserialize, sanitizeLoadedState, SLOT_COUNT } from '../core/save.js';

/** localStorage 的鍵：{ player_id, token, transfer_code, slots:{ <槽>:{version, updated_at} }, auto_upload, local_saved_at:{ <槽>:秒 } }。 */
export const CLOUD_KEY = 'steel-labyrinth:cloud';

export const MSG = Object.freeze({
  unavailable: '雲端暫時無法使用，稍後再試',
  relink: '此裝置的雲端連結已失效，請重新用轉移碼接續',
  badCode: '轉移碼不正確或已失效，請確認後再輸入',
  cloudEmpty: '雲端的這一格是空的',
  disabled: '尚未啟用雲端存檔',
  storageBlocked: '瀏覽器封鎖了儲存空間，無法使用雲端存檔',
  localEmpty: '本機的這一格是空的，沒有可以上傳的存檔',
  localBroken: '本機的這一格存檔無法讀取，不能上傳',
  newer: '雲端存檔的版本較新，請更新遊戲後再下載',
  broken: '雲端存檔的內容有誤，無法使用',
  localWrite: '無法寫入本機存檔（瀏覽器封鎖了儲存空間）',
});

// ---------- 轉移碼 ----------
export const TRANSFER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${TRANSFER_ALPHABET}]{8}$`);
// 分隔字元：空白、連字號與各種破折號（U+2010～U+2015、U+2212、U+30FC、U+FF0D）
const DASHES = [0x2d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0x30fc, 0xff0d].map((c) => String.fromCharCode(c));
const stripSeparators = (s) => [...s].filter((ch) => !/\s/.test(ch) && !DASHES.includes(ch)).join('');

/** 輸入 → 8 碼大寫（容忍小寫、空白、連字號、全形字）；不合法回 null。 */
export function normalizeTransferCode(input) {
  if (typeof input !== 'string') return null;
  const s = stripSeparators(input.normalize('NFKC')).toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

/** 顯示用：XXXX-XXXX；不合法回 null。 */
export function formatTransferCode(input) {
  const n = normalizeTransferCode(input);
  return n ? `${n.slice(0, 4)}-${n.slice(4)}` : null;
}

// ---------- 雲端資訊 ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v !== '';
const isVersion = (v) => Number.isInteger(v) && v >= 0;
const isTime = (v) => Number.isInteger(v) && v >= 0;
const slotKeys = () => Array.from({ length: SLOT_COUNT }, (_, i) => String(i + 1));

function cleanInfo(raw) {
  if (!isObj(raw) || !isStr(raw.token) || !isStr(raw.player_id)) return null;
  const slots = {};
  const saved = {};
  for (const k of slotKeys()) {
    const s = isObj(raw.slots) ? raw.slots[k] : undefined;
    if (isObj(s) && isVersion(s.version)) slots[k] = { version: s.version, updated_at: isTime(s.updated_at) ? s.updated_at : null };
    const t = isObj(raw.local_saved_at) ? raw.local_saved_at[k] : undefined;
    if (isTime(t)) saved[k] = t;
  }
  return {
    player_id: raw.player_id,
    token: raw.token,
    transfer_code: formatTransferCode(raw.transfer_code) ?? null,
    slots,
    auto_upload: raw.auto_upload === true,
    local_saved_at: saved,
  };
}

/** 讀雲端資訊；不存在、損壞、缺權杖、存取丟錯都回 null。 */
export function readCloudInfo(backend) {
  try {
    const raw = backend?.getItem(CLOUD_KEY);
    if (typeof raw !== 'string') return null;
    return cleanInfo(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 寫雲端資訊；成功回 true。 */
export function writeCloudInfo(backend, info) {
  const clean = cleanInfo(info);
  if (!backend || !clean) return false;
  try {
    backend.setItem(CLOUD_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

export function clearCloudInfo(backend) {
  if (!backend) return false;
  try {
    backend.removeItem(CLOUD_KEY);
    return true;
  } catch {
    return false;
  }
}

// ---------- 訊息與摘要 ----------
/** API 失敗結果 → 給玩家看的訊息。 */
export function cloudErrorMessage(r) {
  if (r?.status === 401) return MSG.relink;
  if (r?.status === 429 && Number.isInteger(r.retryAfter) && r.retryAfter > 0) return `雲端暫時無法使用，請等 ${r.retryAfter} 秒後再試`;
  return MSG.unavailable;
}

/** state → { name, map, chapter, playtime_s }。 */
export function summarizeState(state) {
  if (!isObj(state)) return null;
  return {
    name: typeof state.player?.name === 'string' ? state.player.name : '',
    map: typeof state.location?.map === 'string' ? state.location.map : '',
    chapter: typeof state.chapter === 'string' ? state.chapter : null,
    playtime_s: Number.isFinite(state.playtime_s) ? Math.max(0, Math.floor(state.playtime_s)) : 0,
  };
}

/**
 * 伺服器的 summary → { name, map, chapter, playtime_s }。
 * 版本較新的存檔欄位可能是 null（API.md 補充第 4 條）：型別不對的欄位一律為 null，由畫面顯示成「—」。
 */
function cleanSummary(s) {
  const o = isObj(s) ? s : {};
  return {
    name: typeof o.name === 'string' ? o.name : null,
    map: typeof o.map === 'string' && o.map !== '' ? o.map : null,
    chapter: typeof o.chapter === 'string' ? o.chapter : null,
    playtime_s: Number.isFinite(o.playtime_s) && o.playtime_s >= 0 ? Math.floor(o.playtime_s) : null,
  };
}

const parseEtag = (etag) => {
  const m = typeof etag === 'string' ? /^\s*(?:W\/)?"?(\d{1,15})"?\s*$/.exec(etag) : null;
  return m ? Number(m[1]) : null;
};

const CHAPTER_RE = /^[a-z0-9_]{1,32}$/;
const clampInt = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : lo);
const validSlot = (s) => Number.isInteger(s) && s >= 1 && s <= SLOT_COUNT;

/**
 * 建立同步器。
 * - backend：localStorage 相容物件（可為 null）。
 * - saveStore：core/save.js 的 createStorage(...) 結果（本機 3 槽）。
 * - getData：回傳目前的內容資料 bundle（sanitizeLoadedState 用）。
 * - api：createCloudApi(...) 的結果；權杖由 api 的 getToken 讀 readCloudInfo(backend)。
 * - now：毫秒時間（測試用）。
 */
export function createCloudSync({ backend, saveStore, getData = () => null, api, now = () => Date.now() } = {}) {
  let lastError = null;
  let lastOk = null;
  const nowSec = () => Math.floor(now() / 1000);
  const info = () => readCloudInfo(backend);
  const update = (fn) => {
    const cur = info();
    if (!cur) return false;
    return writeCloudInfo(backend, fn(cur));
  };

  /** API 失敗 → 統一的結果；401 時清除本機雲端資訊。 */
  function failed(op, r) {
    lastError = { op, kind: r?.kind ?? 'network', status: r?.status ?? 0, error: r?.error ?? null, at: nowSec() };
    if (r?.status === 401) {
      clearCloudInfo(backend);
      return { ok: false, kind: 'unauthorized', relink: true, message: MSG.relink, status: 401 };
    }
    return { ok: false, kind: r?.kind ?? 'network', status: r?.status ?? 0, retryAfter: r?.retryAfter ?? null, message: cloudErrorMessage(r) };
  }
  const local = (op, kind, message) => {
    lastError = { op, kind, status: 0, error: kind, at: nowSec() };
    return { ok: false, kind, message };
  };
  const succeeded = (op, r) => {
    lastOk = { op, at: nowSec() };
    return r;
  };
  const requireEnabled = (op) => (info() ? null : local(op, 'disabled', MSG.disabled));

  /** 本機槽的摘要（給雲端選單與衝突比較）。 */
  function localSummary(slot) {
    let r;
    try {
      r = saveStore?.load(slot);
    } catch {
      r = { ok: false, code: 'storage_error' };
    }
    const savedAt = info()?.local_saved_at?.[String(slot)] ?? null;
    if (!r?.ok) return { slot, empty: r?.code === 'empty' || r?.code === 'unavailable', broken: r?.code !== 'empty' && r?.code !== 'unavailable', updated_at: null };
    return { slot, empty: false, broken: false, ...summarizeState(r.state), updated_at: savedAt };
  }

  /** 雲端的存檔字串 → 經 deserialize＋sanitizeLoadedState 的 state。 */
  function validateCloudData(data) {
    if (typeof data !== 'string') return { ok: false, kind: 'broken', message: MSG.broken };
    let st;
    try {
      st = deserialize(data);
    } catch (e) {
      if (e?.code === 'newer') return { ok: false, kind: 'newer', message: MSG.newer };
      return { ok: false, kind: 'broken', message: MSG.broken };
    }
    let s;
    try {
      s = sanitizeLoadedState(st, getData?.());
    } catch {
      return { ok: false, kind: 'broken', message: MSG.broken };
    }
    if (!s?.ok) return { ok: false, kind: 'broken', message: `${MSG.broken}（${s?.reason ?? ''}）` };
    return { ok: true, state: s.state, warnings: Array.isArray(s.warnings) ? s.warnings : [] };
  }

  async function fetchCloud(slot) {
    const off = requireEnabled('download');
    if (off) return off;
    if (!validSlot(slot)) return local('download', 'invalid_slot', MSG.unavailable);
    const r = await api.getSave(slot);
    if (!r.ok) {
      if (r.status === 404) return local('download', 'empty', MSG.cloudEmpty);
      return failed('download', r);
    }
    const v = validateCloudData(r.body?.data);
    if (!v.ok) {
      lastError = { op: 'download', kind: v.kind, status: 200, error: v.kind, at: nowSec() };
      return v;
    }
    const version = isVersion(r.body?.version) ? r.body.version : parseEtag(r.etag);
    const updatedAt = isTime(r.body?.updated_at) ? r.body.updated_at : null;
    return succeeded('download', { ok: true, state: v.state, warnings: v.warnings, version, updated_at: updatedAt });
  }

  return {
    enabled: () => info() !== null,

    /** 唯讀狀態（不含權杖）。 */
    status() {
      const i = info();
      return {
        enabled: i !== null,
        playerId: i?.player_id ?? null,
        transferCode: i?.transfer_code ?? null,
        autoUpload: i?.auto_upload ?? false,
        slots: i ? structuredCloneSafe(i.slots) : {},
        localSavedAt: i ? { ...i.local_saved_at } : {},
        lastError: lastError ? { ...lastError } : null,
        lastOk: lastOk ? { ...lastOk } : null,
      };
    },

    transferCode: () => info()?.transfer_code ?? null,
    autoUpload: () => info()?.auto_upload === true,
    localSummary,

    /** 第一次啟用：建立匿名玩家。已啟用時直接成功。 */
    async enable() {
      const cur = info();
      if (cur) return { ok: true, transferCode: cur.transfer_code };
      if (!backend) return local('enable', 'storage', MSG.storageBlocked);
      const r = await api.createPlayer();
      if (!r.ok) return failed('enable', r);
      const b = r.body;
      const code = formatTransferCode(b?.transfer_code);
      if (!isObj(b) || !isStr(b.player_id) || !isStr(b.token) || !code) return local('enable', 'bad_response', MSG.unavailable);
      if (!writeCloudInfo(backend, { player_id: b.player_id, token: b.token, transfer_code: code, slots: {}, auto_upload: false })) {
        return local('enable', 'storage', MSG.storageBlocked);
      }
      return succeeded('enable', { ok: true, transferCode: code });
    },

    /** 用轉移碼接續：成功後整份雲端資訊換成新的玩家權杖（版本紀錄清空）。 */
    async connect(input) {
      const code = formatTransferCode(input);
      if (!code) return local('connect', 'not_found', MSG.badCode);
      if (!backend) return local('connect', 'storage', MSG.storageBlocked);
      const r = await api.transfer(code);
      if (!r.ok) {
        if (r.status === 404 || r.status === 400) return local('connect', 'not_found', MSG.badCode);
        // 轉移時的 401 不代表本機資訊失效（這個請求不帶權杖），不清除
        if (r.status === 401) return local('connect', 'not_found', MSG.badCode);
        return failed('connect', r);
      }
      const b = r.body;
      const next = formatTransferCode(b?.transfer_code);
      if (!isObj(b) || !isStr(b.player_id) || !isStr(b.token) || !next) return local('connect', 'bad_response', MSG.unavailable);
      if (!writeCloudInfo(backend, { player_id: b.player_id, token: b.token, transfer_code: next, slots: {}, auto_upload: false })) {
        return local('connect', 'storage', MSG.storageBlocked);
      }
      return succeeded('connect', { ok: true, transferCode: next });
    },

    async rotate() {
      const off = requireEnabled('rotate');
      if (off) return off;
      const r = await api.rotateTransfer();
      if (!r.ok) return failed('rotate', r);
      const code = formatTransferCode(r.body?.transfer_code);
      if (!code) return local('rotate', 'bad_response', MSG.unavailable);
      update((cur) => ({ ...cur, transfer_code: code }));
      return succeeded('rotate', { ok: true, transferCode: code });
    },

    /** 停用此裝置的雲端：只清本機資訊。 */
    disable() {
      lastError = null;
      return clearCloudInfo(backend);
    },

    setAutoUpload(on) {
      return update((cur) => ({ ...cur, auto_upload: on === true }));
    },

    /** 本機手動存檔後呼叫：記下存檔時間（雲端摘要比較用）。 */
    noteLocalSave(slot) {
      if (!validSlot(slot)) return false;
      return update((cur) => ({ ...cur, local_saved_at: { ...cur.local_saved_at, [String(slot)]: nowSec() } }));
    },

    /** 列出雲端 3 格：[{ slot, empty:true } | { slot, empty:false, version, updated_at, summary }]。 */
    async listCloud() {
      const off = requireEnabled('list');
      if (off) return off;
      const r = await api.listSaves();
      if (!r.ok) return failed('list', r);
      const list = r.body?.slots;
      if (!Array.isArray(list)) return local('list', 'bad_response', MSG.unavailable);
      const slots = [];
      for (let slot = 1; slot <= SLOT_COUNT; slot++) {
        const s = list.find((x) => isObj(x) && x.slot === slot);
        if (!s || s.empty === true || !isVersion(s.version)) slots.push({ slot, empty: true });
        else slots.push({ slot, empty: false, version: s.version, updated_at: isTime(s.updated_at) ? s.updated_at : null, summary: cleanSummary(s.summary) });
      }
      return succeeded('list', { ok: true, slots });
    },

    /**
     * 上傳本機槽到同號的雲端槽。
     * - 一般：依本機記住的雲端版本帶 If-Match；沒有記住時 If-None-Match: *。
     * - force（衝突時選「用本機的」）：以衝突當下的雲端版本 cloudVersion 為 If-Match（null＝雲端是空的）。
     * 回傳 { ok:true, version } | { ok:false, kind:'conflict', slot, conflict } | { ok:false, kind, message, relink? }。
     */
    async upload(slot, { force = false, cloudVersion = null } = {}) {
      const off = requireEnabled('upload');
      if (off) return off;
      if (!validSlot(slot)) return local('upload', 'invalid_slot', MSG.unavailable);
      let r;
      try {
        r = saveStore.load(slot);
      } catch {
        r = { ok: false, code: 'storage_error' };
      }
      if (!r?.ok) {
        if (r?.code === 'empty' || r?.code === 'unavailable') return local('upload', 'local_empty', MSG.localEmpty);
        return local('upload', 'local_broken', MSG.localBroken);
      }
      const data = serialize(r.state);
      const remembered = info()?.slots?.[String(slot)]?.version ?? null;
      let version = force ? (isVersion(cloudVersion) ? cloudVersion : null) : remembered;
      let res = await api.putSave(slot, data, { version });
      if (!res.ok && res.status === 404 && version !== null) {
        // 雲端槽已經被刪掉：記住的版本沒有意義了，改成「只在空槽時建立」再試一次
        update((cur) => {
          const slots = { ...cur.slots };
          delete slots[String(slot)];
          return { ...cur, slots };
        });
        version = null;
        res = await api.putSave(slot, data, { version });
      }
      if (!res.ok) {
        if (res.status === 409) {
          const cur = isObj(res.body?.current) ? res.body.current : null;
          const cloud = cur && isVersion(cur.version)
            ? { empty: false, version: cur.version, updated_at: isTime(cur.updated_at) ? cur.updated_at : null, ...cleanSummary(cur.summary) }
            : { empty: true };
          const ls = localSummary(slot);
          lastError = { op: 'upload', kind: 'conflict', status: 409, error: 'conflict', at: nowSec() };
          return {
            ok: false, kind: 'conflict', slot,
            conflict: {
              slot,
              cloudVersion: cloud.empty ? null : cloud.version,
              cloud,
              local: { empty: false, name: ls.name, map: ls.map, chapter: ls.chapter, playtime_s: ls.playtime_s, updated_at: ls.updated_at },
            },
          };
        }
        return failed('upload', res);
      }
      const newVersion = isVersion(res.body?.version) ? res.body.version : parseEtag(res.etag);
      const updatedAt = isTime(res.body?.updated_at) ? res.body.updated_at : nowSec();
      if (newVersion !== null) {
        update((cur) => ({ ...cur, slots: { ...cur.slots, [String(slot)]: { version: newVersion, updated_at: updatedAt } } }));
      }
      return succeeded('upload', { ok: true, version: newVersion, updated_at: updatedAt });
    },

    /** 只下載並驗證（「直接讀取」用），不寫入本機。 */
    fetchCloud,

    /** 下載雲端槽到本機槽（預設同號）：驗證通過才寫入；同號時記下版本。 */
    async download(cloudSlot, localSlot = cloudSlot) {
      if (!validSlot(localSlot)) return local('download', 'invalid_slot', MSG.unavailable);
      const r = await fetchCloud(cloudSlot);
      if (!r.ok) return r;
      let w;
      try {
        w = saveStore.save(localSlot, r.state);
      } catch {
        w = { ok: false };
      }
      if (!w?.ok) return local('download', 'local_write', MSG.localWrite);
      if (localSlot === cloudSlot && r.version !== null) {
        update((cur) => ({ ...cur, slots: { ...cur.slots, [String(localSlot)]: { version: r.version, updated_at: r.updated_at } } }));
      }
      return r;
    },

    /** 回報章節完成（失敗由呼叫端只記 console）。 */
    async reportClear({ chapter, ending = null, play_seconds: sec = 0, collapse = 0 } = {}) {
      const off = requireEnabled('clear');
      if (off) return off;
      if (typeof chapter !== 'string' || !CHAPTER_RE.test(chapter)) return local('clear', 'bad_chapter', '章節代碼不合法');
      const rec = {
        chapter,
        ending: typeof ending === 'string' && CHAPTER_RE.test(ending) ? ending : null,
        play_seconds: clampInt(sec, 0, 10_000_000),
        collapse: clampInt(collapse, 0, 100),
      };
      const r = await api.reportClear(rec);
      if (!r.ok) return failed('clear', r);
      return succeeded('clear', { ok: true, body: r.body });
    },
  };
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o ?? {}));
}
