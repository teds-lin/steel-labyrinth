// wrangler.toml 與 migration 的設定檢查；並確認 wrangler（esbuild）能把 Worker 連同 web/src/core/save.js 打包。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readWranglerConfig, migrationStatements, devVarOverrides, startWorker, CONFIG_PATH, ROOT } from './helpers.js';

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

  it('正式的 ALLOWED_ORIGINS 只有 GitHub Pages；本機來源只由 worker:dev 的 --var 覆寫（修訂 2 C）', () => {
    expect(cfg.vars.ALLOWED_ORIGINS).toBe('https://teds-lin.github.io');
    expect(raw).not.toMatch(/localhost/);
    const dev = devVarOverrides();
    expect(dev.ALLOWED_ORIGINS.split(',')).toEqual(['https://teds-lin.github.io', 'http://localhost:8080', 'http://localhost:8091']);
    expect(dev.TRANSFER_PEPPER).toBeTruthy();
  });

  it('vars：修訂 2 的全域上限、容量、統計門檻、章節白名單', () => {
    expect(Number(cfg.vars.RL_PLAYER_GLOBAL_PER_HOUR)).toBe(60); // 修訂 3
    expect(Number(cfg.vars.RL_TRANSFER_GLOBAL_PER_HOUR)).toBe(120); // 修訂 3a
    expect(Number(cfg.vars.RL_WRITE_GLOBAL_PER_HOUR)).toBe(400); // 修訂 3a
    expect(Number(cfg.vars.MAX_PLAYERS)).toBe(5000); // 修訂 3
    expect(Number(cfg.vars.STATS_MIN_PLAYERS)).toBe(3);
    expect(cfg.vars.CHAPTERS).toBe('prologue,chapter1,chapter2');
    expect(cfg.vars.D1_METRICS).toBeUndefined(); // 只在測試開啟
  });

  it('Cron Trigger：每天一次（修訂 2 D）', () => {
    expect(cfg.triggers.crons).toHaveLength(1);
    const [min, hour, dom, mon, dow] = cfg.triggers.crons[0].split(' ');
    expect(/^\d+$/.test(min) && /^\d+$/.test(hour)).toBe(true);
    expect([dom, mon, dow]).toEqual(['*', '*', '*']);
  });

  it('vars：限流值', () => {
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

  it('0001 沒有被修改（已套用的 migration 不可改，修正放 0002）', () => {
    const buf = readFileSync(join(ROOT, 'worker', 'migrations', '0001_init.sql'));
    expect(createHash('sha256').update(buf).digest('hex')).toBe('9ab1734e6a5595eaf6e8cbad9afdc94778827a70eac08c5877aecd736ccc0d50');
    const files = readdirSync(join(ROOT, 'worker', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files[0]).toBe('0001_init.sql');
    expect(files[1]).toMatch(/^0002_[a-z0-9_]+\.sql$/);
  });

  it('套用全部 migration 後：rate_limits 沒有 reset_at 索引、saves 有 data_sha256 欄位', async () => {
    const w = await startWorker();
    try {
      const idx = await w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'rate_limits' AND sql IS NOT NULL").all();
      expect(idx.results).toEqual([]);
      const cols = await w.db.prepare("SELECT name FROM pragma_table_info('saves')").all();
      expect(cols.results.map((c) => c.name)).toContain('data_sha256');
    } finally {
      await w.close();
    }
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
