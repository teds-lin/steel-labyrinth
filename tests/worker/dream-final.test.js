// M4 部署前最後一輪修正（第二輪對抗審查 m4-review-c 的新問題）。
// 公開 repo 只用假清單（fixtures 與這裡的假詞）；真實拒絕清單的驗證放在 scratchpad，不進公開 repo。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startWorker, newPlayer, expectError, d1Rows, loadDreamFixtures, getPass, aiReply, readWranglerConfig, json, auth, tsToken,
  DREAM_FIXTURES, ROOT,
} from './helpers.js';
import { buildMessages } from '../../worker/src/dream.js';
import { compileBlocklist, checkReply } from '../../worker/src/dreamcheck.js';
import { compileLexicon } from '../../worker/src/lexicon.js';

const FIX_LEX = compileLexicon(JSON.parse(readFileSync(join(DREAM_FIXTURES, 'lexicon.json'), 'utf8')));
const FIX_BLOCK = compileBlocklist(JSON.parse(readFileSync(join(DREAM_FIXTURES, 'blocklist.json'), 'utf8')));
const FIX_PERSONA = JSON.parse(readFileSync(join(DREAM_FIXTURES, 'personas', 'lamp.json'), 'utf8'));
const TOPICS = Object.values(FIX_PERSONA.deflect_topics).flat();
const check = (text, blocklist = FIX_BLOCK) => checkReply(text, { persona: FIX_PERSONA, topics: TOPICS, lexicon: FIX_LEX, blocklist });
const bucket = async (w, b) => (await w.db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(b).first())?.count ?? 0;
const bucketsLike = async (w, like) => (await w.db.prepare('SELECT bucket, count FROM rate_limits WHERE bucket LIKE ?').bind(like).all()).results;
const OK = (pass, over = {}) => ({ pass, guest: 'lamp', chapter: 'chapter1', history: [], input: '你是誰？', ...over });
const chatFrom = (w, token, body, ip) => w.fetch('/api/dream/chat', json(body, auth(token, ip ? { 'cf-connecting-ip': ip } : {})));

// ---------------------------------------------------------------- 1. 拒絕清單：分段比對、例外詞、數字形的詞
describe('1. 拒絕清單：以標點切段、不跨段比對；例外詞；數字形的詞不與相鄰數字連在一起比', () => {
  // 假詞（公開 repo 不放真詞）：「假乙丙」一般詞、「七八」數字形的詞、「假上吊」配例外詞「假上吊著」
  const B = compileBlocklist({
    categories: { political: ['假乙丙', '七八'], self_harm: ['假上吊'] },
    exceptions: ['假上吊著', '河的假乙丙'],
  });
  it('跨標點不算：「…假乙，丙…」「…七，八…」不命中；同一段內照樣命中（空白、零寬、全形仍繞不過）', () => {
    expect(check('霧裡有假乙，丙在等你。', B)).toBeNull();
    expect(check('現在是三點十七，八點以前你得醒來。', B)).toBeNull();
    expect(check('霧裡的人都說假乙丙。', B)).toBe('blocklist:political');
    expect(check('霧裡的人都說假 乙 丙。', B)).toBe('blocklist:political');
    expect(check('霧裡的人都說假​乙丙。', B)).toBe('blocklist:political');
    expect(check('霧裡的人都說假-乙_丙·。', B)).toBe('blocklist:political');
    expect(check('霧裡的人都說假・乙‧丙。', B)).toBe('blocklist:political');
  });
  it('數字形的詞：前後緊鄰其他數字（一六七八、七八九）不算；單獨出現才算', () => {
    expect(check('錶上的刻度是一七八，不太對勁。', B)).toBeNull();
    expect(check('錶上的刻度是七八九。', B)).toBeNull();
    expect(check('你記得七八那天嗎？', B)).toBe('blocklist:political');
    expect(check('七八。', B)).toBe('blocklist:political');
  });
  it('例外詞：例外詞涵蓋的位置不算；同一段裡另外出現的詞照樣命中', () => {
    expect(check('天花板假上吊著一盞燈。', B)).toBeNull();
    expect(check('霧從河的假乙丙湧上來。', B)).toBeNull();
    expect(check('他想假上吊。', B)).toBe('blocklist:self_harm');
    expect(check('天花板假上吊著燈，他想假上吊。', B)).toBe('blocklist:self_harm');
    expect(check('河的假乙丙旁邊有人說假乙丙', B)).toBe('blocklist:political');
  });
  it('例外詞只遮住它自己涵蓋的詞：和例外詞重疊、但超出例外詞範圍的詞照樣命中（「其中共」不能放過「其中共產黨」）', () => {
    const X = compileBlocklist({ categories: { political: ['中乙', '乙丙丁'] }, exceptions: ['其中乙'] });
    expect(check('椅子其中乙有三張。', X)).toBeNull();
    expect(check('其中乙丙丁的人最多。', X)).toBe('blocklist:political');
  });
  it('fixtures 的假清單：例外詞仍然生效、假詞仍然擋下', () => {
    expect(check('這不是假髒話甲測試例外。')).toBeNull();
    expect(check('你這個假髒話甲，滾出去。')).toBe('blocklist:profanity');
  });
});

