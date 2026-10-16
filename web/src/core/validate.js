// 內容資料檢查（DATA-FORMAT 的所有硬規則）。純函式、不丟例外、不修改輸入；
// 瀏覽器（開發模式自檢）與 tools/check-data.mjs 共用。
// bundle = { manifest, tiles, items, lineages:[], maps:[], story:[], characters?:[], skills?:[], enemies?:[], encounters?:[] }
// （四個戰鬥檔案可以省略，視為空陣列：序章資料沒有它們。）
import { checkCondition } from './conditions.js';
import { checkEffect } from './effects.js';
import { DIRS } from './grid.js';
import { ECHO_TAG } from './echo.js';
import { STAT_KEYS, HERO_ID, MAX_PARTY } from './stats.js';
import { checkBattleEffect } from './battle/effects.js';
import { checkBattleCondition } from './battle/ai.js';

const END = 'END';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v !== '';
const arr = (v) => (Array.isArray(v) ? v : []);
const q = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const has = (obj, k) => isObj(obj) && Object.hasOwn(obj, k); // 不用 in：避免原型鍵（toString…）混過
const isBool = (v) => typeof v === 'boolean';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const SKILL_TARGETS = ['enemy', 'enemy_all', 'ally', 'ally_all', 'self'];
const ON_LOSE = ['retry', 'continue'];
/** 規格補充 2 第 10 條：遭遇的初始敵人上限、含召喚時同時在場的上限。 */
const MAX_ENCOUNTER_ENEMIES = 3;
const MAX_ENEMIES_ON_FIELD = 4;
/** 規格補充 2 第 5 條：階段對話只能用的效果。 */
const PHASE_DIALOGUE_EFFECTS = ['set_flag', 'clear_flag'];
/** 物件裡不在 allowed 清單的鍵（_ 開頭的私有註記發布前會剝除，這裡放行）。 */
const extraKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k) && !k.startsWith('_'));

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

  const characters = indexById(bundle.characters ?? [], 'characters.json', '角色', errors);
  const skills = indexById(bundle.skills ?? [], 'skills.json', '技能', errors);
  const enemies = indexById(bundle.enemies ?? [], 'enemies.json', '敵人', errors);
  const encounters = indexById(bundle.encounters ?? [], 'encounters.json', '遭遇', errors);

  const ctx = { errors, tiles, items, maps, dialogues, lineages, storyIds, characters, skills, enemies, encounters, storyById: new Map(), free: null };
  ctx.free = analyzeFree(bundle, ctx);

  checkManifest(bundle.manifest, ctx, storyIds, lineages);
  for (const tile of tiles.values()) {
    if (!isBool(tile.solid)) errors.push(`tiles.json：地形「${tile.id}」的 solid 必須是 true/false`);
    if (tile.glow !== undefined && !isBool(tile.glow)) errors.push(`tiles.json：地形「${tile.id}」的 glow 必須是 true/false`);
  }
  for (const item of items.values()) checkItem(item, ctx);
  for (const lin of lineages.values()) checkLineage(lin, errors, ctx);
  checkCharacters(characters, ctx);
  for (const sk of skills.values()) checkSkill(sk, ctx);
  for (const en of enemies.values()) checkEnemy(en, ctx);
  for (const enc of encounters.values()) checkEncounter(enc, ctx);
  arr(bundle.story).forEach((story) => { if (isObj(story) && isStr(story.id)) checkStoryMeta(story, errors, ctx); });
  checkPartySkills(ctx);
  checkPartyLimit(bundle, ctx);
  for (const map of maps.values()) checkMap(map, ctx);
  for (const { dlg, file } of dialogues.values()) checkDialogue(dlg, file, ctx);
}

// ---------- 譜系、章節 ----------

function checkLineage(lin, errors, ctx) {
  const W = `lineages/${lin.id}.json`;
  if (!Array.isArray(lin.ranks)) {
    errors.push(`${W}：譜系「${lin.id}」的 ranks 必須是陣列`);
    return;
  }
  if (lin.show_resonance !== undefined && !isBool(lin.show_resonance)) errors.push(`${W}：譜系「${lin.id}」的 show_resonance 必須是 true/false`);
  const seen = new Set();
  lin.ranks.forEach((r, i) => {
    if (!isObj(r) || !Number.isInteger(r.rank)) {
      errors.push(`${W}：譜系「${lin.id}」ranks[${i}] 的 rank 必須是整數`);
      return;
    }
    if (seen.has(r.rank)) errors.push(`${W}：譜系「${lin.id}」的 rank ${r.rank} 重複`);
    seen.add(r.rank);
    const where = `${W}：譜系「${lin.id}」rank ${r.rank}`;
    if (r.skills !== undefined) {
      if (!Array.isArray(r.skills)) errors.push(`${where} 的 skills 必須是陣列`);
      else for (const sk of r.skills) if (!isStr(sk) || !ctx.skills.has(sk)) errors.push(`${where} 的 skills 引用不存在的技能「${q(sk)}」`);
    }
    if (r.stats !== undefined) checkStatBlock(r.stats, `${where} 的 stats`, errors, { partial: true });
  });
}

