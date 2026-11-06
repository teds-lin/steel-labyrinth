// 音檔轉檔配方（tools/audio-recipe.json）的純函式：驗證、ffmpeg 濾鏡與參數、峰值正規化、CREDITS.md 產生。
// 實際呼叫 ffmpeg 的部分在 tools/audio-encode.mjs。

/** 允許進 repo 的授權（只放已逐頁確認的；要加新授權先經使用者同意）。 */
export const ALLOWED_LICENSES = Object.freeze(['CC0 1.0']);

const OUT_RE = /^(sfx|amb|bgm)\/[a-z0-9_]+(\.v[0-9]+)?$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s|]+$/.test(u);
const isNonNeg = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

/** 回傳錯誤訊息陣列（空陣列＝合法）。 */
export function validateRecipe(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['配方不是物件'];
  if (r.version !== 1) errs.push('version 必須是 1');
  const sources = r.sources && typeof r.sources === 'object' ? r.sources : {};
  for (const [id, s] of Object.entries(sources)) {
    if (!/^[a-z0-9-]+$/.test(id)) errs.push(`來源 id「${id}」只能用小寫英數與連字號`);
    if (!ALLOWED_LICENSES.includes(s?.license)) errs.push(`來源 ${id}：授權「${s?.license}」不在允許清單`);
    if (!isHttps(s?.page)) errs.push(`來源 ${id}：page 必須是 https 網址`);
    if (!isHttps(s?.download)) errs.push(`來源 ${id}：download 必須是 https 網址`);
    if (typeof s?.author !== 'string' || !s.author.trim()) errs.push(`來源 ${id}：缺作者`);
    if (typeof s?.title !== 'string' || !s.title.trim()) errs.push(`來源 ${id}：缺素材名稱`);
    if (!SHA_RE.test(s?.sha256 ?? '')) errs.push(`來源 ${id}：sha256 必須是 64 位小寫十六進位`);
  }
  const seen = new Set();
  for (const [i, o] of (Array.isArray(r.outputs) ? r.outputs : []).entries()) {
    const at = `outputs[${i}]`;
    if (typeof o?.out !== 'string' || !OUT_RE.test(o.out)) errs.push(`${at}：out 必須是「sfx|amb|bgm/名稱」`);
    else if (seen.has(o.out)) errs.push(`${at}：out「${o.out}」重複`);
    else seen.add(o.out);
    if (!Object.hasOwn(sources, o?.source)) errs.push(`${at}：找不到來源「${o?.source}」`);
    const f = o?.file;
    if (typeof f !== 'string' || !f || f.startsWith('/') || f.split(/[\\/]/).includes('..')) errs.push(`${at}：file 必須是來源資料夾內的相對路徑`);
    if (typeof o?.use !== 'string' || !o.use.trim()) errs.push(`${at}：缺用途說明（use）`);
    for (const k of ['start', 'duration', 'fade_in', 'fade_out']) {
      if (o?.[k] !== undefined && !isNonNeg(o[k])) errs.push(`${at}：${k} 必須是非負數`);
    }
    if (o?.peak !== undefined && !(typeof o.peak === 'number' && o.peak <= 0 && o.peak >= -30)) errs.push(`${at}：peak 必須介於 −30～0 dBFS`);
    if (o?.trim !== undefined && typeof o.trim !== 'boolean') errs.push(`${at}：trim 必須是布林值`);
  }
  if (!Array.isArray(r.outputs)) errs.push('缺少 outputs 陣列');
  return errs;
}

const SILENCE = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.005';

/**
 * 短音效的濾鏡：轉單聲道 44.1 kHz → 去開頭靜音 →（淡入）→ 反轉 → 去結尾靜音 →（淡出）→ 反轉回來 →（增益）。
 * gainDb：峰值正規化的增益（第一輪量測後才知道），null 表示不加。
 */
