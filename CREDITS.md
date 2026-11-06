# 音效素材來源（CREDITS）

> 本檔由 `node tools/audio-encode.mjs --credits` 依 `tools/audio-recipe.json` 自動產生，請勿手改。
> 授權頁面的存檔放在私有企劃 repo 的 `assets-licenses/`。

《鋼鐵迷都》的音效、背景音樂與環境音都是第三方公開授權素材，經裁切、正規化（音效用峰值、音樂與環境音用響度）、
循環接縫交叉淡化，重新編碼成 Ogg Vorbis 與 AAC（m4a）兩種格式。標示「MIDI 渲染」的音樂是用 CC0 的 MIDI 樂譜改編配器後，
以 MIT 授權的音色庫離線渲染而成（音色庫的授權全文附在本檔最後）。
鐘聲（入夢、醒來、遠方鐘聲）與霧笛是程式即時合成，沒有音檔。

## 每個音檔

| 檔案 | 用途 | 原始素材 | 作者 | 授權 | 來源網址 |
|---|---|---|---|---|---|
| `sfx/ui_move.ogg`、`sfx/ui_move.m4a` | 選單游標移動 | Interface Sounds（Audio/select_001.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/interface-sounds |
| `sfx/ui_confirm.ogg`、`sfx/ui_confirm.m4a` | 確認 | Interface Sounds（Audio/confirmation_001.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/interface-sounds |
| `sfx/ui_cancel.ogg`、`sfx/ui_cancel.m4a` | 返回、取消 | Interface Sounds（Audio/back_001.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/interface-sounds |
| `sfx/ui_error.ogg`、`sfx/ui_error.m4a` | 無法使用的項目 | Interface Sounds（Audio/error_004.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/interface-sounds |
| `sfx/ui_save.ogg`、`sfx/ui_save.m4a` | 存檔成功 | Interface Sounds（Audio/maximize_003.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/interface-sounds |
| `sfx/map_investigate.ogg`、`sfx/map_investigate.m4a` | 調查 | Interface Sounds（Audio/pluck_001.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/interface-sounds |
| `sfx/text_tick.ogg`、`sfx/text_tick.m4a` | 對話送字 | Typewriter sounds（typewriter6.wav） | Cassie-OrbitGames | CC0 1.0 | https://opengameart.org/content/typewriter-sounds |
| `sfx/map_echo.ogg`、`sfx/map_echo.m4a` | 殘響、回溯 | Reversing Time / Stuck in Time（Reverse-Time-Loop-isaiah658_0.ogg） | isaiah658 | CC0 1.0 | https://opengameart.org/content/reversing-time-stuck-in-time |
| `sfx/map_door.ogg`、`sfx/map_door.m4a` | 換地圖、開鎖 | 50 RPG sound effects（OGG/doorOpen_1.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/50-rpg-sound-effects |
| `sfx/item_get.ogg`、`sfx/item_get.m4a` | 取得道具 | 50 RPG sound effects（OGG/handleSmallLeather.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/50-rpg-sound-effects |
| `sfx/bt_miss.ogg`、`sfx/bt_miss.m4a` | 戰鬥：未命中 | 50 RPG sound effects（OGG/cloth1.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/50-rpg-sound-effects |
| `sfx/bt_hit.ogg`、`sfx/bt_hit.m4a` | 戰鬥：敵人受傷 | 100 CC0 SFX（hit_01.ogg） | rubberduck | CC0 1.0 | https://opengameart.org/content/100-cc0-sfx |
| `sfx/bt_crit.ogg`、`sfx/bt_crit.m4a` | 戰鬥：爆擊 | 100 CC0 SFX（hit_04.ogg） | rubberduck | CC0 1.0 | https://opengameart.org/content/100-cc0-sfx |
| `sfx/bt_hurt.ogg`、`sfx/bt_hurt.m4a` | 戰鬥：我方受傷 | 100 CC0 SFX（hit_02.ogg） | rubberduck | CC0 1.0 | https://opengameart.org/content/100-cc0-sfx |
| `sfx/bt_shot.ogg`、`sfx/bt_shot.m4a` | 戰鬥：開槍 | 100 CC0 SFX（shot_02.ogg） | rubberduck | CC0 1.0 | https://opengameart.org/content/100-cc0-sfx |
| `sfx/bt_down.ogg`、`sfx/bt_down.m4a` | 戰鬥：敵人倒下 | 100 CC0 SFX（slam_01.ogg） | rubberduck | CC0 1.0 | https://opengameart.org/content/100-cc0-sfx |
| `sfx/bt_skill.ogg`、`sfx/bt_skill.m4a` | 戰鬥：增益、減益、治療等技能 | Magic Spell SFX（magical_2.ogg） | JaggedStone | CC0 1.0 | https://opengameart.org/content/magic-spell-sfx |
| `sfx/jingle_victory.ogg`、`sfx/jingle_victory.m4a` | 戰鬥勝利（撥弦短樂句） | 85 Short music jingles（OGG/jingles_PIZZA/jingles_PIZZA03.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/85-short-music-jingles |
| `sfx/jingle_defeat.ogg`、`sfx/jingle_defeat.m4a` | 戰敗（撥弦下行短樂句） | 85 Short music jingles（OGG/jingles_PIZZA/jingles_PIZZA14.ogg） | Kenney | CC0 1.0 | https://opengameart.org/content/85-short-music-jingles |
| `bgm/bgm_theme.ogg`、`bgm/bgm_theme.m4a` | 標題、取名、章節結束、結局（整首就是循環：兩段各 37.16 秒） | At Home - Orchestral（cinematic-calm.wav） | Wolfgang_ | CC0 1.0 | https://opengameart.org/content/at-home-orchestral |
| `bgm/bgm_city.ogg`、`bgm/bgm_city.m4a` | 家、街區、公司（日常探索） | Death Waltz（death_waltz.mid，MIDI 渲染：FluidR3_GM 音色庫） | northivanastan；音色庫 Frank Wen | CC0 1.0（樂譜）＋MIT（FluidR3_GM 音色庫，全文見檔尾） | https://opengameart.org/content/death-waltz |
| `bgm/bgm_dream.ogg`、`bgm/bgm_dream.m4a` | 鐘塔之夢、夢客交談（原曲 156 秒是同一段重複兩次，取一段） | 4 Music Box Tracks（musicbox3_sad_tune.ogg） | Aureolus_Omicron | CC0 1.0 | https://opengameart.org/content/4-music-box-tracks |
| `bgm/bgm_battle.ogg`、`bgm/bgm_battle.m4a` | 一般戰鬥（A 段約 40 秒，原曲重複兩次但不是逐取樣相同：第 8 秒起相關最高（約 0.85），循環長度為實測的 1763967 個取樣點，線性淡化） | Battle Theme（Battle.mp3） | Wolfgang_ | CC0 1.0 | https://opengameart.org/content/battle-theme-0 |
| `bgm/bgm_boss.ogg`、`bgm/bgm_boss.m4a` | Boss 戰（原曲 108 秒的後半段與前半段在第 18 秒後相同，取 54 秒） | Determined Pursuit (epic orchestra loop)（determined_pursuit_loop.wav） | Emma_MA | CC0 1.0 | https://opengameart.org/content/determined-pursuit-epic-orchestra-loop |
| `amb/amb_rain.ogg`、`amb/amb_rain.m4a` | 雨聲（隔窗版由執行期低通濾波產生） | Rain (loopable)（1.ogg） | Ylmir | CC0 1.0 | https://opengameart.org/content/rain-loopable |
| `amb/amb_machine.ogg`、`amb/amb_machine.m4a` | 公司、練習室、倉庫的機械聲 | Steam boiler sound loop（generator_loop.wav） | bart | CC0 1.0 | https://opengameart.org/content/steam-boiler-sound-loop |
| `amb/amb_harbor.ogg`、`amb/amb_harbor.m4a` | 碼頭、沉堤、燈塔的浪聲 | Sea and river wave sounds（VistulaShort_0.mp3） | RandomMind | CC0 1.0 | https://opengameart.org/content/sea-and-river-wave-sounds |
| `amb/amb_sewer.ogg`、`amb/amb_sewer.m4a` | 地下水道 | Loopable Dungeon Ambience（dungeon_ambient_1_0.ogg） | JaggedStone | CC0 1.0 | https://opengameart.org/content/loopable-dungeon-ambience |
| `amb/amb_wind.ogg`、`amb/amb_wind.m4a` | 禮拜堂、燈室的風聲 | wind whoosh loop（wind woosh loop.ogg） | SketchMan3 | CC0 1.0 | https://opengameart.org/content/wind-whoosh-loop |
| `amb/amb_clock.ogg`、`amb/amb_clock.m4a` | 鐘塔之夢的時鐘滴答 | Ticking clock.（ticking_clock.wav） | bart | CC0 1.0 | https://opengameart.org/content/ticking-clock |

