// 發版時把同源資源網址加上 ?v=<GAME_VERSION>-<HEAD 短 SHA 7 碼>（只在 GitHub Actions 的工作區執行，不 commit）。
// 參數帶 SHA：同一天 amend＋force-push 時 GAME_VERSION 可能重複，只用版本號會讓不同內容共用同一個網址。
// 同一個參數也寫進 src/version.js 的 ASSET_VERSION，給執行期的 assetUrl()（web/src/asset-url.js）使用；玩家看得到的 GAME_VERSION 不變。
//
// 為什麼：GitHub Pages 回 cache-control: max-age=600。十分鐘內連發兩版時，瀏覽器可能拿快取裡的舊模組（例如舊 config.js）
// 配新的 main.js（import 了新的 export）→ 模組圖連結失敗 → Phaser 沒建立 → 黑畫面。每一版的網址都不同，就不會新舊混用。
//
// 規則：
// - JS：用 es-module-lexer（Vite 也用它做同樣的改寫）找出靜態 import、export … from、動態 import(字串常值)；
//   註解、字串、模板字串、正規表示式裡長得像 import 的文字不會被當成 import。只改 ./ ../ / 開頭的同源路徑。
//   動態 import 的參數不是字串常值（變數、帶 ${} 的模板字串）時無法靜態改寫 → 報錯，要改成字串常值或經過 assetUrl()。
// - HTML：<script src>、資源類 <link href>（stylesheet、modulepreload、icon…）、inline <script type="module"> 的 import。
//   HTML 註解、<style>、一般 inline <script> 的內容不動。
// - 同一個模組只要有一處以不同網址（有／無 ?v=）載入，瀏覽器就會建立兩個模組實例（例如 session 單例被複製），
//   所以改寫後一定要跑 verifyTree：掃描所有檔案＋順著模組圖走一遍，任何一個同源引用沒帶正確版本都算問題。
//
// 已知限制（審查後決定不修，記在這裡）：
// - 每次發版所有網址都換新，包含內容沒變的 vendor/phaser.min.js（約 1 MB）也會重新下載一次；換來的是不必追蹤哪些檔案有變。
// - index.html 本身無法加參數：瀏覽器最多可能拿 10 分鐘內的舊 index.html，它要的是舊參數的網址，而 GitHub Pages 忽略查詢參數，
//   快取裡沒有的檔案會拿到伺服器上的新內容，仍可能新舊混用（新增 export 不會壞，移除或改名 export 才會）。
//   這種情況由 index.html 的載入監看顯示「載入失敗，請重新整理」，按鈕帶 _r 時間戳重新載入就會拿到新的 index.html。
// - 載入監看用「load 事件後 2 秒仍未啟動」當保險判斷失敗，前提是模組圖裡沒有 top-level await；
//   日後若使用 top-level await，要一併調整 index.html 的監看邏輯。
// - 音檔（web/audio/sfx）不加參數，理由見 web/src/audio/index.js。
// - verifyTree 把「/」開頭的路徑當成站台根目錄，但正式站是專案頁（/steel-labyrinth/），這種路徑上線會 404 卻能通過驗證；
//   `new Worker(new URL('./w.js', import.meta.url))` 與 importmap 也不會被改寫或檢查。目前程式碼都沒有這些寫法
//   （tests/ui/asset-url.test.js 的盤點會擋住 import.meta.url），日後要用時先補規則。
// - tests/e2e/stamped-build.spec.js 的輸出目錄必須在 git repo 內，stamp-version／stamp-urls 才取得到 commit 資訊。
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { VERSION_RE } from './version.mjs';

/** 不改寫內容的目錄：第三方的一般（非 module）script，例如 vendor/phaser.min.js（它在 HTML 裡的網址照樣加版本）。 */
export const SKIP_JS_DIRS = ['vendor/'];

/** 會被當成資源下載、需要加版本的 <link rel>。 */
const RESOURCE_RELS = new Set(['stylesheet', 'modulepreload', 'preload', 'prefetch', 'icon', 'shortcut', 'apple-touch-icon', 'manifest']);