/** 能力值區塊：只能用 7 個能力值鍵、值為數字。partial＝成長值（可省略、可為負）；否則全部必填、非負、hp ≥ 1。 */
function checkStatBlock(stats, where, errors, { partial = false } = {}) {
  if (!isObj(stats)) {
    errors.push(`${where} 必須是物件`);
    return;
  }
  for (const k of extraKeys(stats, STAT_KEYS)) errors.push(`${where} 有不認得的能力值「${k}」（只能是 ${STAT_KEYS.join('／')}）`);
  for (const k of STAT_KEYS) {
    if (!Object.hasOwn(stats, k)) {
      if (!partial) errors.push(`${where.replace(/ 的 /, ' ')}.${k} 必填`);
      continue;
    }
    const v = stats[k];
    const label = `${where.replace(/ 的 /, ' ')}.${k}`;
    if (!isNum(v)) errors.push(`${label} 必須是數字，實際為 ${JSON.stringify(v)}`);
    else if (!partial && (v < 0 || (k === 'hp' && v < 1))) errors.push(`${label} 必須 ${k === 'hp' ? '≥ 1' : '≥ 0'}，實際為 ${v}`);
  }
}

// ---------- 戰鬥資料 ----------

function checkLineageRef(lin, where, ctx) {
  if (!isObj(lin) || !isStr(lin.id) || !Number.isInteger(lin.rank)) {
    ctx.errors.push(`${where}：lineage 必須是 { id, rank }`);
    return;
  }
  const def = ctx.lineages.get(lin.id);
  if (!def) ctx.errors.push(`${where}：lineage 引用不存在的譜系「${lin.id}」`);
  else if (!arr(def.ranks).some((r) => isObj(r) && r.rank === lin.rank)) ctx.errors.push(`${where}：譜系「${lin.id}」沒有開放階位 ${lin.rank}`);
}

function checkSkillList(list, where, ctx) {
  if (!Array.isArray(list)) {
    ctx.errors.push(`${where}：skills 必須是陣列`);
    return;
  }
  for (const sk of list) if (!isStr(sk) || !ctx.skills.has(sk)) ctx.errors.push(`${where}：skills 引用不存在的技能「${q(sk)}」`);
}

/** 道具：target＋battle_effects（戰鬥中使用）、field_effects（地圖選單中使用）；兩者都沒有＝劇情道具。 */
function checkItem(item, ctx) {
  const { errors } = ctx;
  const where = `items.json 道具「${item.id}」`;
  const hasT = item.target !== undefined;
  const hasB = item.battle_effects !== undefined;
  if (hasT !== hasB) errors.push(`${where}：target 與 battle_effects 必須一起寫（戰鬥中使用的道具）`);
  if (hasT && !SKILL_TARGETS.includes(item.target)) errors.push(`${where}：target「${q(item.target)}」必須是 ${SKILL_TARGETS.join('／')}`);
  if (hasB) checkBattleEffectList(item.battle_effects, item.target, where, 'battle_effects', ctx);
  if (item.field_effects !== undefined) {
    if (!Array.isArray(item.field_effects) || item.field_effects.length === 0) errors.push(`${where}：field_effects 必須是至少一個效果的陣列`);
    else {
      checkEffects(item.field_effects, `${where} field_effects`, ctx);
      if (usesEcho(item.field_effects)) errors.push(`${where}：field_effects 不可使用 use_echo`);
    }
  }
}

/** 效果積木陣列（技能 effects、道具 battle_effects 共用）。 */
function checkBattleEffectList(list, target, where, field, ctx) {
  const { errors } = ctx;
  if (!Array.isArray(list) || list.length === 0) {
    errors.push(`${where}：${field} 必須是至少一個效果積木的陣列`);
    return;
  }
  list.forEach((e, i) => {
    const errs = checkBattleEffect(e, `${field}[${i}]`);
    for (const m of errs) errors.push(`${where}：${m}`);
    if (errs.length) return;
    if (e.type === 'summon' && !ctx.enemies.has(e.enemy)) errors.push(`${where}：${field}[${i}] summon 引用不存在的敵人「${e.enemy}」`);
    if (e.type === 'reveal_intent' && (e.on === 'self' || !['enemy', 'enemy_all'].includes(target))) {
      errors.push(`${where}：${field}[${i}] reveal_intent 只能用在以敵人為目標（enemy／enemy_all）的技能`);
    }
  });
}

function checkCharacters(characters, ctx) {
  const { errors } = ctx;
  if (characters.size > 0 && !characters.has(HERO_ID)) errors.push(`characters.json：必須有主角「${HERO_ID}」`);
  for (const c of characters.values()) {
    const where = `characters.json 角色「${c.id}」`;
    if (!isStr(c.name)) errors.push(`${where}：name 必須是非空字串`);
    if (c.sprite !== undefined && !isStr(c.sprite)) errors.push(`${where}：sprite 必須是字串`);
    checkStatBlock(c.base, `${where} 的 base`, errors);
    checkSkillList(c.skills, where, ctx);
    if (c.id === HERO_ID && c.lineage !== undefined) errors.push(`${where}：主角的 lineage 來自遊戲狀態（喝下靈劑），不可寫在 characters.json`);
    else if (c.lineage !== undefined) checkLineageRef(c.lineage, where, ctx);
    // 規格補充 2 第 10 條：至少一個不消耗資源的技能（只看 characters.skills：譜系技能可能還沒開放）
    if (Array.isArray(c.skills) && c.skills.every((id) => isStr(id) && ctx.skills.has(id))
      && !c.skills.some((id) => isFreeSkill(ctx.skills.get(id)))) {
      errors.push(`${where}：skills 裡至少要有一個不消耗任何資源（沒有 sp／ammo 花費）的技能`);
    }
    checkRankStats(c, where, ctx);
  }
}

const isFreeSkill = (sk) => !isObj(sk.cost) || Object.values(sk.cost).every((v) => v === 0);

