// 內容資料檢查（DATA-FORMAT 的所有硬規則）。純函式、不丟例外、不修改輸入；
// 瀏覽器（開發模式自檢）與 tools/check-data.mjs 共用。
// bundle = { manifest, tiles, items, lineages:[], maps:[], story:[] }
import { checkCondition } from './conditions.js';
import { checkEffect } from './effects.js';
import { DIRS } from './grid.js';

const END = 'END';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v !== '';
const arr = (v) => (Array.isArray(v) ? v : []);
const q = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const has = (obj, k) => isObj(obj) && Object.hasOwn(obj, k); // 不用 in：避免原型鍵（toString…）混過
const isBool = (v) => typeof v === 'boolean';

/** 回傳錯誤字串陣列；空陣列代表資料合法。 */
export function validateBundle(bundle) {
  const errors = [];
  try {
    run(bundle, errors);
  } catch (e) {
    errors.push(`檢查器內部錯誤（資料形狀可能嚴重錯誤）：${e?.message ?? e}`);
  }
  return errors;
}

/** 檢查清單 id 唯一；回傳 id → 項目 的 Map（重複者保留第一個）。 */
function indexById(list, where, label, errors) {
  const map = new Map();
  if (!Array.isArray(list)) {
    errors.push(`${where}：必須是陣列`);
    return map;
  }
  list.forEach((item, i) => {
    if (!isObj(item) || !isStr(item.id)) {
      errors.push(`${where}：第 ${i} 個${label}缺少 id`);
      return;
    }
    if (map.has(item.id)) errors.push(`${where}：${label} id「${item.id}」重複`);
    else map.set(item.id, item);
  });
  return map;
}

function run(bundle, errors) {
  if (!isObj(bundle)) {
    errors.push('bundle：必須是物件');
    return;
  }
  const tiles = indexById(bundle.tiles, 'tiles.json', '地形', errors);
  const items = indexById(bundle.items, 'items.json', '道具', errors);
  const lineages = indexById(bundle.lineages ?? [], 'lineages', '譜系', errors);
  const maps = indexById(bundle.maps, 'maps', '地圖', errors);

  // 對話：跨所有 story 檔 id 唯一
  const dialogues = new Map(); // id → { dlg, file }
  const storyIds = indexById(bundle.story, 'story', '章節', errors);
  arr(bundle.story).forEach((story, si) => {
    const file = `story/${isObj(story) && isStr(story.id) ? story.id : `[${si}]`}.json`;
    if (!isObj(story)) return;
    if (!Array.isArray(story.dialogues)) {
      errors.push(`${file}：dialogues 必須是陣列`);
      return;
    }
    story.dialogues.forEach((dlg, di) => {
      if (!isObj(dlg) || !isStr(dlg.id)) {
        errors.push(`${file}：第 ${di} 段對話缺少 id`);
        return;
      }
      if (dialogues.has(dlg.id)) errors.push(`${file}：對話 id「${dlg.id}」重複（先前出現在 ${dialogues.get(dlg.id).file}）`);
      else dialogues.set(dlg.id, { dlg, file });
    });
  });

  const ctx = { errors, tiles, items, maps, dialogues, lineages, storyIds, freeItems: new Set() };
  ctx.freeItems = freeGivenItems(bundle, ctx);

  checkManifest(bundle.manifest, ctx, storyIds, lineages);
  for (const tile of tiles.values()) {
    if (!isBool(tile.solid)) errors.push(`tiles.json：地形「${tile.id}」的 solid 必須是 true/false`);
    if (tile.glow !== undefined && !isBool(tile.glow)) errors.push(`tiles.json：地形「${tile.id}」的 glow 必須是 true/false`);
  }
  for (const lin of lineages.values()) checkLineage(lin, errors);
  arr(bundle.story).forEach((story) => { if (isObj(story) && isStr(story.id)) checkStoryMeta(story, errors); });
  for (const map of maps.values()) checkMap(map, ctx);
  for (const { dlg, file } of dialogues.values()) checkDialogue(dlg, file, ctx);
}

// ---------- 譜系、章節 ----------

