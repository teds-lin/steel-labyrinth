// GET /api/saves、GET／PUT／DELETE /api/save/:slot：成功路徑、400、413、428、409（含並行）、404、SQL 注入字串。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWorker, newPlayer, auth, putSave, expectError, sampleSave, sampleState } from './helpers.js';

let w;
beforeAll(async () => { w = await startWorker(); });
afterAll(async () => { await w?.close(); });

const getSave = (token, slot) => w.fetch(`/api/save/${slot}`, { headers: auth(token) });
const del = (token, slot, version) => w.fetch(`/api/save/${slot}`, {
  method: 'DELETE', headers: auth(token, version === undefined ? {} : { 'if-match': `"${version}"` }),
});

describe('GET /api/saves', () => {
  it('新玩家：固定 3 筆空槽', async () => {
    const p = await newPlayer(w);
    const res = await w.fetch('/api/saves', { headers: auth(p.token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slots: [{ slot: 1, empty: true }, { slot: 2, empty: true }, { slot: 3, empty: true }] });
  });

  it('有存檔的槽回版本、時間、摘要；其他仍是空槽；看不到別的玩家', async () => {
    const p = await newPlayer(w);
    const other = await newPlayer(w);
    await putSave(w, other.token, 1, sampleSave({ player: { name: '別人' } }));
    const before = Math.floor(Date.now() / 1000);
    expect((await putSave(w, p.token, 2, sampleSave({ playtime_s: 77 }))).status).toBe(200);
    const { slots } = await (await w.fetch('/api/saves', { headers: auth(p.token) })).json();
    expect(slots).toHaveLength(3);
    expect(slots[0]).toEqual({ slot: 1, empty: true });
    expect(slots[1]).toEqual({
      slot: 2, version: 1, updated_at: expect.any(Number),
      summary: { name: '雷恩', map: 'prologue_hall', chapter: 'chapter1', playtime_s: 77, schema_version: 2 },
    });
    expect(Number.isInteger(slots[1].updated_at)).toBe(true);
    expect(slots[1].updated_at).toBeGreaterThanOrEqual(before - 1);
    expect(slots[2]).toEqual({ slot: 3, empty: true });
  });
});

describe('PUT /api/save/:slot 成功路徑', () => {
  it('If-None-Match: * 建立 → 200 版本 1＋ETag；GET 拿回同一份字串', async () => {
    const p = await newPlayer(w);
    const data = sampleSave();
    const res = await putSave(w, p.token, 1, data);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"1"');
    const body = await res.json();
    expect(body).toEqual({ slot: 1, version: 1, updated_at: expect.any(Number) });

    const g = await getSave(p.token, 1);
    expect(g.status).toBe(200);
    expect(g.headers.get('etag')).toBe('"1"');
    expect(await g.json()).toEqual({ slot: 1, version: 1, updated_at: body.updated_at, data });
  });

  it('If-Match 覆蓋 → 版本遞增', async () => {
    const p = await newPlayer(w);
    await putSave(w, p.token, 3, sampleSave());
    const r2 = await putSave(w, p.token, 3, sampleSave({ playtime_s: 200 }), { match: 1 });
    expect(r2.status).toBe(200);
    expect((await r2.json()).version).toBe(2);
    expect(r2.headers.get('etag')).toBe('"2"');
    const r3 = await putSave(w, p.token, 3, sampleSave({ playtime_s: 300 }), { match: 2 });
    expect((await r3.json()).version).toBe(3);
    expect(JSON.parse((await (await getSave(p.token, 3)).json()).data).playtime_s).toBe(300);
  });

  it('If-Match 也接受不帶引號與弱 ETag（W/"n"）', async () => {
    const p = await newPlayer(w);
    await putSave(w, p.token, 1, sampleSave());
    const h = (m) => ({ method: 'PUT', headers: auth(p.token, { 'if-match': m }), body: JSON.stringify({ data: sampleSave() }) });
    expect((await w.fetch('/api/save/1', h('1'))).status).toBe(200);
    expect((await w.fetch('/api/save/1', h('W/"2"'))).status).toBe(200);
  });

  it('版本較新的存檔（schema_version 比伺服器新）照樣接受', async () => {
    const p = await newPlayer(w);
    const data = JSON.stringify({ ...sampleState(), schema_version: 99, future: { x: 1 } });
    const res = await putSave(w, p.token, 1, data);
    expect(res.status).toBe(200);
    const { slots } = await (await w.fetch('/api/saves', { headers: auth(p.token) })).json();
    expect(slots[0].summary.schema_version).toBe(99);
  });

  it('摘要的名字最多 8 字', async () => {
    const p = await newPlayer(w);
    await putSave(w, p.token, 1, sampleSave({ player: { name: '一二三四五六七八九' } }));
    const { slots } = await (await w.fetch('/api/saves', { headers: auth(p.token) })).json();
    expect(slots[0].summary.name).toBe('一二三四五六七八');
  });

  it('SQL 注入字串只會被當成資料', async () => {
    const p = await newPlayer(w);
    const evil = "'); DROP TABLE saves; --";
    const data = sampleSave({ player: { name: evil.slice(0, 8) }, location: { map: evil, x: 0, y: 0, dir: 'down' }, flags: { [evil]: true } });
    expect((await putSave(w, p.token, 1, data)).status).toBe(200);
    expect((await (await getSave(p.token, 1)).json()).data).toBe(data);
    const { slots } = await (await w.fetch('/api/saves', { headers: auth(p.token) })).json();
    expect(slots[0].summary.map).toBe(evil);
    const t = await w.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='saves'").first();
    expect(t?.name).toBe('saves');
  });
});

describe('400 bad_request／invalid_save', () => {
  let p;
  beforeAll(async () => { p = await newPlayer(w); });

  it.each(['0', '4', 'abc', '-1', '1.5', '01', '%27%20OR%201', '99999999999999999999'])('slot %s → 400', async (slot) => {
    await expectError(await getSave(p.token, slot), 400, 'bad_request');
    await expectError(await putSave(w, p.token, slot, sampleSave()), 400, 'bad_request');
    await expectError(await del(p.token, slot, 1), 400, 'bad_request');
  });

  it('壞 JSON body → 400', async () => {
    const res = await w.fetch('/api/save/1', { method: 'PUT', headers: auth(p.token, { 'if-none-match': '*' }), body: '{"data":' });
    await expectError(res, 400, 'bad_request');
  });

  it.each([
    ['缺 data', {}], ['data 不是字串', { data: { a: 1 } }], ['data 是數字', { data: 5 }], ['body 是陣列', [1]], ['body 是 null', null],
  ])('%s → 400 bad_request', async (_, body) => {
    const res = await w.fetch('/api/save/1', { method: 'PUT', headers: auth(p.token, { 'if-none-match': '*' }), body: JSON.stringify(body) });
    await expectError(res, 400, 'bad_request');
  });

  it.each([
    ['不是 JSON', 'not json'],
    ['不是物件', '[1,2]'],
    ['缺 schema_version', JSON.stringify(sampleState())],
    ['缺欄位', JSON.stringify({ schema_version: 2, player: { name: 'a' } })],
    ['欄位型別錯誤', JSON.stringify({ ...sampleState(), schema_version: 2, collapse: 'x' })],
    ['沒有遷移方法的舊版本', JSON.stringify({ ...sampleState(), schema_version: -1 })],
  ])('存檔%s → 400 invalid_save', async (_, data) => {
    await expectError(await putSave(w, p.token, 1, data), 400, 'invalid_save');
  });

  it('invalid_save 不會寫入任何東西', async () => {
    const q = await newPlayer(w);
    await putSave(w, q.token, 1, '{');
    await expectError(await getSave(q.token, 1), 404, 'not_found');
  });

  it('同時帶 If-Match 與 If-None-Match、或 If-Match 不是版本號 → 400', async () => {
    const mk = (h) => w.fetch('/api/save/1', { method: 'PUT', headers: auth(p.token, h), body: JSON.stringify({ data: sampleSave() }) });
    await expectError(await mk({ 'if-match': '"1"', 'if-none-match': '*' }), 400, 'bad_request');
    for (const m of ['"abc"', '*', '"0"', '"-1"', '"1.5"', '"1", "2"']) await expectError(await mk({ 'if-match': m }), 400, 'bad_request');
    await expectError(await mk({ 'if-none-match': '"1"' }), 400, 'bad_request');
  });
});

describe('413 too_large', () => {
  let p;
  beforeAll(async () => { p = await newPlayer(w); });

  it('存檔內容超過 64 KB → 413（body 還在 80 KB 內）', async () => {
    const data = sampleSave({ flags: { pad: 'x'.repeat(65 * 1024) } });
    await expectError(await putSave(w, p.token, 1, data), 413, 'too_large');
  });

  it('存檔剛好 64 KB 內 → 接受', async () => {
    const base = sampleSave({ flags: { pad: '' } });
    const data = sampleSave({ flags: { pad: 'x'.repeat(64 * 1024 - new TextEncoder().encode(base).length) } });
    expect(new TextEncoder().encode(data).length).toBe(64 * 1024);
    expect((await putSave(w, p.token, 2, data)).status).toBe(200);
    const over = sampleSave({ flags: { pad: 'x'.repeat(64 * 1024 - new TextEncoder().encode(base).length + 1) } });
    await expectError(await putSave(w, p.token, 3, over), 413, 'too_large');
  });

  it('存檔以 UTF-8 位元組計算（中文 3 bytes）', async () => {
    const data = sampleSave({ flags: { pad: '鋼'.repeat(22 * 1024) } }); // 字元數 < 64K，但位元組 > 64 KB
    expect(data.length).toBeLessThan(64 * 1024);
    await expectError(await putSave(w, p.token, 3, data), 413, 'too_large');
  });

  it('body 超過 80 KB（有正確 content-length）→ 413', async () => {
    await expectError(await putSave(w, p.token, 1, 'x'.repeat(100 * 1024)), 413, 'too_large');
  });

  it('body 超過 80 KB 且沒有 content-length（串流 chunked）→ 413', async () => {
    const big = new TextEncoder().encode(JSON.stringify({ data: 'y'.repeat(300 * 1024) }));
    const body = new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 8192) c.enqueue(big.slice(i, i + 8192)); c.close(); } });
    const res = await w.fetch('/api/save/1', { method: 'PUT', headers: auth(p.token, { 'if-none-match': '*' }), body, duplex: 'half' });
    await expectError(res, 413, 'too_large');
  });

  it('超大 body 打 POST /api/player、/api/clear、/api/transfer 也是 413', async () => {
    const big = JSON.stringify({ pad: 'z'.repeat(90 * 1024) });
    await expectError(await w.fetch('/api/player', { method: 'POST', headers: { 'cf-connecting-ip': w.nextIp() }, body: big }), 413, 'too_large');
    await expectError(await w.fetch('/api/clear', { method: 'POST', headers: auth(p.token), body: big }), 413, 'too_large');
    await expectError(await w.fetch('/api/transfer', { method: 'POST', headers: { 'cf-connecting-ip': w.nextIp() }, body: big }), 413, 'too_large');
  });
});

