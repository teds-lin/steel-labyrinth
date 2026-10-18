// 結局（DATA-FORMAT「第一部完結（M5 起）」的「結局」）。純函式，不修改輸入。
// 畫面流程：對話效果 { resolve_ending: true } → 對話結束後 pending 有 { type:'resolve_ending' } →
// resolveEnding(state, data) 依終章 story 的 endings 判定（第一個 if 成立的；最後一筆沒有 if）→
// 把回傳的 state（已寫入 state.ending）設回去 → 播 ending.dialogue（最後有 chapter_end）→ 結局畫面顯示 end_screen.title 與 ending.title。
import { evalCondition } from './conditions.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const hasEndings = (s) => isObj(s) && Array.isArray(s.endings) && s.endings.length > 0;

/** 該章的 endings（沒有回空陣列）。 */
export function endingsOf(chapterId, data) {
  const story = arr(data?.story).find((s) => isObj(s) && s.id === chapterId);
  return hasEndings(story) ? story.endings.filter(isObj) : [];
}

/** 要用哪一章的 endings：opts.chapter → state.chapter（有 endings 時）→ 唯一一個有 endings 的章節。 */
function pickStory(state, data, opts) {
  const stories = arr(data?.story).filter(isObj);
  if (opts?.chapter !== undefined) {
    const s = stories.find((x) => x.id === opts.chapter);
    if (!hasEndings(s)) throw new Error(`章節「${opts.chapter}」沒有 endings`);
    return s;
  }
  const cur = stories.find((x) => x.id === state?.chapter);
  if (hasEndings(cur)) return cur;
  const withEndings = stories.filter(hasEndings);
  if (withEndings.length === 1) return withEndings[0];
  if (withEndings.length === 0) throw new Error('沒有任何章節有 endings，無法判定結局');
  throw new Error(`有多個章節有 endings（${withEndings.map((s) => s.id).join('、')}），而 state.chapter「${state?.chapter}」無法決定要用哪一個；請傳 opts.chapter`);
}

/**
 * 判定結局。回傳 { state（state.ending＝結局 id）, ending:{ id, title, dialogue } }。
 * opts.chapter（選填）：指定章節。找不到可用的 endings、或全部都不成立（資料錯誤）時丟錯。
 */
export function resolveEnding(state, data, opts = {}) {
  const story = pickStory(state, data, opts);
  const hit = story.endings.filter(isObj).find((e) => e.if === undefined || evalCondition(e.if, state, data));
  if (!hit) throw new Error(`章節「${story.id}」沒有成立的結局（endings 的最後一筆必須沒有 if）`);
  return { state: { ...state, ending: hit.id }, ending: { id: hit.id, title: hit.title, dialogue: hit.dialogue } };
}
