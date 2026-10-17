#!/usr/bin/env node
// 產生夢客回覆檢查用的詞表（docs/API.md「鐘塔之夢」、plans/M4-dream.md D5）。
//
//   node tools/gen-dream-lexicon.mjs --out ../steel-labyrinth-design/dream/lexicon.json [--lexicon <lexicon.yaml>] [--python <python>]
//
// 唯一來源：/data/sdg_data/sdg_pipeline/lexicon/lexicon.yaml（簡中偵測詞表的單一事實來源；本工具只讀，絕不修改 sdg_pipeline 的任何檔案）。
// 漏抓或誤報請走詞庫回饋流程（交詞庫維護 session），不要手改產生出來的 lexicon.json。
// 產物屬內部資產，只能放私有 repo（本工具拒絕寫進公開 repo）。
//
// 規則（和官方掃描器 scan_datasets_full.py 的 lexicon 模式一致，但 AI 回覆不給引號保護）：
// - chars＝lexicon 的 simplified_only 字＋開放集（dragonmapper 判為 SIMPLIFIED 的字；「不放過任何簡體字」），
//   扣掉 also_traditional（于、后…正體也合法）、not_simplified、char_whitelist、detect:false。
// - words＝detect 不是 false、沒有領域限定（domain）的詞：deterministic、contextual 全收；advisory 只收「有建議修法（fix）」的
//   （例：信息→資訊、屏幕→螢幕；模型評測裡 gemma 會用反問語氣複述玩家說的「網絡？信息？」）。advisory 而 fix 為空的
//   （例：工藝——詞庫判定為合法台灣詞、沒有替代寫法）不收。AI 回覆命中只會重試或改用預寫台詞，不會改壞資料，
//   所以比資料清洗更嚴格；實測第一～三章劇情與模型評測回覆約 4 萬字，advisory 只命中真正的「信息」。
// - word_rules：contextual 的取消規則（cancel_pre／cancel_post）與詞條自己的例外詞；exceptions：收進 chars 的字的例外詞。
// 讀 YAML 與 dragonmapper 需要 Python（PyYAML＋dragonmapper）；缺 dragonmapper 時大聲失敗，不退回只用 lexicon 的字。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LEXICON_PATH = '/data/sdg_data/sdg_pipeline/lexicon/lexicon.yaml';
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DO_NOT_EDIT = '禁止手改：由 tools/gen-dream-lexicon.mjs 從 source 的 lexicon.yaml 產生；漏抓或誤報請回報詞庫維護 session，改好 lexicon.yaml 後重新產生。';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : []);
const ACTIVE_TIERS = new Set(['deterministic', 'contextual']);
/** advisory 只收有建議修法（fix 是和 term 不同的非空字串）的詞。 */
const wordIncluded = (e) => ACTIVE_TIERS.has(e.tier) || (e.tier === 'advisory' && typeof e.fix === 'string' && e.fix.length > 0 && e.fix !== e.term);

/** 輸出路徑不可以在公開 repo 裡（人設與詞表只能放私有 repo）。 */
export function assertOutsideRepo(path, what) {
  const rel = relative(REPO_ROOT, resolve(path));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`${what}不可以寫進公開 repo（${path}）；請輸出到私有 repo（例如 ../steel-labyrinth-design/dream/）或暫存資料夾。`);
  }
}

/**
 * 由 lexicon.yaml 的內容（已解析的物件）與開放集簡體字產生偵測用詞表。
 * openSet：dragonmapper 判為簡體的字（陣列）；不可為空（避免安靜地只剩 lexicon 的幾十個字）。
 */
