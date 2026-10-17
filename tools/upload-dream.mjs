#!/usr/bin/env node
// 把夢客人設、詞表與預寫台詞轉成 D1 的 SQL（docs/API.md「鐘塔之夢」的「私有資料上傳」）。
//
//   node tools/upload-dream.mjs --out /tmp/dream.sql [--personas <dir>] [--lexicon <file>] [--story <dir>] [--config <wrangler.toml>] [--apply-local | --apply-remote]
//
// - 人設：私有 repo 的 dream/personas/*.json（**只讀 .json**；同一個資料夾的 README-internal.md 等內部筆記寫著劇情真相，絕不讀入）。
// - 詞表：私有 repo 的 dream/lexicon.json（tools/gen-dream-lexicon.mjs 產生，禁止手改）。
// - 預寫台詞：公開的 web/data/story/*.json 的 guests[].scripted，依夢客 id 合併進人設（伺服器改用預寫台詞時需要）。
// - 輸出的 SQL 含人設與詞表，**不可以寫進公開 repo**（本工具會拒絕）。
// - --apply-local：用 `wrangler d1 execute --local` 寫進本機 D1（wrangler dev 用）。
// - --apply-remote：**只印出指令，不執行**（部署時由維護者自己執行）。
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOutsideRepo, REPO_ROOT } from './gen-dream-lexicon.mjs';
import { DEFAULT_NAME } from '../web/src/core/name.js';

const DESIGN = resolve(REPO_ROOT, '..', 'steel-labyrinth-design');
export const DEFAULTS = {
  personasDir: join(DESIGN, 'dream', 'personas'),
  lexiconPath: join(DESIGN, 'dream', 'lexicon.json'),
  storyDir: join(REPO_ROOT, 'web', 'data', 'story'),
};
/** D1 單一 SQL 敘述的長度上限是 100 KB。 */
export const MAX_STATEMENT_BYTES = 100 * 1024;
const ID_RE = /^[a-z0-9_]{1,32}$/;
const PERSONA_FIELDS = ['id', 'name', 'persona', 'speech_examples', 'knowledge', 'deflect_topics', 'leak_markers', 'boundaries'];
const SCRIPTED_REQUIRED = ['greeting', 'fallback', 'quota', 'filtered'];
/** 主角的預設名字（雷恩・葛雷 → 雷恩、葛雷）：人設裡出現就報錯——提示詞不得帶玩家真名，鐘塔裡一律叫「十二點」。 */
const HERO_NAME_PARTS = [...new Set([DEFAULT_NAME, ...DEFAULT_NAME.split(/[・·\s]/)].filter((s) => s.length >= 2))];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
const strArray = (v, { min = 1 } = {}) => Array.isArray(v) && v.length >= min && v.every(nonEmptyStr);

/** 驗證一份人設；有問題就丟錯，訊息列出檔名與所有欄位問題。 */
export function validatePersona(p, file) {
  const problems = [];
  if (!isObj(p)) throw new Error(`${file}：內容不是 JSON 物件`);
  for (const f of PERSONA_FIELDS) if (!Object.hasOwn(p, f)) problems.push(`缺欄位 ${f}`);
  for (const f of Object.keys(p)) if (!PERSONA_FIELDS.includes(f)) problems.push(`未知欄位 ${f}（打錯字？不會上傳）`);
  if (Object.hasOwn(p, 'id')) {
    if (typeof p.id !== 'string' || !ID_RE.test(p.id)) problems.push('id 必須符合 [a-z0-9_]{1,32}');
    else if (`${p.id}.json` !== file.split(/[\\/]/).pop()) problems.push(`id（${p.id}）必須和檔名相同`);
  }
  for (const f of ['name', 'persona', 'boundaries']) if (Object.hasOwn(p, f) && !nonEmptyStr(p[f])) problems.push(`${f} 必須是非空字串`);
  for (const f of ['speech_examples', 'leak_markers']) if (Object.hasOwn(p, f) && !strArray(p[f])) problems.push(`${f} 必須是至少一項的字串陣列`);
  if (Object.hasOwn(p, 'deflect_topics') && !strArray(p.deflect_topics, { min: 0 })) problems.push('deflect_topics 必須是字串陣列');
  if (Object.hasOwn(p, 'knowledge')) {
    if (!isObj(p.knowledge)) problems.push('knowledge 必須是物件（章節 → 字串陣列）');
    else {
      for (const [ch, cards] of Object.entries(p.knowledge)) {
        if (!ID_RE.test(ch)) problems.push(`knowledge 的章節鍵「${ch}」格式錯誤`);
        if (!strArray(cards, { min: 0 })) problems.push(`knowledge.${ch} 必須是字串陣列`);
      }
    }
  }
  const text = JSON.stringify(p);
  for (const n of HERO_NAME_PARTS) {
    if (text.includes(n)) problems.push(`含主角的名字「${n}」：提示詞不得帶玩家真名，鐘塔裡一律稱主角為「十二點」`);
  }
  if (problems.length) throw new Error(`${file}：${problems.join('；')}`);
  return p;
}

