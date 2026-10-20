// 修訂 5a：空帳號改成「建立超過 7 天、沒有任何存檔也沒有通關紀錄」就由 Cron 清除。
// 重新連結頁面要說明原因（啟用雲端 7 天內沒上傳過的帳號會被清除），並告訴玩家重新啟用即可。
import { describe, it, expect } from 'vitest';
import { MSG } from '../../web/src/cloud/sync.js';

describe('修訂 5a：重新連結頁面說明 7 天清除規則', () => {
  it('提到 7 天內沒上傳會被清除，並保留「也可以重新啟用雲端存檔」；錯誤訊息本身不變', () => {
    expect(MSG.relink).toBe('此裝置的雲端連結已失效，請重新用轉移碼接續');
    expect(MSG.relinkPage.startsWith(MSG.relink)).toBe(true);
    expect(MSG.relinkPage).toMatch(/7 天內.*沒有上傳/);
    expect(MSG.relinkPage).toContain('也可以重新啟用雲端存檔');
  });
});
