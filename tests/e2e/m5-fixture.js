// M5（第一部完結）E2E 共用：測試用資料 tests/fixtures/m5（以 ?data=__fixture/full/ 載入）、v4 存檔、晉升演出的操作。
// 第四章～終章的正式資料建置進 web/data 之前，晉升／交換／結局的畫面都用這份自編的 fixture 驗證（內容與正式劇情無關）。
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useDataDir, DATA_DIR_PREFIX } from './dream-fixture.js';

export const M5_DIR = fileURLToPath(new URL('../fixtures/m5', import.meta.url)); // 結尾不加斜線（safeJoin 會補）
export const M5_URL = `./?test=1&data=${DATA_DIR_PREFIX}`;
export const M5_DATA = DATA_DIR_PREFIX;

export const useM5Fixture = (page) => useDataDir(page, M5_DIR);

/** v4 存檔（fixture 的第四章、鏡之間；讀痕者 階 9）。override 淺層合併。 */
export function makeSaveV4(override = {}) {
  return {
    schema_version: 4,
    player: { name: '艾琳' },
    lineage: { id: 'trace', rank: 9 },
    location: { map: 'fx_room', x: 4, y: 3, dir: 'down' },
    flags: {},
    items: {},
    echo: { charges: 0 },
    collapse: 0,
    resonance: {},
    chapter: 'fx_ch4',
    chapter_done: [],
    playtime_s: 30,
    party: [{ id: 'hero', hp: null, sp: null }],
    ammo: 0,
    pending: null,
    dream_return: null,
    promotions: [],
    ending: null,
    ...override,
  };
}

/** 夢中鐘塔（九點旁邊）的存檔。 */
export const dreamSave = (override = {}) => makeSaveV4({
  location: { map: 'fx_dream', x: 5, y: 2, dir: 'right' },
  dream_return: { map: 'fx_room', x: 3, y: 5, dir: 'left' },
  ...override,
});

export async function shot(page, testInfo, name) {
  await page.screenshot({ path: testInfo.outputPath(`${name}-${testInfo.project.name}.png`) });
  if (process.env.SL_SHOT_DIR) await page.screenshot({ path: join(process.env.SL_SHOT_DIR, `${name}-${testInfo.project.name}.png`) });
}

/** 晉升演出：等它出現（可以關閉），回傳演出內容。 */
export async function waitPromotionFx(page) {
  await page.waitForFunction(() => window.__SL.hud()?.promotion?.ready === true, null, { timeout: 8_000 });
  return page.evaluate(() => window.__SL.hud().promotion);
}

/** 關閉晉升演出：手機點畫面、桌機按空白鍵。 */
export async function dismissPromotionFx(page, g, touch) {
  if (touch) await g.tap(180, 300); else await g.key('Space');
  await page.waitForFunction(() => !window.__SL.hud()?.promotion, null, { timeout: 5_000 });
}
