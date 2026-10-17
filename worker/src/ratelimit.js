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
/** 429 rate_limited（Retry-After＝resetAt − now，1 秒～1 天）。 */
export const rateLimited = (resetAt, now) => tooMany(resetAt, now);
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

// 多個 bucket 用一條敘述原子計數（修訂 4b 第 1 節）：gate 在敘述開始時算一次（MATERIALIZED），
// 全部都還沒達到 limit 才一起加一；任何一個滿了就一列都不寫。D1 逐條依序執行敘述，
// 所以並行請求之間不會有「檢查通過、計數前被別人用完」的空隙——超過限流的請求在並行時也一列都不寫。
// ?1：[[bucket, limit, 新時間窗結束時間], …] 的 JSON；?2：現在。
const ATOMIC_UPSERT = `
WITH b AS (
  SELECT json_extract(value, '$[0]') AS bucket, json_extract(value, '$[1]') AS lim, json_extract(value, '$[2]') AS reset_at FROM json_each(?1)
), gate(ok) AS MATERIALIZED (
  SELECT NOT EXISTS (SELECT 1 FROM rate_limits r JOIN b ON r.bucket = b.bucket WHERE r.reset_at > ?2 AND r.count >= b.lim)
)
INSERT INTO rate_limits (bucket, count, reset_at)
SELECT b.bucket, 1, b.reset_at FROM b, gate WHERE gate.ok
ON CONFLICT (bucket) DO UPDATE SET
  count    = CASE WHEN rate_limits.reset_at <= ?2 THEN 1 ELSE rate_limits.count + 1 END,
  reset_at = CASE WHEN rate_limits.reset_at <= ?2 THEN excluded.reset_at ELSE rate_limits.reset_at END
RETURNING bucket`;

/**
 * 多個限制原子地一起計：全部未滿 → 全部加一並回 true；任何一個滿了 → 一列都不寫，回 false。
 * buckets：[{ bucket, limit, resetAt? }]（同一次呼叫內 bucket 不可重複）。
 */
export async function tryHitAll(db, buckets, now) {
  const spec = JSON.stringify(buckets.map((b) => [b.bucket, b.limit, b.resetAt ?? now + WINDOW_SEC]));
  const { results } = await db.prepare(ATOMIC_UPSERT).bind(spec, now).all();
  return results.length > 0;
}

/**
 * 多個限制一起計：任何一個滿了就整個不寫並丟 429（Retry-After 取已滿的 bucket 中最晚重置的）。
 * 來源超額時不會消耗全域額度（單一來源無法把全域額度用光）；全域滿了之後，換再多來源也不會產生寫入。
 */
export async function hitAll(db, buckets, now) {
  if (await tryHitAll(db, buckets, now)) return;
  let resetAt = null;
  for (const b of buckets) {
    const cur = await db.prepare(READ).bind(b.bucket).first();
    if (cur && cur.reset_at > now && cur.count >= b.limit) resetAt = Math.max(resetAt ?? 0, cur.reset_at);
  }
  throw tooMany(resetAt ?? now + 1, now);
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

// ---------- M4：加權計數（夢客對話的 neurons 預算） ----------
// 和 ATOMIC_UPSERT 相同的原子性，但每個 bucket 加自己的量（inc）：全部「count＋inc ≤ limit」才一起加，否則一列都不寫。
// ?1：[[bucket, limit, 新時間窗結束時間, inc], …] 的 JSON；?2：現在。RETURNING 加完後的 count。
const WEIGHTED_UPSERT = `
WITH b AS (
  SELECT json_extract(value, '$[0]') AS bucket, json_extract(value, '$[1]') AS lim,
         json_extract(value, '$[2]') AS reset_at, json_extract(value, '$[3]') AS inc FROM json_each(?1)
), gate(ok) AS MATERIALIZED (
  SELECT NOT EXISTS (SELECT 1 FROM b WHERE b.inc > b.lim)
     AND NOT EXISTS (SELECT 1 FROM rate_limits r JOIN b ON r.bucket = b.bucket WHERE r.reset_at > ?2 AND r.count + b.inc > b.lim)
)
INSERT INTO rate_limits (bucket, count, reset_at)
SELECT b.bucket, b.inc, b.reset_at FROM b, gate WHERE gate.ok
ON CONFLICT (bucket) DO UPDATE SET
  count    = CASE WHEN rate_limits.reset_at <= ?2 THEN excluded.count ELSE rate_limits.count + excluded.count END,
  reset_at = CASE WHEN rate_limits.reset_at <= ?2 THEN excluded.reset_at ELSE rate_limits.reset_at END
RETURNING bucket, count`;

/**
 * 加權版 tryHitAll：buckets＝[{ bucket, limit, resetAt, inc }]。全部加得下 → 一起加並回傳 Map(bucket → 加完的 count)；
 * 任何一個加不下 → 一列都不寫，回傳 null。
 */
export async function tryHitWeighted(db, buckets, now) {
  const spec = JSON.stringify(buckets.map((b) => [b.bucket, b.limit, b.resetAt ?? now + WINDOW_SEC, b.inc ?? 1]));
  const { results } = await db.prepare(WEIGHTED_UPSERT).bind(spec, now).all();
  return results.length > 0 ? new Map(results.map((r) => [r.bucket, r.count])) : null;
}

/** 修正計數（例：依實際 usage 修正預扣的 neurons、退回沒用到的對話額度）。adjust：[{ bucket, delta }]；delta 為 0 的略過。只改時間窗內的列。 */
export async function adjustCounts(db, adjust, now) {
  const stmts = adjust.filter((a) => a.delta !== 0)
    .map((a) => db.prepare('UPDATE rate_limits SET count = MAX(0, count + ?) WHERE bucket = ? AND reset_at > ?').bind(a.delta, a.bucket, now));
  if (stmts.length) await db.batch(stmts);
}

/** 只讀：時間窗內的 count（沒有或已過期 → 0）。 */
export async function currentCount(db, bucket, now) {
  const cur = await db.prepare(READ).bind(bucket).first();
  return cur && cur.reset_at > now ? cur.count : 0;
}

/** UTC 日的時間窗：{ day: 'YYYY-MM-DD', resetAt: 下一個 UTC 午夜 }。 */
export function utcDay(now) {
  return { day: new Date(now * 1000).toISOString().slice(0, 10), resetAt: (Math.floor(now / 86400) + 1) * 86400 };
}

/** 只讀：一次讀多個 bucket。回傳 Map(bucket → { count, resetAt })；沒有或已過期 → { count: 0, resetAt: null }。 */
export async function readCounts(db, buckets, now) {
  const { results } = await db.prepare('SELECT bucket, count, reset_at FROM rate_limits WHERE bucket IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(buckets)).all();
  const out = new Map(buckets.map((b) => [b, { count: 0, resetAt: null }]));
  for (const r of results) if (r.reset_at > now) out.set(r.bucket, { count: r.count, resetAt: r.reset_at });
  return out;
}
