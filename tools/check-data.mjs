#!/usr/bin/env node
// 用法：node tools/check-data.mjs [資料目錄，預設 web/data]
// 讀 manifest 組成 bundle → validateBundle；有錯就列出並以結束碼 1 退出。
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundle } from './lib/bundle.mjs';
import { validateBundle } from '../web/src/core/validate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.argv[2] ?? join(root, 'web', 'data'));

const { bundle, errors: loadErrors } = loadBundle(dataDir);
const errors = bundle ? [...loadErrors, ...validateBundle(bundle)] : loadErrors;

if (errors.length) {
  console.error(`資料檢查失敗（${dataDir}），共 ${errors.length} 個錯誤：`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`資料檢查通過（${dataDir}）：地圖 ${bundle.maps.length}、章節 ${bundle.story.length}、對話 ${bundle.story.reduce((n, s) => n + (s.dialogues?.length ?? 0), 0)}。`);
