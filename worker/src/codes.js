// 轉移碼、權杖、雜湊與常數時間比較（只用 Web Crypto，Worker 與 Node 都能跑）。
import { isLowEntropyToken, isLowEntropyTransferCode, randomToken, randomTransferCode } from '../../web/src/cloud/secrets.js';

/** 轉移碼字元集：排除 0、O、1、I、L。 */
export const TRANSFER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const TRANSFER_LENGTH = 8;
const ALPHABET_SET = new Set(TRANSFER_ALPHABET);

/** 正規化轉移碼：去掉空白、連字號與零寬／格式字元（Unicode Cf）、轉大寫；不是 8 個合法字元就回 null。 */
export function normalizeTransferCode(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.replace(/[\s\p{Cf}-]+/gu, '').toUpperCase();
  if (s.length !== TRANSFER_LENGTH) return null;
  for (const c of s) if (!ALPHABET_SET.has(c)) return null;
  return s;
}

/** 權杖格式：43 字元 base64url（32 bytes、無補位）。 */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isTokenFormat = (v) => typeof v === 'string' && TOKEN_RE.test(v);

/**
 * 修訂 4 第 5 節：低熵秘密一律 400（權杖不同字元少於 16 種；轉移碼同一字元出現 4 次以上）。
 * 判斷與產生器直接用客戶端的 web/src/cloud/secrets.js（同一份程式），官方客戶端產生的秘密不可能被誤殺。
 */
export const isAcceptableToken = (t) => isTokenFormat(t) && !isLowEntropyToken(t);
/** normalized：normalizeTransferCode 的結果（8 碼、無連字號）。 */
export const isAcceptableTransferCode = (normalized) => typeof normalized === 'string' && !isLowEntropyTransferCode(normalized);

/** 測試與工具用的產生器（和客戶端是同一份）。 */
export const generateToken = () => randomToken();
export const generateTransferCode = () => randomTransferCode();

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
 * 限流用的來源字串：IPv4 照舊用整個位址；IPv6 只取前 prefix 位元（64 或 48；一個 /64 通常屬於同一個用戶，
 * 換位址不能繞過限制；修訂 4 另以 /48 限制）；IPv4 對映位址（::ffff:a.b.c.d）當作 IPv4。解析不了就原樣使用。
 */
export function ipBucketSource(ip, prefix = 64) {
  if (typeof ip !== 'string' || !ip.includes(':')) return ip;
  let s = ip.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const halves = s.split('::');
  if (halves.length > 2) return ip;
  const part = (h) => (h === '' ? [] : h.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const last = halves.length === 2 ? tail : head;
  let v4 = null;
  if (last.length && last[last.length - 1].includes('.')) {
    // 尾端內嵌 IPv4（例如 ::ffff:198.51.100.9）：換成兩組 16 位元
    v4 = last[last.length - 1];
    const o = v4.split('.').map(Number);
    if (o.length !== 4 || !o.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return ip;
    last.splice(-1, 1, ((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16));
  }
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return ip;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip;
  const n = groups.map((g) => parseInt(g, 16));
  if (v4 && n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return v4; // IPv4 對映位址
  const groupsKept = prefix === 48 ? 3 : 4;
  return `${n.slice(0, groupsKept).map((x) => x.toString(16)).join(':')}::/${groupsKept * 16}`;
}

/**
 * IP 限流 key：SHA-256(每日鹽＋IP)；每日鹽由 pepper 與 UTC 日期導出，所以隔天就無法和前一天的 key 連結，
 * 而且資料庫裡永遠沒有原始 IP。nowSec：Unix 秒。
 */
export async function ipBucketKey(pepper, ip, nowSec, prefix = 64) {
  const day = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const salt = await sha256Hex(`ip-salt:${pepper}:${day}`);
  return sha256Hex(`${salt}:${ipBucketSource(ip, prefix)}`);
}

/** 是不是可解析的 IPv6 位址（IPv4 對映位址不算）：只有 IPv6 才多一層 /48 限制。 */
export const isIpv6Source = (ip) => /::\/64$/.test(String(ipBucketSource(ip)));
