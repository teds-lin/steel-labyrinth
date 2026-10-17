// E2E 用的假 Turnstile：攔截官方腳本網址，改回一段定義 window.turnstile 的程式（不連外網、結果可控制）。
// 模式由頁面上的 window.__FAKE_TS_MODE 決定（預設 'pass'）：
//   'pass'：顯示小工具後約 80 毫秒回呼 token（Cloudflare 測試金鑰的假 token）
//   'fail'：回呼 error-callback
//   'hang'：永遠不回應
// 每次 render 的 { sitekey, action } 記在 window.__FAKE_TS_LOG。小工具的內容只用 textContent。
export const FAKE_TS_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
export const TURNSTILE_URL_GLOB = 'https://challenges.cloudflare.com/turnstile/**';

const SCRIPT = `(() => {
  const widgets = new Map();
  let seq = 0;
  window.__FAKE_TS_LOG = window.__FAKE_TS_LOG || [];
  window.turnstile = {
    render(el, opts) {
      const id = 'fake-ts-' + (++seq);
      window.__FAKE_TS_LOG.push({ sitekey: opts.sitekey, action: opts.action });
      const box = document.createElement('div');
      box.className = 'fake-turnstile';
      box.style.cssText = 'width:300px;height:65px;display:flex;align-items:center;justify-content:center;background:#222;border:1px solid #666;color:#ddd;font-size:14px;';
      box.textContent = '人機驗證（測試用）';
      el.appendChild(box);
      const mode = window.__FAKE_TS_MODE || 'pass';
      const t = setTimeout(() => {
        if (!widgets.has(id)) return;
        if (mode === 'pass') { box.textContent = '驗證成功（測試用）'; opts.callback && opts.callback(${JSON.stringify(FAKE_TS_TOKEN)}); }
        else if (mode === 'fail') { box.textContent = '驗證失敗（測試用）'; opts['error-callback'] && opts['error-callback']('300030'); }
      }, 80);
      widgets.set(id, { box, t });
      return id;
    },
    remove(id) { const w = widgets.get(id); if (w) { clearTimeout(w.t); w.box.remove(); widgets.delete(id); } },
    reset() {},
    getResponse() { return undefined; },
  };
})();`;

/** 在 page（或 context）上掛假 Turnstile；mode 可預設失敗模式。 */
export async function installFakeTurnstile(target, { mode = null } = {}) {
  await target.route(TURNSTILE_URL_GLOB, (route) => route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: SCRIPT }));
  if (mode) await target.addInitScript((m) => { window.__FAKE_TS_MODE = m; }, mode);
}
