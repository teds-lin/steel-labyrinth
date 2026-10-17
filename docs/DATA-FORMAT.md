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

## 私有註記
原稿可以用 `_` 開頭的欄位寫私有註記（例如 `"_note": "伏筆：……"`），`npm run build:data` 發布前會遞迴剝除。
唯一例外是地圖 `legend` 裡的 `"_"` 鍵（代表地形字元），其他位置的 `"_"` 一律剝除。

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
| `{ "collapse": 5 }` | 崩解值增減（必須是整數；結果夾在 0～100） |
| `{ "use_echo": true }` | 消耗 1 次殘響（同時崩解 +5）。**只能放在選項上**，而且該選項的 `if` 必須保證 `echo_gte ≥ 1` |
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
- 譜系本身已提供 `trace` 時，【殘響】／【回溯】**免費**，不扣次數、不加崩解。
- 【調查】絕不消耗殘響：調查鎖住的物件時只嘗試免費解法（譜系標籤、道具），都沒有就播 `locked`。
- 鎖住的物件如果有 `look`，調查時先播 `look` 再嘗試解鎖；`locked` 只在 `look` 不存在時代替它。

---

# 戰鬥與隊伍（M2 起）

## 新增檔案
```
web/data/
├─ characters.json   主角與隊友
├─ skills.json       技能
├─ enemies.json      敵人
└─ encounters.json   遭遇（敵人組合）
```
`manifest.files` 不需要列這四個檔案（固定檔名，和 tiles／items 一樣）。

## 能力值
| 鍵 | 意義 |
|---|---|
| `hp` | 生命上限 |
| `sp` | 靈性上限（施放技能的消耗） |
| `atk`／`def` | 攻擊／防禦 |
| `spd` | 速度（行動順序） |
| `will` | 意志（減免崩解、抵抗異常狀態） |
| `eva` | 閃避率（%） |

能力值＝`characters.base`＋該角色譜系**已達到的所有階位**（rank ≥ 目前階位）的 `stats` 加總＋裝備（M2 沒有裝備）。由 `deriveStats` 算出，存檔不存。

## characters.json
```json
[ { "id": "hero", "name": "{name}", "sprite": "hero",
    "base": { "hp": 60, "sp": 20, "atk": 10, "def": 6, "spd": 10, "will": 10, "eva": 5 },
    "skills": ["attack", "guard", "shoot"] },
  { "id": "ada", "name": "艾妲・費恩", "sprite": "ada", "lineage": { "id": "dream", "rank": 8 },
    "base": { "hp": 50, "sp": 30, "atk": 7, "def": 5, "spd": 12, "will": 14, "eva": 5 },
    "skills": ["attack", "guard"] } ]
```
- `skills`：不靠譜系的共通技能。實際可用技能＝`skills` ∪ 譜系已達到階位的 `skills`。
- 主角的譜系來自遊戲狀態 `lineage`（喝下靈劑後才有）；隊友的譜系固定寫在這裡。

## lineages/<id>.json 的 rank 擴充
```json
{ "rank": 9, "name": "讀痕者", "field": ["trace"], "skills": ["omen"],
  "stats": { "hp": 10, "sp": 10, "will": 4 } }
```

## skills.json
```jsonc
[ { "id": "omen", "name": "預兆", "desc": "看穿敵人的下一步，並更容易閃避。",
    "cost": { "sp": 4 },               // 選填：sp／ammo
    "target": "enemy",                 // enemy／enemy_all／ally／ally_all／self
    "effects": [ { "type": "reveal_intent" }, { "type": "buff", "stat": "eva", "amount": 40, "turns": 3, "on": "self" } ],
    "tags": [] } ]                     // 選填：例如 "whisper"
```
- 每個效果積木預設作用在技能的 `target`；寫 `"on": "self"` 則作用在施放者自己。

### 效果積木
| type | 欄位 | 說明 |
|---|---|---|
| `damage` | `power`（%）、`stat`（預設 atk）、`ignore_def`、`fixed` | 見傷害公式；有 `fixed` 就是固定傷害 |
| `heal` | `pct`（生命上限的 %）或 `amount` | 回復生命，不超過上限 |
| `sp` | `amount` | 回復／扣除靈性 |
| `buff`／`debuff` | `stat`、`pct`、`turns` | 能力值 ±pct%；同一能力值同類效果取最新的覆蓋 |
| `status` | `status`（sleep／confuse／taunt／guard）、`chance`（%）、`turns` | 機率受目標 `will` 減免：實際機率＝chance × 50 ÷ (50＋will) |
| `reveal_intent` | — | 顯示目標敵人下一次行動（技能與目標） |
| `collapse` | `amount` | 增加主角崩解：實際值＝round(amount × 50 ÷ (50＋主角 will))；主角不在場也照算 |
| `summon` | `enemy`、`max` | 召喚敵人，場上同種敵人不超過 max |

