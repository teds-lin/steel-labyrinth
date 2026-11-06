// 發版時把資源網址加上 ?v=<版本>（tools/lib/stamp-urls.mjs、tools/stamp-urls.mjs）。
// 目的：GitHub Pages 回 cache-control: max-age=600，十分鐘內連發兩版時，瀏覽器可能拿快取裡的舊模組配新模組 → 模組連結失敗 → 黑畫面。
// 每一版的所有同源 .js／.json 網址都不同，就不會新舊混用。同一模組只要有一處沒帶版本就會被載入兩次（兩個實例），所以驗證步驟必須抓得到漏網之魚。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  withVersion, isLocalModuleRef, isLocalHtmlRef, stampJs, scanJs, stampHtml, scanHtml, stampTree, verifyTree, readTreeVersion,
  assetToken, readTreeAssetVersion,
} from '../../tools/lib/stamp-urls.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
// cache-bust 參數＝<GAME_VERSION>-<HEAD 短 SHA 7 碼>：同一天 amend＋force-push 時 GAME_VERSION 可能重複，加上 SHA 才保證一份內容一個網址
const V = '2026.11.07.1-abc1234';
const V2 = '2026.11.07.2-def5678';

describe('assetToken', () => {
  it('GAME_VERSION＋完整或短 SHA → <版本>-<SHA 前 7 碼>', () => {
    expect(assetToken('2026.11.07.3', 'abc1234def5678abc1234def5678abc1234def56')).toBe('2026.11.07.3-abc1234');
    expect(assetToken('2026.11.07', 'ABC1234')).toBe('2026.11.07-abc1234');
  });
  it('版本是 dev、格式不合、SHA 不是 16 進位或不足 7 碼 → 報錯', () => {
    expect(() => assetToken('dev', 'abc1234')).toThrow();
    expect(() => assetToken('2026.13.01', 'abc1234')).toThrow();
    expect(() => assetToken('2026.11.07', 'abc123')).toThrow();
    expect(() => assetToken('2026.11.07', 'xyz1234')).toThrow();
    expect(() => assetToken('2026.11.07', '')).toThrow();
  });
});

describe('withVersion', () => {
  it('沒有查詢字串就加 ?v=', () => {
    expect(withVersion('./a.js', V)).toBe(`./a.js?v=${V}`);
    expect(withVersion('src/main.js', V)).toBe(`src/main.js?v=${V}`);
  });
  it('已有其他參數就接在後面；已有 v 就換成新版本（冪等）', () => {
    expect(withVersion('./a.js?x=1', V)).toBe(`./a.js?x=1&v=${V}`);
    expect(withVersion(`./a.js?v=${V}`, V)).toBe(`./a.js?v=${V}`);
    expect(withVersion(`./a.js?x=1&v=2025.01.01&y=2`, V)).toBe(`./a.js?x=1&y=2&v=${V}`);
  });
  it('#片段留在最後', () => {
    expect(withVersion('./a.js#frag', V)).toBe(`./a.js?v=${V}#frag`);
  });
  it('版本格式不合（含 dev）就報錯，不會把奇怪字元寫進網址', () => {
    for (const bad of ['dev', '', "x'; evil", '2026.13.01', '2026.11.07&x=1', '2026.11.07.1', '2026.11.07.1-ABC1234', '2026.11.07.1-abc123', 'dev-abc1234', '2026.11.07.1-abc1234&x']) {
      expect(() => withVersion('./a.js', bad), bad).toThrow();
    }
  });
});

describe('同源判斷', () => {
  it('JS 模組：只有 ./ ../ / 開頭算同源；裸名稱、完整網址、// 開頭不算', () => {
    for (const s of ['./a.js', '../b/c.js', '/x.js', './d.json']) expect(isLocalModuleRef(s), s).toBe(true);
    for (const s of ['phaser', 'https://x.y/a.js', '//cdn.x/a.js', 'data:text/javascript,1', 'node:fs']) expect(isLocalModuleRef(s), s).toBe(false);
  });
  it('HTML：相對路徑（含不帶 ./ 的 src/main.js）算同源；外部網址、#、data: 不算', () => {
    for (const s of ['src/main.js', './a.css', 'vendor/phaser.min.js', '/x.js']) expect(isLocalHtmlRef(s), s).toBe(true);
    for (const s of ['https://fonts.googleapis.com', '//cdn.x/a.js', '#top', '', 'data:,x', 'mailto:a@b.c']) expect(isLocalHtmlRef(s), s).toBe(false);
  });
});

