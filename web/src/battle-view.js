// 戰鬥畫面用的純函式：把 core 的戰鬥狀態與 log 事件轉成要顯示的文字。不修改輸入、不碰 Phaser。
import { intentOf } from './core/battle/engine.js';
import { graphemes } from './core/name.js';

export const STATUS_NAMES = Object.freeze({ sleep: '睡眠', confuse: '混亂', taunt: '嘲諷', guard: '防禦', bind: '影縛', silence: '禁聲' });
export const STAT_NAMES = Object.freeze({ atk: '攻擊', def: '防禦', spd: '速度', will: '意志', eva: '閃避', hp: '生命', sp: '靈性' });
export const REASON_TEXT = Object.freeze({ sp: '靈性不足', ammo: '子彈不足', no_target: '沒有可選的目標', silence: '禁聲中，無法使用' });
export const OUTCOME_TITLE = Object.freeze({ victory: '勝利', defeat: '戰敗', lost_control: '失控', fled: '成功逃脫' });

const findIn = (list, id) => (Array.isArray(list) ? list.find((x) => x && x.id === id) : undefined);

/**
 * 每個 uid 的顯示名稱。同名的敵人（例如兩隻霧行者）依出場順序加上 A、B、C…，
 * 只有一隻時不加。召喚出來的敵人接在後面編號。
 */
export function unitLabels(battle) {
  const out = {};
  const byName = new Map();
  for (const u of battle.units) {
    if (u.side !== 'enemy') { out[u.uid] = u.name; continue; }
    if (!byName.has(u.name)) byName.set(u.name, []);
    byName.get(u.name).push(u.uid);
  }
  for (const [name, uids] of byName) {
    uids.forEach((uid, i) => { out[uid] = uids.length > 1 ? `${name}${String.fromCharCode(65 + i)}` : name; });
  }
  return out;
}

/** 行動順序列用的縮寫：名字前兩個字（主角的名字、「霧行者A」→「霧A」）。 */
export function shortLabel(label) {
  const g = graphemes(String(label ?? ''));
  const suffix = /[A-Z]$/.test(label ?? '') ? g[g.length - 1] : '';
  const base = suffix ? g.slice(0, -1) : g;
  return suffix ? `${base[0] ?? ''}${suffix}` : base.slice(0, 2).join('');
}

export const skillName = (data, id) => findIn(data?.skills, id)?.name ?? id ?? '';
export const itemName = (data, id) => findIn(data?.items, id)?.name ?? id ?? '';

/** 技能消耗的文字：「靈性 4」「子彈 1」，沒有消耗回「不消耗」。 */
export function costText(cost) {
  const parts = [];
  if (cost?.sp > 0) parts.push(`靈性 ${cost.sp}`);
  if (cost?.ammo > 0) parts.push(`子彈 ${cost.ammo}`);
  return parts.length ? parts.join('・') : '不消耗';
}

export const reasonText = (reason) => (reason ? REASON_TEXT[reason] ?? '現在無法使用' : '');

/** 技能按鈕的短資訊：可用時只放消耗，不可用時接上原因；完整描述改放在說明框（entry.detail）。 */
export const skillSub = (s) => (s.usable ? costText(s.cost) : `${costText(s.cost)}｜${reasonText(s.reason)}`);

/** 道具按鈕的短資訊：可用時不放字（描述在說明框），不可用時說明原因。 */
export const itemSub = (usable) => (usable ? null : '沒有可選的目標');

/** 說明框要顯示的文字：取聚焦項目的 detail；沒有（下一頁、返回、目標按鈕）回空字串。 */
export const helpText = (entry) => (typeof entry?.detail === 'string' ? entry.detail.trim() : '');

/** 說明框的字級、內距與預留行數（邏輯座標）。文字不截斷；預留行數＝玩家選單所有描述的最大行數（資料測試保證）。 */
export const HELP_BOX = Object.freeze({ fontSize: 15, minFontSize: 12, padX: 12, padY: 8, lineSpacing: 3, lineHeight: 22, lines: 2 });

