// 執行期組出來的同源資源網址（資料 JSON、音訊目錄）一律經過 assetUrl() 加上版本；本機與測試（'dev'）不加。
// 以及：web/src 裡每個 fetch 呼叫點都要經過盤點（新增 fetch 時這個測試會失敗，提醒決定要不要加版本）。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { assetUrl } from '../../web/src/asset-url.js';
import { GAME_VERSION, ASSET_VERSION } from '../../web/src/version.js';

const BASE = 'https://teds-lin.github.io/steel-labyrinth/';
const V = '2026.11.07.1-abc1234'; // 發布時的參數：<GAME_VERSION>-<HEAD 短 SHA>（tools/stamp-urls.mjs 寫進 version.js 的 ASSET_VERSION）

describe('assetUrl', () => {
  it("版本是 'dev'（本機、E2E）時只解析成絕對網址，不加任何參數", () => {
    expect(assetUrl('data/manifest.json', { version: 'dev', base: BASE })).toBe(`${BASE}data/manifest.json`);
    expect(assetUrl('audio/catalog.json', { version: 'dev', base: 'http://localhost:8091/?test=1' })).toBe('http://localhost:8091/audio/catalog.json');
  });
  it('發布版本加上 ?v=<版本>', () => {
    expect(assetUrl('data/manifest.json', { version: V, base: BASE })).toBe(`${BASE}data/manifest.json?v=${V}`);
  });
  it('可以直接傳 URL 物件（data-loader 以資料目錄為基準組出來的網址）', () => {
    const u = new URL('maps/attic.json', `${BASE}data/`);
    expect(assetUrl(u, { version: V })).toBe(`${BASE}data/maps/attic.json?v=${V}`);
    expect(assetUrl(u, { version: 'dev' })).toBe(`${BASE}data/maps/attic.json`);
    expect(u.href).toBe(`${BASE}data/maps/attic.json`); // 不改到傳進來的物件
  });
  it('已有的參數保留；已有 v 就換掉（不會出現兩個 v）', () => {
    expect(assetUrl('a.json?x=1', { version: V, base: BASE })).toBe(`${BASE}a.json?x=1&v=${V}`);
    expect(assetUrl(`a.json?v=2025.01.01`, { version: V, base: BASE })).toBe(`${BASE}a.json?v=${V}`);
  });
  it('預設參數取自 version.js 的 ASSET_VERSION（repo 內固定是 dev），不是玩家看得到的 GAME_VERSION', () => {
    expect(GAME_VERSION).toBe('dev');
    expect(ASSET_VERSION).toBe('dev');
    expect(assetUrl('data/x.json', { base: BASE })).toBe(`${BASE}data/x.json`);
  });
});

/** web/src 底下所有 .js（相對路徑 → 原始碼）。 */
function sources() {
  const root = resolve(import.meta.dirname, '../../web/src');
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) out[relative(root, p).replaceAll('\\', '/')] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}
// 去掉註解（粗略：行尾註解與區塊註解），只用在盤點計數。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('同源資源載入點盤點', () => {
  // 每個檔案裡 fetch( 出現的次數與理由。新增 fetch 時：同源的 .js／.json 一律經過 assetUrl()，再把它加進這張表。
  const FETCH_SITES = {
    'data-loader.js': 1, // 遊戲資料 JSON：assetUrl(new URL(rel, base))
    'audio/index.js': 2, // 音訊目錄 catalog.json：assetUrl；音檔本身（fetchFn）刻意不加版本，理由見 audio/index.js
    'audio/loader.js': 1, // 由呼叫端注入的 fetch（上面的 fetchFn），網址由 backend-webaudio 組
    'cloud-client.js': 1, // 雲端存檔 Worker（另一個網域，不屬於 Pages 的快取問題）
  };
  it('fetch 呼叫點與盤點表一致', () => {
    const found = {};
    for (const [file, src] of Object.entries(sources())) {
      const n = (stripComments(src).match(/\bfetch\s*\(/g) ?? []).length;
      if (n) found[file] = n;
    }
    expect(found).toEqual(FETCH_SITES);
  });
  it('同源 JSON 的 fetch 都經過 assetUrl', () => {
    const src = sources();
    expect(stripComments(src['data-loader.js'])).toMatch(/fetch\(assetUrl\(/);
    expect(stripComments(src['audio/index.js'])).toMatch(/fetch\(assetUrl\('audio\/catalog\.json'\)\)/);
  });
  it('沒有其他會載入同源檔案的寫法（new Image、XMLHttpRequest、Phaser Loader、import.meta.url）', () => {
    for (const [file, src] of Object.entries(sources())) {
      const code = stripComments(src);
      expect(code, file).not.toMatch(/new Image\b|XMLHttpRequest|this\.load\.\w+\(|import\.meta\.url/);
    }
  });
});
