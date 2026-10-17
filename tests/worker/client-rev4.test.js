// 審查 t4 的重現：真的客戶端（sync.js＋api.js）打真的 Worker（Miniflare＋D1）。
// A：rotate 的回應遺失（伺服器其實已套用），之後同碼重送遇到限流 → 客戶端不可丟掉新碼、改顯示已失效的舊碼。
// B：轉移請求晚到（超過逾時），使用者改按「啟用雲端存檔」→ 待確認的新權杖不可被覆蓋（否則帳號鎖死）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWorker, newPlayer, newSecrets, json, auth } from './helpers.js';
import { createCloudSync, PENDING_KEY, CLOUD_KEY } from '../../web/src/cloud/sync.js';
import { createCloudApi } from '../../web/src/cloud/api.js';

const mem = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

let w;
beforeAll(async () => { w = await startWorker({ varsOverride: { RL_ROTATE_PER_HOUR: '3' } }); });
afterAll(async () => { await w?.close(); });

function client(ip, hooks = {}) {
  const backend = mem();
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    const go = () => w.mf.dispatchFetch(`https://worker.test${path}`, { ...init, signal: undefined, headers: { ...init.headers, 'cf-connecting-ip': ip } });
    return hooks[path] ? hooks[path](go, init) : go();
  };
  const api = createCloudApi({ baseUrl: 'https://worker.test', fetch: fetchFn, timeoutMs: 300, getToken: () => JSON.parse(backend.getItem(CLOUD_KEY) ?? 'null')?.token });
  const sync = createCloudSync({ backend, saveStore: { load: () => ({ ok: false, code: 'empty' }) }, api });
  return { backend, sync };
}

describe('審查 t4（真客戶端 × 真 Worker）', () => {
  it('A（審查原始情境）：rotate 回應遺失 → 同碼重送 3 次 → recover 仍確認成功', async () => {
    let drop = true;
    const A = client('10.9.9.10', {
      '/api/transfer/rotate': async (go) => { const res = await go(); if (drop) { drop = false; await res.text(); await sleep(600); } return res; },
    });
    expect((await A.sync.enable()).ok).toBe(true);
    const oldCode = A.sync.transferCode();
    const r = await A.sync.rotate();
    expect(r.ok).toBe(false);
    const serverCode = r.pendingCode;
    const { token } = JSON.parse(A.backend.getItem(CLOUD_KEY));
    for (let i = 0; i < 3; i++) await (await w.fetch('/api/transfer/rotate', json({ new_transfer_code: serverCode }, auth(token)))).arrayBuffer();
    const rec = await A.sync.recover();
    expect(rec).toEqual({ recovered: 'rotate' });
    expect(A.sync.transferCode()).toBe(serverCode);
    expect(A.sync.pendingTransferCode()).toBeNull();
    // 另一台裝置輸入畫面上的碼可以接續；舊碼不行
    const s = newSecrets();
    const t = await w.fetch('/api/transfer', json({ code: oldCode, new_token: s.token, new_transfer_code: s.transfer_code }, { 'cf-connecting-ip': '10.1.1.1' }));
    expect(t.status).toBe(404);
    const t2 = await w.fetch('/api/transfer', json({ code: A.sync.transferCode(), new_token: s.token, new_transfer_code: s.transfer_code }, { 'cf-connecting-ip': '10.1.1.2' }));
    expect(t2.status).toBe(200);
  });

  it('A2：rotate 額度用完（伺服器沒有套用新碼）→ 429 時客戶端保留待確認的新碼，不當作確定失敗', async () => {
    const A = client('10.9.9.11');
    expect((await A.sync.enable()).ok).toBe(true);
    const { token } = JSON.parse(A.backend.getItem(CLOUD_KEY));
    for (let i = 0; i < 3; i++) await (await w.fetch('/api/transfer/rotate', json({ new_transfer_code: newSecrets().transfer_code }, auth(token)))).arrayBuffer();
    const r = await A.sync.rotate();
    expect(r).toMatchObject({ ok: false, status: 429 });
    expect(A.sync.pendingTransferCode()).toBe(r.pendingCode);
  });

  it('B：轉移請求卡在路上時按「啟用雲端存檔」→ 不覆蓋待確認；晚到的轉移生效後，這台裝置能接上那個帳號', async () => {
    const victim = await newPlayer(w);
    let release;
    const gate = new Promise((res) => { release = res; });
    let late;
    const B = client('10.8.8.8', { '/api/transfer': async (go) => { late = gate.then(go); return new Promise(() => {}); } });
    const r = await B.sync.connect(victim.transfer_code);
    expect(r.ok).toBe(false);
    expect(JSON.parse(B.backend.getItem(PENDING_KEY)).op).toBe('transfer');
    const e = await B.sync.enable();
    expect(e).toMatchObject({ ok: false, kind: 'pending_transfer' });
    expect(JSON.parse(B.backend.getItem(PENDING_KEY)).op).toBe('transfer');
    release();
    expect((await late).status).toBe(200);
    // 晚到的轉移已生效：舊權杖失效，這台裝置 recover 後就是該帳號
    expect((await w.fetch('/api/saves', { headers: auth(victim.token) })).status).toBe(401);
    expect(await B.sync.recover()).toEqual({ recovered: 'transfer' });
    const tok = JSON.parse(B.backend.getItem(CLOUD_KEY)).token;
    expect((await w.fetch('/api/saves', { headers: auth(tok) })).status).toBe(200);
  });
});
