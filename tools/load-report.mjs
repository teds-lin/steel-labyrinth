#!/usr/bin/env node
// 用法：node tools/load-report.mjs <回報文字檔|-> [--slot 1～3] [--data <資料目錄，預設 web/data>]
// 從玩家貼在討論區的「回報資訊」取出存檔字串，用 deserialize＋sanitizeLoadedState 驗證（與遊戲讀檔相同），
// 再印出可直接貼到瀏覽器 console 的 localStorage.setItem 指令，在本機重現玩家的狀況。
// 檔名用「-」時從標準輸入讀。結束碼：0＝通過、1＝找不到存檔或驗證失敗、2＝參數錯誤。
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundle } from './lib/bundle.mjs';
import { checkReport, consoleCommand } from './lib/report.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = '用法：node tools/load-report.mjs <回報文字檔|-> [--slot 1～3] [--data <資料目錄>]';

const args = process.argv.slice(2);
let file = null;
let slot = 1;
let dataDir = join(root, 'web', 'data');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--slot') slot = Number(args[++i]);
  else if (args[i] === '--data') dataDir = resolve(args[++i] ?? '');
  else if (file === null) file = args[i];
  else { console.error(`多餘的參數：${args[i]}\n${USAGE}`); process.exit(2); }
}
if (file === null) { console.error(USAGE); process.exit(2); }
if (!Number.isInteger(slot) || slot < 1 || slot > 3) { console.error(`--slot 只能是 1～3\n${USAGE}`); process.exit(2); }

let text;
try {
  text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
} catch (e) {
  console.error(`讀不到回報文字：${e.message}`);
  process.exit(2);
}

const { bundle, errors } = loadBundle(dataDir);
if (!bundle) { console.error(`讀不到遊戲資料（${dataDir}）：\n  ${errors.join('\n  ')}`); process.exit(2); }

// 回報的標頭（版本、裝置、章節…）照原樣列出，方便對照
const header = text.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\s*(?:>\s?)+/, ''))
  .filter((l) => /^(遊戲版本|時間|裝置|章節|譜系|隊伍|雲端存檔|附上的存檔)：|^目前不在遊戲中/.test(l));

const r = checkReport(text, bundle);
if (!r.ok) {
  if (header.length) console.error(header.join('\n'));
  console.error(`✗ ${r.reason}`);
  process.exit(1);
}
if (header.length) console.log(`${header.join('\n')}\n`);
const st = r.state;
console.log(`✓ 存檔驗證通過：${st.player.name}｜章節 ${st.chapter ?? '—'}｜地圖 ${st.location.map} (${st.location.x}, ${st.location.y})｜遊戲時間 ${st.playtime_s} 秒`);
for (const w of r.warnings) console.log(`  ⚠ 讀檔時會修正：${w}`);
console.log(`
在本機重現：
  1. npm run serve，用瀏覽器開 http://localhost:8080/?test=1
  2. 打開開發者工具的 console，貼上下面這一行（會覆蓋本機的存檔 ${slot}）：

${consoleCommand(r.saveString, slot)}

  3. 重新整理頁面，在標題畫面選「繼續」→「存檔 ${slot}」。`);
