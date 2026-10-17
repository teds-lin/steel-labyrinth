// Cloudflare Turnstile 驗證（docs/API.md「鐘塔之夢」）。
// - secret：Worker secret TURNSTILE_SECRET；hostname 白名單：vars TURNSTILE_HOSTNAMES（逗號分隔）。
// - 要求 success: true、hostname 在清單內、action 等於端點的 action；逾時（預設 5 秒）、網路錯誤、格式不明一律失敗（fail closed）。
// - siteverify 呼叫可以注入（deps.fetch）；整合測試由 Miniflare 的 outboundService 攔下。
// - 官方測試金鑰（1x… 一律通過、2x… 一律失敗、3x… 已使用過）只在 vars TURNSTILE_ALLOW_TEST_SECRET=1（本機開發／E2E）時
//   離線模擬、不連外網；正式環境誤設測試金鑰時一律失敗，不會變成「人人通過」。

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare 官方的測試 secret（https://developers.cloudflare.com/turnstile/troubleshooting/testing/）。 */
export const TURNSTILE_TEST_SECRETS = {
  pass: '1x0000000000000000000000000000000AA',
  fail: '2x0000000000000000000000000000000AA',
  spent: '3x0000000000000000000000000000000AA',
};
const TEST_SECRET_SET = new Set(Object.values(TURNSTILE_TEST_SECRETS));

const MAX_TOKEN_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 5000;

const hostnamesOf = (env) => String(env.TURNSTILE_HOSTNAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function timeoutOf(env) {
  const n = Number(env.TURNSTILE_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 && n <= DEFAULT_TIMEOUT_MS ? n : DEFAULT_TIMEOUT_MS;
}

const fail = (reason) => ({ ok: false, reason });

/**
 * 驗證 Turnstile token。回傳 { ok: true } 或 { ok: false, reason }（reason 只給 log 用，不回給玩家）。
 * action：端點的 action（create_player、dream_pass）；ip：cf-connecting-ip（可為 null）。
 */
export async function verifyTurnstile(env, token, action, ip, deps = {}) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return fail('no_token');
  const secret = env.TURNSTILE_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    console.error('turnstile: TURNSTILE_SECRET 未設定');
    return fail('no_secret');
  }
  if (TEST_SECRET_SET.has(secret)) {
    if (env.TURNSTILE_ALLOW_TEST_SECRET !== '1') {
      console.error('turnstile: 正式環境不可使用官方測試金鑰');
      return fail('test_secret_not_allowed');
    }
    // 本機開發／E2E：離線模擬官方測試金鑰（官方的模擬回應不帶真正的 hostname／action，所以不檢查）。
    return secret === TURNSTILE_TEST_SECRETS.pass ? { ok: true } : fail('rejected');
  }

  const form = new URLSearchParams({ secret, response: token });
  if (typeof ip === 'string' && ip.length > 0) form.set('remoteip', ip);
  const doFetch = deps.fetch ?? fetch;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutOf(env)); });
  let body;
  try {
    const res = await Promise.race([
      doFetch(SITEVERIFY_URL, { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
      timeout,
    ]);
    if (res === 'timeout') return fail('timeout');
    if (!res.ok) return fail('http');
    body = await Promise.race([res.json(), timeout]);
    if (body === 'timeout') return fail('timeout');
  } catch {
    return fail('network');
  } finally {
    clearTimeout(timer);
  }
  if (body === null || typeof body !== 'object' || body.success !== true) return fail('rejected');
  if (!hostnamesOf(env).includes(body.hostname)) return fail('hostname');
  if (body.action !== action) return fail('action');
  return { ok: true };
}
