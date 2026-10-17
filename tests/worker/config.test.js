// wrangler.toml 與 migration 的設定檢查；並確認 wrangler（esbuild）能把 Worker 連同 web/src/core/save.js 打包。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { unstable_readConfig } from 'wrangler';
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
    // 修訂 1 E：worker:dev 改用本機設定 wrangler.e2e.toml（pepper 寫在那裡）；連真 AI 的 worker:dev:real-ai 用 --var 帶 pepper
    expect(dev.TRANSFER_PEPPER ?? unstable_readConfig({ config: join(ROOT, 'worker', 'wrangler.e2e.toml') }, { hideWarnings: true }).vars.TRANSFER_PEPPER).toBeTruthy();
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts['worker:dev:real-ai']).toMatch(/--var TRANSFER_PEPPER:\S+/);
  });

  it('vars：修訂 2 的全域上限、容量、統計門檻、章節白名單', () => {
    expect(Number(cfg.vars.RL_PLAYER_GLOBAL_PER_HOUR)).toBe(60); // 修訂 3
    expect(Number(cfg.vars.RL_TRANSFER_GLOBAL_PER_HOUR)).toBe(120); // 修訂 3a
    expect(Number(cfg.vars.RL_WRITE_GLOBAL_PER_HOUR)).toBe(100); // 修訂 4a（保留通道之外；原 400 在修訂 4 的算式下超過免費額度）
    expect(Number(cfg.vars.RL_WRITE_GLOBAL_PER_DAY)).toBe(4000); // 修訂 4a：保留通道的全域每日預算
    expect(Number(cfg.vars.PURGE_BATCH)).toBe(500); // 修訂 4 第 2 節
    expect(Number(cfg.vars.MAX_PLAYER_SECONDS)).toBe(36000); // 修訂 4 第 7 節
    expect(Number(cfg.vars.MAX_PLAYERS)).toBe(5000); // 修訂 3
    expect(Number(cfg.vars.STATS_MIN_PLAYERS)).toBe(3);
    // 章節白名單＝已開放章節（tools/release.json → web/data/manifest.json 的 chapters），開放新章節時兩邊一起改
    const manifest = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'manifest.json'), 'utf8'));
    expect(String(cfg.vars.CHAPTERS).split(',')).toEqual(manifest.chapters);
    expect(manifest.chapters.length).toBeGreaterThan(0);
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
    // 修訂 4 第 1 節：每位玩家配額降低、保留通道、IPv6 /48
    expect(Number(cfg.vars.RL_WRITE_PER_HOUR)).toBe(20);
    expect(Number(cfg.vars.RL_ROTATE_PER_HOUR)).toBe(3);
    expect(Number(cfg.vars.RL_CLEAR_PER_HOUR)).toBe(10);
    expect(Number(cfg.vars.RL_RESERVED_PER_HOUR)).toBe(3);
    expect(Number(cfg.vars.RL_PLAYER_PER_HOUR_V6_48)).toBe(10);
    expect(Number(cfg.vars.RL_TRANSFER_PER_HOUR_V6_48)).toBe(20);
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

