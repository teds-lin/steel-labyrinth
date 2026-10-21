// 開發者工具 tools/load-report.mjs：從玩家貼上的回報文字取出存檔字串、用 deserialize＋sanitizeLoadedState 驗證，
// 印出可直接貼到瀏覽器 console 的 localStorage.setItem 指令。
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { loadDir, WEB_DATA_DIR } from '../ui/load-fixture.js';
import { serialize, deserialize, sanitizeLoadedState } from '../../web/src/core/save.js';
import { buildReportInfo, REPORT_SAVE_MARKER } from '../../web/src/ui/report-info.js';
import { extractSaveString, checkReport, consoleCommand } from '../../tools/lib/report.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const cli = (args, input) => spawnSync(process.execPath, [join(ROOT, 'tools', 'load-report.mjs'), ...args], { encoding: 'utf8', input });

let data;
let state;
let report;
beforeAll(() => {
  data = loadDir(WEB_DATA_DIR);
  const raw = {
    schema_version: 4, player: { name: '艾琳' }, lineage: null, location: { map: 'dock', x: 0, y: 6, dir: 'right' },
    flags: {}, items: {}, echo: { charges: 2 }, collapse: 5, resonance: {}, chapter: 'chapter2', chapter_done: ['prologue', 'chapter1'],
    playtime_s: 99, party: [{ id: 'hero', hp: null, sp: null }], ammo: 0, pending: null, dream_return: null, promotions: [], ending: null,
  };
  state = sanitizeLoadedState(deserialize(JSON.stringify(raw)), data).state;
  report = buildReportInfo({ state, data, env: { version: '2026.10.21', now: new Date(0), userAgent: '', screen: { width: 1, height: 1 } } });
});

describe('extractSaveString', () => {
  it('取出分隔線之後的存檔字串', () => {
    expect(extractSaveString(report)).toBe(serialize(state));
  });

  it('貼到討論區後常見的變化：前後多了文字、程式碼區塊、引用符號「> 」、Windows 換行', () => {
    const save = serialize(state);
    const fenced = `我在碼頭卡住了\n\n\`\`\`\n${report}\n\`\`\`\n\n謝謝！`;
    expect(extractSaveString(fenced)).toBe(save);
    const quoted = report.split('\n').map((l) => `> ${l}`).join('\r\n');
    expect(extractSaveString(quoted)).toBe(save);
  });

  it('沒有分隔線或後面沒有內容時回 null', () => {
    expect(extractSaveString('隨便一段文字')).toBeNull();
    expect(extractSaveString(`${REPORT_SAVE_MARKER}\n\n`)).toBeNull();
    expect(extractSaveString('')).toBeNull();
    expect(extractSaveString(null)).toBeNull();
  });
});

describe('checkReport', () => {
  it('合法的存檔：ok、帶回 state 與摘要', () => {
    const r = checkReport(report, data);
    expect(r.ok).toBe(true);
    expect(r.saveString).toBe(serialize(state));
    expect(r.state.location).toEqual(state.location);
    expect(r.warnings).toEqual([]);
  });

  it('損壞、版本較新、地圖不存在時回 ok:false 與原因', () => {
    expect(checkReport('沒有存檔', data)).toMatchObject({ ok: false });
    expect(checkReport(`${REPORT_SAVE_MARKER}\n{壞掉`, data)).toMatchObject({ ok: false, reason: expect.stringContaining('JSON') });
    const newer = JSON.stringify({ ...JSON.parse(serialize(state)), schema_version: 99 });
    expect(checkReport(`${REPORT_SAVE_MARKER}\n${newer}`, data)).toMatchObject({ ok: false, reason: expect.stringContaining('較新') });
    const lost = serialize({ ...state, location: { ...state.location, map: 'nowhere' } });
    expect(checkReport(`${REPORT_SAVE_MARKER}\n${lost}`, data).ok).toBe(false);
  });

  it('座標壞掉但能修復：ok 並帶警告', () => {
    const bad = serialize({ ...state, location: { ...state.location, x: 999 } });
    const r = checkReport(`${REPORT_SAVE_MARKER}\n${bad}`, data);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('consoleCommand', () => {
  it('產生可直接執行的 localStorage.setItem（字串正確跳脫）', () => {
    const save = serialize({ ...state, player: { name: `小'明"\\` } });
    const cmd = consoleCommand(save, 2);
    expect(cmd.startsWith("localStorage.setItem('steel-labyrinth:save:2', ")).toBe(true);
    const store = {};
    // eslint-disable-next-line no-new-func
    new Function('localStorage', cmd)({ setItem: (k, v) => { store[k] = v; } });
    expect(store).toEqual({ 'steel-labyrinth:save:2': save });
  });

  it('不合法的槽位丟錯', () => {
    expect(() => consoleCommand('{}', 0)).toThrow();
    expect(() => consoleCommand('{}', 4)).toThrow();
  });
});

describe('tools/load-report.mjs（指令列）', () => {
  it('從標準輸入讀回報，印出摘要與 console 指令（預設存檔 1、?test=1）', () => {
    const r = cli(['-'], report);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('存檔驗證通過');
    expect(r.stdout).toContain('?test=1');
    expect(r.stdout).toContain(consoleCommand(serialize(state), 1));
  });

  it('--slot 指定槽位', () => {
    const r = cli(['-', '--slot', '3'], report);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(consoleCommand(serialize(state), 3));
  });

  it('沒有存檔或驗證失敗時結束碼 1，訊息寫在 stderr', () => {
    const r = cli(['-'], '只有文字');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('找不到存檔內容');
    const bad = cli(['-'], `${REPORT_SAVE_MARKER}\n{壞掉`);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('JSON');
  });

  it('沒有給檔案時印出用法並結束碼 2', () => {
    const r = cli([], '');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('用法');
  });
});
