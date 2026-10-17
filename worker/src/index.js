// 《鋼鐵迷都》雲端存檔 Worker（Cloudflare Worker＋D1）。規格：docs/API.md。
// 安全重點：SQL 一律參數綁定；權杖與轉移碼只存雜湊；權杖用常數時間比較；IP 只以「每日鹽＋IP」雜湊當限流 key；
// 錯誤回應不含內部細節；body 先看 content-length、讀取時再實際限制大小。
import {
  HttpError, badRequest, jsonResponse, errorResponse, internalError, readJson, isPlainObject,
  allowedOrigin, withCors,
} from './http.js';
import {
  generateTransferCode, normalizeTransferCode, generateToken, sha256Hex, timingSafeEqualHex,
  transferHash, ipBucketKey,
} from './codes.js';
import { hit, limitOf, maybePurge } from './ratelimit.js';
import { buildSummary, DATA_LIMIT } from './summary.js';

const SLOT_COUNT = 3;
const CHAPTER_RE = /^[a-z0-9_]{1,32}$/;
const MAX_PLAY_SECONDS = 1e7;
const LAST_SEEN_GRANULARITY = 86400; // last_seen 一天最多更新一次，省 D1 寫入額度

const nowSec = () => Math.floor(Date.now() / 1000);

function requirePepper(env) {
  const p = env.TRANSFER_PEPPER;
  if (typeof p !== 'string' || p.length === 0) throw new Error('TRANSFER_PEPPER 未設定');
  return p;
}

const isUniqueViolation = (e) => /UNIQUE constraint failed/i.test(String(e?.message ?? e));

/** 執行 fn(newCode)；新轉移碼剛好撞到既有雜湊（UNIQUE）時換一個碼重試。 */
async function withFreshCode(fn) {
  for (let attempt = 0; ; attempt++) {
    const code = generateTransferCode();
    try {
      return await fn(code);
    } catch (e) {
      if (attempt < 4 && isUniqueViolation(e)) continue;
      throw e;
    }
  }
}

// ---------- 驗證 ----------
const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{43})$/i;

/** 驗證 Authorization 權杖，回傳 player_id；失敗丟 401。 */
async function authenticate(request, env, now) {
  const m = BEARER_RE.exec(request.headers.get('authorization') ?? '');
  if (!m) throw new HttpError(401, 'unauthorized');
  const hash = await sha256Hex(m[1]);
  const row = await env.DB.prepare('SELECT player_id, token_hash, last_seen FROM players WHERE token_hash = ?')
    .bind(hash).first();
  if (!row || !timingSafeEqualHex(row.token_hash, hash)) throw new HttpError(401, 'unauthorized');
  if (now - row.last_seen >= LAST_SEEN_GRANULARITY) {
    await env.DB.prepare('UPDATE players SET last_seen = ? WHERE player_id = ?').bind(now, row.player_id).run();
  }
  return row.player_id;
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

const ipKey = async (request, env, kind, now) => {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  return `ip:${kind}:${await ipBucketKey(requirePepper(env), ip, now)}`;
};

// ---------- 端點 ----------

async function createPlayer(request, env, now) {
  await hit(env.DB, await ipKey(request, env, 'player', now), limitOf(env, 'RL_PLAYER_PER_HOUR', 5), now);
  const body = await readJson(request, { allowEmpty: true });
  if (!isPlainObject(body)) throw badRequest();
  const pepper = requirePepper(env);
  const playerId = crypto.randomUUID();
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const code = await withFreshCode(async (c) => {
    await env.DB.prepare(
      'INSERT INTO players (player_id, token_hash, transfer_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
    ).bind(playerId, tokenHash, await transferHash(pepper, normalizeTransferCode(c)), now, now).run();
    return c;
  });
  return jsonResponse({ player_id: playerId, token, transfer_code: code }, 201);
}

async function transfer(request, env, now) {
  // 先計次（成功、失敗、壞 JSON 都算），再處理內容。
  await hit(env.DB, await ipKey(request, env, 'transfer', now), limitOf(env, 'RL_TRANSFER_PER_HOUR', 10), now);
  const body = await readJson(request);
  if (!isPlainObject(body) || typeof body.code !== 'string') throw badRequest();
  const pepper = requirePepper(env);
  const notFound = () => new HttpError(404, 'not_found', { message: '轉移碼不正確或已經失效。' });
  const normalized = normalizeTransferCode(body.code);
  if (!normalized) throw notFound();
  const oldHash = await transferHash(pepper, normalized);
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  // 單一條條件式 UPDATE：換權杖（舊權杖失效）＋換轉移碼，原子完成；並行時只有一個請求會比對到舊碼。
  const result = await withFreshCode(async (c) => {
    const row = await env.DB.prepare(
      'UPDATE players SET token_hash = ?, transfer_hash = ?, last_seen = ? WHERE transfer_hash = ? RETURNING player_id',
    ).bind(tokenHash, await transferHash(pepper, normalizeTransferCode(c)), now, oldHash).first();
    return row ? { player_id: row.player_id, code: c } : null;
  });
  if (!result) throw notFound();
  return jsonResponse({ player_id: result.player_id, token, transfer_code: result.code });
}

async function rotate(request, env, now) {
  const playerId = await authenticate(request, env, now);
  await hit(env.DB, `pl:rotate:${playerId}`, limitOf(env, 'RL_ROTATE_PER_HOUR', 10), now);
  const body = await readJson(request, { allowEmpty: true });
  if (!isPlainObject(body)) throw badRequest();
  const pepper = requirePepper(env);
  const code = await withFreshCode(async (c) => {
    await env.DB.prepare('UPDATE players SET transfer_hash = ? WHERE player_id = ?')
      .bind(await transferHash(pepper, normalizeTransferCode(c)), playerId).run();
    return c;
  });
  return jsonResponse({ transfer_code: code });
}

async function listSaves(request, env, now) {
  const playerId = await authenticate(request, env, now);
  const { results } = await env.DB.prepare(
    'SELECT slot, version, updated_at, summary FROM saves WHERE player_id = ? AND data IS NOT NULL',
  ).bind(playerId).all();
  const bySlot = new Map(results.map((r) => [r.slot, r]));
  const slots = [];
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const r = bySlot.get(slot);
    slots.push(r ? { slot, version: r.version, updated_at: r.updated_at, summary: JSON.parse(r.summary) } : { slot, empty: true });
  }
  return jsonResponse({ slots });
}