/** 網址參數 v 的格式：<GAME_VERSION>-<7 碼小寫 16 進位 SHA>，例如 2026.11.07.3-abc1234。 */
export const ASSET_TOKEN_RE = new RegExp(`^${VERSION_RE.source.slice(1, -1)}-[0-9a-f]{7}$`);

function assertVersion(version) {
  if (typeof version !== 'string' || !ASSET_TOKEN_RE.test(version)) throw new Error(`網址參數格式不合（應為 <版本>-<SHA 7 碼>）：${version}`);
}

/** GAME_VERSION＋commit SHA（完整或縮寫，至少 7 碼）→ 網址參數「<版本>-<SHA 前 7 碼>」。 */
export function assetToken(gameVersion, sha) {
  if (typeof gameVersion !== 'string' || !VERSION_RE.test(gameVersion)) throw new Error(`版本格式不合：${gameVersion}`);
  const s = String(sha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(s)) throw new Error(`commit SHA 格式不合：${sha}`);
  const token = `${gameVersion}-${s.slice(0, 7)}`;
  assertVersion(token);
  return token;
}

/** 把網址拆成 路徑、查詢參數陣列、#片段。 */
function splitRef(spec) {
  const hashAt = spec.indexOf('#');
  const hash = hashAt >= 0 ? spec.slice(hashAt) : '';
  const rest = hashAt >= 0 ? spec.slice(0, hashAt) : spec;
  const qAt = rest.indexOf('?');
  const path = qAt >= 0 ? rest.slice(0, qAt) : rest;
  const params = qAt >= 0 ? rest.slice(qAt + 1).split('&').filter((p) => p !== '') : [];
  return { path, params, hash };
}
const paramName = (p) => p.split('=')[0];

/** 網址加上（或換成）v=<version>；其他參數保留，#片段留在最後。冪等。 */
export function withVersion(spec, version) {
  assertVersion(version);
  const { path, params, hash } = splitRef(spec);
  const kept = params.filter((p) => paramName(p) !== 'v');
  return `${path}?${[...kept, `v=${version}`].join('&')}${hash}`;
}

/** 網址是否恰好帶一個 v，且值等於 version。 */
export function hasVersion(spec, version) {
  const vs = splitRef(spec).params.filter((p) => paramName(p) === 'v');
  return vs.length === 1 && vs[0] === `v=${version}`;
}

/** 去掉 ?查詢與 #片段，只留路徑。 */
export const pathOf = (spec) => splitRef(spec).path;

/** JS 模組路徑是否同源：只有 ./ ../ / 開頭（不含 //）。裸名稱（phaser）、完整網址都不算。 */
export function isLocalModuleRef(spec) {
  return typeof spec === 'string' && (spec.startsWith('./') || spec.startsWith('../') || (spec.startsWith('/') && !spec.startsWith('//')));
}

/** HTML 屬性裡的網址是否同源：不是空的、沒有 scheme（https:、data:…）、不是 // 或 # 開頭。 */
export function isLocalHtmlRef(spec) {
  if (typeof spec !== 'string') return false;
  const s = spec.trim();
  return s !== '' && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) && !s.startsWith('//') && !s.startsWith('#');
}

const lineOf = (src, pos) => src.slice(0, pos).split('\n').length;

/**
 * 找出程式碼裡所有 import 路徑。回傳 { refs: [{ start, end, spec, line }], dynamicProblems: [訊息] }。
 * start／end 是路徑本身（不含引號）在原始碼中的位置。語法壞掉時丟錯。
 */
async function moduleRefs(src, label = '') {
  await init;
  let imports;
  try {
    [imports] = parse(src, label || undefined);
  } catch (e) {
    throw new Error(`無法解析 JS${label ? `（${label}）` : ''}：${e?.message ?? e}`);
  }
  const refs = [];
  const dynamicProblems = [];
  for (const im of imports) {
    if (im.d === -2) continue; // import.meta
    const dynamic = im.d >= 0;
    if (dynamic && im.n === undefined) {
      dynamicProblems.push(`第 ${lineOf(src, im.s)} 行：動態 import 的參數不是字串常值（${src.slice(im.s, im.e)}），無法加上版本；請改用字串常值`);
      continue;
    }
    // 動態 import 的 s..e 含引號；靜態的不含
    const start = dynamic ? im.s + 1 : im.s;
    const end = dynamic ? im.e - 1 : im.e;
    const raw = src.slice(start, end);
    if (!isLocalModuleRef(im.n)) continue;
    if (raw !== im.n) throw new Error(`第 ${lineOf(src, start)} 行：路徑含跳脫字元（${raw}），無法安全改寫`);
    refs.push({ start, end, spec: im.n, line: lineOf(src, start) });
  }
  return { refs, dynamicProblems };
}