function checkLineage(lin, errors) {
  const W = `lineages/${lin.id}.json`;
  if (!Array.isArray(lin.ranks)) {
    errors.push(`${W}：譜系「${lin.id}」的 ranks 必須是陣列`);
    return;
  }
  const seen = new Set();
  lin.ranks.forEach((r, i) => {
    if (!isObj(r) || !Number.isInteger(r.rank)) {
      errors.push(`${W}：譜系「${lin.id}」ranks[${i}] 的 rank 必須是整數`);
      return;
    }
    if (seen.has(r.rank)) errors.push(`${W}：譜系「${lin.id}」的 rank ${r.rank} 重複`);
    seen.add(r.rank);
  });
}

function checkStoryMeta(story, errors) {
  const W = `story/${story.id}.json`;
  if (!isStr(story.title)) errors.push(`${W}：title 必須是非空字串`);
  if (!isObj(story.end_screen)) {
    errors.push(`${W}：缺少 end_screen（{ title, subtitle }）`);
    return;
  }
  for (const k of ['title', 'subtitle']) {
    if (!isStr(story.end_screen[k])) errors.push(`${W}：end_screen.${k} 必須是非空字串`);
  }
}

// ---------- fallback 可達性 ----------

/**
 * 不經過任何 lock 的 on_tag、也不花殘響就能取得的道具。
 * 入口：manifest.start.dialogue、地圖 on_enter、觸發點、出口 blocked、物件 look、lock 的 on_item／locked。
 * 物件 echo 與 lock.on_tag 不算；沒人引用的孤兒對話不算。
 * 在對話內沿 next／branches／choices 走；帶 use_echo 的節點或選項視為要花殘響，不往下走、不算它的效果。
 */
function freeGivenItems(bundle, ctx) {
  const entries = new Set();
  const add = (id) => { if (isStr(id)) entries.add(id); };
  if (isObj(bundle.manifest) && isObj(bundle.manifest.start)) add(bundle.manifest.start.dialogue);
  for (const map of ctx.maps.values()) {
    add(map.on_enter);
    for (const t of arr(map.triggers)) if (isObj(t)) add(t.dialogue);
    for (const ex of arr(map.exits)) if (isObj(ex)) add(ex.blocked);
    for (const obj of arr(map.objects)) {
      if (!isObj(obj)) continue;
      add(obj.look);
      if (isObj(obj.lock)) { add(obj.lock.on_item); add(obj.lock.locked); }
    }
  }
  const costly = (effects) => arr(effects).some((e) => has(e, 'use_echo'));
  const gives = (effects, out) => { for (const e of arr(effects)) if (has(e, 'give_item') && isStr(e.give_item)) out.add(e.give_item); };
  const out = new Set();
  for (const id of entries) {
    const dlg = ctx.dialogues.get(id)?.dlg;
    if (!dlg || !Array.isArray(dlg.nodes)) continue;
    const nodes = new Map(dlg.nodes.filter((n) => isObj(n) && isStr(n.id)).map((n) => [n.id, n]));
    const seen = new Set();
    const stack = [dlg.start];
    while (stack.length) {
      const nid = stack.pop();
      if (seen.has(nid) || !nodes.has(nid)) continue;
      seen.add(nid);
      const n = nodes.get(nid);
      if (costly(n.effects)) continue;
      gives(n.effects, out);
      if (isStr(n.next)) stack.push(n.next);
      for (const b of arr(n.branches)) if (isObj(b) && isStr(b.next)) stack.push(b.next);
      for (const c of arr(n.choices)) {
        if (!isObj(c) || costly(c.effects)) continue;
        gives(c.effects, out);
        if (isStr(c.next)) stack.push(c.next);
      }
    }
  }
  return out;
}

// ---------- 共用：條件、效果、引用 ----------

/** 找出條件裡引用的 key（item／lineage）值。 */
function conditionRefs(cond, key, out = []) {
  if (!isObj(cond)) return out;
  if (has(cond, key) && isStr(cond[key])) out.push(cond[key]);
  for (const c of arr(has(cond, 'all') ? cond.all : undefined)) conditionRefs(c, key, out);
  for (const c of arr(has(cond, 'any') ? cond.any : undefined)) conditionRefs(c, key, out);
  if (has(cond, 'not') && isObj(cond.not)) conditionRefs(cond.not, key, out);
  return out;
}

