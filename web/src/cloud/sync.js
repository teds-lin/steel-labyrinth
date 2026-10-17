// 雲端同步邏輯（純邏輯，不碰 Phaser／DOM）：雲端資訊存取、上傳、下載、衝突整理、401 處理、轉移碼格式。
// 規格：docs/API.md「客戶端行為」與「修訂 2」（衝突時以修訂 2 為準）。本機存檔是主體：任何雲端錯誤都只回傳訊息，不改本機存檔。
//
// 秘密的本機保存（修訂 2 A）：權杖與轉移碼由客戶端產生，**送出請求前**先寫進 localStorage：
// - 建立玩家／用轉移碼接續：待確認區 PENDING_KEY（{ op, …秘密, at }），伺服器確認後才轉正成 CLOUD_KEY 的雲端資訊。
//   逾時、網路錯誤或重新整理後，用待確認的權杖呼叫 GET /api/saves：200＝已生效（轉正）；401＝沒生效（可用同一組重試）。
// - 重新產生轉移碼：新碼先存在雲端資訊的 pending_transfer_code（畫面標示「新轉移碼尚未確認」），重送同一個碼直到成功。
// - 上傳：送出前把這次內容的 SHA-256 記在該格的 pending_sha256；之後以伺服器的 data_sha256 判斷是否其實已經寫入（修訂 2 B）。
import { serialize, deserialize, sanitizeLoadedState, SLOT_COUNT } from '../core/save.js';
import {
  TRANSFER_ALPHABET as ALPHABET, isToken, randomToken, randomTransferCode, sha256Hex, SHA256_RE,
} from './secrets.js';

/**
 * localStorage 的鍵：{ player_id|null, token, transfer_code, pending_transfer_code|null,
 *   slots:{ <槽>:{ version|null, updated_at|null, pending_sha256? } }, auto_upload, local_saved_at:{ <槽>:秒 } }。
 */
export const CLOUD_KEY = 'steel-labyrinth:cloud';
/** 待確認區：{ op:'enable', token, transfer_code, at } | { op:'transfer', code, new_token, new_transfer_code, at }。 */
export const PENDING_KEY = 'steel-labyrinth:cloud-pending';
/** 待確認的權杖確認為「沒生效」（401）時，超過這個秒數才丟掉（太新的可能還有請求在路上）。 */
export const PENDING_MAX_AGE_S = 600;
/**
 * 修訂 4b 第 5 節：回報通關沒送到（429、逾時、網路、5xx）的待送紀錄：{ player_id|null, records:{ <章>:{ chapter, ending, play_seconds, collapse } } }。
 * 各章只留最新一筆；下次啟動（recover）或下次通關回報成功後補送一次。
 */
export const CLEAR_QUEUE_KEY = 'steel-labyrinth:cloud-clear-queue';

export const MSG = Object.freeze({
  unavailable: '雲端暫時無法使用，稍後再試',
  relink: '此裝置的雲端連結已失效，請重新用轉移碼接續',
  // 修訂 4b 第 3 節：401 的重新連結頁面（帳號可能因長時間沒有使用、也沒有存檔而被清除）
  relinkPage: '此裝置的雲端連結已失效，請重新用轉移碼接續。\n也可以重新啟用雲端存檔（本機存檔不受影響）。',
  badCode: '轉移碼不正確或已失效，請確認後再輸入',
  cloudEmpty: '雲端的這一格是空的',
  disabled: '尚未啟用雲端存檔',
  notOpen: '雲端存檔尚未開放',
  capacity: '雲端存檔目前額滿，請稍後再試',
  storageBlocked: '瀏覽器封鎖了儲存空間，無法使用雲端存檔',
  localEmpty: '本機的這一格是空的，沒有可以上傳的存檔',
  localBroken: '本機的這一格存檔無法讀取，不能上傳',
  localInvalid: '本機的這一格存檔內容有誤，不能上傳',
  newer: '雲端存檔的版本較新，請更新遊戲後再下載',
  broken: '雲端存檔的內容有誤，無法使用',
  localWrite: '無法寫入本機存檔（瀏覽器封鎖了儲存空間）',
  tooLarge: '存檔太大，超過雲端每格 16 KB 的上限，無法上傳',
  pendingTransfer: '上一次接續還在確認中，請稍候再試',
});

/** 修訂 4 第 7 節：回報通關的遊戲時間上限（秒）；伺服器拒絕更大的值，超過就以上限回報。 */
export const MAX_PLAYER_SECONDS = 36000;

