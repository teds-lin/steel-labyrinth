// 音檔轉檔：依 tools/audio-recipe.json 把下載的素材轉成 web/audio/<out>.ogg 與 .m4a。
//   sfx：裁切、去頭尾靜音、峰值正規化、單聲道。
//   bgm／amb：裁切成剛好一個循環（xfade 時尾段疊回開頭）、響度正規化（峰值不超過 −1 dBFS）、bgm 立體聲／amb 單聲道。
// MIDI 渲染的音樂（file 為 render/<id>.wav）要先跑 tools/audio-render.mjs。
//
//   node tools/audio-encode.mjs --credits                       只重新產生 CREDITS.md（不需要 ffmpeg）
//   node tools/audio-encode.mjs --src <素材資料夾> [--downloads <下載資料夾>] [--only sfx/ui_move,...]
//
// <素材資料夾>/<來源 id>/<file>：配方裡每個輸出的原始檔（zip 先解壓縮，保留 zip 內的路徑）。
// <下載資料夾>/<來源 id>/<下載檔名>：有給就核對 sha256，不符就中止。
// ffmpeg 位置用環境變數 FFMPEG 指定（預設找 PATH 上的 ffmpeg）。安裝方式見私有企劃 repo 的 tools/README-audio-tools.md。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRecipe, sfxFilter, encodeArgs, measureArgs, parseMaxVolume, peakGainDb, renderCredits,
  loopFilter, inputSpan, kindOfOut, parseLoudness, loudnessGainDb, xfadeCurve,
} from './lib/audio-recipe.mjs';
import { crossfadeReport } from './lib/audio-loop.mjs';

const SR = 44100;
/** 交叉淡化的上限（dB）：淡化區比兩段中較小聲的還低（凹洞）或比較大聲的還高（鼓起）超過這個值就中止。 */
const XFADE_DIP_LIMIT = -1.5;
const XFADE_BUMP_LIMIT = 1.5;

/** 解碼成 44.1 kHz 單聲道 float32（模擬交叉淡化、檢查輸出長度用）。 */
function decodeMono(input, { start, duration } = {}) {
  const a = ['-v', 'error'];
  if (start) a.push('-ss', String(start));
  if (duration) a.push('-t', String(duration));
  a.push('-i', input, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-');
  const r = spawnSync(FFMPEG_BIN(), a, { maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`ffmpeg 解碼失敗：${r.stderr}`);
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.byteLength / 4));
}
const FFMPEG_BIN = () => process.env.FFMPEG || 'ffmpeg';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const recipe = JSON.parse(readFileSync(join(ROOT, 'tools', 'audio-recipe.json'), 'utf8'));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

const errs = validateRecipe(recipe);
if (errs.length) {
  console.error(`配方有誤：\n${errs.join('\n')}`);
  process.exit(1);
}

if (args.includes('--credits')) {
  writeFileSync(join(ROOT, 'CREDITS.md'), renderCredits(recipe));
  console.log('已更新 CREDITS.md');
  process.exit(0);
}

const src = opt('--src');
if (!src) {
  console.error('用法：node tools/audio-encode.mjs --src <素材資料夾> [--downloads <下載資料夾>] [--only a,b]｜--credits');
  process.exit(2);
}
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const downloads = opt('--downloads');
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;

function ffmpeg(a) {
  const r = spawnSync(FFMPEG, a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`ffmpeg 失敗（${r.status}）：${r.stderr}`);
  return r.stderr;
}

if (downloads) {
  for (const [id, s] of Object.entries(recipe.sources)) {
    const p = join(downloads, id, decodeURIComponent(basename(new URL(s.download).pathname)));
    if (!existsSync(p)) { console.warn(`略過核對（找不到下載檔）：${p}`); continue; }
    const h = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (h !== s.sha256) { console.error(`sha256 不符：${p}\n  預期 ${s.sha256}\n  實際 ${h}`); process.exit(1); }
  }
  console.log('下載檔 sha256 核對通過');
}

const rows = [];
for (const o of recipe.outputs) {
  if (only && !only.has(o.out)) continue;
  const input = join(src, o.source, o.file);
  if (!existsSync(input)) { console.error(`找不到原始檔：${input}`); process.exit(1); }
  const kind = kindOfOut(o.out);
  const loop = kind === 'bgm' || kind === 'amb';
  const base = { input, ...(loop ? inputSpan(o) : { start: o.start, duration: o.duration }) };
  const channels = o.channels ?? (kind === 'bgm' ? 2 : 1);
  if (loop && o.xfade > 0) {
    // 先模擬交叉淡化：兩段不夠相關時線性曲線會互相抵消，出現音量凹洞
    const x = decodeMono(input, base);
    const n = Math.round(o.xfade * SR);
    const d = Math.round(o.duration * SR);
    const rep = crossfadeReport(x.subarray(0, n), x.subarray(d, d + n), xfadeCurve(o));
    if (rep.worstDb < XFADE_DIP_LIMIT || rep.peakDb > XFADE_BUMP_LIMIT) {
      console.error(`${o.out}：交叉淡化出現 ${rep.worstDb.toFixed(2)} dB 的凹洞／${rep.peakDb.toFixed(2)} dB 的鼓起（兩段相關 ${rep.corr.toFixed(3)}、曲線 ${xfadeCurve(o)}），請換循環點、淡化長度或 xfade_curve`);
      process.exit(1);
    }
  }
  // 第一輪：量峰值（循環素材另量整體響度）；第二輪：加上增益後編碼兩種格式
  const log = ffmpeg(measureArgs({ ...base, filter: loop ? loopFilter(o) : sfxFilter(o), loudness: loop, mono: channels === 1 }));
  const max = parseMaxVolume(log);
  const lufs = loop ? parseLoudness(log) : null;
  if (loop && lufs === null) { console.error(`${o.out}：量不到響度（ebur128 沒有輸出），中止`); process.exit(1); }
  const gain = loop ? loudnessGainDb(lufs, max, o.loudness) : peakGainDb(max, o.peak ?? -3);
  if (loop && gain < o.loudness - lufs - 0.05) {
    console.warn(`${o.out}：響度被峰值上限壓住，只拉到 ${(lufs + gain).toFixed(1)} LUFS（目標 ${o.loudness}）`);
  }
  const filter = loop ? loopFilter(o, gain) : sfxFilter(o, gain);
  const outBase = join(ROOT, 'web', 'audio', o.out);
  mkdirSync(dirname(outBase), { recursive: true });
  const sizes = {};
  for (const format of ['ogg', 'm4a']) {
    const out = `${outBase}.${format}`;
    ffmpeg(encodeArgs({ ...base, filter, out, format, kind, channels }));
    sizes[format] = statSync(out).size;
  }
  if (loop && o.duration) {
    // ogg 的長度必須剛好是 duration（m4a 尾端有 AAC 補白，播放端用 catalog 的 len 切掉）
    const got = decodeMono(`${outBase}.ogg`).length;
    const want = Math.round(o.duration * SR);
    if (got !== want) { console.error(`${o.out}.ogg：長度 ${got} 個取樣點，應為 ${want}（原始檔不夠長？）`); process.exit(1); }
  }
  rows.push({ out: o.out, peak_in: max, lufs_in: lufs, gain_db: Number(gain.toFixed(2)), ogg: sizes.ogg, m4a: sizes.m4a });
}
console.table(rows);
const total = (f) => rows.reduce((a, r) => a + r[f], 0);
console.log(`合計：ogg ${total('ogg')} bytes、m4a ${total('m4a')} bytes`);