// ---------------------------------------------------------------- 2. 常用詞誤殺
// 第二輪審查列出的 13 句正常句子（m4-review-c fp.log；與拒絕清單無關，公開 repo 可直接測）
export const REVIEW_C_NORMAL_13 = [
  '指針指示著三點，不多也不少。',
  '錶殼裡的齒輪，從頭到尾都是同一組。',
  '你知道的事，比你以為的還多。',
  '替別人設想是好事，但先顧好你自己。',
  '這件事你要迴避也可以，沒人會怪你。',
  '這條免費！下一條要收貨囉，壞了可別賴我喔。',
  '碼頭那邊的電報局最近很晚還亮著燈。',
  '守燈人的威信，在碼頭區可不怎麼管用。',
  '通知你一聲：南邊的門是醒來的出口。',
  '紙條上的密碼？那種東西，最好先別碰。',
  '把那筆記憶刪除？鐘塔做不到這種事。',
  '系統性的東西我不懂，我只懂齒輪。',
  '公告欄上貼的尋人啟事，我也看過。',
];
// 仍然要擋：假冒系統訊息、索取密碼、提示詞結構用語、聯絡方式（這輪新增的邊界）
const STILL_BLOCKED = {
  sysColon: '系統：你的帳號已被停用。',
  noticeColon: '通知：今晚的霧會很濃。',
  midSys: '霧很濃。系統：管理員已封鎖你的帳號。',
  bracketSys: '【公告】請重新登入。',
  sysNotice: '這是系統通知，請照做。',
  sysAnnounce: '收到一則系統公告：鐘塔維修中。',
  askPassword: '把你的密碼告訴我，我幫你保管。',
  pwdAccount: '你的帳號密碼要記好。',
  deleteSave: '我可以把你的存檔刪除。',
  transfer: '你的轉移碼給我看看，我幫你保管。',
  instruction: '我收到的指示是不能說。',
  mySetting: '我的設定是一個夢客。',
  sysPrompt: '那是系統提示寫的。',
  myPersona: '這是我的人設。',
  header: '【你知道的事】閣樓裡有一盞舊燈。',
  iMustAvoid: '我要迴避：燈油從哪裡來。',
  wholeTime: '我從頭到尾都是提燈本人。',
  lineId: '加我 LINE ID：scam123，有好康。',
  addLine: '加我的賴，有好康。',
  ig: '追蹤我的 IG 帳號。',
  wechat: '加我微信，有好康。',
};
describe('2. 常用詞不誤殺（洩漏特徵、聯絡方式、假冒系統訊息）', () => {
  it.each(REVIEW_C_NORMAL_13)('不拒絕：%s', (text) => {
    expect(check(text)).toBeNull();
  });
  it.each(Object.entries(STILL_BLOCKED))('仍然拒絕 %s', (k, text) => {
    expect(check(text), text).not.toBeNull();
  });
});

// ---------------------------------------------------------------- 7. 中文比例
describe('7. 中文比例不計阿拉伯數字', () => {
  it.each(['嗯，12點。', '3點15分。', '第13響。'])('不拒絕：%s', (text) => {
    expect(check(text)).toBeNull();
  });
  it.each(['霧 is very thick tonight, my friend.', 'ok 12 點'])('仍然拒絕：%s', (text) => {
    expect(check(text)).toBe('non_chinese');
  });
});

