// 遊戲階段（session）：畫面層唯一持有「目前 state」的地方。
// core 的 state 不可變，這裡只負責「換成新的 state」並通知各場景重畫。
import { createStorage, sanitizeLoadedState, SLOT_COUNT, AUTO_KEY } from './core/save.js';

/** deserialize 的拒絕原因是否為「存檔版本比遊戲新」（core 的拒絕都帶 code）。 */
const isNewerVersion = (r) => r?.code === 'newer';

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
    this.battleReturn = null;
    this.preBattle = null;
    this.elapsed = 0;
    this.dialogueView = null;
    this.dialogueBusy = false;
  },

  /**
   * 戰前自動存檔：成功回 { ok:true }。寫入失敗時把舊的自動存檔刪掉（避免之後被當成這場戰鬥的戰前狀態），
   * 回 { ok:false, notice } 給畫面提示玩家。儲存空間本來就不能用時（unavailable）不提示，只靠記憶體備份。
   */
  saveBattleAuto(state, encounter) {
    let r;
    try {
      r = this.storage.saveAuto(state, { battle: encounter });
    } catch (e) {
      r = { ok: false, code: 'storage_error', reason: String(e?.message ?? e) };
    }
    if (r?.ok || r?.code === 'unavailable') return { ok: true };
    console.warn(`自動存檔失敗（${r?.code}）：${r?.reason}`);
    try {
      backend?.removeItem(AUTO_KEY);
    } catch (e) {
      console.warn(`無法清除舊的自動存檔：${e?.message ?? e}`);
    }
    return { ok: false, notice: '自動存檔失敗：重新整理頁面後將無法重新挑戰這場戰鬥' };
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

  /**
   * 讀檔流程：storage.load（deserialize）→ sanitizeLoadedState。
   * 回傳 { ok:true, state, warnings } 或 { ok:false, reason, kind:'empty'|'newer'|'broken' }。
   */
  loadSlot(slot) {
    let r;
    try {
      r = this.storage.load(slot);
    } catch (e) {
      return { ok: false, kind: 'broken', reason: String(e?.message ?? e) };
    }
    if (!r.ok) {
      if (r.code === 'empty') return { ok: false, kind: 'empty', reason: '這個存檔槽是空的' };
      return { ok: false, kind: isNewerVersion(r) ? 'newer' : 'broken', reason: String(r.reason ?? '存檔損壞') };
    }
    let s;
    try {
      s = sanitizeLoadedState(r.state, this.data);
    } catch (e) {
      return { ok: false, kind: 'broken', reason: `存檔內容有誤：${e?.message ?? e}` };
    }
    if (!s?.ok) return { ok: false, kind: 'broken', reason: String(s?.reason ?? '存檔內容有誤') };
    return { ok: true, state: s.state, warnings: Array.isArray(s.warnings) ? s.warnings : [] };
  },

  /** 每個存檔槽的摘要（標題與讀取選單用）。kind：'ok'|'empty'|'newer'|'broken'。 */
  slotSummaries() {
    const out = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot++) {
      const r = this.loadSlot(slot);
      if (r.ok) {
        const st = r.state;
        out.push({ slot, kind: 'ok', name: st.player.name, map: st.location.map, playtime_s: st.playtime_s });
      } else {
        out.push({ slot, kind: r.kind, reason: r.reason });
      }
    }
    return out;
  },

  /** 有沒有任何非空的存檔槽（包含損壞的）：標題「繼續」用。 */
  hasAnySave() {
    if (!this.storageAvailable) return false;
    return this.slotSummaries().some((s) => s.kind !== 'empty');
  },

  mapName(id) {
    return this.mapById(id)?.name ?? id ?? '';
  },

  storyById(id) {
    return this.data?.story?.find((c) => c?.id === id) ?? null;
  },

  /**
   * 讀檔後要進哪個畫面：存檔停在「已完成、而且有下一章（end_screen.continue）」的章節結尾時，
   * 回到章節結束畫面（可以按「繼續」進下一章）；其他情況回地圖。
   */
  resumeTarget(state, notices = []) {
    const ch = state?.chapter;
    const done = Array.isArray(state?.chapter_done) ? state.chapter_done : [];
    if (typeof ch === 'string' && done.includes(ch) && this.storyById(ch)?.end_screen?.continue) {
      return { scene: 'ChapterEnd', data: { chapter: ch, notices } };
    }
    return { scene: 'Map', data: { notices } };
  },

  /** 戰鬥結束時呼叫（地圖場景設定），戰鬥結果交回地圖繼續劇情。 */
  battleReturn: null,
  /** 戰前狀態的記憶體備份（儲存空間不能用時，「重新挑戰」改用它）：{ state, encounter }。 */
  preBattle: null,
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
