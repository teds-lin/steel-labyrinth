// wrangler.toml 與 migration 的設定檢查；並確認 wrangler（esbuild）能把 Worker 連同 web/src/core/save.js 打包。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readWranglerConfig, migrationStatements, CONFIG_PATH, ROOT } from './helpers.js';

describe('wrangler.toml', () => {
  const cfg = readWranglerConfig();
  const raw = readFileSync(CONFIG_PATH, 'utf8');

  it('名稱、入口、相容日期', () => {
    expect(cfg.name).toBe('steel-labyrinth');
    expect(cfg.main.replace(/\\/g, '/')).toMatch(/worker\/src\/index\.js$/);
    expect(cfg.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cfg.compatibility_date <= '2026-10-17').toBe(true);
  });

  it('D1 綁定 DB（database_name steel-labyrinth）', () => {
    expect(cfg.d1_databases).toHaveLength(1);
    expect(cfg.d1_databases[0]).toMatchObject({ binding: 'DB', database_name: 'steel-labyrinth' });
    expect(cfg.d1_databases[0].migrations_dir ?? 'migrations').toBe('migrations');
  });

  it('vars：允許來源與限流值', () => {
    expect(String(cfg.vars.ALLOWED_ORIGINS).split(',')).toEqual(['https://teds-lin.github.io', 'http://localhost:8080', 'http://localhost:8091']);
    expect(Number(cfg.vars.RL_PLAYER_PER_HOUR)).toBe(5);
    expect(Number(cfg.vars.RL_TRANSFER_PER_HOUR)).toBe(10);
    expect(Number(cfg.vars.RL_WRITE_PER_HOUR)).toBe(60);
    expect(Number(cfg.vars.RL_ROTATE_PER_HOUR)).toBe(10);
    expect(Number(cfg.vars.RL_CLEAR_PER_HOUR)).toBe(30);
  });

  it('沒有任何密鑰寫進 repo', () => {
    expect(cfg.vars.TRANSFER_PEPPER).toBeUndefined();
    expect(raw).not.toMatch(/^\s*TRANSFER_PEPPER\s*=/m);
  });

  it('.gitignore 排除本機 secret 與 wrangler 狀態', () => {
    const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((s) => s.trim());
    expect(gi).toContain('.dev.vars');
    expect(gi).toContain('.wrangler/');
  });
});

describe('migration', () => {
  it('建立四張表與索引', () => {
    const sql = migrationStatements().join('\n');
    for (const t of ['players', 'saves', 'clears', 'rate_limits']) expect(sql).toMatch(new RegExp(`CREATE TABLE ${t}\\b`));
    expect(sql).toMatch(/CREATE INDEX/);
    expect(existsSync(join(ROOT, 'worker', 'migrations', '0001_init.sql'))).toBe(true);
  });
});

describe('wrangler 打包（dry-run，不需要登入）', () => {
  it('能把 Worker 與共用的 save.js 打包成單一模組', () => {
    // 固定輸出到 node_modules/.cache（已被 .gitignore 排除），每次覆寫，不留暫存目錄。
    const out = join(ROOT, 'node_modules', '.cache', 'steel-labyrinth-worker-build');
    mkdirSync(out, { recursive: true });
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'deploy', '--dry-run', '--config', CONFIG_PATH, '--outdir', out], {
      cwd: ROOT,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_UPDATE_NOTIFIER: '1' },
      stdio: 'pipe',
      timeout: 60000,
    });
    const js = readdirSync(out).filter((f) => f.endsWith('.js'));
    expect(js).toEqual(['index.js']);
    const bundled = readFileSync(join(out, 'index.js'), 'utf8');
    // 來自 web/src/core/save.js 與 name.js（esbuild 會把非 ASCII 字元轉義，所以比對 ASCII 識別字）
    expect(bundled).toContain('chapter_done');
    expect(bundled).toMatch(/function deserialize\(/);
    expect(bundled).toMatch(/function sanitizeName\(/);
  }, 60000);
});
