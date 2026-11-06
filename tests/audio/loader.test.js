// 音檔載入（M6）：自己 fetch＋decodeAudioData（不用 Phaser Loader）。解碼失敗或 404／415 才退下一個格式；網路層失敗立即斷路。
import { describe, it, expect } from 'vitest';
import { loadFirstDecodable, decodeCompat } from '../../web/src/audio/loader.js';

/** 假 fetch：urls → { status, body }；記錄呼叫順序。 */
function fakeFetch(table) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = table[url];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: r.status === 200, status: r.status, arrayBuffer: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

const buf = (tag) => ({ tag });

describe('loadFirstDecodable', () => {
  it('第一個網址成功就不再抓第二個', async () => {
    const f = fakeFetch({ 'a.ogg': { status: 200, body: 'OGG' } });
    const decode = async (ab) => buf(ab);
    const r = await loadFirstDecodable(['a.ogg', 'a.m4a'], { fetch: f, decode });
    expect(r).toEqual({ buffer: buf('OGG'), url: 'a.ogg' });
    expect(f.calls).toEqual(['a.ogg']);
  });
  it('ogg 解碼失敗 → 改抓 m4a 重試一次', async () => {
    const f = fakeFetch({ 'a.ogg': { status: 200, body: 'OGG' }, 'a.m4a': { status: 200, body: 'M4A' } });
    const decode = async (ab) => { if (ab === 'OGG') throw new Error('EncodingError'); return buf(ab); };
    const r = await loadFirstDecodable(['a.ogg', 'a.m4a'], { fetch: f, decode });
    expect(r.url).toBe('a.m4a');
    expect(f.calls).toEqual(['a.ogg', 'a.m4a']);
  });
  it('HTTP 404／415 換下一個格式；全部失敗 → reject，訊息列出每個網址的原因，每個網址只試一次', async () => {
    const f = fakeFetch({ 'a.m4a': { status: 415, body: 'x' } });
    const decode = async () => buf('x');
    await expect(loadFirstDecodable(['a.ogg', 'a.m4a'], { fetch: f, decode })).rejects.toThrow(/a\.ogg.*404[\s\S]*a\.m4a.*415/);
    expect(f.calls).toEqual(['a.ogg', 'a.m4a']);
  });
  it('其他 HTTP 錯誤（例如 500）不換格式：直接 reject（伺服器壞了，換格式也沒用）', async () => {
    const f = fakeFetch({ 'a.ogg': { status: 500, body: 'x' }, 'a.m4a': { status: 200, body: 'M4A' } });
    const err = await loadFirstDecodable(['a.ogg', 'a.m4a'], { fetch: f, decode: async (ab) => buf(ab) }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.network).toBeFalsy();
    expect(f.calls).toEqual(['a.ogg']);
  });
  it('網路層失敗（fetch reject）：第一次就斷路，標記 network，不再試下一個格式', async () => {
    const f = fakeFetch({ 'a.ogg': new TypeError('Failed to fetch'), 'a.m4a': { status: 200, body: 'M4A' } });
    const err = await loadFirstDecodable(['a.ogg', 'a.m4a'], { fetch: f, decode: async (ab) => buf(ab) }).catch((e) => e);
    expect(err.network).toBe(true);
    expect(err.message).toMatch(/Failed to fetch/);
    expect(f.calls).toEqual(['a.ogg']);
  });
  it('沒有網址 → reject', async () => {
    await expect(loadFirstDecodable([], { fetch: fakeFetch({}), decode: async () => 1 })).rejects.toThrow();
  });
});

describe('decodeCompat：同時支援 Promise 與回呼兩種 decodeAudioData', () => {
  it('Promise 版本', async () => {
    const ctx = { decodeAudioData: (ab) => Promise.resolve(buf(ab)) };
    expect(await decodeCompat(ctx, 'X')).toEqual(buf('X'));
  });
  it('只有回呼（舊版 Safari）', async () => {
    const ctx = { decodeAudioData: (ab, ok) => { setTimeout(() => ok(buf(ab)), 0); return undefined; } };
    expect(await decodeCompat(ctx, 'Y')).toEqual(buf('Y'));
  });
  it('回呼錯誤或同步丟錯都變成 reject', async () => {
    const a = { decodeAudioData: (_ab, _ok, bad) => { setTimeout(() => bad(new Error('bad')), 0); } };
    await expect(decodeCompat(a, 'Z')).rejects.toThrow('bad');
    const b = { decodeAudioData: () => { throw new Error('sync'); } };
    await expect(decodeCompat(b, 'Z')).rejects.toThrow('sync');
  });
});