## 來源素材包

| 來源 id | 素材 | 作者 | 授權 | 頁面 | 下載檔 | SHA-256 |
|---|---|---|---|---|---|---|
| kenney-interface | Interface Sounds | Kenney | CC0 1.0 | https://opengameart.org/content/interface-sounds | https://opengameart.org/sites/default/files/kenney_interfaceSounds.zip | `f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232` |
| kenney-rpg | 50 RPG sound effects | Kenney | CC0 1.0 | https://opengameart.org/content/50-rpg-sound-effects | https://opengameart.org/sites/default/files/RPGsounds_Kenney.zip | `3ae398ad63e293f9c450bda22d5d81c3af69c74df66fc1400f33c012c0bbc231` |
| kenney-jingles | 85 Short music jingles | Kenney | CC0 1.0 | https://opengameart.org/content/85-short-music-jingles | https://opengameart.org/sites/default/files/jingleSounds_Kenney.zip | `be324b6cf26e35c95c2a344569a2470512819d0246cc81328bef3499de3682e5` |
| rubberduck-100 | 100 CC0 SFX | rubberduck | CC0 1.0 | https://opengameart.org/content/100-cc0-sfx | https://opengameart.org/sites/default/files/100-CC0-SFX_0.zip | `a5c135878c132f1c59cca54e60061c296cd0ac27ad031ca2c41b8cd5cab3c706` |
| jaggedstone-magic | Magic Spell SFX | JaggedStone | CC0 1.0 | https://opengameart.org/content/magic-spell-sfx | https://opengameart.org/sites/default/files/magical_2.ogg | `84a70f63f3f21e5ba4a48285b760a663d422ad3feddba2f3cbadd94b76cdc52e` |
| cassie-typewriter | Typewriter sounds | Cassie-OrbitGames | CC0 1.0 | https://opengameart.org/content/typewriter-sounds | https://opengameart.org/sites/default/files/typewriter6.wav | `825b668508448212edbf8ddcff2801b0a6251528aaccdf8ab85427023cf0797f` |
| isaiah658-reverse | Reversing Time / Stuck in Time | isaiah658 | CC0 1.0 | https://opengameart.org/content/reversing-time-stuck-in-time | https://opengameart.org/sites/default/files/Reverse-Time-Loop-isaiah658_0.ogg | `dd970cfede2e4d091004be2d3f036dcc824edb8ea9ab82c4c44d1cb380de679b` |
| northivanastan-death-waltz | Death Waltz | northivanastan | CC0 1.0 | https://opengameart.org/content/death-waltz | https://opengameart.org/sites/default/files/death_waltz.mid | `6f93e584e22314e5bb2cd175654a1917f4806393ed5545bcdb007a838526d599` |
| wolfgang-at-home | At Home - Orchestral | Wolfgang_ | CC0 1.0 | https://opengameart.org/content/at-home-orchestral | https://opengameart.org/sites/default/files/cinematic-calm.wav | `2977b4e410edc2d21269406b0d464f3602c4678fbd81d81d6b8b36e30963360f` |
| aureolus-music-box | 4 Music Box Tracks | Aureolus_Omicron | CC0 1.0 | https://opengameart.org/content/4-music-box-tracks | https://opengameart.org/sites/default/files/4_music_box_tracks_ogg.zip | `93b451f01ea4d530ee41b2239ae23f9be7d5a3b55354bb9893c736a4bd193b2f` |
| wolfgang-battle | Battle Theme | Wolfgang_ | CC0 1.0 | https://opengameart.org/content/battle-theme-0 | https://opengameart.org/sites/default/files/Battle.mp3 | `dde7bd4f10bde031800ba8e22151fad591b7c13e1c9ae51920341b4e4ae37be5` |
| emma-determined-pursuit | Determined Pursuit (epic orchestra loop) | Emma_MA | CC0 1.0 | https://opengameart.org/content/determined-pursuit-epic-orchestra-loop | https://opengameart.org/sites/default/files/determined_pursuit_loop.wav | `e4f3be098b50213b56a60aefe60fffae79cd9f7c9008088f93c187ef1bbc856b` |
| ylmir-rain | Rain (loopable) | Ylmir | CC0 1.0 | https://opengameart.org/content/rain-loopable | https://opengameart.org/sites/default/files/Rain%20OGG.zip | `e68f3e1c77493cf43bec84cebff5043bff6be9ce16d59b24caa988cd460aa75b` |
| bart-steam-boiler | Steam boiler sound loop | bart | CC0 1.0 | https://opengameart.org/content/steam-boiler-sound-loop | https://opengameart.org/sites/default/files/generator_loop.wav | `64b174cf8ef71e7f71aa03cf29864ab489f7be1f624456cab916043da38911bd` |
| randommind-waves | Sea and river wave sounds | RandomMind | CC0 1.0 | https://opengameart.org/content/sea-and-river-wave-sounds | https://opengameart.org/sites/default/files/VistulaShort_0.mp3 | `8c24607e41edd6f018ec3582a07e5a8dbc57347276339cb68440951a0fb4cfb1` |
| jaggedstone-dungeon | Loopable Dungeon Ambience | JaggedStone | CC0 1.0 | https://opengameart.org/content/loopable-dungeon-ambience | https://opengameart.org/sites/default/files/dungeon_ambient_1_0.ogg | `df491823e4877371c34dbda4e9321cd83a4a14fa7573cee0ebca1ae423b70e6e` |
| sketchman-wind | wind whoosh loop | SketchMan3 | CC0 1.0 | https://opengameart.org/content/wind-whoosh-loop | https://opengameart.org/sites/default/files/wind%20woosh%20loop.ogg | `0cfdbd3f21ed449689a9024264edf267d0037a6495813a7010827672ec191dac` |
| bart-ticking-clock | Ticking clock. | bart | CC0 1.0 | https://opengameart.org/content/ticking-clock | https://opengameart.org/sites/default/files/ticking_clock.wav | `dc4dc1bf2c4bbeee5fd0841a87610ed19d851a92abc973ce0f5ff3caec40d537` |

## 音色庫（MIDI 渲染用）

### FluidR3_GM（fluidr3-gm）

- 作者：Frank Wen
- 授權：MIT
- 頁面：https://packages.debian.org/sid/fluid-soundfont-gm
- 下載檔：https://deb.debian.org/debian/pool/main/f/fluid-soundfont/fluid-soundfont-gm_3.1-6_all.deb（SHA-256 `9965fbcc6acee17d6f72b685d28c7f968ec64eba14645445b476d5c6cc2eee4c`，使用其中的 `usr/share/sounds/sf2/FluidR3_GM.sf2`）

```
Fluid (R3) SoundFont
Copyright (c) 2000-2002, 2008 Frank Wen <getfrank@gmail.com>
Copyright (c) 2008 Toby Smithe

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

