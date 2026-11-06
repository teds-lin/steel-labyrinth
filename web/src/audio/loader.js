// 音檔載入（不用 Phaser Loader：它在失敗時會 console.error）：自己 fetch＋decodeAudioData。
// 依序嘗試每個網址（通常是 ogg 再 m4a），每個只試一次；規則見 loadFirstDecodable。失敗由呼叫端 warn 一次並保持安靜。

/** decodeAudioData 同時支援 Promise（新版）與回呼（舊版 Safari）兩種寫法。 */
export function decodeCompat(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
    const bad = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e ?? '解碼失敗'))); } };
    try {
      const p = ctx.decodeAudioData(arrayBuffer, ok, bad);
      if (p && typeof p.then === 'function') p.then(ok, bad);
    } catch (e) {
      bad(e);
    }
  });
}

/** 換下一個格式才可能成功的 HTTP 狀態：檔案不存在、伺服器不接受該格式。 */
const NEXT_FORMAT_STATUS = new Set([404, 415]);

/**
 * urls 依序嘗試（通常是 ogg 再 m4a）；回傳 { buffer, url }。fetch／decode 由呼叫端注入（測試可替換）。
 * - 解碼失敗、HTTP 404／415：換下一個格式。
 * - 其他 HTTP 錯誤（例如 500）：直接 reject（換格式也沒用）。
 * - 網路層失敗（fetch reject）：立即 reject，錯誤帶 network:true，呼叫端據此斷路、停止預載其餘音檔。
 */
export async function loadFirstDecodable(urls, { fetch, decode }) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error('沒有可用的音檔網址');
  const reasons = [];
  for (const url of urls) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      const err = new Error(`音檔下載失敗（網路）：${url}：${e?.message ?? e}`);
      err.network = true;
      throw err;
    }
    if (!res.ok) {
      reasons.push(`${url}：HTTP ${res.status}`);
      if (NEXT_FORMAT_STATUS.has(res.status)) continue;
      throw new Error(`音檔載入失敗（${reasons.join('；')}）`);
    }
    try {
      const ab = await res.arrayBuffer();
      return { buffer: await decode(ab), url };
    } catch (e) {
      reasons.push(`${url}：${e?.message ?? e}`);
    }
  }
  throw new Error(`音檔載入失敗（${reasons.join('；')}）`);
}
