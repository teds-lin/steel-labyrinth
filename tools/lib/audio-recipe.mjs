// 音檔轉檔配方（tools/audio-recipe.json）的純函式：驗證、ffmpeg 濾鏡與參數、峰值正規化、CREDITS.md 產生。
// 實際呼叫 ffmpeg 的部分在 tools/audio-encode.mjs。

/** 允許進 repo 的授權（只放已逐頁確認的；要加新授權先經使用者同意）。 */
export const ALLOWED_LICENSES = Object.freeze(['CC0 1.0']);
/** 音色庫（MIDI 渲染用）允許的授權。MIT 已經使用者同意（M6 裁決 1：FluidR3_GM）；授權全文必須附在 CREDITS。 */
export const ALLOWED_SOUNDFONT_LICENSES = Object.freeze(['MIT']);

const OUT_RE = /^(sfx|amb|bgm)\/[a-z0-9_]+(\.v[0-9]+)?$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s|]+$/.test(u);
const isNonNeg = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isRelPath = (f) => typeof f === 'string' && !!f && !f.startsWith('/') && !f.split(/[\\/]/).includes('..');
const RENDER_ID_RE = /^[a-z][a-z0-9_]*$/;
const RENDER_FILE_RE = /^render\/([a-z][a-z0-9_]*)\.wav$/;

/** out 的種類（sfx／amb／bgm）。 */
export const kindOfOut = (out) => String(out).split('/')[0];

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
    if (o?.channels !== undefined && o.channels !== 1 && o.channels !== 2) errs.push(`${at}：channels 只能是 1 或 2`);
    const kind = kindOfOut(o?.out);
    if (kind === 'bgm' || kind === 'amb') {
      // 循環素材：響度正規化；不可去靜音或用峰值（會改變長度／音量不一致）
      if (!(typeof o.loudness === 'number' && o.loudness >= -36 && o.loudness <= -10)) errs.push(`${at}：bgm／amb 必須有 loudness（−36～−10 LUFS）`);
      if (o.peak !== undefined) errs.push(`${at}：bgm／amb 用 loudness，不可用 peak`);
      if (o.trim === true) errs.push(`${at}：bgm／amb 不可去頭尾靜音（會破壞循環長度）`);
      if (o.xfade !== undefined) {
        if (!isNonNeg(o.xfade)) errs.push(`${at}：xfade 必須是非負數`);
        else if (!isNonNeg(o.duration) || o.duration <= 0) errs.push(`${at}：xfade 需要 duration（循環長度）`);
        else if (o.xfade > o.duration / 2) errs.push(`${at}：xfade 不可超過 duration 的一半`);
      }
      if (o.xfade_curve !== undefined && !['tri', 'qsin'].includes(o.xfade_curve)) errs.push(`${at}：xfade_curve 只能是 tri（線性，兩段高度相關時）或 qsin（等功率）`);
    } else {
      if (o?.loudness !== undefined) errs.push(`${at}：sfx 用 peak，不可用 loudness`);
      if (o?.xfade !== undefined || o?.xfade_curve !== undefined) errs.push(`${at}：sfx 不做循環交叉淡化（xfade）`);
    }
    const rm = typeof f === 'string' ? RENDER_FILE_RE.exec(f) : null;
    if (typeof f === 'string' && f.startsWith('render/')) {
      const rd = rm && (Array.isArray(r.renders) ? r.renders : []).find((x) => x?.id === rm[1]);
      if (!rd) errs.push(`${at}：找不到渲染「${f}」`);
      else if (rd.source !== o.source) errs.push(`${at}：渲染「${rm[1]}」的來源是 ${rd.source}，與輸出的來源 ${o.source} 不同`);
    }
  }
  if (!Array.isArray(r.outputs)) errs.push('缺少 outputs 陣列');
  const fonts = r.soundfonts === undefined ? {} : r.soundfonts;
  if (!fonts || typeof fonts !== 'object' || Array.isArray(fonts)) errs.push('soundfonts 必須是物件');
  for (const [id, s] of Object.entries(fonts ?? {})) {
    const at = `音色庫 ${id}`;
    if (!/^[a-z0-9-]+$/.test(id)) errs.push(`${at}：id 只能用小寫英數與連字號`);
    if (!ALLOWED_SOUNDFONT_LICENSES.includes(s?.license)) errs.push(`${at}：授權「${s?.license}」不在允許清單`);
    if (!isHttps(s?.page)) errs.push(`${at}：page 必須是 https 網址`);
    if (!isHttps(s?.download)) errs.push(`${at}：download 必須是 https 網址`);
    if (typeof s?.author !== 'string' || !s.author.trim()) errs.push(`${at}：缺作者`);
    if (typeof s?.title !== 'string' || !s.title.trim()) errs.push(`${at}：缺名稱`);
    if (!SHA_RE.test(s?.sha256 ?? '')) errs.push(`${at}：sha256 必須是 64 位小寫十六進位`);
    if (!isRelPath(s?.file)) errs.push(`${at}：file 必須是下載檔內的相對路徑`);
    if (!SHA_RE.test(s?.file_sha256 ?? '')) errs.push(`${at}：file_sha256（解開後的音色庫檔）必須是 64 位小寫十六進位`);
    if (typeof s?.notice !== 'string' || !s.notice.trim()) errs.push(`${at}：缺授權全文（notice）`);
  }
  if (r.renders !== undefined && !Array.isArray(r.renders)) errs.push('renders 必須是陣列');
  const rids = new Set();
  for (const [i, x] of (Array.isArray(r.renders) ? r.renders : []).entries()) {
    const at = `renders[${i}]`;
    if (typeof x?.id !== 'string' || !RENDER_ID_RE.test(x.id)) errs.push(`${at}：id 只能用小寫英數與底線`);
    else if (rids.has(x.id)) errs.push(`${at}：id「${x.id}」重複`);
    else rids.add(x.id);
    if (!Object.hasOwn(sources, x?.source)) errs.push(`${at}：找不到來源「${x?.source}」`);
    if (!Object.hasOwn(fonts ?? {}, x?.soundfont)) errs.push(`${at}：找不到音色庫「${x?.soundfont}」`);
    if (!isRelPath(x?.midi)) errs.push(`${at}：midi 必須是來源資料夾內的相對路徑`);
    if (!(Number.isInteger(x?.fromBar) && x.fromBar >= 0 && Number.isInteger(x?.toBar) && x.toBar > x.fromBar)) errs.push(`${at}：小節範圍必須是 0 ≤ fromBar < toBar 的整數`);
    if (!(Number.isInteger(x?.repeats) && x.repeats >= 2 && x.repeats <= 8)) errs.push(`${at}：repeats 必須是 2～8（取第 2 次才有前一次的殘響）`);
    if (x?.gain !== undefined && !(typeof x.gain === 'number' && x.gain > 0 && x.gain <= 2)) errs.push(`${at}：gain 必須介於 0～2`);
  }
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

