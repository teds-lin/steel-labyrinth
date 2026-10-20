// M4：與夢客對話（POST /api/dream/chat；docs/API.md「鐘塔之夢」＋ plans/M4-model-eval.md 的定案）。
// 人設、詞表、預寫台詞都是 tests/worker/fixtures/dream/ 的假資料，由上傳工具寫入 D1；AI 是 helpers 的假 binding。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startWorker, newPlayer, expectError, d1Rows, loadDreamFixtures, getPass, dreamChat, aiReply, readWranglerConfig, json, auth,
} from './helpers.js';

const OK = (pass, over = {}) => ({ pass, guest: 'lamp', chapter: 'chapter1', history: [], input: '你是誰？', ...over });
const systemOf = (call) => call.input.messages[0].content;
const allText = (call) => call.input.messages.map((m) => m.content).join('\n');

describe('POST /api/dream/chat：驗證與輸入', () => {
  let w;
  let p;
  let pass;
  beforeAll(async () => {
    w = await startWorker();
    await loadDreamFixtures(w);
    p = await newPlayer(w);
    pass = await getPass(w, p.token);
  });
  afterAll(async () => { await w?.close(); });

  it('沒有權杖 → 401 unauthorized；沒有通行證、格式錯、別的玩家的、過期的 → 401 pass_invalid；都不呼叫 AI', async () => {
    const before = w.aiCalls.length;
    await expectError(await w.fetch('/api/dream/chat', json(OK(pass))), 401, 'unauthorized');
    const other = await newPlayer(w);
    const otherPass = await getPass(w, other.token);
    for (const bad of [undefined, '', 'x.y', otherPass, `${pass}x`]) {
      const b = await expectError(await dreamChat(w, p.token, OK(bad)), 401, 'pass_invalid');
      expect(b.message).toMatch(/通行證/);
    }
    const { signPass, PASS_TTL } = await import('../../worker/src/dream.js');
    const { TEST_DREAM_PASS_SECRET } = await import('./helpers.js');
    const expired = (await signPass(TEST_DREAM_PASS_SECRET, p.player_id, Math.floor(Date.now() / 1000) - PASS_TTL - 1)).pass;
    await expectError(await dreamChat(w, p.token, OK(expired)), 401, 'pass_invalid');
    expect(w.aiCalls.length).toBe(before);
  });

  // 真正還沒開放的章節：CHAPTERS 裡編號最大的 chapterN 的下一章（開放新章節後自動往後推；M5 起最後一章是 finale，不能直接取最後一個）
  const UNRELEASED = `chapter${Math.max(...String(readWranglerConfig().vars.CHAPTERS).split(',').map((c) => /^chapter(\d+)$/.exec(c.trim())?.[1]).filter(Boolean).map(Number)) + 1}`;
  it('UNRELEASED 確實不在 CHAPTERS 白名單內', () => {
    expect(UNRELEASED).toMatch(/^chapter\d+$/);
    expect(String(readWranglerConfig().vars.CHAPTERS).split(',')).not.toContain(UNRELEASED);
  });
  it('guest 格式錯、夢客不存在；chapter 不在 CHAPTERS（含未開放的 chapter9）→ 400，不呼叫 AI', async () => {
    const before = w.aiCalls.length;
    for (const over of [{ guest: 'Lamp' }, { guest: 'x'.repeat(33) }, { guest: 'nobody' }, { guest: 5 },
      { chapter: 'chapter9' }, { chapter: UNRELEASED }, { chapter: '' }, { chapter: null }]) {
      await expectError(await dreamChat(w, p.token, OK(pass, over)), 400, 'bad_request');
    }
    expect(w.aiCalls.length).toBe(before);
  });

  it('input：去頭尾空白、移除控制與 Cf 字元後 1～120 字；history：最多 6 則、role 只能 player／guest → 否則 400', async () => {
    const before = w.aiCalls.length;
    for (const over of [{ input: '' }, { input: '  ​\u0007 ' }, { input: '字'.repeat(121) }, { input: 5 },
      { history: 'x' }, { history: [{ role: 'system', text: 'hi' }] }, { history: [{ role: 'player', text: 5 }] }, { history: [null] }]) {
      await expectError(await dreamChat(w, p.token, OK(pass, over)), 400, 'bad_request');
    }
    expect(w.aiCalls.length).toBe(before);
    const ok = await dreamChat(w, p.token, OK(pass, { input: ` ${'字'.repeat(120)}​ ` }));
    expect(ok.status).toBe(200);
  });

  it('Content-Type 不是 JSON → 415', async () => {
    await expectError(await w.fetch('/api/dream/chat', { method: 'POST', headers: auth(p.token, { 'content-type': 'text/plain' }), body: JSON.stringify(OK(pass)) }), 415, 'unsupported_media_type');
  });
});

