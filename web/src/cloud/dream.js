// 夢客自由交談的客戶端邏輯（純邏輯，不碰 Phaser／DOM）：輸入整理、送給伺服器的歷史、結果整理、夢境通行證。
// 規格：docs/API.md「鐘塔之夢（M4）」。通行證只存在記憶體（不寫 localStorage），重新整理後要重新驗證。
import { waitText } from './sync.js';

export const MAX_INPUT_CHARS = 120;
export const MAX_HISTORY = 6;
export const MAX_HISTORY_CHARS = 150;
/** 通行證剩不到這個秒數就當作過期（避免送出途中過期）。ttl_s 很短時改用 ttl_s 的一半。 */
export const PASS_MARGIN_S = 60;
/** 舊版伺服器的回應沒有 ttl_s 時，通行證當作只有這麼久（伺服器的 401 pass_invalid 才是準的）。 */
export const PASS_DEFAULT_TTL_S = 600;
/** ttl_s 的上限（防止異常值）。 */
export const PASS_MAX_TTL_S = 86400;

export const DREAM_MSG = Object.freeze({
  turnstileFailed: '人機驗證失敗，請再試一次',
  unavailable: '夢境暫時無法連線，請稍後再試',
  relink: '此裝置的雲端連結已失效，請重新用轉移碼接續',
  /** 重新驗證後伺服器仍然不認通行證（一次送出最多重新驗證 1 次，修訂 1 B）。 */
  passRejected: '夢境通行證無法使用，請稍後再試。',
  /** 今日句數用完（remaining_today 是 0）。 */
  quotaUsedUp: '今天的交談次數已經用完了，明天再來吧。',
  /** 伺服器回 reason quota／budget 但還有句數（AI 呼叫次數或全站預算用完）：不說「次數用完」，免得和剩餘句數互相矛盾。 */
  dreamBlurred: '夢境今天變得模糊了，明天再來吧。',
  /** 被每分鐘上限（429）擋下、沒有送到夢客那裡的玩家訊息。 */
  unsent: '沒有送出',
});

/**
 * 交談畫面的額度顯示（最後一輪修正）：
 * - remaining 是 0 → 「今日剩餘 0 句」＋句數用完；
 * - 伺服器回過 quota／budget 但還有句數 → 剩餘句數顯示「—」＋「夢境今天變得模糊了」（不同時顯示「剩 20 句」與「用完了」）；
 * - 其他 → 剩餘句數（還不知道時「—」），沒有提示。
 */
export function chatQuotaView({ remaining, quotaHit }) {
  if (remaining === 0) return { remainingLabel: '今日剩餘 0 句', note: DREAM_MSG.quotaUsedUp, locked: true };
  if (quotaHit) return { remainingLabel: '今日剩餘 — 句', note: DREAM_MSG.dreamBlurred, locked: true };
  return { remainingLabel: `今日剩餘 ${Number.isInteger(remaining) ? remaining : '—'} 句`, note: null, locked: false };
}

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

const isSig = (v) => typeof v === 'string' && v !== '';

/**
 * 對話紀錄 → 送給伺服器的 history（API.md 鐘塔之夢 修訂 1 C）：
 * - 玩家說的話：最多 MAX_HISTORY_CHARS 字；被每分鐘 429 擋下的（unsent）不送；
 * - 夢客的回覆：只送伺服器簽過章的（有 sig；ai 與伺服器的 scripted 都有），文字與 sig 原樣送回
 *   （修訂 1a 4：text 必須與收到的 reply 完全相同——紀錄裡存原文，畫面上才移除 Cc／Cf）。
 *   開場白、離線的預寫台詞、說明沒有 sig → 不送。簽過的文字不能截斷（截了簽章就對不上），超過上限就整則不送。
 * 最近 MAX_HISTORY 則。
 */
export function buildHistory(log) {
  if (!Array.isArray(log)) return [];
  const out = [];
  for (const m of log) {
    if (!isObj(m) || typeof m.text !== 'string') continue;
    if (m.role === 'player') {
      if (m.unsent === true) continue; // 被每分鐘 429 擋下、伺服器沒收到的訊息不送（最後一輪修正）
      out.push({ role: 'player', text: clampInput(m.text, MAX_HISTORY_CHARS) });
    }
    else if (m.role === 'guest' && isSig(m.sig) && charCount(m.text) <= MAX_HISTORY_CHARS) {
      out.push({ role: 'guest', text: m.text, sig: m.sig });
    }
  }
  return out.slice(-MAX_HISTORY);
}

/** 夢客回覆顯示前再移除 Cc／Cf（伺服器也會移除，這是雙保險；修訂 1 D），並去頭尾空白。 */
export const cleanReply = (s) => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '');

