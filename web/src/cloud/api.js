// 雲端 API 包裝（docs/API.md）：每個端點一個方法，永遠不丟例外。
// 回傳：{ ok:true, status, body, etag } 或 { ok:false, kind:'network'|'timeout'|'http', status, error, retryAfter, body }。
// - kind 'network'：fetch 失敗（離線、DNS、CORS 被擋）；'timeout'：超過 timeoutMs（含讀取 body）；'http'：伺服器回非 2xx。
// - error：伺服器 body 的 error 錯誤碼；沒有時為 http_<status>／network／timeout；不合法的 slot 為 invalid_slot（不送請求）。

export const DEFAULT_TIMEOUT_MS = 5000;
/** 夢客對話要等 AI 生成（最多重試一次），逾時放寬。 */
export const DREAM_CHAT_TIMEOUT_MS = 20000;
const SLOT_COUNT = 3;

const validSlot = (s) => Number.isInteger(s) && s >= 1 && s <= SLOT_COUNT;

/** Retry-After：秒數或 HTTP 日期 → 非負整數秒；無法解析回 null。 */
export function parseRetryAfter(raw, now = Date.now()) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const s = raw.trim();
  if (/^\d{1,9}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 1000));
}

const fail = (kind, status, error, extra = {}) => ({ ok: false, kind, status, error, retryAfter: null, body: null, ...extra });

export function createCloudApi({ baseUrl, fetch: fetchFn, getToken = () => null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  const token = () => {
    try {
      const t = getToken?.();
      return typeof t === 'string' && t !== '' ? t : null;
    } catch {
      return null;
    }
  };

  /**
   * 送出請求並整理結果。opts：{ method, body, auth, headers, token }。
   * token：指定這次要用的權杖（轉移／建立玩家逾時後，用待確認的新權杖確認結果）；未指定時用 getToken()。
   * 修訂 2 C：所有 POST／PUT 一律帶 body 與 Content-Type: application/json（否則伺服器回 415）。
   */
  async function request(path, { method = 'GET', body, auth = true, headers = {}, token: override, timeout: wait } = {}) {
    if (typeof fetchFn !== 'function' || base === '') return fail('network', 0, 'network');
    const h = { ...headers };
    if (body === undefined && (method === 'POST' || method === 'PUT')) body = {};
    if (body !== undefined) h['Content-Type'] = 'application/json; charset=utf-8';
    if (auth) {
      const t = typeof override === 'string' && override !== '' ? override : token();
      if (t) h.Authorization = `Bearer ${t}`;
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        try { ctrl?.abort(); } catch { /* 忽略 */ }
        resolve(fail('timeout', 0, 'timeout'));
      }, Number.isFinite(wait) && wait > 0 ? wait : limit);
    });
    const run = (async () => {
      let res;
      try {
        const init = { method, headers: h, signal: ctrl?.signal };
        if (body !== undefined) init.body = JSON.stringify(body);
        res = await fetchFn(`${base}${path}`, init);
      } catch (e) {
        if (e?.name === 'AbortError') return fail('timeout', 0, 'timeout');
        return fail('network', 0, 'network');
      }
      let text;
      try {
        text = await res.text();
      } catch (e) {
        if (e?.name === 'AbortError') return fail('timeout', 0, 'timeout');
        return fail('network', 0, 'network');
      }
      let parsed = null;
      if (typeof text === 'string' && text !== '') {
        try { parsed = JSON.parse(text); } catch { parsed = null; }
      }
      const status = Number(res?.status) || 0;
      const header = (k) => {
        try { return res.headers?.get?.(k) ?? null; } catch { return null; }
      };
      if (status >= 200 && status < 300) return { ok: true, status, body: parsed, etag: header('etag') };
      const code = parsed && typeof parsed.error === 'string' ? parsed.error : `http_${status}`;
      return fail('http', status, code, {
        retryAfter: parseRetryAfter(header('retry-after')),
        body: parsed && typeof parsed === 'object' ? parsed : null,
        message: parsed && typeof parsed.message === 'string' ? parsed.message : null,
      });
    })();
    try {
      return await Promise.race([run, timeout]);
    } catch {
      return fail('network', 0, 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  const slotGuard = (slot, fn) => (validSlot(slot) ? fn() : Promise.resolve(fail('http', 0, 'invalid_slot')));
  const versionHeaders = (version) => (Number.isInteger(version) && version >= 0
    ? { 'If-Match': `"${version}"` }
    : { 'If-None-Match': '*' });

  return {
    /** 修訂 2 A：權杖與轉移碼由客戶端產生後送出；回應只有 player_id。 */
    // M4：建立玩家需要 turnstile_token（action create_player）；冪等重送時不帶（伺服器認得權杖就直接 200）
    createPlayer: ({ token: t, transfer_code: code, turnstile_token: ts } = {}) => request('/api/player', {
      method: 'POST',
      body: typeof ts === 'string' && ts !== '' ? { token: t, transfer_code: code, turnstile_token: ts } : { token: t, transfer_code: code },
      auth: false,
    }),
    /** opts.token：用指定的權杖列表（確認待確認的權杖是否已生效）。 */
    listSaves: ({ token: t } = {}) => request('/api/saves', { token: t }),
    getSave: (slot) => slotGuard(slot, () => request(`/api/save/${slot}`)),
    /** version：本機記得的雲端版本（If-Match）；null／未提供時只在空槽建立（If-None-Match: *）。 */
    putSave: (slot, data, { version = null } = {}) => slotGuard(slot, () => request(`/api/save/${slot}`, {
      method: 'PUT', body: { data }, headers: versionHeaders(version),
    })),
    deleteSave: (slot, version) => slotGuard(slot, () => request(`/api/save/${slot}`, {
      method: 'DELETE', headers: { 'If-Match': `"${version}"` },
    })),
    /** 修訂 2 A：{ code, new_token, new_transfer_code }；回應只有 player_id。 */
    transfer: ({ code, new_token: nt, new_transfer_code: nc } = {}) => request('/api/transfer', {
      method: 'POST', body: { code, new_token: nt, new_transfer_code: nc }, auth: false,
    }),
    /** 修訂 2 A：新碼由客戶端產生；重送同一個碼是安全的。 */
    rotateTransfer: (newCode) => request('/api/transfer/rotate', { method: 'POST', body: { new_transfer_code: newCode } }),
    reportClear: (rec) => request('/api/clear', { method: 'POST', body: rec }),
    stats: () => request('/api/stats', { auth: false }),
    /** M4：用 Turnstile token（action dream_pass）換夢境通行證。 */
    dreamPass: (turnstileToken) => request('/api/dream/pass', { method: 'POST', body: { turnstile_token: turnstileToken } }),
    /** M4：和夢客說一句話：{ pass, guest, chapter, history, input }。 */
    dreamChat: ({ pass, guest, chapter, history, input } = {}) => request('/api/dream/chat', {
      method: 'POST', body: { pass, guest, chapter, history, input }, timeout: DREAM_CHAT_TIMEOUT_MS,
    }),
  };
}