/** 讀人設資料夾：只讀一般檔案、副檔名正好是 .json 的檔案（依檔名排序）。回傳 [{ file, persona }]。 */
export function readPersonas(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && statSync(join(dir, f)).isFile()).sort();
  return files.map((file) => {
    let obj;
    try {
      obj = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      throw new Error(`${file}：JSON 無法解析（${e.message}）`);
    }
    return { file, persona: validatePersona(obj, file) };
  });
}

/** 公開 story 的預寫台詞：Map<夢客 id, scripted>。 */
export function readScripted(storyDir) {
  const out = new Map();
  for (const f of readdirSync(storyDir).filter((x) => x.endsWith('.json')).sort()) {
    const story = JSON.parse(readFileSync(join(storyDir, f), 'utf8'));
    for (const g of Array.isArray(story?.guests) ? story.guests : []) {
      if (!isObj(g) || typeof g.id !== 'string') continue;
      if (out.has(g.id)) throw new Error(`夢客 ${g.id} 的預寫台詞在多個 story 檔重複定義（${f}）`);
      out.set(g.id, isObj(g.scripted) ? g.scripted : {});
    }
  }
  return out;
}

/** 詞表檔：檢查檔頭與格式。 */
export function readLexicon(path) {
  const lex = JSON.parse(readFileSync(path, 'utf8'));
  const problems = [];
  if (!isObj(lex)) throw new Error(`${path}：不是 JSON 物件`);
  for (const f of ['source', 'source_sha256', 'generated_at', 'DO_NOT_EDIT']) if (!nonEmptyStr(lex[f])) problems.push(`缺檔頭 ${f}`);
  if (!Array.isArray(lex.chars) || !lex.chars.every((c) => typeof c === 'string' && [...c].length === 1)) problems.push('chars 必須是單一字元的陣列');
  if (!Array.isArray(lex.words) || !lex.words.every(nonEmptyStr)) problems.push('words 必須是字串陣列');
  if (problems.length) throw new Error(`${path}：${problems.join('；')}`);
  return lex;
}

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** 產生 SQL：先 upsert 全部夢客與詞表，再刪除這次沒有上傳的舊夢客（不會有空窗）。回傳 { sql, guests }。 */
export function buildDreamSql({ personasDir = DEFAULTS.personasDir, lexiconPath = DEFAULTS.lexiconPath, storyDir = DEFAULTS.storyDir, now = Math.floor(Date.now() / 1000) } = {}) {
  const personas = readPersonas(personasDir);
  if (personas.length === 0) throw new Error(`${personasDir} 裡沒有任何人設（*.json）`);
  const scripted = readScripted(storyDir);
  const lexicon = readLexicon(lexiconPath);
  const statements = [];
  for (const { persona: p } of personas) {
    const s = scripted.get(p.id);
    if (!s) throw new Error(`夢客 ${p.id} 在 ${storyDir} 找不到預寫台詞（guests[].scripted）`);
    for (const k of SCRIPTED_REQUIRED) {
      if (!strArray(s[k])) throw new Error(`夢客 ${p.id} 的預寫台詞缺 ${k}（必須是至少一句的字串陣列）`);
    }
    const data = { ...p, scripted: Object.fromEntries(Object.entries(s).filter(([, v]) => strArray(v))) };
    statements.push(`INSERT INTO dream_personas (id, data, updated_at) VALUES (${sqlStr(p.id)}, ${sqlStr(JSON.stringify(data))}, ${now})
  ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at;`);
  }
  const ids = personas.map(({ persona }) => sqlStr(persona.id)).join(', ');
  statements.push(`DELETE FROM dream_personas WHERE id NOT IN (${ids});`);
  const lexSha = createHash('sha256').update(JSON.stringify(lexicon)).digest('hex');
  statements.push(`INSERT INTO dream_lexicon (id, data, source_sha256, updated_at) VALUES ('main', ${sqlStr(JSON.stringify(lexicon))}, ${sqlStr(lexicon.source_sha256)}, ${now})
  ON CONFLICT (id) DO UPDATE SET data = excluded.data, source_sha256 = excluded.source_sha256, updated_at = excluded.updated_at;`);
  for (const st of statements) {
    const bytes = Buffer.byteLength(st, 'utf8');
    if (bytes > MAX_STATEMENT_BYTES) throw new Error(`有一條 SQL 敘述 ${bytes} bytes，超過 D1 的單一敘述上限 100 KB（人設或詞表太大）`);
  }
  const header = `-- 由 tools/upload-dream.mjs 產生（${new Date(now * 1000).toISOString()}）。含私有的人設與詞表：不可放進公開 repo。\n-- 詞表內容 sha256 ${lexSha}；來源 lexicon.yaml sha256 ${lexicon.source_sha256}\n`;
  return { sql: `${header}${statements.join('\n')}\n`, guests: personas.map(({ persona }) => persona.id) };
}

