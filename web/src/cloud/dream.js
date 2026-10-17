// 夢客自由交談的客戶端邏輯（純邏輯，不碰 Phaser／DOM）：輸入整理、送給伺服器的歷史、結果整理、夢境通行證。
// 規格：docs/API.md「鐘塔之夢（M4）」。通行證只存在記憶體（不寫 localStorage），重新整理後要重新驗證。
import { waitText } from './sync.js';

export const MAX_INPUT_CHARS = 120;
export const MAX_HISTORY = 6;
export const MAX_HISTORY_CHARS = 150;
/** 通行證剩不到這個秒數就當作過期（避免送出途中過期）。 */
export const PASS_MARGIN_S = 60;

export const DREAM_MSG = Object.freeze({
  turnstileFailed: '人機驗證失敗，請再試一次',
  unavailable: '夢境暫時無法連線，請稍後再試',
  relink: '此裝置的雲端連結已失效，請重新用轉移碼接續',
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 去頭尾空白、移除控制字元（Cc）與格式字元（Cf，例如零寬字元、方向控制）。與伺服器的整理方式相同。 */
export function cleanChatInput(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
}

/** 以字元（code point）計算長度。 */
export const charCount = (s) => (typeof s === 'string' ? Array.from(s).length : 0);

/** 截到最多 n 個字元（輸入框即時限制用）。 */
export function clampInput(s, n = MAX_INPUT_CHARS) {
  if (typeof s !== 'string') return '';
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join('') : s;
}

/**
 * 對話紀錄 → 送給伺服器的 history：只取玩家說的話與 AI 的回覆（預寫台詞、開場白、說明不送），
 * 最近 MAX_HISTORY 則，每則最多 MAX_HISTORY_CHARS 字。
 */
export function buildHistory(log) {
  if (!Array.isArray(log)) return [];
  return log
    .filter((m) => isObj(m) && typeof m.text === 'string' && (m.role === 'player' || (m.role === 'guest' && m.source === 'ai')))
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, text: clampInput(m.text, MAX_HISTORY_CHARS) }));
}

/** 伺服器的 reason → 預寫台詞的種類。 */
export function scriptedKindFor(reason) {
  if (reason === 'quota' || reason === 'budget') return 'quota';
  if (reason === 'filtered') return 'filtered';
  return 'fallback';
}

/**
 * API 結果 → 畫面要做的事：
 * - { type:'reply', text, source:'ai'|'scripted', reason, remaining }
 * - { type:'pass_invalid' }：重新做人機驗證取得通行證
 * - { type:'unauthorized' }：雲端連結失效
 * - { type:'fallback', kind:'fallback' }：網路錯誤、逾時、429、5xx、回應格式不對 → 播該夢客的 fallback 預寫台詞
 */
export function interpretChat(r) {
  if (r?.ok) {
    const b = r.body;
    if (isObj(b) && typeof b.reply === 'string' && b.reply.trim() !== '' && (b.source === 'ai' || b.source === 'scripted')) {
      const remaining = Number.isInteger(b.remaining_today) && b.remaining_today >= 0 ? b.remaining_today : null;
      return { type: 'reply', text: b.reply, source: b.source, reason: typeof b.reason === 'string' ? b.reason : null, remaining };
    }
    return { type: 'fallback', kind: 'fallback' };
  }
  if (r?.status === 401) return r.error === 'pass_invalid' ? { type: 'pass_invalid' } : { type: 'unauthorized' };
  return { type: 'fallback', kind: 'fallback' };
}

/**
 * 夢境通行證與對話。api：createCloudApi 的結果（dreamPass、dreamChat）。now：毫秒。
 * 通行證、剩餘句數都只在這個物件裡（記憶體）。
 */
export function createDreamClient({ api, now = () => Date.now() } = {}) {
  let pass = null;
  let expiresAt = 0;
  let remaining = null;
  const nowSec = () => Math.floor(now() / 1000);

  return {
    hasPass: () => typeof pass === 'string' && expiresAt - PASS_MARGIN_S > nowSec(),
    clearPass() { pass = null; expiresAt = 0; },
    /** 最後一次伺服器回報的今日剩餘句數；還不知道時為 null。 */
    remaining: () => remaining,

    /** 用 Turnstile token 換通行證（回應的 remaining_today 一併記下）。回傳 { ok:true } 或 { ok:false, kind, message }。 */
    async obtainPass(turnstileToken) {
      const r = await api.dreamPass(turnstileToken);
      if (r?.ok) {
        const b = r.body;
        if (isObj(b) && typeof b.pass === 'string' && b.pass !== '' && Number.isInteger(b.expires_at)) {
          pass = b.pass;
          expiresAt = b.expires_at;
          // API.md 鐘塔之夢補充：通行證回應帶今日剩餘句數，取得後立即顯示（舊版伺服器沒有這個欄位時維持原值）
          if (Number.isInteger(b.remaining_today) && b.remaining_today >= 0) remaining = b.remaining_today;
          return { ok: true };
        }
        return { ok: false, kind: 'unavailable', message: DREAM_MSG.unavailable };
      }
      if (r?.status === 403 && r.error === 'turnstile_failed') return { ok: false, kind: 'turnstile_failed', message: DREAM_MSG.turnstileFailed };
      if (r?.status === 401) return { ok: false, kind: 'unauthorized', message: DREAM_MSG.relink };
      if (r?.status === 429) {
        const w = waitText(r.retryAfter);
        return { ok: false, kind: 'rate_limited', message: w ? `驗證次數太多了，請等${w.startsWith('約') ? '' : ' '}${w}後再試` : '驗證次數太多了，請稍後再試' };
      }
      return { ok: false, kind: 'unavailable', message: DREAM_MSG.unavailable };
    },

    /** 說一句話。沒有有效通行證時不送請求，直接回 pass_invalid。 */
    async chat({ guest, chapter, history, input }) {
      if (!this.hasPass()) return { type: 'pass_invalid' };
      const r = await api.dreamChat({ pass, guest, chapter, history, input });
      const out = interpretChat(r);
      if (out.type === 'pass_invalid') this.clearPass();
      if (out.type === 'reply' && out.remaining !== null) remaining = out.remaining;
      return out;
    },
  };
}
