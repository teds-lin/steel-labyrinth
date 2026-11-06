// 版本號自動產生（tools/lib/version.mjs、tools/stamp-version.mjs）：台灣時間（UTC+8）當天日期，同一天第 n 次（n≥2）加 .n-1。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { taiwanDate, versionFor, countOnDay, stampSource } from '../../tools/lib/version.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const ts = (iso) => Math.floor(Date.parse(iso) / 1000);

describe('taiwanDate', () => {
  it('UTC 16:00 以後已是台灣隔天（跨 UTC 午夜）', () => {
    expect(taiwanDate(ts('2026-10-21T15:59:59Z'))).toBe('2026.10.21');
    expect(taiwanDate(ts('2026-10-21T16:00:00Z'))).toBe('2026.10.22');
    expect(taiwanDate(ts('2026-10-21T00:00:00Z'))).toBe('2026.10.21');
  });
  it('跨月、跨年', () => {
    expect(taiwanDate(ts('2026-10-31T20:00:00Z'))).toBe('2026.11.01');
    expect(taiwanDate(ts('2026-12-31T16:00:00Z'))).toBe('2027.01.01');
  });
});

describe('versionFor', () => {
  it('第 1 次沒有序號，第 2 次 .1，第 3 次 .2', () => {
    expect(versionFor('2026.10.21', 1)).toBe('2026.10.21');
    expect(versionFor('2026.10.21', 2)).toBe('2026.10.21.1');
    expect(versionFor('2026.10.21', 3)).toBe('2026.10.21.2');
  });
  it('n 不是正整數就報錯', () => {
    for (const n of [0, -1, 1.5, NaN, '2']) expect(() => versionFor('2026.10.21', n)).toThrow();
  });
});

describe('countOnDay', () => {
  it('只算台灣日期相同的 commit 時間戳', () => {
    const t = [ts('2026-10-21T01:00:00Z'), ts('2026-10-21T15:00:00Z'), ts('2026-10-21T16:30:00Z'), ts('2026-10-20T10:00:00Z')];
    expect(countOnDay(t, '2026.10.21')).toBe(2);
    expect(countOnDay(t, '2026.10.22')).toBe(1);
    expect(countOnDay(t, '2026.10.20')).toBe(1);
  });
});

describe('stampSource', () => {
  const src = "// x\nexport const GAME_VERSION = 'dev';\n";
  it('只換掉版本字串', () => {
    expect(stampSource(src, '2026.10.21.1')).toBe("// x\nexport const GAME_VERSION = '2026.10.21.1';\n");
  });
  it('版本格式不合或找不到宣告就報錯', () => {
    expect(() => stampSource(src, "x'; evil")).toThrow();
    expect(() => stampSource('nothing', '2026.10.21')).toThrow();
  });
});

describe('stamp-version.mjs（暫存 git repo 實測）', () => {
  it('依 HEAD 以前、台灣同一天的 commit 數寫入版本檔；不碰其他檔案', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
    const sh = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); };
    sh('init', '-q'); sh('config', 'user.email', 'a@b.c'); sh('config', 'user.name', 'x');
    mkdirSync(join(dir, 'web', 'src'), { recursive: true });
    const file = join(dir, 'web', 'src', 'version.js');
    writeFileSync(file, "export const GAME_VERSION = 'dev';\n");
    sh('add', '.');
    const commit = (iso) => {
      const r = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'c'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
      expect(r.status).toBe(0);
    };
    commit('2026-10-20T10:00:00Z'); // 台灣 10/20
    commit('2026-10-21T10:00:00Z'); // 台灣 10/21 第 1 次
    commit('2026-10-21T17:00:00Z'); // 台灣 10/22 第 1 次
    commit('2026-10-21T18:00:00Z'); // 台灣 10/22 第 2 次
    const run = () => spawnSync(process.execPath, [join(ROOT, 'tools', 'stamp-version.mjs'), file], { cwd: dir, encoding: 'utf8' });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe("export const GAME_VERSION = '2026.10.22.1';\n");
    expect(r.stdout).toContain('2026.10.22.1');
    // 冪等：再跑一次結果相同
    writeFileSync(file, "export const GAME_VERSION = 'dev';\n");
    run();
    expect(readFileSync(file, 'utf8')).toBe("export const GAME_VERSION = '2026.10.22.1';\n");
  });
});

describe('版本檔與 config', () => {
  it('版本放在 web/src/version.js（repo 內預設 dev），config.js 轉出口', async () => {
    globalThis.window ??= { location: { search: '', hostname: 'localhost' }, devicePixelRatio: 1 }; // config.js 會讀 window
    const v = await import('../../web/src/version.js');
    const c = await import('../../web/src/config.js');
    expect(v.GAME_VERSION).toBe('dev');
    expect(c.GAME_VERSION).toBe(v.GAME_VERSION);
  });
});
