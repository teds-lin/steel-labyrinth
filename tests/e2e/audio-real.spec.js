// M6 真實音訊後端 smoke（只跑 desktop）：?test=1&audio=1 用 WebAudioBackend（其餘測試模式行為照舊）。
// AudioContext 預設被包成「要等手勢才能出聲」（見 audio-real-fixture.js）；允許自動播放的情況在 audio-autoplay.spec.js。
import { expect, game, seedSaves, makeSave } from './helpers.js';
import { dreamUi } from './dream-ui.js';
import { useDreamFixture, DREAM_FIXTURE_PREFIX } from './dream-fixture.js';
import { test, FILE_CUES, REAL_URL, audio, watchAudioRequests, gesture, waitLoaded } from './audio-real-fixture.js';

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
    expect(reqs).toHaveLength(FILE_CUES.length);
    expect(new Set(reqs.map((u) => u.replace(/\.(ogg|m4a)$/, ''))).size).toBe(FILE_CUES.length);
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
      expect(reqs.filter((u) => u.includes('ui_error'))).toEqual(['/audio/sfx/ui_error.ogg', '/audio/sfx/ui_error.m4a']);
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
