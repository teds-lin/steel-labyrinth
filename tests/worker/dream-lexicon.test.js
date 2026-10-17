// M4：夢客回覆的簡體字／陸用語檢查（worker/src/lexicon.js）與詞表產生工具（tools/gen-dream-lexicon.mjs）。
// 詞表的唯一來源是 sdg_pipeline 的 lexicon.yaml（只讀）；公開 repo 只放自己編的小型假詞表（fixtures）。
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { compileLexicon, findLexiconHits } from '../../worker/src/lexicon.js';
import { buildDreamLexicon, readLexiconSource, DEFAULT_LEXICON_PATH } from '../../tools/gen-dream-lexicon.mjs';
import { DREAM_FIXTURES, ROOT } from './helpers.js';

const fixture = () => JSON.parse(readFileSync(join(DREAM_FIXTURES, 'lexicon.json'), 'utf8'));
const hits = (text, lex = compileLexicon(fixture())) => findLexiconHits(text, lex).map((h) => h.term);

describe('findLexiconHits（假詞表）', () => {
  it('簡體字（chars）逐字命中，回傳位置', () => {
    const r = findLexiconHits('燈说这樣', compileLexicon(fixture()));
    expect(r).toEqual([{ term: '说', index: 1, kind: 'char' }, { term: '这', index: 2, kind: 'char' }]);
  });
  it('陸用語（words）命中；引號、問句裡照樣命中（AI 回覆不給引號保護）', () => {
    expect(hits('這個軟件很好用')).toEqual(['軟件']);
    expect(hits('「視頻」？那是什麼')).toEqual(['視頻']);
  });
  it('取消規則：前一字在 pre、後一字在 post → 不算', () => {
    expect(hits('電視頻道')).toEqual([]);
    expect(hits('探視頻率')).toEqual([]);
    expect(hits('看視頻吧')).toEqual(['視頻']);
  });
  it('例外詞：詞條自己的 exc 與全域 exceptions 範圍內不算，範圍外照算', () => {
    expect(hits('質量守恆')).toEqual([]);
    expect(hits('質量很好')).toEqual(['質量']);
    expect(hits('宁宁測試例外')).toEqual([]);
    expect(hits('宁靜')).toEqual(['宁']);
  });
  it('台灣正常句子不命中', () => {
    for (const s of ['霧裡的鐘聲又響了，你還記得白燈保全公司嗎？', '我們先坐下來，聽齒輪轉動的聲音。', '這段影片的畫質很好。']) expect(hits(s), s).toEqual([]);
  });
  it('詞表格式錯誤（不是物件、chars 不是單字陣列、words 不是字串陣列）→ 丟錯', () => {
    for (const bad of [null, [], { chars: 'abc', words: [] }, { chars: ['ab'], words: [] }, { chars: [], words: [5] }, { chars: [], words: [''] }]) {
      expect(() => compileLexicon(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('buildDreamLexicon（從 lexicon.yaml 的結構產生偵測用詞表）', () => {
  const lexicon = {
    version: 1,
    char_whitelist: ['胜'],
    entries: [
      { term: '宁', kind: 'char', tier: 'deterministic', orthographic_status: 'simplified_only', fix: '寧', exception_words: ['宁宁測試'] },
      { term: '后', kind: 'char', tier: 'contextual', orthographic_status: 'also_traditional', fix: '後', exception_words: ['皇后'] },
      { term: '跡', kind: 'char', tier: 'advisory', orthographic_status: 'not_simplified', detect: false },
      { term: '这', kind: 'char', tier: 'deterministic', orthographic_status: null, fix: '這' },
      { term: '軟件', kind: 'word', tier: 'deterministic', fix: '軟體' },
      { term: '視頻', kind: 'word', tier: 'contextual', fix: '影片', cancel_pre: ['電'], cancel_post: ['道'], exception_words: ['視頻教學網'] },
      { term: '工藝', kind: 'word', tier: 'advisory', fix: null },
      { term: '信息', kind: 'word', tier: 'advisory', fix: '資訊', cancel_post: ['部'] },
      { term: '項目', kind: 'word', tier: 'deterministic', fix: '專案', detect: false },
      { term: '摩爾', kind: 'word', tier: 'contextual', fix: '莫耳', domain: 'chemistry' },
    ],
  };
  const openSet = ['这', '们', '后', '胜', '跡', '说'];
  const out = buildDreamLexicon({ lexicon, openSet, source: '/x/lexicon.yaml', sourceSha256: 'ab'.repeat(32), generatedAt: '2026-10-17T00:00:00.000Z', openSetSource: 'dragonmapper 0.3.0' });

  it('檔頭：source、source_sha256、generated_at、DO_NOT_EDIT', () => {
    expect(out).toMatchObject({ source: '/x/lexicon.yaml', source_sha256: 'ab'.repeat(32), generated_at: '2026-10-17T00:00:00.000Z', format: 1 });
    expect(out.DO_NOT_EDIT).toMatch(/禁止手改/);
    expect(Object.keys(out).slice(0, 4)).toEqual(['source', 'source_sha256', 'generated_at', 'DO_NOT_EDIT']);
  });
  it('chars：simplified_only＋開放集（dragonmapper）；also_traditional、not_simplified、char_whitelist、detect:false 都不算', () => {
    expect(out.chars).toEqual(['们', '宁', '说', '这'].sort());
  });
  it('words：deterministic／contextual，以及有建議修法的 advisory（信息→資訊）；detect:false、有領域限定、沒有修法的 advisory（工藝）不收', () => {
    expect(out.words).toEqual(['信息', '視頻', '軟件']);
  });
  it('word_rules 保留取消規則與詞條自己的例外；exceptions 是收進 chars 的字的例外詞', () => {
    expect(out.word_rules).toEqual({ 信息: { pre: [], post: ['部'], exc: [] }, 視頻: { pre: ['電'], post: ['道'], exc: ['視頻教學網'] } });
    expect(out.exceptions).toEqual(['宁宁測試']);
  });
  it('產生的詞表可以直接給 Worker 使用', () => {
    const c = compileLexicon(out);
    expect(findLexiconHits('皇后與后羿', c)).toEqual([]);
    expect(findLexiconHits('这是视频', c).map((h) => h.term)).toEqual(['这']);
    expect(findLexiconHits('電視頻道與看視頻', c).map((h) => h.term)).toEqual(['視頻']);
  });
  it('lexicon 結構不符預期 → 丟錯（不默默產生空詞表）', () => {
    expect(() => buildDreamLexicon({ lexicon: { entries: 'x' }, openSet: [], source: 'a', sourceSha256: 'b', generatedAt: 'c' })).toThrow();
    expect(() => buildDreamLexicon({ lexicon, openSet: [], source: 'a', sourceSha256: 'b', generatedAt: 'c' })).toThrow(/開放集/);
  });
});

// 用真正的 lexicon.yaml（只讀）驗證；這台機器沒有 sdg_pipeline 或 Python 套件時略過。
function findPython() {
  for (const py of [process.env.DREAM_LEXICON_PYTHON, 'python3', '/data/.axolotl/bin/python'].filter(Boolean)) {
    const r = spawnSync(py, ['-c', 'import yaml, dragonmapper'], { encoding: 'utf8' });
    if (r.status === 0) return py;
  }
  return null;
}
const PY = existsSync(DEFAULT_LEXICON_PATH) ? findPython() : null;

describe.skipIf(!PY)('真正的 lexicon.yaml（只讀，不修改 sdg_pipeline 任何檔案）', () => {
  let src;
  let lex;
  let compiled;
  const load = () => {
    if (!src) {
      src = readLexiconSource(DEFAULT_LEXICON_PATH, { python: PY });
      lex = buildDreamLexicon({ ...src, generatedAt: new Date().toISOString() });
      compiled = compileLexicon(lex);
    }
  };
  const has = (text) => findLexiconHits(text, compiled).length > 0;

  it('source_sha256 等於檔案內容的 SHA-256；開放集來自 dragonmapper', () => {
    load();
    expect(lex.source_sha256).toBe(createHash('sha256').update(readFileSync(DEFAULT_LEXICON_PATH)).digest('hex'));
    expect(lex.open_set_source).toMatch(/^dragonmapper /);
    expect(lex.chars.length).toBeGreaterThan(2000);
    expect(lex.words.length).toBeGreaterThan(300);
  });
  it('also_traditional 的字（于、后、云、万、冲…）與 not_simplified（跡）不算簡體字', () => {
    load();
    for (const c of ['于', '后', '云', '万', '冲', '愿', '跡', '筑', '里']) expect(lex.chars, c).not.toContain(c);
    for (const c of ['这', '说', '们', '宁', '锠', '厂']) expect(lex.chars, c).toContain(c);
  });
  it('lexicon 附帶的測試句：收進詞表的詞條，positive 命中、negative 不命中（該詞條）', () => {
    load();
    const words = new Set(lex.words);
    const charSet = new Set(lex.chars);
    const bad = [];
    for (const e of src.lexicon.entries) {
      const included = e.kind === 'word' ? words.has(e.term) : charSet.has(e.term);
      if (!included) continue;
      for (const t of e.tests?.positive ?? []) {
        if (/[「」『』]/.test(t)) continue;
        // 詞條的測試句不含詞本身（例：缓冲 的「提列資本緩冲」靠的是 冲 這個 also_traditional 字）：
        // 依 M4 定案 also_traditional 不算簡體字，這類句子不在夢客檢查的範圍。
        if (e.kind === 'word' && !t.includes(e.term)) continue;
        // 命中範圍和詞本身重疊就算抓到（例：「Python 代碼」由較長的詞條「Python 代碼」命中，也算抓到「代碼」）
        const at = t.indexOf(e.term);
        const covered = (h) => at >= 0 && h.index < at + e.term.length && h.index + h.term.length > at;
        if (!findLexiconHits(t, compiled).some((h) => h.term === e.term || covered(h))) bad.push(`漏抓 ${e.term}：${t}`);
      }
      for (const t of e.tests?.negative ?? []) {
        // 靠引號保護才不命中的句子（例：「厂」是康熙字典的部首之一）：AI 回覆不給引號保護，命中是預期行為。
        if (/[「」『』]/.test(t)) continue;
        if (findLexiconHits(t, compiled).some((h) => h.term === e.term)) bad.push(`誤報 ${e.term}：${t}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('台灣正常句子不誤報；明顯簡中句子會命中', () => {
    load();
    const taiwan = [
      '霧裡的鐘聲又響了，你還記得白燈保全公司嗎？',
      '我們先坐下來，聽齒輪轉動的聲音。',
      '這段影片的畫質很好，軟體也更新到最新版了。',
      '碼頭區最近有工人接連失蹤，守燈人正在調查。',
      '皇后的後花園裡有一座古老的鐘塔。',
      '請把資料存到雲端，網路連線恢復後再同步。',
      '懷錶停在三點，指針一動也不動。',
    ];
    for (const s of taiwan) expect(findLexiconHits(s, compiled), s).toEqual([]);
    const mainland = ['这个软件的质量很好', '我们说话吧', '网络？信息？', '網絡？', '……網路？信息？這些詞彙聽起來很刺耳。', '請打開視頻看看', '我的賬戶被鎖了', '這個軟件很難用'];
    for (const s of mainland) expect(has(s), s).toBe(true);
  });
  it('CLI：輸出檔頭欄位齊全；拒絕把詞表寫進公開 repo', () => {
    const out = join(tmpdir(), 'steel-labyrinth-dream-lexicon-test.json');
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'gen-dream-lexicon.mjs'), '--out', out, '--python', PY], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    expect(j).toMatchObject({ source: DEFAULT_LEXICON_PATH, DO_NOT_EDIT: expect.any(String) });
    expect(j.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    const inRepo = spawnSync(process.execPath, [join(ROOT, 'tools', 'gen-dream-lexicon.mjs'), '--out', join(ROOT, 'web', 'data', 'lexicon.json'), '--python', PY], { encoding: 'utf8' });
    expect(inRepo.status).not.toBe(0);
    expect(inRepo.stderr).toMatch(/公開 repo/);
    expect(existsSync(join(ROOT, 'web', 'data', 'lexicon.json'))).toBe(false);
  });
});
