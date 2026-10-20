// M4：tools/upload-dream.mjs——把私有 repo 的人設與詞表、公開 story 的預寫台詞轉成 SQL（dream_personas、dream_lexicon）。
// 測試只用 tests/worker/fixtures/dream/ 的假資料；不執行 wrangler。
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildDreamSql, readPersonas, validatePersona, readScripted, readScriptedByChapter, readLexicon, readBlocklist } from '../../tools/upload-dream.mjs';
import { startWorker, loadDreamFixtures, DREAM_FIXTURES, ROOT } from './helpers.js';

const PERSONAS = join(DREAM_FIXTURES, 'personas');
const STORY = join(DREAM_FIXTURES, 'story');
const LEXICON = join(DREAM_FIXTURES, 'lexicon.json');
const BLOCKLIST = join(DREAM_FIXTURES, 'blocklist.json');
const persona = () => JSON.parse(readFileSync(join(PERSONAS, 'lamp.json'), 'utf8'));
const build = (over = {}) => buildDreamSql({ personasDir: PERSONAS, lexiconPath: LEXICON, blocklistPath: BLOCKLIST, storyDir: STORY, now: 1_760_000_000, ...over });

/** 每次測試用同一個固定的暫存資料夾（覆寫，不累積檔案）。 */
function scratchDir(name) {
  const d = join(tmpdir(), 'steel-labyrinth-upload-dream-test', name);
  mkdirSync(d, { recursive: true });
  return d;
}

describe('只讀 dream/personas/*.json（同資料夾的內部筆記絕不可讀入）', () => {
  it('README-internal.md、notes.txt 等非 .json 檔不會出現在 SQL 裡', () => {
    const { sql, guests } = build();
    expect(guests).toEqual(['lamp']);
    expect(sql).not.toContain('INTERNAL_TRUTH_MARK');
    expect(sql).not.toContain('README-internal');
    expect(readPersonas(PERSONAS).map((p) => p.file)).toEqual(['lamp.json']);
  });
  it('不跟隨子資料夾、不讀 .json 以外的副檔名（大小寫也一樣，例如 .JSON.md）', () => {
    const d = scratchDir('ext');
    writeFileSync(join(d, 'lamp.json'), JSON.stringify(persona()));
    writeFileSync(join(d, 'secret.json.md'), '{"id":"secret"} INTERNAL_TRUTH_MARK');
    writeFileSync(join(d, 'README-internal.md'), 'INTERNAL_TRUTH_MARK');
    mkdirSync(join(d, 'sub.json'), { recursive: true });
    expect(readPersonas(d).map((p) => p.file)).toEqual(['lamp.json']);
    expect(build({ personasDir: d }).sql).not.toContain('INTERNAL_TRUTH_MARK');
  });
});

