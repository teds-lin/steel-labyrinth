// 客戶端產生的秘密（docs/API.md 修訂 2 A 節）：權杖、轉移碼由客戶端用 crypto.getRandomValues 產生，
// 伺服器只驗證格式並存雜湊——請求逾時也不會遺失秘密。另提供 SHA-256（修訂 2 B 節的 data_sha256）。
// 純函式，不碰 DOM；Node 22 與瀏覽器都有 globalThis.crypto。

export const TRANSFER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
// 拒絕取樣：只接受 < 248（31 的倍數）的位元組，避免 % 31 偏向前面的字元。
const SAMPLE_LIMIT = 256 - (256 % TRANSFER_ALPHABET.length);

/** 43 字元 base64url（32 bytes、無補位）。 */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isToken = (v) => typeof v === 'string' && TOKEN_RE.test(v);

const defaultRandom = (arr) => globalThis.crypto.getRandomValues(arr);

// 修訂 4 第 5 節：伺服器拒絕低熵秘密（權杖不同字元少於 16 種；轉移碼同一字元出現 4 次以上）。
// 客戶端產生時用同一套判斷重抽，保證官方客戶端產生的秘密永遠不會被伺服器誤殺（Worker 的 codes.js 匯入這兩個函式）。
export const TOKEN_MIN_DISTINCT = 16;
export const CODE_MAX_REPEAT = 3;
/** 權杖中不同字元少於 16 種 → 低熵。 */
export const isLowEntropyToken = (t) => typeof t !== 'string' || new Set(t).size < TOKEN_MIN_DISTINCT;
/** 轉移碼（可含連字號）中同一字元出現 4 次以上 → 低熵。 */
export function isLowEntropyTransferCode(code) {
  if (typeof code !== 'string') return true;
  const count = new Map();
  for (const ch of code.replace(/-/g, '')) {
    const n = (count.get(ch) ?? 0) + 1;
    if (n > CODE_MAX_REPEAT) return true;
    count.set(ch, n);
  }
  return false;
}
// 正常亂數下重抽的機率：權杖約 1e-9 以下、轉移碼約 0.24%；連抽 64 次都不合格只可能是亂數來源壞掉。
const MAX_DRAWS = 64;
const brokenRandom = () => new Error('亂數來源異常，無法產生秘密');

/** 32 bytes → base64url 43 字元（無補位）。 */
export function encodeToken(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 bytes 隨機 → base64url 43 字元；低熵就重抽。getRandomValues 可注入（測試用）。 */
export function randomToken(getRandomValues = defaultRandom) {
  for (let i = 0; i < MAX_DRAWS; i++) {
    const bytes = new Uint8Array(32);
    getRandomValues(bytes);
    const t = encodeToken(bytes);
    if (!isLowEntropyToken(t)) return t;
  }
  throw brokenRandom();
}

function drawTransferCode(getRandomValues) {
  const out = [];
  const buf = new Uint8Array(16);
  for (let guard = 0; out.length < CODE_LENGTH; guard++) {
    if (guard >= MAX_DRAWS) throw brokenRandom();
    getRandomValues(buf);
    for (const b of buf) {
      if (out.length >= CODE_LENGTH) break;
      if (b < SAMPLE_LIMIT) out.push(TRANSFER_ALPHABET[b % TRANSFER_ALPHABET.length]);
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4).join('')}`;
}

/** 8 碼轉移碼（拒絕取樣），顯示格式 XXXX-XXXX；同一字元出現 4 次以上就重抽。 */
export function randomTransferCode(getRandomValues = defaultRandom) {
  for (let i = 0; i < MAX_DRAWS; i++) {
    const c = drawTransferCode(getRandomValues);
    if (!isLowEntropyTransferCode(c)) return c;
  }
  throw brokenRandom();
}

/** 字串 UTF-8 的 SHA-256 → 小寫 hex。 */
export async function sha256Hex(str) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const SHA256_RE = /^[0-9a-f]{64}$/;
