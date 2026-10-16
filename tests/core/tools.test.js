import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBundle } from '../../tools/lib/bundle.mjs';
import { collectStrings, assertUniqueIds } from '../../tools/lib/strings.mjs';
import { stripPrivate } from '../../tools/lib/strip.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const run = (script, args) => spawnSync(process.execPath, [join(ROOT, 'tools', script), ...args], { encoding: 'utf8' });

let dir;
const write = (rel, obj) => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
};
function writeGood({ lineage = true } = {}) {
  write('manifest.json', { chapters: ['prologue'], start: { map: 'attic', spawn: 'default', dialogue: 'dlg_a' },
    files: { maps: ['attic'], story: ['prologue'], lineages: ['trace'] } });
  write('tiles.json', [{ id: 'floor', solid: false }]);
  write('items.json', [{ id: 'key', name: '鑰匙', desc: '舊鑰匙' }]);
  if (lineage) write('lineages/trace.json', { id: 'trace', ranks: [{ rank: 9, field: ['trace'] }] });
  write('maps/attic.json', { id: 'attic', name: '閣樓', tiles: ['..'], legend: { '.': 'floor' },
    spawns: [{ id: 'default', x: 0, y: 0, dir: 'down' }], objects: [], exits: [], triggers: [] });
  write('story/prologue.json', { id: 'prologue', title: '序章', end_screen: { title: '序章　完', subtitle: '第一章　製作中' }, dialogues: [{ id: 'dlg_a', start: 'n1', nodes: [
    { id: 'n1', speaker: '{name}', text: '嗯。', choices: [{ text: '走', next: 'END' }, { text: '留', next: 'n2' }] },
    { id: 'n2', speaker: null, text: '你留下了。', effects: [{ give_item: 'key' }], next: 'END' },
  ] }] });
}

// 每個測試用 OS 暫存區裡自己的目錄；依專案規則不在測試裡做刪除，由 OS 清理暫存區。
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sl-data-')); });

describe('loadBundle', () => {
  it('依 manifest.files 組成 bundle', () => {
    writeGood();
    const { bundle, errors } = loadBundle(dir);
    expect(errors).toEqual([]);
    expect(bundle.maps.map((m) => m.id)).toEqual(['attic']);
    expect(bundle.story.map((s) => s.id)).toEqual(['prologue']);
    expect(bundle.lineages.map((l) => l.id)).toEqual(['trace']);
    expect(bundle.items[0].id).toBe('key');
  });
  it('找不到 manifest、JSON 壞掉、列出的檔案不存在、檔名與 id 不符都回報', () => {
    expect(loadBundle(dir).errors[0]).toMatch(/manifest\.json/);
    writeGood({ lineage: false });
    write('items.json', '{oops');
    write('maps/attic.json', { id: 'loft', name: 'x', tiles: ['.'], legend: { '.': 'floor' }, spawns: [] });
    const errs = loadBundle(dir).errors.join('\n');
    expect(errs).toMatch(/items\.json.*JSON/);
    expect(errs).toMatch(/lineages\/trace\.json.*讀不到|lineages\/trace\.json.*不存在/);
    expect(errs).toMatch(/maps\/attic\.json.*loft/);
  });
});

describe('collectStrings', () => {
  it('收集地圖名、道具名與說明、對話 speaker/text、選項 text', () => {
    writeGood();
    const rows = collectStrings(loadBundle(dir).bundle);
    expect(rows).toEqual([
      { unique_id: 'maps/attic.json#name', text: '閣樓' },
      { unique_id: 'items.json#key.name', text: '鑰匙' },
      { unique_id: 'items.json#key.desc', text: '舊鑰匙' },
      { unique_id: 'story/prologue.json#dlg_a.n1.speaker', text: '{name}' },
      { unique_id: 'story/prologue.json#dlg_a.n1.text', text: '嗯。' },
      { unique_id: 'story/prologue.json#dlg_a.n1.choices[0].text', text: '走' },
      { unique_id: 'story/prologue.json#dlg_a.n1.choices[1].text', text: '留' },
      { unique_id: 'story/prologue.json#dlg_a.n2.text', text: '你留下了。' },
    ]);
  });
  it('assertUniqueIds：重複就丟錯並列出重複的 id', () => {
    expect(() => assertUniqueIds([{ unique_id: 'a' }, { unique_id: 'b' }])).not.toThrow();
    expect(() => assertUniqueIds([{ unique_id: 'a' }, { unique_id: 'a' }])).toThrow(/a/);
  });
});