/**
 * 規格補充 2 第 10 條：角色在任何已開放階位的能力值都必須合法（hp、spd ≥ 1，其他 ≥ 0）。
 * 主角：沒有譜系、以及每個譜系的每個階位；隊友：自己譜系的每個階位。能力值＝base＋該階位以上（rank ≥）各階的 stats。
 */
function checkRankStats(c, where, ctx) {
  if (!isObj(c.base)) return;
  const cases = [];
  if (c.id === HERO_ID) {
    cases.push({ label: '沒有譜系時', lin: null, rank: null });
    for (const lin of ctx.lineages.values()) for (const r of arr(lin.ranks)) if (isObj(r) && Number.isInteger(r.rank)) cases.push({ lin, rank: r.rank });
  } else if (isObj(c.lineage) && ctx.lineages.has(c.lineage.id)) {
    const lin = ctx.lineages.get(c.lineage.id);
    for (const r of arr(lin.ranks)) if (isObj(r) && Number.isInteger(r.rank)) cases.push({ lin, rank: r.rank });
  }
  const who = c.id === HERO_ID ? `${where}（主角）` : where;
  for (const k of cases) {
    const st = {};
    for (const key of STAT_KEYS) st[key] = isNum(c.base[key]) ? c.base[key] : 0;
    if (k.lin) {
      for (const r of arr(k.lin.ranks)) {
        if (!isObj(r) || !Number.isInteger(r.rank) || r.rank < k.rank || !isObj(r.stats)) continue;
        for (const key of STAT_KEYS) if (isNum(r.stats[key])) st[key] += r.stats[key];
      }
    }
    const label = k.lin ? `譜系「${k.lin.id}」rank ${k.rank} 時` : k.label;
    for (const key of STAT_KEYS) {
      const min = key === 'hp' || key === 'spd' ? 1 : 0;
      if (st[key] < min) ctx.errors.push(`${who}：${label} ${key} 為 ${st[key]}（hp、spd 至少 1，其他不得為負）`);
    }
  }
}

/** 規格補充 2 第 10 條：我方技能（角色 skills、任何譜系階位的 skills）不能有 summon。 */
function checkPartySkills(ctx) {
  const ids = new Set();
  for (const c of ctx.characters.values()) for (const id of arr(c.skills)) ids.add(id);
  for (const lin of ctx.lineages.values()) for (const r of arr(lin.ranks)) if (isObj(r)) for (const id of arr(r.skills)) ids.add(id);
  for (const id of ids) {
    const sk = isStr(id) ? ctx.skills.get(id) : undefined;
    if (sk && arr(sk.effects).some((e) => isObj(e) && e.type === 'summon')) {
      ctx.errors.push(`skills.json 技能「${id}」：我方技能（角色或譜系可用）不能有 summon`);
    }
  }
}

/** 所有劇情效果陣列（對話節點與選項、遭遇 on_win、道具 field_effects）。 */
function allStoryEffects(bundle, ctx) {
  const out = [];
  for (const { dlg } of ctx.dialogues.values()) {
    for (const n of arr(dlg.nodes)) {
      if (!isObj(n)) continue;
      out.push(...arr(n.effects));
      for (const ch of arr(n.choices)) if (isObj(ch)) out.push(...arr(ch.effects));
    }
  }
  for (const enc of ctx.encounters.values()) if (isObj(enc.on_win)) out.push(...arr(enc.on_win.effects));
  for (const it of ctx.items.values()) out.push(...arr(it.field_effects));
  return out;
}

/** 規格補充 2 第 10 條：join_party 可能加入的隊友（不重複）加上主角，靜態上限不超過 MAX_PARTY。 */
function checkPartyLimit(bundle, ctx) {
  const joins = new Set();
  for (const e of allStoryEffects(bundle, ctx)) if (has(e, 'join_party') && isStr(e.join_party) && e.join_party !== HERO_ID) joins.add(e.join_party);
  if (joins.size + 1 > MAX_PARTY) {
    ctx.errors.push(`join_party：可能加入的隊友（${[...joins].join('、')}）加上主角共 ${joins.size + 1} 人，超過隊伍上限 ${MAX_PARTY}`);
  }
}

function checkSkill(sk, ctx) {
  const { errors } = ctx;
  const where = `skills.json 技能「${sk.id}」`;
  if (!isStr(sk.name)) errors.push(`${where}：name 必須是非空字串`);
  if (sk.desc !== undefined && typeof sk.desc !== 'string') errors.push(`${where}：desc 必須是字串`);
  if (!SKILL_TARGETS.includes(sk.target)) errors.push(`${where}：target「${q(sk.target)}」必須是 ${SKILL_TARGETS.join('／')}`);
  if (sk.cost !== undefined) {
    const ok = isObj(sk.cost) && extraKeys(sk.cost, ['sp', 'ammo']).length === 0
      && Object.values(sk.cost).every((v) => Number.isInteger(v) && v >= 0);
    if (!ok) errors.push(`${where}：cost 必須是 { sp?, ammo? }（非負整數），實際為 ${JSON.stringify(sk.cost)}`);
  }
  if (sk.tags !== undefined && !(Array.isArray(sk.tags) && sk.tags.every(isStr))) errors.push(`${where}：tags 必須是字串陣列`);
  if (sk.menu !== undefined && sk.menu !== 'root') errors.push(`${where}：menu 只能是 "root"（顯示在戰鬥指令第一層），實際為 ${JSON.stringify(sk.menu)}`);
  checkBattleEffectList(sk.effects, sk.target, where, 'effects', ctx);
}

