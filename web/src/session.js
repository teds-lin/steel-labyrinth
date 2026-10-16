// 遊戲階段（session）：畫面層唯一持有「目前 state」的地方。
// core 的 state 不可變，這裡只負責「換成新的 state」並通知各場景重畫。
import { createStorage } from './core/save.js';

function getLocalStorage() {
  try {
    const ls = window.localStorage;
    return ls ?? null;
  } catch {
    return null; // 瀏覽器封鎖儲存空間（例如停用 Cookie）時，存取本身就會丟錯
  }
}

const backend = getLocalStorage();

export const session = {
  /** 已驗證的資料 bundle（Boot 填入）。 */
  data: null,
  /** 目前的遊戲 state；在標題畫面時為 null。 */
  state: null,
  storage: createStorage(backend),
  storageAvailable: backend !== null,
  events: new Phaser.Events.EventEmitter(),
  /** 目前畫面（給 E2E 掛勾與除錯用）。 */
  scene: 'Boot',
  /** 對話進行中的目前節點（由對話框維護）；沒有對話時為 null。 */
  dialogueView: null,
  get inDialogue() { return this.dialogueView !== null || this.dialogueBusy; },
  dialogueBusy: false,
  /** 尚未併入 state.playtime_s 的秒數（對話進行中 state 由對話執行器持有，先暫存）。 */
  elapsed: 0,

  setState(next) {
    this.state = next;
    this.events.emit('state', next);
  },

  /** 把累積的整數秒併入 playtime_s（只在沒有對話時呼叫）。 */
  foldPlaytime() {
    if (!this.state || this.inDialogue) return;
    const whole = Math.floor(this.elapsed);
    if (whole <= 0) return;
    this.elapsed -= whole;
    this.setState({ ...this.state, playtime_s: (this.state.playtime_s ?? 0) + whole });
  },

  /** 含尚未併入秒數的 state（存檔、E2E 用）。 */
  snapshot() {
    if (!this.state) return null;
    return { ...this.state, playtime_s: (this.state.playtime_s ?? 0) + Math.floor(this.elapsed) };
  },

  reset() {
    this.state = null;
    this.elapsed = 0;
    this.dialogueView = null;
    this.dialogueBusy = false;
  },

  mapById(id) {
    return this.data?.maps?.find((m) => m.id === id) ?? null;
  },

  dialogueById(id) {
    for (const ch of this.data?.story ?? []) {
      const d = (ch.dialogues ?? []).find((x) => x.id === id);
      if (d) return d;
    }
    return null;
  },

  mapName(id) {
    return this.mapById(id)?.name ?? id ?? '';
  },
};

/** 同一個原生鍵盤事件只讓一個處理者使用（多個場景都會收到同一個事件）。 */
export function claimKey(event) {
  if (!event || event.__slClaimed) return false;
  event.__slClaimed = true;
  return true;
}

/** 秒數 → 「時:分:秒」。 */
export function formatPlaytime(sec) {
  const s = Math.max(0, Math.floor(sec ?? 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
