// 測試用：把資料夾（manifest＋files＋固定檔名）讀成和瀏覽器 data-loader 相同格式的 bundle。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const M5_FIXTURE_DIR = fileURLToPath(new URL('../fixtures/m5/', import.meta.url));
export const WEB_DATA_DIR = fileURLToPath(new URL('../../web/data/', import.meta.url));

const read = (dir, rel) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

export function loadDir(dir) {
  const manifest = read(dir, 'manifest.json');
  const list = (k) => (manifest.files?.[k] ?? []).map((id) => read(dir, `${k}/${id}.json`));
  const opt = (k) => (existsSync(join(dir, `${k}.json`)) ? read(dir, `${k}.json`) : []);
  return {
    manifest, tiles: read(dir, 'tiles.json'), items: read(dir, 'items.json'),
    lineages: list('lineages'), maps: list('maps'), story: list('story'),
    characters: opt('characters'), skills: opt('skills'), enemies: opt('enemies'), encounters: opt('encounters'),
  };
}
