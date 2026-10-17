// 《鋼鐵迷都》雲端存檔 Worker（Cloudflare Worker＋D1）。規格：docs/API.md（與前文衝突時以最後的修訂為準，目前是「修訂 4b」）。
// 安全重點：SQL 一律參數綁定；權杖與轉移碼由客戶端產生、伺服器只存雜湊、低熵秘密拒收；權杖用常數時間比較；
// IP 只以「每日鹽＋IP（IPv6 取 /64，另加 /48 一層）」雜湊當限流 key；已登入寫入有每位玩家的保留通道；不在允許清單的 Origin 一律 403；POST／PUT 必須是 JSON（415）；
// 超過限流不寫入 D1；錯誤回應不含內部細節；body 先看 content-length、讀取時再實際限制大小。
import {
  HttpError, badRequest, jsonResponse, errorResponse, internalError, readJson, isPlainObject,
  checkOrigin, withCors, requireJsonContentType, MESSAGES,
} from './http.js';
import {
  normalizeTransferCode, isTokenFormat, sha256Hex, timingSafeEqualHex, transferHash, ipBucketKey, isIpv6Source,
  isAcceptableToken, isAcceptableTransferCode,
} from './codes.js';
import {
  hitAll, tryHitAll, assertBelow, dayWindow, limitOf, purgeExpired,
} from './ratelimit.js';
import { buildSummary, DATA_LIMIT } from './summary.js';
import { MeteredDb } from './db.js';

const SLOT_COUNT = 3;
const LAST_SEEN_GRANULARITY = 86400; // last_seen 一天最多更新一次，省 D1 寫入額度
const INACTIVE_SEC = 180 * 86400; // Cron：超過 180 天未登入的玩家連同資料刪除
const EMPTY_ACCOUNT_SEC = 7 * 86400; // Cron：超過 7 天沒有使用（last_seen）、沒有存檔也沒有通關紀錄的玩家刪除（修訂 4 第 2 節、修訂 4b 第 3 節）
const STATS_TTL = 60;

const nowSec = () => Math.floor(Date.now() / 1000);

function requirePepper(env) {
  const p = env.TRANSFER_PEPPER;
  if (typeof p !== 'string' || p.length === 0) throw new Error('TRANSFER_PEPPER 未設定');
  return p;
}

const uniqueViolation = (e) => {
  const m = /UNIQUE constraint failed: ([\w.]+)/i.exec(String(e?.message ?? e));
  return m ? m[1] : null;
};
/** 客戶端產生的秘密和既有雜湊撞到（實際上幾乎不會發生）→ 409，客戶端換一組重送。 */
const secretConflict = () => new HttpError(409, 'conflict', { message: MESSAGES.secret_conflict });

/** 轉移碼欄位：必須是字串且正規化後是 8 個合法字元；否則 null。 */
const codeField = (v) => (typeof v === 'string' ? normalizeTransferCode(v) : null);

// ---------- 驗證 ----------
const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{43})$/i;

/** 驗證 Authorization 權杖，回傳 { player_id, transfer_hash }；失敗丟 401。 */
async function authenticate(request, env, now) {
  const m = BEARER_RE.exec(request.headers.get('authorization') ?? '');
  if (!m) throw new HttpError(401, 'unauthorized');
  const hash = await sha256Hex(m[1]);
  const row = await env.DB.prepare('SELECT player_id, token_hash, transfer_hash, last_seen FROM players WHERE token_hash = ?')
    .bind(hash).first();
  if (!row || !timingSafeEqualHex(row.token_hash, hash)) throw new HttpError(401, 'unauthorized');
  if (now - row.last_seen >= LAST_SEEN_GRANULARITY) {
    await env.DB.prepare('UPDATE players SET last_seen = ? WHERE player_id = ?').bind(now, row.player_id).run();
  }
  return row;
}

function parseSlot(raw) {
  if (!/^[1-9]$/.test(raw)) throw badRequest();
  const slot = Number(raw);
  if (slot > SLOT_COUNT) throw badRequest();
  return slot;
}

/** If-Match 的版本號：接受 "3"、3、W/"3"；其他格式 → 400。 */
function parseIfMatch(value) {
  const m = /^(?:W\/)?(?:"([1-9]\d{0,14})"|([1-9]\d{0,14}))$/.exec(value.trim());
  if (!m) throw badRequest();
  return Number(m[1] ?? m[2]);
}

