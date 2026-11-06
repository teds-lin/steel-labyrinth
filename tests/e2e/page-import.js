// 頁面內 import 遊戲模組的唯一入口：window.__slImport('./src/session.js')。
// 發布版的模組網址都帶 ?v=<ASSET_VERSION>（tools/stamp-urls.mjs）；同一個模組只要用不同網址 import，瀏覽器就會建立第二個實例
// （例如另一份空的 session）。所以這裡沿用頁面「實際載入的 main.js」的查詢字串，保證拿到與遊戲同一個模組實例。
// 本機（版本 'dev'）main.js 不帶查詢字串，結果與以前直接用相對路徑 import 相同。
// 這個檔案不 import Playwright：純函式部分由 vitest 測試（tests/core/e2e-page-import.test.js）。

/** path（相對於頁面）＋頁面上 main.js 的網址 → 與遊戲同一版的模組網址。找不到 main.js 就丟錯。 */
export function moduleUrlFor(path, mainSrc, baseURI) {
  if (!mainSrc) throw new Error('頁面上找不到 main.js 的 <script type="module">，無法決定模組版本');
  const u = new URL(path, baseURI);
  u.search = new URL(mainSrc, baseURI).search;
  return u.href;
}

/** 注入頁面的腳本（自足的字串，每次導覽都會重新執行）：定義 window.__slImport(path)。 */
export const PAGE_IMPORT_SCRIPT = `(() => {
  const moduleUrlFor = ${moduleUrlFor.toString()};
  Object.defineProperty(window, '__slImport', {
    configurable: true,
    value: (path) => {
      const main = document.querySelector('script[type="module"][src*="main.js"]');
      return import(moduleUrlFor(path, main && main.src, document.baseURI));
    },
  });
})();`;

/** 在 page 上安裝 window.__slImport（helpers.js 的 test fixture 會自動呼叫）。 */
export async function installPageImport(page) {
  await page.addInitScript({ content: PAGE_IMPORT_SCRIPT });
}