// 各種 import 寫法（單雙引號、多行、副作用 import、export from、動態 import、JSON import attributes），
// 以及「看起來像 import 但其實是註解／字串／模板字串／正規表示式」的干擾項。
const SRC = [
  "// import x from './c1.js';",
  "/* import('./c2.js') ; export * from './c3.js' */",
  'import a from "./a.js";',
  'import {',
  '  b,',
  '  c,',
  "} from '../b.js';",
  "import './side.js';",
  "export * from './star.js';",
  "export { q } from './q.js';",
  "import * as ns from './ns.js';",
  "const t = `import y from './tpl.js'`;",
  "const s = \"import z from './str.js'\";",
  "const re = /import\\('.\\/re.js'\\)/;",
  "import('./dyn.js');",
  'import("../dyn2.js").then(() => {});',
  'import(`./tpl-dyn.js`);',
  "import j from './d.json' with { type: 'json' };",
  "import P from 'phaser';",
  "import ext from 'https://cdn.example/x.js';",
  'const u = import.meta.url;',
  'export const k = 1;',
  '',
].join('\n');

describe('stampJs', () => {
  it('改寫所有同源的靜態 import／export from／動態 import（字串常值），並保留原本的引號', async () => {
    const { code, count } = await stampJs(SRC, V);
    const q = `?v=${V}`;
    expect(code).toContain(`import a from "./a.js${q}";`);
    expect(code).toContain(`} from '../b.js${q}';`);
    expect(code).toContain(`import './side.js${q}';`);
    expect(code).toContain(`export * from './star.js${q}';`);
    expect(code).toContain(`export { q } from './q.js${q}';`);
    expect(code).toContain(`import * as ns from './ns.js${q}';`);
    expect(code).toContain(`import('./dyn.js${q}');`);
    expect(code).toContain(`import("../dyn2.js${q}").then`);
    expect(code).toContain(`import(\`./tpl-dyn.js${q}\`);`);
    expect(code).toContain(`import j from './d.json${q}' with { type: 'json' };`);
    expect(count).toBe(10);
  });
  it('註解、字串、模板字串、正規表示式裡的路徑不改；裸名稱、外部網址、import.meta 不改', async () => {
    const { code } = await stampJs(SRC, V);
    for (const keep of [
      "// import x from './c1.js';",
      "/* import('./c2.js') ; export * from './c3.js' */",
      "const t = `import y from './tpl.js'`;",
      "const s = \"import z from './str.js'\";",
      "const re = /import\\('.\\/re.js'\\)/;",
      "import P from 'phaser';",
      "import ext from 'https://cdn.example/x.js';",
      'const u = import.meta.url;',
    ]) expect(code).toContain(keep);
  });
  it('除了路徑以外一個字元都不動（行數、縮排、其他程式碼相同）', async () => {
    const { code } = await stampJs(SRC, V);
    expect(code.replaceAll(`?v=${V}`, '')).toBe(SRC);
  });
  it('冪等：跑兩次結果相同；換新版本只換版本號，不會疊成兩個 v', async () => {
    const once = (await stampJs(SRC, V)).code;
    expect((await stampJs(once, V)).code).toBe(once);
    const next = (await stampJs(once, V2)).code;
    expect(next).toBe((await stampJs(SRC, V2)).code);
    expect(next).not.toContain(V + "'");
  });
  it('動態 import 用變數或帶 ${} 的模板字串：無法靜態改寫，直接報錯（要改用字串常值）', async () => {
    await expect(stampJs("const n = 'x'; import(`./maps/${n}.js`);", V)).rejects.toThrow(/動態 import/);
    await expect(stampJs('import(name);', V)).rejects.toThrow(/動態 import/);
  });
  it('語法壞掉的檔案報錯，不默默跳過', async () => {
    await expect(stampJs("import { a from './a.js';\nexport {", V)).rejects.toThrow();
  });
});