/**
 * 循環素材（bgm／amb）的濾鏡：轉聲道與 44.1 kHz，不去靜音（長度就是循環長度）。
 * xfade：輸入多讀 xfade 秒（見 inputSpan），把尾段 [duration, duration+xfade) 淡出後疊到開頭（開頭同時淡入），
 * 輸出長度＝duration，接回開頭時聲音連續。環境音（不相關的雜訊）用等功率曲線，音樂（重複段落、高度相關）用線性。
 */
export function loopFilter(o, gainDb = null) {
  const layout = (o.channels ?? (kindOfOut(o.out) === 'bgm' ? 2 : 1)) === 2 ? 'stereo' : 'mono';
  const parts = [`aformat=channel_layouts=${layout}`, 'aresample=44100'];
  let graph = parts.join(',');
  if (o.xfade > 0) {
    const d = o.duration;
    const x = o.xfade;
    const curve = xfadeCurve(o);
    graph += `,asplit=2[a][b];[a]atrim=0:${d},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${x}:curve=${curve}[a1];`
      + `[b]atrim=${d}:${d + x},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${x}:curve=${curve}[b1];`
      + '[a1][b1]amix=inputs=2:normalize=0:duration=first';
  }
  if (gainDb !== null && gainDb !== undefined) graph += `,volume=${gainDb.toFixed(2)}dB`;
  return graph;
}

/** 交叉淡化曲線：配方指定的優先；否則音樂（重複段落、高度相關）用線性，環境音（不相關的雜訊）用等功率。 */
export function xfadeCurve(o) {
  return o.xfade_curve ?? (kindOfOut(o.out) === 'bgm' ? 'tri' : 'qsin');
}

/** 要從原始檔讀的範圍：交叉淡化要多讀 xfade 秒。 */
export function inputSpan(o) {
  const duration = o.duration === undefined ? undefined : o.duration + (o.xfade > 0 ? o.xfade : 0);
  return { start: o.start, duration };
}

