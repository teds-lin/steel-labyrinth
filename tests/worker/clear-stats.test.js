// POST /api/clear 與 GET /api/stats。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startWorker, newPlayer, auth, expectError, d1Rows, readWranglerConfig, ROOT } from './helpers.js';

let w;
beforeAll(async () => { w = await startWorker(); });
afterAll(async () => { await w?.close(); });

const clear = (token, body, s = w) => s.fetch('/api/clear', {
  method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), body: typeof body === 'string' ? body : JSON.stringify(body),
});
const ok = (over = {}) => ({ chapter: 'chapter2', ending: null, play_seconds: 3600, collapse: 34, ...over });

describe('POST /api/clear', () => {
  it('200：回 chapter 與 best_play_seconds', async () => {
    const p = await newPlayer(w);
    const res = await clear(p.token, ok());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chapter: 'chapter2', best_play_seconds: 3600 });
  });

  it('同一章只保留遊戲時間最短的一筆（含崩解）', async () => {
    const p = await newPlayer(w);
    await clear(p.token, ok({ play_seconds: 5000, collapse: 10 }));
    expect(await (await clear(p.token, ok({ play_seconds: 3500, collapse: 50 }))).json())
      .toEqual({ chapter: 'chapter2', best_play_seconds: 3500 });
    expect(await (await clear(p.token, ok({ play_seconds: 9000, collapse: 1 }))).json())
      .toEqual({ chapter: 'chapter2', best_play_seconds: 3500 });
    const rows = await w.db.prepare('SELECT * FROM clears WHERE player_id = ?').bind(p.player_id).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ chapter: 'chapter2', play_seconds: 3500, collapse: 50, ending: null });
  });

  it('不同章各自記錄', async () => {
    const p = await newPlayer(w);
    await clear(p.token, ok({ chapter: 'chapter1', play_seconds: 100 }));
    await clear(p.token, ok({ chapter: 'prologue', play_seconds: 300 }));
    const rows = await w.db.prepare('SELECT chapter FROM clears WHERE player_id = ? ORDER BY chapter').bind(p.player_id).all();
    expect(rows.results.map((r) => r.chapter)).toEqual(['chapter1', 'prologue']);
  });

  it('邊界值可以接受；ending 可以省略', async () => {
    const p = await newPlayer(w);
    for (const b of [
      ok({ chapter: 'prologue', play_seconds: 0, collapse: 0 }),
      ok({ chapter: 'chapter1', play_seconds: 36000, collapse: 100 }), // 修訂 4 第 7 節：MAX_PLAYER_SECONDS
      ok({ chapter: 'chapter3' }), // M4：第三章開放
    ]) expect((await clear(p.token, b)).status).toBe(200);
    const { ending, ...noEnding } = ok({ chapter: 'chapter2' });
    expect((await clear(p.token, noEnding)).status).toBe(200);
  });

  // 真正還沒開放的章節：CHAPTERS 裡編號最大的 chapterN 的下一章（開放新章節後自動往後推；M5 起最後一章是 finale，不能直接取最後一個）
  const UNRELEASED = `chapter${Math.max(...String(readWranglerConfig().vars.CHAPTERS).split(',').map((c) => /^chapter(\d+)$/.exec(c.trim())?.[1]).filter(Boolean).map(Number)) + 1}`;
  it('UNRELEASED 確實不在 CHAPTERS 白名單內', () => {
    expect(UNRELEASED).toMatch(/^chapter\d+$/);
    expect(String(readWranglerConfig().vars.CHAPTERS).split(',')).not.toContain(UNRELEASED);
  });
  it('chapter 不在 CHAPTERS 白名單 → 400，不寫入（修訂 2 E；審查 t1：一小時灌 30 個假章節）', async () => {
    const p = await newPlayer(w);
    for (let i = 0; i < 5; i++) await expectError(await clear(p.token, ok({ chapter: `spam_${i}` })), 400, 'bad_request');
    for (const c of [UNRELEASED, 'a', 'z'.repeat(32), 'ch_2_x', 'Chapter1']) await expectError(await clear(p.token, ok({ chapter: c })), 400, 'bad_request');
    const rows = await w.db.prepare('SELECT COUNT(*) AS n FROM clears WHERE player_id = ?').bind(p.player_id).first();
    expect(rows.n).toBe(0);
  });

  it('ENDINGS 是空字串（正式設定目前如此）：給字串 ending → 400', async () => {
    const p = await newPlayer(w);
    for (const e of ['end_a', 'true_end_1', 'chapter1']) await expectError(await clear(p.token, ok({ ending: e })), 400, 'bad_request');
  });

  it.each([
    ['壞 JSON', '{"chapter":'],
    ['不是物件', '[]'],
    ['缺 chapter', { ending: null, play_seconds: 1, collapse: 1 }],
    ['chapter 空字串', ok({ chapter: '' })],
    ['chapter 太長', ok({ chapter: 'a'.repeat(33) })],
    ['chapter 大寫', ok({ chapter: 'Chapter2' })],
    ['chapter 有連字號', ok({ chapter: 'chapter-2' })],
    ['chapter 有空白', ok({ chapter: 'chapter 2' })],
    ['chapter 是中文', ok({ chapter: '第二章' })],
    ['chapter SQL 注入', ok({ chapter: "x'; DROP TABLE clears; --" })],
    ['chapter 不是字串', ok({ chapter: 2 })],
    ['ending 格式錯', ok({ ending: 'End!' })],
    ['ending 是 false', ok({ ending: false })],
    ['ending 是數字', ok({ ending: 1 })],
    ['play_seconds 負數', ok({ play_seconds: -1 })],
    ['play_seconds 太大（> MAX_PLAYER_SECONDS）', ok({ play_seconds: 36001 })],
    ['play_seconds 是字串', ok({ play_seconds: '3600' })],
    ['play_seconds 缺少', { chapter: 'c', ending: null, collapse: 1 }],
    ['collapse 小數', ok({ collapse: 3.5 })],
    ['collapse 超過 100', ok({ collapse: 101 })],
    ['collapse 負數', ok({ collapse: -1 })],
    ['collapse 缺少', { chapter: 'c', ending: null, play_seconds: 1 }],
  ])('%s → 400', async (_, body) => {
    const p = await newPlayer(w);
    await expectError(await clear(p.token, body), 400, 'bad_request');
    const t = await w.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='clears'").first();
    expect(t.n).toBe(1);
  });
});

