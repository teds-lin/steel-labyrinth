// 收集玩家看得到的字串，供校對／翻譯／在地化掃描使用。
const arr = (v) => (Array.isArray(v) ? v : []);
const isStr = (v) => typeof v === 'string';

/** 回傳 [{ unique_id: "<檔案>#<路徑>", text }]，順序：地圖 → 道具 → 角色 → 技能 → 敵人 → 對話。 */
export function collectStrings(bundle) {
  const rows = [];
  const add = (file, path, text) => { if (isStr(text)) rows.push({ unique_id: `${file}#${path}`, text }); };
  for (const map of arr(bundle.maps)) add(`maps/${map.id}.json`, 'name', map.name);
  for (const item of arr(bundle.items)) {
    add('items.json', `${item.id}.name`, item.name);
    add('items.json', `${item.id}.desc`, item.desc);
  }
  for (const c of arr(bundle.characters)) add('characters.json', `${c.id}.name`, c.name);
  for (const s of arr(bundle.skills)) {
    add('skills.json', `${s.id}.name`, s.name);
    add('skills.json', `${s.id}.desc`, s.desc);
  }
  for (const e of arr(bundle.enemies)) add('enemies.json', `${e.id}.name`, e.name);
  for (const story of arr(bundle.story)) {
    const file = `story/${story.id}.json`;
    for (const dlg of arr(story.dialogues)) {
      for (const node of arr(dlg.nodes)) {
        const base = `${dlg.id}.${node.id}`;
        add(file, `${base}.speaker`, node.speaker);
        add(file, `${base}.text`, node.text);
        arr(node.choices).forEach((c, i) => add(file, `${base}.choices[${i}].text`, c?.text));
      }
    }
  }
  return rows;
}

/** unique_id 必須唯一；不唯一就丟錯並列出重複者。 */
export function assertUniqueIds(rows) {
  const seen = new Set();
  const dup = new Set();
  for (const r of rows) (seen.has(r.unique_id) ? dup : seen).add(r.unique_id);
  if (dup.size) throw new Error(`unique_id 不唯一（${dup.size} 個）：\n  ${[...dup].join('\n  ')}`);
}
