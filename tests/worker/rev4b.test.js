// API 修訂 4b（M3 部署前最後一輪審查）：每一項都先寫成重現測試（紅燈）再修。
// 1：並行請求不可放大保留通道對全域每日預算的消耗（保留名額與每日預算一起原子計數）。
// 2：轉移額度用完後，rotate／POST /api/player 不論新碼是否碰撞都回 429 且不寫入（無法分辨是否猜中）。
// 3：空帳號清理改看 last_seen（仍在使用、但還沒上傳的玩家不刪）。
import { describe, it, expect } from 'vitest';
import {
  startWorker, newPlayer, newSecrets, json, auth, putSave, expectError, sampleSave, d1Rows,
  tsToken,
} from './helpers.js';
import { generateTransferCode } from '../../worker/src/codes.js';

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const dayCount = async (s) => (await s.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE bucket LIKE 'g:wday:%'").first()).n;
const bucketCount = async (s, bucket) => (await s.db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(bucket).first())?.count ?? 0;
const clear = (s, token, ps = 100) => s.fetch('/api/clear', {
  method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), body: JSON.stringify({ chapter: 'chapter1', play_seconds: ps, collapse: 0 }),
});
const rotate = (s, token, code = generateTransferCode()) => s.fetch('/api/transfer/rotate', json({ new_transfer_code: code }, auth(token)));
/** 預先把某個 bucket 灌滿（模擬攻擊者已用完）。 */
const fill = (s, bucket, count, resetAt = nowSec() + 3600) => s.db.prepare('INSERT OR REPLACE INTO rate_limits (bucket, count, reset_at) VALUES (?, ?, ?)')
  .bind(bucket, count, resetAt).run();
const dayBucket = () => `g:wday:${new Date(nowSec() * 1000).toISOString().slice(0, 10)}`;

/** 單一帳號並行 33 個寫入（20 PUT＋10 clear＋3 rotate），回傳各回應的狀態。 */
async function burst33(s, token) {
  const reqs = [];
  for (let i = 0; i < 20; i++) reqs.push(putSave(s, token, (i % 3) + 1, sampleSave({ playtime_s: 100 + i })));
  for (let i = 0; i < 10; i++) reqs.push(clear(s, token, 100 + i));
  for (let i = 0; i < 3; i++) reqs.push(rotate(s, token));
  const rs = await Promise.all(reqs);
  const out = [];
  for (const r of rs) { out.push(r.status); await r.arrayBuffer(); }
  return out;
}

describe('修訂 4b 第 1 節：並行請求不放大保留通道對每日預算的消耗', () => {
  it('單一帳號並行 33 個寫入（20 PUT＋10 clear＋3 rotate）→ g:wday 增加 ≤ 3', async () => {
    const s = await startWorker();
    try {
      const p = await newPlayer(s);
      const before = await dayCount(s);
      await burst33(s, p.token);
      expect((await dayCount(s)) - before).toBeLessThanOrEqual(3);
      expect(await bucketCount(s, `pl:rsv:${p.player_id}`)).toBeLessThanOrEqual(3);
    } finally {
      await s.close();
    }
  });

  it('單一帳號並行 20 個 PUT → g:wday 增加 ≤ 3', async () => {
    const s = await startWorker();
    try {
      const p = await newPlayer(s);
      const before = await dayCount(s);
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => putSave(s, p.token, (i % 3) + 1, sampleSave({ playtime_s: i }))));
      for (const r of rs) await r.arrayBuffer();
      expect((await dayCount(s)) - before).toBeLessThanOrEqual(3);
    } finally {
      await s.close();
    }
  });

  it('全域每小時上限已滿時並行 33 個寫入：只有保留通道的 3 次成功，其餘 429 而且不留下任何限流寫入', async () => {
    const s = await startWorker();
    try {
      await fill(s, 'g:write', 100);
      const p = await newPlayer(s);
      const st = await burst33(s, p.token);
      const passed = st.filter((x) => x !== 429).length;
      expect(passed).toBe(3);
      expect(await dayCount(s)).toBe(3);
      expect(await bucketCount(s, `pl:rsv:${p.player_id}`)).toBe(3);
      // 端點限制的計數＝實際通過限流的請求數（429 的請求沒有寫入任何一列）
      const local = (await bucketCount(s, `pl:write:${p.player_id}`)) + (await bucketCount(s, `pl:clear:${p.player_id}`)) + (await bucketCount(s, `pl:rotate:${p.player_id}`));
      expect(local).toBe(passed);
      expect(await bucketCount(s, 'g:write')).toBe(100);
    } finally {
      await s.close();
    }
  });

  it('每日預算已滿時，保留名額不被消耗，直接走每小時通道', async () => {
    const s = await startWorker();
    try {
      await fill(s, dayBucket(), 4000, (Math.floor(nowSec() / DAY) + 1) * DAY);
      const p = await newPlayer(s);
      expect((await putSave(s, p.token, 1, sampleSave())).status).toBe(200);
      expect(await bucketCount(s, `pl:rsv:${p.player_id}`)).toBe(0);
      expect(await bucketCount(s, 'g:write')).toBe(1);
      expect(await dayCount(s)).toBe(4000);
    } finally {
      await s.close();
    }
  });

  it('保留通道與每小時通道都滿 → 429、不寫入、Retry-After 來自已滿的 bucket', async () => {
    const s = await startWorker();
    try {
      const p = await newPlayer(s);
      await fill(s, `pl:rsv:${p.player_id}`, 3, nowSec() + 1000);
      await fill(s, 'g:write', 100, nowSec() + 2000);
      const r = await putSave(s, p.token, 1, sampleSave());
      expect(d1Rows(r).written).toBe(0);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(1900);
      await expectError(r, 429, 'rate_limited');
    } finally {
      await s.close();
    }
  });
});