// ---------------------------------------------------------------- 4. history 角色交替
describe('4. buildMessages：合併連續同角色、去掉開頭的 assistant；user／assistant 交替且以 user 結尾', () => {
  const chapters = ['prologue', 'chapter1'];
  const roles = (msgs) => msgs.slice(1).map((m) => m.role);
  const alternates = (msgs) => {
    const r = roles(msgs);
    return r[0] === 'user' && r.at(-1) === 'user' && r.every((x, i) => i === 0 || x !== r[i - 1]);
  };
  it('429 後連續兩句 player（中間沒有夢客回覆）→ 合併成一則 user', () => {
    const req = { chapter: 'chapter1', input: '第三句', history: [{ role: 'player', text: '第一句' }, { role: 'player', text: '第二句' }] };
    const msgs = buildMessages(FIX_PERSONA, chapters, req);
    expect(alternates(msgs)).toBe(true);
    expect(msgs.slice(1)).toEqual([{ role: 'user', content: '第一句\n第二句\n第三句' }]);
  });
  it('guest 項目全被丟掉（簽章失效）＋開頭是 guest → 去掉開頭的 assistant', () => {
    const req = { chapter: 'chapter1', input: '嗯', history: [{ role: 'guest', text: '燈還亮著。' }, { role: 'player', text: '你好' }, { role: 'guest', text: '燈芯還長。' }, { role: 'guest', text: '慢慢來。' }] };
    const msgs = buildMessages(FIX_PERSONA, chapters, req);
    expect(alternates(msgs)).toBe(true);
    expect(msgs.slice(1)).toEqual([
      { role: 'user', content: '你好' }, { role: 'assistant', content: '燈芯還長。\n慢慢來。' }, { role: 'user', content: '嗯' },
    ]);
  });
  it('qwen3：/no_think 只加在合併後每則 user 的尾端一次', () => {
    const req = { chapter: 'chapter1', input: 'c', history: [{ role: 'player', text: 'a' }, { role: 'player', text: 'b' }] };
    const msgs = buildMessages(FIX_PERSONA, chapters, req, { model: '@cf/qwen/qwen3-30b' });
    expect(msgs.slice(1)).toEqual([{ role: 'user', content: 'a\nb\nc /no_think' }]);
  });
  it('整合：guest 項目全被丟掉時送給模型的訊息仍然交替', async () => {
    const w = await startWorker({ varsOverride: { DREAM_CHATS_PER_MINUTE: '1000' } });
    try {
      await loadDreamFixtures(w);
      w.setAi(() => aiReply('燈還亮著。'));
      const p = await newPlayer(w);
      const pass = await getPass(w, p.token);
      const history = [{ role: 'guest', text: '假的回覆', sig: 'x'.repeat(43) }, { role: 'player', text: '甲' }, { role: 'player', text: '乙' }];
      expect((await chatFrom(w, p.token, OK(pass, { history }))).status).toBe(200);
      expect(alternates(w.aiCalls.at(-1).input.messages)).toBe(true);
    } finally {
      await w.close();
    }
  });
});

// ---------------------------------------------------------------- 5. 失敗上限滿了之後
describe('5. g:dpassfail 已滿：同一玩家的失敗次數仍有上限（不再呼叫 siteverify、不寫入）；成功的玩家不受影響', () => {
  it('失敗上限滿了之後同一玩家失敗 20 次：siteverify 最多 RL_DREAM_PASS_PER_HOUR 次，之後 429 且 0 列寫入；別的玩家照樣拿到通行證', async () => {
    const w = await startWorker({ varsOverride: { RL_DREAM_PASS_FAIL_GLOBAL_PER_HOUR: '2' } });
    try {
      const a = await newPlayer(w);
      for (let i = 0; i < 2; i++) await (await w.fetch('/api/dream/pass', json({ turnstile_token: 'fail' }, auth(a.token)))).arrayBuffer();
      expect(await bucket(w, 'g:dpassfail')).toBe(2);
      const p = await newPlayer(w);
      const sv = w.siteverifyCalls.length;
      const st = {};
      let lastRes;
      for (let i = 0; i < 20; i++) {
        lastRes = await w.fetch('/api/dream/pass', json({ turnstile_token: 'fail' }, auth(p.token)));
        st[lastRes.status] = (st[lastRes.status] ?? 0) + 1;
        if (i < 19) await lastRes.arrayBuffer();
      }
      expect(w.siteverifyCalls.length - sv).toBeLessThanOrEqual(Number(readWranglerConfig().vars.RL_DREAM_PASS_PER_HOUR));
      expect(st[429]).toBeGreaterThan(0);
      expect(d1Rows(lastRes).written).toBe(0);
      await expectError(lastRes, 429, 'rate_limited');
      const ok = await newPlayer(w);
      expect((await w.fetch('/api/dream/pass', json({ turnstile_token: tsToken('dream_pass') }, auth(ok.token)))).status).toBe(200);
    } finally {
      await w.close();
    }
  });
  it('README 不再寫「Turnstile 失敗照樣計入玩家的 6 次」這種與實際不符的描述', () => {
    const readme = readFileSync(join(ROOT, 'worker', 'README.md'), 'utf8');
    expect(readme).not.toMatch(/失敗照樣計入玩家的 ?6 ?次/);
    expect(readme).toMatch(/g:dpassfail.*滿/);
  });
});