function checkAiRule(rule, where, ctx, own) {
  const { errors } = ctx;
  if (!isObj(rule)) {
    errors.push(`${where}：必須是物件`);
    return;
  }
  for (const k of extraKeys(rule, ['skill', 'weight', 'if'])) errors.push(`${where}：不認得的欄位「${k}」`);
  if (!isStr(rule.skill) || !ctx.skills.has(rule.skill)) errors.push(`${where}：skill 引用不存在的技能「${q(rule.skill)}」`);
  else if (Array.isArray(own) && !own.includes(rule.skill)) errors.push(`${where}：skill「${rule.skill}」不在這名敵人的 skills 裡`);
  if (!isNum(rule.weight) || rule.weight <= 0) errors.push(`${where}：weight 必須是正數，實際為 ${JSON.stringify(rule.weight)}`);
  if (rule.if !== undefined) for (const m of checkBattleCondition(rule.if, 'if')) errors.push(`${where}：${m}`);
}

function checkEnemy(en, ctx) {
  const { errors } = ctx;
  const where = `enemies.json 敵人「${en.id}」`;
  if (!isStr(en.name)) errors.push(`${where}：name 必須是非空字串`);
  if (en.sprite !== undefined && !isStr(en.sprite)) errors.push(`${where}：sprite 必須是字串`);
  if (en.summon_text !== undefined && !isStr(en.summon_text)) errors.push(`${where}：summon_text 必須是非空字串`);
  if (!Number.isInteger(en.rank)) errors.push(`${where}：rank 必須是整數`);
  checkStatBlock(en.stats, `${where} 的 stats`, errors);
  checkSkillList(en.skills, where, ctx);
  if (!Array.isArray(en.ai) || en.ai.length === 0) {
    errors.push(`${where}：ai 必須是至少一條規則的陣列`);
  } else {
    en.ai.forEach((rule, i) => checkAiRule(rule, `${where} ai[${i}]`, ctx, en.skills));
    if (!en.ai.some((rule) => isObj(rule) && rule.if === undefined)) errors.push(`${where}：ai 至少要有一條沒有 if 的規則（確保永遠有行動可選）`);
  }
  if (en.phases !== undefined) {
    if (!Array.isArray(en.phases)) errors.push(`${where}：phases 必須是陣列`);
    else en.phases.forEach((ph, i) => {
      const pw = `${where} phases[${i}]`;
      if (!isObj(ph)) { errors.push(`${pw}：必須是物件`); return; }
      for (const k of extraKeys(ph, ['hp_lte_pct', 'add_ai', 'dialogue'])) errors.push(`${pw}：不認得的欄位「${k}」`);
      if (!isNum(ph.hp_lte_pct) || ph.hp_lte_pct < 0 || ph.hp_lte_pct > 100) errors.push(`${pw}：hp_lte_pct 必須是 0～100 的數字`);
      if (ph.add_ai !== undefined) {
        if (!Array.isArray(ph.add_ai)) errors.push(`${pw}：add_ai 必須是陣列`);
        else ph.add_ai.forEach((rule, j) => checkAiRule(rule, `${pw} add_ai[${j}]`, ctx, en.skills));
      }
      refDialogue(ph.dialogue, pw, 'dialogue', ctx);
      checkPhaseDialogue(ph.dialogue, pw, ctx);
    });
  }
  if (en.drops !== undefined) {
    if (!Array.isArray(en.drops)) errors.push(`${where}：drops 必須是陣列`);
    else en.drops.forEach((d, i) => {
      const dw = `${where} drops[${i}]`;
      if (!isObj(d)) { errors.push(`${dw}：必須是物件`); return; }
      if (!isStr(d.item) || !ctx.items.has(d.item)) errors.push(`${dw}：item 引用不存在的道具「${q(d.item)}」`);
      if (!isNum(d.chance) || d.chance <= 0 || d.chance > 100) errors.push(`${dw}：chance 必須是 0（不含）～100 的數字`);
    });
  }
}

/** 規格補充 2 第 5 條：階段對話（戰鬥中播放）只能有 set_flag／clear_flag 效果。 */
function checkPhaseDialogue(id, where, ctx) {
  if (!isStr(id) || !ctx.dialogues.has(id)) return;
  const { dlg } = ctx.dialogues.get(id);
  const bad = new Set();
  for (const n of arr(dlg.nodes)) {
    if (!isObj(n)) continue;
    const effs = [...arr(n.effects), ...arr(n.choices).flatMap((c) => (isObj(c) ? arr(c.effects) : []))];
    for (const e of effs) if (isObj(e)) for (const k of Object.keys(e)) if (!PHASE_DIALOGUE_EFFECTS.includes(k)) bad.add(k);
  }
  if (bad.size) ctx.errors.push(`${where}：dialogue「${id}」是階段對話，只能有 set_flag／clear_flag 效果，實際有「${[...bad].join('」「')}」`);
}

/**
 * 規格補充 2 第 10 條：遭遇「同時在場」敵人數的靜態上限。每種敵人最多＝max(初始數量, 任何會在場的敵人召喚它的 max)，
 * 召喚出來的敵人若也會召喚，一併展開；合計即上限。
 */
