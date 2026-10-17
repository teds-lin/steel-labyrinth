// 客戶端產生的秘密（web/src/cloud/secrets.js，API.md 修訂 2 A 節）：權杖、轉移碼、SHA-256。
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  randomToken, randomTransferCode, isToken, sha256Hex, TOKEN_RE,
} from '../../web/src/cloud/secrets.js';
import { TRANSFER_ALPHABET, normalizeTransferCode } from '../../web/src/cloud/sync.js';

/** 依序吐出指定位元組的假 getRandomValues（用完就從頭再來）。 */
function scripted(bytes) {
  let i = 0;
  const calls = [];
  const fn = (arr) => {
    calls.push(arr.length);
    for (let k = 0; k < arr.length; k++) arr[k] = bytes[i++ % bytes.length];
    return arr;
  };
  fn.calls = calls;
  return fn;
}

describe('randomToken', () => {
  it('32 bytes → base64url 43 字元（無 = 填充）', () => {
    for (let n = 0; n < 200; n++) {
      const t = randomToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isToken(t)).toBe(true);
    }
  });
  it('用 getRandomValues 取 32 bytes，且編碼正確', () => {
    const bytes = Array.from({ length: 32 }, (_, i) => (i * 37 + 251) & 0xff);
    const rv = scripted(bytes);
    const t = randomToken(rv);
    expect(rv.calls).toEqual([32]);
    expect(t).toBe(Buffer.from(bytes).toString('base64url'));
  });
  it('全 0xff 也不會出現 + / =', () => {
    const t = randomToken(scripted([0xff]));
    expect(t).toBe(`${'_'.repeat(42)}8`);
  });
  it('每次都不同', () => {
    const set = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(set.size).toBe(100);
  });
});

describe('isToken（本機雲端資訊驗證，修訂 2 G 節）', () => {
  it('43 字元 base64url 才算', () => {
    expect(isToken('A'.repeat(43))).toBe(true);
    expect(isToken('-_'.repeat(21) + 'a')).toBe(true);
    for (const bad of ['', 'tok', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, `${'A'.repeat(42)}+`, `${'A'.repeat(42)}\n`, null, 43, undefined]) {
      expect(isToken(bad), String(bad)).toBe(false);
    }
    expect(TOKEN_RE.test('A'.repeat(43))).toBe(true);
  });
});

describe('randomTransferCode', () => {
  it('8 碼、只用 ABCDEFGHJKMNPQRSTUVWXYZ23456789、顯示成 XXXX-XXXX', () => {
    for (let n = 0; n < 500; n++) {
      const c = randomTransferCode();
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
      expect(normalizeTransferCode(c)).toBe(c.replace('-', ''));
      for (const ch of c.replace('-', '')) expect(TRANSFER_ALPHABET).toContain(ch);
    }
  });
  it('拒絕取樣：≥ 248（31×8）的位元組丟掉不用，不會偏向前面的字元', () => {
    // 248～255 全部要被丟棄；0→A、30→9、31→A（31 % 31）、247→247 % 31 = 30 → 9
    const rv = scripted([255, 248, 0, 250, 30, 31, 247, 252, 1, 2, 3, 4]);
    expect(randomTransferCode(rv)).toBe('A9A9-BCDE');
  });
  it('字元分布大致均勻（每個字元都會出現，沒有字元被系統性偏好）', () => {
    const count = new Map();
    const N = 4000;
    for (let n = 0; n < N; n++) for (const ch of randomTransferCode().replace('-', '')) count.set(ch, (count.get(ch) ?? 0) + 1);
    expect(count.size).toBe(31);
    const expected = (N * 8) / 31;
    for (const [ch, k] of count) expect(Math.abs(k - expected) / expected, ch).toBeLessThan(0.2);
  });
});

describe('sha256Hex', () => {
  it('UTF-8 的 SHA-256，小寫 hex（與 node:crypto 一致，含中文）', async () => {
    for (const s of ['', 'abc', '{"player":{"name":"艾琳"}}', '😀 雲端']) {
      expect(await sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
});
