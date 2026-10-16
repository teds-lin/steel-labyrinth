# 資料格式（引擎與內容的共同約定）

所有遊戲內容都是 JSON，放在 `web/data/`。引擎（`web/src/core/`）只解讀資料，不寫死任何內容。
所有清單一律用**陣列＋`id` 欄位**（不用物件的 key 當 id，因為 JSON 重複的 key 會被靜默覆蓋）。
`npm run check` 會強制檢查 id 唯一、引用存在、劇情沒有死路。

## 目錄

```
web/data/
├─ manifest.json        已開放章節與起始點
├─ tiles.json           地形種類
├─ items.json           道具
├─ lineages/<id>.json   譜系（只放已開放的階位）
├─ maps/<id>.json       地圖
└─ story/<chapter>.json 該章的全部對話
```

## manifest.json
```json
{ "chapters": ["prologue"],
  "start": { "map": "attic", "spawn": "default", "dialogue": "dlg_opening" },
  "files": { "maps": ["attic"], "story": ["prologue"], "lineages": ["trace"] } }
```

- `start.echo_charges`（選填，預設 0）：新遊戲的殘響次數。序章為 3。

## tiles.json
```json
[ { "id": "wall", "solid": true, "color": "#2b2f3a" }, { "id": "floor", "solid": false, "color": "#5a5248" },
  { "id": "gas_lamp", "solid": true, "color": "#e0a050", "glow": true } ]
```
- `solid` 必須是布林值；`glow`（選填，布林）為 true 時畫面會在該格加上燈光光暈。

## items.json
```json
[ { "id": "attic_key", "name": "閣樓鑰匙", "desc": "……" } ]
```

## lineages/<id>.json
```json
{ "id": "trace", "source": "mirror", "nature": "看穿真相",
  "ranks": [ { "rank": 9, "name": "讀痕者", "field": ["trace"] } ] }
```
- `ranks` 是陣列，每筆用 `rank`（數字）當識別，同一譜系內不可重複。
- 公開資料只放**已開放**的階位（防劇透），更高階位留在私有企劃 repo。

## maps/<id>.json
```jsonc
{
  "id": "attic", "name": "鐵橋街 17 號・閣樓",
  "tiles": ["##########", "#........#"],          // 每列等長；字元對應 legend
  "legend": { "#": "wall", ".": "floor" },         // 值必須是 tiles.json 的 id
  "spawns": [ { "id": "default", "x": 2, "y": 2, "dir": "down" } ],   // dir: up/down/left/right
  "on_enter": "dlg_xxx",                           // 選填：第一次進入時觸發（自動記旗標 enter:<map id>）
  "objects": [
    { "id": "obj_vial", "x": 6, "y": 1, "sprite": "vial", "solid": true,
      "look": "dlg_vial_look",                     // 【調查】
      "echo": "dlg_vial_echo",                     // 選填：【殘響】
      "if": { "not_flag": "vial_broken" } },       // 選填：條件成立才出現
    { "id": "obj_door", "x": 5, "y": 7, "sprite": "door", "solid": true,
      "look": "dlg_door_look",
      "lock": {
        "flag": "door_open",                       // 解開後設定的旗標；旗標成立時物件視為已解開
        "solvable_by": ["trace"],                  // 可以解開它的探索標籤
        "fallback": "item:attic_key",              // 必填：不靠能力的解法（目前只支援 item:<id>）
        "on_tag": { "trace": "dlg_door_echo" },    // 用標籤解開時播放的對話
        "on_item": "dlg_door_key",                 // 用道具解開時播放的對話
        "locked": "dlg_door_locked" } }            // 還打不開時播放的對話
  ],
  "exits": [ { "x": 5, "y": 8, "to": "stairs", "spawn": "from_attic",
               "requires": { "flag": "door_open" }, "blocked": "dlg_door_locked" } ],
  "triggers": [ { "id": "trg_window", "x": 3, "y": 4, "dialogue": "dlg_xxx", "once": true, "if": { } } ]
}
```
- 座標從 0 開始，`(x, y)` = 第 y 列第 x 個字元。
- 物件、出口、觸發點的座標必須在地圖範圍內，而且都不可放在 solid 地形上。
- 出口與觸發點是「踩上去就觸發」的格子；出口不可以和 solid 物件重疊（否則永遠踩不到）。
- 門這類 lock 物件放在通道上，出口放在門後面那一格。
- 已解開的 lock 物件不再阻擋（`solid` 失效），代表門打開了。

