// 音訊目錄（web/audio/catalog.json）：驗證規則、格式選擇、cue 的檔案網址（純函式，node 可測）。
// 目錄只列音檔本身（通用名稱），不列地圖或戰鬥 id；哪裡用哪首寫在私有原稿的地圖／遭遇資料（防劇透）。

/** 每個 cue 都有兩種格式：Ogg Vorbis 與 AAC（m4a）。 */
export const AUDIO_FORMATS = Object.freeze(['ogg', 'm4a']);
/** 程序合成音（不下載音檔）。 */
export const SYNTHS = Object.freeze(['bell']);
export const KINDS = Object.freeze(['bgm', 'amb', 'sfx']);

const ID_RE = /^[a-z][a-z0-9_]*$/;
const EVENT_KEY_RE = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const SRC_RE = /^(bgm|amb|sfx)\/[a-z0-9_]+(\.v[0-9]+)?$/;

/** 回傳 { ok, errors }。只檢查結構；檔案是否存在由單元測試（磁碟檢查）把關。 */
export function validateCatalog(cat) {
  const errors = [];
  if (!cat || typeof cat !== 'object' || Array.isArray(cat)) return { ok: false, errors: ['catalog 不是物件'] };
  if (cat.version !== 1) errors.push(`version 必須是 1（目前 ${JSON.stringify(cat.version)}）`);
  const cues = cat.cues;
  if (!cues || typeof cues !== 'object' || Array.isArray(cues)) {
    errors.push('缺少 cues 物件');
    return { ok: false, errors };
  }
  for (const [id, c] of Object.entries(cues)) {
    const at = `cues.${id}`;
    if (!ID_RE.test(id)) errors.push(`${at}：cue id 只能用小寫英數與底線`);
    if (!c || typeof c !== 'object') { errors.push(`${at}：不是物件`); continue; }
    if (!KINDS.includes(c.kind)) errors.push(`${at}：kind 必須是 ${KINDS.join('／')}`);
    const hasSrc = c.src !== undefined;
    const hasSynth = c.synth !== undefined;
    if (hasSrc === hasSynth) errors.push(`${at}：src 與 synth 必須剛好有一個`);
    if (hasSrc) {
      if (typeof c.src !== 'string' || !SRC_RE.test(c.src) || !c.src.startsWith(`${c.kind}/`)) {
        errors.push(`${at}：src 必須是「${c.kind}/名稱」（不含副檔名）`);
      }
      if (typeof c.credit !== 'string' || !c.credit) errors.push(`${at}：有 src 就必須有 credit（CREDITS 來源 id）`);
    }
    if (hasSynth && !SYNTHS.includes(c.synth)) errors.push(`${at}：未知的 synth「${c.synth}」`);
    if (c.volume !== undefined && !(typeof c.volume === 'number' && c.volume >= 0 && c.volume <= 1)) {
      errors.push(`${at}：volume 必須介於 0～1`);
    }
    if (c.loop !== undefined && typeof c.loop !== 'boolean') errors.push(`${at}：loop 必須是布林值`);
    // 同時發聲上限的優先序（M6 P2）：priority＝不受上限；exempt＝不受上限也不佔額度
    if (c.burst !== undefined && c.burst !== 'priority' && c.burst !== 'exempt') errors.push(`${at}：burst 只能是 priority 或 exempt`);
  }
  if (cat.defaults !== undefined) {
    if (!cat.defaults || typeof cat.defaults !== 'object' || Array.isArray(cat.defaults)) {
      errors.push('defaults 必須是物件');
    } else {
      for (const [k, v] of Object.entries(cat.defaults)) {
        if (v !== null && !(typeof v === 'string' && Object.hasOwn(cues, v))) errors.push(`defaults.${k}：找不到 cue「${v}」`);
      }
    }
  }
  if (cat.events !== undefined) {
    // 事件鍵 → cue（M6 P2）：值必須是存在的 sfx cue，或 null（刻意不發聲）
    if (!cat.events || typeof cat.events !== 'object' || Array.isArray(cat.events)) {
      errors.push('events 必須是物件');
    } else {
      for (const [k, v] of Object.entries(cat.events)) {
        if (!EVENT_KEY_RE.test(k)) errors.push(`events：事件鍵「${k}」格式不對（例如 battle.hit）`);
        if (v !== null && !(typeof v === 'string' && Object.hasOwn(cues, v) && cues[v]?.kind === 'sfx')) {
          errors.push(`events.${k}：必須是存在的 sfx cue 或 null（目前 ${JSON.stringify(v)}）`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 依瀏覽器支援決定嘗試順序：支援 Ogg Vorbis 時先 ogg、失敗再退 m4a；否則只用 m4a。 */
export function chooseFormats(canPlayType) {
  try {
    if (canPlayType('audio/ogg; codecs="vorbis"')) return ['ogg', 'm4a'];
  } catch { /* 判斷不了就用最保守的 m4a */ }
  return ['m4a'];
}

/** cue 的候選網址（依格式順序）；合成音回空陣列。 */
export function cueUrls(cue, formats, base) {
  if (!cue || typeof cue.src !== 'string') return [];
  return formats.map((f) => `${base}${cue.src}.${f}`);
}