describe('人設驗證：缺欄位或型別錯誤就報錯', () => {
  it('完整的假人設通過', () => expect(() => validatePersona(persona(), 'lamp.json')).not.toThrow());
  it.each(['id', 'name', 'persona', 'speech_examples', 'knowledge', 'deflect_topics', 'leak_markers', 'boundaries'])('缺 %s → 錯誤訊息指出欄位與檔名', (field) => {
    const p = persona();
    delete p[field];
    expect(() => validatePersona(p, 'lamp.json')).toThrow(new RegExp(`lamp\\.json.*${field}`));
  });
  it('型別錯誤、空字串、空陣列、knowledge 的章節鍵格式錯、id 與檔名不同、未知欄位 → 錯誤', () => {
    const cases = [
      (p) => { p.name = ''; }, (p) => { p.speech_examples = []; }, (p) => { p.speech_examples = ['a', 5]; },
      (p) => { p.knowledge = []; }, (p) => { p.knowledge = { Chapter1: ['x'] }; }, (p) => { p.knowledge = { chapter1: 'x' }; },
      (p) => { p.deflect_topics = 'x'; }, (p) => { p.leak_markers = []; }, (p) => { p.boundaries = 5; },
      (p) => { p.id = 'other'; }, (p) => { p.id = 'Lamp'; }, (p) => { p.secret_answer = '劇透'; },
    ];
    for (const mut of cases) {
      const p = persona();
      mut(p);
      expect(() => validatePersona(p, 'lamp.json'), mut.toString()).toThrow(/lamp\.json/);
    }
  });
  it('人設任何欄位含主角的預設名字（雷恩、葛雷）→ 錯誤（提示詞不得帶玩家真名，鐘塔裡一律叫「十二點」）', () => {
    for (const mut of [(p) => { p.speech_examples.push('雷恩，你來了。'); }, (p) => { p.knowledge.chapter1.push('葛雷先生在碼頭。'); }, (p) => { p.persona += '稱呼主角雷恩'; }]) {
      const p = persona();
      mut(p);
      expect(() => validatePersona(p, 'lamp.json'), mut.toString()).toThrow(/十二點/);
    }
  });
  it('JSON 壞掉 → 錯誤指出檔名', () => {
    const d = scratchDir('broken');
    writeFileSync(join(d, 'lamp.json'), '{ broken');
    expect(() => readPersonas(d)).toThrow(/lamp\.json/);
  });
  it('人設資料夾沒有任何 .json → 錯誤（避免上傳空的夢客清單）', () => {
    const d = scratchDir('empty');
    writeFileSync(join(d, 'README-internal.md'), 'x');
    expect(() => build({ personasDir: d })).toThrow(/沒有/);
  });
});

describe('預寫台詞從公開的 story 讀取並合併', () => {
  it('readScripted：guests[].scripted 依夢客 id 收集', () => {
    const m = readScripted(STORY);
    expect(m.get('lamp').filtered).toEqual(['SCRIPTED_FILTERED 我好像說錯話了，當我沒說。']);
  });
  it('人設沒有對應的預寫台詞、或缺 greeting／fallback／quota／filtered → 錯誤', () => {
    const d = scratchDir('story');
    writeFileSync(join(d, 'x.json'), JSON.stringify({ id: 'x', guests: [] }));
    expect(() => build({ storyDir: d })).toThrow(/lamp.*預寫台詞/);
    const story = JSON.parse(readFileSync(join(STORY, 'fake_chapter.json'), 'utf8'));
    delete story.guests[0].scripted.quota;
    writeFileSync(join(d, 'x.json'), JSON.stringify(story));
    expect(() => build({ storyDir: d })).toThrow(/quota/);
  });
  it('真正的 web/data/story 能讀（目前可能還沒有夢客）', () => {
    expect(() => readScripted(join(ROOT, 'web', 'data', 'story'))).not.toThrow();
  });
  it('M5：每章各有一份 guests（故事聖經 0.7）→ 同一夢客取章節順序最早的一份（不把後面章節的台詞送上雲端）', () => {
    const d = scratchDir('story-multi');
    const base = JSON.parse(readFileSync(join(STORY, 'fake_chapter.json'), 'utf8'));
    const later = structuredClone(base);
    later.id = 'chapter10';
    later.guests[0].scripted.greeting = ['LATER 後面章節的招呼'];
    const early = structuredClone(base);
    early.id = 'chapter9';
    early.guests[0].scripted.greeting = ['EARLY 前面章節的招呼'];
    // 檔名排序（chapter10 < chapter9）和章節順序相反：必須依章節順序
    writeFileSync(join(d, 'chapter10.json'), JSON.stringify(later));
    writeFileSync(join(d, 'chapter9.json'), JSON.stringify(early));
    expect(readScripted(d, { chapters: ['chapter9', 'chapter10'] }).get('lamp').greeting).toEqual(['EARLY 前面章節的招呼']);
    // 同一章檔案裡重複定義仍是錯誤
    const dup = structuredClone(early);
    dup.guests.push(structuredClone(dup.guests[0]));
    writeFileSync(join(d, 'chapter9.json'), JSON.stringify(dup));
    expect(() => readScripted(d, { chapters: ['chapter9', 'chapter10'] })).toThrow(/重複/);
  });
  it('M5：web/data 的三點、九點取第三章的預寫台詞（manifest.chapters 順序）', () => {
    const m = readScripted(join(ROOT, 'web', 'data', 'story'));
    const ch3 = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'story', 'chapter3.json'), 'utf8'));
    for (const g of ch3.guests) expect(m.get(g.id)).toEqual(g.scripted);
  });
});

