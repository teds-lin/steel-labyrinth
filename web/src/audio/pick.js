// 選曲（M6 P3）：依目前畫面與資料決定背景音樂（bgm）與環境音（amb）。純函式，node 可測。
// 地圖、遭遇、結局可以在私有原稿的資料裡指定 bgm／amb（null＝安靜；欄位不存在＝用 catalog.defaults），
// 所以哪張地圖放什麼會跟著章節開放，公開的目錄不列地圖或戰鬥 id（防劇透）。
//
// 回傳：null＝不換（選單、Boot、未知畫面、地圖資料還沒有）；
//       { bgm, amb }；amb 不出現＝環境音不變（戰鬥沿用地圖的環境音，由 director 壓低）；battle: true＝戰鬥（地圖曲暫停、結束後接回）。

const own = (o, k) => !!o && typeof o === 'object' && Object.hasOwn(o, k);
const cueOr = (o, k, fallback) => (own(o, k) && (o[k] === null || typeof o[k] === 'string') ? o[k] : fallback);

export function pickMusic(ctx, catalog) {
  const d = catalog?.defaults && typeof catalog.defaults === 'object' ? catalog.defaults : {};
  const def = (k) => (typeof d[k] === 'string' ? d[k] : null);
  switch (ctx?.scene) {
    case 'Title':
    case 'Name':
      return { bgm: def('title'), amb: null };
    case 'Map': {
      const m = ctx.map;
      if (!m || typeof m !== 'object') return null;
      const dream = m.dream === true;
      return { bgm: cueOr(m, 'bgm', def(dream ? 'dream' : 'map')), amb: cueOr(m, 'amb', def(dream ? 'dream_amb' : 'map_amb')) };
    }
    case 'Battle':
      return { bgm: cueOr(ctx.encounter, 'bgm', def('battle')), battle: true };
    case 'ChapterEnd':
      return { bgm: ctx.ending ? cueOr(ctx.ending, 'bgm', def('ending')) : def('chapter_end'), amb: null };
    case 'GameOver':
      return { bgm: def('game_over'), amb: null };
    case 'DreamChat':
      return { bgm: def('dream_chat') };
    default:
      return null;
  }
}