describe('M4 鐘塔之夢的設定', () => {
  const cfg = readWranglerConfig();
  const raw = readFileSync(CONFIG_PATH, 'utf8');

  it('Workers AI 綁定 AI；模型與參數依模型評測（plans/M4-model-eval.md）', () => {
    expect(cfg.ai).toMatchObject({ binding: 'AI' });
    expect(cfg.vars.DREAM_MODEL).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(Number(cfg.vars.DREAM_MAX_TOKENS)).toBe(200);
  });

  it('額度、預算與 neurons 換算', () => {
    expect(Number(cfg.vars.DREAM_CHATS_PER_DAY)).toBe(20);
    expect(Number(cfg.vars.DREAM_NEURONS_PER_DAY)).toBe(8000);
    expect(Number(cfg.vars.DREAM_NEURONS_PER_CALL)).toBe(20);
    expect(Number(cfg.vars.DREAM_NEURONS_MIN_PER_CALL)).toBeGreaterThan(0);
    expect(Number(cfg.vars.DREAM_NEURONS_MIN_PER_CALL)).toBeLessThanOrEqual(Number(cfg.vars.DREAM_NEURONS_PER_CALL));
    // gemma-4-26b-a4b-it：輸入 0.10、輸出 0.30 美元／百萬 tokens；1000 neurons = 0.011 美元
    expect(Number(cfg.vars.DREAM_NEURONS_PER_M_INPUT)).toBe(Math.round(0.10 / 0.011 * 1000));
    expect(Number(cfg.vars.DREAM_NEURONS_PER_M_OUTPUT)).toBe(Math.round(0.30 / 0.011 * 1000));
    expect(Number(cfg.vars.RL_DREAM_PASS_PER_HOUR)).toBe(6);
    expect(Number(cfg.vars.RL_DREAM_PASS_GLOBAL_PER_HOUR)).toBeGreaterThan(0);
  });

  it('Turnstile：正式只接受 GitHub Pages 的 hostname；秘密與測試開關不寫進 wrangler.toml', () => {
    expect(cfg.vars.TURNSTILE_HOSTNAMES).toBe('teds-lin.github.io');
    for (const k of ['TURNSTILE_SECRET', 'DREAM_PASS_SECRET', 'TURNSTILE_ALLOW_TEST_SECRET']) {
      expect(cfg.vars[k], k).toBeUndefined();
      expect(raw).not.toMatch(new RegExp(`^\\s*${k}\\s*=`, 'm'));
    }
    expect(raw).not.toMatch(/1x0000000000000000000000000000000AA|2x0000000000000000000000000000000AA/);
  });

  it('migration 0003 建立 dream_personas、dream_lexicon；0002 沒有被修改', () => {
    const sql = migrationStatements().join('\n');
    expect(sql).toMatch(/CREATE TABLE dream_personas\b/);
    expect(sql).toMatch(/CREATE TABLE dream_lexicon\b/);
    const files = readdirSync(join(ROOT, 'worker', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files.slice(0, 3)).toEqual(['0001_init.sql', '0002_revision2.sql', '0003_dream.sql']);
  });

  it('migration 0004 建立 dream_blocklist（修訂 1 D）；0001～0003 不變', () => {
    const files = readdirSync(join(ROOT, 'worker', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files.slice(0, 4)).toEqual(['0001_init.sql', '0002_revision2.sql', '0003_dream.sql', '0004_dream_blocklist.sql']);
    expect(readFileSync(join(ROOT, 'worker', 'migrations', '0004_dream_blocklist.sql'), 'utf8')).toMatch(/CREATE TABLE dream_blocklist\b/);
  });

  it('公開 repo 不含人設或詞表：fixtures 之外沒有 dream/personas、lexicon.json；fixtures 的詞表是小型假詞表', () => {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      if (['node_modules', '.git', '.wrangler', 'test-results', 'playwright-report'].includes(e.name)) return [];
      const p = join(d, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
    const files = walk(ROOT).map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/'));
    const leaked = files.filter((f) => (/(^|\/)lexicon\.json$/.test(f) || /(^|\/)personas\//.test(f)) && !f.startsWith('tests/worker/fixtures/dream/'));
    expect(leaked).toEqual([]);
    const fake = JSON.parse(readFileSync(join(ROOT, 'tests', 'worker', 'fixtures', 'dream', 'lexicon.json'), 'utf8'));
    expect(fake.chars.length + fake.words.length).toBeLessThan(50);
  });
});

describe('worker/wrangler.e2e.toml（本機 E2E 專用：沒有 AI 綁定、模擬 AI、官方測試金鑰）', () => {
  const E2E = join(ROOT, 'worker', 'wrangler.e2e.toml');
  const main = readWranglerConfig();
  const e2e = unstable_readConfig({ config: E2E }, { hideWarnings: true });
  const ONLY_E2E = ['DREAM_FAKE_AI', 'TURNSTILE_SECRET', 'TURNSTILE_ALLOW_TEST_SECRET', 'DREAM_PASS_SECRET', 'TRANSFER_PEPPER'];

  it('其餘 vars 與正式設定完全相同；沒有 AI 綁定、沒有 Cron；D1 是假 id、名稱不同（誤部署也綁不到正式資料庫）', () => {
    const rest = Object.fromEntries(Object.entries(e2e.vars).filter(([k]) => !ONLY_E2E.includes(k)));
    expect(rest).toEqual(main.vars);
    expect(e2e.ai).toBeUndefined();
    expect(e2e.triggers?.crons ?? []).toEqual([]);
    expect(e2e.d1_databases[0]).toMatchObject({ binding: 'DB', database_name: 'steel-labyrinth', database_id: '00000000-0000-0000-0000-000000000000' });
    expect(e2e.name).not.toBe(main.name);
    expect(e2e.main.replace(/\\/g, '/')).toMatch(/worker\/src\/index\.js$/);
    expect(e2e.vars).toMatchObject({ DREAM_FAKE_AI: '1', TURNSTILE_SECRET: '1x0000000000000000000000000000000AA', TURNSTILE_ALLOW_TEST_SECRET: '1' });
  });

  it('以 E2E 設定啟動（沒有 AI 綁定）：測試金鑰離線通過、模擬 AI 回覆、#ai_error 改用預寫台詞', async () => {
    const { loadDreamFixtures, newSecrets, dreamChat, json: j } = await import('./helpers.js');
    const w = await startWorker({ config: E2E, noAi: true, varsOverride: { ...e2e.vars } });
    try {
      const s = { ...newSecrets(), turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' };
      const res = await w.fetch('/api/player', j(s, { 'cf-connecting-ip': w.nextIp() }));
      expect(res.status).toBe(201);
      expect(w.siteverifyCalls).toHaveLength(0);
      await loadDreamFixtures(w);
      const passRes = await w.fetch('/api/dream/pass', j({ turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }, { authorization: `Bearer ${s.token}` }));
      expect(passRes.status).toBe(200);
      const { pass } = await passRes.json();
      const ok = await (await dreamChat(w, s.token, { pass, guest: 'lamp', chapter: 'chapter1', input: '你好嗎' })).json();
      expect(ok).toMatchObject({ source: 'ai', reply: '（模擬夢客）霧裡傳來回聲：你好嗎' });
      const err = await (await dreamChat(w, s.token, { pass, guest: 'lamp', chapter: 'chapter1', input: '#ai_error' })).json();
      expect(err).toMatchObject({ source: 'scripted', reason: 'ai_error' });
      const filtered = await (await dreamChat(w, s.token, { pass, guest: 'lamp', chapter: 'chapter1', input: '这是什么' })).json();
      expect(filtered).toMatchObject({ source: 'scripted', reason: 'filtered' });
    } finally {
      await w.close();
    }
  });

  it('正式設定下沒有模擬 AI：沒有 AI 綁定時即使設了 DREAM_FAKE_AI 以外的值也不會假造回覆', async () => {
    const { loadDreamFixtures, newPlayer, getPass, dreamChat } = await import('./helpers.js');
    expect(main.vars.DREAM_FAKE_AI).toBeUndefined();
    const w = await startWorker({ noAi: true });
    try {
      await loadDreamFixtures(w);
      const p = await newPlayer(w);
      const body = await (await dreamChat(w, p.token, { pass: await getPass(w, p.token), guest: 'lamp', chapter: 'chapter1', input: '你好' })).json();
      expect(body).toMatchObject({ source: 'scripted', reason: 'ai_error' });
    } finally {
      await w.close();
    }
  });
});
