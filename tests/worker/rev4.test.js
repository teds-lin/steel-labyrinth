// API 修訂 4（M3 第二輪安全審查）：保留通道、IPv6 /48、空帳號清理與 Cron 分批、rotate 冪等優先於限流、
// 碰撞 409 計入轉移額度、低熵秘密 400、MAX_PLAYER_SECONDS。每一項都先寫成重現測試（紅燈）再修。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startWorker, newPlayer, newSecrets, doTransfer, doRotate, json, auth, putSave, expectError, sampleSave, d1Rows, readWranglerConfig,
} from './helpers.js';
import { generateTransferCode } from '../../worker/src/codes.js';

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const clearBody = (over = {}) => JSON.stringify({ chapter: 'chapter1', ending: null, play_seconds: 10, collapse: 0, ...over });
const clear = (s, token, over) => s.fetch('/api/clear', { method: 'POST', headers: auth(token, { 'content-type': 'application/json' }), body: clearBody(over) });
const create = (s, ip, body = newSecrets()) => s.fetch('/api/player', json(body, { 'cf-connecting-ip': ip }));
const bucketCount = async (s, bucket) => (await s.db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(bucket).first())?.count ?? 0;
const dayCount = async (s) => (await s.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE bucket LIKE 'g:wday:%'").first()).n;

async function expect429(res) {
  expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
  await expectError(res, 429, 'rate_limited');
}

describe('第 1 節：每位玩家配額與保留通道', () => {
  it('wrangler.toml：每位玩家 20／3／10、保留 3、IPv6 /48 10／20、全域每日預算已設定', () => {
    const v = readWranglerConfig().vars;
    expect(Number(v.RL_WRITE_PER_HOUR)).toBe(20);
    expect(Number(v.RL_ROTATE_PER_HOUR)).toBe(3);
    expect(Number(v.RL_CLEAR_PER_HOUR)).toBe(10);
    expect(Number(v.RL_RESERVED_PER_HOUR)).toBe(3);
    expect(Number(v.RL_PLAYER_PER_HOUR_V6_48)).toBe(10);
    expect(Number(v.RL_TRANSFER_PER_HOUR_V6_48)).toBe(20);
    expect(Number.isInteger(Number(v.RL_WRITE_GLOBAL_PER_DAY)) && Number(v.RL_WRITE_GLOBAL_PER_DAY) > 0).toBe(true);
    expect(Number(v.PURGE_BATCH)).toBe(500);
    expect(Number(v.MAX_PLAYER_SECONDS)).toBe(36000);
  });

  it('審查 t3：攻擊者佔滿全域每小時上限後，正常玩家每小時的前 3 次寫入（PUT、clear、rotate）仍然成功', async () => {
    const s = await startWorker({ varsOverride: { RL_WRITE_GLOBAL_PER_HOUR: '4' } });
    try {
      const atk = [await newPlayer(s), await newPlayer(s)];
      // 攻擊者：先用掉自己的保留通道，再把全域每小時上限灌滿
      let ok = 0;
      for (const a of atk) for (let i = 0; i < 10; i++) if ((await clear(s, a.token, { play_seconds: 1000 - i })).status === 200) ok++;
      expect(ok).toBe(3 + 3 + 4);
      expect(await bucketCount(s, 'g:write')).toBe(4);
      await expect429(await clear(s, atk[0].token));

      const victim = await newPlayer(s);
      const put = await putSave(s, victim.token, 1, sampleSave());
      expect(put.status).toBe(200);
      expect((await clear(s, victim.token)).status).toBe(200);
      expect((await doRotate(s, victim.token)).status).toBe(200);
      // 第 4 次已超出保留通道，回到全域每小時上限 → 429，而且不寫入
      const fourth = await putSave(s, victim.token, 2, sampleSave());
      expect(d1Rows(fourth).written).toBe(0);
      await expect429(fourth);
      expect(await bucketCount(s, 'g:write')).toBe(4);
      expect(await dayCount(s)).toBe(9); // 保留通道只計入全域每日預算
    } finally {
      await s.close();
    }
  });

  it('全域每日預算用完後，保留通道關閉，改受全域每小時上限限制', async () => {
    const s = await startWorker({ varsOverride: { RL_WRITE_GLOBAL_PER_DAY: '2', RL_WRITE_GLOBAL_PER_HOUR: '1' } });
    try {
      const ps = [];
      for (let i = 0; i < 4; i++) ps.push(await newPlayer(s));
      expect((await putSave(s, ps[0].token, 1, sampleSave())).status).toBe(200); // 保留（每日 1）
      expect((await putSave(s, ps[1].token, 1, sampleSave())).status).toBe(200); // 保留（每日 2）
      expect((await putSave(s, ps[2].token, 1, sampleSave())).status).toBe(200); // 每日用完 → 每小時（1）
      const r = await putSave(s, ps[3].token, 1, sampleSave());
      expect(d1Rows(r).written).toBe(0);
      await expect429(r);
      expect(await dayCount(s)).toBe(2);
      expect(await bucketCount(s, 'g:write')).toBe(1);
    } finally {
      await s.close();
    }
  });

  it('保留通道不繞過每位玩家的端點限制（rotate 每小時 3 次）', async () => {
    const s = await startWorker({ varsOverride: { RL_ROTATE_PER_HOUR: '1' } });
    try {
      const p = await newPlayer(s);
      expect((await doRotate(s, p.token)).status).toBe(200);
      const r = await doRotate(s, p.token);
      expect(d1Rows(r).written).toBe(0);
      await expect429(r);
      expect((await putSave(s, p.token, 1, sampleSave())).status).toBe(200); // 其他端點仍可用保留通道
    } finally {
      await s.close();
    }
  });

  it('每位玩家：PUT＋DELETE 每小時 20 次、clear 10 次、rotate 3 次（正式 vars）', async () => {
    const s = await startWorker();
    try {
      const p = await newPlayer(s);
      for (let i = 0; i < 20; i++) await putSave(s, p.token, 1, '{');
      await expect429(await putSave(s, p.token, 1, sampleSave()));
      for (let i = 0; i < 10; i++) expect((await clear(s, p.token)).status).toBe(200);
      await expect429(await clear(s, p.token));
      for (let i = 0; i < 3; i++) expect((await doRotate(s, p.token)).status).toBe(200);
      await expect429(await doRotate(s, p.token));
    } finally {
      await s.close();
    }
  });
});

describe('第 1 節：IPv6 另以 /48 限制', () => {
  let s;
  beforeAll(async () => { s = await startWorker(); });
  afterAll(async () => { await s?.close(); });

  it('建立玩家：同一 /48 下 12 個 /64 合計只能建立 10 個；別的 /48 不受影響', async () => {
    let ok = 0;
    for (let i = 0; i < 12; i++) for (let k = 0; k < 5; k++) if ((await create(s, `2001:db8:77:${i.toString(16)}::${k + 1}`)).status === 201) ok++;
    expect(ok).toBe(10);
    const r = await create(s, '2001:db8:77:ff::9');
    expect(d1Rows(r).written).toBe(0);
    await expect429(r);
    expect((await create(s, '2001:db8:78:1::1')).status).toBe(201);
    expect((await create(s, '198.51.100.20')).status).toBe(201);
  });

  it('轉移：同一 /48 下 12 個 /64 合計只能嘗試 20 次', async () => {
    let n = 0;
    for (let i = 0; i < 12; i++) for (let k = 0; k < 10; k++) {
      const { res } = await doTransfer(s, 'ZZZZ-ZZZZ', { ip: `2001:db8:88:${i.toString(16)}::1` });
      if (res.status === 404) n++;
      await res.arrayBuffer();
    }
    expect(n).toBe(20);
    const victim = await newPlayer(s);
    expect((await doTransfer(s, victim.transfer_code, { ip: '198.51.100.21' })).res.status).toBe(200);
  });
});

describe('第 2 節：Cron 刪除 7 天以上的空帳號，分批 PURGE_BATCH', () => {
  let s;
  beforeAll(async () => { s = await startWorker({ varsOverride: { STATS_MIN_PLAYERS: '1' } }); });
  afterAll(async () => { await s?.close(); });
  // 修訂 4b 第 3 節：空帳號改看 last_seen（建立時間與最後使用時間一起往前調）
  const setCreated = (pid, at) => s.db.prepare('UPDATE players SET created_at = ?, last_seen = ? WHERE player_id = ?').bind(at, at, pid).run();
  const exists = async (pid) => (await s.db.prepare('SELECT COUNT(*) AS n FROM players WHERE player_id = ?').bind(pid).first()).n === 1;

  it('空帳號 7 天後被刪；有存檔或通關紀錄的活躍玩家不刪；未滿 7 天不刪；只剩已刪除空槽也算空帳號', async () => {
    const now = nowSec();
    const empty = await newPlayer(s);
    const young = await newPlayer(s);
    const withSave = await newPlayer(s);
    const withClear = await newPlayer(s);
    const deletedOnly = await newPlayer(s);
    expect((await putSave(s, withSave.token, 1, sampleSave())).status).toBe(200);
    expect((await clear(s, withClear.token)).status).toBe(200);
    const put = await putSave(s, deletedOnly.token, 2, sampleSave());
    const { version } = await put.json();
    expect((await s.fetch('/api/save/2', { method: 'DELETE', headers: auth(deletedOnly.token, { 'if-match': `"${version}"` }) })).status).toBe(204);
    for (const p of [empty, withSave, withClear, deletedOnly]) await setCreated(p.player_id, now - 7 * DAY - 60);
    await setCreated(young.player_id, now - 7 * DAY + 3600);

    expect((await s.scheduled(now * 1000)).outcome).toBe('ok');
    expect(await exists(empty.player_id)).toBe(false);
    expect(await exists(deletedOnly.player_id)).toBe(false);
    expect((await s.db.prepare('SELECT COUNT(*) AS n FROM saves WHERE player_id = ?').bind(deletedOnly.player_id).first()).n).toBe(0);
    expect(await exists(young.player_id)).toBe(true);
    expect(await exists(withSave.player_id)).toBe(true);
    expect(await exists(withClear.player_id)).toBe(true);
    await expectError(await s.fetch('/api/saves', { headers: auth(empty.token) }), 401, 'unauthorized');
    expect((await s.fetch('/api/saves', { headers: auth(withSave.token) })).status).toBe(200);
    // 容量計數跟著減少
    const counter = (await s.db.prepare("SELECT value FROM counters WHERE name = 'players'").first()).value;
    expect(counter).toBe((await s.db.prepare('SELECT COUNT(*) AS n FROM players').first()).n);
  });

  it('一次 Cron 最多刪 PURGE_BATCH 人，剩下的下一次再刪', async () => {
    const t = await startWorker({ varsOverride: { PURGE_BATCH: '50' } });
    try {
      const old = nowSec() - 30 * DAY;
      await t.db.prepare(`INSERT INTO players (player_id, token_hash, transfer_hash, created_at, last_seen)
        SELECT 'e' || value, 't' || value, 'x' || value, ?, ? FROM json_each(?)`).bind(old, old, JSON.stringify(Array.from({ length: 70 }, (_, i) => i))).run();
      const n = async () => (await t.db.prepare("SELECT COUNT(*) AS n FROM players WHERE player_id LIKE 'e%'").first()).n;
      await t.scheduled(Date.now());
      expect(await n()).toBe(20);
      await t.scheduled(Date.now());
      expect(await n()).toBe(0);
    } finally {
      await t.close();
    }
  });
});

describe('第 3 節：rotate 的冪等比對在限流之前', () => {
  it('rotate 額度用完後，重送「目前已生效的碼」→ 200，不計入任何限流、不寫入', async () => {
    const s = await startWorker({ varsOverride: { RL_ROTATE_PER_HOUR: '2', RL_WRITE_GLOBAL_PER_HOUR: '1', RL_WRITE_GLOBAL_PER_DAY: '1' } });
    try {
      const p = await newPlayer(s);
      const code = generateTransferCode();
      expect((await doRotate(s, p.token, code)).status).toBe(200);
      for (let i = 0; i < 5; i++) {
        const r = await doRotate(s, p.token, code);
        expect(r.status).toBe(200);
        expect(d1Rows(r).written).toBe(0);
        await r.arrayBuffer();
      }
      expect(await bucketCount(s, `pl:rotate:${p.player_id}`)).toBe(1);
      expect((await doRotate(s, p.token)).status).toBe(200); // 額度沒有被重送吃掉：第 2 次（全域每小時 1）
      await expect429(await doRotate(s, p.token, code)); // 舊碼已不是目前的碼 → 正常計入限流
    } finally {
      await s.close();
    }
  });
});

describe('第 5 節：轉移碼探測', () => {
  it('POST /api/player 因轉移碼碰撞回 409 → 計入 ip:transfer 與 g:transfer', async () => {
    const s = await startWorker({ varsOverride: { RL_TRANSFER_PER_HOUR: '2' } });
    try {
      const victim = await newPlayer(s);
      const ip = '198.51.100.40';
      for (let i = 0; i < 2; i++) await expectError(await create(s, ip, { token: newSecrets().token, transfer_code: victim.transfer_code }), 409, 'conflict');
      expect(await bucketCount(s, 'g:transfer')).toBe(2);
      // 這個 IP 的轉移額度已經用完：接續與再一次探測都 429
      await expect429((await doTransfer(s, victim.transfer_code, { ip })).res);
      await expect429(await create(s, ip, { token: newSecrets().token, transfer_code: victim.transfer_code }));
    } finally {
      await s.close();
    }
  });

  it('rotate 因轉移碼碰撞回 409 → 計入 g:transfer（有 IP 時也計入 ip:transfer）', async () => {
    const s = await startWorker({ varsOverride: { RL_TRANSFER_GLOBAL_PER_HOUR: '1' } });
    try {
      const victim = await newPlayer(s);
      const att = await newPlayer(s);
      await expectError(await doRotate(s, att.token, victim.transfer_code), 409, 'conflict');
      expect(await bucketCount(s, 'g:transfer')).toBe(1);
      await expect429(await doRotate(s, att.token, victim.transfer_code));
      await expect429((await doTransfer(s, victim.transfer_code)).res);
    } finally {
      await s.close();
    }
  });

  describe('低熵秘密 → 400', () => {
    let s;
    beforeAll(async () => { s = await startWorker(); });
    afterAll(async () => { await s?.close(); });
    const lowToken = 'A'.repeat(43);
    const fifteen = 'ABCDEFGHIJKLMNO'.repeat(3).slice(0, 43); // 15 種字元
    const sixteen = 'ABCDEFGHIJKLMNOP'.repeat(3).slice(0, 43); // 16 種字元

    it.each([
      ['權杖只有 1 種字元', { token: lowToken, transfer_code: generateTransferCode() }],
      ['權杖只有 15 種字元', { token: fifteen, transfer_code: generateTransferCode() }],
      ['轉移碼同一字元 4 次', { token: newSecrets().token, transfer_code: 'AAAA-BCDE' }],
      ['轉移碼同一字元 8 次', { token: newSecrets().token, transfer_code: 'AAAA-AAAA' }],
      ['轉移碼同一字元分散 4 次', { token: newSecrets().token, transfer_code: 'A2A3-A4A5' }],
    ])('POST /api/player：%s', async (_, body) => {
      await expectError(await create(s, s.nextIp(), body), 400, 'bad_request');
    });

    it('邊界：16 種字元的權杖、同一字元 3 次的轉移碼可以建立', async () => {
      expect((await create(s, s.nextIp(), { token: sixteen, transfer_code: 'AAAB-CDEF' })).status).toBe(201);
    });

    it('POST /api/transfer：new_token／new_transfer_code 低熵 → 400，原本的碼仍有效', async () => {
      const p = await newPlayer(s);
      const raw = (b) => s.fetch('/api/transfer', json(b, { 'cf-connecting-ip': s.nextIp() }));
      await expectError(await raw({ code: p.transfer_code, new_token: lowToken, new_transfer_code: generateTransferCode() }), 400, 'bad_request');
      await expectError(await raw({ code: p.transfer_code, new_token: newSecrets().token, new_transfer_code: 'ZZZZ-2345' }), 400, 'bad_request');
      expect((await doTransfer(s, p.transfer_code)).res.status).toBe(200);
    });

    it('rotate：新碼低熵 → 400', async () => {
      const p = await newPlayer(s);
      await expectError(await doRotate(s, p.token, 'BBBB-2345'), 400, 'bad_request');
    });
  });
});

describe('第 7 節：MAX_PLAYER_SECONDS＝36000', () => {
  it('36000 秒可以、36001 秒 → 400', async () => {
    const s = await startWorker();
    try {
      const p = await newPlayer(s);
      expect((await clear(s, p.token, { play_seconds: 36000 })).status).toBe(200);
      await expectError(await clear(s, p.token, { chapter: 'chapter2', play_seconds: 36001 }), 400, 'bad_request');
      await expectError(await clear(s, p.token, { chapter: 'chapter2', play_seconds: 1e7 }), 400, 'bad_request');
    } finally {
      await s.close();
    }
  });
});