/** 清單版面（技能、道具）：標題、說明框、按鈕由上而下都在面板內（y ≥ panelTop），不往戰場長。 */
export function listLayout() {
  const panelTop = 316;
  const textCap = HELP_BOX.lines * HELP_BOX.lineHeight + (HELP_BOX.lines - 1) * HELP_BOX.lineSpacing;
  const helpY = panelTop + 20;
  const helpH = textCap + HELP_BOX.padY * 2;
  return {
    panelTop,
    title: { centerY: panelTop + 11, bottom: panelTop + 20 },
    help: { y: helpY, h: helpH, textCap },
    buttons: { firstCenter: helpY + helpH + 3 + 22, h: 44, gap: 2 },
  };
}

/** 子選單標題：行動者名字已在上方的提示句（「○○要怎麼做？」），標題不重複。 */
export function menuTitle(kind, { sp = 0, maxSp = 0 } = {}) {
  return kind === 'skills' ? `技能　靈性 ${sp}/${maxSp}` : '道具';
}

export const TAP_AGAIN_HINT = '點一下使用';

/** 觸控：清單裡有說明的項目，第一次點未聚焦的只聚焦（看說明），已聚焦才使用。 */
export const shouldFocusFirst = ({ touch, layout, focused, hasDetail }) => !!touch && layout === 'list' && !focused && !!hasDetail;

/** 副標接上「點一下使用」提示（只在觸控且該項目已聚焦、可用時 with=true）。 */
export function subWithHint(base, withHint) {
  const b = base ?? '';
  if (!withHint) return b;
  return b ? `${b}｜${TAP_AGAIN_HINT}` : TAP_AGAIN_HINT;
}

/**
 * 估算說明文字換行後的行數（單元測試用；實機以 Phaser 量測為準，見 e2e）。
 * 依據：中文字與全形標點寬度 = 字級，半形英數約 0.56 倍字級；逐字換行（中文沒有空白可斷）。
 */
export function estimateHelpLines(text, wrapWidth, fontSize = HELP_BOX.fontSize) {
  let lines = 0;
  for (const para of String(text ?? '').split('\n')) {
    let used = 0;
    let n = 1;
    for (const ch of graphemes(para)) {
      const w = /[\u0020-\u007e]/.test(ch) ? fontSize * 0.56 : fontSize;
      if (used + w > wrapWidth) { n += 1; used = 0; }
      used += w;
    }
    lines += n;
  }
  return lines;
}

/** 我方回合的提示；不能逃跑的戰鬥（canFlee === false）要明講，免得玩家以為「逃跑」鍵不見了。 */
export const commandPrompt = (label, canFlee) => `${label}要怎麼做？${canFlee === false ? '（無法逃跑）' : ''}`;

/**
 * 被預兆揭露的意圖文字：「下一步：重擊 → 雷恩」。單體以外的技能不寫目標（全體寫「全體」）。
 * 沒有被揭露時回 null。
 */
export function intentText(battle, uid, data, labels = unitLabels(battle)) {
  const it = intentOf(battle, uid, data);
  if (!it) return null;
  return formatIntent({ uid, skill: it.skill, skill_name: it.skill_name, target: it.target }, data, labels);
}

/**
 * 意圖 → 「下一步：重擊 → 雷恩」。intent：{ uid（敵人自己）, skill, skill_name?, target?, target_name? }。
 * 目標名稱優先用畫面標籤（同名敵人有 A、B），沒有時用 target_name。
 */
export function formatIntent(intent, data, labels = {}) {
  const skill = findIn(data?.skills, intent.skill);
  const name = intent.skill_name ?? skill?.name ?? intent.skill ?? '';
  if (skill?.target === 'enemy_all') return `下一步：${name} → 全體`;
  const t = intent.target;
  const tName = (t && labels[t]) || intent.target_name || null;
  if (t && tName && t !== intent.uid) return `下一步：${name} → ${tName}`;
  return `下一步：${name}`;
}