async function getSave(request, env, now, rawSlot) {
  const playerId = await authenticate(request, env, now);
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
    'SELECT version, updated_at, summary FROM saves WHERE player_id = ? AND slot = ? AND data IS NOT NULL',
  ).bind(playerId, slot).first();
  return row ? { version: row.version, updated_at: row.updated_at, summary: JSON.parse(row.summary) } : null;
}

const conflict = (current) => new HttpError(409, 'conflict', { extra: { current } });
const emptySlot = () => new HttpError(404, 'not_found', { message: '這個雲端槽是空的。' });

async function putSave(request, env, now, rawSlot) {
  const playerId = await authenticate(request, env, now);
  const slot = parseSlot(rawSlot);
  const ifMatch = request.headers.get('if-match');
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifMatch !== null && ifNoneMatch !== null) throw badRequest();
  if (ifMatch === null && ifNoneMatch === null) throw new HttpError(428, 'precondition_required');
  if (ifNoneMatch !== null && ifNoneMatch.trim() !== '*') throw badRequest();
  const expected = ifMatch !== null ? parseIfMatch(ifMatch) : null;

  await hit(env.DB, `pl:write:${playerId}`, limitOf(env, 'RL_WRITE_PER_HOUR', 60), now);

  const body = await readJson(request);
  if (!isPlainObject(body) || typeof body.data !== 'string') throw badRequest();
  if (new TextEncoder().encode(body.data).byteLength > DATA_LIMIT) throw new HttpError(413, 'too_large');
  const checked = buildSummary(body.data);
  if (!checked.ok) throw new HttpError(400, 'invalid_save');
  const summary = JSON.stringify(checked.summary);

  let row;
  if (expected === null) {
    // 只在空槽（不存在或已刪除）時建立；已刪除的槽沿用版本號繼續遞增。
    row = await env.DB.prepare(`
      INSERT INTO saves (player_id, slot, version, data, summary, updated_at) VALUES (?1, ?2, 1, ?3, ?4, ?5)
      ON CONFLICT (player_id, slot) DO UPDATE SET
        version = saves.version + 1, data = excluded.data, summary = excluded.summary, updated_at = excluded.updated_at
      WHERE saves.data IS NULL
      RETURNING version, updated_at`).bind(playerId, slot, body.data, summary, now).first();
    if (!row) throw conflict(await currentOf(env, playerId, slot));
  } else {
    // 樂觀鎖：條件式 UPDATE，版本相符才寫入（不先 SELECT，避免競態）。
    row = await env.DB.prepare(`
      UPDATE saves SET version = version + 1, data = ?, summary = ?, updated_at = ?
      WHERE player_id = ? AND slot = ? AND version = ? AND data IS NOT NULL
      RETURNING version, updated_at`).bind(body.data, summary, now, playerId, slot, expected).first();
    if (!row) {
      const current = await currentOf(env, playerId, slot);
      throw current ? conflict(current) : emptySlot();
    }
  }
  return jsonResponse({ slot, version: row.version, updated_at: row.updated_at }, 200, { ETag: `"${row.version}"` });
}