未知的 type 或欄位型別錯誤一律丟錯（validate 會先擋）。

### 公式（引擎與平衡測試共用，改公式必須同步改測試）
- **命中**：攻擊方是敵人時，命中率＝100 − 目標 eva（含增益）；`fixed` 傷害與 `ignore_def` 也會被閃避。
- **傷害**：base＝攻擊方 stat × power ÷ 100；未 `ignore_def` 時 base −＝ 目標 def × 0.5；
  再乘亂數 0.9～1.1、爆擊（5%）× 1.5、目標防禦中（guard）× 0.5；最後 round，最少 1。
- **行動順序（CTB）**：每位行動者有行動值 ct，從 0 開始；每一跳所有人 ct ＋＝ spd，最先達到 100 的人行動，行動後 ct −＝ 100。
  同一跳有多人達到 100：ct 高者先；再平手時我方先於敵方，同陣營依隊伍順序。睡眠中的角色照樣累積 ct，但輪到時跳過並減少睡眠回合。
- **敵人意圖**：敵人在戰鬥開始時、以及每次行動後，立刻決定「下一次行動」（技能與目標）並記在戰鬥狀態裡。
  預兆顯示的就是這個意圖，所以必定成真；目標若在那之前倒下，改打隊伍中下一位存活者（依隊伍順序）。

## enemies.json
```jsonc
[ { "id": "fogwalker", "name": "霧行者", "sprite": "fogwalker", "rank": 9,
    "stats": { "hp": 40, "sp": 0, "atk": 9, "def": 4, "spd": 9, "will": 5, "eva": 5 },
    "skills": ["attack", "whisper_minor"],
    "ai": [ { "skill": "whisper_minor", "weight": 1, "if": { "turn_gte": 2 } }, { "skill": "attack", "weight": 3 } ],
    "phases": [ { "hp_lte_pct": 50, "add_ai": [ { "skill": "call_fog", "weight": 2 } ], "dialogue": "dlg_x" } ],  // 選填
    "drops": [ { "item": "bandage", "chance": 30 } ] } ]
```
- AI：先過濾 `if` 成立的規則，再依 weight 加權抽選（用戰鬥 PRNG）；至少要有一條沒有 `if` 的規則。
- 戰鬥條件：`hp_lte_pct`、`turn_gte`、`allies_lte`（場上敵人數）、`target_has_status`、`all`／`any`／`not`。
- 目標選擇：單體技能選我方「生命比例最低」者；有 taunt 的角色優先。

## encounters.json
```jsonc
[ { "id": "enc_dock_1", "enemies": ["fogwalker", "fogwalker"], "bg": "dock",
    "can_flee": true,
    "on_win": { "effects": [ { "set_flag": "dock_fight_1" } ], "dialogue": "dlg_after_fight" },
    "on_lose": "retry" } ]             // retry＝回到戰前自動存檔；continue＝照樣執行 on_win 的劇情（教學戰用）
```

## 地圖與對話的擴充
- 物件與觸發點可以加 `"battle": "enc_id"`：調查物件或踩到觸發點時，先播 `look`／`dialogue`（若有），再開始戰鬥。
- 新增對話效果：
| 寫法 | 意義 |
|---|---|
| `{ "battle": "enc_id" }` | 這段對話結束後開始戰鬥 |
| `{ "set_lineage": { "id": "trace", "rank": 9 } }` | 主角成為該譜系、階位 |
| `{ "join_party": "ada" }`／`{ "leave_party": "ada" }` | 隊友加入／離開（隊伍最多 3 人，主角永遠在） |
| `{ "give_ammo": 6 }` | 子彈增加（上限 12） |
| `{ "heal_party": true }` | 全隊生命與靈性回滿 |
| `{ "goto": { "map": "office", "spawn": "door", "dialogue": "dlg_x" } }` | 對話結束後移動到其他地圖（dialogue 選填） |
- story 的 `end_screen` 可以加 `"continue": { "map": …, "spawn": …, "dialogue": … }`：章節結束畫面出現「繼續」，進入下一章。
- 新增條件：`{ "in_party": "ada" }`、`{ "ammo_gte": 1 }`。