function maxEnemiesOnField(ids, ctx) {
  const cap = new Map();
  for (const id of ids) cap.set(id, (cap.get(id) ?? 0) + 1);
  for (let changed = true, guard = 0; changed && guard < 100; guard++) {
    changed = false;
    for (const id of [...cap.keys()]) {
      const en = ctx.enemies.get(id);
      for (const sid of arr(en?.skills)) {
        for (const e of arr(ctx.skills.get(sid)?.effects)) {
          if (!isObj(e) || e.type !== 'summon' || !isStr(e.enemy) || !Number.isInteger(e.max)) continue;
          if ((cap.get(e.enemy) ?? 0) < e.max) { cap.set(e.enemy, e.max); changed = true; }
        }
      }
    }
  }
  return [...cap.values()].reduce((a, b) => a + b, 0);
}

function checkEncounter(enc, ctx) {
  const { errors } = ctx;
  const where = `encounters.json 遭遇「${enc.id}」`;
  if (!Array.isArray(enc.enemies) || enc.enemies.length === 0) errors.push(`${where}：enemies 必須至少一名敵人`);
  else {
    for (const id of enc.enemies) if (!isStr(id) || !ctx.enemies.has(id)) errors.push(`${where}：enemies 引用不存在的敵人「${q(id)}」`);
    if (enc.enemies.length > MAX_ENCOUNTER_ENEMIES) errors.push(`${where}：enemies 最多 ${MAX_ENCOUNTER_ENEMIES} 名，實際 ${enc.enemies.length} 名`);
    const n = maxEnemiesOnField(enc.enemies.filter(isStr), ctx);
    if (n > MAX_ENEMIES_ON_FIELD) errors.push(`${where}：含召喚，同時在場的敵人最多可能有 ${n} 名，超過 ${MAX_ENEMIES_ON_FIELD}`);
  }
  if (enc.bg !== undefined && !isStr(enc.bg)) errors.push(`${where}：bg 必須是字串`);
  if (enc.can_flee !== undefined && !isBool(enc.can_flee)) errors.push(`${where}：can_flee 必須是 true/false`);
  if (enc.on_lose !== undefined && !ON_LOSE.includes(enc.on_lose)) errors.push(`${where}：on_lose「${q(enc.on_lose)}」必須是 retry 或 continue`);
  if (enc.on_win !== undefined) {
    if (!isObj(enc.on_win)) errors.push(`${where}：on_win 必須是物件`);
    else {
      for (const k of extraKeys(enc.on_win, ['effects', 'dialogue'])) errors.push(`${where}：on_win 不認得的欄位「${k}」`);
      checkEffects(enc.on_win.effects, `${where} on_win`, ctx);
      refDialogue(enc.on_win.dialogue, `${where} on_win`, 'dialogue', ctx);
    }
  }
}

function refEncounter(id, where, ctx) {
  if (id === undefined) return;
  if (!isStr(id) || !ctx.encounters.has(id)) ctx.errors.push(`${where}：battle 引用不存在的遭遇「${q(id)}」`);
}

/** 目的地 { map, spawn, dialogue? }（goto、end_screen.continue 共用）。 */
function checkDestination(dest, where, ctx) {
  if (!isObj(dest) || !isStr(dest.map) || !isStr(dest.spawn) || extraKeys(dest, ['map', 'spawn', 'dialogue']).length) {
    ctx.errors.push(`${where} 必須是 { map, spawn, dialogue? }，實際為 ${JSON.stringify(dest)}`);
    return;
  }
  const map = ctx.maps.get(dest.map);
  if (!map) ctx.errors.push(`${where} 引用不存在的地圖「${dest.map}」`);
  else if (!arr(map.spawns).some((sp) => isObj(sp) && sp.id === dest.spawn)) ctx.errors.push(`${where}：地圖「${dest.map}」沒有 spawn「${dest.spawn}」`);
  if (dest.dialogue !== undefined && (!isStr(dest.dialogue) || !ctx.dialogues.has(dest.dialogue))) {
    ctx.errors.push(`${where} 的 dialogue 引用不存在的對話「${q(dest.dialogue)}」`);
  }
}

function checkStoryMeta(story, errors, ctx) {
  const W = `story/${story.id}.json`;
  if (!isStr(story.title)) errors.push(`${W}：title 必須是非空字串`);
  if (!isObj(story.end_screen)) {
    errors.push(`${W}：缺少 end_screen（{ title, subtitle }）`);
    return;
  }
  for (const k of ['title', 'subtitle']) {
    if (!isStr(story.end_screen[k])) errors.push(`${W}：end_screen.${k} 必須是非空字串`);
  }
  if (story.end_screen.continue !== undefined) checkDestination(story.end_screen.continue, `${W}：end_screen.continue`, ctx);
}

// ---------- 免費可達性（fallback 檢查） ----------

const fallbackItemOf = (lock) => {
  const m = isObj(lock) && typeof lock.fallback === 'string' ? /^item:(.+)$/.exec(lock.fallback) : null;
  return m ? m[1] : null;
};

/**
 * 在「免費世界」裡，條件有沒有可能成立（保守的靜態判斷）。
 * 免費世界＝殘響 0；譜系只有「已證明能免費喝下」的（第二階段才有）；flags／items 是目前已證明能免費取得的集合。
 * - flag／item：在集合裡才可能成立。
 * - echo_gte：值 ≤ 0 才成立（殘響 0）；lineage／rank_lte：已喝下的譜系／階位才成立。
 * - in_party：主角，或已證明能免費加入的隊友；ammo_gte：值 ≤ 0，或已證明能免費拿到子彈。
 * - not_flag／not：一律視為可能成立（避免誤報；旗標可能根本沒設）。
 * - any：任一子條件可能成立；all：每個子條件都可能成立。
 * 寫法不合法的條件當作不成立（另有檢查會報錯）。
 */
