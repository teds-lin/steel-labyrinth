// POST /api/clear 與 GET /api/stats。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWorker, newPlayer, auth, expectError } from './helpers.js';

let w;
beforeAll(async () => { w = await startWorker(); });
afterAll(async () => { await w?.close(); });

const clear = (token, body) => w.fetch('/api/clear', {
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

  it('同一章只保留遊戲時間最短的一筆（含結局與崩解）', async () => {
    const p = await newPlayer(w);
    await clear(p.token, ok({ play_seconds: 5000, collapse: 10, ending: 'end_a' }));
    expect(await (await clear(p.token, ok({ play_seconds: 3500, collapse: 50, ending: 'end_b' }))).json())
      .toEqual({ chapter: 'chapter2', best_play_seconds: 3500 });
    expect(await (await clear(p.token, ok({ play_seconds: 9000, collapse: 1, ending: null }))).json())
      .toEqual({ chapter: 'chapter2', best_play_seconds: 3500 });
    const rows = await w.db.prepare('SELECT * FROM clears WHERE player_id = ?').bind(p.player_id).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ chapter: 'chapter2', play_seconds: 3500, collapse: 50, ending: 'end_b' });
  });

  it('不同章各自記錄', async () => {
    const p = await newPlayer(w);
    await clear(p.token, ok({ chapter: 'chapter1', play_seconds: 100 }));
    await clear(p.token, ok({ chapter: 'chapter3', play_seconds: 300 }));
    const rows = await w.db.prepare('SELECT chapter FROM clears WHERE player_id = ? ORDER BY chapter').bind(p.player_id).all();
    expect(rows.results.map((r) => r.chapter)).toEqual(['chapter1', 'chapter3']);
  });

  it('邊界值可以接受', async () => {
    const p = await newPlayer(w);
    for (const b of [
      ok({ chapter: 'a', play_seconds: 0, collapse: 0 }),
      ok({ chapter: 'z'.repeat(32), play_seconds: 1e7, collapse: 100, ending: 'e'.repeat(32) }),
      ok({ chapter: 'ch_2_x', ending: 'true_end_1' }),
    ]) expect((await clear(p.token, b)).status).toBe(200);
    const { ending, ...noEnding } = ok({ chapter: 'no_ending' });
    expect((await clear(p.token, noEnding)).status).toBe(200);
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
    ['ending 是數字', ok({ ending: 1 })],
    ['play_seconds 負數', ok({ play_seconds: -1 })],
    ['play_seconds 太大', ok({ play_seconds: 1e7 + 1 })],
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
  it('各章完成人數與平均遊戲時間；不含任何玩家 id；可快取 60 秒', async () => {
    const s = await startWorker();
    try {
      const players = [];
      for (let i = 0; i < 3; i++) players.push(await newPlayer(s));
      const c = (p, body) => s.fetch('/api/clear', { method: 'POST', headers: auth(p.token), body: JSON.stringify(body) });
      await c(players[0], ok({ chapter: 'chapter1', play_seconds: 1000 }));
      await c(players[1], ok({ chapter: 'chapter1', play_seconds: 2001 }));
      await c(players[1], ok({ chapter: 'chapter1', play_seconds: 3000 })); // 不是最好，不影響
      await c(players[2], ok({ chapter: 'chapter2', play_seconds: 500 }));

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
});