describe('CLI：check-data', () => {
  it('合法資料 → 結束碼 0', () => {
    writeGood();
    const r = run('check-data.mjs', [dir]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
  it('有錯 → 列出並結束碼 1', () => {
    writeGood();
    write('items.json', []);
    const r = run('check-data.mjs', [dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/key/);
  });
  it('找不到 manifest → 結束碼 1', () => {
    const r = run('check-data.mjs', [join(dir, 'nope')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/manifest\.json/);
  });
});

describe('CLI：export-strings', () => {
  it('輸出 jsonl', () => {
    writeGood();
    const out = join(dir, 'out', 'strings.jsonl');
    const r = run('export-strings.mjs', [out, dir]);
    expect(r.status, r.stderr).toBe(0);
    const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(8);
    expect(lines[0]).toEqual({ unique_id: 'maps/attic.json#name', text: '閣樓' });
  });
  it('unique_id 不唯一（例如重複對話 id）→ 報錯退出且不寫檔', () => {
    writeGood();
    const story = JSON.parse(readFileSync(join(dir, 'story/prologue.json'), 'utf8'));
    story.dialogues.push(structuredClone(story.dialogues[0]));
    write('story/prologue.json', story);
    const out = join(dir, 'dup.jsonl');
    const r = run('export-strings.mjs', [out, dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/dlg_a/);
    expect(existsSync(out)).toBe(false);
  });
  it('沒給輸出路徑 → 結束碼 1', () => {
    expect(run('export-strings.mjs', []).status).toBe(1);
  });
});

describe('build-data：剝除 _ 開頭的私有欄位', () => {
  it('stripPrivate 遞迴剝除物件與陣列裡的 _ 欄位，不修改輸入', () => {
    const src = { id: 'a', _note: '劇透', nested: { _todo: 1, keep: [{ _x: 1, y: 2 }, 3] }, list: [{ _a: 1 }] };
    const before = JSON.stringify(src);
    expect(stripPrivate(src)).toEqual({ id: 'a', nested: { keep: [{ y: 2 }, 3] }, list: [{}] });
    expect(JSON.stringify(src)).toBe(before);
  });
  it('單一字元的「_」不是私有欄位（地圖 legend 用它當地形字元）', () => {
    expect(stripPrivate({ legend: { _: 'threshold', '#': 'wall' } })).toEqual({ legend: { _: 'threshold', '#': 'wall' } });
  });
  it('「_」只在地圖 legend 物件裡放行，其他層級的「_」照樣剝除（N4b）', () => {
    const src = { _: '根層私有', id: 'attic', legend: { _: 'threshold', '#': 'wall', _x: 'floor' },
      objects: [{ id: 'o', _: '物件私有' }], meta: { _: 1, legend: { _: 'x' } } };
    expect(stripPrivate(src)).toEqual({ id: 'attic', legend: { _: 'threshold', '#': 'wall' }, objects: [{ id: 'o' }], meta: { legend: {} } });
  });
  it('CLI：輸出的檔案裡沒有任何 _ 欄位', () => {
    const design = join(dir, 'design');
    const chap = join(design, 'story', 'prologue');
    const w = (rel, obj) => { mkdirSync(join(chap, rel, '..'), { recursive: true }); writeFileSync(join(chap, rel), JSON.stringify(obj)); };
    w('manifest.json', { _comment: '私有', start: { map: 'attic', spawn: 'default' } });
    w('tiles.json', [{ id: 'floor', solid: false, _why: '私有' }]);
    w('items.json', [{ id: 'key', name: '鑰匙', desc: 'x', _spoiler: '第三章會壞掉' }]);
    w('maps/attic.json', { id: 'attic', _design: 'x', name: '閣樓', tiles: ['_'], legend: { _: 'floor' }, spawns: [{ id: 'default', x: 0, y: 0, _n: 1 }] });
    w('story/prologue.json', { id: 'prologue', _draft: true, dialogues: [{ id: 'd', _memo: 'x', start: 'n1', nodes: [{ id: 'n1', text: 'a', next: 'END', _alt: 'b' }] }] });
    const out = join(dir, 'out-data'); // 不存在的新目錄
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'build-data.mjs')], { encoding: 'utf8', env: { ...process.env, DESIGN_DIR: design, OUT_DIR: out } });
    expect(r.status, r.stderr).toBe(0);
    const files = ['manifest.json', 'tiles.json', 'items.json', 'maps/attic.json', 'story/prologue.json'];
    for (const f of files) {
      const text = readFileSync(join(out, f), 'utf8');
      expect(text, f).not.toMatch(/"_[^"]/);
    }
    expect(JSON.parse(readFileSync(join(out, 'maps/attic.json'), 'utf8')).legend).toEqual({ _: 'floor' });
    expect(existsSync(join(ROOT, 'web', 'data', 'manifest.json'))).toBe(true); // 沒動到正式輸出
  });
});