/** intent_revealed 事件 → 意圖（給 formatIntent）。 */
export const revealedIntent = (ev) => ({
  uid: ev.target, skill: ev.skill, skill_name: ev.skill_name, target: ev.intent_target ?? null, target_name: ev.intent_target_name ?? null,
});

/** 召喚訊息：敵人的 summon_text（可含 {name}；不含時接在名字後面），沒有時「{name}出現了！」。 */
export function summonText(name, def) {
  const t = typeof def?.summon_text === 'string' && def.summon_text.trim() ? def.summon_text : '{name}出現了！';
  return t.includes('{name}') ? t.split('{name}').join(name) : `${name}${t}`;
}

/** log 事件 → 訊息列的文字；不需要文字的事件回 null。 */
export function describe(ev, labels, data) {
  const n = (uid) => labels[uid] ?? uid ?? '';
  switch (ev.type) {
    case 'turn_start': return null;
    case 'sleep_skip': return `${n(ev.uid)}睡著了，無法行動`;
    case 'bind_skip': return `${n(ev.uid)}被影子縛住，動彈不得`;
    case 'wake': return `${n(ev.uid)}醒過來了！`;
    case 'expire': return null;
    case 'action':
      if (ev.item) return `${n(ev.uid)}使用了${itemName(data, ev.item)}`;
      return `${n(ev.uid)}的「${skillName(data, ev.skill)}」`;
    case 'cost': return null;
    case 'item_used': return null;
    case 'confused': return `${n(ev.uid)}陷入混亂，搞錯了目標！`;
    case 'retarget': return `目標已經倒下，改向${n(ev.to)}出手`;
    case 'miss': return `${n(ev.target)}閃開了！`;
    case 'crit': return '爆擊！';
    case 'damage': return `${n(ev.target)}受到 ${ev.amount} 點傷害`;
    case 'heal': return `${n(ev.target)}回復了 ${ev.amount} 點生命`;
    case 'sp': return ev.amount >= 0 ? `${n(ev.target)}回復了 ${ev.amount} 點靈性` : `${n(ev.target)}失去了 ${-ev.amount} 點靈性`;
    case 'buff': return `${n(ev.target)}的${STAT_NAMES[ev.stat] ?? ev.stat}提升了`;
    case 'debuff': return `${n(ev.target)}的${STAT_NAMES[ev.stat] ?? ev.stat}下降了`;
    case 'status': return ev.status === 'guard' ? `${n(ev.target)}擺好了防禦架勢` : `${n(ev.target)}陷入${STATUS_NAMES[ev.status] ?? ev.status}`;
    case 'status_resisted': return `${n(ev.target)}抵抗了${STATUS_NAMES[ev.status] ?? ev.status}`;
    case 'intent_revealed': return `看穿了${n(ev.target)}的${formatIntent(revealedIntent(ev), data, labels)}`;
    case 'collapse': return ev.amount >= 0 ? `崩解上升了 ${ev.amount}` : `崩解下降了 ${-ev.amount}`;
    case 'summon': return summonText(n(ev.uid), findIn(data?.enemies, ev.enemy));
    case 'summon_failed': return '但是什麼也沒有出現';
    case 'phase': return null;
    case 'defeated': return `${n(ev.uid)}倒下了`;
    case 'drop': return `${n(ev.uid)}掉落了${itemName(data, ev.item)}`;
    case 'victory': return '戰鬥勝利！';
    case 'defeat': return '隊伍全滅了……';
    case 'lost_control': return '崩解到達極限，失去了控制……';
    case 'fled': return '成功逃脫了！';
    case 'flee_failed': return '逃跑失敗了！';
    default: return null;
  }
}

/** 掉落 → 「繃帶 ×1」的清單文字。 */
export function rewardLines(rewards, data) {
  const items = Array.isArray(rewards?.items) ? rewards.items : [];
  return items.map((d) => `${itemName(data, d.item)} ×${d.count}`);
}
