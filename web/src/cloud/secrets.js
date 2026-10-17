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

/** 32 bytes 隨機 → base64url 43 字元。getRandomValues 可注入（測試用）。 */
export function randomToken(getRandomValues = defaultRandom) {
  const bytes = new Uint8Array(32);
  getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 8 碼轉移碼（拒絕取樣），顯示格式 XXXX-XXXX。 */
export function randomTransferCode(getRandomValues = defaultRandom) {
  const out = [];
  const buf = new Uint8Array(16);
  while (out.length < CODE_LENGTH) {
    getRandomValues(buf);
    for (const b of buf) {
      if (out.length >= CODE_LENGTH) break;
      if (b < SAMPLE_LIMIT) out.push(TRANSFER_ALPHABET[b % TRANSFER_ALPHABET.length]);
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4).join('')}`;
}

/** 字串 UTF-8 的 SHA-256 → 小寫 hex。 */
export async function sha256Hex(str) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const SHA256_RE = /^[0-9a-f]{64}$/;
