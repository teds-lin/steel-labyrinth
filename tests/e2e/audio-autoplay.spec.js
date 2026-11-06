// M6 真實音訊後端：瀏覽器允許自動播放（context 一開始就 running、Phaser 不會鎖）時，仍要等第一次手勢才下載與播放。
// launchOptions 會強制開新 worker，只能寫在檔案最上層，所以獨立成一個檔。只跑 desktop。
import { expect, game } from './helpers.js';
import { test, FILE_CUES, REAL_URL, audio, watchAudioRequests, gesture, waitLoaded } from './audio-real-fixture.js';

test.use({ gateAudio: false, launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

test.describe('M6 真實音訊後端：允許自動播放', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === 'mobile', '真實後端 smoke 只跑 desktop');
  });

  test('context 一開始就 running 時，手勢前仍不下載任何音檔；手勢後才載入', async ({ page }) => {
    const reqs = watchAudioRequests(page);
    const g = game(page);
    await page.goto(REAL_URL);
    await g.waitScene('Title', 15_000);
    await g.sleep(1000);
    const a0 = await audio(page);
    expect(a0.real.state, '這個測試的前提：自動播放被允許').toBe('running');
    expect(a0.unlocked).toBe(false);
    expect(reqs).toEqual([]);
    await gesture(page);
    await waitLoaded(page, FILE_CUES.length);
    expect((await audio(page)).unlocked).toBe(true);
  });
});
