// 聲音設定（純函式，node 可測）：解析容錯、序列化、localStorage 存取（一律 try/catch）、音量換算、設定畫面的調整動作。
// 音量分 5 段（0＝關、1～4），換算成 0、25%、50%、75%、100%。

export const AUDIO_SETTINGS_KEY = 'steel-labyrinth:settings:audio';
export const LEVEL_MAX = 4;
/** 有音量的通道（typing 沒有自己的音量：開啟時跟著音效音量）。 */
export const LEVEL_CHANNELS = Object.freeze(['bgm', 'amb', 'sfx']);
const TOGGLES = ['mute', 'typing'];

/** 預設值（使用者裁決 2026-11-06）：開聲音，音樂 50%、環境音 50%、音效 75%，對話打字音開。 */
export const AUDIO_DEFAULTS = Object.freeze({ v: 1, mute: false, bgm: 2, amb: 2, sfx: 3, typing: true });

function clampLevel(x, fallback) {
  let n = x;
  if (typeof n === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(n)) n = Number(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(LEVEL_MAX, Math.max(0, Math.round(n)));
}

/** 字串（localStorage 的值）或物件 → 合法的設定。壞資料、未知版本一律回預設值；超出範圍夾住。 */
export function parseAudioSettings(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch { return { ...AUDIO_DEFAULTS }; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return { ...AUDIO_DEFAULTS };
  const out = { v: 1 };
  for (const t of TOGGLES) out[t] = typeof o[t] === 'boolean' ? o[t] : AUDIO_DEFAULTS[t];
  for (const ch of LEVEL_CHANNELS) out[ch] = clampLevel(o[ch], AUDIO_DEFAULTS[ch]);
  return { v: 1, mute: out.mute, bgm: out.bgm, amb: out.amb, sfx: out.sfx, typing: out.typing };
}

export function serializeAudioSettings(s) {
  return JSON.stringify(parseAudioSettings({ ...s, v: 1 }));
}

/** backend：localStorage（瀏覽器封鎖時為 null）。讀不到就用預設值。 */
export function loadAudioSettings(backend) {
  if (!backend) return { ...AUDIO_DEFAULTS };
  try {
    return parseAudioSettings(backend.getItem(AUDIO_SETTINGS_KEY));
  } catch {
    return { ...AUDIO_DEFAULTS };
  }
}

/** 寫入成功回 true；儲存空間不能用時回 false（設定只留在記憶體）。 */
export function saveAudioSettings(backend, s) {
  if (!backend) return false;
  try {
    backend.setItem(AUDIO_SETTINGS_KEY, serializeAudioSettings(s));
    return true;
  } catch {
    return false;
  }
}

/** 音量段數 → 增益（0～1）。 */
export function levelGain(level) {
  return clampLevel(level, 0) / LEVEL_MAX;
}

/** 通道實際增益：靜音一律 0；typing 關閉時 0、開啟時跟音效音量。未知通道 0。 */
export function channelGain(channel, s) {
  if (!s || s.mute) return 0;
  if (channel === 'typing') return s.typing ? levelGain(s.sfx) : 0;
  if (!LEVEL_CHANNELS.includes(channel)) return 0;
  return levelGain(s[channel]);
}

/** 音量加減一格（夾在 0～4；wrap 時超過上限回到 0、低於 0 回到上限）。回新物件。 */
export function stepLevel(s, channel, delta, { wrap = false } = {}) {
  if (!LEVEL_CHANNELS.includes(channel)) return { ...s };
  let n = s[channel] + delta;
  if (wrap) n = ((n % (LEVEL_MAX + 1)) + LEVEL_MAX + 1) % (LEVEL_MAX + 1);
  return { ...s, [channel]: Math.min(LEVEL_MAX, Math.max(0, n)) };
}

/** 開關（mute／typing）反轉。回新物件。 */
export function toggleSetting(s, key) {
  if (!TOGGLES.includes(key)) return { ...s };
  return { ...s, [key]: !s[key] };
}
