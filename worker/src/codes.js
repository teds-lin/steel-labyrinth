// 轉移碼、權杖、雜湊與常數時間比較（只用 Web Crypto，Worker 與 Node 都能跑）。

/** 轉移碼字元集：排除 0、O、1、I、L。 */
export const TRANSFER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TRANSFER_LENGTH = 8;
const ALPHABET_SET = new Set(TRANSFER_ALPHABET);
// 拒絕取樣：只接受 < 248（31 的倍數）的位元組，避免 % 31 的偏差。
const SAMPLE_LIMIT = 256 - (256 % TRANSFER_ALPHABET.length);

/** 產生 XXXX-XXXX 格式的轉移碼。 */
export function generateTransferCode() {
  const out = [];
  const buf = new Uint8Array(16);
  while (out.length < TRANSFER_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < SAMPLE_LIMIT && out.length < TRANSFER_LENGTH) out.push(TRANSFER_ALPHABET[b % TRANSFER_ALPHABET.length]);
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4).join('')}`;
}

/** 正規化轉移碼：去掉空白與連字號、轉大寫；不是 8 個合法字元就回 null。 */
export function normalizeTransferCode(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.replace(/[\s-]+/g, '').toUpperCase();
  if (s.length !== TRANSFER_LENGTH) return null;
  for (const c of s) if (!ALPHABET_SET.has(c)) return null;
  return s;
}

/** 32 bytes 隨機權杖 → base64url（43 字元、無補位）。 */
export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 → 小寫十六進位。 */
export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常數時間比較兩個十六進位字串（長度不同直接回 false；長度不是秘密）。 */
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 轉移碼雜湊：SHA-256(pepper＋正規化碼)。 */
export const transferHash = (pepper, normalized) => sha256Hex(`${pepper}${normalized}`);

/**
 * IP 限流 key：SHA-256(每日鹽＋IP)；每日鹽由 pepper 與 UTC 日期導出，所以隔天就無法和前一天的 key 連結，
 * 而且資料庫裡永遠沒有原始 IP。nowSec：Unix 秒。
 */
export async function ipBucketKey(pepper, ip, nowSec) {
  const day = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const salt = await sha256Hex(`ip-salt:${pepper}:${day}`);
  return sha256Hex(`${salt}:${ip}`);
}
