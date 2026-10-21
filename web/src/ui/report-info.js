// 意見回饋的「複製回報資訊」：把遊戲版本、時間、裝置、目前進度與存檔內容整理成一段純文字，給玩家貼到討論區。
// 純邏輯（不碰 Phaser／DOM；localStorage 與剪貼簿都由呼叫端傳入），node 可測。
//
// 安全：雲端權杖、轉移碼、player_id 等等同密碼的資料**絕不能**出現在回報裡。
// - buildReportInfo 只讀傳入的 state、data 與 env 列出的欄位，從不讀 localStorage；雲端只輸出「已啟用／未啟用」。
// - 另外由 collectCloudSecrets 收集本機雲端資訊裡的秘密，輸出前逐一遮蔽（萬一秘密混進存檔或名字，也不會外流）。
import { serialize, CURRENT_VERSION, KEY_PREFIX, SLOT_COUNT } from '../core/save.js';
import { partyStatus } from '../core/stats.js';
import { CLOUD_KEY, PENDING_KEY, CLEAR_QUEUE_KEY } from '../cloud/sync.js';
import { rankHud, resonanceHud } from './hud.js';

/** 存檔區塊的分隔線：tools/load-report.mjs 以它找出存檔字串（兩邊必須一致）。 */
export const REPORT_SAVE_MARKER = '---- 存檔內容（請勿修改）----';
/** 最近一次手動讀取或存檔的槽位（標題畫面的回報附上這一格）。 */
export const LAST_SLOT_KEY = 'steel-labyrinth:report-last-slot';
const MASK = '［已遮蔽］';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validSlot = (n) => Number.isInteger(n) && n >= 1 && n <= SLOT_COUNT;

/** 秒數 → hh:mm:ss（同 session.js 的 formatPlaytime；session.js 依賴 Phaser，node 測試不能匯入）。 */
function hms(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

const major = (ua, re) => {
  const m = ua.match(re);
  return m ? m[1] : null;
};

/** userAgent → 「作業系統／瀏覽器 主版本」（例如「Android 14／Chrome 129」）。不認得的部分寫「未知…」。 */
export function describeDevice(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  let os = '未知作業系統';
  const ios = ua.match(/(?:iPhone|iPad|iPod)[^)]*? OS (\d+)(?:_(\d+))?/);
  const android = ua.match(/Android (\d+(?:\.\d+)?)/);
  if (ios) os = `iOS ${ios[1]}.${ios[2] ?? '0'}`;
  else if (android) os = `Android ${android[1]}`;
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  // 順序有意義：Edge、Samsung、Opera、LINE 的 UA 也含 Chrome／Safari 字樣
  const browsers = [
    ['LINE 內建瀏覽器', /\bLine\/(\d+)/],
    ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
    ['Samsung Internet', /SamsungBrowser\/(\d+)/],
    ['Opera', /\bOPR\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:CriOS|Chrome)\/(\d+)/],
    ['Safari', /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//],
  ];
  let browser = '未知瀏覽器';
  for (const [name, re] of browsers) {
    const v = major(ua, re);
    if (v) { browser = `${name} ${v}`; break; }
  }
  return `${os}／${browser}`;
}

function isoTime(now) {
  try {
    const d = now instanceof Date ? now : new Date(now);
    return Number.isNaN(d.getTime()) ? '未知' : d.toISOString();
  } catch {
    return '未知';
  }
}

