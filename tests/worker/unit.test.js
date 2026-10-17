// Worker 純函式單元測試（直接在 Node 跑，不需要 Miniflare）：轉移碼、權杖、雜湊、body 讀取上限、存檔摘要。
import { describe, it, expect } from 'vitest';
import {
  TRANSFER_ALPHABET, generateTransferCode, normalizeTransferCode, generateToken,
  sha256Hex, timingSafeEqualHex, ipBucketKey, ipBucketSource, isTokenFormat, isIpv6Source,
} from '../../worker/src/codes.js';
import { readBodyText, HttpError, BODY_LIMIT } from '../../worker/src/http.js';
import { buildSummary, DATA_LIMIT } from '../../worker/src/summary.js';
import { sampleSave, sampleState } from './helpers.js';
import { CURRENT_VERSION } from '../../web/src/core/save.js';

describe('轉移碼', () => {
  it('字元集排除 0、O、1、I、L，共 31 個字元', () => {
    expect(TRANSFER_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
    for (const c of '0O1IL') expect(TRANSFER_ALPHABET).not.toContain(c);
  });

  it('產生 XXXX-XXXX 格式，且大量產生也不會出現易混淆字元', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const code = generateTransferCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(2000); // 31^8 種，2000 個不該撞
  });

  it('字元分布大致均勻（拒絕取樣、沒有明顯偏差）', () => {
    const counts = Object.fromEntries([...TRANSFER_ALPHABET].map((c) => [c, 0]));
    const N = 4000;
    for (let i = 0; i < N; i++) for (const c of generateTransferCode().replace('-', '')) counts[c]++;
    const expected = (N * 8) / 31;
    for (const c of TRANSFER_ALPHABET) {
      expect(counts[c]).toBeGreaterThan(expected * 0.8);
      expect(counts[c]).toBeLessThan(expected * 1.2);
    }
  });

  it('正規化：大小寫、空白、連字號都容忍', () => {
    expect(normalizeTransferCode('ABCD-EFGH')).toBe('ABCDEFGH');
    expect(normalizeTransferCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeTransferCode('  ab cd\tef-gh \n')).toBe('ABCDEFGH');
    expect(normalizeTransferCode('A-B-C-D-E-F-G-H')).toBe('ABCDEFGH');
  });

  it('正規化：長度不對、含字元集以外的字元、非字串 → null', () => {
    for (const bad of ['ABCD-EFG', 'ABCD-EFGHJ', 'ABCD-EFG0', 'ABCD-EFGO', 'ABCD-EFGI', 'ABCD-EFGL', 'ABCD-EFG1',
      'ＡＢＣＤ-ＥＦＧＨ', "' OR 1=1 --", '', null, undefined, 12345678, {}, []]) {
      expect(normalizeTransferCode(bad)).toBeNull();
    }
  });
});