function parseArgs(argv) {
  const a = { personasDir: DEFAULTS.personasDir, lexiconPath: DEFAULTS.lexiconPath, storyDir: DEFAULTS.storyDir, out: null, local: false, remote: false, config: 'worker/wrangler.toml' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--personas') a.personasDir = argv[++i];
    else if (k === '--lexicon') a.lexiconPath = argv[++i];
    else if (k === '--story') a.storyDir = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--apply-local') a.local = true;
    else if (k === '--apply-remote') a.remote = true;
    else if (k === '--config') a.config = argv[++i];
    else throw new Error(`不認得的參數：${k}`);
  }
  if (!a.out) throw new Error('請用 --out 指定 SQL 的輸出路徑（不可在公開 repo 裡，例如 /tmp/steel-labyrinth-dream.sql）');
  return a;
}

function main() {
  try {
    const a = parseArgs(process.argv.slice(2));
    assertOutsideRepo(a.out, 'SQL（含人設與詞表）');
    const { sql, guests } = buildDreamSql(a);
    mkdirSync(dirname(resolve(a.out)), { recursive: true });
    writeFileSync(a.out, sql);
    console.log(`已寫出 ${a.out}：夢客 ${guests.join('、')}`);
    const cmd = ['wrangler', 'd1', 'execute', 'steel-labyrinth', '--config', a.config, '--file', a.out];
    if (a.local) {
      const r = spawnSync('npx', [...cmd.slice(0, 4), '--local', ...cmd.slice(4)], { cwd: REPO_ROOT, stdio: 'inherit' });
      if (r.status !== 0) throw new Error('wrangler d1 execute --local 失敗');
      console.log('已寫進本機 D1（wrangler dev 使用的 .wrangler/state）。');
    }
    if (a.remote) {
      console.log('正式環境請自行執行（本工具不會自動執行）：');
      console.log(`  npx wrangler d1 execute steel-labyrinth --remote --config ${a.config} --file ${a.out}`);
    }
  } catch (e) {
    console.error(`upload-dream：${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