/**
 * 已登入寫入（PUT、DELETE、clear、rotate）的限流（修訂 3、修訂 4 第 1 節、修訂 4b 第 1 節）：
 * - 一律先受同一玩家的端點限制（RL_WRITE／RL_CLEAR／RL_ROTATE_PER_HOUR）。
 * - 保留通道：同一玩家每小時的前 RL_RESERVED_PER_HOUR 次寫入（四種合計）不受全域每小時上限，
 *   改計入全域每日預算 RL_WRITE_GLOBAL_PER_DAY——攻擊者灌滿全域每小時上限時，正常玩家仍能寫入。
 *   端點限制、保留名額、每日預算三者用一條敘述原子計數：保留名額沒拿到就不碰每日預算，
 *   所以單一帳號並行送再多請求，每日預算最多也只增加 RL_RESERVED_PER_HOUR（修訂 4b：修正並行放大）。
 * - 保留通道用完（或全域每日預算用完）→ 受全域每小時上限 RL_WRITE_GLOBAL_PER_HOUR 限制，保留名額不被消耗。
 * 任何一個限制滿了都回 429，而且一列都不寫（並行時也一樣）。
 */
async function hitWrite(env, playerId, { kind, name, fallback }, now) {
  const db = env.DB;
  const local = { bucket: `pl:${kind}:${playerId}`, limit: limitOf(env, name, fallback) };
  const reserved = { bucket: `pl:rsv:${playerId}`, limit: limitOf(env, 'RL_RESERVED_PER_HOUR', 3) };
  const day = { ...dayWindow(now), limit: limitOf(env, 'RL_WRITE_GLOBAL_PER_DAY', 4000) };
  const hourly = { bucket: 'g:write', limit: limitOf(env, 'RL_WRITE_GLOBAL_PER_HOUR', 100) };
  if (await tryHitAll(db, [local, reserved, day], now)) return;
  await hitAll(db, [local, hourly], now);
}

/** 玩家的限流 bucket 前綴（pl:<kind>:<player_id>）；Cron 刪除玩家時一起刪（purgeExpired 不刪它們）。 */
const PLAYER_BUCKET_PREFIXES = JSON.stringify(['write', 'clear', 'rotate', 'rsv', 'transfer'].map((k) => `pl:${k}:`));

const WRITE_LIMITS = {
  write: { kind: 'write', name: 'RL_WRITE_PER_HOUR', fallback: 20 },
  clear: { kind: 'clear', name: 'RL_CLEAR_PER_HOUR', fallback: 10 },
  rotate: { kind: 'rotate', name: 'RL_ROTATE_PER_HOUR', fallback: 3 },
};

const clientIp = (request) => request.headers.get('cf-connecting-ip');

/** IP 限流的 bucket：IPv4 一層；IPv6 兩層（/64 與 /48，修訂 4 第 1 節）。 */
async function ipBuckets(request, env, kind, now, { name, fallback, name48, fallback48 }) {
  const pepper = requirePepper(env);
  const ip = clientIp(request) ?? 'unknown';
  const out = [{ bucket: `ip:${kind}:${await ipBucketKey(pepper, ip, now)}`, limit: limitOf(env, name, fallback) }];
  if (isIpv6Source(ip)) {
    out.push({ bucket: `ip:${kind}48:${await ipBucketKey(pepper, ip, now, 48)}`, limit: limitOf(env, name48, fallback48) });
  }
  return out;
}

const PLAYER_IP_LIMITS = { name: 'RL_PLAYER_PER_HOUR', fallback: 5, name48: 'RL_PLAYER_PER_HOUR_V6_48', fallback48: 10 };
const TRANSFER_IP_LIMITS = { name: 'RL_TRANSFER_PER_HOUR', fallback: 10, name48: 'RL_TRANSFER_PER_HOUR_V6_48', fallback48: 20 };
const globalTransfer = (env) => ({ bucket: 'g:transfer', limit: limitOf(env, 'RL_TRANSFER_GLOBAL_PER_HOUR', 120) });

/**
 * 計入轉移額度（ip:transfer〔IPv6 另加 /48〕＋g:transfer）。轉移嘗試本身，以及 POST /api/player 與 rotate
 * 因轉移碼雜湊碰撞回 409 時（修訂 4 第 5 節：碰撞等於猜中別人的轉移碼，要和猜碼共用同一份額度）。
 * rotate 沒有 IP 資訊時改以玩家計入。
 */
