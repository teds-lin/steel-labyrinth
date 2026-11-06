// MIDI 離線渲染：依 tools/audio-recipe.json 的 renders，把 CC0 的 MIDI 改編配器、取一段小節重複，
// 用 FluidSynth＋音色庫渲染，量出實際循環週期後裁成剛好一個循環的 WAV：<素材資料夾>/<來源 id>/render/<id>.wav。
// 之後由 tools/audio-encode.mjs 照一般素材轉檔（配方 outputs 的 file 寫 render/<id>.wav）。
//
//   node tools/audio-render.mjs --src <素材資料夾> --soundfonts <音色庫資料夾> [--only city_waltz]
//
// <音色庫資料夾>/<音色庫 id>/<file>：配方 soundfonts 的 file（例如 Debian 套件解開後的 usr/share/sounds/sf2/FluidR3_GM.sf2）。
// FluidSynth 與 ffmpeg 的位置用環境變數 FLUIDSYNTH、FFMPEG 指定（預設找 PATH）。安裝方式見私有企劃 repo 的 tools/README-audio-tools.md。
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateRecipe, fluidsynthArgs } from './lib/audio-recipe.mjs';
import { parseMidi, writeMidi, arrange, loopSection, tempoBpm, ticksPerBar } from './lib/midi.mjs';
import { findPeriod } from './lib/audio-loop.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const recipe = JSON.parse(readFileSync(join(ROOT, 'tools', 'audio-recipe.json'), 'utf8'));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const errs = validateRecipe(recipe);
if (errs.length) { console.error(`配方有誤：\n${errs.join('\n')}`); process.exit(1); }
const src = opt('--src');
const fonts = opt('--soundfonts');
if (!src || !fonts) { console.error('用法：node tools/audio-render.mjs --src <素材資料夾> --soundfonts <音色庫資料夾> [--only id]'); process.exit(2); }
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
const FLUIDSYNTH = process.env.FLUIDSYNTH || 'fluidsynth';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SR = 44100;

function run(cmd, a, opts = {}) {
  const r = spawnSync(cmd, a, { maxBuffer: 1024 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} 失敗（${r.status}）：${String(r.stderr)}`);
  return r;
}

const tmp = mkdtempSync(join(tmpdir(), 'sl-render-'));
for (const rd of recipe.renders ?? []) {
  if (only && !only.has(rd.id)) continue;
  const font = recipe.soundfonts[rd.soundfont];
  const sf2 = join(fonts, rd.soundfont, font.file);
  const midPath = join(src, rd.source, rd.midi);
  for (const p of [sf2, midPath]) if (!existsSync(p)) { console.error(`找不到：${p}`); process.exit(1); }
  const sfHash = createHash('sha256').update(readFileSync(sf2)).digest('hex');
  if (sfHash !== font.file_sha256) { console.error(`音色庫 sha256 不符：${sf2}\n  預期 ${font.file_sha256}\n  實際 ${sfHash}`); process.exit(1); }
  const midHash = createHash('sha256').update(readFileSync(midPath)).digest('hex');
  const src0 = recipe.sources[rd.source];
  const dlName = decodeURIComponent(new URL(src0.download).pathname.split('/').pop());
  if (dlName === rd.midi && midHash !== src0.sha256) { console.error(`MIDI 的 sha256 與來源記錄不符：${midPath}\n  預期 ${src0.sha256}\n  實際 ${midHash}`); process.exit(1); }
  if (dlName !== rd.midi) console.warn(`MIDI 不是來源下載檔本身（${dlName}），無法核對雜湊：${midPath}`);
  const m = arrange(parseMidi(readFileSync(midPath)), { tracks: rd.tracks ?? {}, channels: rd.channels ?? {} });
  const looped = loopSection(m, { fromBar: rd.fromBar, toBar: rd.toBar, repeats: rd.repeats });
  const mid = join(tmp, `${rd.id}.mid`);
  const full = join(tmp, `${rd.id}.wav`);
  writeFileSync(mid, writeMidi(looped));
  run(FLUIDSYNTH, fluidsynthArgs({ sf2, mid, out: full, gain: rd.gain ?? 0.5 }));
  // 量實際週期：比對第 1 次與第 2 次重複的中段（中段不受前一次殘響影響）
  const seconds = ((rd.toBar - rd.fromBar) * ticksPerBar(looped) / looped.division) * (60 / tempoBpm(looped));
  const expected = Math.round(seconds * SR);
  const pcm = run(FFMPEG, ['-v', 'error', '-i', full, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-']).stdout;
  const x = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  const { period, score } = findPeriod(x, { expected, search: Math.round(0.01 * SR), window: SR, at: Math.round(expected / 2) });
  if (score < 0.99) { console.error(`${rd.id}：兩次重複對不起來（相關係數 ${score.toFixed(4)}），不輸出`); process.exit(1); }
  const outDir = join(src, rd.source, 'render');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${rd.id}.wav`);
  run(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', full,
    '-af', `atrim=start_sample=${period}:end_sample=${2 * period},asetpts=PTS-STARTPTS`, '-c:a', 'pcm_f32le', '-map_metadata', '-1', '-fflags', '+bitexact', out]);
  console.log(`${rd.id}：理論週期 ${expected} 取樣點，實測 ${period}（相關 ${score.toFixed(5)}），輸出 ${(period / SR).toFixed(4)} 秒 → ${out}`);
}
