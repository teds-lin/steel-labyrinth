// 夢客回覆的輸出檢查（docs/API.md「鐘塔之夢 修訂 1」D）：正規化 → 各項拒絕規則。
// - 正規化：NFKC → 移除 \p{Cc}、\p{Cf}（零寬、RTL 等）；比對用的版本（compactText）再移除空白、標點、符號、組合記號並轉小寫。
// - 送給玩家的回覆本身也移除 Cc／Cf（stripCcCf；不做 NFKC，全形標點照樣保留）。
// - checkReply 回傳拒絕原因（字串）或 null（通過）。原因只給 log 與測試用，不回給玩家。
// - 拒絕清單（dream_blocklist）的內容只放在私有 repo 的 dream/blocklist.json；公開 repo 的測試只用 fixtures 的假清單。
import { findLexiconHits } from './lexicon.js';

const CC_CF = /[\p{Cc}\p{Cf}]/gu;
/** 方向控制字元（RLO、LRI…）：正常的中文回覆不會出現，出現就當作被操控的輸出。 */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/u;
const NOT_COMPARED = /[\s\p{P}\p{S}\p{M}\p{Z}]/gu;

/** 移除控制與格式字元（零寬、RTL、BOM…）。 */
export const stripCcCf = (s) => String(s).replace(CC_CF, '');
/** NFKC → 移除 Cc／Cf。 */
export const normalizeText = (s) => stripCcCf(String(s).normalize('NFKC'));
/** 比對用：正規化後再移除空白、標點、符號、組合記號，轉小寫（「A I」「ＡＩ」「A​I」都變成 ai）。 */
export const compactText = (s) => normalizeText(s).replace(NOT_COMPARED, '').toLowerCase();

// ---------- 自稱 AI、洩漏設定 ----------
/** 自稱 AI、提到模型或公司（比對 compactText，所以空格、全形、零寬都繞不過）。 */
const AI_SELF_RE = /(?<![a-z])(?:ai|llm|gpt|chatgpt|openai|gemma|gemini|google|qwen|llama|claude|anthropic|cloudflare|deepseek|mistral)(?![a-z])|人工智慧|人工智能|語言模型|語言模組|大型語言|聊天機器人|機器學習|通義千問|虛擬助理|虛擬助手|助理程式/u;
/** 預設的洩漏特徵（提示詞結構用語）；人設檔的 leak_markers 疊加上去。 */
export const DEFAULT_LEAK_MARKERS = [
  '角色扮演', '你從頭到尾都是', '從頭到尾都是', '系統提示', '提示詞', '指示', '人設', '設定檔', '知識卡', '我被設定',
  '絕對規則', '說話範例', '你知道的事', '要迴避', '迴避的話題', '迴避的主題',
];
const COPY_WINDOW = 10;
/** 迴避主題：比對每個主題的前後任意 min(8, 長度) 字；同一則回覆碰到 2 個以上主題才算照抄（只複述玩家問的那一個不算）。 */
const TOPIC_WINDOW = 8;
const TOPIC_MIN = 4;

const windows = (text, n) => {
  const t = [...text];
  const out = [];
  for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n).join(''));
  return out;
};

/** 人設／界線裡用「」『』框起來的是要夢客照說的台詞（例如「真名留在醒著的那一邊」），不算照抄；其餘各段分開比對。 */
const QUOTED = /「[^」]*」|『[^』]*』/gu;

function copiesPersona(c, persona, topics) {
  for (const src of [persona?.persona, persona?.boundaries]) {
    for (const part of String(src ?? '').split(QUOTED)) {
      if (windows(compactText(part), COPY_WINDOW).some((w) => c.includes(w))) return true;
    }
  }
  let hit = 0;
  for (const topic of topics) {
    const t = compactText(topic);
    const len = [...t].length;
    if (len < TOPIC_MIN) continue;
    if (len >= COPY_WINDOW && windows(t, COPY_WINDOW).some((w) => c.includes(w))) return true;
    if (windows(t, Math.min(TOPIC_WINDOW, len)).some((w) => c.includes(w))) hit++;
    if (hit >= 2) return true;
  }
  return false;
}