/** 各種類的編碼參數（單一格式的大小預算見 tests/audio/assets.test.js）。 */
const CODEC = {
  sfx: { ogg: ['-c:a', 'libvorbis', '-q:a', '2'], m4a: ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart'] },
  bgm: { ogg: ['-c:a', 'libvorbis', '-q:a', '1'], m4a: ['-c:a', 'aac', '-b:a', '80k', '-movflags', '+faststart'] },
  amb: { ogg: ['-c:a', 'libvorbis', '-q:a', '0'], m4a: ['-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart'] },
};

/** ffmpeg 參數：裁切（-ss／-t）、濾鏡、聲道數、清 metadata、可重現（bitexact）、編碼器。 */
export function encodeArgs({ input, start, duration, filter, out, format, kind = 'sfx', channels = 1 }) {
  const codec = CODEC[kind]?.[format];
  if (!codec) throw new Error(`不支援的格式：${kind}／${format}`);
  const a = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
  if (start) a.push('-ss', String(start));
  if (duration) a.push('-t', String(duration));
  a.push('-i', input, '-af', filter, '-ac', String(channels), '-ar', '44100', '-map_metadata', '-1',
    '-fflags', '+bitexact', '-flags:a', '+bitexact', ...codec, out);
  return a;
}

/** 量測用參數：同樣的濾鏡加 volumedetect（loudness 時再加 ebur128 量整體響度），輸出丟掉。 */
export function measureArgs({ input, start, duration, filter, loudness = false, mono = false }) {
  const a = ['-hide_banner', '-nostdin', '-loglevel', 'info'];
  if (start) a.push('-ss', String(start));
  if (duration) a.push('-t', String(duration));
  // 單聲道素材播放時會送到左右兩聲道：用 dualmono 量（否則實際聽起來比量測值大約 3 LU）
  const ebu = loudness ? `ebur128=framelog=quiet${mono ? ':dualmono=true' : ''},` : '';
  a.push('-i', input, '-af', `${filter},${ebu}volumedetect`, '-f', 'null', '-');
  return a;
}

/** ebur128 摘要的整體響度（LUFS）；量不到時 null。 */
export function parseLoudness(log) {
  const m = /Integrated loudness:\s*\n\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(String(log));
  return m ? Number(m[1]) : null;
}

/** 拉到目標響度需要的增益，但加上增益後峰值不得超過 ceiling（預設 −1 dBFS）。量不到響度時不調整。 */
export function loudnessGainDb(lufs, maxVolume, target, ceiling = -1) {
  if (lufs === null || lufs === undefined || !Number.isFinite(lufs)) return 0;
  const g = target - lufs;
  if (maxVolume === null || maxVolume === undefined || !Number.isFinite(maxVolume)) return g;
  return Math.min(g, ceiling - maxVolume);
}

/** FluidSynth 離線渲染參數：不開音效卡、不進互動模式，直接寫 WAV。 */
export function fluidsynthArgs({ sf2, mid, out, gain = 0.5 }) {
  return ['-ni', '-q', '-F', out, '-r', '44100', '-g', String(gain), sf2, mid];
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
    '《鋼鐵迷都》的音效、背景音樂與環境音都是第三方公開授權素材，經裁切、正規化（音效用峰值、音樂與環境音用響度）、',
    '循環接縫交叉淡化，重新編碼成 Ogg Vorbis 與 AAC（m4a）兩種格式。標示「MIDI 渲染」的音樂是用 CC0 的 MIDI 樂譜改編配器後，',
    '以 MIT 授權的音色庫離線渲染而成（音色庫的授權全文附在本檔最後）。',
    '鐘聲（入夢、醒來、遠方鐘聲）與霧笛是程式即時合成，沒有音檔。',
    '',
    '## 每個音檔',
    '',
    '| 檔案 | 用途 | 原始素材 | 作者 | 授權 | 來源網址 |',
    '|---|---|---|---|---|---|',
  ];
  for (const o of r.outputs ?? []) {
    const s = r.sources[o.source];
    const rm = RENDER_FILE_RE.exec(o.file ?? '');
    const rd = rm ? (r.renders ?? []).find((x) => x.id === rm[1]) : null;
    const font = rd ? r.soundfonts?.[rd.soundfont] : null;
    const what = rd ? `${cell(rd.midi)}，MIDI 渲染：${cell(font?.title)} 音色庫` : cell(o.file);
    const lic = rd ? `${cell(s.license)}（樂譜）＋${cell(font?.license)}（${cell(font?.title)} 音色庫，全文見檔尾）` : cell(s.license);
    const who = rd ? `${cell(s.author)}；音色庫 ${cell(font?.author)}` : cell(s.author);
    lines.push(`| \`${o.out}.ogg\`、\`${o.out}.m4a\` | ${cell(o.use)} | ${cell(s.title)}（${what}） | ${who} | ${lic} | ${s.page} |`);
  }
  lines.push('', '## 來源素材包', '', '| 來源 id | 素材 | 作者 | 授權 | 頁面 | 下載檔 | SHA-256 |', '|---|---|---|---|---|---|---|');
  for (const [id, s] of Object.entries(r.sources ?? {})) {
    lines.push(`| ${id} | ${cell(s.title)} | ${cell(s.author)} | ${cell(s.license)} | ${s.page} | ${s.download} | \`${s.sha256}\` |`);
  }
  const fonts = Object.entries(r.soundfonts ?? {});
  if (fonts.length) {
    lines.push('', '## 音色庫（MIDI 渲染用）', '');
    for (const [id, s] of fonts) {
      lines.push(`### ${cell(s.title)}（${id}）`, '', `- 作者：${cell(s.author)}`, `- 授權：${cell(s.license)}`, `- 頁面：${s.page}`,
        `- 下載檔：${s.download}（SHA-256 \`${s.sha256}\`，使用其中的 \`${s.file}\`）`, '', '```', s.notice.trim(), '```', '');
    }
  }
  lines.push('');
  return lines.join('\n');
}
