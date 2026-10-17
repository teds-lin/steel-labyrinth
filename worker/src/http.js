// HTTP 工具：錯誤格式、JSON 回應、CORS、限制大小的 body 讀取。

/** 請求 body 上限 24 KB（修訂 3：16 KB 存檔＋JSON 包裝）。 */
export const BODY_LIMIT = 24 * 1024;

/** 給玩家看的錯誤訊息（台灣繁體）。 */
export const MESSAGES = {
  bad_request: '請求格式不正確。',
  invalid_save: '存檔內容無法讀取，沒有上傳。',
  unauthorized: '雲端連結已失效，請重新用轉移碼接續。',
  not_found: '找不到資料。',
  transfer_not_found: '轉移碼不正確或已經失效。',
  conflict: '雲端的存檔已經被其他裝置更新。',
  secret_conflict: '這組轉移碼剛好和別人重複，請重試一次。',
  unsupported_media_type: '請求的資料格式不正確（必須是 JSON）。',
  forbidden_origin: '這個網站不能使用雲端存檔。',
  capacity: '雲端存檔目前額滿，請稍後再試。',
  too_large: '資料太大，無法上傳。',
  precondition_required: '缺少版本資訊，請重新整理後再試。',
  rate_limited: '操作太頻繁，請稍後再試。',
  internal: '雲端暫時無法使用，請稍後再試。',
};

/** 會被轉成錯誤回應的例外。extra 會併入 body（例如 409 的 current）。 */
export class HttpError extends Error {
  constructor(status, code, { message, extra, headers } = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.publicMessage = message ?? MESSAGES[code] ?? MESSAGES.internal;
    this.extra = extra;
    this.headers = headers;
  }
}

export const badRequest = () => new HttpError(400, 'bad_request');

const JSON_CT_RE = /^application\/json\s*(?:;.*)?$/i;

/** POST／PUT 的 Content-Type 必須是 application/json（可帶 charset 等參數），否則 415（修訂 2 C）。 */
export function requireJsonContentType(request) {
  if (!JSON_CT_RE.test((request.headers.get('content-type') ?? '').trim())) throw new HttpError(415, 'unsupported_media_type');
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': JSON_TYPE, ...headers } });
}

export function errorResponse(err) {
  return jsonResponse({ error: err.code, message: err.publicMessage, ...(err.extra ?? {}) }, err.status, err.headers ?? {});
}

export const internalError = () => errorResponse(new HttpError(500, 'internal'));

/**
 * 讀取 body 文字，最多 limit bytes。先看 content-length（超過就不讀），讀取時再實際計算位元組數，
 * 不信任 header。超過 → HttpError 413；content-length 不是數字 → 400。
 */
export async function readBodyText(request, limit = BODY_LIMIT) {
  const cl = request.headers.get('content-length');
  if (cl !== null) {
    if (!/^\d+$/.test(cl.trim())) throw badRequest();
    if (Number(cl) > limit) throw new HttpError(413, 'too_large');
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        reader.cancel().catch(() => {});
        throw new HttpError(413, 'too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

/** 讀取 JSON body；allowEmpty 時空 body 視為 {}。壞 JSON → 400。 */
export async function readJson(request, { allowEmpty = false } = {}) {
  const text = await readBodyText(request);
  if (text.trim() === '') {
    if (allowEmpty) return {};
    throw badRequest();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest();
  }
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- CORS ----------
const ALLOW_METHODS = 'GET, PUT, POST, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Authorization, Content-Type, If-Match, If-None-Match';
const EXPOSE_HEADERS = 'ETag, Retry-After';

/**
 * 檢查 Origin：沒有 Origin（非瀏覽器）→ { origin: null, forbidden: false }；
 * 在 ALLOWED_ORIGINS 裡 → { origin, forbidden: false }；其他（含字串 "null"）→ forbidden（修訂 2 C：403）。
 */
export function checkOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (origin === null) return { origin: null, forbidden: false };
  const list = String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? { origin, forbidden: false } : { origin: null, forbidden: true };
}

/** 在回應加上 CORS 標頭（來源在允許清單內才加）；一律加 Vary: Origin。 */
export function withCors(response, origin, { preflight = false } = {}) {
  const res = new Response(response.body, response);
  res.headers.append('Vary', 'Origin');
  if (origin) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
    if (preflight) {
      res.headers.set('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.headers.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.headers.set('Access-Control-Max-Age', '86400');
    }
  }
  return res;
}
