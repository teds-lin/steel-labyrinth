# 測試用夢境資料（E2E）

第三章資料建置進 `web/data/` 之前，E2E 用這份自編的夢境 fixture 驗證入夢／醒來／夢客交談流程。
內容與正式劇情無關（不含任何未公開章節的內容）。

E2E 以 `?test=1&data=__fixture/dream/` 載入（`web/src/config.js` 的 `dataBase()`），並用 `page.route` 提供檔案
（`tests/e2e/dream-fixture.js`）：
- `overlay.json`：manifest 要加上的 maps／story、要附加到既有地圖的物件。
- `maps/`、`story/`：新增的檔案；其餘檔案照常讀 `web/data/`。

夢客 id 用 `lamp`，與 Worker 的 E2E 假人設（`tests/worker/fixtures/dream`）相同：`npm run e2e:cloud` 可以用同一份 fixture 對真的本機 Worker 交談。
