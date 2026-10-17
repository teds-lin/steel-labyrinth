// M4 部署前最後一輪修正（客戶端）：額度用完的畫面不互相矛盾、被每分鐘 429 擋下的玩家訊息不進 history。
import { describe, it, expect } from 'vitest';
import { buildHistory, createDreamClient, chatQuotaView, DREAM_MSG } from '../../web/src/cloud/dream.js';

const ok = (status, body) => ({ ok: true, status, body, etag: null });
const NOW = 1_000_000;
function fakeApi(map) {
  return {
    dreamPass: async () => map.dreamPass,
    dreamChat: async () => (Array.isArray(map.dreamChat) ? map.dreamChat.shift() : map.dreamChat),
  };
}

describe('6. 額度用完的畫面', () => {
  it('reason quota 但 remaining_today > 0 → 剩餘句數顯示「—」、狀態列是「夢境今天變得模糊了」，不是「次數已用完」', () => {
    const v = chatQuotaView({ remaining: 20, quotaHit: true });
    expect(v).toEqual({ remainingLabel: '今日剩餘 — 句', note: DREAM_MSG.dreamBlurred, locked: true });
    expect(DREAM_MSG.dreamBlurred).toBe('夢境今天變得模糊了，明天再來吧。');
  });
  it('remaining_today 是 0 → 「今日剩餘 0 句」＋「今天的交談次數已經用完了」', () => {
    expect(chatQuotaView({ remaining: 0, quotaHit: true })).toEqual({ remainingLabel: '今日剩餘 0 句', note: DREAM_MSG.quotaUsedUp, locked: true });
    expect(chatQuotaView({ remaining: 0, quotaHit: false })).toEqual({ remainingLabel: '今日剩餘 0 句', note: DREAM_MSG.quotaUsedUp, locked: true });
  });
  it('還可以說 → 顯示剩餘句數、沒有提示；還不知道 → 「—」', () => {
    expect(chatQuotaView({ remaining: 5, quotaHit: false })).toEqual({ remainingLabel: '今日剩餘 5 句', note: null, locked: false });
    expect(chatQuotaView({ remaining: null, quotaHit: false })).toEqual({ remainingLabel: '今日剩餘 — 句', note: null, locked: false });
  });
  it('reason budget（全站預算用完）也算今天不能再說（quotaHit），重新取得通行證後清除', async () => {
    const api = fakeApi({
      dreamPass: ok(200, { pass: 'P1', ttl_s: 7200, remaining_today: 9 }),
      dreamChat: [ok(200, { reply: '發條快鬆了。', source: 'scripted', reason: 'budget', remaining_today: 9 })],
    });
    const c = createDreamClient({ api, now: () => NOW });
    await c.obtainPass('ts');
    await c.chat({ guest: 'g', chapter: 'c', history: [], input: 'x' });
    expect(c.quotaHit()).toBe(true);
    expect(chatQuotaView({ remaining: c.remaining(), quotaHit: c.quotaHit() }).note).toBe(DREAM_MSG.dreamBlurred);
    await c.obtainPass('ts');
    expect(c.quotaHit()).toBe(false);
  });
});

describe('6. 被每分鐘 429 擋下、沒有送出的玩家訊息不進 history', () => {
  it('unsent 的玩家訊息不送', () => {
    const log = [
      { role: 'player', text: '問題1' }, { role: 'guest', text: '答1', sig: 's1' },
      { role: 'player', text: '問題7', unsent: true }, { role: 'player', text: '問題8', unsent: true },
      { role: 'player', text: '問題9' },
    ];
    expect(buildHistory(log)).toEqual([
      { role: 'player', text: '問題1' }, { role: 'guest', text: '答1', sig: 's1' }, { role: 'player', text: '問題9' },
    ]);
  });
});
