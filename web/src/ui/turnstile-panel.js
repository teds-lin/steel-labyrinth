// 在 Phaser 場景裡放一個 Turnstile 小工具（DOM 容器），取得 token 後回呼。
// 小工具的內容由 Cloudflare 的 iframe 產生；我們只建立空的 div，不寫入任何 HTML。
import { runTurnstile } from '../cloud/turnstile.js';
import { turnstile } from '../cloud-client.js';

/**
 * scene：Phaser 場景；(x, y)：小工具中心的邏輯座標；action：'create_player'｜'dream_pass'。
 * onResult(r)：r 為 runTurnstile 的結果（cancelled 不回呼）。回傳 { cancel, dispose }。
 */
export function mountTurnstile(scene, x, y, { action, onResult }) {
  const div = document.createElement('div');
  div.className = 'sl-turnstile';
  div.setAttribute('aria-label', '人機驗證');
  const dom = scene.add.dom(x, y, div);
  const h = runTurnstile({ loader: turnstile.loader, container: div, sitekey: turnstile.sitekey(), action });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { dom.destroy(); } catch { /* 場景已關閉 */ }
  };
  h.promise.then((r) => {
    if (r.kind === 'cancelled') return;
    if (r.ok) h.dispose();
    close();
    onResult(r);
  });
  scene.events.once('shutdown', () => { h.cancel(); close(); });
  return { cancel: () => { h.cancel(); close(); }, element: div };
}
