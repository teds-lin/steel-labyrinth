// 收集玩家看得到的字串，供校對／翻譯／在地化掃描使用。
const arr = (v) => (Array.isArray(v) ? v : []);
const isStr = (v) => typeof v === 'string';

/**
 * 回傳 [{ unique_id: "<檔案>#<路徑>", text }]，順序：地圖 → 道具 → 譜系 → 角色 → 技能 → 敵人 → 章節（標題、結束畫面、夢客、結局、對話）。
 * 新增玩家看得到的欄位時，要同時加在這裡與 tests/core/strings-m5.test.js 的 VISIBLE（守門測試會擋下沒分類的字串欄位）。
 */
export function collectStrings(bundle) {
  const rows = [];
  const add = (file, path, text) => { if (isStr(text)) rows.push({ unique_id: `${file}#${path}`, text }); };
  for (const map of arr(bundle.maps)) {
    add(`maps/${map.id}.json`, 'name', map.name);
    // 鐘塔之夢補充 5：入夢選項的文字（選填）
    for (const obj of arr(map.objects)) {
      for (const k of ['prompt', 'yes', 'no']) add(`maps/${map.id}.json`, `${obj?.id}.dream.${k}`, obj?.dream?.[k]);
    }
  }
  for (const item of arr(bundle.items)) {
    add('items.json', `${item.id}.name`, item.name);
    add('items.json', `${item.id}.desc`, item.desc);
  }
  for (const lin of arr(bundle.lineages)) {
    const file = `lineages/${lin.id}.json`;
    add(file, 'nature', lin.nature);
    for (const r of arr(lin.ranks)) add(file, `ranks.${r?.rank}.name`, r?.name); // 選單顯示「借聲者（階 8）」
  }
  for (const c of arr(bundle.characters)) add('characters.json', `${c.id}.name`, c.name);
  for (const s of arr(bundle.skills)) {
    add('skills.json', `${s.id}.name`, s.name);
    add('skills.json', `${s.id}.desc`, s.desc);
  }
  for (const e of arr(bundle.enemies)) {
    add('enemies.json', `${e.id}.name`, e.name);
    add('enemies.json', `${e.id}.summon_text`, e.summon_text); // 規格補充 2 第 7 條：召喚訊息
  }
  for (const story of arr(bundle.story)) {
    const file = `story/${story.id}.json`;
    // M4 待辦：章節標題、章節結束畫面
    add(file, 'title', story.title);
    add(file, 'end_screen.title', story.end_screen?.title);
    add(file, 'end_screen.subtitle', story.end_screen?.subtitle);
    // M4 待辦：夢客名字與全部預寫台詞；M5：交換的說明
    for (const g of arr(story.guests)) {
      const gb = `guests.${g?.id}`;
      add(file, `${gb}.name`, g?.name);
      const scripted = g?.scripted !== null && typeof g?.scripted === 'object' ? g.scripted : {};
      for (const [kind, list] of Object.entries(scripted)) arr(list).forEach((line, i) => add(file, `${gb}.scripted.${kind}[${i}]`, line));
      for (const t of arr(g?.trades)) add(file, `${gb}.trades.${t?.id}.label`, t?.label);
    }
    // M5：結局名稱
    for (const e of arr(story.endings)) add(file, `endings.${e?.id}.title`, e?.title);
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
