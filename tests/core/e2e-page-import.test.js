// E2E 在頁面內 import 遊戲模組（page.evaluate 裡取 session、引擎等）必須拿到「與遊戲同一個模組實例」。
// 發布版（tools/stamp-urls.mjs）的模組網址都帶 ?v=<ASSET_VERSION>，頁面內寫 import('./src/session.js') 會以不同網址
// 載入第二份 session（空的單例）→ 線上 E2E 出現「找不到遭遇」「Cannot redefine property: __SL」等錯誤。
// 所以：一律經 tests/e2e/page-import.js 的 window.__slImport(path)（沿用頁面實際載入的 main.js 的查詢字串），
// 並禁止 spec 直接寫字串常值的頁內 import。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { moduleUrlFor, PAGE_IMPORT_SCRIPT } from '../e2e/page-import.js';

describe('moduleUrlFor', () => {
  it('本機（main.js 不帶查詢字串）：只解析成絕對網址', () => {
    expect(moduleUrlFor('./src/session.js', 'http://localhost:8091/src/main.js', 'http://localhost:8091/?test=1'))
      .toBe('http://localhost:8091/src/session.js');
  });
  it('發布版：沿用 main.js 的查詢字串（同一個 ?v=），子目錄網站也正確', () => {
    const base = 'https://teds-lin.github.io/steel-labyrinth/?test=1&seed=3';
    const main = 'https://teds-lin.github.io/steel-labyrinth/src/main.js?v=2026.11.07.2-922b779';
    expect(moduleUrlFor('./src/core/battle/engine.js', main, base))
      .toBe('https://teds-lin.github.io/steel-labyrinth/src/core/battle/engine.js?v=2026.11.07.2-922b779');
    expect(moduleUrlFor('./src/main.js', main, base)).toBe(main);
  });
  it('頁面上找不到 main.js 的 module script：報錯（不默默載入第二份模組）', () => {
    expect(() => moduleUrlFor('./src/session.js', null, 'http://localhost:8091/')).toThrow(/main\.js/);
  });
  it('頁內腳本是自足的字串，定義 window.__slImport', () => {
    expect(typeof PAGE_IMPORT_SCRIPT).toBe('string');
    expect(PAGE_IMPORT_SCRIPT).toContain('__slImport');
    expect(() => new Function(PAGE_IMPORT_SCRIPT)).not.toThrow(); // 語法正確
  });
});

describe('E2E 不得直接寫頁內 import', () => {
  it('tests/e2e 裡沒有 import(\'…\') 這種字串常值的動態 import（一律用 window.__slImport）', () => {
    const dir = resolve(import.meta.dirname, '../e2e');
    const offenders = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (/\bimport\s*\(\s*['"`]/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
