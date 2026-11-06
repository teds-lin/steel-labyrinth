// M6 真實音訊後端 smoke（只跑 desktop）：?test=1&audio=1 用 WebAudioBackend（其餘測試模式行為照舊）。
// AudioContext 預設被包成「要等手勢才能出聲」（見 audio-real-fixture.js）；允許自動播放的情況在 audio-autoplay.spec.js。
import { expect, game, seedSaves, makeSave } from './helpers.js';
import { dreamUi } from './dream-ui.js';
import { useDreamFixture, DREAM_FIXTURE_PREFIX } from './dream-fixture.js';
import { test, FILE_CUES, SFX_FILE, REAL_URL, audio, watchAudioRequests, gesture, waitLoaded } from './audio-real-fixture.js';

test.describe('M6 真實音訊後端（?test=1&audio=1）', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', '真實後端 smoke 只跑 desktop');
  });

  test('標題出現前 0 個音訊請求；第一次手勢後所有音效都載入（每個只抓一種格式）、沒有 console error', async ({ page }) => {
    const reqs = watchAudioRequests(page);
    const g = game(page);
    await page.goto(REAL_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(1000);
    const a0 = await audio(page);
    expect(a0).toMatchObject({ backend: 'webaudio', unlocked: false });
    expect(a0.real).toMatchObject({ state: 'suspended', buffers: 0 });
    expect(reqs, '手勢前不得抓任何音檔').toEqual([]);

    await gesture(page);
    await waitLoaded(page, FILE_CUES.length);
    const a1 = await audio(page);
    expect(a1.unlocked).toBe(true);
    expect(a1.real.state).toBe('running');
    expect(a1.broken).toEqual([]);
    const sfxReqs = reqs.filter((u) => SFX_FILE.test(u));
    expect(sfxReqs).toHaveLength(FILE_CUES.length);
    expect(new Set(sfxReqs.map((u) => u.replace(/\.(ogg|m4a)$/, ''))).size).toBe(FILE_CUES.length);
    // M6 P3：標題的主題曲在解鎖後才下載（只抓一種格式）並開始循環播放
    expect(reqs.filter((u) => !SFX_FILE.test(u)).map((u) => u.replace(/^.*\/audio\//, '').replace(/\.(ogg|m4a)$/, ''))).toEqual(['bgm/bgm_theme']);
    await page.waitForFunction(() => window.__SL.audio().real?.loops?.bgm === 'bgm_theme', null, { timeout: 10_000 });
  });

  test('只按 Esc（不算使用者啟動）：不解鎖、也不抓任何音檔；之後點一下才解鎖', async ({ page }) => {
    const reqs = watchAudioRequests(page);
    const g = game(page);
    await page.goto(REAL_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(500);
    await g.key('Escape');
    await g.key('Escape');
    await g.sleep(800);
    const a = await audio(page);
    expect(a.unlocked).toBe(false);
    expect(a.real.state).toBe('suspended');
    expect(reqs).toEqual([]);
    // Phaser 自己的解鎖在 resume 被拒絕後就不再嘗試；遊戲自己的手勢監聽仍在，點一下就能解鎖
    await gesture(page);
    await waitLoaded(page, FILE_CUES.length);
    expect((await audio(page)).unlocked).toBe(true);
  });

  test('真實後端打一場戰鬥到結果畫面：沒有 console error、沒有壞掉的 cue，戰鬥音效有送出播放（M6 P2）', async ({ page }) => {
    test.setTimeout(180_000);
    await seedSaves(page, { 1: {
      ...makeSave(), schema_version: 2, lineage: { id: 'trace', rank: 9 }, location: { map: 'warehouse', x: 7, y: 3, dir: 'up' },
      flags: {
        'enter:office': true, 'enter:training': true, 'enter:dock': true, 'enter:warehouse': true, drank_potion: true, sparred: true,
        fog1_done: true, fog2_done: true, fog3_done: true, boss_warned: true, ch2_deduced: true, wh_door_open: true,
      },
      items: { revolver: 1, bandage: 2, sedative_incense: 1, warehouse_key: 1 }, echo: { charges: 0 }, collapse: 10,
      resonance: { clue_found: 3, deduction_correct: 1 }, chapter: 'chapter2', chapter_done: ['prologue', 'chapter1'],
      party: [{ id: 'hero', hp: null, sp: null }, { id: 'ada', hp: null, sp: null }], ammo: 12, pending: null,
    } });
    await page.goto(`${REAL_URL}&seed=3`);
    const g = game(page);
    const u = dreamUi(page, g, false);
    await u.loadFromTitle(1); // 滑鼠點擊＝手勢解鎖
    await waitLoaded(page, FILE_CUES.length);
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue();
    await g.waitScene('Battle');
    let b = null;
    for (let turn = 0; turn < 200; turn++) {
      const x = await g.battleWait(30_000);
      if (!x) break; // Boss 戰輸了直接進 Game Over
      b = x;
      if (b.mode === 'result') break;
      if (b.mode !== 'root') { await g.battleButton('返回'); continue; }
      const target = b.units.find((x) => x.side === 'enemy' && x.alive).uid;
      const shoot = b.commands.skills.find((s) => s.id === 'shoot' && s.usable);
      await g.battleCommand({ skill: shoot ? 'shoot' : 'attack', target });
    }
    expect(['Battle', 'GameOver']).toContain(await g.scene());
    const a = await audio(page);
    expect(a.backend).toBe('webaudio');
    expect(a.broken).toEqual([]);
    expect(a.lastSfx.some((x) => /^(bt_|jingle_)/.test(x))).toBe(true);
    expect(a.lastSfx.filter((x) => x.startsWith('jingle_'))).toHaveLength(1);
  });

  test.describe('某個音效回 404', () => {
    test.use({ allow404: '/audio/sfx/ui_error.' });
    test('遊戲照常、只 warn 一次、該 cue 進 broken（ogg 404 → 試 m4a 一次 → 放棄）', async ({ page, warns }) => {
      const reqs = watchAudioRequests(page);
      await page.route('**/audio/sfx/ui_error.*', (r) => r.fulfill({ status: 404, body: 'not found' }));
      const g = game(page);
      await page.goto(REAL_URL);
      await g.waitScene('Title', 15_000);
      await gesture(page);
      await waitLoaded(page, FILE_CUES.length - 1);
      const a = await audio(page);
      expect(a.broken).toEqual(['ui_error']);
      // 線上網址前面多一層 /steel-labyrinth/，只比對結尾
      const errReqs = reqs.filter((u) => u.includes('ui_error'));
      expect(errReqs).toHaveLength(2);
      expect(errReqs[0].endsWith('/audio/sfx/ui_error.ogg')).toBe(true);
      expect(errReqs[1].endsWith('/audio/sfx/ui_error.m4a')).toBe(true);
      expect(warns.filter((w) => w.includes('ui_error'))).toHaveLength(1);
      expect(warns, '整個過程只有這一筆 warn').toHaveLength(1);
      // 遊戲照常：開新遊戲進到命名畫面
      await g.key('Enter');
      await g.waitScene('Name');
    });
  });

  test('回傳無法解碼的內容：cue 進 broken，沒有 console error', async ({ page, warns }) => {
    await page.route('**/audio/sfx/ui_save.*', (r) => r.fulfill({ status: 200, contentType: 'audio/ogg', body: 'this is not audio' }));
    const g = game(page);
    await page.goto(REAL_URL);
    await g.waitScene('Title', 15_000);
    await gesture(page);
    await waitLoaded(page, FILE_CUES.length - 1);
    expect((await audio(page)).broken).toEqual(['ui_save']);
    expect(warns.filter((w) => w.includes('ui_save'))).toHaveLength(1);
  });

  test('M 鍵靜音：master gain 變 0；再按回到 1', async ({ page }) => {
    const g = game(page);
    await page.goto(REAL_URL);
    await g.waitScene('Title', 15_000);
    await gesture(page);
    await waitLoaded(page, FILE_CUES.length);
    await g.key('KeyM');
    expect((await audio(page)).real.masterTarget).toBe(0);
    await page.waitForFunction(() => window.__SL.audio().real.master < 0.01, null, { timeout: 3_000 });
    await g.key('KeyM');
    expect((await audio(page)).real.masterTarget).toBe(1);
    await page.waitForFunction(() => window.__SL.audio().real.master > 0.99, null, { timeout: 3_000 });
  });

  test('入夢與醒來各響一次鐘聲（sfx_bell）', async ({ page }) => {
    const ATTIC_SPOT = { map: 'attic', x: 3, y: 2, dir: 'up' };
    await useDreamFixture(page);
    await seedSaves(page, { 1: makeSave({ location: ATTIC_SPOT }) });
    await page.goto(`${REAL_URL}&data=${DREAM_FIXTURE_PREFIX}`);
    const g = game(page, { data: DREAM_FIXTURE_PREFIX });
    const u = dreamUi(page, g, false);
    await u.loadFromTitle(1);
    const bells = async () => (await audio(page)).lastSfx.filter((x) => x === 'sfx_bell').length;
    expect(await bells()).toBe(0);
    await u.investigate([0]); // 入夢
    await u.waitMap('fx_tower');
    expect(await bells()).toBe(1);
    await g.waitDialogue();
    await g.finishDialogue();
    await g.faceObject('obj_fx_door');
    await g.act('investigate');
    await g.waitDialogue();
    await g.finishDialogue([0]); // 醒來
    await u.waitMap('attic');
    expect(await bells()).toBe(2);
    expect((await audio(page)).backend).toBe('webaudio');
  });
});

test.describe('M6 P3 真實後端：背景音樂與環境音', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', '真實後端 smoke 只跑 desktop');
  });

  test('新遊戲進閣樓：城市曲＋隔窗雨聲真的在循環播放；開戰時戰鬥曲、環境音壓低；逃跑後接回；解碼的循環 buffer ≤ 100 MB', async ({ page }) => {
    test.setTimeout(120_000);
    const reqs = watchAudioRequests(page);
    const g = game(page);
    await page.goto(REAL_URL);
    await g.newGame('艾琳'); // Enter＝手勢解鎖
    await g.finishDialogue();
    await page.waitForFunction(() => {
      const r = window.__SL.audio().real;
      return r?.loops?.bgm === 'bgm_city' && r?.loops?.amb === 'amb_rain_in';
    }, null, { timeout: 15_000 });
    // 隔窗雨聲與雨聲共用同一個檔（只下載一次）
    expect(reqs.filter((u) => /\/amb\//.test(u)).map((u) => u.replace(/^.*\/audio\//, '').replace(/\.(ogg|m4a)$/, ''))).toEqual(['amb/amb_rain']);
    // 用遊戲自己的開戰流程；逃跑的種子
    const seed = await page.evaluate(async () => {
      const { simulate } = await window.__slImport('./src/core/battle/engine.js');
      const { session } = await window.__slImport('./src/session.js');
      for (let s = 1; s <= 400; s++) if (simulate('enc_dock_1', window.__SL.getState(), session.data, s, () => ({ type: 'flee' })).outcome === 'fled') return s;
      return null;
    });
    expect(seed).not.toBeNull();
    await page.evaluate((s) => history.replaceState(null, '', `${location.pathname}?test=1&audio=1&seed=${s}`), seed);
    await page.evaluate(async () => {
      const { game: phaser } = await window.__slImport('./src/main.js');
      phaser.scene.getScene('Map').doBattle('enc_dock_1');
    });
    await g.waitScene('Battle');
    await page.waitForFunction(() => window.__SL.audio().real?.loops?.bgm === 'bgm_battle', null, { timeout: 15_000 });
    await page.waitForFunction(() => Math.abs(window.__SL.audio().real.ducked.amb - 0.3) < 0.02, null, { timeout: 5_000 });
    expect((await audio(page)).real.loops.amb).toBe('amb_rain_in');
    const r = await g.fightBattle(() => ({ flee: true }));
    expect(r.scene).toBe('Map');
    await page.waitForFunction(() => window.__SL.audio().real?.loops?.bgm === 'bgm_city', null, { timeout: 15_000 });
    await page.waitForFunction(() => Math.abs(window.__SL.audio().real.ducked.amb - 1) < 0.02, null, { timeout: 5_000 });
    const a = await audio(page);
    expect(a.broken).toEqual([]);
    expect(a.real.loopBytes).toBeLessThanOrEqual(100 * 1024 * 1024);
    // 城市曲只下載一次（戰鬥後接回用的是快取裡的 buffer）
    expect(reqs.filter((u) => u.includes('bgm_city'))).toHaveLength(1);
  });
});

test.describe('M6 P3 壓限器（真實瀏覽器）', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', '只跑 desktop');
  });
  test('門檻以下的聲音經過壓限器＋補償抵銷後音量不變（±0.1 dB）；滿刻度被壓到 −1.5 dBFS 以下', async ({ page }) => {
    await page.goto(REAL_URL);
    await page.waitForFunction(() => window.__SL?.currentScene() === 'Title', null, { timeout: 15_000 });
    const r = await page.evaluate(async () => {
      const { LIMITER, LIMITER_TRIM } = await window.__slImport('./src/audio/backend-webaudio.js');
      const out = {};
      for (const amp of [0.05, 0.3, 1]) {
        const sr = 48000;
        const ctx = new OfflineAudioContext(1, sr, sr);
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = amp;
        const c = ctx.createDynamicsCompressor();
        for (const [k, v] of Object.entries(LIMITER)) c[k].value = v;
        const t = ctx.createGain();
        t.gain.value = LIMITER_TRIM;
        o.connect(g).connect(c).connect(t).connect(ctx.destination);
        o.start();
        const d = (await ctx.startRendering()).getChannelData(0).slice(sr / 2);
        let pk = 0;
        for (const x of d) pk = Math.max(pk, Math.abs(x));
        out[amp] = 20 * Math.log10(pk) - 20 * Math.log10(amp);
      }
      return out;
    });
    expect(Math.abs(r[0.05])).toBeLessThan(0.1);
    expect(Math.abs(r[0.3])).toBeLessThan(0.1);
    expect(r[1]).toBeLessThan(-1.5);
  });
});
