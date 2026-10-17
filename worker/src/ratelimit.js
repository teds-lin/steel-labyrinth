// 頻率限制：D1 的 rate_limits 表（WITHOUT ROWID），固定時間窗（第一次命中起算 1 小時）。
// 修訂 2 D：「count < limit 才加一」的條件式 UPSERT——超過限制後只讀不寫，攻擊者灌請求不會消耗寫入額度。
// 過期紀錄由 Cron（scheduled）清理，一般請求不再順便清理。
import { HttpError } from './http.js';

export const WINDOW_SEC = 3600;

// 時間窗已過 → 重設為 1；還在時間窗內且 count < limit → 加一；否則 WHERE 不成立，不寫入、不回傳列。
// ?4：新時間窗的結束時間（一般是現在＋1 小時；全域每日預算是下一個 UTC 午夜）。
const CONDITIONAL_UPSERT = `
INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?1, 1, ?4)
ON CONFLICT (bucket) DO UPDATE SET
  count    = CASE WHEN rate_limits.reset_at <= ?2 THEN 1 ELSE rate_limits.count + 1 END,
  reset_at = CASE WHEN rate_limits.reset_at <= ?2 THEN ?4 ELSE rate_limits.reset_at END
WHERE rate_limits.reset_at <= ?2 OR rate_limits.count < ?3
RETURNING count`;

const READ = 'SELECT count, reset_at FROM rate_limits WHERE bucket = ?';

/** 讀 vars 的限制值（字串或數字皆可）；不合法就用預設值。 */
export function limitOf(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const MAX_RETRY_AFTER = 86400;
const tooMany = (resetAt, now) => new HttpError(429, 'rate_limited', {
  headers: { 'Retry-After': String(Math.max(1, Math.min(MAX_RETRY_AFTER, resetAt - now))) },
});
export const isRateLimited = (e) => e instanceof HttpError && e.status === 429;

/** 計一次；已達 limit 就丟 429（附 Retry-After 秒數），而且不寫入。resetAt：新時間窗的結束時間。 */
export async function hit(db, bucket, limit, now, resetAt = now + WINDOW_SEC) {
  const row = await db.prepare(CONDITIONAL_UPSERT).bind(bucket, now, limit, resetAt).first();
  if (row) return;
  const cur = await db.prepare(READ).bind(bucket).first();
  throw tooMany(cur?.reset_at ?? resetAt, now);
}

/** 只讀：時間窗內還沒達到 limit → true。 */
export async function below(db, { bucket, limit }, now) {
  const cur = await db.prepare(READ).bind(bucket).first();
  return !(cur && cur.reset_at > now && cur.count >= limit);
}

/** 只讀：時間窗內已達 limit 就丟 429（不寫入）。給「先看再算」用。 */
export async function assertBelow(db, bucket, limit, now) {
  const cur = await db.prepare(READ).bind(bucket).first();
  if (cur && cur.reset_at > now && cur.count >= limit) throw tooMany(cur.reset_at, now);
}

/**
 * 多個限制一起計：先只讀檢查**全部**（任何一個滿了就整個不寫），再依序計數。
 * 來源超額時不會消耗全域額度（單一來源無法把全域額度用光）；全域滿了之後，換再多來源也不會產生寫入。
 * buckets：[{ bucket, limit, resetAt? }]，計數順序就是陣列順序（全域放最後）。
 */
export async function hitAll(db, buckets, now) {
  for (const b of buckets) await assertBelow(db, b.bucket, b.limit, now);
  for (const b of buckets) await hit(db, b.bucket, b.limit, now, b.resetAt);
}

/** 來源限制＋全域上限（修訂 2 D）。 */
export const hitWithGlobal = (db, local, global, now) => hitAll(db, [local, global], now);

/** 全域每日預算（修訂 4 第 1 節）：bucket 帶 UTC 日期，時間窗到下一個 UTC 午夜為止。 */
export function dayWindow(now) {
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  return { bucket: `g:wday:${day}`, resetAt: (Math.floor(now / 86400) + 1) * 86400 };
}

/**
 * Cron：刪除過期的時間窗（全表掃描）。玩家的 bucket（pl:*）不刪：同一個玩家下次寫入時會原地重設（不多寫一列），
 * 每天刪掉再重建反而每列多花 1 列寫入；它們在玩家本身被 Cron 刪除時一起刪（最多 MAX_PLAYERS × 5 列）。
 * 要刪的是每天換鹽、隔天就不會再用到的 IP bucket，以及全域 bucket。
 */
export function purgeExpired(db, now) {
  return db.prepare("DELETE FROM rate_limits WHERE reset_at <= ? AND substr(bucket, 1, 3) <> 'pl:'").bind(now);
}