function screenText(screen) {
  const w = Number(screen?.width);
  const h = Number(screen?.height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? `${Math.round(w)}×${Math.round(h)}` : '未知';
}

const findById = (list, id) => (Array.isArray(list) ? list.find((x) => isObj(x) && x.id === id) : undefined);
const label = (name, id) => `${typeof name === 'string' && name !== '' ? name : String(id ?? '—')}（${String(id ?? '—')}）`;

/** 遊戲中的進度各行；任何一項算不出來都以「—」代替，不丟錯。 */
function progressLines(state, data, cloudEnabled) {
  const safe = (fn, fallback = '—') => {
    try { return fn(); } catch { return fallback; }
  };
  const loc = isObj(state.location) ? state.location : {};
  const chapter = safe(() => label(findById(data?.story, state.chapter)?.title, state.chapter));
  const map = safe(() => label(findById(data?.maps, loc.map)?.name, loc.map));
  const pos = `(${String(loc.x ?? '—')}, ${String(loc.y ?? '—')})`;
  const rank = safe(() => (state.lineage ? rankHud(state, data)?.text ?? String(state.lineage.id) : '尚未取得'));
  const reso = safe(() => resonanceHud(state.resonance).value);
  const party = safe(() => partyStatus(state, data).map((m) => `${m.name} ${m.hp}/${m.max.hp}`).join('　'));
  return [
    `章節：${chapter}　地圖：${map}　位置：${pos}`,
    `譜系：${rank} 共鳴 ${reso}　崩解 ${String(state.collapse ?? '—')}　殘響 ${String(state.echo?.charges ?? '—')}　遊戲時間 ${hms(state.playtime_s)}`,
    `隊伍：${party}`,
    `雲端存檔：${cloudEnabled ? '已啟用' : '未啟用'}（不含任何權杖或轉移碼）`,
  ];
}

/** 把秘密（含轉移碼不帶連字號的寫法）換成「［已遮蔽］」。 */
function maskSecrets(text, secrets) {
  const list = new Set();
  for (const s of Array.isArray(secrets) ? secrets : []) {
    if (typeof s !== 'string' || s.length < 8) continue;
    list.add(s);
    if (s.includes('-')) list.add(s.replace(/-/g, ''));
  }
  let out = text;
  // 長的先換，避免短的先換掉一半
  for (const s of [...list].sort((a, b) => b.length - a.length)) out = out.split(s).join(MASK);
  return out;
}

/**
 * 回報資訊（純文字）。
 * env：{ version, now, userAgent, screen:{ width, height }, cloudEnabled, lastSave:{ slot, raw, why:'last'|'only' }|null, secrets:[] }。
 * state 為 null（標題畫面）時只輸出版本、時間、裝置與「目前不在遊戲中」，有 lastSave 時附上它的原始內容。
 */
export function buildReportInfo({ state = null, data = null, env = {} } = {}) {
  const e = isObj(env) ? env : {};
  const version = typeof e.version === 'string' && e.version.trim() !== '' ? e.version.trim() : '未知';
  const lines = [
    '【鋼鐵迷都 回報資訊】',
    `遊戲版本：${version}（存檔格式 v${CURRENT_VERSION}）`,
    `時間：${isoTime(e.now)}`,
    `裝置：${describeDevice(e.userAgent)}；畫面 ${screenText(e.screen)}`,
  ];
  if (isObj(state)) {
    lines.push(...progressLines(state, data, e.cloudEnabled === true));
    let save;
    try { save = serialize(state); } catch (err) { save = `（無法輸出存檔：${err?.message ?? err}）`; }
    lines.push(REPORT_SAVE_MARKER, save);
  } else {
    lines.push('目前不在遊戲中');
    const last = e.lastSave;
    if (isObj(last) && validSlot(last.slot) && typeof last.raw === 'string') {
      lines.push(`附上的存檔：存檔 ${last.slot}（${last.why === 'only' ? '唯一的存檔' : '最近一次讀取或存檔的槽位'}）`, REPORT_SAVE_MARKER, last.raw);
    } else {
      lines.push('沒有附上存檔（找不到最近一次讀取或存檔的槽位）');
    }
  }
  return maskSecrets(lines.join('\n'), e.secrets);
}

/** 欄位名稱像秘密的（權杖、轉移碼、通行證、player_id）：值要遮蔽。 */
const SECRET_FIELD = /token|code|pass|secret|player_id/i;

/**
 * 從本機的雲端資訊、待確認區、通關待送紀錄收集秘密（字串值）。讀不到、壞掉都回空陣列。
 * 只收「欄位名稱像秘密」的值，避免把 'enable' 之類的普通字也遮掉。
 */
export function collectCloudSecrets(backend) {
  const out = [];
  const walk = (v, secretField) => {
    if (typeof v === 'string' || typeof v === 'number') {
      if (secretField) out.push(String(v));
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, secretField)); return; }
    if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, secretField || SECRET_FIELD.test(k));
  };
  for (const key of [CLOUD_KEY, PENDING_KEY, CLEAR_QUEUE_KEY]) {
    try {
      const raw = backend?.getItem(key);
      if (typeof raw === 'string') walk(JSON.parse(raw), false);
    } catch { /* 讀不到或壞掉：沒有可收集的 */ }
  }
  return [...new Set(out)];
}

/** 記住最近一次手動讀取或存檔的槽位；成功回 true。 */
export function rememberLastSlot(backend, slot) {
  if (!validSlot(slot) || !backend) return false;
  try {
    backend.setItem(LAST_SLOT_KEY, String(slot));
    return true;
  } catch {
    return false;
  }
}

/**
 * 標題畫面的回報要附哪一格：最近一次讀取或存檔的槽位（還有內容時）；沒有紀錄時，只有一格存檔就用那格。
 * 回傳 { slot, raw（原始字串，不經解析）, why:'last'|'only' } 或 null。
 */
export function readLastSave(backend) {
  try {
    if (!backend) return null;
    const rawOf = (slot) => {
      const v = backend.getItem(`${KEY_PREFIX}${slot}`);
      return typeof v === 'string' ? v : null;
    };
    const last = Number(backend.getItem(LAST_SLOT_KEY));
    if (validSlot(last) && rawOf(last) !== null) return { slot: last, raw: rawOf(last), why: 'last' };
    const filled = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot++) if (rawOf(slot) !== null) filled.push(slot);
    return filled.length === 1 ? { slot: filled[0], raw: rawOf(filled[0]), why: 'only' } : null;
  } catch {
    return null;
  }
}

/**
 * 複製到剪貼簿：成功回 true；權限被拒、不支援、丟錯都回 false。
 * writeText 在呼叫當下（使用者輸入事件的同步處理中）就送出，之後才等結果。
 */
export async function copyText(text, nav = globalThis.navigator) {
  try {
    if (typeof nav?.clipboard?.writeText !== 'function') return false;
    await nav.clipboard.writeText(String(text));
    return true;
  } catch {
    return false;
  }
}
