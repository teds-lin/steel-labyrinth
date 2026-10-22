// 流量統計（Cloudflare Web Analytics）：只在正式網站載入，本機與 ?test=1 一律不載入。
import { describe, it, expect, beforeAll } from 'vitest';

let an;
beforeAll(async () => {
  globalThis.window ??= { location: { search: '', hostname: 'localhost' }, devicePixelRatio: 1 };
  an = await import('../../web/src/analytics.js');
});

const loc = (hostname, search = '') => ({ hostname, search });

describe('shouldLoadAnalytics', () => {
  it('正式網站載入', () => {
    expect(an.shouldLoadAnalytics(loc('teds-lin.github.io'))).toBe(true);
  });
  it('測試模式不載入', () => {
    expect(an.shouldLoadAnalytics(loc('teds-lin.github.io', '?test=1'))).toBe(false);
    expect(an.shouldLoadAnalytics(loc('teds-lin.github.io', '?a=1&test=1'))).toBe(false);
  });
  it('本機與其他網域不載入', () => {
    for (const h of ['localhost', '127.0.0.1', '', 'example.com', 'evil-teds-lin.github.io']) {
      expect(an.shouldLoadAnalytics(loc(h))).toBe(false);
    }
  });
});

describe('beaconAttrs', () => {
  it('官方 beacon 網址與 token', () => {
    const a = an.beaconAttrs();
    expect(a.src).toBe('https://static.cloudflareinsights.com/beacon.min.js');
    expect(JSON.parse(a.beacon)).toEqual({ token: '627408e0a6d24f15b16fe0acea4cafd7' });
  });
});

describe('loadAnalytics', () => {
  const fakeDoc = () => {
    const added = [];
    return {
      added,
      createElement: () => ({ setAttribute(k, v) { this[k] = v; } }),
      head: { appendChild: (el) => added.push(el) },
    };
  };
  it('正式網站插入一個 defer 的 script', () => {
    const doc = fakeDoc();
    expect(an.loadAnalytics(loc('teds-lin.github.io'), doc)).toBe(true);
    expect(doc.added).toHaveLength(1);
    expect(doc.added[0].src).toBe('https://static.cloudflareinsights.com/beacon.min.js');
    expect(doc.added[0].defer).toBe(true);
    expect(doc.added[0]['data-cf-beacon']).toContain('627408e0a6d24f15b16fe0acea4cafd7');
  });
  it('測試模式什麼都不插入', () => {
    const doc = fakeDoc();
    expect(an.loadAnalytics(loc('teds-lin.github.io', '?test=1'), doc)).toBe(false);
    expect(doc.added).toHaveLength(0);
  });
});
