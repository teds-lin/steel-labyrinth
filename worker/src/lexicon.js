// 夢客回覆的簡體字／陸用語檢查（docs/API.md「鐘塔之夢」輸出處理）。
// 詞表由 tools/gen-dream-lexicon.mjs 從 sdg_pipeline 的 lexicon.yaml 產生（唯一來源，禁止手改），部署時上傳到 D1 的 dream_lexicon。
// 格式：{ chars: [單一簡體字…], words: [陸用語…], exceptions: [例外詞…], word_rules: { 詞: { pre, post, exc } } }
// - chars：只有 simplified_only 與開放集（dragonmapper 判定）的簡體字形；also_traditional（于、后…）不在其中。
// - exceptions：例外詞範圍內的字不算（例：人名、專名）；word_rules 的 pre／post：前一字／後一字在清單內就不算；exc：該詞自己的例外詞。
// - AI 回覆一律嚴格檢查：引號、問句裡的詞照樣算（模型會用反問語氣複述玩家的陸用語，例如「網絡？信息？」）。

const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 檢查格式並預先編譯；格式不對就丟錯（呼叫端改用預寫台詞，不在沒有檢查的情況下呼叫 AI）。 */
export function compileLexicon(lex) {
  if (lex === null || typeof lex !== 'object' || Array.isArray(lex)) throw new Error('詞表不是物件');
  if (!isStrArray(lex.chars) || lex.chars.some((c) => [...c].length !== 1)) throw new Error('詞表 chars 必須是單一字元的陣列');
  if (!isStrArray(lex.words)) throw new Error('詞表 words 必須是非空字串的陣列');
  const exceptions = lex.exceptions ?? [];
  if (!isStrArray(exceptions)) throw new Error('詞表 exceptions 必須是字串陣列');
  const rules = new Map();
  for (const [term, r] of Object.entries(lex.word_rules ?? {})) {
    rules.set(term, {
      pre: new Set(Array.isArray(r?.pre) ? r.pre : []),
      post: new Set(Array.isArray(r?.post) ? r.post : []),
      exc: (Array.isArray(r?.exc) ? r.exc : []).filter((p) => typeof p === 'string' && p.includes(term)),
    });
  }
  const words = [...new Set(lex.words)].sort((a, b) => b.length - a.length); // 長詞優先
  return {
    chars: new Set(lex.chars),
    wordRe: words.length ? new RegExp(words.map(escapeRe).join('|'), 'gu') : null,
    rules,
    exceptions: exceptions.filter((e) => e.length > 0),
  };
}

/** 例外詞覆蓋到的字元位置（UTF-16 索引）。 */
function maskedPositions(text, exceptions) {
  const masked = new Set();
  for (const e of exceptions) {
    let i = text.indexOf(e);
    while (i !== -1) {
      for (let k = i; k < i + e.length; k++) masked.add(k);
      i = text.indexOf(e, i + 1);
    }
  }
  return masked;
}

function wordCancelled(text, pos, term, rule) {
  if (!rule) return false;
  const before = [...text.slice(0, pos)].at(-1);
  const after = [...text.slice(pos + term.length)][0];
  if (before !== undefined && rule.pre.has(before)) return true;
  if (after !== undefined && rule.post.has(after)) return true;
  for (const phrase of rule.exc) {
    const off = phrase.indexOf(term);
    const start = pos - off;
    if (start >= 0 && text.slice(start, start + phrase.length) === phrase) return true;
  }
  return false;
}

/** 回傳所有命中：[{ term, index, kind: 'word'|'char' }]（依位置排序）。 */
export function findLexiconHits(text, compiled) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  if (compiled.wordRe) {
    compiled.wordRe.lastIndex = 0;
    for (const m of text.matchAll(compiled.wordRe)) {
      if (!wordCancelled(text, m.index, m[0], compiled.rules.get(m[0]))) out.push({ term: m[0], index: m.index, kind: 'word' });
    }
  }
  const masked = maskedPositions(text, compiled.exceptions);
  let i = 0;
  for (const ch of text) {
    if (compiled.chars.has(ch) && !masked.has(i)) out.push({ term: ch, index: i, kind: 'char' });
    i += ch.length;
  }
  return out.sort((a, b) => a.index - b.index);
}
