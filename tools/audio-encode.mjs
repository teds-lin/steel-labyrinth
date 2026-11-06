// 音檔轉檔：依 tools/audio-recipe.json 把下載的素材裁切、去頭尾靜音、峰值正規化，輸出 web/audio/<out>.ogg 與 .m4a。
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
} from './lib/audio-recipe.mjs';

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
    const p = join(downloads, id, basename(new URL(s.download).pathname));
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
  const base = { input, start: o.start, duration: o.duration };
  // 第一輪：量峰值；第二輪：加上增益後編碼兩種格式
  const max = parseMaxVolume(ffmpeg(measureArgs({ ...base, filter: sfxFilter(o) })));
  const gain = peakGainDb(max, o.peak ?? -3);
  const filter = sfxFilter(o, gain);
  const outBase = join(ROOT, 'web', 'audio', o.out);
  mkdirSync(dirname(outBase), { recursive: true });
  const sizes = {};
  for (const format of ['ogg', 'm4a']) {
    const out = `${outBase}.${format}`;
    ffmpeg(encodeArgs({ ...base, filter, out, format }));
    sizes[format] = statSync(out).size;
  }
  rows.push({ out: o.out, peak_in: max, gain_db: Number(gain.toFixed(2)), ogg: sizes.ogg, m4a: sizes.m4a });
}
console.table(rows);
const total = (f) => rows.reduce((a, r) => a + r[f], 0);
console.log(`合計：ogg ${total('ogg')} bytes、m4a ${total('m4a')} bytes`);