describe('scanJs（驗證）', () => {
  it('改寫後沒有問題', async () => {
    expect(await scanJs((await stampJs(SRC, V)).code, V)).toEqual([]);
  });
  it('只漏一個也抓得到，並指出是哪一個路徑', async () => {
    const stamped = (await stampJs(SRC, V)).code;
    const leaked = stamped.replace(`'./side.js?v=${V}'`, "'./side.js'");
    const problems = await scanJs(leaked, V);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('./side.js');
  });
  it('版本不對（舊版號）也算問題', async () => {
    const stamped = (await stampJs(SRC, V)).code;
    expect((await scanJs(stamped, V2)).length).toBe(10);
  });
  it('非常值的動態 import 算問題', async () => {
    expect((await scanJs('import(name);', V)).join('\n')).toMatch(/動態 import/);
  });
});

const HTML = `<!doctype html>
<html>
<head>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC&display=swap">
  <link rel="stylesheet" href='css/game.css'>
  <link rel=icon href=icon.png>
  <!-- <script src="old/commented.js"></script> -->
  <style>.x { background: url("not-a-tag.png"); } /* <link href="in-style.css"> */</style>
</head>
<body>
  <div id="game"></div>
  <script>
    // <script src="in-inline.js"> 不是標籤
    var s = '<link href="inline-str.css">';
  </script>
  <script src="vendor/phaser.min.js"></script>
  <script
    type="module"
    src="src/main.js"></script>
  <script type="module">
    import { x } from './src/inline-dep.js';
  </script>
  <a href="other.html">連結不是資源，不改</a>
</body>
</html>
`;

describe('stampHtml', () => {
  it('script src、link href（同源）加上版本；外部網址不改；保留引號樣式（無引號的值改寫後補上雙引號）', async () => {
    const { code } = await stampHtml(HTML, V);
    const q = `?v=${V}`;
    expect(code).toContain(`<script src="vendor/phaser.min.js${q}"></script>`);
    expect(code).toContain(`src="src/main.js${q}"></script>`);
    expect(code).toContain(`<link rel="stylesheet" href='css/game.css${q}'>`);
    expect(code).toContain(`<link rel=icon href="icon.png${q}">`);
    expect(code).toContain('<link rel="preconnect" href="https://fonts.googleapis.com">');
    expect(code).toContain('href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC&display=swap">');
  });
  it('inline module script 的 import 也改；inline 一般 script、註解、style、<a> 不改', async () => {
    const { code, count } = await stampHtml(HTML, V);
    expect(code).toContain(`import { x } from './src/inline-dep.js?v=${V}';`);
    for (const keep of [
      '<!-- <script src="old/commented.js"></script> -->',
      '/* <link href="in-style.css"> */',
      '// <script src="in-inline.js"> 不是標籤',
      "var s = '<link href=\"inline-str.css\">';",
      '<a href="other.html">',
    ]) expect(code).toContain(keep);
    expect(count).toBe(5);
    expect(code.replaceAll(`?v=${V}`, '').replace('href="icon.png"', 'href=icon.png')).toBe(HTML);
  });
  it('冪等', async () => {
    const once = (await stampHtml(HTML, V)).code;
    expect((await stampHtml(once, V)).code).toBe(once);
  });
  it('scanHtml：改寫後沒問題；漏一個抓得到', async () => {
    const once = (await stampHtml(HTML, V)).code;
    expect(await scanHtml(once, V)).toEqual([]);
    const leaked = once.replace(`vendor/phaser.min.js?v=${V}`, 'vendor/phaser.min.js');
    const problems = await scanHtml(leaked, V);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('vendor/phaser.min.js');
  });
});

