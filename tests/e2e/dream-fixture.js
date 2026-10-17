// 用 ?data= 測試掛勾載入額外的內容資料（web/src/config.js 的 dataBase()）。
// - useDreamFixture：tests/fixtures/dream 的測試用夢境（overlay：在正式資料上加地圖、劇情、物件）。
// - useDataDir：整份資料夾（例如在 scratchpad 建置、含第三章的資料；不進 repo）。
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_DATA = join(ROOT, 'web', 'data');
const FIX = join(ROOT, 'tests', 'fixtures', 'dream');
export const DREAM_FIXTURE_PREFIX = '__fixture/dream/';
export const DATA_DIR_PREFIX = '__fixture/full/';

const json = (route, obj) => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(obj) });
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
/** 只允許 base 底下的相對路徑。 */
function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  return p.startsWith(base + sep) ? p : null;
}

export async function useDreamFixture(page) {
  const overlay = readJson(join(FIX, 'overlay.json'));
  await page.route(`**/${DREAM_FIXTURE_PREFIX}**`, async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.split(`/${DREAM_FIXTURE_PREFIX}`)[1] ?? '');
    if (rel === 'manifest.json') {
      const m = readJson(join(WEB_DATA, 'manifest.json'));
      for (const [k, ids] of Object.entries(overlay.add)) m.files[k] = [...(m.files[k] ?? []), ...ids];
      await json(route, m);
      return;
    }
    const own = safeJoin(FIX, rel);
    if (own && existsSync(own) && rel !== 'overlay.json') { await json(route, readJson(own)); return; }
    const real = safeJoin(WEB_DATA, rel);
    if (!real || !existsSync(real)) { await route.fulfill({ status: 404, body: 'not found' }); return; }
    const data = readJson(real);
    const m = /^maps\/([a-z0-9_]+)\.json$/.exec(rel);
    if (m && overlay.objects[m[1]]) data.objects = [...(data.objects ?? []), ...overlay.objects[m[1]]];
    await json(route, data);
  });
}

/** 整份資料夾（dir 是本機絕對路徑）以 ?data=__fixture/full/ 提供。 */
export async function useDataDir(page, dir) {
  await page.route(`**/${DATA_DIR_PREFIX}**`, async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.split(`/${DATA_DIR_PREFIX}`)[1] ?? '');
    const p = safeJoin(dir, rel);
    if (!p || !existsSync(p)) { await route.fulfill({ status: 404, body: 'not found' }); return; }
    await json(route, readJson(p));
  });
}
