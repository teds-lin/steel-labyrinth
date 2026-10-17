// 鐘塔之夢 E2E 共用操作（dream.spec.js 與 cloud-live.spec.js）：讀檔、調查、等聊天畫面、說一句話。
import { makeSave } from './helpers.js';

/** 存檔 v3（有 dream_return）：v1／v2 遷移時 dream_return 一律補 null，所以夢境中的存檔要直接寫 v3。 */
export const makeSaveV3 = (override = {}) => ({
  ...makeSave(), schema_version: 3, party: [{ id: 'hero', hp: null, sp: null }], ammo: 0, pending: null, dream_return: null, ...override,
});

/** 手機用 tap、桌機用滑鼠／鍵盤。 */
export function dreamUi(page, g, touch) {
  const chat = () => page.evaluate(() => window.__SL.chat());
  async function titlePick(label) {
    await g.waitScene('Title', 15_000);
    await page.waitForFunction((l) => (window.__SL.title()?.items ?? []).some((it) => it.label === l && it.enabled), label, { timeout: 8_000 });
    await g.sleep(200);
    const it = (await page.evaluate(() => window.__SL.title())).items.find((x) => x.label === label);
    await g.pointAt(it.x, it.y);
  }
  async function loadFromTitle(slot) {
    await titlePick('繼續');
    await g.waitScene('Menu');
    await g.pickMenu(`存檔 ${slot}`);
    await g.waitScene('Map');
    await g.sleep(150);
  }
  /** 調查面前的物件並播完對話（picks：遇到選項依序選的索引）。 */
  async function investigate(picks = []) {
    await g.act('investigate');
    await g.waitDialogue();
    return g.finishDialogue(picks);
  }
  const waitMap = (id) => page.waitForFunction((m) => window.__SL.getState()?.location.map === m && window.__SL.currentScene() === 'Map', id, { timeout: 8_000 });
  const waitChat = () => page.waitForFunction(() => window.__SL.chat() !== null, null, { timeout: 8_000 });
  const waitReady = () => page.waitForFunction(() => window.__SL.chat()?.inputEnabled === true, null, { timeout: 8_000 });
  async function tapButton(name) {
    const b = (await chat()).buttons[name];
    await g.pointAt(b.x + b.w / 2, b.y + b.h / 2);
  }
  /** 輸入一句並送出：手機點輸入框、用螢幕鍵盤打字、點「送出」；桌機填入後按 Enter。 */
  async function say(text) {
    const n = (await chat()).messages.length;
    const box = page.locator('.sl-chat-input');
    if (touch) {
      await box.tap();
      await page.keyboard.type(text);
      await tapButton('send');
    } else {
      await box.fill(text);
      await box.press('Enter');
    }
    // 等玩家訊息＋夢客回覆都出現、而且不在等待中
    await page.waitForFunction((k) => {
      const c = window.__SL.chat();
      return c && c.messages.length >= k + 2 && !c.busy && !c.waiting;
    }, n, { timeout: 10_000 });
    return (await chat()).messages.at(-1);
  }
  return { chat, titlePick, loadFromTitle, investigate, waitMap, waitChat, waitReady, tapButton, say };
}

