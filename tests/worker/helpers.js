// Worker 整合測試共用工具：用 Miniflare 的 Node API 啟動 Worker＋本機（記憶體）D1，並套用 migration。
// 每個測試檔建立自己的實例（beforeAll／afterAll），彼此的資料庫互不影響。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_readConfig, unstable_splitSqlQuery } from 'wrangler';
import { serialize } from '../../web/src/core/save.js';
import { generateToken, generateTransferCode } from '../../worker/src/codes.js';

// Miniflare 啟動與 D1 往返比純函式測試慢，放寬這些測試檔的逾時。
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WORKER_DIR = join(ROOT, 'worker');
export const CONFIG_PATH = join(WORKER_DIR, 'wrangler.toml');
export const TEST_PEPPER = 'test-pepper-不要用在正式環境';
/** 測試用的 Worker secrets（正式環境用 `wrangler secret put` 設定）。 */
export const TEST_TURNSTILE_SECRET = 'test-turnstile-secret-不要用在正式環境';
export const TEST_DREAM_PASS_SECRET = 'test-dream-pass-secret-0123456789abcdef-不要用在正式環境';
/** 正式 TURNSTILE_HOSTNAMES 內的 hostname（假 siteverify 預設回傳它）。 */
export const TURNSTILE_OK_HOST = 'teds-lin.github.io';
/**
 * 假 siteverify 的 Turnstile token 寫法（Worker 對 challenges.cloudflare.com 的呼叫由 outboundService 攔下）：
 * - `ts:<action>`：成功，hostname＝TURNSTILE_OK_HOST、action＝<action>
 * - `host:<hostname>:<action>`：成功但 hostname 是指定值
 * - `fail`：success false；`slow`：不回應（測逾時）；`500`：siteverify 回 500
 */
export const tsToken = (action) => `ts:${action}`;
export const BASE = 'https://worker.test';

/** 用 wrangler 自己的解析器讀 wrangler.toml（確保測試用的設定就是部署用的設定）。 */
export function readWranglerConfig() {
  return unstable_readConfig({ config: CONFIG_PATH }, { hideWarnings: true });
}

/**
 * Worker 的 ES 模組清單：從入口沿著相對 import 走訪（含 ../../web/src/core/save.js 與它的相依），
 * 入口放第一個。和 wrangler（esbuild）打包時解析的是同一組檔案。
 */
export function workerModules(entry) {
  const seen = new Set();
  const order = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    order.push(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g)) {
      visit(resolve(dirname(file), m[1]));
    }
  };
  visit(resolve(entry));
  return order.map((path) => ({ type: 'ESModule', path }));
}

/**
 * 本機開發用的 vars 覆寫：直接從 package.json 的 worker:dev 指令解析 `--var KEY:VALUE`
 * （確保測試用的本機來源就是開發時用的來源；正式的 wrangler.toml 只允許 GitHub Pages）。
 */
export function devVarOverrides() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const cmd = pkg.scripts['worker:dev'];
  const after = cmd.slice(cmd.indexOf('--var') + '--var'.length);
  const out = {};
  for (const tok of after.trim().split(/\s+/)) {
    if (tok.startsWith('--') || tok === '&&') break;
    const i = tok.indexOf(':');
    out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

/** 依檔名順序回傳 migrations/*.sql 的所有 SQL 敘述。 */
export function migrationStatements() {
  const dir = join(WORKER_DIR, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return files.flatMap((f) => unstable_splitSqlQuery(readFileSync(join(dir, f), 'utf8')));
}

/**
 * 啟動 Worker。varsOverride 可以覆寫 [vars]（例如把限流值調小）；bindingsOverride 可以拿掉 pepper 等。
 * 回傳 { mf, db, fetch, close }。
 */
/** 假的 siteverify：解析 secret／response／remoteip，依 token 寫法回應（見 tsToken）。calls 記錄每次呼叫。 */
function fakeSiteverify(calls) {
  return async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'challenges.cloudflare.com') return new Response('外部網路在測試中停用', { status: 599 });
    const form = new URLSearchParams(await request.text());
    const call = { url: url.toString(), method: request.method, secret: form.get('secret'), response: form.get('response'), remoteip: form.get('remoteip') };
    calls.push(call);
    const t = call.response ?? '';
    if (call.secret !== TEST_TURNSTILE_SECRET) return Response.json({ success: false, 'error-codes': ['invalid-input-secret'] });
    if (t === 'slow') return new Promise(() => {});
    if (t === '500') return new Response('oops', { status: 500 });
    let m = /^ts:(.*)$/.exec(t);
    if (m) return Response.json({ success: true, hostname: TURNSTILE_OK_HOST, action: m[1], 'error-codes': [] });
    m = /^host:([^:]*):(.*)$/.exec(t);
    if (m) return Response.json({ success: true, hostname: m[1], action: m[2], 'error-codes': [] });
    return Response.json({ success: false, 'error-codes': ['invalid-input-response'] });
  };
}

