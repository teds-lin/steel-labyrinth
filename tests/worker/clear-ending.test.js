// M5：POST /api/clear 的 ending 改用 vars ENDINGS 白名單（P7）；不新增任何 D1 寫入（Q4）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startWorker, newPlayer, auth, expectError, d1Rows, readWranglerConfig, ROOT } from './helpers.js';

const WHITELIST = 'lamp_kept, fog_walker ,dawn'; // 逗號分隔，前後空白要容許
let w;
beforeAll(async () => { w = await startWorker({ varsOverride: { ENDINGS: WHITELIST } }); });
afterAll(async () => { await w?.close(); });

const clear = (token, body, s = w) => s.fetch('/api/clear', {
  method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), body: JSON.stringify(body),
});
const ok = (over = {}) => ({ chapter: 'chapter3', ending: null, play_seconds: 3600, collapse: 34, ...over });

describe('POST /api/clear：ending 白名單（vars ENDINGS）', () => {
  it('白名單內的 ending → 200，寫進同一列的 ending 欄位', async () => {
    const p = await newPlayer(w);
    const res = await clear(p.token, ok({ ending: 'fog_walker' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chapter: 'chapter3', best_play_seconds: 3600 });
    const rows = await w.db.prepare('SELECT chapter, ending FROM clears WHERE player_id = ?').bind(p.player_id).all();
    expect(rows.results).toEqual([{ chapter: 'chapter3', ending: 'fog_walker' }]);
  });

  it('改善成績時 ending 跟著更新；沒有改善時不變', async () => {
    const p = await newPlayer(w);
    await clear(p.token, ok({ ending: 'dawn', play_seconds: 5000 }));
    await clear(p.token, ok({ ending: 'lamp_kept', play_seconds: 4000 }));
    await clear(p.token, ok({ ending: 'fog_walker', play_seconds: 9000 }));
    const row = await w.db.prepare('SELECT ending, play_seconds FROM clears WHERE player_id = ?').bind(p.player_id).first();
    expect(row).toEqual({ ending: 'lamp_kept', play_seconds: 4000 });
  });

  it('沒有結局的章節仍送 null（或省略）', async () => {
    const p = await newPlayer(w);
    expect((await clear(p.token, ok({ ending: null }))).status).toBe(200);
    const { ending, ...noEnding } = ok({ chapter: 'chapter2' });
    expect((await clear(p.token, noEnding)).status).toBe(200);
  });

  it.each([
    'true_end', 'Dawn', 'dawn ', ' dawn', '', 'lamp_kept,dawn', 'chapter3', '__proto__', 'toString', false, 0, 1, true, ['dawn'], { id: 'dawn' },
  ])('不在白名單（%j）→ 400，不寫入', async (e) => {
    const p = await newPlayer(w); // 每次用新玩家：同一玩家每小時只能回報 RL_CLEAR_PER_HOUR 次
    await expectError(await clear(p.token, ok({ ending: e })), 400, 'bad_request');
    const n = await w.db.prepare('SELECT COUNT(*) AS n FROM clears WHERE player_id = ?').bind(p.player_id).first();
    expect(n.n).toBe(0);
  });

  it('ENDINGS 是空字串（目前的正式設定）→ 任何字串 ending 都 400，null 照常', async () => {
    const s = await startWorker({ varsOverride: { ENDINGS: '' } });
    try {
      const p = await newPlayer(s);
      for (const e of ['dawn', '', 'lamp_kept']) await expectError(await clear(p.token, ok({ ending: e }), s), 400, 'bad_request');
      expect((await clear(p.token, ok(), s)).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe('Q4：ending 不增加任何寫入列數（x-d1-rows 實測）', () => {
  it('新紀錄／改善成績／沒有改善：帶 ending 與 ending: null 的寫入列數完全相同', async () => {
    const measure = async (ending) => {
      const p = await newPlayer(w);
      const out = [];
      for (const ps of [100, 99, 500]) {
        const res = await clear(p.token, ok({ ending, play_seconds: ps }));
        expect(res.status).toBe(200);
        out.push(d1Rows(res).written);
        await res.arrayBuffer();
      }
      return out;
    };
    const withNull = await measure(null);
    const withEnding = await measure('dawn');
    expect(withEnding).toEqual(withNull);
    expect(withNull[0]).toBeGreaterThan(0);
  });

  it('/api/clear 仍然只有一個 INSERT … ON CONFLICT 寫入敘述（ending 用參數綁定，不是新的寫入路徑）', () => {
    const src = readFileSync(join(ROOT, 'worker', 'src', 'index.js'), 'utf8');
    const body = src.slice(src.indexOf('async function reportClear'), src.indexOf('async function stats'));
    expect(body.match(/\b(INSERT|UPDATE|DELETE)\b/g)).toEqual(['INSERT', 'UPDATE']); // INSERT … ON CONFLICT DO UPDATE
    expect(body).not.toMatch(/ending\s*=\s*['"`]/); // 不把 ending 拼進 SQL 字串
  });
});

describe('vars ENDINGS（wrangler.toml）', () => {
  const ids = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  it('wrangler.toml 與 wrangler.e2e.toml 都有 ENDINGS（字串）；每個 id 是 [a-z0-9_]{1,32}', () => {
    for (const f of ['wrangler.toml', 'wrangler.e2e.toml']) {
      const raw = readFileSync(join(ROOT, 'worker', f), 'utf8');
      expect(raw, f).toMatch(/^ENDINGS = "/m);
    }
    for (const id of ids(readWranglerConfig().vars.ENDINGS)) expect(id).toMatch(/^[a-z0-9_]{1,32}$/);
  });

  it('ENDINGS 必須等於公開資料裡所有 endings 的 id（之後由主 session 依故事聖經填入；資料加了結局就要同步）', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'manifest.json'), 'utf8'));
    const fromData = [];
    for (const id of manifest.files?.story ?? []) {
      const story = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'story', `${id}.json`), 'utf8'));
      for (const e of Array.isArray(story.endings) ? story.endings : []) fromData.push(e.id);
    }
    expect(ids(readWranglerConfig().vars.ENDINGS).sort()).toEqual(fromData.sort());
  });
});