/** 依 edits（{ start, end, text }）由後往前替換。 */
function applyEdits(src, edits) {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** 改寫一個 JS 模組：所有同源 import 路徑加上 ?v=<version>。回傳 { code, count }；有無法改寫的動態 import 就丟錯。 */
export async function stampJs(src, version, label = '') {
  assertVersion(version);
  const { refs, dynamicProblems } = await moduleRefs(src, label);
  if (dynamicProblems.length) throw new Error(`${label ? `${label}：` : ''}${dynamicProblems.join('；')}`);
  const code = applyEdits(src, refs.map((r) => ({ start: r.start, end: r.end, text: withVersion(r.spec, version) })));
  return { code, count: refs.length };
}

/** 驗證一個 JS 模組：回傳問題清單（同源路徑沒帶正確版本、非常值的動態 import）。 */
export async function scanJs(src, version, label = '') {
  const { refs, dynamicProblems } = await moduleRefs(src, label);
  return [
    ...refs.filter((r) => !hasVersion(r.spec, version)).map((r) => `第 ${r.line} 行：「${r.spec}」沒有帶 ?v=${version}`),
    ...dynamicProblems,
  ];
}

// ---- HTML ----

// 依序比對：HTML 註解、<style>…</style>（整段跳過）、<script …> 或 <link …> 的開始標籤（屬性值可含 >）。
const HTML_TOKEN = /<!--[\s\S]*?(?:-->|$)|<style\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/style\s*>|$)|<(script|link)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
// 無引號的屬性值照瀏覽器的實際行為讀到空白或 > 為止（含 =）；改寫時一律補上雙引號（無引號的值不該含 =）。
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/dg;
const SCRIPT_END = /<\/script\s*>/gi;

function parseAttrs(text, offset) {
  const attrs = {};
  for (const m of text.matchAll(ATTR)) {
    const g = m[2] !== undefined ? 2 : m[3] !== undefined ? 3 : m[4] !== undefined ? 4 : 0;
    const name = m[1].toLowerCase();
    if (name in attrs) continue; // HTML：重複屬性以第一個為準
    attrs[name] = g ? { value: m[g], start: offset + m.indices[g][0], end: offset + m.indices[g][1], unquoted: g === 4 } : { value: '', start: -1, end: -1 };
  }
  return attrs;
}

/**
 * 走過 HTML，回傳需要處理的項目：
 * - { kind: 'url', tag, spec, start, end, module }：同源的 script src、資源類 link href；
 * - { kind: 'inline-module', code, start, end }：inline <script type="module"> 的內容。
 */
function htmlItems(html) {
  const items = [];
  HTML_TOKEN.lastIndex = 0;
  let m;
  while ((m = HTML_TOKEN.exec(html))) {
    if (!m[1]) continue; // 註解或 <style>
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2], m.index + 1 + m[1].length);
    if (tag === 'link') {
      const rels = (attrs.rel?.value ?? '').toLowerCase().split(/\s+/);
      const href = attrs.href;
      if (href && rels.some((r) => RESOURCE_RELS.has(r)) && isLocalHtmlRef(href.value)) {
        items.push({ kind: 'url', tag, spec: href.value, start: href.start, end: href.end, unquoted: href.unquoted, module: rels.includes('modulepreload') });
      }
      continue;
    }
    // <script>：找到對應的 </script>，內容整段跳過（不會被當成標籤）
    const bodyStart = HTML_TOKEN.lastIndex;
    SCRIPT_END.lastIndex = bodyStart;
    const close = SCRIPT_END.exec(html);
    const bodyEnd = close ? close.index : html.length;
    HTML_TOKEN.lastIndex = close ? SCRIPT_END.lastIndex : html.length;
    const isModule = (attrs.type?.value ?? '').trim().toLowerCase() === 'module';
    if (attrs.src) {
      if (isLocalHtmlRef(attrs.src.value)) items.push({ kind: 'url', tag, spec: attrs.src.value, start: attrs.src.start, end: attrs.src.end, unquoted: attrs.src.unquoted, module: isModule });
    } else if (isModule) {
      items.push({ kind: 'inline-module', code: html.slice(bodyStart, bodyEnd), start: bodyStart, end: bodyEnd });
    }
  }
  return items;
}