/**
 * 假的 Workers AI（env.AI）：另一個 Worker 以 RPC 提供 run(model, input, options)，實際的回應交給 Node 端的 handler，
 * 測試可以用 w.setAi(fn) 換掉（fn({ model, input, options }) 回傳 { response, usage } 或丟錯）。w.aiCalls 記錄每次呼叫。
 */
const FAKE_AI_SCRIPT = `
import { WorkerEntrypoint } from 'cloudflare:workers';
export class FakeAi extends WorkerEntrypoint {
  async run(model, input, options) {
    const r = await this.env.CONTROL.fetch('http://control/', { method: 'POST', body: JSON.stringify({ model, input, options: options ?? null }) });
    if (r.status !== 200) throw new Error('AI 錯誤 ' + r.status);
    return r.json();
  }
}
export default { fetch() { return new Response('fake-ai'); } };`;

/**
 * Workers AI 的 OpenAI 相容回應格式（gemma-4／qwen3 等；M4 模型評測）：choices[0].message.content，
 * 思考內容在 message.reasoning（Worker 一律不採用）。
 */
export const aiReply = (content, { finish_reason = 'stop', reasoning = null, usage = { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 } } = {}) => ({
  choices: [{ index: 0, message: { role: 'assistant', content, reasoning }, finish_reason }], usage,
});

/** 預設的假 AI 回覆：台灣繁體、不提設定。 */
export const DEFAULT_AI_REPLY = '鐘聲又慢了半拍。你今天看起來很累，坐下來聽我說一會兒吧。';

export async function startWorker({ varsOverride = {}, bindingsOverride, config = CONFIG_PATH, noAi = false } = {}) {
  const cfg = unstable_readConfig({ config }, { hideWarnings: true });
  const d1 = cfg.d1_databases.find((d) => d.binding === 'DB');
  const { TRANSFER_PEPPER: _devPepper, ...devVars } = devVarOverrides();
  // D1_METRICS=1：回應加上 x-d1-rows 標頭（本次請求的 D1 讀寫列數），只在測試開啟。
  const bindings = bindingsOverride ?? {
    ...cfg.vars, ...devVars, D1_METRICS: '1', TURNSTILE_SECRET: TEST_TURNSTILE_SECRET, DREAM_PASS_SECRET: TEST_DREAM_PASS_SECRET,
    ...varsOverride, TRANSFER_PEPPER: TEST_PEPPER,
  };
  const siteverifyCalls = [];
  const aiCalls = [];
  let aiHandler = () => aiReply(DEFAULT_AI_REPLY);
  let aiCount = 0; // setAi 之後第幾次呼叫（從 1 起算）
  const control = async (request) => {
    const call = await request.json();
    aiCalls.push(call);
    try {
      return Response.json(await aiHandler(call, ++aiCount));
    } catch (e) {
      return new Response(String(e?.message ?? e), { status: 500 });
    }
  };
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: cfg.name,
      modulesRoot: ROOT,
      modules: workerModules(cfg.main),
      compatibilityDate: cfg.compatibility_date,
      compatibilityFlags: cfg.compatibility_flags,
      d1Databases: { DB: d1.database_id },
      bindings,
      serviceBindings: noAi ? {} : { AI: { name: 'fake-ai', entrypoint: 'FakeAi' } },
      outboundService: fakeSiteverify(siteverifyCalls),
    }, {
      name: 'fake-ai',
      modules: true,
      script: FAKE_AI_SCRIPT,
      compatibilityDate: cfg.compatibility_date,
      serviceBindings: { CONTROL: control },
    }],
  }));
  await mf.ready;
  const db = await mf.getD1Database('DB');
  // D1 預設強制外鍵；和正式環境一致。
  await db.batch(migrationStatements().map((s) => db.prepare(s)));
  let ipSeq = 0;
  const fetch = (path, init = {}) => mf.dispatchFetch(`${BASE}${path}`, init);
  return {
    mf,
    db,
    fetch,
    /** 每次呼叫給一個不同的假 IP，避免測試之間互相吃掉 IP 限流額度。 */
    nextIp: () => `10.${Math.floor(++ipSeq / 65536) % 256}.${Math.floor(ipSeq / 256) % 256}.${ipSeq % 256}`,
    close: () => mf.dispose(),
    siteverifyCalls,
    aiCalls,
    /** 換掉假 AI 的回應：fn(call, 換掉之後第幾次呼叫〔1 起算〕) → aiReply(...)，丟錯＝AI 失敗。 */
    setAi: (fn) => { aiHandler = fn; aiCount = 0; },
    /** 觸發 Cron（scheduled handler）。scheduledTime：毫秒。 */
    scheduled: async (scheduledTime = Date.now()) => (await mf.getWorker()).scheduled({ cron: '17 3 * * *', scheduledTime: new Date(scheduledTime) }),
  };
}

/** 解析 x-d1-rows 標頭：{ read, written }（沒有任何 D1 查詢時兩者為 0）。 */
export function d1Rows(res) {
  const h = res.headers.get('x-d1-rows');
  if (h === null) throw new Error('回應沒有 x-d1-rows 標頭（D1_METRICS 未開啟？）');
  const m = /^read=(\d+); written=(\d+)$/.exec(h);
  if (!m) throw new Error(`x-d1-rows 格式不對：${h}`);
  return { read: Number(m[1]), written: Number(m[2]) };
}