async function transferBuckets(request, env, now, playerId = null) {
  const local = playerId !== null && clientIp(request) === null
    ? [{ bucket: `pl:transfer:${playerId}`, limit: limitOf(env, 'RL_TRANSFER_PER_HOUR', 10) }]
    : await ipBuckets(request, env, 'transfer', now, TRANSFER_IP_LIMITS);
  return [...local, globalTransfer(env)];
}
async function hitTransfer(request, env, now, playerId = null) {
  await hitAll(env.DB, await transferBuckets(request, env, now, playerId), now);
}

/**
 * 修訂 4b 第 2 節：寫入轉移碼（建立玩家、rotate）之前，先只讀檢查轉移額度；已滿 → 一律 429、不執行 INSERT／UPDATE。
 * 否則額度用完後，攻擊者仍能從「新碼碰撞 → 429」與「沒碰撞 → 寫入成功」的差別分辨是否猜中別人的轉移碼。
 */
async function assertTransferBelow(request, env, now, playerId = null) {
  for (const b of await transferBuckets(request, env, now, playerId)) await assertBelow(env.DB, b.bucket, b.limit, now);
}

/** 秘密碰撞 → 先計入轉移額度（額度用完則 429），再回 409。 */
async function collision(request, env, now, playerId = null) {
  await hitTransfer(request, env, now, playerId);
  return secretConflict();
}

// ---------- 端點 ----------

async function createPlayer(request, env, now) {
  requireJsonContentType(request);
  const pepper = requirePepper(env);
  await hitAll(env.DB, [
    ...await ipBuckets(request, env, 'player', now, PLAYER_IP_LIMITS),
    { bucket: 'g:player', limit: limitOf(env, 'RL_PLAYER_GLOBAL_PER_HOUR', 60) },
  ], now);
  const body = await readJson(request);
  if (!isPlainObject(body) || !isTokenFormat(body.token)) throw badRequest();
  const code = codeField(body.transfer_code);
  if (!code) throw badRequest();
  // 修訂 4 第 5 節：低熵秘密 400（官方客戶端用同一套判斷產生，不會被誤殺）
  if (!isAcceptableToken(body.token) || !isAcceptableTransferCode(code)) throw badRequest();
  const tokenHash = await sha256Hex(body.token);
  const existing = () => env.DB.prepare('SELECT player_id FROM players WHERE token_hash = ?').bind(tokenHash).first();
  // 冪等：權杖已經建立過（例如上一次請求逾時）→ 回同一個玩家。持有權杖即擁有帳號。
  const had = await existing();
  if (had) return jsonResponse({ player_id: had.player_id }, 200);
  await assertTransferBelow(request, env, now);
  const playerId = crypto.randomUUID();
  let row;
  try {
    // 容量上限：counters 由 trigger 維護，讀一列就知道玩家數；和 INSERT 在同一條敘述內判斷，不會超收。
    row = await env.DB.prepare(`
      INSERT INTO players (player_id, token_hash, transfer_hash, created_at, last_seen)
      SELECT ?1, ?2, ?3, ?4, ?4 WHERE (SELECT value FROM counters WHERE name = 'players') < ?5
      RETURNING player_id`).bind(playerId, tokenHash, await transferHash(pepper, code), now, limitOf(env, 'MAX_PLAYERS', 20000)).first();
  } catch (e) {
    const col = uniqueViolation(e);
    if (col === 'players.token_hash') { // 同一個權杖的兩個請求同時抵達
      const again = await existing();
      if (again) return jsonResponse({ player_id: again.player_id }, 200);
    }
    if (col) throw await collision(request, env, now);
    throw e;
  }
  if (!row) throw new HttpError(503, 'capacity');
  return jsonResponse({ player_id: row.player_id }, 201);
}

