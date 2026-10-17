// 頻率限制：D1 的 rate_limits 表，固定時間窗（第一次命中起算 1 小時）。
// 用單一條 UPSERT … RETURNING 原子地「加一並取回計數」，不會有先讀後寫的競態。
import { HttpError } from './http.js';

export const WINDOW_SEC = 3600;

const UPSERT = `
INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?1, 1, ?2 + ${WINDOW_SEC})
ON CONFLICT (bucket) DO UPDATE SET
  count    = CASE WHEN rate_limits.reset_at <= ?2 THEN 1 ELSE rate_limits.count + 1 END,
  reset_at = CASE WHEN rate_limits.reset_at <= ?2 THEN ?2 + ${WINDOW_SEC} ELSE rate_limits.reset_at END
RETURNING count, reset_at`;

/** 讀 vars 的限制值（字串或數字皆可）；不合法就用預設值。 */
export function limitOf(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 計一次；超過 limit 就丟 429（附 Retry-After 秒數）。 */
export async function hit(db, bucket, limit, now) {
  const row = await db.prepare(UPSERT).bind(bucket, now).first();
  if (row.count > limit) {
    const retry = Math.max(1, Math.min(WINDOW_SEC, row.reset_at - now));
    throw new HttpError(429, 'rate_limited', { headers: { 'Retry-After': String(retry) } });
  }
}

/** 偶爾清掉過期的時間窗（約 1% 的請求），避免表無限成長。 */
export async function maybePurge(db, now) {
  if (Math.random() < 0.01) await db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(now).run();
}