// ---------- 聯絡方式、網址、假冒系統訊息 ----------
const TLD = 'com|net|org|edu|gov|tw|cn|hk|mo|jp|kr|io|me|cc|xyz|top|info|biz|app|dev|ly|gg|co|us|uk|ru|link|site|online|shop|club|vip|ai|tv|fm|to|so';
const URL_RE = new RegExp(`(?:https?|ftp)://|www\\.|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLD})(?![a-z])|[a-z0-9._%+-]+@[a-z0-9-]+`, 'iu');
const URL_SPOKEN_RE = new RegExp(`(?:點|点|dot)(?:${TLD})(?![a-z])`, 'u');
const DIGITS_RE = /\p{Nd}{6,}/u;
const CONTACT_COMPACT_RE = /(?<![a-z])line(?:id|(?![a-z]))|(?<![a-z])(?:wechat|weixin|whatsapp|telegram|discord|instagram|facebook|messenger|skype|kakao|snapchat|tiktok|qq)(?![a-z])|微信|威信|微訊|臉書|脸书|電報|推特|抖音|小紅書|私訊我|加我好友|加好友|加賴|加我賴|賴我/u;
const CONTACT_SPACED_RE = /(?<![a-z])(?:ig|fb|dm)(?![a-z])/iu;
const FAKE_SYSTEM_START_RE = /^\s*[【\[〔〖]/u;
const FAKE_SYSTEM_COMPACT_START_RE = /^(?:系統|系统|公告|通知)/u;
const FAKE_SYSTEM_WORDS_RE = /轉移碼|转移码|存檔已|存档已|刪除|删除|密碼|密码|帳號|账号|帳户|帳戶|账户/u;

// ---------- 中文字比例 ----------
const CJK_RE = /[\p{Script=Han}\p{Script=Bopomofo}]/u;
export const MIN_CJK_RATIO = 0.6;

// ---------- 拒絕清單 ----------
/**
 * 拒絕清單格式：{ categories: { <分類>: [詞…] }, exceptions?: [例外詞…] }。詞與例外詞都用 compactText 比對。
 * 格式不對就丟錯（呼叫端改用預寫台詞，不在沒有檢查的情況下呼叫 AI）。
 */
export function compileBlocklist(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('拒絕清單不是物件');
  const cats = raw.categories;
  if (cats === null || typeof cats !== 'object' || Array.isArray(cats) || Object.keys(cats).length === 0) throw new Error('拒絕清單缺 categories');
  const terms = [];
  for (const [cat, list] of Object.entries(cats)) {
    if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) throw new Error(`拒絕清單 ${cat} 必須是字串陣列`);
    for (const t of list) {
      const c = compactText(t);
      if (c.length === 0) throw new Error(`拒絕清單 ${cat} 有空字串或只有標點的詞`);
      terms.push({ term: c, category: cat });
    }
  }
  const exceptions = raw.exceptions ?? [];
  if (!Array.isArray(exceptions) || !exceptions.every((t) => typeof t === 'string')) throw new Error('拒絕清單 exceptions 必須是字串陣列');
  return { terms, exceptions: exceptions.map(compactText).filter(Boolean).sort((a, b) => b.length - a.length) };
}

function blocked(c, blocklist) {
  let text = c;
  for (const e of blocklist.exceptions) text = text.split(e).join('|');
  return blocklist.terms.find((t) => text.includes(t.term))?.category ?? null;
}

/**
 * 檢查一則（已清理過 Markdown／HTML、已截斷的）回覆。ctx：{ persona, topics（提示詞裡的迴避主題）, lexicon（已編譯）, blocklist（已編譯） }。
 * 回傳拒絕原因或 null。
 */
export function checkReply(reply, { persona, topics = [], lexicon, blocklist }) {
  const raw = String(reply);
  if (BIDI.test(raw)) return 'bidi';
  const n = normalizeText(raw);
  const c = compactText(raw);
  if (c.length === 0) return null; // 只有「……」之類：沒有可檢查的內容
  if (findLexiconHits(n, lexicon).length > 0 || findLexiconHits(c, lexicon).length > 0) return 'lexicon';
  if (AI_SELF_RE.test(c)) return 'ai_self';
  for (const m of [...DEFAULT_LEAK_MARKERS, ...(persona?.leak_markers ?? [])]) {
    const k = typeof m === 'string' ? compactText(m) : '';
    if (k.length > 0 && c.includes(k)) return 'leak_marker';
  }
  if (copiesPersona(c, persona, topics)) return 'copy';
  if (URL_RE.test(n) || URL_SPOKEN_RE.test(c)) return 'url';
  if (DIGITS_RE.test(c)) return 'digits';
  if (CONTACT_COMPACT_RE.test(c) || CONTACT_SPACED_RE.test(n)) return 'contact';
  if (FAKE_SYSTEM_START_RE.test(n) || FAKE_SYSTEM_COMPACT_START_RE.test(c) || FAKE_SYSTEM_WORDS_RE.test(c)) return 'fake_system';
  const chars = [...c];
  if (chars.filter((ch) => CJK_RE.test(ch)).length < chars.length * MIN_CJK_RATIO) return 'non_chinese';
  const cat = blocked(c, blocklist);
  if (cat) return `blocklist:${cat}`;
  return null;
}
