#!/usr/bin/env node
// 用法：node tools/export-strings.mjs <輸出.jsonl> [資料目錄，預設 web/data]
// 輸出所有玩家看得到的字串；每列 {"unique_id":"<檔案>#<路徑>","text":"..."}。
// unique_id 不唯一時報錯退出、不寫檔。
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadBundle } from './lib/bundle.mjs';
import { collectStrings, assertUniqueIds } from './lib/strings.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [outArg, dataArg] = process.argv.slice(2);
if (!outArg) {
  console.error('用法：node tools/export-strings.mjs <輸出.jsonl> [資料目錄]');
  process.exit(1);
}
const dataDir = resolve(dataArg ?? join(root, 'web', 'data'));
const { bundle, errors } = loadBundle(dataDir);
if (errors.length) {
  console.error(`讀取資料失敗（${dataDir}）：`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
const rows = collectStrings(bundle);
try {
  assertUniqueIds(rows);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const out = resolve(outArg);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
console.log(`已輸出 ${rows.length} 筆字串到 ${out}`);