describe('修訂 2：客戶端秘密格式、零寬字元、IPv6 /64', () => {
  it('isTokenFormat：43 字元 base64url', () => {
    expect(isTokenFormat(generateToken())).toBe(true);
    expect(isTokenFormat('A'.repeat(43))).toBe(true);
    for (const bad of ['A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, `${'A'.repeat(42)}/`, `${'A'.repeat(42)}=`, ` ${'A'.repeat(42)}`, null, 43, undefined]) {
      expect(isTokenFormat(bad), String(bad)).toBe(false);
    }
  });

  it('正規化轉移碼時移除零寬與格式字元（Unicode Cf）', () => {
    expect(normalizeTransferCode('\u200bABCD\u200c-\u200dEFGH\u2060\ufeff')).toBe('ABCDEFGH');
    expect(normalizeTransferCode('AB\u00adCD-EFGH')).toBe('ABCDEFGH'); // 軟連字號也是 Cf
  });

  it('ipBucketSource(ip, 48)：IPv6 取前 48 位元（修訂 4）；IPv4 與對映位址照舊；isIpv6Source', () => {
    expect(ipBucketSource('2001:db8:77:1::1', 48)).toBe('2001:db8:77::/48');
    expect(ipBucketSource('2001:db8:77:ffff:1:2:3:4', 48)).toBe('2001:db8:77::/48');
    expect(ipBucketSource('2001:db8:78::1', 48)).not.toBe(ipBucketSource('2001:db8:77::1', 48));
    expect(ipBucketSource('203.0.113.7', 48)).toBe('203.0.113.7');
    expect(ipBucketSource('::ffff:198.51.100.9', 48)).toBe('198.51.100.9');
    expect(isIpv6Source('2001:db8::1')).toBe(true);
    expect(isIpv6Source('::1')).toBe(true);
    for (const x of ['203.0.113.7', '::ffff:198.51.100.9', 'unknown', '1:2:3']) expect(isIpv6Source(x), x).toBe(false);
  });

  it('ipBucketSource：IPv4 照舊；IPv6 取前 64 位元（/64）；IPv4 對映位址當 IPv4', () => {
    expect(ipBucketSource('203.0.113.7')).toBe('203.0.113.7');
    const a = ipBucketSource('2001:db8::1');
    expect(a).toBe('2001:db8:0:0::/64');
    for (const same of ['2001:db8::ffff', '2001:DB8:0:0:1:2:3:4', '2001:0db8:0000:0000::abcd', '2001:db8:0:0:ffff::']) {
      expect(ipBucketSource(same), same).toBe(a);
    }
    expect(ipBucketSource('2001:db8:0:1::1')).not.toBe(a);
    expect(ipBucketSource('::1')).toBe('0:0:0:0::/64');
    expect(ipBucketSource('::ffff:198.51.100.9')).toBe('198.51.100.9');
    expect(ipBucketSource('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    // 解析不了的字串原樣使用（不會讓請求失敗）
    expect(ipBucketSource('unknown')).toBe('unknown');
    expect(ipBucketSource('1:2:3')).toBe('1:2:3');
  });
});

describe('權杖與雜湊', () => {
  it('權杖是 32 bytes 的 base64url（43 字元、無補位）', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(t);
  });

  it('sha256Hex 與已知值相符', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('timingSafeEqualHex：相同為真，不同或長度不同為假', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
    expect(timingSafeEqualHex('abcd', null)).toBe(false);
  });

  it('IP 限流 key：只含雜湊、不含原始 IP；同一天相同、隔天不同、不同 pepper 不同', async () => {
    const a = await ipBucketKey('p', '203.0.113.7', 0);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('203.0.113.7');
    expect(await ipBucketKey('p', '203.0.113.7', 3600)).toBe(a);
    expect(await ipBucketKey('p', '203.0.113.7', 86400)).not.toBe(a);
    expect(await ipBucketKey('q', '203.0.113.7', 0)).not.toBe(a);
    expect(await ipBucketKey('p', '203.0.113.8', 0)).not.toBe(a);
  });
});

describe('readBodyText：不信任 content-length', () => {
  const streamOf = (bytes, chunk = 1000) => new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes; i += chunk) c.enqueue(new Uint8Array(Math.min(chunk, bytes - i)).fill(97));
      c.close();
    },
  });
  const fakeReq = (headers, body) => ({ headers: new Headers(headers), body });

  it('上限是 24 KB（修訂 3）', () => expect(BODY_LIMIT).toBe(24 * 1024));

  it('content-length 超過上限就直接 413，不讀 body', async () => {
    let pulled = false;
    const body = new ReadableStream({ pull() { pulled = true; } }, { highWaterMark: 0 });
    await expect(readBodyText(fakeReq({ 'content-length': String(BODY_LIMIT + 1) }, body), BODY_LIMIT))
      .rejects.toMatchObject({ status: 413, code: 'too_large' });
    expect(pulled).toBe(false);
  });

  it('content-length 說謊（宣稱 10 bytes、實際 200 KB）→ 讀取時仍限制並 413', async () => {
    await expect(readBodyText(fakeReq({ 'content-length': '10' }, streamOf(200 * 1024)), BODY_LIMIT))
      .rejects.toBeInstanceOf(HttpError);
    await expect(readBodyText(fakeReq({ 'content-length': '10' }, streamOf(200 * 1024)), BODY_LIMIT))
      .rejects.toMatchObject({ status: 413 });
  });

  it('沒有 content-length（chunked）且超過上限 → 413', async () => {
    await expect(readBodyText(fakeReq({}, streamOf(BODY_LIMIT + 1)), BODY_LIMIT)).rejects.toMatchObject({ status: 413 });
  });

  it('剛好在上限內 → 正常回傳文字（UTF-8 多位元組字元不會被切壞）', async () => {
    const text = '鋼'.repeat(1000);
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 1)); c.enqueue(bytes.slice(1)); c.close(); } });
    expect(await readBodyText(fakeReq({}, body), BODY_LIMIT)).toBe(text);
    expect(await readBodyText(fakeReq({}, streamOf(BODY_LIMIT)), BODY_LIMIT)).toHaveLength(BODY_LIMIT);
    expect(await readBodyText(fakeReq({}, null), BODY_LIMIT)).toBe('');
  });

  it('content-length 不是數字 → 400', async () => {
    await expect(readBodyText(fakeReq({ 'content-length': 'abc' }, streamOf(5)), BODY_LIMIT))
      .rejects.toMatchObject({ status: 400, code: 'bad_request' });
  });
});