function maybeTrue(cond, world) {
  if (!isObj(cond)) return false;
  const keys = Object.keys(cond);
  if (keys.length !== 1) return false;
  const [k] = keys;
  const v = cond[k];
  switch (k) {
    case 'flag': return world.flags.has(v);
    case 'item': return world.items.has(v);
    case 'not_flag': return true;
    case 'not': return true;
    case 'echo_gte': return typeof v === 'number' && v <= 0;
    case 'lineage': return world.lineages.has(v);
    case 'rank_lte': return typeof v === 'number' && [...world.lineages.values()].some((r) => r <= v);
    case 'in_party': return v === HERO_ID || world.party.has(v);
    case 'ammo_gte': return typeof v === 'number' && (v <= 0 || world.ammo);
    case 'any': return Array.isArray(v) && v.some((c) => maybeTrue(c, world));
    case 'all': return Array.isArray(v) && v.every((c) => maybeTrue(c, world));
    default: return false;
  }
}
const maybe = (cond, world) => cond === undefined || maybeTrue(cond, world);

const newWorld = () => ({ flags: new Set(), items: new Set(), party: new Set(), ammo: false, lineages: new Map(), tags: new Set() });
const cloneWorld = (w) => ({ flags: new Set(w.flags), items: new Set(w.items), party: new Set(w.party), ammo: w.ammo, lineages: new Map(w.lineages), tags: new Set(w.tags) });

/** 喝下 { id, rank }：記下譜系與階位，並加入已達到階位的 field 標籤。回傳是否有變化。 */
function grantLineage(world, g, ctx) {
  const def = ctx.lineages.get(g.id);
  if (!def || !Number.isInteger(g.rank)) return false;
  let changed = false;
  const cur = world.lineages.get(g.id);
  if (cur === undefined || g.rank < cur) { world.lineages.set(g.id, g.rank); changed = true; }
  for (const r of arr(def.ranks)) {
    if (!isObj(r) || !Number.isInteger(r.rank) || r.rank < g.rank) continue;
    for (const t of arr(r.field)) if (isStr(t) && !world.tags.has(t)) { world.tags.add(t); changed = true; }
  }
  return changed;
}

/**
 * 一個階段的不動點：從 startMaps 與 entries（{ dlg, map }：在哪張地圖上播的對話）出發，反覆擴張直到不再變化。
 * - 入口：entries；可達地圖的 on_enter、if 可能成立的觸發點（dialogue 與 battle）、有 requires 的出口 blocked、
 *   可見（if 可能成立）物件的 look、battle 與 lock.locked；lock 的 on_item 只有在「fallback 道具已在集合中」時才算，
 *   同時把 lock.flag 加入旗標集合。
 * - lineageActive（喝下靈劑之後的階段）：world.tags 裡的標籤可以免費解開 solvable_by 含該標籤的 lock（走 on_tag），
 *   有 trace 時物件的【殘響】對話也免費。
 * - 出口 requires 可能成立 → 目的地圖可達；goto、chapter_end 對應章節的 end_screen.continue → 目的地圖可達，其 dialogue 在該地圖播放。
 * - 遭遇（battle 效果、物件／觸發點的 battle）假設打得贏：on_win.effects 與 on_win.dialogue 算入（在觸發它的地圖播放）。
 *   戰鬥中 phases 的 dialogue 不算（不保證會觸發）。
 * - 對話內沿 next／branches／choices 走；branch／choice 的 if 要可能成立才走；帶 use_echo 的節點或選項不往下走、不算它的效果。
 * - 收集 set_flag／give_item／join_party／give_ammo；set_lineage 記成 grant（第一階段不生效，第二階段立即生效）。
 * 物件 echo（第一階段）與 lock.on_tag（沒有對應的免費標籤時）不算入口；沒人引用的孤兒對話不算。
 */