describe('GET /api/stats', () => {
  const clearIn = (s, p, body) => clear(p.token, body, s);

  it('各章完成人數與平均遊戲時間；不含任何玩家 id；可快取 60 秒', async () => {
    const s = await startWorker({ varsOverride: { STATS_MIN_PLAYERS: '1' } });
    try {
      const players = [];
      for (let i = 0; i < 3; i++) players.push(await newPlayer(s));
      await clearIn(s, players[0], ok({ chapter: 'chapter1', play_seconds: 1000 }));
      await clearIn(s, players[1], ok({ chapter: 'chapter1', play_seconds: 3000 }));
      await clearIn(s, players[1], ok({ chapter: 'chapter1', play_seconds: 2001 })); // 改善成績：平均跟著變
      await clearIn(s, players[1], ok({ chapter: 'chapter1', play_seconds: 2500 })); // 不是最好，不影響
      await clearIn(s, players[2], ok({ chapter: 'chapter2', play_seconds: 500 }));

      const before = Math.floor(Date.now() / 1000);
      const res = await s.fetch('/api/stats');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
      const text = await res.text();
      for (const p of players) {
        expect(text).not.toContain(p.player_id);
        expect(text).not.toContain(p.token);
      }
      expect(text).not.toContain('player_id');
      const body = JSON.parse(text);
      expect(body.chapters).toEqual([
        { chapter: 'chapter1', players: 2, avg_play_seconds: 1501 },
        { chapter: 'chapter2', players: 1, avg_play_seconds: 500 },
      ]);
      expect(Number.isInteger(body.generated_at)).toBe(true);
      expect(body.generated_at).toBeGreaterThanOrEqual(before - 1);
    } finally {
      await s.close();
    }
  });

  it('沒有任何紀錄 → 空陣列；不需要權杖', async () => {
    const s = await startWorker();
    try {
      const res = await s.fetch('/api/stats');
      expect(res.status).toBe(200);
      expect((await res.json()).chapters).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('完成人數少於 STATS_MIN_PLAYERS（預設 3）的章節不出現（修訂 2 E）', async () => {
    const s = await startWorker();
    try {
      expect(Number(readWranglerConfig().vars.STATS_MIN_PLAYERS)).toBe(3);
      const ps = [];
      for (let i = 0; i < 3; i++) ps.push(await newPlayer(s));
      for (const p of ps) await clearIn(s, p, ok({ chapter: 'chapter1', play_seconds: 600 }));
      for (const p of ps.slice(0, 2)) await clearIn(s, p, ok({ chapter: 'chapter2', play_seconds: 900 }));
      const body = await (await s.fetch('/api/stats')).json();
      expect(body.chapters).toEqual([{ chapter: 'chapter1', players: 3, avg_play_seconds: 600 }]);
    } finally {
      await s.close();
    }
  });

  it('Cache API 快取 60 秒：第二次請求不查 D1，回同一份內容（修訂 2 E）', async () => {
    const s = await startWorker({ varsOverride: { STATS_MIN_PLAYERS: '1' } });
    try {
      const p = await newPlayer(s);
      await clearIn(s, p, ok({ chapter: 'chapter1', play_seconds: 100 }));
      const first = await s.fetch('/api/stats');
      expect(d1Rows(first).read).toBeGreaterThan(0);
      const a = await first.json();
      await clearIn(s, p, ok({ chapter: 'chapter2', play_seconds: 100 })); // 60 秒內的新紀錄不會馬上出現
      for (let i = 0; i < 3; i++) {
        const again = await s.fetch('/api/stats', { headers: { origin: 'https://teds-lin.github.io' } });
        expect(d1Rows(again)).toEqual({ read: 0, written: 0 });
        expect(again.headers.get('access-control-allow-origin')).toBe('https://teds-lin.github.io');
        expect(again.headers.get('cache-control')).toBe('public, max-age=60');
        expect(await again.json()).toEqual(a);
      }
      const cached = await (await s.mf.getCaches()).default.match('https://worker.test/api/stats');
      expect(cached).toBeTruthy();
      expect(cached.headers.get('cache-control')).toBe('public, max-age=60');
      await cached.text();
    } finally {
      await s.close();
    }
  });

  it('統計查詢的讀取列數只和章節數有關，與通關紀錄筆數無關（審查 t1：5035 筆讀 5030 列）', async () => {
    const s = await startWorker({ varsOverride: { STATS_MIN_PLAYERS: '1' } });
    try {
      const ids = JSON.stringify(Array.from({ length: 3000 }, (_, i) => i));
      await s.db.prepare(`INSERT INTO players (player_id, token_hash, transfer_hash, created_at, last_seen)
        SELECT 'p' || value, 't' || value, 'x' || value, 0, 0 FROM json_each(?)`).bind(ids).run();
      await s.db.prepare(`INSERT INTO clears (player_id, chapter, ending, play_seconds, collapse, created_at)
        SELECT 'p' || value, 'chapter1', NULL, 100 + value % 2, 0, 0 FROM json_each(?)`).bind(ids).run();
      const res = await s.fetch('/api/stats');
      expect(d1Rows(res).read).toBeLessThanOrEqual(10);
      expect((await res.json()).chapters).toEqual([{ chapter: 'chapter1', players: 3000, avg_play_seconds: 101 }]);
    } finally {
      await s.close();
    }
  });
});

describe('CHAPTERS 白名單（修訂 2 E）', () => {
  it('wrangler.toml 的 CHAPTERS 等於 web/data/manifest.json 的 chapters', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'manifest.json'), 'utf8'));
    expect(String(readWranglerConfig().vars.CHAPTERS).split(',')).toEqual(manifest.chapters);
  });
});