/** 伺服器的 reason → 預寫台詞的種類。 */
export function scriptedKindFor(reason) {
  if (reason === 'quota' || reason === 'budget') return 'quota';
  if (reason === 'filtered') return 'filtered';
  return 'fallback';
}

/**
 * API 結果 → 畫面要做的事：
 * - { type:'reply', text（伺服器的 reply 原文，存紀錄與送 history 用）, display（畫面用，已移除 Cc／Cf）, sig（回覆簽章或 null）,
 *     source:'ai'|'scripted', reason, remaining }
 * - { type:'rate_limited', retryAfter }：429（每分鐘超過上限，不扣句數；修訂 1 A）
 * - { type:'pass_invalid' }：重新做人機驗證取得通行證
 * - { type:'unauthorized' }：雲端連結失效
 * - { type:'fallback', kind:'fallback' }：網路錯誤、逾時、429、5xx、回應格式不對 → 播該夢客的 fallback 預寫台詞
 */
export function interpretChat(r) {
  if (r?.ok) {
    const b = r.body;
    const display = isObj(b) ? cleanReply(b.reply) : '';
    if (display !== '' && (b.source === 'ai' || b.source === 'scripted')) {
      const remaining = Number.isInteger(b.remaining_today) && b.remaining_today >= 0 ? b.remaining_today : null;
      return {
        type: 'reply', text: b.reply, display, sig: isSig(b.sig) ? b.sig : null,
        source: b.source, reason: typeof b.reason === 'string' ? b.reason : null, remaining,
      };
    }
    return { type: 'fallback', kind: 'fallback' };
  }
  if (r?.status === 401) return r.error === 'pass_invalid' ? { type: 'pass_invalid' } : { type: 'unauthorized' };
  if (r?.status === 429) return { type: 'rate_limited', retryAfter: Number.isFinite(r.retryAfter) ? r.retryAfter : null };
  return { type: 'fallback', kind: 'fallback' };
}

/** 單調時鐘（毫秒）：不受使用者調整裝置時間影響。 */
const monotonicNow = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());

/** 回應的 ttl_s：正數就用（夾到 PASS_MAX_TTL_S）；沒有這個欄位 → 預設值；其他（0、負數、非數字）→ null（回應不合法）。 */
function ttlOf(b) {
  if (b.ttl_s === undefined) return PASS_DEFAULT_TTL_S;
  if (typeof b.ttl_s !== 'number' || !Number.isFinite(b.ttl_s) || b.ttl_s <= 0) return null;
  return Math.min(b.ttl_s, PASS_MAX_TTL_S);
}

/**
 * 夢境通行證與對話。api：createCloudApi 的結果（dreamPass、dreamChat）。now：毫秒（預設單調時鐘）。
 * 通行證、剩餘句數都只在這個物件裡（記憶體）。
 * 過期判斷（API.md 鐘塔之夢 修訂 1 B）：收到回應的本機時間＋ttl_s；不拿 expires_at 和裝置時鐘比（裝置時鐘可能不準）。
 */
export function createDreamClient({ api, now = monotonicNow } = {}) {
  let pass = null;
  let deadline = 0; // 毫秒（now() 的時間軸）：超過就當作過期
  let remaining = null;
  let quotaHit = false; // 伺服器回過 reason quota／budget（可能 remaining_today > 0：當日 AI 呼叫次數、每 IP 呼叫次數或全站預算用完）

  return {
    hasPass: () => typeof pass === 'string' && now() < deadline,
    clearPass() { pass = null; deadline = 0; },
    /** 最後一次伺服器回報的今日剩餘句數；還不知道時為 null。 */
    remaining: () => remaining,
    /** 這張通行證期間伺服器回過 reason quota 或 budget（今天不能再說；重新取得通行證時清除）。 */
    quotaHit: () => quotaHit,

    /** 用 Turnstile token 換通行證（回應的 remaining_today 一併記下）。回傳 { ok:true } 或 { ok:false, kind, message }。 */
    async obtainPass(turnstileToken) {
      const r = await api.dreamPass(turnstileToken);
      if (r?.ok) {
        const b = r.body;
        const ttl = isObj(b) ? ttlOf(b) : null;
        if (isObj(b) && typeof b.pass === 'string' && b.pass !== '' && ttl !== null) {
          pass = b.pass;
          deadline = now() + (ttl - Math.min(PASS_MARGIN_S, ttl / 2)) * 1000;
          quotaHit = false;
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
      if (out.type === 'reply' && (out.reason === 'quota' || out.reason === 'budget')) quotaHit = true;
      return out;
    },
  };
}