/** 客戶端產生的一組秘密（API 修訂 2 A）。 */
export const newSecrets = () => ({ token: generateToken(), transfer_code: generateTransferCode(), turnstile_token: tsToken('create_player') });

/** 一份能通過 deserialize 的最小存檔 state。 */
export function sampleState(overrides = {}) {
  return {
    player: { name: '雷恩' },
    lineage: null,
    location: { map: 'prologue_hall', x: 2, y: 3, dir: 'down' },
    flags: {},
    items: {},
    echo: { charges: 3 },
    collapse: 10,
    resonance: {},
    chapter: 'chapter1',
    chapter_done: [],
    playtime_s: 120,
    party: [{ id: 'hero', hp: 20, sp: 5 }],
    ammo: 0,
    pending: null,
    ...overrides,
  };
}
export const sampleSave = (overrides) => serialize(sampleState(overrides));

export const json = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
export const auth = (token, headers = {}) => ({ authorization: `Bearer ${token}`, ...headers });

/** 建立一個玩家（每次用不同 IP；秘密由「客戶端」產生）。回傳 { player_id, token, transfer_code }。 */
export async function newPlayer(w, headers = {}) {
  const secrets = newSecrets();
  const res = await w.fetch('/api/player', json(secrets, { 'cf-connecting-ip': w.nextIp(), ...headers }));
  if (res.status !== 201) throw new Error(`建立玩家失敗：${res.status} ${await res.text()}`);
  const { player_id } = await res.json();
  return { player_id, ...secrets };
}

/** 用轉移碼接續（新權杖與新轉移碼由客戶端產生）。回傳 { res, token, transfer_code }。 */
export async function doTransfer(w, code, { ip = w.nextIp(), secrets = newSecrets(), headers = {} } = {}) {
  const res = await w.fetch('/api/transfer', json({ code, new_token: secrets.token, new_transfer_code: secrets.transfer_code }, { 'cf-connecting-ip': ip, ...headers }));
  return { res, token: secrets.token, transfer_code: secrets.transfer_code };
}

/** 重新產生轉移碼（新碼由客戶端產生）。 */
export function doRotate(w, token, code = generateTransferCode()) {
  return w.fetch('/api/transfer/rotate', json({ new_transfer_code: code }, auth(token)));
}

/** PUT 一份存檔。cond：{ match: 版本 } 或 { create: true }。 */
export function putSave(w, token, slot, data, cond = { create: true }) {
  const headers = auth(token, { 'content-type': 'application/json' });
  if (cond.create) headers['if-none-match'] = '*';
  if (cond.match !== undefined) headers['if-match'] = `"${cond.match}"`;
  return w.fetch(`/api/save/${slot}`, { method: 'PUT', headers, body: JSON.stringify({ data }) });
}

/** 錯誤回應的共同檢查：狀態碼、error 代碼、message 是非空字串、不含堆疊或 SQL 字樣。 */
export async function expectError(res, status, code) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`錯誤回應不是 JSON：${res.status} ${text}`); }
  if (res.status !== status || body.error !== code) {
    throw new Error(`預期 ${status} ${code}，實際 ${res.status} ${text}`);
  }
  if (typeof body.message !== 'string' || body.message.length === 0) throw new Error(`缺少 message：${text}`);
  if (/at .*\.js|SQLITE|D1_|stack|TypeError|SELECT|INSERT/i.test(text)) throw new Error(`錯誤回應洩漏內部細節：${text}`);
  if (!(res.headers.get('content-type') ?? '').startsWith('application/json')) throw new Error('錯誤回應 content-type 不是 JSON');
  return body;
}

// ---------- M4：夢客 ----------
export const DREAM_FIXTURES = join(ROOT, 'tests', 'worker', 'fixtures', 'dream');

/** 用上傳工具（tools/upload-dream.mjs）把測試用的假人設、假詞表、假拒絕清單、假預寫台詞寫進 D1。 */
export async function loadDreamFixtures(w, opts = {}) {
  const { buildDreamSql } = await import('../../tools/upload-dream.mjs');
  const { sql } = buildDreamSql({
    personasDir: join(DREAM_FIXTURES, 'personas'),
    lexiconPath: join(DREAM_FIXTURES, 'lexicon.json'),
    blocklistPath: join(DREAM_FIXTURES, 'blocklist.json'),
    storyDir: join(DREAM_FIXTURES, 'story'),
    ...opts,
  });
  await w.db.batch(unstable_splitSqlQuery(sql).map((s) => w.db.prepare(s)));
  return sql;
}

/** 取得夢境通行證。 */
export async function getPass(w, token) {
  const res = await w.fetch('/api/dream/pass', json({ turnstile_token: tsToken('dream_pass') }, auth(token)));
  if (res.status !== 200) throw new Error(`取得通行證失敗：${res.status} ${await res.text()}`);
  return (await res.json()).pass;
}

/** 送一句話給夢客。 */
export function dreamChat(w, token, body) {
  return w.fetch('/api/dream/chat', json(body, auth(token)));
}