async function deleteSave(request, env, now, rawSlot) {
  const playerId = await authenticate(request, env, now);
  const slot = parseSlot(rawSlot);
  const ifMatch = request.headers.get('if-match');
  if (ifMatch === null) throw new HttpError(428, 'precondition_required');
  const expected = parseIfMatch(ifMatch);
  await hit(env.DB, `pl:write:${playerId}`, limitOf(env, 'RL_WRITE_PER_HOUR', 60), now);
  // 刪除＝清空 data 並遞增版本（保留版本號，避免之後新建的存檔版本倒退）。
  const res = await env.DB.prepare(`
    UPDATE saves SET data = NULL, summary = NULL, version = version + 1, updated_at = ?
    WHERE player_id = ? AND slot = ? AND version = ? AND data IS NOT NULL`).bind(now, playerId, slot, expected).run();
  if (res.meta.changes === 0) {
    const current = await currentOf(env, playerId, slot);
    throw current ? conflict(current) : emptySlot();
  }
  return new Response(null, { status: 204 });
}

function validClear(body) {
  if (!isPlainObject(body)) return false;
  const { chapter, play_seconds: ps, collapse } = body;
  const ending = Object.hasOwn(body, 'ending') ? body.ending : null;
  if (typeof chapter !== 'string' || !CHAPTER_RE.test(chapter)) return false;
  if (ending !== null && (typeof ending !== 'string' || !CHAPTER_RE.test(ending))) return false;
  if (typeof ps !== 'number' || !Number.isFinite(ps) || ps < 0 || ps > MAX_PLAY_SECONDS) return false;
  if (!Number.isInteger(collapse) || collapse < 0 || collapse > 100) return false;
  return true;
}

async function reportClear(request, env, now) {
  const playerId = await authenticate(request, env, now);
  await hit(env.DB, `pl:clear:${playerId}`, limitOf(env, 'RL_CLEAR_PER_HOUR', 30), now);
  const body = await readJson(request);
  if (!validClear(body)) throw badRequest();
  const playSeconds = Math.round(body.play_seconds);
  const ending = body.ending ?? null;
  const [, best] = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO clears (player_id, chapter, ending, play_seconds, collapse, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (player_id, chapter) DO UPDATE SET
        ending = excluded.ending, play_seconds = excluded.play_seconds, collapse = excluded.collapse, created_at = excluded.created_at
      WHERE excluded.play_seconds < clears.play_seconds`).bind(playerId, body.chapter, ending, playSeconds, body.collapse, now),
    env.DB.prepare('SELECT play_seconds FROM clears WHERE player_id = ? AND chapter = ?').bind(playerId, body.chapter),
  ]);
  return jsonResponse({ chapter: body.chapter, best_play_seconds: best.results[0].play_seconds });
}

async function stats(request, env, now) {
  const { results } = await env.DB.prepare(`
    SELECT chapter, COUNT(*) AS players, CAST(ROUND(AVG(play_seconds)) AS INTEGER) AS avg_play_seconds
    FROM clears GROUP BY chapter ORDER BY chapter`).all();
  const chapters = results.map((r) => ({ chapter: r.chapter, players: r.players, avg_play_seconds: r.avg_play_seconds }));
  return jsonResponse({ chapters, generated_at: now }, 200, { 'Cache-Control': 'public, max-age=60' });
}

// ---------- 路由 ----------

const SAVE_RE = /^\/api\/save\/([^/]+)$/;

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  const now = nowSec();
  if (pathname === '/api/player' && method === 'POST') return createPlayer(request, env, now);
  if (pathname === '/api/saves' && method === 'GET') return listSaves(request, env, now);
  if (pathname === '/api/transfer' && method === 'POST') return transfer(request, env, now);
  if (pathname === '/api/transfer/rotate' && method === 'POST') return rotate(request, env, now);
  if (pathname === '/api/clear' && method === 'POST') return reportClear(request, env, now);
  if (pathname === '/api/stats' && method === 'GET') return stats(request, env, now);
  const m = SAVE_RE.exec(pathname);
  if (m) {
    if (method === 'GET') return getSave(request, env, now, m[1]);
    if (method === 'PUT') return putSave(request, env, now, m[1]);
    if (method === 'DELETE') return deleteSave(request, env, now, m[1]);
  }
  throw new HttpError(404, 'not_found', { message: '找不到這個路徑。' });
}

export default {
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request, env);
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin, { preflight: true });
    let response;
    try {
      response = await route(request, env);
    } catch (e) {
      if (e instanceof HttpError) {
        response = errorResponse(e);
      } else {
        // 只記錄錯誤類型與訊息到 Worker log；回應不含任何內部細節。
        console.error('internal error:', e?.name, e?.message);
        response = internalError();
      }
    }
    try {
      const purge = maybePurge(env.DB, nowSec()).catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(purge);
    } catch { /* 清理失敗不影響回應 */ }
    return withCors(response, origin);
  },
};
