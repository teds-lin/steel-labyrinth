// 音檔資產把關（M6 P0）：目錄合法、每個 cue 雙格式齊全、沒有孤兒檔、大小預算、每個檔都有 CREDITS 條目。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog, AUDIO_FORMATS } from '../../web/src/audio/catalog.js';
import { validateRecipe, renderCredits } from '../../tools/lib/audio-recipe.mjs';
import { EVENT_KEYS } from '../../web/src/audio/events.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AUDIO = join(ROOT, 'web', 'audio');
const catalog = JSON.parse(readFileSync(join(AUDIO, 'catalog.json'), 'utf8'));
const recipe = JSON.parse(readFileSync(join(ROOT, 'tools', 'audio-recipe.json'), 'utf8'));
const credits = readFileSync(join(ROOT, 'CREDITS.md'), 'utf8');

/** 單一格式的大小上限（位元組）：計畫 §3.2。 */
const BUDGET = { sfx: 300_000, amb: 1_200_000, bgm: 4_500_000, total: 6_000_000 };

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [relative(AUDIO, p).split(sep).join('/')];
  });
}

const fileCues = Object.entries(catalog.cues).filter(([, c]) => typeof c.src === 'string');

describe('catalog.json', () => {
  it('通過 validateCatalog', () => {
    expect(validateCatalog(catalog).errors).toEqual([]);
  });
  it('P1／P2 需要的介面與音效 cue 都在', () => {
    const need = [
      'ui_move', 'ui_confirm', 'ui_cancel', 'ui_error', 'ui_save', 'text_tick',
      'map_investigate', 'map_echo', 'map_door', 'item_get',
      'bt_hit', 'bt_crit', 'bt_hurt', 'bt_miss', 'bt_shot', 'bt_skill', 'bt_down',
      'jingle_victory', 'jingle_defeat', 'sfx_bell',
    ];
    for (const id of need) expect(catalog.cues[id], id).toBeTruthy();
    expect(catalog.cues.sfx_bell.synth).toBe('bell');
  });
  it('events 對應表剛好涵蓋程式用到的所有事件鍵（不多不少），每個值都是 sfx cue', () => {
    expect(Object.keys(catalog.events ?? {}).sort()).toEqual([...EVENT_KEYS].sort());
    for (const [k, v] of Object.entries(catalog.events)) {
      expect(v === null || catalog.cues[v]?.kind === 'sfx', `${k} → ${v}`).toBe(true);
    }
  });
  it('同時發聲上限的優先序：短樂句與存檔音不被擋（priority）；打字音與按鍵的介面音一次輸入一聲、不會湧入，不佔額度（exempt）；其他事件音受上限', () => {
    const burst = Object.fromEntries(Object.entries(catalog.cues).filter(([, c]) => c.burst).map(([id, c]) => [id, c.burst]));
    expect(burst).toEqual({
      jingle_victory: 'priority', jingle_defeat: 'priority', ui_save: 'priority',
      text_tick: 'exempt', ui_move: 'exempt', ui_confirm: 'exempt', ui_cancel: 'exempt', ui_error: 'exempt',
    });
  });
  it('P2 的探索與戰鬥對應（計畫 §1.4）', () => {
    expect(catalog.events).toMatchObject({
      'map.investigate': 'map_investigate', 'map.echo': 'map_echo', 'map.change': 'map_door', 'map.unlock': 'map_door',
      'item.get': 'item_get', 'save.ok': 'ui_save',
      'battle.hit': 'bt_hit', 'battle.crit': 'bt_crit', 'battle.hurt': 'bt_hurt', 'battle.miss': 'bt_miss', 'battle.shot': 'bt_shot',
      'battle.heal': 'bt_skill', 'battle.buff': 'bt_skill', 'battle.debuff': 'bt_skill', 'battle.status': 'bt_skill',
      'battle.down': 'bt_down', 'battle.victory': 'jingle_victory', 'battle.defeat': 'jingle_defeat', 'battle.lost_control': 'jingle_defeat',
    });
  });
  it('公開目錄不列地圖或戰鬥 id（防劇透）：cue id 一律用通用前綴，目錄裡找不到任何地圖或遭遇 id', () => {
    const PREFIX = /^(ui|text|map|item|bt|jingle|sfx|bgm|amb)_[a-z0-9_]+$/;
    for (const id of Object.keys(catalog.cues)) expect(id, id).toMatch(PREFIX);
    // 已發布的資料一定在；私有原稿在本機時（開發機）連未開放章節一起比對
    const ids = new Set();
    const dataDir = join(ROOT, 'web', 'data');
    for (const f of readdirSync(join(dataDir, 'maps'))) ids.add(f.replace(/\.json$/, ''));
    for (const e of JSON.parse(readFileSync(join(dataDir, 'encounters.json'), 'utf8'))) ids.add(e.id);
    const priv = join(ROOT, '..', 'steel-labyrinth-design', 'story');
    if (existsSync(priv)) {
      for (const ch of readdirSync(priv)) {
        const md = join(priv, ch, 'maps');
        if (existsSync(md)) for (const f of readdirSync(md)) ids.add(f.replace(/\.json$/, ''));
        const ef = join(priv, ch, 'encounters.json');
        if (existsSync(ef)) for (const e of JSON.parse(readFileSync(ef, 'utf8'))) ids.add(e.id);
      }
    }
    expect(ids.size).toBeGreaterThan(10);
    const strings = JSON.stringify(catalog).match(/"[^"]*"/g).map((s) => s.slice(1, -1));
    expect(strings.filter((s) => ids.has(s) || [...ids].some((id) => s.split('/').includes(id)))).toEqual([]);
  });
});

