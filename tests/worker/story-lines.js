// 測試共用：收集公開劇情（web/data/story/*.json）裡所有含中文的字串，當作「正常回覆」樣本量誤殺率。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 回傳不重複的中文字串（{name} 之類的代入欄位換成「十二點」，模擬夢客的稱呼）。
 * M5：結局畫面的致謝（end_screen.credits）是遊戲外的製作名單（會寫到製作者與 AI 的名字），不是劇中人物會說的話，不列入樣本。
 */
export function storyLines(dir) {
  const lines = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (/\p{Script=Han}/u.test(v)) lines.add(v.replace(/\{[a-z_]+\}/g, '十二點'));
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k !== 'credits') walk(x); });
  };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) walk(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  return [...lines];
}