## 存檔 v2（新增的事實欄位）
```jsonc
{ "schema_version": 2,
  "party": [ { "id": "hero", "hp": 70, "sp": 30 }, { "id": "ada", "hp": 50, "sp": 30 } ],   // 目前值；上限由 deriveStats 算
  "ammo": 3,
  "pending": null }                    // 對話結束後要執行的事（battle／goto），存檔時一律為 null
```
- v1→v2 遷移：`party` ＝ 只有主角、生命與靈性為滿值（遷移時無法算上限，記為 `null`，讀檔時由 `sanitizeLoadedState` 補成上限）；`ammo` ＝ 持有 revolver 時 3，否則 0。
- 讀檔驗證：hp／sp 為 0 以上的整數或 null（超過上限時夾到上限並警告 `party_clamped`，不拒絕，以免調降數值後舊存檔無法讀取）；隊伍成員必須存在於 characters.json、主角必須在第一位、不可重複；ammo 0～12 整數。
- 戰鬥開始前自動存檔到 `steel-labyrinth:save:auto`，給「重新挑戰」使用；不占用 3 個手動存檔槽。

## 規格補充（2026-10-16，依第一、二章設計回饋定案）
1. **道具**：items.json 的道具可以加
   - `"target"`（同技能的 target）＋`"battle_effects": [效果積木]`：戰鬥中使用，用掉 1 個。
   - `"field_effects": [對話效果]`：在地圖選單中使用（例如鎮靜香 `{ "collapse": -15 }`），用掉 1 個。
   兩者都沒有的道具是劇情道具，不能使用。
2. **buff／debuff 可以用加法**：寫 `"amount": 20` 代表能力值直接 ±20（eva 這類百分比能力值請用 amount）；`pct` 與 `amount` 擇一。
3. **意志減免只套用在敵對效果**：`status` 的機率減免、只有在「施放者與目標不同陣營」時才計算；我方對自己或隊友施放的 guard、taunt 必定成功。
4. **崩解減免只套用在增加**：`collapse` 的 amount 為負（降低崩解）時不受意志縮放。崩解只屬於主角，`collapse` 積木不論 target 是誰都作用在主角身上。
5. **phases**：`add_ai`、`dialogue` 都是選填。一次攻擊跨過多個門檻時，依門檻由高到低依序觸發，每段只觸發一次。
6. **免費可達性分析**的入口也包含：`goto` 的 dialogue、`end_screen.continue` 的地圖與 dialogue、遭遇 `on_win.dialogue`（遭遇本身必須能從免費入口觸發）。

## 規格補充 2（2026-10-17，依 M2 第一輪對抗審查定案）
1. **重新挑戰**：戰敗或失控後的「重新挑戰」＝戰前狀態，但全隊生命、靈性回滿，崩解改為 min(戰前崩解, 60)。由核心 `prepareRetry(preState, data)` 計算。
2. **睡眠**：受到傷害（damage 事件 amount ≥ 1）就會醒來，移除 sleep 狀態。
3. **預兆的收益**：被 `reveal_intent` 揭露的意圖，在該敵人執行它時，對我方造成的傷害 × 0.5、`collapse` 增加量 × 0.5（在其他減免之後計算，結果 round，最少 1 才算命中傷害）。揭露的意圖在施放時就寫進 log 的 `intent_revealed`，畫面必須立刻顯示，不依賴之後再查詢。
4. **崩解要命中才算**：一次行動的所有目標都閃避時，該行動的 `collapse` 不生效。
5. **階段對話**：`phases[].dialogue` 只能有 `set_flag`／`clear_flag` 效果，其他效果 validate 報錯。
6. **選單位置**：技能可以加 `"menu": "root"`，表示顯示在戰鬥指令第一層（例如攻擊、開槍、防禦）；其他技能在「技能」子選單。
7. **召喚訊息**：敵人可以加 `"summon_text"`（例如「從霧裡出現了！」），沒有就用「{name}出現了！」。
8. **共鳴顯示**：譜系可以加 `"show_resonance": true`，主角屬於該譜系時 HUD 顯示共鳴度。
9. **逃跑**：逃跑成功後，玩家回到踩上觸發點之前的那一格（物件觸發的戰鬥則留在原地）。
10. **validate 新增**：每名角色（主角與隊友）至少有一個不消耗任何資源的技能；`join_party` 造成的隊伍人數靜態上限不超過 3；敵人 `ai` 只能引用自己 `skills` 裡的技能；我方技能不能有 `summon`；角色在任何已開放階位的能力值都必須 > 0（hp、spd 至少 1）；遭遇最多 3 名敵人（含召喚上限合計不超過 4）。
11. 計畫 S2 提到的 `battle_seed` **不存檔**：每次開戰（含重新挑戰）都產生新種子。