describe('M5：每章各自的預寫台詞（scripted_by_chapter）', () => {
  /** 兩章各自定義 lamp 的預寫台詞（第二章、第三章），fallback 不同。 */
  function twoChapters() {
    const d = scratchDir('story-by-chapter');
    const base = JSON.parse(readFileSync(join(STORY, 'fake_chapter.json'), 'utf8'));
    for (const ch of ['chapter2', 'chapter3']) {
      const s = structuredClone(base);
      s.id = ch;
      s.guests[0].scripted.fallback = [`FALLBACK_${ch}`];
      writeFileSync(join(d, `${ch}.json`), JSON.stringify(s));
    }
    return d;
  }
  it('readScriptedByChapter：夢客 → { 章節: 預寫台詞 }，依章節順序', () => {
    const m = readScriptedByChapter(twoChapters(), { chapters: ['prologue', 'chapter2', 'chapter3'] });
    expect(Object.keys(m.get('lamp'))).toEqual(['chapter2', 'chapter3']);
    expect(m.get('lamp').chapter3.fallback).toEqual(['FALLBACK_chapter3']);
  });
  it('buildDreamSql：人設資料帶 scripted（最早一章）與 scripted_by_chapter（每章一份），每章都檢查必填台詞', () => {
    const d = twoChapters();
    const { sql } = build({ storyDir: d, chapters: ['chapter2', 'chapter3'] });
    const row = /INSERT INTO dream_personas \(id, data, updated_at\) VALUES \('lamp', '(.*?)', \d+\)/s.exec(sql);
    const data = JSON.parse(row[1].replace(/''/g, "'"));
    expect(data.scripted.fallback).toEqual(['FALLBACK_chapter2']);
    expect(Object.keys(data.scripted_by_chapter)).toEqual(['chapter2', 'chapter3']);
    expect(data.scripted_by_chapter.chapter3.fallback).toEqual(['FALLBACK_chapter3']);
    // 其中一章缺必填台詞 → 錯誤（指出章節）
    const bad = JSON.parse(readFileSync(join(d, 'chapter3.json'), 'utf8'));
    delete bad.guests[0].scripted.quota;
    writeFileSync(join(d, 'chapter3.json'), JSON.stringify(bad));
    expect(() => build({ storyDir: d, chapters: ['chapter2', 'chapter3'] })).toThrow(/chapter3.*quota|quota.*chapter3/);
  });
  it('正式的 web/data/story（第三～七章都有 guests）可以整包上傳：三點、九點各帶 chapter3～chapter7 的台詞', () => {
    const d = scratchDir('personas-real-guests');
    for (const id of ['three', 'nine']) writeFileSync(join(d, `${id}.json`), JSON.stringify({ ...persona(), id, name: id }));
    const { sql, guests } = build({ personasDir: d, storyDir: join(ROOT, 'web', 'data', 'story') });
    expect(guests.sort()).toEqual(['nine', 'three']);
    for (const id of ['three', 'nine']) {
      const row = new RegExp(`VALUES \\('${id}', '(.*?)', \\d+\\)`, 's').exec(sql);
      const data = JSON.parse(row[1].replace(/''/g, "'"));
      expect(Object.keys(data.scripted_by_chapter)).toEqual(['chapter3', 'chapter4', 'chapter5', 'chapter6', 'chapter7']);
    }
  });
});