function checkCond(cond, where, ctx) {
  const errs = checkCondition(cond, 'if');
  for (const e of errs) ctx.errors.push(`${where}：${e}`);
  if (errs.length === 0) {
    for (const id of conditionRefs(cond, 'item')) if (!ctx.items.has(id)) ctx.errors.push(`${where}：條件引用不存在的道具「${id}」`);
    for (const id of conditionRefs(cond, 'lineage')) if (!ctx.lineages.has(id)) ctx.errors.push(`${where}：條件引用不存在的譜系「${id}」`);
  }
}

function checkEffects(effects, where, ctx) {
  if (effects === undefined) return;
  if (!Array.isArray(effects)) {
    ctx.errors.push(`${where}：effects 必須是陣列`);
    return;
  }
  effects.forEach((e, i) => {
    const errs = checkEffect(e, `effects[${i}]`);
    for (const m of errs) ctx.errors.push(`${where}：${m}`);
    if (errs.length) return;
    for (const k of ['give_item', 'take_item']) {
      if (has(e, k) && !ctx.items.has(e[k])) ctx.errors.push(`${where}：effects[${i}] ${k} 引用不存在的道具「${e[k]}」`);
    }
    if (has(e, 'chapter_end') && !ctx.storyIds.has(e.chapter_end)) {
      ctx.errors.push(`${where}：effects[${i}] chapter_end 引用沒有載入的章節（story）「${e.chapter_end}」`);
    }
  });
}

function refDialogue(id, where, field, ctx, required = false) {
  if (id === undefined || id === null) {
    if (required) ctx.errors.push(`${where}：缺少 ${field}`);
    return;
  }
  if (!isStr(id) || !ctx.dialogues.has(id)) ctx.errors.push(`${where}：${field} 引用不存在的對話「${q(id)}」`);
}

// ---------- manifest ----------

function checkManifest(manifest, ctx, storyIds, lineages) {
  const W = 'manifest.json';
  const { errors } = ctx;
  if (!isObj(manifest)) {
    errors.push(`${W}：缺少或不是物件`);
    return;
  }
  const start = manifest.start;
  if (!isObj(start)) {
    errors.push(`${W}：缺少 start`);
  } else {
    const map = ctx.maps.get(start.map);
    if (!map) errors.push(`${W}：start.map 引用不存在的地圖「${q(start.map)}」`);
    else if (!arr(map.spawns).some((s) => isObj(s) && s.id === start.spawn)) {
      errors.push(`${W}：start.spawn「${q(start.spawn)}」不在地圖「${map.id}」裡`);
    }
    refDialogue(start.dialogue, W, 'start.dialogue', ctx);
    if (has(start, 'echo_charges')) {
      const v = start.echo_charges;
      if (!Number.isInteger(v) || v < 0 || v > 99) errors.push(`${W}：start.echo_charges 必須是 0～99 的整數，實際為 ${JSON.stringify(v)}`);
    }
  }
  if (!Array.isArray(manifest.chapters)) {
    errors.push(`${W}：chapters 必須是陣列`);
  } else {
    for (const id of manifest.chapters) if (!isStr(id) || !storyIds.has(id)) errors.push(`${W}：chapters 列出的章節「${q(id)}」沒有對應的 story`);
  }
  const files = manifest.files;
  if (isObj(files)) {
    const kinds = { maps: ctx.maps, story: storyIds, lineages };
    for (const [kind, loaded] of Object.entries(kinds)) {
      if (files[kind] === undefined) continue;
      if (!Array.isArray(files[kind])) {
        errors.push(`${W}：files.${kind} 必須是陣列`);
        continue;
      }
      for (const id of files[kind]) if (!loaded.has(id)) errors.push(`${W}：files.${kind} 列出的「${q(id)}」沒有載入（檔案不存在或 id 不符）`);
    }
  }
}

// ---------- maps ----------

