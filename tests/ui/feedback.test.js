// 意見回饋：討論區網址（只定義在 config.js）、提示文字、開新分頁的行為（被瀏覽器擋下時回報失敗）。
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_EXPECTED = 'https://github.com/teds-lin/steel-labyrinth/discussions';

let config;
let fb;
beforeAll(async () => {
  // config.js 會讀 window（瀏覽器環境）；node 裡給一個最小的替身
  globalThis.window ??= { location: { search: '', hostname: 'localhost' }, devicePixelRatio: 1 };
  config = await import('../../web/src/config.js');
  fb = await import('../../web/src/ui/feedback.js');
});

/** 假的 window：記錄 open 的呼叫，回傳指定的結果。 */
function fakeWin(result) {
  const calls = [];
  return {
    calls,
    open(...args) {
      calls.push(args);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe('意見回饋：網址與文字', () => {
  it('討論區網址是 config.js 的 FEEDBACK_URL', () => {
    expect(config.FEEDBACK_URL).toBe(URL_EXPECTED);
  });

  it('網址只寫在 web/src 的一個地方', () => {
    const root = fileURLToPath(new URL('../../web/src/', import.meta.url));
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js') && readFileSync(p, 'utf8').includes('teds-lin/steel-labyrinth/discussions')) hits.push(p);
      }
    };
    walk(root);
    expect(hits.map((p) => p.slice(root.length))).toEqual(['config.js']);
    expect(readFileSync(join(root, 'config.js'), 'utf8').split('teds-lin/steel-labyrinth/discussions').length - 1).toBe(1);
  });

  it('按鈕與提示頁的文字', () => {
    expect(fb.FEEDBACK_LABEL).toBe('意見回饋');
    expect(fb.FEEDBACK_TITLE).toBe('意見回饋');
    expect(fb.FEEDBACK_BODY).toBe('即將在新分頁開啟 GitHub 討論區。你可以在那裡回報問題、提出建議，或分享遊玩心得。（發文需要 GitHub 帳號）');
    expect(fb.FEEDBACK_GO).toBe('前往討論區');
    expect(fb.FEEDBACK_CANCEL).toBe('取消');
  });

  it('複製回報資訊的按鈕與提示文字', () => {
    expect(fb.REPORT_COPY_LABEL).toBe('複製回報資訊');
    expect(fb.REPORT_COPIED).toBe('已複製，請貼到討論區的回報表單裡');
    expect(fb.REPORT_COPY_FAILED).toBe('無法自動複製，請在下方框內全選文字後手動複製');
    expect(fb.REPORT_PRIVACY).toBe('回報資訊會包含你的角色名字與遊戲進度');
  });

  it('遊戲版本號：config.js 的 GAME_VERSION（年.月.日，同一天多版加 .序號）', () => {
    expect(config.GAME_VERSION).toMatch(/^20\d{2}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])(\.\d+)?$/);
  });

  it('新分頁被擋下時的手動前往提示（網址去掉 https://）', () => {
    expect(fb.feedbackBlockedText()).toBe('瀏覽器擋下了新分頁，請手動前往：github.com/teds-lin/steel-labyrinth/discussions');
  });
});

describe('feedbackNoteForDisplay', () => {
  it('空白改成不換行空白、手動前往的網址換到下一行（帳號後再換一次）；去掉這些排版後與原文相同', () => {
    const body = fb.feedbackNoteForDisplay(fb.FEEDBACK_BODY);
    expect(body).not.toContain(' ');
    expect(body).toContain('開啟\u00a0GitHub\u00a0討論區');
    const blocked = fb.feedbackNoteForDisplay(fb.feedbackBlockedText());
    expect(blocked).toBe('瀏覽器擋下了新分頁，請手動前往：\ngithub.com/teds-lin/\nsteel-labyrinth/discussions');
    const plain = (s) => s.replace(/\u00a0/g, ' ').replace(/\n/g, '');
    expect(plain(body)).toBe(fb.FEEDBACK_BODY);
    expect(plain(blocked)).toBe(fb.feedbackBlockedText());
  });
});

describe('openFeedback', () => {
  it('以新分頁開啟討論區，切斷 opener，回傳 true', () => {
    const child = { opener: { fake: true } };
    const w = fakeWin(child);
    expect(fb.openFeedback(w)).toBe(true);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0][0]).toBe(URL_EXPECTED);
    expect(w.calls[0][1]).toBe('_blank');
    expect(child.opener).toBeNull();
  });

  it('瀏覽器擋下（open 回傳 null）時回傳 false', () => {
    const w = fakeWin(null);
    expect(fb.openFeedback(w)).toBe(false);
    expect(w.calls).toHaveLength(1);
  });

  it('open 丟錯或不存在時回傳 false，不往外丟錯', () => {
    expect(fb.openFeedback(fakeWin(new Error('blocked')))).toBe(false);
    expect(fb.openFeedback({})).toBe(false);
    expect(fb.openFeedback(null)).toBe(false);
  });

  it('設定 opener 失敗（例如唯讀）仍算成功開啟', () => {
    const child = {};
    Object.defineProperty(child, 'opener', { get: () => null, set: () => { throw new Error('read only'); } });
    expect(fb.openFeedback(fakeWin(child))).toBe(true);
  });
});