describe('詞表檔驗證', () => {
  it('readLexicon：要有 DO_NOT_EDIT、source_sha256、chars、words', () => {
    expect(readLexicon(LEXICON).chars).toContain('这');
    const d = scratchDir('lex');
    const bad = { ...JSON.parse(readFileSync(LEXICON, 'utf8')) };
    delete bad.DO_NOT_EDIT;
    writeFileSync(join(d, 'lexicon.json'), JSON.stringify(bad));
    expect(() => readLexicon(join(d, 'lexicon.json'))).toThrow(/DO_NOT_EDIT/);
    writeFileSync(join(d, 'lexicon.json'), JSON.stringify({ ...bad, DO_NOT_EDIT: 'x', chars: 'abc' }));
    expect(() => readLexicon(join(d, 'lexicon.json'))).toThrow(/chars/);
  });
});

describe('產生的 SQL', () => {
  it('寫入 D1 後可讀回：人設（含合併的預寫台詞）與詞表；重複上傳會取代、舊夢客會刪除', async () => {
    const w = await startWorker();
    try {
      await w.db.prepare("INSERT INTO dream_personas (id, data, updated_at) VALUES ('stale', '{}', 1)").run();
      await loadDreamFixtures(w);
      await loadDreamFixtures(w);
      const { results } = await w.db.prepare('SELECT id, data, updated_at FROM dream_personas').all();
      expect(results.map((r) => r.id)).toEqual(['lamp']);
      const data = JSON.parse(results[0].data);
      expect(data).toMatchObject({ name: '提燈', scripted: { quota: ['SCRIPTED_QUOTA 夢境變得模糊了，今天先聊到這裡吧。'] } });
      expect(data.knowledge.chapter9).toBeDefined(); // 伺服器端依 CHAPTERS 篩選，上傳時保留
      const lex = await w.db.prepare('SELECT id, data, source_sha256 FROM dream_lexicon').all();
      expect(lex.results).toHaveLength(1);
      expect(JSON.parse(lex.results[0].data).words).toEqual(['軟件', '視頻', '質量']);
    } finally {
      await w.close();
    }
  });
  it('單引號正確跳脫（SQL 注入不可能）', async () => {
    const d = scratchDir('quote');
    const p = persona();
    p.persona = "它說：'); DROP TABLE players; --";
    writeFileSync(join(d, 'lamp.json'), JSON.stringify(p));
    const w = await startWorker();
    try {
      await loadDreamFixtures(w, { personasDir: d });
      const row = await w.db.prepare("SELECT data FROM dream_personas WHERE id = 'lamp'").first();
      expect(JSON.parse(row.data).persona).toBe(p.persona);
      expect((await w.db.prepare('SELECT COUNT(*) AS n FROM players').first()).n).toBeGreaterThanOrEqual(0);
    } finally {
      await w.close();
    }
  });
  it('每條敘述不超過 D1 的單一敘述上限（100 KB）；超過就報錯', () => {
    expect(() => build()).not.toThrow();
    const d = scratchDir('huge');
    const p = persona();
    p.knowledge.chapter1 = Array.from({ length: 2000 }, (_, i) => `很長的知識卡第 ${i} 條，${'霧'.repeat(30)}`);
    writeFileSync(join(d, 'lamp.json'), JSON.stringify(p));
    expect(() => build({ personasDir: d })).toThrow(/100 KB/);
  });
});