function explore(ctx, { world, startMaps, entries, lineageActive }) {
  const maps = new Set(startMaps.filter((m) => ctx.maps.has(m)));
  const ents = [];
  const entKeys = new Set();
  const grants = [];
  const grantKeys = new Set();
  const costly = (effects) => arr(effects).some((e) => has(e, 'use_echo'));
  let changed = true;
  const addEntry = (dlg, map) => {
    const key = `${dlg}@${map}`;
    if (!isStr(dlg) || entKeys.has(key)) return;
    entKeys.add(key);
    ents.push({ dlg, map });
    changed = true;
  };
  for (const e of entries) addEntry(e.dlg, e.map);
  const addMap = (id) => { if (ctx.maps.has(id) && !maps.has(id)) { maps.add(id); changed = true; } };
  const addFlag = (f) => { if (isStr(f) && !world.flags.has(f)) { world.flags.add(f); changed = true; } };
  const addDest = (d) => {
    if (!isObj(d) || !isStr(d.map) || !ctx.maps.has(d.map)) return;
    addMap(d.map);
    if (d.dialogue !== undefined) addEntry(d.dialogue, d.map);
  };

  let walked;
  let encWalked;
  const collect = (effects, mapCtx, dlgId) => {
    for (const e of arr(effects)) {
      if (!isObj(e)) continue;
      if (has(e, 'give_item') && isStr(e.give_item) && !world.items.has(e.give_item)) { world.items.add(e.give_item); changed = true; }
      if (has(e, 'set_flag')) addFlag(e.set_flag);
      if (has(e, 'join_party') && isStr(e.join_party) && !world.party.has(e.join_party)) { world.party.add(e.join_party); changed = true; }
      if (has(e, 'give_ammo') && !world.ammo) { world.ammo = true; changed = true; }
      if (has(e, 'set_lineage') && isObj(e.set_lineage)) {
        const g = { id: e.set_lineage.id, rank: e.set_lineage.rank, map: mapCtx, dlg: dlgId };
        const key = `${g.id}:${g.rank}@${g.map}:${g.dlg}`;
        if (!grantKeys.has(key)) { grantKeys.add(key); grants.push(g); }
        if (lineageActive && grantLineage(world, g, ctx)) changed = true;
      }
      if (has(e, 'goto')) addDest(e.goto);
      if (has(e, 'chapter_end')) {
        const story = ctx.storyById.get(e.chapter_end);
        if (isObj(story?.end_screen)) addDest(story.end_screen.continue);
      }
      if (has(e, 'battle')) walkEncounter(e.battle, mapCtx);
    }
  };
  const walkEncounter = (id, mapCtx) => {
    const enc = isStr(id) ? ctx.encounters.get(id) : undefined;
    const key = `${id}@${mapCtx}`;
    if (!enc || encWalked.has(key)) return;
    encWalked.add(key);
    const onWin = isObj(enc.on_win) ? enc.on_win : {};
    collect(onWin.effects, mapCtx, isStr(onWin.dialogue) ? onWin.dialogue : null);
    walk(onWin.dialogue, mapCtx);
  };
  const walk = (id, mapCtx) => {
    const dlg = isStr(id) ? ctx.dialogues.get(id)?.dlg : undefined;
    const key = `${id}@${mapCtx}`;
    if (!dlg || !Array.isArray(dlg.nodes) || walked.has(key)) return;
    walked.add(key);
    const nodes = new Map(dlg.nodes.filter((n) => isObj(n) && isStr(n.id)).map((n) => [n.id, n]));
    const seen = new Set();
    const stack = [dlg.start];
    while (stack.length) {
      const nid = stack.pop();
      if (seen.has(nid) || !nodes.has(nid)) continue;
      seen.add(nid);
      const n = nodes.get(nid);
      if (costly(n.effects)) continue;
      collect(n.effects, mapCtx, id);
      if (isStr(n.next)) stack.push(n.next);
      for (const b of arr(n.branches)) if (isObj(b) && isStr(b.next) && maybe(b.if, world)) stack.push(b.next);
      for (const c of arr(n.choices)) {
        if (!isObj(c) || costly(c.effects) || !maybe(c.if, world)) continue;
        collect(c.effects, mapCtx, id);
        if (isStr(c.next)) stack.push(c.next);
      }
    }
  };

  while (changed) {
    changed = false;
    walked = new Set();
    encWalked = new Set();
    for (let i = 0; i < ents.length; i++) walk(ents[i].dlg, ents[i].map);
    for (const mapId of [...maps]) {
      const map = ctx.maps.get(mapId);
      walk(map.on_enter, mapId);
      for (const t of arr(map.triggers)) {
        if (!isObj(t) || !maybe(t.if, world)) continue;
        walk(t.dialogue, mapId);
        walkEncounter(t.battle, mapId);
      }
      for (const ex of arr(map.exits)) {
        if (!isObj(ex)) continue;
        if (ex.requires !== undefined) walk(ex.blocked, mapId);
        if (maybe(ex.requires, world)) addMap(ex.to);
      }
      for (const obj of arr(map.objects)) {
        if (!isObj(obj) || !maybe(obj.if, world)) continue;
        walk(obj.look, mapId);
        walkEncounter(obj.battle, mapId);
        if (lineageActive && world.tags.has(ECHO_TAG)) walk(obj.echo, mapId);
        if (!isObj(obj.lock)) continue;
        walk(obj.lock.locked, mapId);
        const fb = fallbackItemOf(obj.lock);
        if (fb !== null && world.items.has(fb)) {
          addFlag(obj.lock.flag);
          walk(obj.lock.on_item, mapId);
        }
        if (lineageActive) {
          for (const tag of arr(obj.lock.solvable_by)) {
            if (!world.tags.has(tag)) continue;
            addFlag(obj.lock.flag);
            if (has(obj.lock.on_tag, tag)) walk(obj.lock.on_tag[tag], mapId);
          }
        }
      }
    }
  }
  return { world, maps, grants };
}

/**
 * 兩階段的免費可達性：
 * 1. 喝下靈劑之前（沒有譜系、殘響 0）：從 manifest.start 出發的不動點。記下所有能免費抵達的 set_lineage。
 * 2. 喝下之後：沿用第 1 階段取得的旗標與道具，從「播放 set_lineage 的地圖」重新出發，譜系的 field 標籤免費。
 *    只有第 2 階段還到得了的地圖，lock 才可以用譜系標籤當免費解法（例如喝下讀痕者後的 trace）；
 *    之後回不去的地圖（例如序章）仍必須有免費 fallback。
 */
function analyzeFree(bundle, ctx) {
  ctx.storyById = new Map(arr(bundle.story).filter((s) => isObj(s) && isStr(s.id)).map((s) => [s.id, s]));
  const start = isObj(bundle.manifest) && isObj(bundle.manifest.start) ? bundle.manifest.start : {};
  const s1 = explore(ctx, { world: newWorld(), startMaps: [start.map], entries: [{ dlg: start.dialogue, map: start.map }], lineageActive: false });
  let s2 = null;
  if (s1.grants.length) {
    const world = cloneWorld(s1.world);
    for (const g of s1.grants) grantLineage(world, g, ctx);
    s2 = explore(ctx, {
      world,
      startMaps: s1.grants.map((g) => g.map),
      entries: s1.grants.filter((g) => isStr(g.dlg)).map((g) => ({ dlg: g.dlg, map: g.map })),
      lineageActive: true,
    });
  }
  return {
    items1: s1.world.items, maps1: s1.maps,
    items2: s2 ? s2.world.items : new Set(), maps2: s2 ? s2.maps : new Set(), tags2: s2 ? s2.world.tags : new Set(),
  };
}

