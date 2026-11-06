#!/usr/bin/env node
// 用法：node tools/stamp-version.mjs [版本檔，預設 web/src/version.js]
// 版本日期＝HEAD commit 的台灣日期（UTC+8）；當天序號 n＝HEAD 以前（含）、台灣日期相同的 commit 數
// （需要完整歷史：Actions 的 checkout 要 fetch-depth: 0）。只改指定的版本檔，不 commit。
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { taiwanDate, versionFor, countOnDay, stampSource } from './lib/version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(process.argv[2] ?? join(root, 'web', 'src', 'version.js'));
const cwd = process.argv[2] ? dirname(file) : root;

const git = spawnSync('git', ['log', '--format=%ct', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (git.status !== 0) {
  console.error(`git log 失敗：${git.stderr}`);
  process.exit(1);
}
const stamps = git.stdout.split('\n').filter(Boolean).map(Number);
if (stamps.length === 0) {
  console.error('沒有任何 commit，無法決定版本');
  process.exit(1);
}
const date = taiwanDate(stamps[0]);
const version = versionFor(date, countOnDay(stamps, date));
writeFileSync(file, stampSource(readFileSync(file, 'utf8'), version));
console.log(`GAME_VERSION = ${version}（${file}）`);
