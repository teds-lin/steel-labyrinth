// 選曲（M6 P3）：依畫面與資料決定背景音樂與環境音。純函式。
// 回傳 null＝不換（選單、未知畫面）；amb 為 undefined＝環境音不變（戰鬥時沿用地圖的環境音，只是壓低）。
import { describe, it, expect } from 'vitest';
import { pickMusic } from '../../web/src/audio/pick.js';

const catalog = () => ({
  defaults: {
    title: 'bgm_theme', map: 'bgm_city', dream: 'bgm_dream', battle: 'bgm_battle', chapter_end: 'bgm_theme',
    ending: 'bgm_theme', game_over: null, dream_chat: 'bgm_dream', map_amb: null, dream_amb: 'amb_clock',
  },
});

describe('pickMusic', () => {
  it('標題、取名：主題曲，沒有環境音', () => {
    expect(pickMusic({ scene: 'Title' }, catalog())).toEqual({ bgm: 'bgm_theme', amb: null });
    expect(pickMusic({ scene: 'Name' }, catalog())).toEqual({ bgm: 'bgm_theme', amb: null });
  });
  it('地圖：欄位存在就用欄位（null＝安靜）；不存在時用預設（一般地圖／夢境）', () => {
    expect(pickMusic({ scene: 'Map', map: { id: 'a' } }, catalog())).toEqual({ bgm: 'bgm_city', amb: null });
    expect(pickMusic({ scene: 'Map', map: { id: 'a', amb: 'amb_rain' } }, catalog())).toEqual({ bgm: 'bgm_city', amb: 'amb_rain' });
    expect(pickMusic({ scene: 'Map', map: { id: 'a', bgm: null, amb: 'amb_harbor' } }, catalog())).toEqual({ bgm: null, amb: 'amb_harbor' });
    expect(pickMusic({ scene: 'Map', map: { id: 'd', dream: true } }, catalog())).toEqual({ bgm: 'bgm_dream', amb: 'amb_clock' });
    expect(pickMusic({ scene: 'Map', map: { id: 'd', dream: true, amb: null } }, catalog())).toEqual({ bgm: 'bgm_dream', amb: null });
  });
  it('地圖資料還沒有（讀檔中）：不換', () => {
    expect(pickMusic({ scene: 'Map', map: null }, catalog())).toBeNull();
  });
  it('欄位型別不對（資料壞掉）時退回預設，不丟錯', () => {
    expect(pickMusic({ scene: 'Map', map: { id: 'a', bgm: 3, amb: {} } }, catalog())).toEqual({ bgm: 'bgm_city', amb: null });
  });
  it('戰鬥：遭遇有指定就用（Boss），否則一般戰鬥曲；環境音不變；標記 battle', () => {
    expect(pickMusic({ scene: 'Battle', encounter: { id: 'e' } }, catalog())).toEqual({ bgm: 'bgm_battle', battle: true });
    expect(pickMusic({ scene: 'Battle', encounter: { id: 'b', bgm: 'bgm_boss' } }, catalog())).toEqual({ bgm: 'bgm_boss', battle: true });
    expect(pickMusic({ scene: 'Battle', encounter: null }, catalog())).toEqual({ bgm: 'bgm_battle', battle: true });
  });
  it('章節結束：一般用 chapter_end；結局畫面用結局指定的曲子或 ending 預設；沒有環境音', () => {
    expect(pickMusic({ scene: 'ChapterEnd' }, catalog())).toEqual({ bgm: 'bgm_theme', amb: null });
    expect(pickMusic({ scene: 'ChapterEnd', ending: { id: 'x' } }, catalog())).toEqual({ bgm: 'bgm_theme', amb: null });
    expect(pickMusic({ scene: 'ChapterEnd', ending: { id: 'x', bgm: 'bgm_dream' } }, catalog())).toEqual({ bgm: 'bgm_dream', amb: null });
  });
  it('GameOver：安靜（戰敗短樂句已經響過）', () => {
    expect(pickMusic({ scene: 'GameOver' }, catalog())).toEqual({ bgm: null, amb: null });
  });
  it('夢客交談：夢境曲，環境音不變', () => {
    expect(pickMusic({ scene: 'DreamChat' }, catalog())).toEqual({ bgm: 'bgm_dream' });
  });
  it('選單、Boot、未知畫面：不換', () => {
    for (const scene of ['Menu', 'Boot', 'Whatever', undefined]) expect(pickMusic({ scene }, catalog())).toBeNull();
  });
  it('目錄沒有 defaults 或缺鍵時當作安靜', () => {
    expect(pickMusic({ scene: 'Title' }, {})).toEqual({ bgm: null, amb: null });
    expect(pickMusic({ scene: 'Map', map: { id: 'a' } }, null)).toEqual({ bgm: null, amb: null });
  });
});