/**
 * lock 是否「不花殘響就保證解得開」：
 * - fallback 道具在喝下靈劑之前就能免費取得；或
 * - lock 所在地圖在喝下之後仍到得了，而且（solvable_by 含已免費的譜系標籤，或 fallback 道具在喝下後能免費取得）；或
 * - 地圖完全到不了（另有引用檢查）時，fallback 道具在任一階段能免費取得。
 */
function freelySolvable(lock, item, mapId, free) {
  if (free.items1.has(item)) return true;
  if (free.maps2.has(mapId)) return arr(lock.solvable_by).some((t) => free.tags2.has(t)) || free.items2.has(item);
  return !free.maps1.has(mapId) && free.items2.has(item);
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
    for (const id of conditionRefs(cond, 'in_party')) if (id !== HERO_ID && !ctx.characters.has(id)) ctx.errors.push(`${where}：條件 in_party 引用不存在的角色「${id}」`);
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
    if (has(e, 'battle') && !ctx.encounters.has(e.battle)) ctx.errors.push(`${where}：effects[${i}] battle 引用不存在的遭遇「${e.battle}」`);
    if (has(e, 'set_lineage')) {
      const { id, rank } = e.set_lineage;
      const def = ctx.lineages.get(id);
      if (!def) ctx.errors.push(`${where}：effects[${i}] set_lineage 引用不存在的譜系「${id}」`);
      else if (!arr(def.ranks).some((r) => isObj(r) && r.rank === rank)) ctx.errors.push(`${where}：effects[${i}] set_lineage 譜系「${id}」沒有開放階位 ${rank}`);
    }
    for (const k of ['join_party', 'leave_party']) {
      if (!has(e, k)) continue;
      if (e[k] === HERO_ID) { if (k === 'leave_party') ctx.errors.push(`${where}：effects[${i}] leave_party 不可以讓主角離開隊伍`); }
      else if (!ctx.characters.has(e[k])) ctx.errors.push(`${where}：effects[${i}] ${k} 引用不存在的角色「${e[k]}」`);
    }
    if (has(e, 'goto')) checkDestination(e.goto, `${where}：effects[${i}] goto`, ctx);
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
    refEncounter(obj.battle, where, ctx);
    if (obj.lock !== undefined) checkLock(obj.lock, where, ctx, map.id);
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
    if (checkPos(trg, `觸發點「${trg.id}」`)) {
      for (const obj of objects.values()) {
        if (obj.x === trg.x && obj.y === trg.y && obj.solid === true) {
          errors.push(`${where}：與 solid 物件「${obj.id}」重疊，永遠踩不到`);
        }
      }
    }
    refDialogue(trg.dialogue, where, 'dialogue', ctx, trg.battle === undefined); // 有 battle 時 dialogue 可省略
    refEncounter(trg.battle, where, ctx);
    if (trg.if !== undefined) checkCond(trg.if, where, ctx);
  }
}

function checkLock(lock, where, ctx, mapId) {
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
    else if (!freelySolvable(lock, m[1], mapId, ctx.free)) {
      errors.push(`${where}：lock.fallback 道具「${m[1]}」無法從免費入口取得（不花殘響、沒有譜系時，必須能從 start／可達地圖的 on_enter／觸發點／look／locked、或已能用道具開的鎖的 on_item 對話裡拿到；條件不可能成立的選項／branch／物件／觸發點／出口、物件 echo、lock.on_tag、要花殘響的選項、孤兒對話、以及只靠這道鎖自己 on_item 的循環都不算）`);
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

const usesEcho = (effects) => arr(effects).some((e) => has(e, 'use_echo'));
/** 條件成立時是否保證殘響 ≥ 1：echo_gte ≥ 1 的葉，或 all 裡任一子條件保證。any／not 不算。 */
function guaranteesEcho(cond) {
  if (!isObj(cond)) return false;
  if (has(cond, 'echo_gte')) return typeof cond.echo_gte === 'number' && cond.echo_gte >= 1;
  if (has(cond, 'all') && Array.isArray(cond.all)) return cond.all.some(guaranteesEcho);
  return false;
}

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
          if (usesEcho(c.effects) && !guaranteesEcho(c.if)) {
            errors.push(`${cw}：有 use_echo 的選項必須用 if 保證 echo_gte ≥ 1（例如 { "echo_gte": 1 }），否則殘響 0 時選了會出錯`);
          }
        });
        if (n.choices.every((c) => isObj(c) && c.if !== undefined)) {
          errors.push(`${where}：至少要有一個沒有 if 的選項，確保永遠有路可走`);
        }
      }
    }
    if (n.text !== undefined && n.text !== null && typeof n.text !== 'string') errors.push(`${where}：text 必須是字串`);
    if (n.speaker !== undefined && n.speaker !== null && typeof n.speaker !== 'string') errors.push(`${where}：speaker 必須是字串或 null`);
    checkEffects(n.effects, where, ctx);
    if (usesEcho(n.effects)) {
      errors.push(`${where}：use_echo 只能放在選項上（並以 if 的 echo_gte ≥ 1 守門），不可放在節點的 effects`);
    }
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
