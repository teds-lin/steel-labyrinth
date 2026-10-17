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
/**
 * 預設的洩漏特徵（提示詞結構用語）；人設檔的 leak_markers 疊加上去。
 * 最後一輪修正（m4-review-c）：只用較長、日常說話不會出現的片語（「指示」「你知道的事」「要迴避」「從頭到尾都是」會誤殺
 * 「指針指示著三點」「你知道的事，比你以為的還多」「你要迴避也可以」「從頭到尾都是同一組」）。
 */
export const DEFAULT_LEAK_MARKERS = [
  '角色扮演', '系統提示', '提示詞', '設定檔', '知識卡', '我被設定', '我的設定是', '我的人設', '人設是',
  '我收到的指示', '收到的指示是', '給我的指示', '說話範例', '絕對規則', '我要迴避的', '迴避的話題', '迴避的主題',
];
/** 提示詞的段落標題被照抄（比對 normalizeText，保留括號）：【你知道的事】【要迴避的話題】… */
const PROMPT_HEADER_RE = /[【\[]\s*(?:你是誰|說話範例|你知道的事|要迴避的話題|界線|絕對規則)\s*[】\]]|我要迴避\s*[:：]/u;
/**
 * 洩漏特徵比對前先拿掉的常用詞：「設」屬於後一個詞時（替別人設想、設計、設置…），「人設」不是人設。
 * 人設檔的 leak_markers 常含「人設」，所以在這裡統一處理，不改人設檔。
 */
const MARKER_SAFE_RE = /設(?=[想計置施立下法局宴身])/gu;
/** 照抄提示詞的開頭「你從頭到尾都是<名字>本人」。 */
const selfIntroMarker = (persona) => (typeof persona?.name === 'string' && persona.name !== '' ? `從頭到尾都是${persona.name}本人` : null);
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
/**
 * 聯絡方式（比對 compactText）。最後一輪修正：拿掉會撞到正常中文的「賴我」（別賴我）、「威信」（守燈人的威信）、「電報」（電報局）；
 * 保留明確的 LINE ID、加我 LINE／加我的賴、各平台名稱。
 */
const CONTACT_COMPACT_RE = /(?<![a-z])line(?:id|(?![a-z]))|(?<![a-z])(?:wechat|weixin|whatsapp|telegram|discord|instagram|facebook|messenger|skype|kakao|snapchat|tiktok|qq)(?![a-z])|微信|微訊|臉書|脸书|推特|抖音|小紅書|私訊我|加我好友|加好友|加賴|加我賴|加我的賴|賴的帳號|賴帳號/u;
const CONTACT_SPACED_RE = /(?<![a-z])(?:ig|fb|dm)(?![a-z])/iu;
/**
 * 假冒系統訊息（最後一輪修正：只認明確的標記與片語，「通知你一聲」「系統性的」「公告欄」不算）：
 * - 標記：【系統】【公告】［系統公告］〔通知〕…（括號裡是系統／公告／通知／官方／管理員／客服／GM 開頭）；
 * - 句首（或句號後）「系統：」「公告：」「通知：」「管理員：」；
 * - 片語：系統通知、系統公告、系統訊息、官方公告。
 */
