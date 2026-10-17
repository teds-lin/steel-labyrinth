// POST /api/transfer、POST /api/transfer/rotate（修訂 2 A：新權杖與新轉移碼由客戶端產生）：
// 接續、舊權杖與舊碼失效、正規化、並行轉移、格式驗證、碰撞 409、rotate 冪等。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startWorker, newPlayer, newSecrets, doTransfer, doRotate, json, auth, putSave, expectError, sampleSave,
} from './helpers.js';
import { generateTransferCode } from '../../worker/src/codes.js';

let w;
beforeAll(async () => { w = await startWorker(); });
afterAll(async () => { await w?.close(); });

const transfer = (code, opts) => doTransfer(w, code, opts);
const rawTransfer = (body, ip = w.nextIp()) => w.fetch('/api/transfer', json(body, { 'cf-connecting-ip': ip }));

describe('POST /api/transfer', () => {
  it('200：只回 player_id；客戶端送來的新權杖可用；雲端存檔接得到', async () => {
    const a = await newPlayer(w);
    await putSave(w, a.token, 2, sampleSave({ playtime_s: 4321 }));
    const t = await transfer(a.transfer_code);
    expect(t.res.status).toBe(200);
    expect(await t.res.json()).toEqual({ player_id: a.player_id });
    const g = await (await w.fetch('/api/save/2', { headers: auth(t.token) })).json();
    expect(JSON.parse(g.data).playtime_s).toBe(4321);
  });

  it('轉移後舊權杖 → 401；舊轉移碼 → 404；客戶端送來的新轉移碼可以再轉移', async () => {
    const a = await newPlayer(w);
    const b = await transfer(a.transfer_code);
    expect(b.res.status).toBe(200);
    await expectError(await w.fetch('/api/saves', { headers: auth(a.token) }), 401, 'unauthorized');
    await expectError(await putSave(w, a.token, 1, sampleSave()), 401, 'unauthorized');
    await expectError((await transfer(a.transfer_code)).res, 404, 'not_found');
    const c = await transfer(b.transfer_code);
    expect(await c.res.json()).toEqual({ player_id: a.player_id });
    await expectError(await w.fetch('/api/saves', { headers: auth(b.token) }), 401, 'unauthorized');
    expect((await w.fetch('/api/saves', { headers: auth(c.token) })).status).toBe(200);
  });

  it('逾時情境：客戶端用 new_token 呼叫 GET /api/saves 就能判斷轉移是否成功', async () => {
    const a = await newPlayer(w);
    const s = newSecrets();
    // 尚未送出（或沒送到）：new_token 是 401，原本的碼還能用
    await expectError(await w.fetch('/api/saves', { headers: auth(s.token) }), 401, 'unauthorized');
    expect((await transfer(a.transfer_code, { secrets: s })).res.status).toBe(200);
    expect((await w.fetch('/api/saves', { headers: auth(s.token) })).status).toBe(200);
  });

  it.each([
    ['小寫', (c) => c.toLowerCase()],
    ['沒有連字號', (c) => c.replace('-', '')],
    ['前後與中間有空白', (c) => `  ${c.slice(0, 2)} ${c.slice(2)}  `],
    ['多個連字號與小寫混合', (c) => c.replace('-', '').split('').join('-').toLowerCase()],
    ['夾雜零寬字元（Unicode Cf）', (c) => `​${c.slice(0, 3)}‍${c.slice(3)}﻿`],
  ])('正規化：%s 也能接續', async (_, f) => {
    const a = await newPlayer(w);
    const t = await transfer(f(a.transfer_code));
    expect(t.res.status).toBe(200);
    expect((await t.res.json()).player_id).toBe(a.player_id);
  });

  it('不存在與格式錯誤的 code 回一模一樣的 404 訊息', async () => {
    const notExist = await expectError((await transfer('ABCD-EFGH')).res, 404, 'not_found');
    const malformed = await expectError((await transfer('0O1I-LLLL')).res, 404, 'not_found');
    const tooShort = await expectError((await transfer('AB')).res, 404, 'not_found');
    const sqli = await expectError((await transfer("' OR '1'='1")).res, 404, 'not_found');
    expect(malformed).toEqual(notExist);
    expect(tooShort).toEqual(notExist);
    expect(sqli).toEqual(notExist);
  });

  it.each([
    ['壞 JSON', '{x'],
    ['空物件', {}],
    ['code 不是字串', { code: 12345678, new_token: newSecrets().token, new_transfer_code: generateTransferCode() }],
    ['缺 new_token', { code: 'ABCD-EFGH', new_transfer_code: generateTransferCode() }],
    ['缺 new_transfer_code', { code: 'ABCD-EFGH', new_token: newSecrets().token }],
    ['new_token 格式錯', { code: 'ABCD-EFGH', new_token: 'short', new_transfer_code: generateTransferCode() }],
    ['new_transfer_code 格式錯', { code: 'ABCD-EFGH', new_token: newSecrets().token, new_transfer_code: 'ABCD-EF01' }],
  ])('%s → 400', async (_, body) => {
    await expectError(await rawTransfer(body), 400, 'bad_request');
  });

  it('new_token／new_transfer_code 格式錯 → 400，原本的碼沒有被消耗', async () => {
    const a = await newPlayer(w);
    await expectError(await rawTransfer({ code: a.transfer_code, new_token: `${'x'.repeat(42)}!`, new_transfer_code: generateTransferCode() }), 400, 'bad_request');
    await expectError(await rawTransfer({ code: a.transfer_code, new_token: newSecrets().token, new_transfer_code: 'nope' }), 400, 'bad_request');
    expect((await transfer(a.transfer_code)).res.status).toBe(200);
  });

  it('新轉移碼和舊碼相同 → 400（舊碼必須失效）', async () => {
    const a = await newPlayer(w);
    await expectError(await rawTransfer({ code: a.transfer_code, new_token: newSecrets().token, new_transfer_code: a.transfer_code.toLowerCase() }), 400, 'bad_request');
    expect((await w.fetch('/api/saves', { headers: auth(a.token) })).status).toBe(200);
  });

  it('新轉移碼和別人的碼相同 → 409 conflict；什麼都沒改（舊權杖、舊碼仍有效）', async () => {
    const a = await newPlayer(w);
    const other = await newPlayer(w);
    await expectError((await transfer(a.transfer_code, { secrets: { token: newSecrets().token, transfer_code: other.transfer_code } })).res, 409, 'conflict');
    expect((await w.fetch('/api/saves', { headers: auth(a.token) })).status).toBe(200);
    expect((await transfer(a.transfer_code)).res.status).toBe(200);
  });

  it('新權杖和別人的權杖相同 → 409 conflict（實際上不會發生）', async () => {
    const a = await newPlayer(w);
    const other = await newPlayer(w);
    await expectError((await transfer(a.transfer_code, { secrets: { token: other.token, transfer_code: generateTransferCode() } })).res, 409, 'conflict');
    expect((await w.fetch('/api/saves', { headers: auth(a.token) })).status).toBe(200);
  });

  it('不需要權杖（帶了錯的權杖也照常處理）', async () => {
    const a = await newPlayer(w);
    expect((await transfer(a.transfer_code, { headers: { authorization: 'Bearer nope' } })).res.status).toBe(200);
  });

  it('兩台裝置同時用同一個轉移碼：只有一台的權杖生效', async () => {
    const a = await newPlayer(w);
    const results = await Promise.all([transfer(a.transfer_code), transfer(a.transfer_code), transfer(a.transfer_code)]);
    expect(results.map((r) => r.res.status).sort()).toEqual([200, 404, 404]);
    const winner = results.find((r) => r.res.status === 200);
    expect((await w.fetch('/api/saves', { headers: auth(winner.token) })).status).toBe(200);
    for (const r of results.filter((x) => x !== winner)) {
      await expectError(await w.fetch('/api/saves', { headers: auth(r.token) }), 401, 'unauthorized');
    }
    const row = await w.db.prepare('SELECT COUNT(*) AS n FROM players WHERE player_id = ?').bind(a.player_id).first();
    expect(row.n).toBe(1);
  });
});