async function transfer(request, env, now) {
  requireJsonContentType(request);
  const pepper = requirePepper(env);
  // 先計次（成功、失敗、壞 JSON 都算），再處理內容。
  await hitTransfer(request, env, now);
  const body = await readJson(request);
  if (!isPlainObject(body) || typeof body.code !== 'string' || !isTokenFormat(body.new_token)) throw badRequest();
  const newCode = codeField(body.new_transfer_code);
  if (!newCode) throw badRequest();
  if (!isAcceptableToken(body.new_token) || !isAcceptableTransferCode(newCode)) throw badRequest(); // 修訂 4 第 5 節
  const notFound = () => new HttpError(404, 'not_found', { message: MESSAGES.transfer_not_found });
  const normalized = normalizeTransferCode(body.code);
  if (!normalized) throw notFound();
  if (newCode === normalized) throw badRequest(); // 舊碼必須失效
  // 單一條條件式 UPDATE：換權杖（舊權杖失效）＋換轉移碼，原子完成；並行時只有一個請求會比對到舊碼。
  let row;
  try {
    row = await env.DB.prepare(
      'UPDATE players SET token_hash = ?, transfer_hash = ?, last_seen = ? WHERE transfer_hash = ? RETURNING player_id',
    ).bind(await sha256Hex(body.new_token), await transferHash(pepper, newCode), now, await transferHash(pepper, normalized)).first();
  } catch (e) {
    if (uniqueViolation(e)) throw secretConflict();
    throw e;
  }
  if (!row) throw notFound();
  return jsonResponse({ player_id: row.player_id });
}

async function rotate(request, env, now) {
  requireJsonContentType(request);
  const pepper = requirePepper(env);
  const player = await authenticate(request, env, now);
  // 修訂 4 第 3 節：先讀 body、比對雜湊；重送「已經生效的新碼」直接 200，不計入任何限流
  // （否則回應遺失後的重送會被 429 擋下，客戶端以為沒換成功，畫面顯示已經失效的舊碼）。
  const body = await readJson(request);
  if (!isPlainObject(body)) throw badRequest();
  const code = codeField(body.new_transfer_code);
  if (!code) throw badRequest();
  const hash = await transferHash(pepper, code);
  if (timingSafeEqualHex(player.transfer_hash, hash)) return jsonResponse({});
  if (!isAcceptableTransferCode(code)) throw badRequest(); // 修訂 4 第 5 節
  await assertTransferBelow(request, env, now, player.player_id); // 修訂 4b 第 2 節：先於任何寫入
  await hitWrite(env, player.player_id, WRITE_LIMITS.rotate, now);
  try {
    await env.DB.prepare('UPDATE players SET transfer_hash = ? WHERE player_id = ?').bind(hash, player.player_id).run();
  } catch (e) {
    if (uniqueViolation(e)) throw await collision(request, env, now, player.player_id);
    throw e;
  }
  return jsonResponse({});
}

/** 有存檔的槽：{ slot?, version, updated_at, data_sha256, summary }（修訂 2 B：data_sha256＝data 的 SHA-256 hex）。 */
const slotInfo = (r, withSlot = true) => ({
  ...(withSlot ? { slot: r.slot } : {}), version: r.version, updated_at: r.updated_at, data_sha256: r.data_sha256, summary: JSON.parse(r.summary),
});

async function listSaves(request, env, now) {
  const { player_id: playerId } = await authenticate(request, env, now);
  const { results } = await env.DB.prepare(
    'SELECT slot, version, updated_at, data_sha256, summary FROM saves WHERE player_id = ? AND data IS NOT NULL',
  ).bind(playerId).all();
  const bySlot = new Map(results.map((r) => [r.slot, r]));
  const slots = [];
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const r = bySlot.get(slot);
    slots.push(r ? slotInfo(r) : { slot, empty: true });
  }
  return jsonResponse({ slots });
}

async function getSave(request, env, now, rawSlot) {
  const { player_id: playerId } = await authenticate(request, env, now);
  const slot = parseSlot(rawSlot);
  const row = await env.DB.prepare(
    'SELECT version, updated_at, data FROM saves WHERE player_id = ? AND slot = ? AND data IS NOT NULL',
  ).bind(playerId, slot).first();
  if (!row) throw new HttpError(404, 'not_found', { message: '這個雲端槽是空的。' });
  return jsonResponse({ slot, version: row.version, updated_at: row.updated_at, data: row.data }, 200, { ETag: `"${row.version}"` });
}

/** 讀目前的版本與摘要（給 409 的 current）；空槽或不存在回 null。 */
async function currentOf(env, playerId, slot) {
  const row = await env.DB.prepare(
    'SELECT version, updated_at, data_sha256, summary FROM saves WHERE player_id = ? AND slot = ? AND data IS NOT NULL',
  ).bind(playerId, slot).first();
  return row ? slotInfo(row, false) : null;
}

