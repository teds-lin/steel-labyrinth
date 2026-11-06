// 發布流程整合測試：對 web/ 的複本實際跑 stamp-version＋stamp-urls（和 GitHub Actions 相同的步驟），
// 再用本機靜態伺服器（tools/serve.mjs，SERVE_ROOT 指向複本）載入，確認：
// - 遊戲正常啟動到標題畫面；
// - 沒有任何不帶版本的同源 .js／.json 請求；
// - 每個模組只載入一次（同一路徑若以不同網址載入，瀏覽器會建立兩個模組實例，例如 session 單例被複製）。
// 只跑 desktop（mobile 重跑一次沒有額外意義）。複本放在 Playwright 的輸出目錄（每次執行開始時由 Playwright 清空）。
import { test, expect } from '@playwright/test';
import { cpSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '../..');
let dir; // 改寫後的 web/ 複本
let version; // 玩家看得到的 GAME_VERSION（stamp-version 寫入，stamp-urls 不改）
let token; // 網址參數 v＝<GAME_VERSION>-<HEAD 短 SHA 7 碼>
let server;
let baseUrl;

function hashTree(d) {
  const out = {};
  const walk = (p) => {
    for (const n of readdirSync(p)) {
      const f = join(p, n);
      if (statSync(f).isDirectory()) walk(f);
      else out[relative(d, f)] = createHash('sha256').update(readFileSync(f)).digest('hex');
    }
  };
  walk(d);
  return out;
}

// 複本可能不在 repo 裡（例如 playwright --output 指到別處）：stamp-version／stamp-urls 的 git 指令一律指向本 repo
const GIT_DIR = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const node = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_DIR } });

test.describe('發布版（stamp-version＋stamp-urls）', () => {
  test.beforeAll(async ({}, testInfo) => {
    if (testInfo.project.name !== 'desktop') return;
    dir = testInfo.outputPath('stamped-web');
    cpSync(join(ROOT, 'web'), dir, { recursive: true });

    const sv = node([join(ROOT, 'tools', 'stamp-version.mjs'), join(dir, 'src', 'version.js')]);
    expect(sv.status, sv.stderr).toBe(0);
    version = /GAME_VERSION = '([^']+)'/.exec(readFileSync(join(dir, 'src', 'version.js'), 'utf8'))[1];
    expect(version).not.toBe('dev');

    const su = node([join(ROOT, 'tools', 'stamp-urls.mjs'), dir]);
    expect(su.status, `${su.stdout}\n${su.stderr}`).toBe(0);
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    token = `${version}-${sha.slice(0, 7)}`;
    const vsrc = readFileSync(join(dir, 'src', 'version.js'), 'utf8');
    expect(vsrc).toContain(`export const GAME_VERSION = '${version}';`); // 玩家看得到的版本號不變
    expect(vsrc).toContain(`export const ASSET_VERSION = '${token}';`);

    // 冪等：再跑一次，所有檔案逐位元組相同
    const before = hashTree(dir);
    const again = node([join(ROOT, 'tools', 'stamp-urls.mjs'), dir]);
    expect(again.status, again.stderr).toBe(0);
    expect(hashTree(dir)).toEqual(before);

    server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
      env: { ...process.env, PORT: '0', SERVE_ROOT: dir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    baseUrl = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('靜態伺服器 10 秒內沒有啟動')), 10_000);
      let buf = '';
      server.stdout.on('data', (d) => {
        buf += d;
        const m = /http:\/\/localhost:(\d+)\//.exec(buf);
        if (m && m[1] !== '0') { clearTimeout(t); res(m[0]); }
      });
      server.on('exit', (code) => rej(new Error(`靜態伺服器結束（${code}）`)));
    });
  });

  test.afterAll(() => {
    server?.kill();
  });

  test('遊戲正常啟動；同源 .js／.json 全部帶版本；每個模組只載入一次', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', '只跑 desktop');
    const origin = new URL(baseUrl).origin;
    const reqs = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.origin === origin) reqs.push(u);
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`${baseUrl}?test=1`);
    await expect.poll(() => page.evaluate(() => window.__SL?.currentScene?.() ?? null), { timeout: 20_000 }).toBe('Title');
    await page.waitForTimeout(1000); // 讓啟動後的延遲請求（音訊目錄等）也送出
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__slBootWatch?.state)).toBe('ok');
    await expect(page.locator('#load-status')).toBeHidden();

    const assets = reqs.filter((u) => /\.(js|json)$/.test(u.pathname));
    const js = assets.filter((u) => u.pathname.endsWith('.js'));
    const json = assets.filter((u) => u.pathname.endsWith('.json'));
    expect(js.length, '應該載入了整個模組圖').toBeGreaterThan(50);
    expect(json.length, '應該載入了遊戲資料').toBeGreaterThan(5);
    expect(json.map((u) => u.pathname)).toEqual(expect.arrayContaining(['/data/manifest.json', '/audio/catalog.json']));
    expect(js.map((u) => u.pathname)).toEqual(expect.arrayContaining(['/vendor/phaser.min.js', '/src/main.js', '/src/version.js']));

    const unversioned = assets.filter((u) => u.searchParams.get('v') !== token || u.searchParams.getAll('v').length !== 1).map((u) => u.href);
    expect(unversioned, '不得有不帶（或帶錯）版本的同源 .js／.json 請求').toEqual([]);

    const byPath = {};
    for (const u of js) (byPath[u.pathname] ??= []).push(u.href);
    const dup = Object.entries(byPath).filter(([, list]) => list.length !== 1);
    expect(dup, '每個模組只能載入一次（同路徑不同網址＝兩個模組實例）').toEqual([]);
  });
});