describe('buildSummary：用共用的 deserialize 驗證並算出摘要', () => {
  it('存檔內容上限 16 KB（修訂 3）', () => expect(DATA_LIMIT).toBe(16 * 1024));

  it('正常存檔 → 摘要五個欄位', () => {
    const r = buildSummary(sampleSave());
    expect(r).toEqual({ ok: true, summary: { name: '雷恩', map: 'prologue_hall', chapter: 'chapter1', playtime_s: 120, schema_version: CURRENT_VERSION } });
  });

  it('名字最多 8 字（以字素計）', () => {
    const r = buildSummary(sampleSave({ player: { name: '一二三四五六七八九十' } }));
    expect(r.summary.name).toBe('一二三四五六七八');
  });

  it('壞 JSON、缺欄位、型別錯誤 → 不通過', () => {
    expect(buildSummary('{').ok).toBe(false);
    expect(buildSummary('[]').ok).toBe(false);
    const { party, ...noParty } = sampleState();
    expect(buildSummary(JSON.stringify({ ...noParty, schema_version: 2 })).ok).toBe(false);
    expect(buildSummary(JSON.stringify({ ...sampleState(), collapse: 101, schema_version: 2 })).ok).toBe(false);
  });

  it('版本較新的存檔照樣接受，摘要盡量取得', () => {
    const r = buildSummary(JSON.stringify({ ...sampleState(), schema_version: 7, newField: 1 }));
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ name: '雷恩', map: 'prologue_hall', chapter: 'chapter1', playtime_s: 120, schema_version: 7 });
  });

  it('版本較新但 schema_version > CURRENT_VERSION＋5 → 不通過（修訂 2 F）', () => {
    expect(buildSummary(JSON.stringify({ ...sampleState(), schema_version: CURRENT_VERSION + 6 })).ok).toBe(false);
    expect(buildSummary(JSON.stringify({ schema_version: 1e300 })).ok).toBe(false);
    expect(buildSummary(JSON.stringify({ schema_version: Number.MAX_SAFE_INTEGER })).ok).toBe(false);
  });

  it('map／chapter 必須符合 [a-z0-9_]{1,32}，否則摘要為 null（修訂 2 F）', () => {
    const bad = ['M'.repeat(33), 'Hall', '<img>', '大廳', '', 'a-b'];
    for (const v of bad) {
      expect(buildSummary(sampleSave({ location: { map: v, x: 0, y: 0, dir: 'down' }, chapter: v })).summary, v)
        .toMatchObject({ map: null, chapter: null });
      expect(buildSummary(JSON.stringify({ schema_version: CURRENT_VERSION + 1, location: { map: v }, chapter: v })).summary, v)
        .toMatchObject({ map: null, chapter: null });
    }
    expect(buildSummary(sampleSave({ chapter: null })).summary.chapter).toBeNull();
  });

  it('版本較新但欄位格式怪異 → 仍接受，摘要欄位改成 null', () => {
    const r = buildSummary(JSON.stringify({ schema_version: CURRENT_VERSION + 1, player: 5, location: { map: 7 }, chapter: [], playtime_s: 'x' }));
    expect(r.ok).toBe(true);
    expect(r.summary).toEqual({ name: null, map: null, chapter: null, playtime_s: null, schema_version: CURRENT_VERSION + 1 });
  });

  it('舊版（v1）存檔透過遷移通過驗證，摘要的 schema_version 是原始版本', () => {
    const { party, ammo, pending, ...v1 } = sampleState();
    const r = buildSummary(JSON.stringify({ ...v1, schema_version: 1 }));
    expect(r.ok).toBe(true);
    expect(r.summary.schema_version).toBe(1);
  });
});