const conflict = (current) => new HttpError(409, 'conflict', { extra: { current } });
const emptySlot = () => new HttpError(404, 'not_found', { message: '這個雲端槽是空的。' });

async function putSave(request, env, now, rawSlot) {
  requireJsonContentType(request);
  const { player_id: playerId } = await authenticate(request, env, now);
  const slot = parseSlot(rawSlot);
  const ifMatch = request.headers.get('if-match');
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifMatch !== null && ifNoneMatch !== null) throw badRequest();
  if (ifMatch === null && ifNoneMatch === null) throw new HttpError(428, 'precondition_required');
  if (ifNoneMatch !== null && ifNoneMatch.trim() !== '*') throw badRequest();
  const expected = ifMatch !== null ? parseIfMatch(ifMatch) : null;

  await hitWrite(env, playerId, WRITE_LIMITS.write, now);

  const body = await readJson(request);
  if (!isPlainObject(body) || typeof body.data !== 'string') throw badRequest();
  if (new TextEncoder().encode(body.data).byteLength > DATA_LIMIT) throw new HttpError(413, 'too_large');
  const checked = buildSummary(body.data);
  if (!checked.ok) throw new HttpError(400, 'invalid_save');
  const summary = JSON.stringify(checked.summary);
  const digest = await sha256Hex(body.data);

  let row;
  if (expected === null) {
    // 只在空槽（不存在或已刪除）時建立；已刪除的槽沿用版本號繼續遞增。
    row = await env.DB.prepare(`
      INSERT INTO saves (player_id, slot, version, data, data_sha256, summary, updated_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6)
      ON CONFLICT (player_id, slot) DO UPDATE SET
        version = saves.version + 1, data = excluded.data, data_sha256 = excluded.data_sha256,
        summary = excluded.summary, updated_at = excluded.updated_at
      WHERE saves.data IS NULL
      RETURNING version, updated_at`).bind(playerId, slot, body.data, digest, summary, now).first();
    if (!row) throw conflict(await currentOf(env, playerId, slot));
  } else {
    // 樂觀鎖：條件式 UPDATE，版本相符才寫入（不先 SELECT，避免競態）。
    row = await env.DB.prepare(`
      UPDATE saves SET version = version + 1, data = ?, data_sha256 = ?, summary = ?, updated_at = ?
      WHERE player_id = ? AND slot = ? AND version = ? AND data IS NOT NULL
      RETURNING version, updated_at`).bind(body.data, digest, summary, now, playerId, slot, expected).first();
    if (!row) {
      const current = await currentOf(env, playerId, slot);
      throw current ? conflict(current) : emptySlot();
    }
  }
  return jsonResponse({ slot, version: row.version, updated_at: row.updated_at }, 200, { ETag: `"${row.version}"` });
}

async function deleteSave(request, env, now, rawSlot) {
  const { player_id: playerId } = await authenticate(request, env, now);
  const slot = parseSlot(rawSlot);
  const ifMatch = request.headers.get('if-match');
  if (ifMatch === null) throw new HttpError(428, 'precondition_required');
  const expected = parseIfMatch(ifMatch);
  await hitWrite(env, playerId, WRITE_LIMITS.write, now);
  // 刪除＝清空 data 並遞增版本（保留版本號，避免之後新建的存檔版本倒退）。
  const res = await env.DB.prepare(`
    UPDATE saves SET data = NULL, data_sha256 = NULL, summary = NULL, version = version + 1, updated_at = ?
    WHERE player_id = ? AND slot = ? AND version = ? AND data IS NOT NULL`).bind(now, playerId, slot, expected).run();
  if (res.meta.changes === 0) {
    const current = await currentOf(env, playerId, slot);
    throw current ? conflict(current) : emptySlot();
  }
  return new Response(null, { status: 204 });
}

/** vars 的 CHAPTERS（逗號分隔）：允許回報的章節白名單，必須等於 web/data/manifest.json 的 chapters（測試把關）。 */
const chaptersOf = (env) => String(env.CHAPTERS ?? '').split(',').map((c) => c.trim()).filter(Boolean);

