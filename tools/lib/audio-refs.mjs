// 資料裡的聲音引用（M6 P3）對照音訊目錄（web/audio/catalog.json）：地圖的 bgm／amb、遭遇與結局的 bgm。
// validate.js 只檢查型別（遊戲啟動時跑，聲音問題不能擋住遊戲）；cue 是否存在、種類對不對由這裡在 check-data（CI）把關。
const arr = (v) => (Array.isArray(v) ? v : []);

/** 回傳錯誤訊息陣列。值為 null（安靜）或欄位不存在（用目錄預設）都合法。 */
export function checkAudioRefs(bundle, catalog) {
  const errors = [];
  const cues = catalog?.cues && typeof catalog.cues === 'object' ? catalog.cues : {};
  const check = (where, k, v, kind) => {
    if (typeof v !== 'string') return; // null＝安靜、沒寫＝預設；其他型別由 validate.js 報錯，這裡不重複
    const c = Object.hasOwn(cues, v) ? cues[v] : null;
    if (!c) errors.push(`${where}：${k}「${v}」不在音訊目錄（web/audio/catalog.json）`);
    else if (c.kind !== kind) errors.push(`${where}：${k}「${v}」是 ${c.kind}，這裡必須是 ${kind}`);
  };
  for (const m of arr(bundle?.maps)) {
    check(`maps/${m?.id}.json`, 'bgm', m?.bgm, 'bgm');
    check(`maps/${m?.id}.json`, 'amb', m?.amb, 'amb');
  }
  for (const e of arr(bundle?.encounters)) check(`encounters.json 遭遇「${e?.id}」`, 'bgm', e?.bgm, 'bgm');
  for (const s of arr(bundle?.story)) {
    for (const e of arr(s?.endings)) check(`story/${s?.id}.json 結局「${e?.id}」`, 'bgm', e?.bgm, 'bgm');
  }
  return errors;
}