function checkMap(map, ctx) {
  const W = `maps/${map.id}.json`;
  const { errors } = ctx;
  if (!isStr(map.name)) errors.push(`${W}：缺少 name`);

  // 地形
  const rows = Array.isArray(map.tiles) && map.tiles.every((r) => typeof r === 'string') ? map.tiles.map((r) => Array.from(r)) : null;
  if (!rows || rows.length === 0) {
    errors.push(`${W}：tiles 必須是非空的字串陣列`);
    return;
  }
  const width = rows[0].length;
  rows.forEach((r, y) => {
    if (r.length !== width) errors.push(`${W}：tiles 第 ${y} 列長度 ${r.length}，與第 0 列 ${width} 不等長`);
  });
  const legend = isObj(map.legend) ? map.legend : {};
  if (!isObj(map.legend)) errors.push(`${W}：缺少 legend`);
  for (const [ch, tid] of Object.entries(legend)) {
    if (Array.from(ch).length !== 1) errors.push(`${W}：legend 的鍵「${ch}」必須是單一字元`);
    if (!ctx.tiles.has(tid)) errors.push(`${W}：legend「${ch}」引用不存在的地形「${q(tid)}」`);
  }
  const unknownChars = new Set();
  rows.forEach((r) => r.forEach((ch) => { if (!Object.hasOwn(legend, ch)) unknownChars.add(ch); }));
  for (const ch of unknownChars) errors.push(`${W}：tiles 用到 legend 沒有定義的字元「${ch}」`);

  const solidTileAt = (x, y) => {
    const ch = rows[y]?.[x];
    const t = Object.hasOwn(legend, ch ?? '') ? ctx.tiles.get(legend[ch]) : undefined;
    return !t || t.solid === true; // 未知地形當作 solid
  };
  /** 檢查座標：整數、範圍內、不在 solid 地形。回傳是否在範圍內。 */
  const checkPos = (o, label) => {
    if (!isObj(o) || !Number.isInteger(o.x) || !Number.isInteger(o.y)) {
      errors.push(`${W}：${label} 座標必須是整數`);
      return false;
    }
    if (o.y < 0 || o.y >= rows.length || o.x < 0 || o.x >= (rows[o.y]?.length ?? 0)) {
      errors.push(`${W}：${label} 座標 (${o.x}, ${o.y}) 超出地圖範圍`);
      return false;
    }
    if (solidTileAt(o.x, o.y)) errors.push(`${W}：${label} 座標 (${o.x}, ${o.y}) 在 solid 地形上`);
    return true;
  };

  // spawns
  const solidObjects = arr(map.objects).filter((o) => isObj(o) && o.solid === true);
  const spawnIds = indexById(map.spawns ?? [], W, 'spawn', errors);
  for (const sp of spawnIds.values()) {
    if (checkPos(sp, `spawn「${sp.id}」`)) {
      for (const o of solidObjects) if (o.x === sp.x && o.y === sp.y) errors.push(`${W}：spawn「${sp.id}」放在 solid 物件「${o.id}」上`);
    }
    if (sp.dir !== undefined && !(typeof sp.dir === 'string' && Object.hasOwn(DIRS, sp.dir))) errors.push(`${W}：spawn「${sp.id}」的 dir「${q(sp.dir)}」必須是 up/down/left/right`);
  }

  refDialogue(map.on_enter, W, 'on_enter', ctx);

  // objects
  const objects = indexById(map.objects ?? [], W, '物件', errors);
  for (const obj of objects.values()) {
    const where = `${W} 物件「${obj.id}」`;
    checkPos(obj, `物件「${obj.id}」`);
    if (obj.solid !== undefined && !isBool(obj.solid)) errors.push(`${where}：solid 必須是 true/false`);
    if (obj.if !== undefined) checkCond(obj.if, where, ctx);
    refDialogue(obj.look, where, 'look', ctx);
    refDialogue(obj.echo, where, 'echo', ctx);
    if (obj.lock !== undefined) checkLock(obj.lock, where, ctx);
  }

  // exits
  arr(map.exits).forEach((ex, i) => {
    const label = `exits[${i}]`;
    const where = `${W} ${label}`;
    if (!isObj(ex)) {
      errors.push(`${where}：必須是物件`);
      return;
    }
    if (checkPos(ex, label)) {
      for (const obj of objects.values()) {
        if (obj.x === ex.x && obj.y === ex.y && obj.solid === true) {
          errors.push(`${where}：與 solid 物件「${obj.id}」重疊，永遠踩不到`);
        }
      }
    }
    const target = ctx.maps.get(ex.to);
    if (!target) errors.push(`${where}：to 引用不存在的地圖「${q(ex.to)}」`);
    else if (!arr(target.spawns).some((s) => isObj(s) && s.id === ex.spawn)) {
      errors.push(`${where}：地圖「${target.id}」沒有 spawn「${q(ex.spawn)}」`);
    }
    if (ex.requires !== undefined) checkCond(ex.requires, where, ctx);
    refDialogue(ex.blocked, where, 'blocked', ctx);
  });
  if (map.exits !== undefined && !Array.isArray(map.exits)) errors.push(`${W}：exits 必須是陣列`);

  // triggers
  const triggers = indexById(map.triggers ?? [], W, '觸發點', errors);
  for (const trg of triggers.values()) {
    const where = `${W} 觸發點「${trg.id}」`;
    checkPos(trg, `觸發點「${trg.id}」`);
    refDialogue(trg.dialogue, where, 'dialogue', ctx, true);
    if (trg.if !== undefined) checkCond(trg.if, where, ctx);
  }
}

