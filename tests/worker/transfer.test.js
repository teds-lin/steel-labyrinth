// POST /api/transfer、POST /api/transfer/rotate：接續、舊權杖失效、轉移碼換新、正規化、並行轉移。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWorker, newPlayer, json, auth, putSave, expectError, sampleSave } from './helpers.js';

let w;
beforeAll(async () => { w = await startWorker(); });
afterAll(async () => { await w?.close(); });

const transfer = (code, ip = w.nextIp()) => w.fetch('/api/transfer', json({ code }, { 'cf-connecting-ip': ip }));
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

describe('POST /api/transfer', () => {
  it('200：同一個 player_id、新權杖、新轉移碼；雲端存檔接得到', async () => {
    const a = await newPlayer(w);
    await putSave(w, a.token, 2, sampleSave({ playtime_s: 4321 }));
    const res = await transfer(a.transfer_code);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(Object.keys(b).sort()).toEqual(['player_id', 'token', 'transfer_code']);
    expect(b.player_id).toBe(a.player_id);
    expect(b.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.token).not.toBe(a.token);
    expect(b.transfer_code).toMatch(CODE_RE);
    expect(b.transfer_code).not.toBe(a.transfer_code);
    const g = await (await w.fetch('/api/save/2', { headers: auth(b.token) })).json();
    expect(JSON.parse(g.data).playtime_s).toBe(4321);
  });

  it('轉移後舊權杖 → 401；舊轉移碼 → 404；新轉移碼可以再轉移', async () => {
    const a = await newPlayer(w);
    const b = await (await transfer(a.transfer_code)).json();
    await expectError(await w.fetch('/api/saves', { headers: auth(a.token) }), 401, 'unauthorized');
    await expectError(await putSave(w, a.token, 1, sampleSave()), 401, 'unauthorized');
    await expectError(await transfer(a.transfer_code), 404, 'not_found');
    const c = await (await transfer(b.transfer_code)).json();
    expect(c.player_id).toBe(a.player_id);
    await expectError(await w.fetch('/api/saves', { headers: auth(b.token) }), 401, 'unauthorized');
    expect((await w.fetch('/api/saves', { headers: auth(c.token) })).status).toBe(200);
  });

  it.each([
    ['小寫', (c) => c.toLowerCase()],
    ['沒有連字號', (c) => c.replace('-', '')],
    ['前後與中間有空白', (c) => `  ${c.slice(0, 2)} ${c.slice(2)}  `],
    ['多個連字號與小寫混合', (c) => c.replace('-', '').split('').join('-').toLowerCase()],
  ])('正規化：%s 也能接續', async (_, f) => {
    const a = await newPlayer(w);
    const res = await transfer(f(a.transfer_code));
    expect(res.status).toBe(200);
    expect((await res.json()).player_id).toBe(a.player_id);
  });

  it('不存在與格式錯誤回一模一樣的 404 訊息', async () => {
    const notExist = await expectError(await transfer('ABCD-EFGH'), 404, 'not_found');
    const malformed = await expectError(await transfer('0O1I-LLLL'), 404, 'not_found');
    const tooShort = await expectError(await transfer('AB'), 404, 'not_found');
    const sqli = await expectError(await transfer("' OR '1'='1"), 404, 'not_found');
    expect(malformed).toEqual(notExist);
    expect(tooShort).toEqual(notExist);
    expect(sqli).toEqual(notExist);
  });

  it('body 壞掉或 code 不是字串 → 400', async () => {
    await expectError(await w.fetch('/api/transfer', json('{x', { 'cf-connecting-ip': w.nextIp() })), 400, 'bad_request');
    await expectError(await w.fetch('/api/transfer', json({}, { 'cf-connecting-ip': w.nextIp() })), 400, 'bad_request');
    await expectError(await w.fetch('/api/transfer', json({ code: 12345678 }, { 'cf-connecting-ip': w.nextIp() })), 400, 'bad_request');
  });

  it('不需要權杖（帶了錯的權杖也照常處理）', async () => {
    const a = await newPlayer(w);
    const res = await w.fetch('/api/transfer', json({ code: a.transfer_code }, { 'cf-connecting-ip': w.nextIp(), authorization: 'Bearer nope' }));
    expect(res.status).toBe(200);
  });

  it('兩台裝置同時用同一個轉移碼：只有一台拿到權杖', async () => {
    const a = await newPlayer(w);
    const results = await Promise.all([transfer(a.transfer_code), transfer(a.transfer_code), transfer(a.transfer_code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    const winner = await results.find((r) => r.status === 200).json();
    expect((await w.fetch('/api/saves', { headers: auth(winner.token) })).status).toBe(200);
    const row = await w.db.prepare('SELECT COUNT(*) AS n FROM players WHERE player_id = ?').bind(a.player_id).first();
    expect(row.n).toBe(1);
  });
});

describe('POST /api/transfer/rotate', () => {
  it('200：新轉移碼；舊碼失效、新碼可用；權杖不變', async () => {
    const a = await newPlayer(w);
    const res = await w.fetch('/api/transfer/rotate', { method: 'POST', headers: auth(a.token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['transfer_code']);
    expect(body.transfer_code).toMatch(CODE_RE);
    expect(body.transfer_code).not.toBe(a.transfer_code);
    expect((await w.fetch('/api/saves', { headers: auth(a.token) })).status).toBe(200);
    await expectError(await transfer(a.transfer_code), 404, 'not_found');
    expect((await transfer(body.transfer_code)).status).toBe(200);
  });

  it('沒有 body 或 body 是 {} 都可以', async () => {
    const a = await newPlayer(w);
    expect((await w.fetch('/api/transfer/rotate', { method: 'POST', headers: auth(a.token), body: '{}' })).status).toBe(200);
  });
});
