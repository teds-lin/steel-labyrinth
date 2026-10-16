// 從私有企劃 repo 把「已開放」的章節資料複製到 web/data/（防劇透：沒列在 release.json 的章節一律不會出現在公開 repo）。
// 用法：npm run build:data   （企劃 repo 路徑可用環境變數 DESIGN_DIR 覆寫；輸出目錄可用 OUT_DIR 覆寫，測試用；
//       開放章節清單預設 tools/release.json，可用 RELEASE_FILE 指定另一份，例如在暫存目錄實測多章合併）
// 輸出前會遞迴剝除所有 `_` 開頭的私有欄位（見 lib/strip.mjs）。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripPrivate } from './lib/strip.mjs';

const repo = resolve(new URL('..', import.meta.url).pathname);
const designDir = resolve(process.env.DESIGN_DIR || join(repo, '..', 'steel-labyrinth-design'));
const release = JSON.parse(readFileSync(resolve(process.env.RELEASE_FILE || join(repo, 'tools', 'release.json')), 'utf8'));
const out = resolve(process.env.OUT_DIR || join(repo, 'web', 'data'));

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { fail(`無法讀取 ${p}：${e.message}`); }
};
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

if (!Array.isArray(release.unlocked) || release.unlocked.length === 0) fail('tools/release.json 的 unlocked 必須是非空陣列');
if (!existsSync(designDir)) fail(`找不到企劃 repo：${designDir}`);

// 合併各章的資料；同類資料 id 重複就中止（不靜默覆蓋）。
// 根層陣列檔（tiles、items、四個戰鬥檔）與資料夾（maps、story、lineages）。
const ROOT_FILES = ['tiles', 'items', 'characters', 'skills', 'enemies', 'encounters'];
const merged = Object.fromEntries([...ROOT_FILES, 'maps', 'story', 'lineages'].map((k) => [k, new Map()]));
let manifest = null;
const put = (kind, id, value, src) => {
  if (typeof id !== 'string' || !id) fail(`${src} 缺少 id`);
  if (merged[kind].has(id)) fail(`${kind} id 重複：${id}（${src}）`);
  merged[kind].set(id, value);
};

for (const chapter of release.unlocked) {
  const dir = join(designDir, 'story', chapter);
  if (!existsSync(dir)) fail(`找不到章節資料夾：${dir}`);
  for (const kind of ROOT_FILES) {
    const p = join(dir, `${kind}.json`);
    if (!existsSync(p)) continue;
    const rows = readJson(p);
    if (!Array.isArray(rows)) fail(`${p} 必須是陣列`);
    for (const row of rows) put(kind, row?.id, row, p);
  }
  for (const kind of ['maps', 'story', 'lineages']) {
    for (const f of jsonFiles(join(dir, kind))) {
      const p = join(dir, kind, f);
      const data = readJson(p);
      if (`${data.id}.json` !== f) fail(`${p} 的 id（${data.id}）必須與檔名一致`);
      put(kind, data.id, data, p);
    }
  }
  // manifest 只取有 manifest.json 的章節；起始點以第一個提供 manifest 的開放章節為準（新遊戲從最早的章節開始）。
  const mp = join(dir, 'manifest.json');
  if (existsSync(mp) && !manifest) manifest = readJson(mp);
}
if (!manifest) fail('沒有任何章節提供 manifest.json');

// 寫出前清空 web/data/，確保舊的（可能是未開放的）檔案不會殘留。
rmSync(out, { recursive: true, force: true });
for (const kind of ['maps', 'story', 'lineages']) mkdirSync(join(out, kind), { recursive: true });
const write = (p, data) => writeFileSync(join(out, p), JSON.stringify(stripPrivate(data), null, 2) + '\n');

for (const kind of ROOT_FILES) write(`${kind}.json`, [...merged[kind].values()]);
for (const kind of ['maps', 'story', 'lineages']) for (const [id, data] of merged[kind]) write(`${kind}/${id}.json`, data);
write('manifest.json', {
  ...manifest,
  chapters: [...release.unlocked],
  files: { maps: [...merged.maps.keys()], story: [...merged.story.keys()], lineages: [...merged.lineages.keys()] },
});
console.log(`✓ 已輸出 ${release.unlocked.join('、')} 到 ${out}（地圖 ${merged.maps.size}、劇情 ${merged.story.size}、道具 ${merged.items.size}）`);