export function sfxFilter(o, gainDb = null) {
  const trim = o.trim !== false;
  const parts = ['aformat=channel_layouts=mono', 'aresample=44100'];
  if (trim) parts.push(SILENCE);
  if (o.fade_in) parts.push(`afade=t=in:d=${o.fade_in}`);
  if (trim || o.fade_out) {
    parts.push('areverse');
    if (trim) parts.push(SILENCE);
    if (o.fade_out) parts.push(`afade=t=in:d=${o.fade_out}`);
    parts.push('areverse');
  }
  if (gainDb !== null && gainDb !== undefined) parts.push(`volume=${gainDb.toFixed(2)}dB`);
  return parts.join(',');
}

const CODEC = {
  ogg: ['-c:a', 'libvorbis', '-q:a', '2'],
  m4a: ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart'],
};

/** ffmpeg 參數：裁切（-ss／-t）、濾鏡、單聲道、清 metadata、可重現（bitexact）、編碼器。 */
export function encodeArgs({ input, start, duration, filter, out, format }) {
  if (!CODEC[format]) throw new Error(`不支援的格式：${format}`);
  const a = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
  if (start) a.push('-ss', String(start));
  if (duration) a.push('-t', String(duration));
  a.push('-i', input, '-af', filter, '-ac', '1', '-ar', '44100', '-map_metadata', '-1',
    '-fflags', '+bitexact', '-flags:a', '+bitexact', ...CODEC[format], out);
  return a;
}

/** 量測用參數：同樣的濾鏡加 volumedetect，輸出丟掉。 */
export function measureArgs({ input, start, duration, filter }) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'info'];
  if (start) a.push('-ss', String(start));
  if (duration) a.push('-t', String(duration));
  a.push('-i', input, '-af', `${filter},volumedetect`, '-f', 'null', '-');
  return a;
}

export function parseMaxVolume(log) {
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(String(log));
  return m ? Number(m[1]) : null;
}

/** 把峰值拉到 target dBFS 需要的增益。量不到峰值時不調整。 */
export function peakGainDb(maxVolume, target = -3) {
  if (maxVolume === null || maxVolume === undefined || !Number.isFinite(maxVolume)) return 0;
  return target - maxVolume;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '｜').replace(/\n/g, ' ');

/** CREDITS.md 全文（公開 repo 根目錄）。由配方產生，避免手寫漏列。 */
export function renderCredits(r) {
  const lines = [
    '# 音效素材來源（CREDITS）',
    '',
    '> 本檔由 `node tools/audio-encode.mjs --credits` 依 `tools/audio-recipe.json` 自動產生，請勿手改。',
    '> 授權頁面的存檔放在私有企劃 repo 的 `assets-licenses/`。',
    '',
    '《鋼鐵迷都》的音效都是第三方公開授權素材，經裁切、去頭尾靜音、峰值正規化，重新編碼成 Ogg Vorbis 與 AAC（m4a）兩種格式。',
    '鐘聲（入夢、醒來）是程式即時合成，沒有音檔。',
    '',
    '## 每個音檔',
    '',
    '| 檔案 | 用途 | 原始素材 | 作者 | 授權 | 來源網址 |',
    '|---|---|---|---|---|---|',
  ];
  for (const o of r.outputs ?? []) {
    const s = r.sources[o.source];
    lines.push(`| \`${o.out}.ogg\`、\`${o.out}.m4a\` | ${cell(o.use)} | ${cell(s.title)}（${cell(o.file)}） | ${cell(s.author)} | ${cell(s.license)} | ${s.page} |`);
  }
  lines.push('', '## 來源素材包', '', '| 來源 id | 素材 | 作者 | 授權 | 頁面 | 下載檔 | SHA-256 |', '|---|---|---|---|---|---|---|');
  for (const [id, s] of Object.entries(r.sources ?? {})) {
    lines.push(`| ${id} | ${cell(s.title)} | ${cell(s.author)} | ${cell(s.license)} | ${s.page} | ${s.download} | \`${s.sha256}\` |`);
  }
  lines.push('');
  return lines.join('\n');
}