/** 在暫存目錄做一份迷你 web/：index.html → main.js → 兩個模組共用 session.js；vendor 的一般 script；data 的 JSON。 */
function makeTree(version = V) {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-urls-'));
  const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  put('index.html', '<!doctype html><script src="vendor/lib.min.js"></script>\n<script type="module" src="src/main.js"></script>\n');
  put('vendor/lib.min.js', "window.Lib={};/* import x from './nope.js' */");
  put('src/version.js', `export const GAME_VERSION = '${version}';\nexport const ASSET_VERSION = 'dev';\n`);
  put('src/session.js', "export const session = { id: Math.random() };\n");
  put('src/a.js', "import { session } from './session.js';\nexport const a = session;\n");
  put('src/scenes/B.js', "import { session } from '../session.js';\nimport { GAME_VERSION } from '../version.js';\nexport const b = [session, GAME_VERSION];\n");
  put('src/main.js', "import { a } from './a.js';\nimport { b } from \"./scenes/B.js\";\nimport('./lazy.js');\n");
  put('src/lazy.js', "export * from './a.js';\n");
  put('data/manifest.json', '{"files":{}}\n');
  return dir;
}
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');

describe('stampTree／verifyTree', () => {
  it('整棵樹改寫後驗證通過；vendor 的一般 script 內容不動；JSON 不動', async () => {
    const dir = makeTree();
    const vendorBefore = read(dir, 'vendor/lib.min.js');
    const r = await stampTree(dir, V);
    expect(r.refs).toBe(2 + 1 + 2 + 3 + 1); // html 2、a 1、B 2、main 3、lazy 1
    expect(await verifyTree(dir, V)).toEqual([]);
    expect(read(dir, 'vendor/lib.min.js')).toBe(vendorBefore);
    expect(read(dir, 'src/scenes/B.js')).toContain(`from '../session.js?v=${V}'`);
    expect(read(dir, 'index.html')).toContain(`src="vendor/lib.min.js?v=${V}"`);
  });
  it('src/version.js 的 ASSET_VERSION 寫成同一個參數（給 assetUrl 用）；玩家看得到的 GAME_VERSION 不變', async () => {
    const dir = makeTree('2026.11.07');
    await stampTree(dir, V);
    expect(readTreeVersion(dir)).toBe('2026.11.07');
    expect(readTreeAssetVersion(dir)).toBe(V);
    await stampTree(dir, V2); // 換版本只換值，不疊加
    expect(read(dir, 'src/version.js')).toBe(`export const GAME_VERSION = '2026.11.07';\nexport const ASSET_VERSION = '${V2}';\n`);
  });
  it('驗證：ASSET_VERSION 與網址參數不一致也算問題', async () => {
    const dir = makeTree();
    await stampTree(dir, V);
    writeFileSync(join(dir, 'src/version.js'), read(dir, 'src/version.js').replace(`ASSET_VERSION = '${V}'`, "ASSET_VERSION = 'dev'"));
    expect((await verifyTree(dir, V)).join('\n')).toMatch(/ASSET_VERSION/);
  });
  it('src/version.js 沒有 ASSET_VERSION 宣告 → 報錯，不默默略過', async () => {
    const dir = makeTree();
    writeFileSync(join(dir, 'src/version.js'), "export const GAME_VERSION = '2026.11.07.1';\n");
    await expect(stampTree(dir, V)).rejects.toThrow(/ASSET_VERSION/);
  });
  it('冪等：整棵樹跑兩次，每個檔案都相同', async () => {
    const dir = makeTree();
    await stampTree(dir, V);
    const files = ['index.html', 'src/main.js', 'src/a.js', 'src/scenes/B.js', 'src/lazy.js', 'src/session.js'];
    const first = files.map((f) => read(dir, f));
    await stampTree(dir, V);
    expect(files.map((f) => read(dir, f))).toEqual(first);
  });
  it('驗證抓得到漏網之魚：任何一個檔案的任何一個同源引用沒帶版本', async () => {
    const dir = makeTree();
    await stampTree(dir, V);
    writeFileSync(join(dir, 'src/a.js'), read(dir, 'src/a.js').replace(`./session.js?v=${V}`, './session.js'));
    const problems = await verifyTree(dir, V);
    expect(problems.join('\n')).toContain('src/a.js');
    expect(problems.join('\n')).toContain('./session.js');
  });
  it('驗證會順著模組圖檢查：引用到不存在的檔案也算問題', async () => {
    const dir = makeTree();
    await stampTree(dir, V);
    writeFileSync(join(dir, 'src/a.js'), `import './missing.js?v=${V}';\n${read(dir, 'src/a.js')}`);
    expect((await verifyTree(dir, V)).join('\n')).toMatch(/missing\.js/);
  });
  it('readTreeVersion 讀 src/version.js 的 GAME_VERSION', () => {
    expect(readTreeVersion(makeTree('2026.11.07.3'))).toBe('2026.11.07.3');
    expect(readTreeVersion(makeTree('dev'))).toBe('dev');
  });
});