describe('POST /api/dream/chat：AI 呼叫與提示詞', () => {
  let w;
  beforeAll(async () => {
    w = await startWorker();
    await loadDreamFixtures(w);
  });
  afterAll(async () => { await w?.close(); });

  it('成功 → 200 { reply, source:"ai", reason:null, remaining_today:19 }；模型與參數依 vars／模型評測', async () => {
    const p = await newPlayer(w);
    const res = await dreamChat(w, p.token, OK(await getPass(w, p.token)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: '鐘聲又慢了半拍。你今天看起來很累，坐下來聽我說一會兒吧。', source: 'ai', reason: null, remaining_today: 19, sig: expect.any(String) });
    const call = w.aiCalls.at(-1);
    expect(call.model).toBe(readWranglerConfig().vars.DREAM_MODEL);
    expect(call.model).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(call.input).toMatchObject({ max_tokens: 200, temperature: 0.7, chat_template_kwargs: { enable_thinking: false } });
  });

  it('提示詞（v2 範本）：人設、說話範例、到該章為止的知識卡、迴避主題名稱、界線、台灣繁體、150 字；主角稱為「十二點」', async () => {
    const p = await newPlayer(w);
    await dreamChat(w, p.token, OK(await getPass(w, p.token), { chapter: 'chapter1' }));
    const sys = systemOf(w.aiCalls.at(-1));
    expect(sys).toMatch(/^你是「提燈」，鋼鐵迷都世界裡的一位夢客。這是一段角色扮演，你從頭到尾都是提燈本人。/);
    for (const mark of ['PERSONA_MARK', 'EXAMPLE_MARK', 'KC_PROLOGUE', 'KC_CHAPTER1', '燈油從哪裡來、自己真正的名字', 'BOUNDARY_MARK', '台灣繁體中文', '150 字', '正在跟你說話的人叫「十二點」']) {
      expect(sys, mark).toContain(mark);
    }
    for (const mark of ['KC_CHAPTER2', 'KC_CHAPTER9', '港口倉庫的鑰匙', '未開放章節的祕密']) expect(sys, mark).not.toContain(mark);
    // 第 4 條排在第 5 條前面（評測時誤排，報告已改回）
    expect(sys.indexOf('4. ')).toBeLessThan(sys.indexOf('5. '));
    expect(sys.indexOf('5. ')).toBeLessThan(sys.indexOf('6. '));
  });

  it('防劇透：假人設有 chapter9 的知識卡；客戶端宣稱 chapter9 → 400，宣稱最後一個已開放章節 → 提示詞也不含 chapter9', async () => {
    const p = await newPlayer(w);
    const pass = await getPass(w, p.token);
    const before = w.aiCalls.length;
    await expectError(await dreamChat(w, p.token, OK(pass, { chapter: 'chapter9' })), 400, 'bad_request');
    expect(w.aiCalls.length).toBe(before);
    const last = readWranglerConfig().vars.CHAPTERS.split(',').at(-1);
    expect((await dreamChat(w, p.token, OK(pass, { chapter: last }))).status).toBe(200);
    const all = allText(w.aiCalls.at(-1));
    expect(all).toContain('KC_CHAPTER2');
    expect(all).not.toContain('KC_CHAPTER9');
    expect(all).not.toContain('劇透');
  });

  it('CHAPTERS 加開到 chapter9 之前，chapter9 的知識卡不可能被讀到（只取 CHAPTERS 順序中 ≤ 宣稱章節的鍵）', async () => {
    const s = await startWorker({ varsOverride: { CHAPTERS: 'prologue,chapter1,chapter2,chapter3' } });
    try {
      await loadDreamFixtures(s);
      const p = await newPlayer(s);
      expect((await dreamChat(s, p.token, OK(await getPass(s, p.token), { chapter: 'chapter3' }))).status).toBe(200);
      expect(allText(s.aiCalls.at(-1))).not.toContain('KC_CHAPTER9');
    } finally {
      await s.close();
    }
  });

  it('提示詞不含玩家的真名：body 夾帶名字欄位也不會被讀入（伺服器只認 pass／guest／chapter／history／input）', async () => {
    const p = await newPlayer(w);
    await dreamChat(w, p.token, { ...OK(await getPass(w, p.token)), name: '雷恩・葛雷', player: { name: '雷恩' }, player_name: '艾琳' });
    const all = allText(w.aiCalls.at(-1));
    for (const n of ['雷恩', '葛雷', '艾琳']) expect(all).not.toContain(n);
    expect(all).toContain('十二點');
  });

  it('history 照順序放進 messages（player→user、guest→assistant），只留最後 6 則、每則截到 150 字；input 是最後一則 user', async () => {
    const p = await newPlayer(w);
    // 修訂 1 C：guest 項目要帶伺服器簽過的 sig（這裡直接用同一把測試金鑰簽）
    const { signReply } = await import('../../worker/src/dream.js');
    const { TEST_DREAM_PASS_SECRET } = await import('./helpers.js');
    const history = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
      const text = `第${i}則${i === 7 ? '長'.repeat(200) : ''}`;
      return i % 2 ? { role: 'guest', text, sig: await signReply(TEST_DREAM_PASS_SECRET, p.player_id, 'lamp', text) } : { role: 'player', text };
    }));
    await dreamChat(w, p.token, OK(await getPass(w, p.token), { history, input: '  今天的霧好濃。​ ' }));
    const msgs = w.aiCalls.at(-1).input.messages;
    expect(msgs[0].role).toBe('system');
    expect(msgs.slice(1, -1).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(msgs[1].content).toBe('第2則');
    expect([...msgs[6].content]).toHaveLength(150);
    expect(msgs.at(-1)).toEqual({ role: 'user', content: '今天的霧好濃。' });
  });

  it('隱私：input、history、reply 都不寫進 D1', async () => {
    const p = await newPlayer(w);
    await dreamChat(w, p.token, OK(await getPass(w, p.token), { input: 'PRIVACY_INPUT_MARK', history: [{ role: 'player', text: 'PRIVACY_HISTORY_MARK' }] }));
    const { results: tables } = await w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all();
    for (const { name } of tables) {
      const { results } = await w.db.prepare(`SELECT * FROM ${name}`).all();
      const dump = JSON.stringify(results);
      for (const m of ['PRIVACY_INPUT_MARK', 'PRIVACY_HISTORY_MARK', '鐘聲又慢了半拍']) expect(dump, `${name} 含 ${m}`).not.toContain(m);
    }
  });
});