## story/<chapter>.json
```jsonc
{ "id": "prologue", "title": "序章",
  "end_screen": { "title": "序章　完", "subtitle": "第一章　製作中" },   // chapter_end 後的畫面文字
  "dialogues": [
  { "id": "dlg_vial_look", "start": "n1", "nodes": [
    { "id": "n1", "speaker": null, "text": "桌上有一個空藥瓶……", "next": "n2" },
    { "id": "n2", "speaker": "{name}", "text": "這是……我喝的？", "effects": [ { "set_flag": "saw_vial" } ], "next": "END" },
    { "id": "n3", "text": "要怎麼回答？", "choices": [
        { "text": "說實話", "next": "n4", "effects": [ { "set_flag": "told_truth" } ] },
        { "text": "看穿她", "if": { "echo_gte": 1 }, "next": "n5", "effects": [ { "use_echo": true } ] } ] }
  ] } ] }
```
- 節點必須有 `next`（節點 id 或 `"END"`）或 `choices`（至少一個選項，每個選項都有 `next`）。
- 條件分歧：節點可以加 `"branches": [ { "if": {…}, "next": "nX" } ]`，在節點的文字與效果處理完後依序檢查，
  第一個成立的就走它的 `next`；都不成立就走節點本身的 `next`（所以有 `branches` 的節點也必須有 `next`）。
  `branches` 和 `choices` 不能同時出現。節點可以沒有 `text`（純分歧節點，不顯示任何東西）。
- 會給道具或一次性旗標的對話，請用 `branches` 檢查旗標，避免重複調查時重複取得。
- `speaker`：`null` 是旁白；`"{name}"` 是主角；其他字串是 NPC 名字。
- `text` 與 `speaker` 可以使用 `{name}`，會代入主角名字。
- 所有節點都必須能從 `start` 走到，而且至少有一條路走到 `END`。
- 選項的 `if` 不成立時不顯示；同一節點至少要有一個選項**沒有** `if`，確保永遠有路可走。

## 條件（condition）
| 寫法 | 意義 |
|---|---|
| `{ "flag": "x" }` | 旗標 x 成立 |
| `{ "not_flag": "x" }` | 旗標 x 不成立 |
| `{ "item": "id" }` | 持有道具 |
| `{ "echo_gte": 1 }` | 殘響剩餘次數 ≥ n |
| `{ "lineage": "trace" }` | 目前譜系 |
| `{ "rank_lte": 8 }` | 階位數字 ≤ n（數字越小越強） |
| `{ "all": [ ... ] }`／`{ "any": [ ... ] }`／`{ "not": { ... } }` | 組合 |

未知的條件寫法一律**丟錯**，不可以當成成立。

## 效果（effect）
| 寫法 | 意義 |
|---|---|
| `{ "set_flag": "x" }`／`{ "clear_flag": "x" }` | 設定／清除旗標 |
| `{ "give_item": "id" }`／`{ "take_item": "id" }` | 取得／失去道具 |
| `{ "resonance": "lie_exposed" }` | 觸發共鳴事件（累加計數） |
| `{ "collapse": 5 }` | 崩解值增減（範圍 0～100） |
| `{ "use_echo": true }` | 消耗 1 次殘響（同時崩解 +5） |
| `{ "chapter_end": "prologue" }` | 章節結束 |

未知的效果寫法一律丟錯。

## 遊戲狀態（存檔只存這些事實）
```jsonc
{ "schema_version": 1,
  "player": { "name": "雷恩・葛雷" },
  "lineage": null,                      // 或 { "id": "trace", "rank": 9 }
  "location": { "map": "attic", "x": 2, "y": 2, "dir": "down" },
  "flags": { "door_open": true },
  "items": { "attic_key": 1 },
  "echo": { "charges": 3 },
  "collapse": 0,
  "resonance": { "lie_exposed": 1 },
  "chapter": "prologue", "chapter_done": [],
  "playtime_s": 0 }
```

## 讀檔驗證
讀檔一律經過 `deserialize`（格式）與 `sanitizeLoadedState(state, data)`（語意）：
- 數值：`echo.charges` 為 0～99 的整數、`collapse` 為 0～100 的整數、`playtime_s` ≥ 0、道具數量為正整數，否則拒絕讀檔。
- 名字：重新經過 `sanitizeName`。
- 譜系：`lineage` 為 null，或 id 存在於資料中、rank 是該譜系已開放的階位，否則拒絕。
- 位置：地圖必須存在（否則拒絕）；座標不是整數、超出範圍、在 solid 地形或 solid 物件上、方向不合法時，**改放到該地圖第一個 spawn** 並附上警告，不拒絕。
- 拒絕時回傳 `{ ok:false, reason }`，存檔槽在畫面上顯示為「已損壞」或「版本較新」。

## 探索標籤從哪裡來
`availableFieldTags(state, data)` ＝ 目前譜系「已達到的階位」的 `field` 標籤 ∪ 暫時能力。
序章的暫時能力是殘響：`echo.charges > 0` 時提供 `trace` 標籤，用一次扣一次。
- 譜系本身已提供 `trace` 時（例如之後喝下讀痕者靈劑），【殘響】／【回溯】**免費**，不扣次數、不加崩解。
- 【調查】絕不消耗殘響：調查鎖住的物件時只嘗試免費解法（譜系標籤、道具），都沒有就播 `locked`。
- 鎖住的物件如果有 `look`，調查時先播 `look` 再嘗試解鎖；`locked` 只在 `look` 不存在時代替它。
