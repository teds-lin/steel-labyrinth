// 設定畫面與靜音提示的文字（M6 P1）：純函式，畫面層只負責排版。
import { describe, it, expect } from 'vitest';
import {
  SETTINGS_LABEL, settingsRows, levelText, settingsNote, muteToast, settingsAction, toastY, MUTED_MARK, soundStatus,
} from '../../web/src/ui/audio-view.js';
import { TITLE_KEY_HINT } from '../../web/src/ui/m5-view.js';
import { AUDIO_DEFAULTS } from '../../web/src/audio/settings.js';

describe('設定畫面的列', () => {
  it('入口名稱是「設定」', () => {
    expect(SETTINGS_LABEL).toBe('設定');
  });
  it('依序是音樂、環境音、音效、全部靜音、對話打字音', () => {
    const rows = settingsRows(AUDIO_DEFAULTS);
    expect(rows.map((r) => r.id)).toEqual(['bgm', 'amb', 'sfx', 'mute', 'typing']);
    expect(rows.map((r) => r.kind)).toEqual(['level', 'level', 'level', 'toggle', 'toggle']);
  });
  it('音量列顯示格數與百分比；0 顯示「關」', () => {
    expect(levelText(2)).toBe('■■□□　50%');
    expect(levelText(4)).toBe('■■■■　100%');
    expect(levelText(0)).toBe('□□□□　關');
    const rows = settingsRows({ ...AUDIO_DEFAULTS, sfx: 0 });
    expect(rows[0].label).toBe('音樂　■■□□　50%');
    expect(rows[1].label).toBe('環境音　■■□□　50%');
    expect(rows[2].label).toBe('音效　□□□□　關');
  });
  it('開關列顯示目前狀態', () => {
    const rows = settingsRows({ ...AUDIO_DEFAULTS, mute: true, typing: false });
    expect(rows[3].label).toBe('全部靜音：開');
    expect(rows[4].label).toBe('對話打字音：關');
    const d = settingsRows(AUDIO_DEFAULTS);
    expect(d[3].label).toBe('全部靜音：關');
    expect(d[4].label).toBe('對話打字音：開');
  });
  it('說明文字：提到 M 鍵；儲存空間被封鎖時多一行提示', () => {
    expect(settingsNote(true)).toContain('M');
    expect(settingsNote(true)).not.toContain('封鎖');
    expect(settingsNote(false)).toContain('瀏覽器封鎖了儲存空間');
  });
  it('觸控裝置：只說「點 ◀ ▶ 或點整列調整」，不提 M 鍵與左右鍵', () => {
    const t = settingsNote(true, { touch: true });
    expect(t).toBe('點 ◀ ▶ 或點整列調整');
    expect(t).not.toContain('M');
    expect(t).not.toContain('左右鍵');
    expect(settingsNote(false, { touch: true })).toBe('點 ◀ ▶ 或點整列調整\n瀏覽器封鎖了儲存空間，設定只在這次遊玩有效');
  });
  it('音量列拆成名稱、方塊、數值三欄（對齊用）；靜音中三條音量列變暗並標「（靜音中）」', () => {
    const rows = settingsRows(AUDIO_DEFAULTS);
    expect(rows[1]).toMatchObject({ name: '環境音', bar: '■■□□', value: '50%', dimmed: false });
    expect(settingsRows({ ...AUDIO_DEFAULTS, bgm: 0 })[0]).toMatchObject({ bar: '□□□□', value: '關' });
    expect(MUTED_MARK).toBe('（靜音中）');
    const m = settingsRows({ ...AUDIO_DEFAULTS, mute: true });
    for (const r of m.slice(0, 3)) {
      expect(r.dimmed, r.id).toBe(true);
      expect(r.label.endsWith('（靜音中）'), r.label).toBe(true);
    }
    expect(m[3].dimmed).toBeFalsy();
  });
});

describe('settingsAction：設定畫面的操作 → 新設定（純函式）', () => {
  const s = { ...AUDIO_DEFAULTS };
  it('音量列：左右加減一格、確認（點列）循環到下一格', () => {
    expect(settingsAction(s, 'bgm', 'left').bgm).toBe(1);
    expect(settingsAction(s, 'bgm', 'right').bgm).toBe(3);
    expect(settingsAction({ ...s, bgm: 4 }, 'bgm', 'confirm').bgm).toBe(0);
  });
  it('開關列：左右或確認都切換', () => {
    for (const a of ['left', 'right', 'confirm']) expect(settingsAction(s, 'mute', a).mute).toBe(true);
    expect(settingsAction(s, 'typing', 'confirm').typing).toBe(false);
  });
  it('未知列或動作：原樣回傳', () => {
    expect(settingsAction(s, 'voice', 'left')).toEqual(s);
    expect(settingsAction(s, 'bgm', 'jump')).toEqual(s);
  });
});