/** 把迷你樹變成 git repo 並 commit（stamp-urls 從 HEAD 取短 SHA）；回傳 HEAD 的完整 SHA。 */
function gitCommit(dir, { amend = false } = {}) {
  const sh = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
  if (!amend) { sh('init', '-q'); sh('config', 'user.email', 'a@b.c'); sh('config', 'user.name', 'x'); }
  sh('add', '-A');
  sh('commit', '-q', '--allow-empty', ...(amend ? ['--amend', '-m', 'amended'] : ['-m', 'c']));
  return sh('rev-parse', 'HEAD');
}
const GV = '2026.11.07.1';

describe('stamp-urls.mjs（命令列）', () => {
  const run = (dir) => spawnSync(process.execPath, [join(ROOT, 'tools', 'stamp-urls.mjs'), dir], { encoding: 'utf8' });
  it('版本仍是 dev 就拒絕（exit 1），不改任何檔案', () => {
    const dir = makeTree('dev');
    gitCommit(dir);
    const before = read(dir, 'src/main.js');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dev');
    expect(read(dir, 'src/main.js')).toBe(before);
  });
  it('改寫＋驗證成功 exit 0：參數＝<GAME_VERSION>-<HEAD 短 SHA>；GAME_VERSION 不變；跑第二次結果相同', () => {
    const dir = makeTree(GV);
    const token = `${GV}-${gitCommit(dir).slice(0, 7)}`;
    const r = run(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(token);
    const once = read(dir, 'src/main.js');
    expect(once).toContain(`'./a.js?v=${token}'`);
    expect(readTreeVersion(dir)).toBe(GV);
    expect(readTreeAssetVersion(dir)).toBe(token);
    expect(run(dir).status).toBe(0);
    expect(read(dir, 'src/main.js')).toBe(once);
  });
  it('同一天 amend 後重新發布（GAME_VERSION 相同、內容不同）：參數跟著新 SHA 改變', () => {
    const dir = makeTree(GV);
    const sha1 = gitCommit(dir);
    expect(run(dir).status).toBe(0);
    writeFileSync(join(dir, 'src/session.js'), 'export const session = { id: 2 };\n');
    const sha2 = gitCommit(dir, { amend: true });
    expect(sha2).not.toBe(sha1);
    const r = run(dir);
    expect(r.status, r.stderr).toBe(0);
    expect(readTreeVersion(dir)).toBe(GV);
    const t2 = `${GV}-${sha2.slice(0, 7)}`;
    expect(read(dir, 'src/main.js')).toContain(`'./a.js?v=${t2}'`);
    expect(read(dir, 'src/main.js')).not.toContain(sha1.slice(0, 7));
    expect(readTreeAssetVersion(dir)).toBe(t2);
  });
  it('不在 git repo 裡（取不到 SHA）→ exit 1，不改任何檔案', () => {
    const dir = makeTree(GV);
    const before = read(dir, 'src/main.js');
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'stamp-urls.mjs'), dir], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SHA|git/);
    expect(read(dir, 'src/main.js')).toBe(before);
  });
  it('有無法改寫的動態 import → exit 1', () => {
    const dir = makeTree(GV);
    gitCommit(dir);
    writeFileSync(join(dir, 'src/lazy.js'), 'const n = 1; import(`./m${n}.js`);\n');
    expect(run(dir).status).toBe(1);
  });
  it('驗證失敗 → exit 1：模組圖走進了不改寫的 vendor/ 目錄，裡面的 import 沒帶版本', () => {
    const dir = makeTree(GV);
    gitCommit(dir);
    writeFileSync(join(dir, 'vendor/mod.js'), "import '../src/session.js';\n");
    writeFileSync(join(dir, 'src/a.js'), `import '../vendor/mod.js';\n${read(dir, 'src/a.js')}`);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('vendor/mod.js');
  });
});
