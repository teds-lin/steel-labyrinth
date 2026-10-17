// Turnstile 小工具：載入官方腳本（explicit render）並在指定的 DOM 容器裡取得 token。
// 純邏輯＋可注入的 window／document（vitest 用假物件）；畫面層在 ui/turnstile-panel.js。
import { TURNSTILE_SCRIPT_URL } from './turnstile-config.js';

export const TURNSTILE_MSG = Object.freeze({
  failed: '人機驗證失敗，請再試一次',
  loadFailed: '無法載入人機驗證，請檢查網路後再試一次',
  expired: '人機驗證已逾時，請再試一次',
  noSitekey: '人機驗證尚未設定，暫時無法使用',
});

/** 腳本載入器：只載入一次；失敗後下次呼叫會重新載入。window.turnstile 已存在時直接使用。 */
export function createTurnstileLoader({ win = globalThis.window, doc = globalThis.document, src = TURNSTILE_SCRIPT_URL, timeoutMs = 15000 } = {}) {
  let pending = null;
  return {
    load() {
      if (win?.turnstile) return Promise.resolve(win.turnstile);
      if (pending) return pending;
      pending = new Promise((resolve, reject) => {
        let timer = null;
        const done = (fn, v) => { clearTimeout(timer); fn(v); };
        try {
          const el = doc.createElement('script');
          el.src = src;
          el.async = true;
          el.defer = true;
          el.onload = () => (win?.turnstile ? done(resolve, win.turnstile) : done(reject, new Error('Turnstile 腳本載入後沒有 window.turnstile')));
          el.onerror = () => done(reject, new Error('Turnstile 腳本載入失敗'));
          timer = setTimeout(() => done(reject, new Error('Turnstile 腳本載入逾時')), timeoutMs);
          doc.head.appendChild(el);
        } catch (e) {
          done(reject, e);
        }
      }).catch((e) => { pending = null; throw e; });
      return pending;
    },
  };
}

/**
 * 在 container 裡顯示小工具，取得 token。回傳 { promise, cancel }；promise 一定 resolve：
 * { ok:true, token } 或 { ok:false, kind:'failed'|'expired'|'load_failed'|'no_sitekey'|'cancelled', message }。
 */
export function runTurnstile({ loader, container, sitekey, action }) {
  let settle;
  let widget = null;
  let api = null;
  let finished = false;
  const promise = new Promise((r) => { settle = r; });
  const remove = () => {
    try { if (api && widget !== null) api.remove(widget); } catch { /* 小工具已不存在 */ }
    widget = null;
  };
  const finish = (v) => {
    if (finished) return;
    finished = true;
    if (!v.ok) remove();
    settle(v);
  };
  if (typeof sitekey !== 'string' || sitekey === '') {
    finish({ ok: false, kind: 'no_sitekey', message: TURNSTILE_MSG.noSitekey });
    return { promise, cancel: () => {} };
  }
  loader.load().then((ts) => {
    if (finished) return;
    api = ts;
    try {
      widget = ts.render(container, {
        sitekey,
        action,
        theme: 'dark',
        language: 'zh-tw',
        retry: 'never',
        'refresh-expired': 'manual',
        callback: (token) => finish(typeof token === 'string' && token !== '' ? { ok: true, token } : { ok: false, kind: 'failed', message: TURNSTILE_MSG.failed }),
        'error-callback': () => { finish({ ok: false, kind: 'failed', message: TURNSTILE_MSG.failed }); return true; },
        'expired-callback': () => finish({ ok: false, kind: 'expired', message: TURNSTILE_MSG.expired }),
        'timeout-callback': () => finish({ ok: false, kind: 'expired', message: TURNSTILE_MSG.expired }),
      });
    } catch {
      finish({ ok: false, kind: 'failed', message: TURNSTILE_MSG.failed });
    }
  }, () => finish({ ok: false, kind: 'load_failed', message: TURNSTILE_MSG.loadFailed }));
  return {
    promise,
    cancel() {
      remove();
      finish({ ok: false, kind: 'cancelled', message: null });
    },
    /** 成功後移除小工具（token 已取得）。 */
    dispose: remove,
  };
}
