// 流量統計：Cloudflare Web Analytics（不使用 cookie、不蒐集個人資料）。
// 只在正式網站載入；本機開發與 ?test=1（自動測試）一律不載入，避免把測試流量算進去。
export const ANALYTICS_HOST = 'teds-lin.github.io';
const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
const BEACON_TOKEN = '627408e0a6d24f15b16fe0acea4cafd7'; // 公開的站點 token，本來就會出現在網頁原始碼

export function shouldLoadAnalytics(location) {
  if (location?.hostname !== ANALYTICS_HOST) return false;
  return !new URLSearchParams(location.search ?? '').has('test');
}

export function beaconAttrs() {
  return { src: BEACON_SRC, beacon: JSON.stringify({ token: BEACON_TOKEN }) };
}

/** 符合條件時在 <head> 插入 beacon；回傳是否有插入。 */
export function loadAnalytics(location = window.location, doc = document) {
  if (!shouldLoadAnalytics(location)) return false;
  const { src, beacon } = beaconAttrs();
  const s = doc.createElement('script');
  s.defer = true;
  s.src = src;
  s.setAttribute('data-cf-beacon', beacon);
  doc.head.appendChild(s);
  return true;
}