function checkLock(lock, where, ctx) {
  const { errors } = ctx;
  if (!isObj(lock)) {
    errors.push(`${where}：lock 必須是物件`);
    return;
  }
  if (!isStr(lock.flag)) errors.push(`${where}：lock.flag 必填`);
  const tags = Array.isArray(lock.solvable_by) && lock.solvable_by.every(isStr) ? lock.solvable_by : null;
  if (lock.solvable_by !== undefined && !tags) errors.push(`${where}：lock.solvable_by 必須是字串陣列`);
  if (lock.fallback === undefined) {
    errors.push(`${where}：lock.fallback 必填（不靠能力的解法）`);
  } else {
    const m = typeof lock.fallback === 'string' ? /^item:(.+)$/.exec(lock.fallback) : null;
    if (!m) errors.push(`${where}：lock.fallback「${q(lock.fallback)}」寫法不支援（目前只支援 item:<id>）`);
    else if (!ctx.items.has(m[1])) errors.push(`${where}：lock.fallback 引用不存在的道具「${m[1]}」`);
    else if (!ctx.freeItems.has(m[1])) {
      errors.push(`${where}：lock.fallback 道具「${m[1]}」無法從免費入口取得（需要 start／on_enter／觸發點／look／on_item／locked 對話裡有 give_item；物件 echo、lock.on_tag、要花殘響的選項、孤兒對話都不算）`);
    }
  }
  if (lock.on_tag !== undefined) {
    if (!isObj(lock.on_tag)) errors.push(`${where}：lock.on_tag 必須是物件`);
    else {
      for (const [tag, dlg] of Object.entries(lock.on_tag)) {
        if (tags && !tags.includes(tag)) errors.push(`${where}：lock.on_tag 的標籤「${tag}」不在 solvable_by 裡，永遠不會播放`);
        refDialogue(dlg, where, `lock.on_tag.${tag}`, ctx);
      }
    }
  }
  refDialogue(lock.on_item, where, 'lock.on_item', ctx);
  refDialogue(lock.locked, where, 'lock.locked', ctx);
}

// ---------- 對話 ----------