describe('POST /api/transfer/rotate', () => {
  it('200 {}：客戶端送來的新碼生效；舊碼失效；權杖不變', async () => {
    const a = await newPlayer(w);
    const code = generateTransferCode();
    const res = await doRotate(w, a.token, code);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await w.fetch('/api/saves', { headers: auth(a.token) })).status).toBe(200);
    await expectError((await transfer(a.transfer_code)).res, 404, 'not_found');
    expect((await transfer(code)).res.status).toBe(200);
  });

  it('冪等：用同一個新碼重送 → 200，而且不寫入', async () => {
    const a = await newPlayer(w);
    const code = generateTransferCode();
    expect((await doRotate(w, a.token, code)).status).toBe(200);
    const again = await doRotate(w, a.token, code.toLowerCase().replace('-', ' '));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({});
    expect((await transfer(code)).res.status).toBe(200);
  });

  it('新碼和別人的碼相同 → 409 conflict；原本的碼仍有效', async () => {
    const a = await newPlayer(w);
    const other = await newPlayer(w);
    await expectError(await doRotate(w, a.token, other.transfer_code), 409, 'conflict');
    expect((await transfer(a.transfer_code)).res.status).toBe(200);
  });

  it.each([
    ['沒有 body', undefined],
    ['{}', '{}'],
    ['格式錯', JSON.stringify({ new_transfer_code: 'ABCD' })],
    ['易混淆字元', JSON.stringify({ new_transfer_code: 'ABCD-EFGI' })],
    ['不是字串', JSON.stringify({ new_transfer_code: 1 })],
  ])('%s → 400', async (_, body) => {
    const a = await newPlayer(w);
    await expectError(await w.fetch('/api/transfer/rotate', { method: 'POST', headers: auth(a.token, { 'content-type': 'application/json' }), body }), 400, 'bad_request');
    expect((await transfer(a.transfer_code)).res.status).toBe(200);
  });
});
