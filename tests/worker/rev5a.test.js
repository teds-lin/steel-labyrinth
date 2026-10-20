// API 修訂 5a（M5 部署前最後的小修正）：空帳號（沒有任何存檔、也沒有任何通關紀錄）改看 created_at——
// 建立超過 7 天就刪除，不看 last_seen（否則只要定期被碰一下就永遠不會被刪）。
// 有存檔或通關紀錄的帳號照舊依 180 天未上線清理。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWorker, newPlayer, auth, putSave, sampleSave } from './helpers.js';

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

describe('修訂 5a：空帳號依 created_at 清理，不看 last_seen', () => {
  let s;
  beforeAll(async () => { s = await startWorker(); });
  afterAll(async () => { await s?.close(); });
  const setTimes = (pid, created, seen) => s.db.prepare('UPDATE players SET created_at = ?, last_seen = ? WHERE player_id = ?').bind(created, seen, pid).run();
  const exists = async (pid) => (await s.db.prepare('SELECT COUNT(*) AS n FROM players WHERE player_id = ?').bind(pid).first()).n === 1;

  it('建立 8 天、昨天才碰過、沒有任何資料 → 刪；建立 8 天、有存檔 → 不刪；建立 6 天的空帳號 → 不刪', async () => {
    const now = nowSec();
    const touched = await newPlayer(s);
    const withSave = await newPlayer(s);
    const young = await newPlayer(s);
    expect((await putSave(s, withSave.token, 1, sampleSave())).status).toBe(200);
    await setTimes(touched.player_id, now - 8 * DAY, now - DAY);
    await setTimes(withSave.player_id, now - 8 * DAY, now - DAY);
    await setTimes(young.player_id, now - 6 * DAY, now - 6 * DAY);

    expect((await s.scheduled(now * 1000)).outcome).toBe('ok');
    expect(await exists(touched.player_id)).toBe(false);
    expect(await exists(withSave.player_id)).toBe(true);
    expect(await exists(young.player_id)).toBe(true);
    const r = await s.fetch('/api/saves', { headers: auth(touched.token) });
    expect(r.status).toBe(401);
    await r.arrayBuffer();
  });

  it('有存檔的帳號 last_seen 超過 180 天仍照舊清理', async () => {
    const now = nowSec();
    const p = await newPlayer(s);
    expect((await putSave(s, p.token, 1, sampleSave())).status).toBe(200);
    await setTimes(p.player_id, now - 400 * DAY, now - 180 * DAY - 10);
    await s.scheduled(now * 1000);
    expect(await exists(p.player_id)).toBe(false);
  });
});