function checkDialogue(dlg, file, ctx) {
  const W = `${file} 對話「${dlg.id}」`;
  const { errors } = ctx;
  if (!Array.isArray(dlg.nodes)) {
    errors.push(`${W}：nodes 必須是陣列`);
    return;
  }
  const nodes = new Map();
  dlg.nodes.forEach((n, i) => {
    if (!isObj(n) || !isStr(n.id)) {
      errors.push(`${W}：第 ${i} 個節點缺少 id`);
      return;
    }
    if (n.id === END) errors.push(`${W}：節點 id 不可以是保留字 END`);
    else if (nodes.has(n.id)) errors.push(`${W}：節點 id「${n.id}」重複`);
    else nodes.set(n.id, n);
  });

  const edges = new Map(); // id → 目標 id 陣列（含 END）
  const target = (where, field, next) => {
    if (next === END) return END;
    if (!isStr(next) || !nodes.has(next)) {
      errors.push(`${where}：${field} 指向不存在的節點「${q(next)}」`);
      return null;
    }
    return next;
  };

  for (const n of nodes.values()) {
    const where = `${W} 節點 ${n.id}`;
    const out = [];
    const hasChoices = n.choices !== undefined;
    const hasNext = n.next !== undefined;
    if (!hasNext && !hasChoices) errors.push(`${where}：必須有 next 或 choices`);
    if (hasNext && hasChoices) errors.push(`${where}：next 與 choices 不可同時存在（語意不明）`);
    if (n.branches !== undefined && hasChoices) errors.push(`${where}：branches 與 choices 不可同時存在`);
    if (n.branches !== undefined && !hasNext) errors.push(`${where}：有 branches 的節點必須有 next（都不成立時走的路）`);
    if (hasNext) out.push(target(where, 'next', n.next));
    if (n.branches !== undefined) {
      if (!Array.isArray(n.branches)) errors.push(`${where}：branches 必須是陣列`);
      else n.branches.forEach((b, i) => {
        const bw = `${where} branches[${i}]`;
        if (!isObj(b)) { errors.push(`${bw}：必須是物件`); return; }
        if (b.if === undefined) errors.push(`${bw}：缺少 if`);
        else checkCond(b.if, bw, ctx);
        out.push(target(bw, 'next', b.next));
      });
    }
    if (hasChoices) {
      if (!Array.isArray(n.choices) || n.choices.length === 0) {
        errors.push(`${where}：choices 必須至少一個選項`);
      } else {
        n.choices.forEach((c, i) => {
          const cw = `${where} choices[${i}]`;
          if (!isObj(c)) { errors.push(`${cw}：必須是物件`); return; }
          if (typeof c.text !== 'string') errors.push(`${cw}：缺少 text`);
          if (c.next === undefined) errors.push(`${cw}：缺少 next`);
          else out.push(target(cw, 'next', c.next));
          if (c.if !== undefined) checkCond(c.if, cw, ctx);
          checkEffects(c.effects, cw, ctx);
        });
        if (n.choices.every((c) => isObj(c) && c.if !== undefined)) {
          errors.push(`${where}：至少要有一個沒有 if 的選項，確保永遠有路可走`);
        }
      }
    }
    if (n.text !== undefined && n.text !== null && typeof n.text !== 'string') errors.push(`${where}：text 必須是字串`);
    if (n.speaker !== undefined && n.speaker !== null && typeof n.speaker !== 'string') errors.push(`${where}：speaker 必須是字串或 null`);
    checkEffects(n.effects, where, ctx);
    edges.set(n.id, out.filter((t) => t !== null));
  }

  // 可達性：從 start 出發
  if (!nodes.has(dlg.start)) {
    errors.push(`${W}：start 指向不存在的節點「${q(dlg.start)}」`);
    return;
  }
  const reached = new Set([dlg.start]);
  const stack = [dlg.start];
  while (stack.length) {
    for (const t of edges.get(stack.pop()) ?? []) {
      if (t !== END && !reached.has(t)) { reached.add(t); stack.push(t); }
    }
  }
  for (const id of nodes.keys()) if (!reached.has(id)) errors.push(`${W} 節點 ${id}：從 start 走不到`);

  // 死路：反向從 END 出發，找出走得到 END 的節點
  const canEnd = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, outs] of edges) {
      if (!canEnd.has(id) && outs.some((t) => t === END || canEnd.has(t))) { canEnd.add(id); changed = true; }
    }
  }
  for (const id of nodes.keys()) {
    if (!canEnd.has(id)) errors.push(`${W} 節點 ${id}：無法走到 END（只能繞圈的死路）`);
  }
}
