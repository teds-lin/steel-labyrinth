// index.html 的靜態檢查：全螢幕的提示框（#load-status、#boot-error）不能只靠 inset:0，
// 不支援 inset 的舊瀏覽器（例如 Safari 14.0 以前）會讓框縮成一小塊，所以先寫 top/right/bottom/left 再寫 inset。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
/** 取出某個選擇器的第一個 CSS 規則內容。 */
const rule = (sel) => {
  const m = new RegExp(`\\n\\s*${sel.replace(/[#.]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(html);
  return m ? m[1] : null;
};

describe('index.html 全螢幕提示框的定位', () => {
  for (const sel of ['#load-status', '#boot-error']) {
    it(`${sel}：有 top/right/bottom/left: 0 的後備，且寫在 inset 之前`, () => {
      const r = rule(sel);
      expect(r, sel).not.toBeNull();
      expect(r).toMatch(/position:\s*fixed/);
      const fallback = r.search(/top:\s*0;\s*right:\s*0;\s*bottom:\s*0;\s*left:\s*0;/);
      expect(fallback, '缺少 top/right/bottom/left: 0').toBeGreaterThanOrEqual(0);
      expect(fallback).toBeLessThan(r.search(/inset:\s*0/));
    });
  }
});

describe('不支援 module 的舊瀏覽器', () => {
  it('有 <script nomodule>，而且放在載入監看之前（監看看到旗標就不再報「載入失敗」）', () => {
    const nomodule = html.indexOf('<script nomodule>');
    expect(nomodule).toBeGreaterThan(0);
    expect(nomodule).toBeLessThan(html.indexOf('__slBootWatch'));
    expect(html).toContain('瀏覽器版本太舊，請更新後再試');
  });
});