describe('CLI', () => {
  const cli = (args) => spawnSync(process.execPath, [join(ROOT, 'tools', 'upload-dream.mjs'), ...args], { encoding: 'utf8' });
  const base = ['--personas', PERSONAS, '--lexicon', LEXICON, '--story', STORY];

  it('--out 寫出 SQL；--apply-remote 只印出指令、不執行', () => {
    const out = join(scratchDir('cli'), 'dream.sql');
    const r = cli([...base, '--out', out, '--apply-remote']);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('INSERT INTO dream_personas');
    expect(r.stdout).toContain(`wrangler d1 execute steel-labyrinth --remote --config worker/wrangler.toml --file ${out}`);
    expect(r.stdout).toMatch(/不會自動執行|請自行執行/);
  });
  it('拒絕把 SQL 寫進公開 repo（裡面有人設與詞表）；缺 --out → 錯誤', () => {
    const inRepo = join(ROOT, 'worker', 'dream.sql');
    const r = cli([...base, '--out', inRepo]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/公開 repo/);
    expect(existsSync(inRepo)).toBe(false);
    expect(cli(base).status).not.toBe(0);
  });
  it('人設有錯 → 結束碼非 0，訊息指出檔名與欄位，不寫出 SQL', () => {
    const d = scratchDir('cli-bad');
    const p = persona();
    delete p.boundaries;
    writeFileSync(join(d, 'lamp.json'), JSON.stringify(p));
    const out = join(scratchDir('cli-bad-out'), 'never.sql');
    const r = cli(['--personas', d, '--lexicon', LEXICON, '--story', STORY, '--out', out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/lamp\.json.*boundaries/);
    expect(existsSync(out)).toBe(false);
  });
});


// 鐘塔之夢 修訂 1：拒絕清單（dream_blocklist）與依章節分層的 deflect_topics
describe('修訂 1：拒絕清單與分層的 deflect_topics', () => {
  it('SQL 寫入 dream_blocklist（id main）；讀回的內容等於清單檔', async () => {
    const { sql } = build();
    expect(sql).toMatch(/INSERT INTO dream_blocklist \(id, data, sha256, updated_at\) VALUES \('main'/);
    const w = await startWorker();
    try {
      await loadDreamFixtures(w);
      const row = await w.db.prepare("SELECT data, sha256 FROM dream_blocklist WHERE id = 'main'").first();
      expect(JSON.parse(row.data)).toEqual(JSON.parse(readFileSync(BLOCKLIST, 'utf8')));
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await w.close();
    }
  });
  it('沒有指定 --blocklist 時取人設資料夾上一層的 blocklist.json（私有 repo 的 dream/blocklist.json）', () => {
    const { sql } = buildDreamSql({ personasDir: PERSONAS, lexiconPath: LEXICON, storyDir: STORY, now: 1 });
    expect(sql).toContain('假髒話甲');
  });
  it('readBlocklist：檔案不存在、JSON 壞掉、沒有 categories、分類不是字串陣列、空詞、沒有任何詞 → 錯誤', () => {
    const d = scratchDir('block');
    expect(() => readBlocklist(join(d, 'nope.json'))).toThrow(/拒絕清單/);
    for (const bad of ['{', '{}', '{"categories":{}}', '{"categories":{"a":"x"}}', '{"categories":{"a":[5]}}', '{"categories":{"a":["。"]}}', '{"categories":{"a":[]}}']) {
      writeFileSync(join(d, 'b.json'), bad);
      expect(() => readBlocklist(join(d, 'b.json')), bad).toThrow(/b\.json/);
    }
    expect(readBlocklist(BLOCKLIST).categories.profanity).toEqual(['假髒話甲']);
  });
  it('deflect_topics 必須依章節分層（{ 章節: [主題…] }）：陣列、章節鍵格式錯、值不是字串陣列 → 錯誤', () => {
    for (const bad of [['燈油'], { Chapter1: ['x'] }, { chapter1: 'x' }, { chapter1: [5] }]) {
      const p = persona();
      p.deflect_topics = bad;
      expect(() => validatePersona(p, 'lamp.json'), JSON.stringify(bad)).toThrow(/lamp\.json.*deflect_topics/);
    }
    const p = persona();
    p.deflect_topics = { chapter3: [] };
    expect(() => validatePersona(p, 'lamp.json')).not.toThrow();
  });
});
