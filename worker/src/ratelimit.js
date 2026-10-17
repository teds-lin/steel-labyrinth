// 頻率限制：D1 的 rate_limits 表（WITHOUT ROWID），固定時間窗（第一次命中起算 1 小時）。
// 修訂 2 D：「count < limit 才加一」的條件式 UPSERT——超過限制後只讀不寫，攻擊者灌請求不會消耗寫入額度。
// 過期紀錄由 Cron（scheduled）清理，一般請求不再順便清理。
import { HttpError } from './http.js';

export const WINDOW_SEC = 3600;

// 時間窗已過 → 重設為 1；還在時間窗內且 count < limit → 加一；否則 WHERE 不成立，不寫入、不回傳列。
const CONDITIONAL_UPSERT = `
INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?1, 1, ?2 + ${WINDOW_SEC})
ON CONFLICT (bucket) DO UPDATE SET
  count    = CASE WHEN rate_limits.reset_at <= ?2 THEN 1 ELSE rate_limits.count + 1 END,
  reset_at = CASE WHEN rate_limits.reset_at <= ?2 THEN ?2 + ${WINDOW_SEC} ELSE rate_limits.reset_at END
WHERE rate_limits.reset_at <= ?2 OR rate_limits.count < ?3
RETURNING count`;

const READ = 'SELECT count, reset_at FROM rate_limits WHERE bucket = ?';

/** 讀 vars 的限制值（字串或數字皆可）；不合法就用預設值。 */
export function limitOf(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const tooMany = (resetAt, now) => new HttpError(429, 'rate_limited', {
  headers: { 'Retry-After': String(Math.max(1, Math.min(WINDOW_SEC, resetAt - now))) },
});

/** 計一次；已達 limit 就丟 429（附 Retry-After 秒數），而且不寫入。 */
export async function hit(db, bucket, limit, now) {
  const row = await db.prepare(CONDITIONAL_UPSERT).bind(bucket, now, limit).first();
  if (row) return;
  const cur = await db.prepare(READ).bind(bucket).first();
  throw tooMany(cur?.reset_at ?? now + WINDOW_SEC, now);
}

/** 只讀：時間窗內已達 limit 就丟 429（不寫入）。給全域上限做「先看再算」用。 */
export async function assertBelow(db, bucket, limit, now) {
  const cur = await db.prepare(READ).bind(bucket).first();
  if (cur && cur.reset_at > now && cur.count >= limit) throw tooMany(cur.reset_at, now);
}

/**
 * 來源限制＋全域上限：先只讀檢查全域（滿了就整個不寫），再計來源、再計全域。
 * 來源超額時不會消耗全域額度（單一來源無法把全域額度用光）；全域滿了之後，換再多來源也不會產生寫入。
 */
export async function hitWithGlobal(db, local, global, now) {
  await assertBelow(db, global.bucket, global.limit, now);
  await hit(db, local.bucket, local.limit, now);
  await hit(db, global.bucket, global.limit, now);
}

/** Cron：刪除過期的時間窗（全表掃描；表裡只有最近一小時的來源）。 */
export function purgeExpired(db, now) {
  return db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(now);
}
