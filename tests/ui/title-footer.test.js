// 標題畫面底部：顯示資料提供的版本名稱（manifest.title_footer），不再寫死「（開發中）」。
import { describe, it, expect } from 'vitest';
import { titleFooter, TITLE_KEY_HINT } from '../../web/src/ui/m5-view.js';

describe('titleFooter', () => {
  it('有 manifest.title_footer 就照資料顯示', () => {
    expect(titleFooter({ manifest: { title_footer: '第一部　霧中鐘聲' } })).toBe('第一部　霧中鐘聲');
  });
  it('沒有就不顯示（空字串），不再出現「開發中」', () => {
    expect(titleFooter({ manifest: {} })).toBe('');
    expect(titleFooter(undefined)).toBe('');
  });
});

describe('TITLE_KEY_HINT', () => {
  it('能力鍵同時寫出殘響與回溯（喝靈劑前後名稱不同）', () => {
    expect(TITLE_KEY_HINT).toContain('E 殘響／回溯');
  });
});

import { collectStrings } from '../../tools/lib/strings.mjs';
describe('字串匯出包含標題畫面底部的版本名稱', () => {
  it('manifest.title_footer 會被匯出（納入繁中掃描）', () => {
    const rows = collectStrings({ manifest: { title_footer: '第一部　霧中鐘聲' } });
    expect(rows).toContainEqual({ unique_id: 'manifest.json#title_footer', text: '第一部　霧中鐘聲' });
  });
});
