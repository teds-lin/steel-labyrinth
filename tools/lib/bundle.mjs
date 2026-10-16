// Node 端讀取 web/data/ 組成 bundle（瀏覽器端請用 fetch 自行組，再交給 core/validate.js）。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readJson(dir, rel, errors) {
  const p = join(dir, rel);
  if (!existsSync(p)) {
    errors.push(`${rel}：讀不到檔案（不存在）`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    errors.push(`${rel}：JSON 解析失敗：${e.message}`);
    return undefined;
  }
}

/**
 * 讀 manifest 與其 files 列出的檔案。回傳 { bundle, errors }；
 * errors 只含「讀檔層級」的問題（缺檔、JSON 壞、檔名與 id 不符），內容規則交給 validateBundle。
 */
export function loadBundle(dataDir) {
  const errors = [];
  const manifest = readJson(dataDir, 'manifest.json', errors);
  if (manifest === undefined) return { bundle: null, errors };
  const files = manifest?.files ?? {};
  const listOf = (kind) => (Array.isArray(files[kind]) ? files[kind] : []);
  const loadKind = (kind) => listOf(kind).flatMap((id) => {
    const rel = `${kind}/${id}.json`;
    const obj = readJson(dataDir, rel, errors);
    if (obj === undefined) return [];
    if (obj?.id !== id) errors.push(`${rel}：檔名是「${id}」但內容的 id 是「${obj?.id}」`);
    return [obj];
  });
  const bundle = {
    manifest,
    tiles: readJson(dataDir, 'tiles.json', errors),
    items: readJson(dataDir, 'items.json', errors),
    lineages: loadKind('lineages'),
    maps: loadKind('maps'),
    story: loadKind('story'),
  };
  return { bundle, errors };
}