describe('428／409 版本控制', () => {
  it('PUT 沒有 If-Match 也沒有 If-None-Match → 428', async () => {
    const p = await newPlayer(w);
    const res = await w.fetch('/api/save/1', { method: 'PUT', headers: auth(p.token), body: JSON.stringify({ data: sampleSave() }) });
    await expectError(res, 428, 'precondition_required');
  });

  it('If-None-Match: * 但槽已有存檔 → 409 附 current', async () => {
    const p = await newPlayer(w);
    const first = await (await putSave(w, p.token, 1, sampleSave({ playtime_s: 11 }))).json();
    const body = await expectError(await putSave(w, p.token, 1, sampleSave()), 409, 'conflict');
    expect(body.current).toEqual({
      version: 1, updated_at: first.updated_at,
      summary: { name: '雷恩', map: 'prologue_hall', chapter: 'chapter1', playtime_s: 11, schema_version: 2 },
    });
  });

  it('If-Match 版本不符 → 409 附 current，資料不變', async () => {
    const p = await newPlayer(w);
    await putSave(w, p.token, 2, sampleSave({ playtime_s: 1 }));
    await putSave(w, p.token, 2, sampleSave({ playtime_s: 2 }), { match: 1 });
    const body = await expectError(await putSave(w, p.token, 2, sampleSave({ playtime_s: 999 }), { match: 1 }), 409, 'conflict');
    expect(body.current.version).toBe(2);
    expect(body.current.summary.playtime_s).toBe(2);
    expect(JSON.parse((await (await getSave(p.token, 2)).json()).data).playtime_s).toBe(2);
  });

  it('If-Match 打到空槽 → 404', async () => {
    const p = await newPlayer(w);
    await expectError(await putSave(w, p.token, 1, sampleSave(), { match: 1 }), 404, 'not_found');
  });

  it('兩個並行 PUT（同一個 If-Match）只有一個成功，另一個 409', async () => {
    const p = await newPlayer(w);
    await putSave(w, p.token, 1, sampleSave());
    const results = await Promise.all([
      putSave(w, p.token, 1, sampleSave({ playtime_s: 1001 }), { match: 1 }),
      putSave(w, p.token, 1, sampleSave({ playtime_s: 1002 }), { match: 1 }),
      putSave(w, p.token, 1, sampleSave({ playtime_s: 1003 }), { match: 1 }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    const winner = results.find((r) => r.status === 200);
    expect((await winner.json()).version).toBe(2);
    const g = await (await getSave(p.token, 1)).json();
    expect(g.version).toBe(2);
  });

  it('兩個並行建立（If-None-Match: *）只有一個成功', async () => {
    const p = await newPlayer(w);
    const results = await Promise.all([putSave(w, p.token, 3, sampleSave()), putSave(w, p.token, 3, sampleSave())]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('GET／DELETE 404 與 DELETE', () => {
  it('GET 空槽 → 404', async () => {
    const p = await newPlayer(w);
    await expectError(await getSave(p.token, 2), 404, 'not_found');
  });

  it('DELETE 成功 → 204；之後是空槽；可以再用 If-None-Match: * 建立，版本不會倒退', async () => {
    const p = await newPlayer(w);
    await putSave(w, p.token, 1, sampleSave());
    await putSave(w, p.token, 1, sampleSave(), { match: 1 });
    const res = await del(p.token, 1, 2);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    await expectError(await getSave(p.token, 1), 404, 'not_found');
    const { slots } = await (await w.fetch('/api/saves', { headers: auth(p.token) })).json();
    expect(slots[0]).toEqual({ slot: 1, empty: true });
    // 拿著刪除前版本號的舊裝置不能覆蓋新建立的存檔
    const created = await (await putSave(w, p.token, 1, sampleSave())).json();
    expect(created.version).toBeGreaterThan(2);
    await expectError(await putSave(w, p.token, 1, sampleSave(), { match: 1 }), 409, 'conflict');
    await expectError(await putSave(w, p.token, 1, sampleSave(), { match: 2 }), 409, 'conflict');
  });

  it('DELETE 沒有 If-Match → 428', async () => {
    const p = await newPlayer(w);
    await putSave(w, p.token, 1, sampleSave());
    await expectError(await del(p.token, 1), 428, 'precondition_required');
    expect((await getSave(p.token, 1)).status).toBe(200);
  });

  it('DELETE 版本不符 → 409 附 current，資料保留', async () => {
    const p = await newPlayer(w);
    await putSave(w, p.token, 1, sampleSave());
    const body = await expectError(await del(p.token, 1, 7), 409, 'conflict');
    expect(body.current.version).toBe(1);
    expect((await getSave(p.token, 1)).status).toBe(200);
  });

  it('DELETE 空槽 → 404；刪過的槽再刪也是 404', async () => {
    const p = await newPlayer(w);
    await expectError(await del(p.token, 3, 1), 404, 'not_found');
    await putSave(w, p.token, 3, sampleSave());
    expect((await del(p.token, 3, 1)).status).toBe(204);
    await expectError(await del(p.token, 3, 1), 404, 'not_found');
  });

  it('不能讀、改、刪別的玩家的槽', async () => {
    const a = await newPlayer(w);
    const b = await newPlayer(w);
    await putSave(w, a.token, 1, sampleSave({ playtime_s: 5 }));
    await expectError(await getSave(b.token, 1), 404, 'not_found');
    await expectError(await del(b.token, 1, 1), 404, 'not_found');
    expect((await putSave(w, b.token, 1, sampleSave({ playtime_s: 6 }))).status).toBe(200);
    expect(JSON.parse((await (await getSave(a.token, 1)).json()).data).playtime_s).toBe(5);
  });
});