## 規格補充 3（2026-10-17，依 M2 第二輪對抗審查定案）
1. **重新挑戰不能撈好處**：重新挑戰的那場戰鬥一律不能逃跑；結束（勝利或 continue）時，崩解寫回 max(戰後崩解, 戰前崩解)。生命、靈性照戰後的值。
2. **催眠要有正收益**：睡眠中的目標受到的**第一次**傷害 × 1.5（在其他倍率之後、round 之前計算），然後醒來（`wake` 事件）。
3. **隊伍上限檢查**：validate 計算「可能同時在隊」的人數時要算進 `leave_party`；輪替隊友（任何時刻 ≤ 3 人）不可誤報。
4. **一次性觸發點的戰鬥**：觸發點同時有 `once: true` 與可逃跑（`can_flee: true`）的 `battle` 時，validate 報錯（逃跑後遭遇會永久消失）；請改用 `if: { not_flag }` 搭配勝利旗標。
5. **逃跑退回**：前一格目前不能站（`canMove` 為 false）時，留在原地。

---

# 鐘塔之夢（M4 起）

## 地圖
- 地圖可以加 `"dream": true`：這是夢境地圖。進入夢境時記住現實的位置，醒來時回到那裡。
- 夢境地圖的物件可以加 `"guest": "three"`：夢客。調查時先播 `look` 對話；`look` 對話可以有效果 `{ "open_chat": "three" }`，對話結束後開啟自由交談介面（需要雲端；未啟用時播放 `"not_open"` 預寫台詞）。

## 入夢與醒來（對話效果）
| 寫法 | 意義 |
|---|---|
| `{ "enter_dream": { "map": "clocktower", "spawn": "center" } }` | 對話結束後入夢：記住目前的現實位置到 `state.dream_return`，移動到夢境地圖 |
| `{ "wake": true }` | 對話結束後醒來：回到 `state.dream_return`，並清除它 |
| `{ "open_chat": "three" }` | 對話結束後開啟與該夢客的自由交談 |

- 現實地圖的物件可以加 `"dream": { "if": {條件} }`：調查時在 `look` 之後多一個選項「入夢」（條件成立才出現；文字可以自訂，見下方補充 5）。
- 存檔 v3：新增 `dream_return`（null 或 `{ map, x, y, dir }`）。v2→v3 遷移補 null。夢境中存檔、讀檔都允許；讀檔時 `dream_return` 指向的地圖必須存在，否則改成該章的預設起點並警告。

## 夢客的預寫台詞（公開，放在章節的 story 檔）
```jsonc
{ "id": "chapter3", "guests": [
  { "id": "three", "name": "三點", "sprite": "guest_three",
    "scripted": {
      "greeting": ["……又見面了。", "鐘聲還沒響完，你可以多待一會兒。"],
      "fallback": ["霧太濃了，我聽不清楚你說什麼。"],     // ai_error
      "quota":    ["夢境變得模糊了，今天先聊到這裡吧。"],   // quota／budget
      "filtered": ["……我好像說錯話了，當我沒說。"],        // filtered
      "not_open": ["（啟用雲端存檔後，可以和夢客自由交談。）"] } } ] }
```
- 這些台詞只能寫已開放章節的內容；夢客的人設、知識卡與 AI 提示詞**不放在公開資料**。

## 補充（2026-10-17，依第三章設計回饋）
1. 現實物件的入夢欄位必須寫明目的地：`"dream": { "if": {條件}, "map": "clocktower", "spawn": "center" }`（`if` 選填；`map` 必須是 `dream: true` 的地圖；`spawn` 必須存在）。
2. `wake` 可以帶醒來後要播的對話：`{ "wake": true }` 或 `{ "wake": { "dialogue": "dlg_x" } }`。
3. `open_chat` 可以放在節點或選項的 effects（和其他效果一樣）。
4. 夢客的 AI 提示詞**不包含玩家的真名**；鐘塔裡一律以代號（主角為「十二點」）稱呼。
5. 入夢選項的文字可以由資料提供（選填）：`"dream": { "if": {條件}, "map": "clocktower", "spawn": "center", "prompt": "提示文字", "yes": "入夢的選項", "no": "不入夢的選項" }`。
   - 三個欄位都是選填、各自獨立；沒寫的用預設：`prompt`「一陣倦意湧上來。遠處好像有鐘聲。」、`yes`「入夢」、`no`「留在現實」。
   - 必須是非空字串（只有空白也不行），否則 validate 報錯；文字可以用 `{name}`（和對話一樣代入）。
   - 選項順序固定：第一個是 `yes`（入夢），第二個是 `no`。
   - 這些文字屬於玩家看得到的字串，`tools/export-strings.mjs` 會匯出（`unique_id`：`maps/<地圖>.json#<物件>.dream.<欄位>`）。