export function buildDreamLexicon({ lexicon, openSet, source, sourceSha256, generatedAt, openSetSource = null }) {
  if (!isObj(lexicon) || !Array.isArray(lexicon.entries)) throw new Error('lexicon.yaml 的結構不符預期（缺 entries 陣列）');
  if (!Array.isArray(openSet) || openSet.length === 0) throw new Error('開放集簡體字是空的（缺 dragonmapper？）；依「不放過任何簡體字」拒絕產生');
  const entries = lexicon.entries.filter(isObj);
  const chars = entries.filter((e) => e.kind === 'char');
  const statusSet = (s) => new Set(chars.filter((e) => e.orthographic_status === s).map((e) => e.term));
  const excluded = new Set([
    ...strList(lexicon.char_whitelist), ...statusSet('also_traditional'), ...statusSet('not_simplified'),
    ...chars.filter((e) => e.detect === false).map((e) => e.term),
  ]);
  const charSet = new Set();
  for (const e of chars) if (e.orthographic_status === 'simplified_only' && e.detect !== false) charSet.add(e.term);
  for (const c of openSet) if (typeof c === 'string' && [...c].length === 1 && !excluded.has(c)) charSet.add(c);
  for (const c of excluded) charSet.delete(c);
  const exceptions = new Set();
  for (const e of chars) if (charSet.has(e.term)) for (const p of strList(e.exception_words)) exceptions.add(p);

  const words = [];
  const wordRules = {};
  for (const e of entries) {
    if (e.kind !== 'word' || e.detect === false || !wordIncluded(e) || (e.domain ?? null) !== null) continue;
    if (typeof e.term !== 'string' || e.term.length === 0) continue;
    words.push(e.term);
    const pre = strList(e.cancel_pre);
    const post = strList(e.cancel_post);
    const exc = strList(e.exception_words).filter((p) => p.includes(e.term));
    if (pre.length || post.length || exc.length) wordRules[e.term] = { pre, post, exc };
  }
  return {
    source,
    source_sha256: sourceSha256,
    generated_at: generatedAt,
    DO_NOT_EDIT,
    format: 1,
    open_set_source: openSetSource,
    chars: [...charSet].sort(),
    words: [...new Set(words)].sort(),
    exceptions: [...exceptions].sort(),
    word_rules: Object.fromEntries(Object.entries(wordRules).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

// Python：只讀 lexicon.yaml，輸出 JSON（lexicon 本體＋dragonmapper 開放集）。
const PY = `
import json, sys
import yaml
from dragonmapper import hanzi as H
import importlib.metadata as md
with open(sys.argv[1], encoding='utf-8') as f:
    lex = yaml.safe_load(f)
ranges = [(0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x2A6DF)]
open_set = [chr(c) for a, b in ranges for c in range(a, b + 1) if H.identify(chr(c)) is H.SIMPLIFIED]
json.dump({'lexicon': lex, 'open_set': open_set, 'dragonmapper': md.version('dragonmapper')}, sys.stdout, ensure_ascii=False)
`;

/** 讀 lexicon.yaml（只讀）：回傳 buildDreamLexicon 需要的 { lexicon, openSet, source, sourceSha256, openSetSource }。 */
export function readLexiconSource(path = DEFAULT_LEXICON_PATH, { python = process.env.DREAM_LEXICON_PYTHON ?? 'python3' } = {}) {
  const bytes = readFileSync(path);
  const r = spawnSync(python, ['-c', PY, path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error(`用 ${python} 讀取 lexicon.yaml 失敗（需要 PyYAML 與 dragonmapper；可用 --python 指定）：${r.error?.message ?? r.stderr}`);
  }
  const parsed = JSON.parse(r.stdout);
  return {
    lexicon: parsed.lexicon,
    openSet: parsed.open_set,
    source: path,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    openSetSource: `dragonmapper ${parsed.dragonmapper}`,
  };
}

function parseArgs(argv) {
  const args = { lexicon: DEFAULT_LEXICON_PATH, out: null, python: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lexicon') args.lexicon = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--python') args.python = argv[++i];
    else throw new Error(`不認得的參數：${a}`);
  }
  if (!args.out) throw new Error('請用 --out 指定輸出路徑（私有 repo 的 dream/lexicon.json）');
  return args;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    assertOutsideRepo(args.out, '詞表');
    const src = readLexiconSource(args.lexicon, args.python ? { python: args.python } : undefined);
    const lex = buildDreamLexicon({ ...src, generatedAt: new Date().toISOString() });
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(lex, null, 1)}\n`);
    console.log(`已產生 ${args.out}：簡體字 ${lex.chars.length} 個、陸用語 ${lex.words.length} 個、例外詞 ${lex.exceptions.length} 個（來源 sha256 ${lex.source_sha256.slice(0, 16)}…）`);
  } catch (e) {
    console.error(`gen-dream-lexicon：${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
