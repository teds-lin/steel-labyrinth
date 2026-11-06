#!/usr/bin/env node
// 用法：node tools/stamp-urls.mjs [web 目錄，預設 web]
// 發布前（tools/stamp-version.mjs 寫入版本之後）把 web 目錄裡所有同源資源網址加上 ?v=<GAME_VERSION>-<HEAD 短 SHA 7 碼>
// （SHA 從 web 目錄所在的 git repo 取；Actions 的 checkout 已是 fetch-depth: 0）：
// index.html 的 script／link、所有模組的 import／export from／動態 import。執行期組出來的網址（資料 JSON、音訊目錄）
// 由 web/src/asset-url.js 的 assetUrl() 在瀏覽器端加上同一個參數（本工具同時把它寫進 src/version.js 的 ASSET_VERSION）。
// 規則與已知限制見 tools/lib/stamp-urls.mjs。
// 改寫後一定跑驗證：任何一個同源 .js／.json 引用沒帶版本（或指向不存在的檔案）就 exit 1。
// 只改工作區（GitHub Actions 的 checkout），不 commit；版本仍是 dev（沒先跑 stamp-version）時拒絕執行。
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stampTree, verifyTree, readTreeVersion, assetToken } from './lib/stamp-urls.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] ?? join(root, 'web'));

let version;
try {
  version = readTreeVersion(dir);
} catch (e) {
  console.error(`讀不到版本：${e.message}`);
  process.exit(1);
}
if (version === 'dev') {
  console.error(`版本仍是 dev（${join(dir, 'src', 'version.js')}）：請先執行 node tools/stamp-version.mjs`);
  process.exit(1);
}

const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
let token;
try {
  if (git.status !== 0) throw new Error((git.stderr || git.error?.message || '').trim());
  token = assetToken(version, git.stdout);
} catch (e) {
  console.error(`取不到 HEAD 的 commit SHA（${dir} 必須在 git repo 裡）：${e.message}`);
  process.exit(1);
}

try {
  const r = await stampTree(dir, token);
  console.log(`已加上 ?v=${token}（GAME_VERSION ${version} 不變）：${r.files} 個檔案、${r.refs} 個引用（${dir}）`);
} catch (e) {
  console.error(`改寫失敗（沒有寫入任何檔案）：${e.message}`);
  process.exit(1);
}

const problems = await verifyTree(dir, token);
if (problems.length) {
  console.error(`驗證失敗：${problems.length} 個問題（同源引用必須一律帶 ?v=${token}，否則同一模組可能被載入兩次）`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('驗證通過：所有同源 .js／.json 引用都帶版本，模組圖中引用的檔案都存在');