describe('磁碟上的音檔', () => {
  it('每個 cue 的 ogg 與 m4a 都存在且非空', () => {
    for (const [id, c] of fileCues) {
      for (const f of AUDIO_FORMATS) {
        const p = join(AUDIO, `${c.src}.${f}`);
        expect(existsSync(p), `${id} 缺 ${c.src}.${f}`).toBe(true);
        expect(statSync(p).size, `${c.src}.${f} 是空檔`).toBeGreaterThan(0);
      }
    }
  });
  it('web/audio 底下每個檔案都被某個 cue 引用（沒有孤兒檔）', () => {
    const used = new Set(fileCues.flatMap(([, c]) => AUDIO_FORMATS.map((f) => `${c.src}.${f}`)));
    const orphans = walk(AUDIO).filter((f) => f !== 'catalog.json' && !used.has(f));
    expect(orphans).toEqual([]);
  });
  it('檔案內容真的是對應格式（ogg 以 OggS 開頭、m4a 有 ftyp）', () => {
    for (const [, c] of fileCues) {
      const ogg = readFileSync(join(AUDIO, `${c.src}.ogg`));
      expect(ogg.subarray(0, 4).toString('latin1'), c.src).toBe('OggS');
      const m4a = readFileSync(join(AUDIO, `${c.src}.m4a`));
      expect(m4a.subarray(4, 8).toString('latin1'), c.src).toBe('ftyp');
    }
  });
  it('大小預算（單一格式分別計算）：SFX ≤ 0.3 MB、環境音 ≤ 1.2 MB、BGM ≤ 4.5 MB、合計 ≤ 6 MB', () => {
    for (const f of AUDIO_FORMATS) {
      const sum = { sfx: 0, amb: 0, bgm: 0, total: 0 };
      for (const [, c] of fileCues) {
        const n = statSync(join(AUDIO, `${c.src}.${f}`)).size;
        sum[c.kind] += n;
        sum.total += n;
      }
      for (const k of Object.keys(BUDGET)) expect(sum[k], `${f} ${k} ${sum[k]} bytes`).toBeLessThanOrEqual(BUDGET[k]);
    }
  });
});

describe('授權與 CREDITS', () => {
  it('轉檔配方合法（只用允許的授權、每個來源都有網址與雜湊）', () => {
    expect(validateRecipe(recipe)).toEqual([]);
  });
  it('每個有檔案的 cue 都對得到配方輸出，credit 等於該輸出的來源 id', () => {
    const outs = new Map(recipe.outputs.map((o) => [o.out, o]));
    for (const [id, c] of fileCues) {
      const o = outs.get(c.src);
      expect(o, `${id}（${c.src}）沒有配方`).toBeTruthy();
      expect(c.credit, id).toBe(o.source);
    }
  });
  it('配方的每個輸出都被 catalog 使用（不轉沒人用的檔）', () => {
    const srcs = new Set(fileCues.map(([, c]) => c.src));
    expect(recipe.outputs.map((o) => o.out).filter((o) => !srcs.has(o))).toEqual([]);
  });
  it('CREDITS.md 與配方同步（由 tools/audio-encode.mjs --credits 產生），每個檔都列出網址、作者、授權', () => {
    expect(credits).toBe(renderCredits(recipe));
    for (const [, c] of fileCues) {
      for (const f of AUDIO_FORMATS) {
        const line = credits.split('\n').find((l) => l.includes(`\`${c.src}.${f}\``));
        expect(line, `${c.src}.${f} 沒有 CREDITS 條目`).toBeTruthy();
        const src = recipe.sources[recipe.outputs.find((o) => o.out === c.src).source];
        expect(line).toContain(src.author);
        expect(line).toContain(src.license);
        expect(line).toContain(src.page);
      }
    }
  });
});