/** 改寫 HTML。回傳 { code, count }。 */
export async function stampHtml(html, version, label = '') {
  assertVersion(version);
  const edits = [];
  let count = 0;
  for (const it of htmlItems(html)) {
    if (it.kind === 'url') {
      const v = withVersion(it.spec, version);
      edits.push({ start: it.start, end: it.end, text: it.unquoted ? `"${v}"` : v });
      count += 1;
    } else {
      const r = await stampJs(it.code, version, `${label} inline module`);
      edits.push({ start: it.start, end: it.end, text: r.code });
      count += r.count;
    }
  }
  return { code: applyEdits(html, edits), count };
}

/** 驗證 HTML：回傳問題清單。 */
export async function scanHtml(html, version, label = '') {
  const problems = [];
  for (const it of htmlItems(html)) {
    if (it.kind === 'url') {
      if (!hasVersion(it.spec, version)) problems.push(`第 ${lineOf(html, it.start)} 行：<${it.tag}>「${it.spec}」沒有帶 ?v=${version}`);
    } else {
      for (const p of await scanJs(it.code, version, `${label} inline module`)) problems.push(`inline module：${p}`);
    }
  }
  return problems;
}

// ---- 整棵目錄 ----

function listFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const n of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out;
}
const isSkippedJs = (rel) => SKIP_JS_DIRS.some((d) => rel.startsWith(d));