/** 修訂 3：每格雲端存檔上限 16 KB（serialize 輸出的 UTF-8 位元組）。 */
export const MAX_SAVE_BYTES = 16 * 1024;
const utf8Bytes = (str) => new TextEncoder().encode(str).length;

// ---------- 轉移碼 ----------
export const TRANSFER_ALPHABET = ALPHABET;
const CODE_RE = new RegExp(`^[${TRANSFER_ALPHABET}]{8}$`);
// 分隔字元：空白、連字號與各種破折號（U+2010～U+2015、U+2212、U+30FC、U+FF0D）
const DASHES = [0x2d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0x30fc, 0xff0d].map((c) => String.fromCharCode(c));
const stripSeparators = (s) => [...s].filter((ch) => !/\s/.test(ch) && !DASHES.includes(ch)).join('');
// 修訂 2 G：零寬與格式字元（Unicode Cf，例如 U+200B、U+FEFF、U+00AD、方向控制字元）一律去掉
const stripFormat = (s) => s.replace(/\p{Cf}/gu, '');

/** 輸入 → 8 碼大寫（容忍小寫、空白、連字號、全形字、零寬字元）；不合法回 null。 */
export function normalizeTransferCode(input) {
  if (typeof input !== 'string' || input.length > 256) return null;
  const s = stripSeparators(stripFormat(stripFormat(input).normalize('NFKC'))).toUpperCase();
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
/** 修訂 2 G：版本必須是 1～2³¹ 的整數。 */
const MAX_VERSION = 2 ** 31;
const isVersion = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_VERSION;
const isTime = (v) => Number.isInteger(v) && v >= 0;
const isSha = (v) => typeof v === 'string' && SHA256_RE.test(v);
const slotKeys = () => Array.from({ length: SLOT_COUNT }, (_, i) => String(i + 1));
const cleanPlayerId = (v) => (isStr(v) && v.length <= 128 ? v : null);

function cleanInfo(raw) {
  // 修訂 2 G：權杖必須是 43 字元 base64url，否則當作未啟用
  if (!isObj(raw) || !isToken(raw.token)) return null;
  const slots = {};
  const saved = {};
  for (const k of slotKeys()) {
    const s = isObj(raw.slots) ? raw.slots[k] : undefined;
    if (isObj(s)) {
      const version = isVersion(s.version) ? s.version : null; // 不合法的版本：忘掉
      const pend = isSha(s.pending_sha256) ? s.pending_sha256 : null;
      if (version !== null || pend !== null) {
        slots[k] = { version, updated_at: version !== null && isTime(s.updated_at) ? s.updated_at : null };
        if (pend !== null) slots[k].pending_sha256 = pend;
      }
    }
    const t = isObj(raw.local_saved_at) ? raw.local_saved_at[k] : undefined;
    if (isTime(t)) saved[k] = t;
  }
  return {
    player_id: cleanPlayerId(raw.player_id),
    token: raw.token,
    transfer_code: formatTransferCode(raw.transfer_code) ?? null,
    pending_transfer_code: formatTransferCode(raw.pending_transfer_code) ?? null,
    slots,
    auto_upload: raw.auto_upload === true,
    local_saved_at: saved,
  };
}

/** 讀雲端資訊；不存在、損壞、權杖格式不對、存取丟錯都回 null。 */
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

// ---------- 待確認區 ----------
function cleanPending(raw) {
  if (!isObj(raw)) return null;
  const at = isTime(raw.at) ? raw.at : 0;
  if (raw.op === 'enable') {
    const code = formatTransferCode(raw.transfer_code);
    return isToken(raw.token) && code ? { op: 'enable', token: raw.token, transfer_code: code, at } : null;
  }
  if (raw.op === 'transfer') {
    const code = formatTransferCode(raw.code);
    const next = formatTransferCode(raw.new_transfer_code);
    return code && next && isToken(raw.new_token) ? { op: 'transfer', code, new_token: raw.new_token, new_transfer_code: next, at } : null;
  }
  return null;
}

/** 讀待確認區；壞掉的內容直接清掉。 */
export function readPending(backend) {
  let raw;
  try {
    raw = backend?.getItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== 'string') return null;
  let p = null;
  try { p = cleanPending(JSON.parse(raw)); } catch { p = null; }
  if (!p) clearPending(backend);
  return p;
}

function writePending(backend, p) {
  const clean = cleanPending(p);
  if (!backend || !clean) return false;
  try {
    backend.setItem(PENDING_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

function clearPending(backend) {
  try { backend?.removeItem(PENDING_KEY); } catch { /* 忽略 */ }
}

// ---------- 訊息與摘要 ----------
/** 429 的等待時間：不足 1 分鐘顯示秒數，否則「約 N 分鐘」（無條件進位，修訂 2 G）。 */
export function waitText(sec) {
  if (!Number.isInteger(sec) || sec <= 0) return null;
  return sec < 60 ? `${sec} 秒` : `約 ${Math.ceil(sec / 60)} 分鐘`;
}

/** API 失敗結果 → 給玩家看的訊息。 */
export function cloudErrorMessage(r) {
  if (r?.status === 401) return MSG.relink;
  if (r?.status === 503 && r?.error === 'capacity') return MSG.capacity;
  if (r?.status === 413) return MSG.tooLarge;
  const wait = r?.status === 429 ? waitText(r.retryAfter) : null;
  // 「請等 37 秒後再試」／「請等約 2 分鐘後再試」
  if (wait) return `雲端暫時無法使用，請等${wait.startsWith('約') ? '' : ' '}${wait}後再試`;
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
 * - configured：是否有 API 位址（修訂 2 G：空字串＝雲端存檔尚未開放）。
 * - random：{ token(), code() } 秘密產生器（測試用；預設 crypto.getRandomValues）。
 * - hash：字串 → SHA-256 hex（預設 crypto.subtle）。
 * - now：毫秒時間（測試用）。
 */
// ---------- 回報通關的待送紀錄（修訂 4b 第 5 節） ----------
function cleanClearRecord(r, chapter) {
  if (!isObj(r) || r.chapter !== chapter || !CHAPTER_RE.test(chapter)) return null;
  return {
    chapter,
    ending: typeof r.ending === 'string' && CHAPTER_RE.test(r.ending) ? r.ending : null,
    play_seconds: clampInt(r.play_seconds, 0, MAX_PLAYER_SECONDS),
    collapse: clampInt(r.collapse, 0, 100),
  };
}
function readClearQueue(backend) {
  try {
    const raw = JSON.parse(backend?.getItem(CLEAR_QUEUE_KEY) ?? 'null');
    if (!isObj(raw) || !isObj(raw.records)) return null;
    const records = {};
    for (const [k, v] of Object.entries(raw.records)) {
      const r = cleanClearRecord(v, k);
      if (r) records[k] = r;
    }
    return { player_id: isStr(raw.player_id) ? raw.player_id : null, records };
  } catch {
    return null;
  }
}
function writeClearQueue(backend, q) {
  try {
    if (!q || Object.keys(q.records).length === 0) backend?.removeItem(CLEAR_QUEUE_KEY);
    else backend?.setItem(CLEAR_QUEUE_KEY, JSON.stringify(q));
  } catch { /* 忽略：存不下就只是少補送一次 */ }
}

export function createCloudSync({
  backend, saveStore, getData = () => null, api, now = () => Date.now(), configured = () => true,
  random = { token: () => randomToken(), code: () => randomTransferCode() }, hash = sha256Hex,
} = {}) {
  let lastError = null;
  let lastOk = null;
  const nowSec = () => Math.floor(now() / 1000);
  const isOpen = () => {
    try { return configured() !== false; } catch { return false; }
  };
  const info = () => (isOpen() ? readCloudInfo(backend) : null);
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
      writeClearQueue(backend, null);
      return { ok: false, kind: 'unauthorized', relink: true, message: MSG.relink, status: 401 };
    }
    return { ok: false, kind: r?.kind ?? 'network', status: r?.status ?? 0, retryAfter: r?.retryAfter ?? null, message: cloudErrorMessage(r) };
  }
  const local = (op, kind, message, extra = {}) => {
    lastError = { op, kind, status: 0, error: kind, at: nowSec() };
    return { ok: false, kind, message, ...extra };
  };
  const succeeded = (op, r) => {
    lastOk = { op, at: nowSec() };
    return r;
  };
  const requireEnabled = (op) => {
    if (!isOpen()) return local(op, 'not_open', MSG.notOpen);
    return info() ? null : local(op, 'disabled', MSG.disabled);
  };
  /** 伺服器有明確回應而且一定沒有套用（4xx，401 另外處理）；逾時、網路、5xx 都可能已經套用。 */
  const definitelyRejected = (r) => r?.kind === 'http' && r.status >= 400 && r.status < 500;

  // ---------- 秘密：待確認 → 轉正 ----------
  /** 用指定權杖列表：'ok'（權杖有效）｜'no'（401）｜'unknown'（網路、逾時、5xx…）。 */
  async function checkToken(token) {
    const r = await api.listSaves({ token });
    if (r?.ok) return { state: 'ok', r };
    if (r?.status === 401) return { state: 'no', r };
    return { state: 'unknown', r };
  }
  /** 待確認的秘密轉正成雲端資訊（換掉整份，版本紀錄清空），並清掉待確認區。 */
  function promote({ player_id: pid, token, transfer_code: code }) {
    const okWrite = writeCloudInfo(backend, { player_id: cleanPlayerId(pid), token, transfer_code: code, slots: {}, auto_upload: false });
    if (okWrite) clearPending(backend);
    return okWrite;
  }
  const secretsOf = (p) => (p.op === 'enable'
    ? { token: p.token, transfer_code: p.transfer_code }
    : { token: p.new_token, transfer_code: p.new_transfer_code });

  // ---------- 槽的版本紀錄 ----------
  const slotEntry = (slot) => info()?.slots?.[String(slot)] ?? null;
  const setSlots = (fn) => update((cur) => ({ ...cur, slots: fn({ ...cur.slots }) }));
  /** 記下雲端版本（並清掉 pending_sha256）。 */
  const rememberSlot = (slot, version, updatedAt) => setSlots((slots) => {
    if (isVersion(version)) slots[String(slot)] = { version, updated_at: isTime(updatedAt) ? updatedAt : null };
    else delete slots[String(slot)];
    return slots;
  });
  const markPending = (slot, sha) => setSlots((slots) => {
    const e = slots[String(slot)] ?? { version: null, updated_at: null };
    slots[String(slot)] = { ...e, pending_sha256: sha };
    return slots;
  });
  const clearSlotPending = (slot) => setSlots((slots) => {
    const e = slots[String(slot)];
    if (e) {
      const { pending_sha256: _drop, ...rest } = e;
      if (isVersion(rest.version)) slots[String(slot)] = rest;
      else delete slots[String(slot)];
    }
    return slots;
  });
  const forgetVersion = (slot) => setSlots((slots) => {
    const e = slots[String(slot)];
    if (e?.pending_sha256) slots[String(slot)] = { version: null, updated_at: null, pending_sha256: e.pending_sha256 };
    else delete slots[String(slot)];
    return slots;
  });

  /**
   * 本機槽：deserialize＋sanitizeLoadedState（修訂 2 B：語意壞掉的本機存檔不可上傳）。
   * 回傳 { ok:true, state }（sanitize 後）或 { ok:false, kind:'local_empty'|'local_broken'|'local_invalid', message, reason }。
   */
  function checkLocal(slot) {
    let r;
    try {
      r = saveStore?.load(slot);
    } catch {
      r = { ok: false, code: 'storage_error', reason: '無法讀取儲存空間' };
    }
    if (!r?.ok) {
      if (r?.code === 'empty' || r?.code === 'unavailable') return { ok: false, kind: 'local_empty', message: MSG.localEmpty, reason: null };
      return { ok: false, kind: 'local_broken', message: MSG.localBroken, reason: r?.reason ?? '存檔無法讀取' };
    }
    let s;
    try {
      s = sanitizeLoadedState(r.state, getData?.());
    } catch (e) {
      s = { ok: false, reason: `存檔檢查失敗：${e?.message ?? e}` };
    }
    if (!s?.ok) {
      const reason = typeof s?.reason === 'string' && s.reason !== '' ? s.reason : '存檔檢查失敗';
      return { ok: false, kind: 'local_invalid', message: `${MSG.localInvalid}（${reason}）`, reason };
    }
    const data = serialize(s.state);
    const bytes = utf8Bytes(data);
    if (bytes > MAX_SAVE_BYTES) {
      const reason = `存檔大小 ${(bytes / 1024).toFixed(1)} KB，超過雲端上限 16 KB`;
      return { ok: false, kind: 'local_too_large', message: `${MSG.tooLarge}（${reason}）`, reason };
    }
    return { ok: true, state: s.state, data };
  }

  /** 本機槽的摘要（給雲端選單與衝突比較）；uploadable＝可以上傳，不行時 reason 說明原因。 */
  function localSummary(slot) {
    const c = checkLocal(slot);
    const savedAt = info()?.local_saved_at?.[String(slot)] ?? null;
    if (!c.ok) {
      if (c.kind === 'local_empty') return { slot, empty: true, broken: false, uploadable: false, reason: null, updated_at: null };
      return { slot, empty: false, broken: true, uploadable: false, reason: c.reason, updated_at: null };
    }
    return { slot, empty: false, broken: false, uploadable: true, ...summarizeState(c.state), updated_at: savedAt };
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

  /** 伺服器列表的一格 → { slot, empty, version, updated_at, sha, summary }。 */
  function cloudSlot(list, slot) {
    const s = Array.isArray(list) ? list.find((x) => isObj(x) && x.slot === slot) : null;
    if (!s || s.empty === true || !isVersion(s.version)) return { slot, empty: true };
    return {
      slot, empty: false, version: s.version, updated_at: isTime(s.updated_at) ? s.updated_at : null,
      sha: isSha(s.data_sha256) ? s.data_sha256 : null, summary: cleanSummary(s.summary),
    };
  }

  // ---------- 重新產生轉移碼 ----------
  async function rotate() {
    const off = requireEnabled('rotate');
    if (off) return off;
    let code = info().pending_transfer_code;
    if (!code) {
      code = formatTransferCode(random.code());
      // 送出前先記下新碼：逾時或重新整理後用同一個碼重送
      if (!code || !update((cur) => ({ ...cur, pending_transfer_code: code }))) return local('rotate', 'storage', MSG.storageBlocked);
    }
    const r = await api.rotateTransfer(code);
    if (r.ok) {
      update((cur) => ({ ...cur, transfer_code: code, pending_transfer_code: null }));
      return succeeded('rotate', { ok: true, transferCode: code });
    }
    if (r.status === 401) return failed('rotate', r);
    if (r.kind === 'http' && (r.status === 400 || r.status === 409)) {
      // 修訂 4 第 3 節：只有 400（格式）與 409（碰撞）確定新碼沒生效 → 丟掉，舊碼照舊有效。
      update((cur) => ({ ...cur, pending_transfer_code: null }));
      return failed('rotate', r);
    }
    // 429、5xx、逾時、網路錯誤：上一次的請求可能已經生效，保留待確認的新碼，之後用同一個碼重送
    return { ...failed('rotate', r), pendingCode: code };
  }

  /**
   * 待確認區的建立／轉移是否已經生效（用待確認的權杖列表）。
   * 回傳 'ok'（已轉正）｜'no'（沒生效）｜'unknown'（確認不了）｜'none'（沒有待確認）。
   * drop：沒生效時是否丟掉（只丟超過 PENDING_MAX_AGE_S 的，避免還在路上的請求晚到）。
   */
  async function settlePending({ drop = false } = {}) {
    const p = readPending(backend);
    if (!p) return { state: 'none' };
    if (p.op === 'enable' && info()) { clearPending(backend); return { state: 'none' }; }
    const sec = secretsOf(p);
    const c = await checkToken(sec.token);
    if (c.state === 'ok') {
      if (!promote({ player_id: null, ...sec })) return { state: 'unknown', p, r: c.r };
      return { state: 'ok', p };
    }
    if (c.state === 'no' && drop && nowSec() - p.at > PENDING_MAX_AGE_S) clearPending(backend);
    return { state: c.state, p, r: c.r };
  }

  // ---------- 回報通關的待送紀錄（修訂 4b 第 5 節） ----------
  const queueFor = () => {
    const q = readClearQueue(backend);
    const pid = info()?.player_id ?? null;
    // 換了帳號（兩邊的 player_id 都知道而且不同）→ 舊帳號的紀錄作廢
    if (q && q.player_id && pid && q.player_id !== pid) { writeClearQueue(backend, null); return null; }
    return q;
  };
  function enqueueClear(rec) {
    const q = queueFor() ?? { player_id: info()?.player_id ?? null, records: {} };
    writeClearQueue(backend, { ...q, records: { ...q.records, [rec.chapter]: rec } });
  }
  function dequeueClear(chapter) {
    const q = queueFor();
    if (!q?.records[chapter]) return;
    const { [chapter]: _drop, ...rest } = q.records;
    writeClearQueue(backend, { ...q, records: rest });
  }
  /** 待送紀錄各補送一次：成功或伺服器明確拒絕（400）→ 刪除；429 → 這次停止、保留；401 → 全部清掉。 */
  async function flushClears() {
    if (!info()) return;
    const q = queueFor();
    if (!q) return;
    for (const rec of Object.values(q.records)) {
      const r = await api.reportClear(rec);
      if (r?.ok || (definitelyRejected(r) && r.status !== 429 && r.status !== 401)) { dequeueClear(rec.chapter); continue; }
      if (r?.status === 401) { failed('clear', r); return; }
      if (r?.status === 429) return;
    }
  }

  return {
    configured: isOpen,
    enabled: () => info() !== null,

    /** 唯讀狀態（不含權杖）。 */
    status() {
      const i = info();
      const p = isOpen() ? readPending(backend) : null;
      return {
        configured: isOpen(),
        enabled: i !== null,
        playerId: i?.player_id ?? null,
        transferCode: i?.transfer_code ?? null,
        pendingTransferCode: i?.pending_transfer_code ?? null,
        pendingOp: p?.op ?? null,
        autoUpload: i?.auto_upload ?? false,
        slots: i ? structuredCloneSafe(i.slots) : {},
        localSavedAt: i ? { ...i.local_saved_at } : {},
        lastError: lastError ? { ...lastError } : null,
        lastOk: lastOk ? { ...lastOk } : null,
      };
    },

    transferCode: () => info()?.transfer_code ?? null,
    pendingTransferCode: () => info()?.pending_transfer_code ?? null,
    autoUpload: () => info()?.auto_upload === true,
    localSummary,

    /** 第一次啟用：用客戶端產生的權杖與轉移碼建立匿名玩家。已啟用時直接成功。 */
    async enable() {
      if (!isOpen()) return local('enable', 'not_open', MSG.notOpen);
      const cur = info();
      if (cur) return { ok: true, transferCode: cur.transfer_code };
      if (!backend) return local('enable', 'storage', MSG.storageBlocked);
      let p = readPending(backend);
      if (p?.op === 'transfer') {
        // 先前的轉移還沒確認：已生效就直接用那個帳號；確認不了就先不要蓋掉它
        const st = await settlePending();
        if (st.state === 'ok') return succeeded('enable', { ok: true, transferCode: info()?.transfer_code ?? null });
        if (st.state === 'unknown') return failed('enable', st.r);
        // 修訂 4 第 4 節：還沒生效但很新（請求可能還在路上，晚到就會作廢舊權杖）→ 不可覆蓋
        if (nowSec() - p.at <= PENDING_MAX_AGE_S) return local('enable', 'pending_transfer', MSG.pendingTransfer);
        p = null;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!p || p.op !== 'enable') {
          p = { op: 'enable', token: random.token(), transfer_code: formatTransferCode(random.code()), at: nowSec() };
          // 送出前先存：逾時或重新整理也不會遺失
          if (!writePending(backend, p)) return local('enable', 'storage', MSG.storageBlocked);
        }
        const r = await api.createPlayer({ token: p.token, transfer_code: p.transfer_code });
        if (r.ok) {
          const pid = r.body?.player_id;
          if (!isStr(pid)) return local('enable', 'bad_response', MSG.unavailable);
          if (!promote({ player_id: pid, token: p.token, transfer_code: p.transfer_code })) return local('enable', 'storage', MSG.storageBlocked);
          return succeeded('enable', { ok: true, transferCode: p.transfer_code });
        }
        if (r.status === 409) { p = null; continue; } // 轉移碼雜湊碰撞：換一組重送
        return failed('enable', r);
      }
      return local('enable', 'conflict', MSG.unavailable);
    },

    /**
     * 用轉移碼接續：new_token／new_transfer_code 由客戶端產生，送出前寫進待確認區。
     * 沒拿到成功回應時用 new_token 列表：200＝其實已成功；401＝沒成功（保留待確認區，重試沿用同一組）。
     */
    async connect(input) {
      if (!isOpen()) return local('connect', 'not_open', MSG.notOpen);
      const code = formatTransferCode(input);
      if (!code) return local('connect', 'not_found', MSG.badCode);
      if (!backend) return local('connect', 'storage', MSG.storageBlocked);
      let p = readPending(backend);
      if (p?.op === 'transfer') {
        const st = await settlePending();
        if (st.state === 'ok') return succeeded('connect', { ok: true, transferCode: st.p.new_transfer_code });
        if (st.state === 'unknown') return failed('connect', st.r);
        p = { ...p, code, at: nowSec() }; // 沒生效：沿用同一組秘密重試
      } else {
        p = { op: 'transfer', code, new_token: random.token(), new_transfer_code: formatTransferCode(random.code()), at: nowSec() };
      }
      if (!writePending(backend, p)) return local('connect', 'storage', MSG.storageBlocked);
      let r = await api.transfer({ code, new_token: p.new_token, new_transfer_code: p.new_transfer_code });
      if (r.status === 409 && (await checkToken(p.new_token)).state === 'no') {
        // 新秘密與既有的碰撞（伺服器沒有套用）：換一組新秘密重送一次
        p = { op: 'transfer', code, new_token: random.token(), new_transfer_code: formatTransferCode(random.code()), at: nowSec() };
        if (!writePending(backend, p)) return local('connect', 'storage', MSG.storageBlocked);
        r = await api.transfer({ code, new_token: p.new_token, new_transfer_code: p.new_transfer_code });
      }
      if (r.ok) {
        if (!promote({ player_id: r.body?.player_id, token: p.new_token, transfer_code: p.new_transfer_code })) {
          return local('connect', 'storage', MSG.storageBlocked);
        }
        return succeeded('connect', { ok: true, transferCode: p.new_transfer_code });
      }
      if (r.status === 429) {
        // 限流：伺服器確定沒處理（修訂 4b 第 4 節）→ 清除待確認區，不擋接下來的「啟用雲端存檔」
        clearPending(backend);
        return failed('connect', r);
      }
      const c = await checkToken(p.new_token);
      if (c.state === 'ok') {
        if (!promote({ player_id: null, token: p.new_token, transfer_code: p.new_transfer_code })) return local('connect', 'storage', MSG.storageBlocked);
        return succeeded('connect', { ok: true, transferCode: p.new_transfer_code });
      }
      const wrongCode = r.status === 404 || r.status === 400 || r.status === 401;
      if (c.state === 'no' && definitelyRejected(r)) {
        clearPending(backend); // 伺服器明確拒絕、新權杖也沒生效：這組秘密作廢
        return wrongCode ? local('connect', 'not_found', MSG.badCode) : failed('connect', { ...r, status: r.status === 401 ? 0 : r.status });
      }
      if (wrongCode) return local('connect', 'not_found', MSG.badCode);
      return failed('connect', r);
    },

    /** 重新整理後（或開機時）處理待確認的秘密：轉移／建立確認是否生效；新轉移碼用同一個碼重送。 */
    async recover() {
      if (!isOpen() || !backend) return { recovered: null };
      let recovered = null;
      const st = await settlePending({ drop: true });
      if (st.state === 'ok') recovered = st.p.op;
      if (info()?.pending_transfer_code) {
        const r = await rotate();
        if (r.ok) recovered = recovered ?? 'rotate';
      }
      await flushClears(); // 修訂 4b 第 5 節：上次沒送到的通關紀錄補送一次
      return { recovered };
    },

    rotate,

    /** 停用此裝置的雲端：只清本機資訊。 */
    disable() {
      lastError = null;
      writeClearQueue(backend, null);
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
        const c = cloudSlot(list, slot);
        // 先前逾時的上傳其實已經寫入（雜湊相符）：順便記下版本
        const pend = slotEntry(slot)?.pending_sha256;
        if (!c.empty && pend && c.sha === pend) rememberSlot(slot, c.version, c.updated_at);
        slots.push(c.empty ? { slot, empty: true } : { slot, empty: false, version: c.version, updated_at: c.updated_at, summary: c.summary });
      }
      return succeeded('list', { ok: true, slots });
    },

    /**
     * 上傳本機槽到同號的雲端槽。
     * - 一般：依本機記住的雲端版本帶 If-Match；沒有記住時 If-None-Match: *。
     * - force（衝突時選「用本機的」）：以衝突當下的雲端版本 cloudVersion 為 If-Match（null＝雲端是空的）。
     * - 修訂 2 B：先前的上傳沒拿到結果（pending_sha256）→ 先列表，雜湊相符就採用雲端版本；
     *   409 的 current.data_sha256 等於這次內容 → 視為已上傳。
     * 回傳 { ok:true, version } | { ok:false, kind:'conflict', slot, conflict } | { ok:false, kind, message, relink? }。
     */
    async upload(slot, { force = false, cloudVersion = null } = {}) {
      const off = requireEnabled('upload');
      if (off) return off;
      if (!validSlot(slot)) return local('upload', 'invalid_slot', MSG.unavailable);
      const chk = checkLocal(slot);
      if (!chk.ok) return local('upload', chk.kind, chk.message, { reason: chk.reason });
      const { data } = chk;
      let sha = null;
      try { sha = await hash(data); } catch { sha = null; }
      if (!isSha(sha)) sha = null;

      const entry = slotEntry(slot);
      const prevPending = entry?.pending_sha256 ?? null;
      let version = force ? (isVersion(cloudVersion) ? cloudVersion : null) : (entry?.version ?? null);
      const done = (v, at) => {
        rememberSlot(slot, v, at);
        return succeeded('upload', { ok: true, version: v, updated_at: at });
      };

      if (!force && prevPending) {
        // 上一次上傳沒拿到結果：先刷新列表，確認它是否已經寫入
        const l = await api.listSaves();
        if (!l.ok && l.status === 401) return failed('upload', l);
        if (l.ok) {
          const c = cloudSlot(l.body?.slots, slot);
          if (!c.empty && c.sha && (c.sha === prevPending || c.sha === sha)) {
            if (c.sha === sha) return done(c.version, c.updated_at); // 雲端已經是這份內容
            rememberSlot(slot, c.version, c.updated_at);
            version = c.version;
          }
        }
      }

      let retried = false;
      for (;;) {
        if (sha) markPending(slot, sha);
        let res = await api.putSave(slot, data, { version });
        if (!res.ok && res.status === 404 && version !== null) {
          // 雲端槽已經被刪掉：記住的版本沒有意義了，改成「只在空槽時建立」再試一次
          forgetVersion(slot);
          version = null;
          res = await api.putSave(slot, data, { version });
        }
        if (res.ok) {
          const newVersion = isVersion(res.body?.version) ? res.body.version : parseEtag(res.etag);
          const updatedAt = isTime(res.body?.updated_at) ? res.body.updated_at : nowSec();
          if (isVersion(newVersion)) return done(newVersion, updatedAt);
          clearSlotPending(slot);
          return succeeded('upload', { ok: true, version: null, updated_at: updatedAt });
        }
        if (res.status === 409) {
          const cur = isObj(res.body?.current) ? res.body.current : null;
          const curVersion = cur && isVersion(cur.version) ? cur.version : null;
          const curSha = cur && isSha(cur.data_sha256) ? cur.data_sha256 : null;
          if (curVersion !== null && sha && curSha === sha) {
            return done(curVersion, isTime(cur.updated_at) ? cur.updated_at : null); // 內容相同：其實已上傳
          }
          if (!force && !retried && curVersion !== null && prevPending && curSha === prevPending) {
            // 雲端是先前逾時那次上傳的內容（本機自己寫的）：採用它的版本再送一次
            retried = true;
            rememberSlot(slot, curVersion, cur.updated_at);
            version = curVersion;
            continue;
          }
          clearSlotPending(slot);
          const cloud = curVersion !== null
            ? { empty: false, version: curVersion, updated_at: isTime(cur.updated_at) ? cur.updated_at : null, ...cleanSummary(cur.summary) }
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
        // 伺服器明確拒絕 → 這次一定沒寫入；逾時、網路、5xx → 保留 pending_sha256，下次先確認
        if (definitelyRejected(res)) clearSlotPending(slot);
        return failed('upload', res);
      }
    },

    /** 只下載並驗證（「直接讀取」用），不寫入本機。 */
    fetchCloud,

    /** 下載雲端槽到本機槽（預設同號）：驗證通過才寫入；同號時記下版本。 */
    async download(cloudSlot_, localSlot = cloudSlot_) {
      if (!validSlot(localSlot)) return local('download', 'invalid_slot', MSG.unavailable);
      const r = await fetchCloud(cloudSlot_);
      if (!r.ok) return r;
      let w;
      try {
        w = saveStore.save(localSlot, r.state);
      } catch {
        w = { ok: false };
      }
      if (!w?.ok) return local('download', 'local_write', MSG.localWrite);
      if (localSlot === cloudSlot_ && r.version !== null) rememberSlot(localSlot, r.version, r.updated_at);
      return r;
    },

    /** 回報章節完成（失敗由呼叫端只記 console）。 */
    async reportClear({ chapter, ending = null, play_seconds: sec = 0, collapse = 0 } = {}) {
      const off = requireEnabled('clear');
      if (off) return off;
      if (typeof chapter !== 'string' || !CHAPTER_RE.test(chapter)) return local('clear', 'bad_chapter', '章節編號不合法');
      const rec = cleanClearRecord({ chapter, ending, play_seconds: sec, collapse }, chapter);
      const r = await api.reportClear(rec);
      if (!r.ok) {
        const out = failed('clear', r);
        if (r.status === 401) return out;
        if (definitelyRejected(r) && r.status !== 429) { dequeueClear(chapter); return out; }
        // 修訂 4b 第 5 節：429、逾時、網路、5xx → 記在本機（各章只留最新一筆），之後補送
        enqueueClear(rec);
        return { ...out, queued: true };
      }
      dequeueClear(chapter);
      await flushClears();
      return succeeded('clear', { ok: true, body: r.body });
    },
  };
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o ?? {}));
}
