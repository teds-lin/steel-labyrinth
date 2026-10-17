// E2E 用的假雲端 API（照 docs/API.md、「補充（2026-10-17）」與「修訂 2」的行為），以 Playwright 的 route 攔截。
// 修訂 2：權杖與轉移碼由客戶端產生（伺服器只驗證格式）、建立玩家與 rotate 冪等、列表與 409 附 data_sha256、
// POST／PUT 必須是 application/json（否則 415）。
// 同一個 mock 可以掛在多個 browser context 上（模擬兩台裝置共用同一個伺服器）。
// 位址用 127.0.0.1（跨來源）：順便驗證 CORS 標頭（ETag、Retry-After 要 expose 才讀得到）。
// 鐘塔之夢 修訂 1：通行證回應帶 ttl_s（2 小時）；夢客回覆帶 sig（HMAC），history 裡 guest 項目的 sig 不對就丟掉該則
// （丟掉的記在 log 的 entry.droppedHistory，給測試斷言）。

export const MOCK_API = 'http://127.0.0.1:9/mock-api';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { FAKE_TS_TOKEN } from './fake-turnstile.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

let seq = 0;
const randomCode = () => {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
/** 正規化：去掉空白與連字號、轉大寫；不是 8 個合法字元回 null（與 Worker 相同）。 */
const normCode = (c) => {
  if (typeof c !== 'string') return null;
  const s = c.toUpperCase().replace(/[\s-]/g, '');
  return s.length === 8 && [...s].every((ch) => ALPHABET.includes(ch)) ? s : null;
};
export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DREAM_SECRET = 'mock-dream-pass-secret';
/** 修訂 1 C／1a 4：base64url(HMAC-SHA256(secret, player_id + "\n" + guest + "\n" + reply))。history 的 text 必須與 reply 完全相同。 */
export const signReply = (playerId, guest, reply) => createHmac('sha256', DREAM_SECRET).update(`${playerId}\n${guest}\n${reply}`, 'utf8').digest('base64url');

/** 從存檔字串算 summary（伺服器端的行為）。 */
export function summaryOf(data) {
  const o = JSON.parse(data);
  return {
    name: typeof o.player?.name === 'string' ? o.player.name.slice(0, 8) : null,
    map: o.location?.map ?? null,
    chapter: o.chapter ?? null,
    playtime_s: o.playtime_s ?? null,
    schema_version: o.schema_version ?? null,
  };
}

export function createMockCloud() {
  const players = []; // { id, token, code, saves: { [slot]: { version, updated_at, data|null } } }
  const log = [];
  /**
   * 下一個（或之後每個）符合的請求要怎麼失敗：{ match(req), action, once }。
   * action：'abort'｜'hang'（永不回應）｜{ status, body, headers }（固定回應）｜
   *         { delay: 毫秒 }（照常處理、伺服器狀態照常改變，但回應延遲送出——模擬「伺服器做完了，回應晚到」）。
   */
  const faults = [];
  let clock = 1_760_000_000;

  const tick = () => { clock += 60; return clock; };
  const byToken = (auth) => {
    const m = /^Bearer (.+)$/.exec(auth ?? '');
    return m ? players.find((p) => p.token === m[1]) ?? null : null;
  };
  const newToken = () => randomBytes(32).toString('base64url');
  const byCode = (n) => (n ? players.find((p) => normCode(p.code) === n) ?? null : null);

  // M4：夢境（通行證、對話額度）。passes：通行證字串 → { player, exp, revoked }
  const passes = new Map();
  // ttl：通行證有效秒數（修訂 1 B 預設 7200）；rejectChats：之後每個 chat 都回 401 pass_invalid（伺服器一直不認通行證）
  const dream = { quota: 20, used: 0, replies: [], ttl: 7200, rejectChats: false };

  const mock = {
    log,
    players,
    faults,
    dream,
    /** 讓目前所有通行證失效（之後的 chat 回 401 pass_invalid）。 */
    revokePasses() { for (const v of passes.values()) v.revoked = true; },
    /** 指定接下來 chat 的回覆（依序取用）：{ reply, source, reason, sig?（給了就用這個 sig，例如 null＝不帶） }。 */
    queueReply(r) { dream.replies.push(r); },
    /** 建一個玩家（測試準備用）；回傳 { player_id, token, transfer_code }。 */
    seedPlayer({ saves = {} } = {}) {
      const p = { id: `p-${++seq}`, token: newToken(), code: randomCode(), saves: {} };
      for (const [slot, { version, data }] of Object.entries(saves)) p.saves[slot] = { version, updated_at: tick(), data };
      players.push(p);
      return { player_id: p.id, token: p.token, transfer_code: p.code };
    },
    /** 模擬「別台裝置」直接改了雲端槽。 */
    serverWrite(token, slot, data) {
      const p = players.find((x) => x.token === token);
      const cur = p.saves[slot];
      p.saves[slot] = { version: (cur?.version ?? 0) + 1, updated_at: tick(), data };
      return p.saves[slot].version;
    },
    fail(match, action, { once = true } = {}) {
      faults.push({ match, action, once });
    },
    calls(pathRe, method) {
      return log.filter((l) => pathRe.test(l.path) && (!method || l.method === method));
    },
    async attach(target) {
      await target.route(`${MOCK_API}/**`, (route) => handle(route));
    },
  };

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/mock-api/, '');
    const method = req.method();
    const headers = req.headers();
    const origin = headers.origin ?? '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
      'Access-Control-Expose-Headers': 'ETag, Retry-After',
    };
    if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = '__bad__'; }
    const entry = { method, path, headers, body };
    log.push(entry);

    let delay = 0;
    const fi = faults.findIndex((f) => f.match({ method, path, body }));
    if (fi >= 0) {
      const f = faults[fi];
      if (f.once) faults.splice(fi, 1);
      entry.fault = f.action;
      if (f.action === 'abort') { await route.abort('connectionrefused'); return; }
      if (f.action === 'hang') return; // 永遠不回應（逾時）
      if (Number.isFinite(f.action?.delay)) {
        delay = f.action.delay;
      } else {
        await route.fulfill({
          status: f.action.status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', ...(f.action.headers ?? {}) },
          body: JSON.stringify(f.action.body ?? { error: 'internal', message: '伺服器發生錯誤' }),
        });
        return;
      }
    }

    const send = async (status, obj, extra = {}) => {
      if (delay > 0) await sleep(delay);
      try {
        await route.fulfill({
          status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', ...extra },
          body: obj === null ? '' : JSON.stringify(obj),
        });
      } catch {
        entry.dropped = true; // 頁面在回應前重新整理／關閉：回應送不到（伺服器端的狀態已經改了）
      }
    };
    const err = (status, error, message, extra = {}) => send(status, { error, message, ...extra });

    // 修訂 2 C：POST／PUT 的 Content-Type 必須是 application/json
    if ((method === 'POST' || method === 'PUT') && !/^application\/json\s*(;|$)/i.test(headers['content-type'] ?? '')) {
      await err(415, 'unsupported_media_type', '請求格式必須是 JSON');
      return;
    }

    if (method === 'POST' && path === '/api/player') {
      const code = normCode(body?.transfer_code);
      if (!TOKEN_RE.test(body?.token ?? '') || !code) { await err(400, 'bad_request', '欄位格式錯誤'); return; }
      const same = players.find((x) => x.token === body.token);
      if (same) { await send(200, { player_id: same.id }); return; } // 持有權杖即擁有帳號：重送安全（不需要 Turnstile）
      // M4：新建立需要 Turnstile（假小工具的 token）
      if (body?.turnstile_token !== FAKE_TS_TOKEN) { await err(403, 'turnstile_failed', '人機驗證失敗，請再試一次'); return; }
      if (byCode(code)) { await err(409, 'conflict', '轉移碼重複，請換一組'); return; }
      const p = { id: `p-${++seq}`, token: body.token, code: `${code.slice(0, 4)}-${code.slice(4)}`, saves: {} };
      players.push(p);
      await send(201, { player_id: p.id });
      return;
    }
    if (method === 'POST' && path === '/api/transfer') {
      const next = normCode(body?.new_transfer_code);
      if (!TOKEN_RE.test(body?.new_token ?? '') || !next) { await err(400, 'bad_request', '欄位格式錯誤'); return; }
      const p = byCode(normCode(body?.code));
      if (!p) { await err(404, 'not_found', '轉移碼不正確或已經失效。'); return; }
      if (players.some((x) => x.token === body.new_token)) { await err(409, 'conflict', '權杖重複'); return; }
      const clash = byCode(next);
      if (clash && clash !== p) { await err(409, 'conflict', '轉移碼重複'); return; }
      p.token = body.new_token; // 舊權杖與舊碼同時失效
      p.code = `${next.slice(0, 4)}-${next.slice(4)}`;
      await send(200, { player_id: p.id });
      return;
    }
    if (method === 'GET' && path === '/api/stats') { await send(200, { chapters: [], generated_at: clock }); return; }

    const p = byToken(headers.authorization);
    if (!p) { await err(401, 'unauthorized', '權杖無效'); return; }
    entry.player = p.id;

    if (method === 'POST' && path === '/api/dream/pass') {
      if (body?.turnstile_token !== FAKE_TS_TOKEN) { await err(403, 'turnstile_failed', '人機驗證失敗，請再試一次'); return; }
      const pass = `pass-${p.id}-${passes.size + 1}`;
      const exp = Math.floor(Date.now() / 1000) + dream.ttl;
      passes.set(pass, { player: p.id, exp, revoked: false });
      // API.md 鐘塔之夢補充（remaining_today）、修訂 1 B（ttl_s）
      await send(200, { pass, expires_at: exp, ttl_s: dream.ttl, remaining_today: Math.max(0, dream.quota - dream.used) });
      return;
    }
    if (method === 'POST' && path === '/api/dream/chat') {
      const ps = passes.get(body?.pass);
      if (dream.rejectChats || !ps || ps.revoked || ps.player !== p.id || ps.exp <= Date.now() / 1000) { await err(401, 'pass_invalid', '夢境通行證無效'); return; }
      const input = typeof body?.input === 'string' ? body.input.trim() : '';
      const okBody = /^[a-z0-9_]{1,32}$/.test(body?.guest ?? '') && /^[a-z0-9_]{1,32}$/.test(body?.chapter ?? '')
        && Array.isArray(body?.history) && body.history.length <= 6 && input.length >= 1 && [...input].length <= 120;
      if (!okBody) { await err(400, 'bad_request', '欄位格式錯誤'); return; }
      // 修訂 1 C：guest 項目必須帶正確的 sig，否則丟掉該則（不報錯）
      entry.acceptedHistory = body.history.filter((h) => h?.role !== 'guest' || (typeof h.sig === 'string' && h.sig === signReply(p.id, body.guest, h.text)));
      entry.droppedHistory = body.history.filter((h) => !entry.acceptedHistory.includes(h));
      const signed = (o, q) => ({ ...o, ...(q && Object.hasOwn(q, 'sig') ? (q.sig === null ? {} : { sig: q.sig }) : { sig: signReply(p.id, body.guest, o.reply) }) });
      if (dream.used >= dream.quota) {
        await send(200, signed({ reply: '夢境變得模糊了，今天先聊到這裡吧。', source: 'scripted', reason: 'quota', remaining_today: 0 }));
        return;
      }
      const q = dream.replies.shift();
      if (q && q.source === 'scripted') {
        await send(200, signed({ reply: q.reply, source: 'scripted', reason: q.reason ?? 'ai_error', remaining_today: dream.quota - dream.used }, q));
        return;
      }
      dream.used += 1;
      await send(200, signed({ reply: q?.reply ?? `「${input}」……我聽見了。`, source: 'ai', reason: null, remaining_today: dream.quota - dream.used }, q));
      return;
    }
    if (method === 'POST' && path === '/api/transfer/rotate') {
      const next = normCode(body?.new_transfer_code);
      if (!next) { await err(400, 'bad_request', '欄位格式錯誤'); return; }
      const clash = byCode(next);
      if (clash && clash !== p) { await err(409, 'conflict', '轉移碼重複'); return; }
      p.code = `${next.slice(0, 4)}-${next.slice(4)}`; // 已經是這個碼 → 照樣 200（重送安全）
      await send(200, {});
      return;
    }
    if (method === 'POST' && path === '/api/clear') {
      await send(200, { chapter: body.chapter, best_play_seconds: body.play_seconds });
      return;
    }
    if (method === 'GET' && path === '/api/saves') {
      const slots = [1, 2, 3].map((slot) => {
        const s = p.saves[slot];
        if (!s || s.data === null) return { slot, empty: true };
        return { slot, version: s.version, updated_at: s.updated_at, data_sha256: sha256(s.data), summary: summaryOf(s.data) };
      });
      await send(200, { slots });
      return;
    }
    const m = /^\/api\/save\/(\d+)$/.exec(path);
    if (m) {
      const slot = Number(m[1]);
      if (slot < 1 || slot > 3) { await err(400, 'bad_request', '存檔槽不合法'); return; }
      const cur = p.saves[slot];
      const filled = cur && cur.data !== null;
      if (method === 'GET') {
        if (!filled) { await err(404, 'not_found', '雲端槽是空的'); return; }
        await send(200, { slot, version: cur.version, updated_at: cur.updated_at, data: cur.data }, { ETag: `"${cur.version}"` });
        return;
      }
      if (method === 'PUT') {
        // 修訂 3：每格存檔上限 16 KB（UTF-8 位元組）
        if (typeof body?.data === 'string' && Buffer.byteLength(body.data, 'utf8') > 16 * 1024) {
          await err(413, 'too_large', '存檔太大'); return;
        }
        const ifMatch = headers['if-match'];
        const ifNone = headers['if-none-match'];
        const current = filled ? { version: cur.version, updated_at: cur.updated_at, data_sha256: sha256(cur.data), summary: summaryOf(cur.data) } : null;
        if (!ifMatch && ifNone !== '*') { await err(428, 'precondition_required', '缺少版本條件'); return; }
        if (ifMatch) {
          const v = Number(/(\d+)/.exec(ifMatch)?.[1]);
          if (!filled) { await err(404, 'not_found', '雲端槽是空的'); return; } // 補充 1
          if (v !== cur.version) { await err(409, 'conflict', '版本不符', { current }); return; }
        } else if (filled) {
          await err(409, 'conflict', '版本不符', { current });
          return;
        }
        // 補充 2：版本永不倒退（刪除後重建從原本的版本往上加）
        const version = (cur?.version ?? 0) + 1;
        p.saves[slot] = { version, updated_at: tick(), data: body.data };
        await send(200, { slot, version, updated_at: p.saves[slot].updated_at }, { ETag: `"${version}"` });
        return;
      }
      if (method === 'DELETE') {
        if (!filled) { await err(404, 'not_found', '雲端槽是空的'); return; }
        p.saves[slot] = { version: cur.version + 1, updated_at: tick(), data: null };
        await send(204, null);
        return;
      }
    }
    await err(404, 'not_found', '找不到');
  }

  return mock;
}
