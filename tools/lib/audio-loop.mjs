// 循環長度量測：渲染器（FluidSynth）的時間量化會讓第 2 次重複比理論位置晚幾個取樣點，
// 用正規化互相關在預期週期附近找出實際週期（取樣點精度）。
/**
 * x：單聲道取樣；expected：預期週期（取樣點）；search：往前後找的範圍；window：比對窗長；at：比對窗起點。
 * 回傳 { period, score（正規化相關係數，1＝完全相同） }。
 */
export function findPeriod(x, { expected, search, window, at }) {
  if (at + expected + search + window > x.length || expected - search < 1) throw new Error('資料不夠長，無法量測週期');
  let e1 = 0;
  for (let i = 0; i < window; i++) e1 += x[at + i] * x[at + i];
  let best = { period: expected, score: -Infinity };
  for (let lag = expected - search; lag <= expected + search; lag++) {
    let dot = 0;
    let e2 = 0;
    for (let i = 0; i < window; i++) {
      const b = x[at + lag + i];
      dot += x[at + i] * b;
      e2 += b * b;
    }
    const score = dot / (Math.sqrt(e1 * e2) || 1);
    if (score > best.score || (score === best.score && Math.abs(lag - expected) < Math.abs(best.period - expected))) best = { period: lag, score };
  }
  return best;
}

/**
 * 交叉淡化的品質（轉檔前模擬）：a＝循環開頭 xfade 段、b＝循環結尾之後的 xfade 段（同長度、單聲道）。
 * 回傳 { corr（兩段的正規化相關）,
 *         worstDb（以 win 個取樣點為窗，淡化結果比兩段中較小聲的那段還低最多幾 dB，負數＝凹洞：相位抵消、線性曲線用在不相關的兩段）,
 *         peakDb（淡化結果比兩段中較大聲的那段還高最多幾 dB，正數＝鼓起：等功率曲線用在高度相關的兩段） }。
 * 窗長取 min(win, 淡化長度)，短淡化也會檢查。
 * 線性曲線只適合高度相關的兩段（相關低時會互相抵消、出現凹洞）；等功率適合不相關的兩段。
 */
export function crossfadeReport(a, b, curve, win = 2205) {
  const n = Math.min(a.length, b.length);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  const corr = ab / (Math.sqrt(aa * bb) || 1);
  let worstDb = 0;
  let peakDb = 0;
  win = Math.max(1, Math.min(win, n));
  const step = Math.max(1, Math.floor(win / 2));
  for (let k = 0; k + win <= n; k += step) {
    let ea = 0;
    let eb = 0;
    let eo = 0;
    for (let i = k; i < k + win; i++) {
      const t = n > 1 ? i / (n - 1) : 1;
      const fi = curve === 'tri' ? t : Math.sin((t * Math.PI) / 2);
      const fo = curve === 'tri' ? 1 - t : Math.cos((t * Math.PI) / 2);
      const o = a[i] * fi + b[i] * fo;
      ea += a[i] * a[i];
      eb += b[i] * b[i];
      eo += o * o;
    }
    // 凹洞＝比兩段都小聲（兩段音量不同時，從一段過渡到另一段的音量變化不算凹洞）
    const lo = Math.min(ea, eb);
    const hi = Math.max(ea, eb);
    if (lo / win > 1e-8) worstDb = Math.min(worstDb, 10 * Math.log10(eo / lo + 1e-12));
    if (hi / win > 1e-8) peakDb = Math.max(peakDb, 10 * Math.log10(eo / hi + 1e-12));
  }
  return { corr, worstDb, peakDb };
}