describe('POST /api/dream/chat：輸出處理流水線', () => {
  let w;
  beforeAll(async () => {
    w = await startWorker();
    await loadDreamFixtures(w);
  });
  afterAll(async () => { await w?.close(); });
  const chatWith = async (fn, over = {}) => {
    w.setAi(fn);
    const p = await newPlayer(w);
    const before = w.aiCalls.length;
    const res = await dreamChat(w, p.token, OK(await getPass(w, p.token), over));
    expect(res.status).toBe(200);
    return { body: await res.json(), calls: w.aiCalls.length - before, res };
  };

  it('讀 choices[0].message.content，不採用 message.reasoning；也支援舊格式 { response }', async () => {
    let r = await chatWith(() => aiReply('霧散了一點。', { reasoning: '（思考：REASONING_MARK）' }));
    expect(r.body).toMatchObject({ reply: '霧散了一點。', source: 'ai' });
    r = await chatWith(() => ({ response: '燈芯還長。', usage: { prompt_tokens: 800, completion_tokens: 20 } }));
    expect(r.body).toMatchObject({ reply: '燈芯還長。', source: 'ai' });
  });

  it('content 是 null、finish_reason 是 length、回應格式不明、AI 丟錯 → scripted＋ai_error（fallback 台詞），不扣額度', async () => {
    for (const fn of [() => aiReply(null), () => aiReply('說到一半', { finish_reason: 'length' }), () => ({ foo: 1 }), () => { throw new Error('boom'); }]) {
      const r = await chatWith(fn);
      expect(r.body).toEqual({ reply: 'SCRIPTED_FALLBACK 火光太暗，我聽不清楚。', source: 'scripted', reason: 'ai_error', remaining_today: 20, sig: expect.any(String) });
    }
  });

  it('去除 <think>…</think>、Markdown 符號、HTML 標籤', async () => {
    const r = await chatWith(() => aiReply('<think>THINK_MARK</think>\n\n**霧**很濃。<b>別怕</b>，\n# 我在這裡。<script>alert(1)</script>[燈](https://x.example)還亮著。'));
    expect(r.body.reply).toBe('霧很濃。別怕，我在這裡。alert(1)燈還亮著。');
    expect(r.body.source).toBe('ai');
  });

  it('只有開頭沒有結尾的 <think> → 整段丟掉（當成 ai_error）；只有 </think> → 丟掉它之前的內容', async () => {
    expect((await chatWith(() => aiReply('<think>想了很久還沒想完'))).body.reason).toBe('ai_error');
    expect((await chatWith(() => aiReply('一些思考</think>好的，燈還亮著。'))).body.reply).toBe('好的，燈還亮著。');
  });

  it('超過 150 字 → 在 150 字內最後一個句號（。！？）處截斷；沒有句號就硬截並加「……」', async () => {
    const long = `${'霧'.repeat(100)}。${'燈'.repeat(30)}！${'鐘'.repeat(40)}。`;
    const r = await chatWith(() => aiReply(long));
    expect(r.body.reply).toBe(`${'霧'.repeat(100)}。${'燈'.repeat(30)}！`);
    const r2 = await chatWith(() => aiReply('霧'.repeat(300)));
    expect([...r2.body.reply]).toHaveLength(150);
    expect(r2.body.reply.endsWith('……')).toBe(true);
  });

  it('詞表命中（簡體字、陸用語，包括反問語氣複述「網絡？信息？」這類）→ 重試一次；重試通過 → ai', async () => {
    const r = await chatWith((call, n) => aiReply(n % 2 === 1 ? '軟件？那是什麼東西。' : '那是什麼東西？夢裡沒有這種詞。'));
    expect(r.calls).toBe(2);
    expect(r.body).toMatchObject({ reply: '那是什麼東西？夢裡沒有這種詞。', source: 'ai', remaining_today: 19 });
  });

  it('詞表命中兩次 → scripted＋filtered（filtered 台詞），不扣額度；簡體字、例外詞、取消規則依詞表', async () => {
    let r = await chatWith(() => aiReply('这个燈還亮著。'));
    expect(r.calls).toBe(2);
    expect(r.body).toEqual({ reply: 'SCRIPTED_FILTERED 我好像說錯話了，當我沒說。', source: 'scripted', reason: 'filtered', remaining_today: 20, sig: expect.any(String) });
    r = await chatWith(() => aiReply('電視頻道今晚只有雜訊，質量守恆的道理夢裡也適用。'));
    expect(r.calls).toBe(1);
    expect(r.body.source).toBe('ai');
  });

  it('自稱 AI、提到設定用語（預設清單＋人設的 leak_markers）、照抄人設原文 → 重試一次，仍命中改用預寫', async () => {
    for (const text of ['我是一個 AI 語言模型。', '身為人工智慧，我不能回答。', '這是一段角色扮演，我只是照著指示。', '我的人設不允許我說。',
      '說話慢吞吞，喜歡用燈火比喻。']) {
      const r = await chatWith(() => aiReply(text));
      expect(r.calls, text).toBe(2);
      expect(r.body, text).toMatchObject({ source: 'scripted', reason: 'filtered' });
    }
  });

  it('重試最多一次：第一次命中詞表、第二次自稱 AI → scripted＋filtered（共 2 次呼叫）', async () => {
    const r = await chatWith((call, n) => aiReply(n % 2 === 1 ? '这是燈。' : '我是語言模型。'));
    expect(r.calls).toBe(2);
    expect(r.body.reason).toBe('filtered');
  });

  it('重試時在系統提示詞尾端加一段提醒（不在對話中間插入 system 訊息；gemma 的對話範本只接受開頭的 system），不把第一次的輸出放回提示詞', async () => {
    await chatWith((call, n) => aiReply(n % 2 === 1 ? '这是 FIRST_OUTPUT_MARK。' : '燈還亮著。'));
    const [first, second] = w.aiCalls.slice(-2);
    expect(allText(second)).not.toContain('FIRST_OUTPUT_MARK');
    expect(second.input.messages.length).toBe(first.input.messages.length);
    expect(second.input.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(systemOf(second).startsWith(systemOf(first))).toBe(true);
    expect(systemOf(second)).toMatch(/提醒.*台灣繁體/);
  });
});

describe('POST /api/dream/chat：額度與預算', () => {
  it('每位玩家每日 DREAM_CHATS_PER_DAY 句（scripted 不扣）；用完 → scripted＋quota、不呼叫 AI、不寫 D1', async () => {
    const w = await startWorker({ varsOverride: { DREAM_CHATS_PER_DAY: '2' } });
    try {
      await loadDreamFixtures(w);
      const p = await newPlayer(w);
      const pass = await getPass(w, p.token);
      expect((await (await dreamChat(w, p.token, OK(pass))).json()).remaining_today).toBe(1);
      expect((await (await dreamChat(w, p.token, OK(pass))).json()).remaining_today).toBe(0);
      const before = w.aiCalls.length;
      const res = await dreamChat(w, p.token, OK(pass));
      expect(d1Rows(res).written).toBe(0);
      expect(await res.json()).toEqual({ reply: 'SCRIPTED_QUOTA 夢境變得模糊了，今天先聊到這裡吧。', source: 'scripted', reason: 'quota', remaining_today: 0, sig: expect.any(String) });
      expect(w.aiCalls.length).toBe(before);
      // 別的玩家不受影響
      const q = await newPlayer(w);
      expect((await (await dreamChat(w, q.token, OK(await getPass(w, q.token)))).json()).source).toBe('ai');
    } finally {
      await w.close();
    }
  });

  it('全站每日 neurons 預算用完 → scripted＋budget、不呼叫 AI、不寫 D1；預扣 DREAM_NEURONS_PER_CALL＝20、呼叫後依 usage 修正', async () => {
    const w = await startWorker({ varsOverride: { DREAM_NEURONS_PER_DAY: '45' } });
    try {
      await loadDreamFixtures(w);
      expect(Number(readWranglerConfig().vars.DREAM_NEURONS_PER_CALL)).toBe(20);
      const p = await newPlayer(w);
      const pass = await getPass(w, p.token);
      const day = new Date().toISOString().slice(0, 10);
      const used = async () => (await w.db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(`g:neurons:${day}`).first())?.count ?? 0;
      // usage：1000 輸入、100 輸出 → 1000×9091/1e6＋100×27273/1e6 = 9.09＋2.73 → 12（無條件進位；高於 MIN、低於 MAX）
      w.setAi(() => aiReply('燈還亮著。', { usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }));
      expect((await (await dreamChat(w, p.token, OK(pass))).json()).source).toBe('ai');
      expect(await used()).toBe(12);
      // 沒有 usage → 維持預扣的 20
      w.setAi(() => ({ choices: [{ message: { content: '燈還亮著。' }, finish_reason: 'stop' }] }));
      expect((await (await dreamChat(w, p.token, OK(pass))).json()).source).toBe('ai');
      expect(await used()).toBe(32);
      // 剩 13 < 預扣 20 → budget
      const before = w.aiCalls.length;
      const res = await dreamChat(w, p.token, OK(pass));
      expect(d1Rows(res).written).toBe(0);
      expect(await res.json()).toEqual({ reply: 'SCRIPTED_QUOTA 夢境變得模糊了，今天先聊到這裡吧。', source: 'scripted', reason: 'budget', remaining_today: 18, sig: expect.any(String) });
      expect(w.aiCalls.length).toBe(before);
    } finally {
      await w.close();
    }
  });

  it('每次 AI 呼叫至少計 DREAM_NEURONS_MIN_PER_CALL（usage 很小也一樣，讓每日呼叫次數有上限）', async () => {
    const w = await startWorker();
    try {
      await loadDreamFixtures(w);
      const p = await newPlayer(w);
      w.setAi(() => aiReply('燈。', { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      await dreamChat(w, p.token, OK(await getPass(w, p.token)));
      const day = new Date().toISOString().slice(0, 10);
      const row = await w.db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(`g:neurons:${day}`).first();
      expect(row.count).toBe(Number(readWranglerConfig().vars.DREAM_NEURONS_MIN_PER_CALL));
    } finally {
      await w.close();
    }
  });

  it('並行：同一玩家同時送超過額度的請求，AI 呼叫次數不超過額度', async () => {
    const w = await startWorker({ varsOverride: { DREAM_CHATS_PER_DAY: '3' } });
    try {
      await loadDreamFixtures(w);
      const p = await newPlayer(w);
      const pass = await getPass(w, p.token);
      const before = w.aiCalls.length;
      const rs = await Promise.all(Array.from({ length: 8 }, () => dreamChat(w, p.token, OK(pass))));
      const bodies = await Promise.all(rs.map((r) => r.json()));
      // 修訂 1：句數在 AI 回覆通過檢查後才原子計入（不超收）；AI 呼叫次數由 pl:dcall 與每分鐘限制（pl:dmin）封頂
      expect(bodies.filter((b) => b.source === 'ai')).toHaveLength(3);
      expect(bodies.filter((b) => b.source !== 'ai').every((b) => b.reason === 'quota' || b.error === 'rate_limited')).toBe(true);
      expect(w.aiCalls.length - before).toBeLessThanOrEqual(Number(readWranglerConfig().vars.DREAM_CHATS_PER_MINUTE));
    } finally {
      await w.close();
    }
  });

  it('詞表或人設還沒上傳 → 夢客不存在（400）；只缺詞表 → scripted＋ai_error（不在沒有檢查的情況下呼叫 AI）', async () => {
    const w = await startWorker();
    try {
      const p = await newPlayer(w);
      const pass = await getPass(w, p.token);
      await expectError(await dreamChat(w, p.token, OK(pass)), 400, 'bad_request');
      await loadDreamFixtures(w);
      await w.db.prepare('DELETE FROM dream_lexicon').run();
      const s = await startWorker(); // 新的 isolate（沒有快取）
      try {
        await loadDreamFixtures(s);
        await s.db.prepare('DELETE FROM dream_lexicon').run();
        const q = await newPlayer(s);
        const before = s.aiCalls.length;
        const body = await (await dreamChat(s, q.token, OK(await getPass(s, q.token)))).json();
        expect(body).toMatchObject({ source: 'scripted', reason: 'ai_error' });
        expect(s.aiCalls.length).toBe(before);
      } finally {
        await s.close();
      }
    } finally {
      await w.close();
    }
  });
});

describe('M5：預寫台詞依玩家所在章節（scripted_by_chapter；當章沒有就往前一章找）', () => {
  it('scriptedLine：取 CHAPTERS 順序中 ≤ 玩家章節、最近的一份；都沒有就用 scripted', async () => {
    const { scriptedLine } = await import('../../worker/src/dream.js');
    const persona = {
      scripted: { fallback: ['DEFAULT'] },
      scripted_by_chapter: { chapter3: { fallback: ['C3'], quota: ['Q3'] }, chapter5: { fallback: ['C5'] } },
    };
    const chapters = ['prologue', 'chapter1', 'chapter2', 'chapter3', 'chapter4', 'chapter5', 'chapter6'];
    expect(scriptedLine(persona, 'ai_error', 'chapter2', chapters)).toBe('DEFAULT');
    expect(scriptedLine(persona, 'ai_error', 'chapter3', chapters)).toBe('C3');
    expect(scriptedLine(persona, 'quota', 'chapter4', chapters)).toBe('Q3');
    expect(scriptedLine(persona, 'ai_error', 'chapter6', chapters)).toBe('C5');
    expect(scriptedLine(persona, 'quota', 'chapter6', chapters)).toBe('C5'); // 該章沒有 quota → 該章的 fallback
    expect(scriptedLine({ scripted: { fallback: ['OLD'] } }, 'ai_error', 'chapter6', chapters)).toBe('OLD'); // 舊格式
  });
  it('/api/dream/chat：AI 失敗時回的預寫台詞是玩家所在章節的版本', async () => {
    const w = await startWorker();
    try {
      const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const { DREAM_FIXTURES } = await import('./helpers.js');
      const d = join(tmpdir(), 'steel-labyrinth-dream-chat-test', 'story-by-chapter');
      mkdirSync(d, { recursive: true });
      const base = JSON.parse(readFileSync(join(DREAM_FIXTURES, 'story', 'fake_chapter.json'), 'utf8'));
      for (const ch of ['chapter1', 'chapter2']) {
        const s = structuredClone(base);
        s.id = ch;
        s.guests[0].scripted.fallback = [`FALLBACK_${ch}`];
        writeFileSync(join(d, `${ch}.json`), JSON.stringify(s));
      }
      await loadDreamFixtures(w, { storyDir: d, chapters: ['chapter1', 'chapter2'] });
      w.setAi(() => { throw new Error('boom'); });
      for (const [chapter, want] of [['chapter1', 'FALLBACK_chapter1'], ['chapter2', 'FALLBACK_chapter2'], ['chapter3', 'FALLBACK_chapter2']]) {
        const p = await newPlayer(w);
        const res = await dreamChat(w, p.token, OK(await getPass(w, p.token), { chapter }));
        expect(res.status).toBe(200);
        expect((await res.json()).reply, chapter).toBe(want);
      }
    } finally { await w.close(); }
  });
});
