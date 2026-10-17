// E2E 用的假雲端 API（照 docs/API.md 與「補充（2026-10-17）」的回應格式），以 Playwright 的 route 攔截。
// 同一個 mock 可以掛在多個 browser context 上（模擬兩台裝置共用同一個伺服器）。
// 位址用 127.0.0.1（跨來源）：順便驗證 CORS 標頭（ETag、Retry-After 要 expose 才讀得到）。

export const MOCK_API = 'http://127.0.0.1:9/mock-api';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let seq = 0;
const randomCode = () => {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
const normCode = (c) => String(c ?? '').toUpperCase().replace(/[\s-]/g, '');

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
  /** 下一個（或之後每個）符合的請求要怎麼失敗：{ match(req) , action:'abort'|'hang'|{status, body, headers}, once } */
  const faults = [];
  let clock = 1_760_000_000;

  const tick = () => { clock += 60; return clock; };
  const byToken = (auth) => {
    const m = /^Bearer (.+)$/.exec(auth ?? '');
    return m ? players.find((p) => p.token === m[1]) ?? null : null;
  };
  const newToken = () => `tok-${++seq}-${Math.random().toString(36).slice(2)}`;

  const mock = {
    log,
    players,
    faults,
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

    const fi = faults.findIndex((f) => f.match({ method, path }));
    if (fi >= 0) {
      const f = faults[fi];
      if (f.once) faults.splice(fi, 1);
      entry.fault = f.action;
      if (f.action === 'abort') { await route.abort('connectionrefused'); return; }
      if (f.action === 'hang') return; // 永遠不回應（逾時）
      await route.fulfill({
        status: f.action.status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', ...(f.action.headers ?? {}) },
        body: JSON.stringify(f.action.body ?? { error: 'internal', message: '伺服器發生錯誤' }),
      });
      return;
    }

    const send = (status, obj, extra = {}) => route.fulfill({
      status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', ...extra },
      body: obj === null ? '' : JSON.stringify(obj),
    });
    const err = (status, error, message, extra = {}) => send(status, { error, message, ...extra });

    if (method === 'POST' && path === '/api/player') {
      const p = mock.seedPlayer();
      await send(201, p);
      return;
    }
    if (method === 'POST' && path === '/api/transfer') {
      const p = players.find((x) => normCode(x.code) === normCode(body?.code));
      if (!p) { await err(404, 'not_found', '轉移碼不正確或已經失效。'); return; }
      p.token = newToken(); // 舊權杖同時失效
      p.code = randomCode();
      await send(200, { player_id: p.id, token: p.token, transfer_code: p.code });
      return;
    }
    if (method === 'GET' && path === '/api/stats') { await send(200, { chapters: [], generated_at: clock }); return; }

    const p = byToken(headers.authorization);
    if (!p) { await err(401, 'unauthorized', '權杖無效'); return; }
    entry.player = p.id;

    if (method === 'POST' && path === '/api/transfer/rotate') {
      p.code = randomCode();
      await send(200, { transfer_code: p.code });
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
        return { slot, version: s.version, updated_at: s.updated_at, summary: summaryOf(s.data) };
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
        const ifMatch = headers['if-match'];
        const ifNone = headers['if-none-match'];
        const current = filled ? { version: cur.version, updated_at: cur.updated_at, summary: summaryOf(cur.data) } : null;
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