describe('修訂 4b 第 2 節：轉移額度用完後無法以碰撞探測轉移碼', () => {
  it('g:transfer 滿：rotate 不論新碼是否碰撞都回 429，而且不寫入', async () => {
    const s = await startWorker();
    try {
      const victim = await newPlayer(s);
      const att = await newPlayer(s);
      await fill(s, 'g:transfer', 120);
      const before = await s.db.prepare('SELECT transfer_hash FROM players WHERE player_id = ?').bind(att.player_id).first();
      const hit = await rotate(s, att.token, victim.transfer_code);
      const miss = await rotate(s, att.token);
      for (const r of [hit, miss]) {
        expect(d1Rows(r).written).toBe(0);
        await expectError(r, 429, 'rate_limited');
      }
      const after = await s.db.prepare('SELECT transfer_hash FROM players WHERE player_id = ?').bind(att.player_id).first();
      expect(after.transfer_hash).toBe(before.transfer_hash);
    } finally {
      await s.close();
    }
  });

  it('g:transfer 滿：POST /api/player 不論轉移碼是否碰撞都回 429，而且不建立玩家', async () => {
    const s = await startWorker();
    try {
      const victim = await newPlayer(s);
      await fill(s, 'g:transfer', 120);
      const count = async () => (await s.db.prepare('SELECT COUNT(*) AS n FROM players').first()).n;
      const n0 = await count();
      const hit = await s.fetch('/api/player', json({ token: newSecrets().token, transfer_code: victim.transfer_code, turnstile_token: tsToken('create_player') }, { 'cf-connecting-ip': s.nextIp() }));
      const miss = await s.fetch('/api/player', json(newSecrets(), { 'cf-connecting-ip': s.nextIp() }));
      await expectError(hit, 429, 'rate_limited');
      await expectError(miss, 429, 'rate_limited');
      expect(await count()).toBe(n0);
    } finally {
      await s.close();
    }
  });

  it('這個 IP 的轉移額度滿：POST /api/player 一律 429（不分碰撞與否）；別的 IP 正常建立', async () => {
    const s = await startWorker({ varsOverride: { RL_TRANSFER_PER_HOUR: '1' } });
    try {
      const victim = await newPlayer(s);
      const ip = '198.51.100.77';
      expect((await s.fetch('/api/transfer', json({ code: 'ZZZZ-ZZZZ', new_token: newSecrets().token, new_transfer_code: generateTransferCode() }, { 'cf-connecting-ip': ip }))).status).toBe(404);
      await expectError(await s.fetch('/api/player', json({ token: newSecrets().token, transfer_code: victim.transfer_code, turnstile_token: tsToken('create_player') }, { 'cf-connecting-ip': ip })), 429, 'rate_limited');
      await expectError(await s.fetch('/api/player', json(newSecrets(), { 'cf-connecting-ip': ip })), 429, 'rate_limited');
      expect((await s.fetch('/api/player', json(newSecrets(), { 'cf-connecting-ip': s.nextIp() }))).status).toBe(201);
    } finally {
      await s.close();
    }
  });
});

describe('修訂 4b 第 3 節：空帳號清理看 last_seen', () => {
  it('10 天前建立、1 小時前還在使用、沒有存檔 → 不刪；last_seen 8 天前的空帳號 → 刪', async () => {
    const s = await startWorker();
    try {
      const now = nowSec();
      const active = await newPlayer(s);
      const idle = await newPlayer(s);
      await s.db.prepare('UPDATE players SET created_at = ?, last_seen = ? WHERE player_id = ?').bind(now - 10 * DAY, now - 3600, active.player_id).run();
      await s.db.prepare('UPDATE players SET created_at = ?, last_seen = ? WHERE player_id = ?').bind(now - 10 * DAY, now - 8 * DAY, idle.player_id).run();
      await s.scheduled(now * 1000);
      const exists = async (pid) => (await s.db.prepare('SELECT COUNT(*) AS n FROM players WHERE player_id = ?').bind(pid).first()).n === 1;
      expect(await exists(active.player_id)).toBe(true);
      expect(await exists(idle.player_id)).toBe(false);
      expect((await s.fetch('/api/saves', { headers: auth(active.token) })).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});