const GAME_DECL = /^export const GAME_VERSION = '([^']*)';$/m;
const ASSET_DECL = /^(export const ASSET_VERSION = ')([^']*)(';)$/m;
const VERSION_FILE = 'src/version.js';

/** 讀 <dir>/src/version.js 的 GAME_VERSION（玩家看得到的版本號）。 */
export function readTreeVersion(dir) {
  const file = join(dir, VERSION_FILE);
  const m = GAME_DECL.exec(readFileSync(file, 'utf8'));
  if (!m) throw new Error(`${file} 找不到 export const GAME_VERSION = '…'; 宣告`);
  return m[1];
}

/** 讀 <dir>/src/version.js 的 ASSET_VERSION（網址參數）。 */
export function readTreeAssetVersion(dir) {
  const file = join(dir, VERSION_FILE);
  const m = ASSET_DECL.exec(readFileSync(file, 'utf8'));
  if (!m) throw new Error(`${file} 找不到 export const ASSET_VERSION = '…'; 宣告`);
  return m[2];
}

/**
 * 改寫整個 web 目錄：所有 .html、所有 .js（vendor/ 除外），以及 src/version.js 的 ASSET_VERSION（有這個檔案時必須有宣告）。
 * 先全部算好再寫入（任何一個檔案失敗就一個都不寫）；
 * 內容沒變的檔案不重寫。回傳 { files（有引用的檔案數）, refs（改寫的引用數） }。
 */
export async function stampTree(dir, version) {
  assertVersion(version);
  const writes = [];
  let files = 0;
  let refs = 0;
  for (const rel of listFiles(dir)) {
    let r;
    if (rel.endsWith('.html')) r = await stampHtml(readFileSync(join(dir, rel), 'utf8'), version, rel);
    else if (rel.endsWith('.js') && !isSkippedJs(rel)) r = await stampJs(readFileSync(join(dir, rel), 'utf8'), version, rel);
    else continue;
    if (rel === VERSION_FILE) {
      if (!ASSET_DECL.test(r.code)) throw new Error(`${rel} 找不到 export const ASSET_VERSION = '…'; 宣告（assetUrl 需要它）`);
      r = { ...r, code: r.code.replace(ASSET_DECL, `$1${version}$3`) };
    }
    if (r.count) { files += 1; refs += r.count; }
    writes.push([rel, r.code]);
  }
  for (const [rel, code] of writes) {
    if (readFileSync(join(dir, rel), 'utf8') !== code) writeFileSync(join(dir, rel), code);
  }
  return { files, refs };
}

/** 把 fromRel 檔案裡的引用 spec 解析成相對於根目錄的路徑（/ 開頭＝根目錄）；跳出根目錄回 null。 */
function resolveRel(fromRel, spec) {
  const p = pathOf(spec);
  const joined = p.startsWith('/') ? posix.normalize(p.slice(1)) : posix.normalize(posix.join(posix.dirname(fromRel), p));
  return joined.startsWith('../') || joined === '..' ? null : joined;
}

/**
 * 驗證整個 web 目錄，回傳問題清單（空＝通過）：
 * 1. 每個 .html、每個 .js（vendor/ 除外）的每個同源引用都帶正確版本；
 * 2. 從 HTML 順著模組圖走：每個引用到的檔案都存在；走到的模組（包含 vendor/ 底下的）也都要通過第 1 項的檢查。
 */
export async function verifyTree(dir, version) {
  assertVersion(version);
  const problems = [];
  const scanned = new Set();
  const scanFile = async (rel) => {
    if (scanned.has(rel)) return;
    scanned.add(rel);
    try {
      for (const p of await scanJs(readFileSync(join(dir, rel), 'utf8'), version, rel)) problems.push(`${rel}：${p}`);
    } catch (e) {
      problems.push(`${rel}：${e.message}`);
    }
  };
  const files = listFiles(dir);
  if (files.includes(VERSION_FILE)) {
    try {
      const asset = readTreeAssetVersion(dir);
      if (asset !== version) problems.push(`${VERSION_FILE}：ASSET_VERSION 是「${asset}」，與網址參數 ${version} 不一致（執行期的 assetUrl 會用錯參數）`);
    } catch (e) {
      problems.push(`${VERSION_FILE}：${e.message}`);
    }
  }
  for (const rel of files) {
    if (rel.endsWith('.html')) {
      for (const p of await scanHtml(readFileSync(join(dir, rel), 'utf8'), version, rel)) problems.push(`${rel}：${p}`);
    } else if (rel.endsWith('.js') && !isSkippedJs(rel)) {
      await scanFile(rel);
    }
  }

  // 模組圖
  const visited = new Set();
  const queue = [];
  const enqueueSpecs = async (fromRel, code, label) => {
    let refs;
    try {
      ({ refs } = await moduleRefs(code, label));
    } catch { return; } // 解析錯誤已在上面回報
    for (const r of refs) queue.push({ from: fromRel, spec: r.spec, module: true });
  };
  for (const rel of files.filter((f) => f.endsWith('.html'))) {
    for (const it of htmlItems(readFileSync(join(dir, rel), 'utf8'))) {
      if (it.kind === 'url') {
        if (it.tag === 'script') queue.push({ from: rel, spec: it.spec, module: it.module });
        else if (it.module) queue.push({ from: rel, spec: it.spec, module: true });
      } else {
        await enqueueSpecs(rel, it.code, `${rel} inline module`);
      }
    }
  }
  while (queue.length) {
    const { from, spec, module } = queue.shift();
    const target = resolveRel(from, spec);
    if (target === null) { problems.push(`${from}：「${spec}」跳出了網站根目錄`); continue; }
    if (!existsSync(join(dir, target)) || statSync(join(dir, target)).isDirectory()) {
      problems.push(`${from}：「${spec}」指向不存在的檔案 ${target}`);
      continue;
    }
    if (!module || visited.has(target)) continue;
    visited.add(target);
    if (!target.endsWith('.js')) continue; // JSON 等非 JS 模組：只確認存在
    await scanFile(target);
    await enqueueSpecs(target, readFileSync(join(dir, target), 'utf8'), target);
  }
  return problems;
}
