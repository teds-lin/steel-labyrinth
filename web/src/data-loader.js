// 瀏覽器端組 bundle：格式與 tools/lib/bundle.mjs 相同（manifest＋files 列出的檔案＋戰鬥資料四個固定檔）。
// 讀檔層級的問題（缺檔、JSON 壞、檔名與 id 不符）收進 errors，內容規則交給 core/validate.js。
import { validateBundle } from './core/validate.js';

/** 戰鬥資料的固定檔名（manifest.files 不列，與 tools/lib/bundle.mjs 的 BATTLE_FILES 相同）；不存在時視為空陣列。 */
export const BATTLE_FILES = ['characters', 'skills', 'enemies', 'encounters'];

async function fetchJson(base, rel, errors, { optional = false } = {}) {
  let res;
  try {
    res = await fetch(new URL(rel, base), { cache: 'no-cache' });
  } catch (e) {
    errors.push(`${rel}：讀不到檔案（網路錯誤：${e?.message ?? e}）`);
    return undefined;
  }
  if (optional && res.status === 404) return [];
  if (!res.ok) {
    errors.push(`${rel}：讀不到檔案（HTTP ${res.status}）`);
    return undefined;
  }
  try {
    return JSON.parse(await res.text());
  } catch (e) {
    errors.push(`${rel}：JSON 解析失敗：${e.message}`);
    return undefined;
  }
}

/** 回傳 { bundle, errors }；errors 含讀檔錯誤與 validateBundle 的內容錯誤。 */
export async function loadBundle(baseUrl = new URL('data/', document.baseURI)) {
  const errors = [];
  const manifest = await fetchJson(baseUrl, 'manifest.json', errors);
  if (manifest === undefined) return { bundle: null, errors };
  const files = manifest?.files ?? {};
  const listOf = (kind) => (Array.isArray(files[kind]) ? files[kind] : []);
  const loadKind = async (kind) => {
    const objs = await Promise.all(listOf(kind).map(async (id) => {
      const rel = `${kind}/${id}.json`;
      const obj = await fetchJson(baseUrl, rel, errors);
      if (obj === undefined) return null;
      if (obj?.id !== id) errors.push(`${rel}：檔名是「${id}」但內容的 id 是「${obj?.id}」`);
      return obj;
    }));
    return objs.filter((o) => o !== null);
  };
  const [tiles, items, lineages, maps, story, ...battle] = await Promise.all([
    fetchJson(baseUrl, 'tiles.json', errors),
    fetchJson(baseUrl, 'items.json', errors),
    loadKind('lineages'),
    loadKind('maps'),
    loadKind('story'),
    ...BATTLE_FILES.map((kind) => fetchJson(baseUrl, `${kind}.json`, errors, { optional: true })),
  ]);
  const bundle = { manifest, tiles, items, lineages, maps, story };
  BATTLE_FILES.forEach((kind, i) => { bundle[kind] = battle[i] ?? []; });
  if (errors.length === 0) errors.push(...validateBundle(bundle));
  return { bundle, errors };
}