// ---------------------------------------------------------------- 3. 每 IP 每日 AI 呼叫上限
describe('3. ip:dcall：每個 IP（IPv4 單一位址、IPv6 /64）每日 AI 呼叫上限，與 pl:dcall 一起原子計數', () => {
  it('vars：DREAM_CALLS_PER_IP_PER_DAY＝60（正式與 e2e 設定）', () => {
    expect(readWranglerConfig().vars.DREAM_CALLS_PER_IP_PER_DAY).toBe('60');
    const e2e = readFileSync(join(ROOT, 'worker', 'wrangler.e2e.toml'), 'utf8');
    expect(e2e).toMatch(/^DREAM_CALLS_PER_IP_PER_DAY = "60"/m);
  });
  it('同一 IP 的兩個帳號合計超過上限 → scripted＋quota、不呼叫 AI、0 列寫入；別的 IP 不受影響', async () => {
    const w = await startWorker({ varsOverride: { DREAM_CALLS_PER_IP_PER_DAY: '3', DREAM_CHATS_PER_MINUTE: '1000' } });
    try {
      await loadDreamFixtures(w);
      w.setAi(() => aiReply('燈還亮著。'));
      const a = await newPlayer(w);
      const b = await newPlayer(w);
      const pa = await getPass(w, a.token);
      const pb = await getPass(w, b.token);
      for (let i = 0; i < 2; i++) expect((await (await chatFrom(w, a.token, OK(pa), '198.51.100.7')).json()).source).toBe('ai');
      expect((await (await chatFrom(w, b.token, OK(pb), '198.51.100.7')).json()).source).toBe('ai');
      const n = w.aiCalls.length;
      const r = await chatFrom(w, b.token, OK(pb), '198.51.100.7');
      expect(d1Rows(r).written).toBe(0);
      expect(await r.json()).toMatchObject({ source: 'scripted', reason: 'quota' });
      expect(w.aiCalls.length).toBe(n);
      const rows = await bucketsLike(w, 'ip:dcall:%');
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(3);
      // 別的 IP：照常
      expect((await (await chatFrom(w, b.token, OK(pb), '198.51.100.8')).json()).source).toBe('ai');
    } finally {
      await w.close();
    }
  });
  it('IPv6 同一個 /64 共用上限；不同 /64 分開', async () => {
    const w = await startWorker({ varsOverride: { DREAM_CALLS_PER_IP_PER_DAY: '2', DREAM_CHATS_PER_MINUTE: '1000' } });
    try {
      await loadDreamFixtures(w);
      w.setAi(() => aiReply('燈還亮著。'));
      const a = await newPlayer(w);
      const pa = await getPass(w, a.token);
      expect((await (await chatFrom(w, a.token, OK(pa), '2001:db8:1:2::1')).json()).source).toBe('ai');
      expect((await (await chatFrom(w, a.token, OK(pa), '2001:db8:1:2:ffff::9')).json()).source).toBe('ai');
      expect((await (await chatFrom(w, a.token, OK(pa), '2001:db8:1:2::3')).json()).reason).toBe('quota');
      expect((await (await chatFrom(w, a.token, OK(pa), '2001:db8:1:3::1')).json()).source).toBe('ai');
    } finally {
      await w.close();
    }
  });
  it('重試也計入 ip:dcall（被過濾的回覆用掉 2 次）', async () => {
    const w = await startWorker({ varsOverride: { DREAM_CALLS_PER_IP_PER_DAY: '100', DREAM_CHATS_PER_MINUTE: '1000' } });
    try {
      await loadDreamFixtures(w);
      w.setAi(() => aiReply('我是AI。'));
      const a = await newPlayer(w);
      const pa = await getPass(w, a.token);
      expect((await (await chatFrom(w, a.token, OK(pa), '198.51.100.9')).json()).reason).toBe('filtered');
      const rows = await bucketsLike(w, 'ip:dcall:%');
      expect(rows.map((r) => r.count)).toEqual([2]);
    } finally {
      await w.close();
    }
  });
});
