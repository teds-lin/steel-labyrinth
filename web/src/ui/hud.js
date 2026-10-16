// HUD 顯示用的純函式：把 state 的數值轉成要畫的文字。
// 數值異常（NaN、負數、超大、非整數、字串）一律先 clamp，絕不因此丟錯。

/** 殘響最多畫幾個點；超過的用數字表示。 */
export const ECHO_DOTS_MAX = 10;
const ECHO_NUM_MAX = 99;
const COLLAPSE_HUD_MAX = 100;

function toInt(v, lo, hi) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * 殘響區文字。view 來自 core 的 echoAvailable(state, data)：{ free, charges }，
 * max 是新遊戲的殘響次數（manifest.start.echo_charges），用來畫空心點。
 * 回傳 { text, filled, free }。
 */
export function echoHud({ charges, free = false, max = 0 } = {}) {
  if (free === true) return { text: '回溯 ∞', filled: 0, free: true };
  const n = toInt(charges, 0, ECHO_NUM_MAX);
  if (n > ECHO_DOTS_MAX) {
    return { text: `殘響 ${'●'.repeat(ECHO_DOTS_MAX)} ${n}`, filled: ECHO_DOTS_MAX, free: false };
  }
  const total = Math.max(n, toInt(max, 0, ECHO_DOTS_MAX));
  return { text: `殘響 ${'●'.repeat(n)}${'○'.repeat(total - n)}`, filled: n, free: false };
}

/** 崩解值：回傳 { value, text, ratio, danger }。 */
export function collapseHud(c, max = COLLAPSE_HUD_MAX) {
  const top = toInt(max, 1, 10_000);
  const value = toInt(c, 0, top);
  return { value, text: `崩解 ${value}/${top}`, ratio: value / top, danger: value >= top * 0.6 };
}

/** 子彈：持有左輪或還有子彈時才顯示。回傳 { text, show }。 */
export function ammoHud(ammo, { hasGun = false } = {}) {
  const n = toInt(ammo, 0, 99);
  return { text: `子彈 ${n}`, show: hasGun || n > 0, value: n };
}

/** 讀痕者共鳴度：resonance 各事件的合計（M2 只顯示、不晉升）。 */
export function resonanceHud(resonance) {
  const vals = resonance && typeof resonance === 'object' ? Object.values(resonance) : [];
  const total = vals.reduce((a, v) => a + toInt(v, 0, 9999), 0);
  return { text: `共鳴 ${total}`, value: total };
}

/** 隊伍生命的精簡顯示：[{ name, hp, max, ratio, text }]（名字只取前兩個字）。 */
export function partyHud(list) {
  return (Array.isArray(list) ? list : []).map((m) => {
    const max = toInt(m?.max?.hp, 0, 99999);
    const hp = toInt(m?.hp, 0, max || 99999);
    const name = String(m?.name ?? '');
    const short = Array.from(name.split('・')[0]).slice(0, 2).join('');
    return { id: m?.id ?? null, name: short, hp, max, ratio: max > 0 ? hp / max : 0, text: `${short} ${hp}/${max}` };
  });
}