const FAKE_SYSTEM_MARK_RE = /[【\[〔〖]\s*(?:系統|系统|公告|通知|官方|管理員|管理员|客服|gm)/iu;
const FAKE_SYSTEM_HEAD_RE = /(?:^|[。！？!?\n])\s*(?:系統|系统|公告|通知|管理員|管理员|官方)\s*[:：]/u;
const FAKE_SYSTEM_PHRASE_RE = /系統通知|系统通知|系統公告|系统公告|系統訊息|系统消息|官方公告/u;
/** 轉移碼、帳號、存檔已…單獨出現就算（遊戲裡夢客沒有理由提到）。 */
const ACCOUNT_RE = /轉移碼|转移码|存檔已|存档已|帳號|账号|帳户|帳戶|账户/u;
/** 「密碼」「刪除」要和轉移碼／帳號／存檔一起出現，或是在索取（你的密碼、密碼告訴我）才算（紙條上的密碼、把記憶刪除不算）。 */
const SENSITIVE_RE = /密碼|密码|刪除|删除/u;
const SENSITIVE_CONTEXT_RE = /轉移碼|转移码|帳號|账号|帳户|帳戶|账户|存檔|存档/u;
const ASK_SECRET_RE = /(?:你的|輸入|提供|告訴我|給我|交出)(?:[^。！？!?]{0,6})(?:密碼|密码)|(?:密碼|密码)(?:[^。！？!?]{0,6})(?:告訴我|給我|交給|傳給|輸入|提供)/u;

function fakeSystem(n, c) {
  if (FAKE_SYSTEM_MARK_RE.test(n) || FAKE_SYSTEM_HEAD_RE.test(n) || FAKE_SYSTEM_PHRASE_RE.test(c)) return true;
  if (ACCOUNT_RE.test(c)) return true;
  return SENSITIVE_RE.test(c) && (SENSITIVE_CONTEXT_RE.test(c) || ASK_SECRET_RE.test(n));
}

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

/**
 * 切段：以標點與換行切開，拒絕清單不跨段比對（「三點十六，四點」不會湊成數字形的詞）。
 * 空白、符號、連接號與間隔號（- _ · ・）不切：「假 髒 話」「假-髒-話」照樣繞不過。
 */
const SEGMENT_SPLIT_RE = /[[\p{P}\n\r]--[\p{Pd}\p{Pc}·・‧]]+/v;
/** 數字形的詞（只由數字或中文數字組成，例如真清單裡的日期詞）：前後緊鄰其他數字時不算（「一六四」「三點六四分」不是那個詞）。 */
const NUMERAL = '0-9〇零一二三四五六七八九十百千兩';
const NUMERIC_TERM_RE = new RegExp(`^[${NUMERAL}]+$`, 'u');
const NUMERAL_RE = new RegExp(`[${NUMERAL}]`, 'u');

/** 段落裡每個例外詞出現的範圍 [起, 迄)。 */
function exceptionSpans(seg, exceptions) {
  const spans = [];
  for (const e of exceptions) for (let i = seg.indexOf(e); i >= 0; i = seg.indexOf(e, i + 1)) spans.push([i, i + e.length]);
  return spans;
}

/**
 * 這一段有沒有這個詞：被某個例外詞完全涵蓋的那一次不算（只遮住例外詞自己的範圍：「其中共」不會放過「其中共產黨」裡的「共產黨」）；
 * 數字形的詞前後緊鄰其他數字也不算。
 */
function segmentHas(seg, term, spans) {
  const numeric = NUMERIC_TERM_RE.test(term);
  for (let i = seg.indexOf(term); i >= 0; i = seg.indexOf(term, i + 1)) {
    const end = i + term.length;
    if (spans.some(([s, e]) => s <= i && end <= e)) continue;
    if (numeric && ((i > 0 && NUMERAL_RE.test(seg[i - 1])) || (end < seg.length && NUMERAL_RE.test(seg[end])))) continue;
    return true;
  }
  return false;
}

/** 拒絕清單：每一段各自比對；回傳命中的分類或 null。 */
function blocked(n, blocklist) {
  for (const part of n.split(SEGMENT_SPLIT_RE)) {
    const seg = compactText(part);
    if (seg.length === 0) continue;
    const spans = exceptionSpans(seg, blocklist.exceptions);
    const hit = blocklist.terms.find((t) => segmentHas(seg, t.term, spans));
    if (hit) return hit.category;
  }
  return null;
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
  const mc = c.replace(MARKER_SAFE_RE, '|');
  for (const m of [...DEFAULT_LEAK_MARKERS, ...(persona?.leak_markers ?? []), selfIntroMarker(persona)]) {
    const k = typeof m === 'string' ? compactText(m) : '';
    if (k.length > 0 && mc.includes(k)) return 'leak_marker';
  }
  if (PROMPT_HEADER_RE.test(n)) return 'leak_marker';
  if (copiesPersona(c, persona, topics)) return 'copy';
  if (URL_RE.test(n) || URL_SPOKEN_RE.test(c)) return 'url';
  if (DIGITS_RE.test(c)) return 'digits';
  if (CONTACT_COMPACT_RE.test(c) || CONTACT_SPACED_RE.test(n)) return 'contact';
  if (fakeSystem(n, c)) return 'fake_system';
  // 中文比例不計阿拉伯數字（「嗯，12點。」「3點15分。」）；長串數字另由 DIGITS_RE 把關
  const chars = [...c].filter((ch) => !/\p{Nd}/u.test(ch));
  if (chars.filter((ch) => CJK_RE.test(ch)).length < chars.length * MIN_CJK_RATIO) return 'non_chinese';
  const cat = blocked(n, blocklist);
  if (cat) return `blocklist:${cat}`;
  return null;
}