/** maxSeconds：MAX_PLAYER_SECONDS（修訂 4 第 7 節：10 小時，超過 400）。 */
function validClear(body, chapters, maxSeconds) {
  if (!isPlainObject(body)) return false;
  const { chapter, play_seconds: ps, collapse } = body;
  if (typeof chapter !== 'string' || !chapters.includes(chapter)) return false;
  if (Object.hasOwn(body, 'ending') && body.ending !== null) return false; // 修訂 2 E：ending 目前一律 null
  if (typeof ps !== 'number' || !Number.isFinite(ps) || ps < 0 || ps > maxSeconds) return false;
  if (!Number.isInteger(collapse) || collapse < 0 || collapse > 100) return false;
  return true;
}

async function reportClear(request, env, now) {
  requireJsonContentType(request);
  const { player_id: playerId } = await authenticate(request, env, now);
  await hitWrite(env, playerId, WRITE_LIMITS.clear, now);
  const body = await readJson(request);
  if (!validClear(body, chaptersOf(env), limitOf(env, 'MAX_PLAYER_SECONDS', 36000))) throw badRequest();
  const playSeconds = Math.round(body.play_seconds);
  // chapter_stats 由 clears 的 trigger 同步更新（新紀錄＋1 人；改善成績調整總時間）。
  const [, best] = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO clears (player_id, chapter, ending, play_seconds, collapse, created_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5)
      ON CONFLICT (player_id, chapter) DO UPDATE SET
        ending = excluded.ending, play_seconds = excluded.play_seconds, collapse = excluded.collapse, created_at = excluded.created_at
      WHERE excluded.play_seconds < clears.play_seconds`).bind(playerId, body.chapter, playSeconds, body.collapse, now),
    env.DB.prepare('SELECT play_seconds FROM clears WHERE player_id = ? AND chapter = ?').bind(playerId, body.chapter),
  ]);
  return jsonResponse({ chapter: body.chapter, best_play_seconds: best.results[0].play_seconds });
}

/**
 * 公開統計（修訂 2 E）：Cache API 快取 60 秒，同一個時間窗內同一個資料中心最多查一次 D1；
 * 只讀 chapter_stats（列數＝章節數），只列出白名單內、完成人數 ≥ STATS_MIN_PLAYERS 的章節。
 * 快取的是不含 CORS 標頭的回應，CORS 依每個請求的 Origin 另外加。
 */
async function stats(request, env, now, ctx) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(new URL('/api/stats', request.url).toString(), { method: 'GET' });
  if (cache) {
    const cached = await cache.match(key);
    if (cached) return cached;
  }
  const min = limitOf(env, 'STATS_MIN_PLAYERS', 3);
  const allowed = new Set(chaptersOf(env));
  const { results } = await env.DB.prepare(`
    SELECT chapter, players, CAST(ROUND(total_seconds * 1.0 / players) AS INTEGER) AS avg_play_seconds
    FROM chapter_stats WHERE players >= ? ORDER BY chapter`).bind(min).all();
  const chapters = results.filter((r) => allowed.has(r.chapter))
    .map((r) => ({ chapter: r.chapter, players: r.players, avg_play_seconds: r.avg_play_seconds }));
  const response = jsonResponse({ chapters, generated_at: now }, 200, { 'Cache-Control': `public, max-age=${STATS_TTL}` });
  if (cache) {
    const put = cache.put(key, response.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    await put;
  }
  return response;
}

// Cron 要刪的玩家：超過 180 天未登入（?1），或超過 7 天沒有使用（last_seen < ?2，修訂 4b 第 3 節）而且沒有任何存檔
// （已刪除的空槽不算）也沒有通關紀錄。last_seen 一天最多更新一次，所以實際上是「至少 6 天沒有任何已登入請求」。
const PURGE_WHERE = `(p.last_seen < ?1 OR (p.last_seen < ?2
  AND NOT EXISTS (SELECT 1 FROM saves s WHERE s.player_id = p.player_id AND s.data IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM clears c WHERE c.player_id = p.player_id)))`;
// 刪除時把條件再判斷一次：在「選出名單」與「刪除」之間剛上傳存檔的玩家不會被誤刪。
const PURGE_TARGETS = `SELECT p.player_id FROM players p JOIN json_each(?3) j ON j.value = p.player_id WHERE ${PURGE_WHERE}`;

/**
 * Cron（每天一次）：刪除超過 180 天未登入的玩家，以及超過 7 天沒有使用的空帳號（修訂 4 第 2 節、修訂 4b 第 3 節），連同其存檔、通關紀錄；
 * 每次最多 batch（PURGE_BATCH）人，避免單次寫入暴增，剩下的下一次再刪。另外刪除過期的限流紀錄。
 * 回傳這次刪除的玩家數。
 */
export async function purge(db, now, { batch = 500 } = {}) {
  const stale = now - INACTIVE_SEC;
  const empty = now - EMPTY_ACCOUNT_SEC;
  const { results } = await db.prepare(`SELECT p.player_id FROM players p WHERE ${PURGE_WHERE} ORDER BY p.player_id LIMIT ?3`)
    .bind(stale, empty, batch).all();
  let deleted = 0;
  if (results.length > 0) {
    const ids = JSON.stringify(results.map((r) => r.player_id));
    const rs = await db.batch([
      db.prepare(`DELETE FROM saves WHERE player_id IN (${PURGE_TARGETS})`).bind(stale, empty, ids),
      db.prepare(`DELETE FROM clears WHERE player_id IN (${PURGE_TARGETS})`).bind(stale, empty, ids),
      db.prepare(`DELETE FROM rate_limits WHERE bucket IN (SELECT k.value || t.player_id FROM (${PURGE_TARGETS}) t, json_each(?4) k)`)
        .bind(stale, empty, ids, PLAYER_BUCKET_PREFIXES),
      db.prepare(`DELETE FROM players WHERE player_id IN (${PURGE_TARGETS}) RETURNING player_id`).bind(stale, empty, ids),
    ]);
    deleted = rs[3]?.results?.length ?? 0;
  }
  await db.batch([purgeExpired(db, now)]);
  return deleted;
}

// ---------- 路由 ----------

const SAVE_RE = /^\/api\/save\/([^/]+)$/;

async function route(request, env, ctx) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  const now = nowSec();
  if (pathname === '/api/player' && method === 'POST') return createPlayer(request, env, now);
  if (pathname === '/api/saves' && method === 'GET') return listSaves(request, env, now);
  if (pathname === '/api/transfer' && method === 'POST') return transfer(request, env, now);
  if (pathname === '/api/transfer/rotate' && method === 'POST') return rotate(request, env, now);
  if (pathname === '/api/clear' && method === 'POST') return reportClear(request, env, now);
  if (pathname === '/api/stats' && method === 'GET') return stats(request, env, now, ctx);
  const m = SAVE_RE.exec(pathname);
  if (m) {
    if (method === 'GET') return getSave(request, env, now, m[1]);
    if (method === 'PUT') return putSave(request, env, now, m[1]);
    if (method === 'DELETE') return deleteSave(request, env, now, m[1]);
  }
  throw new HttpError(404, 'not_found', { message: '找不到這個路徑。' });
}

export default {
  async fetch(request, rawEnv, ctx) {
    const db = new MeteredDb(rawEnv.DB);
    const env = { ...rawEnv, DB: db };
    const { origin, forbidden } = checkOrigin(request, env);
    const preflight = request.method === 'OPTIONS';
    let response;
    if (forbidden) {
      // 修訂 2 C：帶了 Origin 但不在允許清單（含預檢）→ 403，不碰資料庫。
      response = errorResponse(new HttpError(403, 'forbidden_origin'));
    } else if (preflight) {
      response = new Response(null, { status: 204 });
    } else {
      try {
        response = await route(request, env, ctx);
      } catch (e) {
        if (e instanceof HttpError) {
          response = errorResponse(e);
        } else {
          // 只記錄錯誤類型與訊息到 Worker log；回應不含任何內部細節。
          console.error('internal error:', e?.name, e?.message);
          response = internalError();
        }
      }
    }
    response = withCors(response, origin, { preflight });
    if (rawEnv.D1_METRICS === '1') response.headers.set('x-d1-rows', db.header());
    return response;
  },

  async scheduled(controller, env, ctx) {
    const now = Math.floor((controller?.scheduledTime ?? Date.now()) / 1000);
    const job = purge(env.DB, now, { batch: limitOf(env, 'PURGE_BATCH', 500) });
    if (ctx?.waitUntil) ctx.waitUntil(job.catch(() => {}));
    await job;
  },
};
