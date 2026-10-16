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

  // 所有 give_item 的道具（fallback 必須拿得到）
  const givenItems = new Set();
  for (const { dlg } of dialogues.values()) {
    for (const node of arr(dlg.nodes)) {
      if (!isObj(node)) continue;
      const effectLists = [node.effects, ...arr(node.choices).map((c) => (isObj(c) ? c.effects : undefined))];
      for (const list of effectLists) for (const e of arr(list)) if (isObj(e) && isStr(e.give_item)) givenItems.add(e.give_item);
    }
  }

  const ctx = { errors, tiles, items, maps, dialogues, givenItems };

  checkManifest(bundle.manifest, ctx, storyIds, lineages);
  for (const tile of tiles.values()) {
    if (tile.solid !== undefined && typeof tile.solid !== 'boolean') errors.push(`tiles.json：地形「${tile.id}」的 solid 必須是 true/false`);
  }
  for (const map of maps.values()) checkMap(map, ctx);
  for (const { dlg, file } of dialogues.values()) checkDialogue(dlg, file, ctx);
}

// ---------- 共用：條件、效果、引用 ----------

/** 找出條件裡引用的道具 id。 */
function conditionItems(cond, out = []) {
  if (!isObj(cond)) return out;
  if (isStr(cond.item)) out.push(cond.item);
  for (const c of arr(cond.all)) conditionItems(c, out);
  for (const c of arr(cond.any)) conditionItems(c, out);
  if (isObj(cond.not)) conditionItems(cond.not, out);
  return out;
}

function checkCond(cond, where, ctx) {
  const errs = checkCondition(cond, 'if');
  for (const e of errs) ctx.errors.push(`${where}：${e}`);
  if (errs.length === 0) {
    for (const id of conditionItems(cond)) if (!ctx.items.has(id)) ctx.errors.push(`${where}：條件引用不存在的道具「${id}」`);
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
      if (k in e && !ctx.items.has(e[k])) ctx.errors.push(`${where}：effects[${i}] ${k} 引用不存在的道具「${e[k]}」`);
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
  rows.forEach((r) => r.forEach((ch) => { if (!(ch in legend)) unknownChars.add(ch); }));
  for (const ch of unknownChars) errors.push(`${W}：tiles 用到 legend 沒有定義的字元「${ch}」`);

  const solidTileAt = (x, y) => {
    const ch = rows[y]?.[x];
    const t = ctx.tiles.get(legend[ch]);
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
  const spawnIds = indexById(map.spawns ?? [], W, 'spawn', errors);
  for (const sp of spawnIds.values()) {
    checkPos(sp, `spawn「${sp.id}」`);
    if (sp.dir !== undefined && !(sp.dir in DIRS)) errors.push(`${W}：spawn「${sp.id}」的 dir「${q(sp.dir)}」必須是 up/down/left/right`);
  }

  refDialogue(map.on_enter, W, 'on_enter', ctx);

  // objects
  const objects = indexById(map.objects ?? [], W, '物件', errors);
  for (const obj of objects.values()) {
    const where = `${W} 物件「${obj.id}」`;
    checkPos(obj, `物件「${obj.id}」`);
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
    else if (!ctx.givenItems.has(m[1])) errors.push(`${where}：lock.fallback 道具「${m[1]}」沒有任何 give_item 可以取得`);
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