describe('soundStatus：AudioDirector 的摘要 → 回報資訊用的聲音狀態', () => {
  const info = (over = {}) => ({ backend: 'webaudio', unlocked: true, catalog: true, settings: { ...AUDIO_DEFAULTS }, ...over });
  it('可以出聲：on＋各通道音量', () => {
    expect(soundStatus(info())).toEqual({ status: 'on', bgm: 2, amb: 2, sfx: 3, typing: true });
  });
  it('靜音：muted（不管有沒有解鎖）；但瀏覽器不支援時優先回報不支援', () => {
    expect(soundStatus(info({ settings: { ...AUDIO_DEFAULTS, mute: true } }))).toEqual({ status: 'muted' });
    expect(soundStatus(info({ unlocked: false, settings: { ...AUDIO_DEFAULTS, mute: true } }))).toEqual({ status: 'muted' });
    expect(soundStatus(info({ backend: 'none', settings: { ...AUDIO_DEFAULTS, mute: true } }))).toEqual({ status: 'off', reason: 'unsupported' });
    expect(soundStatus(info({ catalog: false, settings: { ...AUDIO_DEFAULTS, mute: true } }))).toEqual({ status: 'off', reason: 'catalog' });
    expect(soundStatus(info({ broken: ['bgm_city'], settings: { ...AUDIO_DEFAULTS, mute: true } }))).toEqual({ status: 'muted', broken: 1 });
  });
  it('音效音量 0 時打字音算關（實際上不響）', () => {
    expect(soundStatus(info({ settings: { ...AUDIO_DEFAULTS, sfx: 0, typing: true } }))).toMatchObject({ status: 'on', sfx: 0, typing: false });
  });
  it('有音檔載入失敗時附上數量（沒有就不加這個欄位）', () => {
    expect(soundStatus(info({ broken: ['ui_error', 'bgm_city'] }))).toMatchObject({ status: 'on', broken: 2 });
    expect(soundStatus(info({ broken: [] }))).not.toHaveProperty('broken');
  });
  it('未啟用：瀏覽器不支援／音效目錄載入失敗／尚未解鎖（依序判斷）', () => {
    expect(soundStatus(info({ backend: 'none' }))).toEqual({ status: 'off', reason: 'unsupported' });
    expect(soundStatus(info({ catalog: false }))).toEqual({ status: 'off', reason: 'catalog' });
    expect(soundStatus(info({ unlocked: false }))).toEqual({ status: 'off', reason: 'locked' });
    expect(soundStatus(null)).toEqual({ status: 'off', reason: 'unsupported' });
  });
});

describe('M 鍵提示', () => {
  it('靜音／開聲音各有短提示', () => {
    expect(muteToast(true)).toBe('已靜音');
    expect(muteToast(false)).toBe('已開啟聲音');
  });
  it('地圖上第一次按 M：附上「（選單請按 Esc）」（M 以前會開選單）', () => {
    expect(muteToast(true, { menuHint: true })).toBe('已靜音（選單請按 Esc）');
    expect(muteToast(false, { menuHint: true })).toBe('已開啟聲音（選單請按 Esc）');
  });
  it('提示的位置依場景決定，避開頂部介面（HUD、行動順序列、夢客剩餘句數）', () => {
    expect(toastY('UI')).toBe(90); // 地圖：HUD（0～62）下方；對話選項最多 4 個時上緣約 220，不相撞
    expect(toastY('Battle')).toBe(262); // 戰場下半部（行動順序列在 0～44、訊息在 308）
    expect(toastY('DreamChat')).toBe(606); // 輸入框（533～579）下方；中間的紀錄是 DOM，會蓋住畫布
    expect(toastY('Title')).toBe(262); // 副標與按鈕之間
    expect(toastY('Menu')).toBe(606); // 面板（70～570）下方
    expect(toastY('ChapterEnd')).toBe(40); // 章節結束／結局畫面的按鈕可能排到 530／590，最上方文字從 92 開始
  });
  it('標題畫面的操作說明補上 M 鍵', () => {
    expect(TITLE_KEY_HINT).toContain('M 靜音');
    expect(TITLE_KEY_HINT).toContain('E 殘響／回溯');
  });
});
