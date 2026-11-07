// 聲音設定畫面與靜音提示的文字（純函式，node 可測）。排版在 MenuScene（settings 頁），規則在 audio/settings.js。
import { LEVEL_MAX, levelGain, stepLevel, toggleSetting, LEVEL_CHANNELS } from '../audio/settings.js';

/** 標題與遊戲選單的入口名稱，也是設定頁的標題。 */
export const SETTINGS_LABEL = '設定';

const LEVEL_NAMES = { bgm: '音樂', amb: '環境音', sfx: '音效' };
/** 全部靜音時，三條音量列附加的標記。 */
export const MUTED_MARK = '（靜音中）';

function levelParts(level) {
  const n = Math.min(LEVEL_MAX, Math.max(0, Math.round(Number(level) || 0)));
  return { bar: '■'.repeat(n) + '□'.repeat(LEVEL_MAX - n), value: n === 0 ? '關' : `${Math.round(levelGain(n) * 100)}%` };
}

/** 音量段數 → 「■■□□　50%」；0 顯示「關」。 */
export function levelText(level) {
  const { bar, value } = levelParts(level);
  return `${bar}　${value}`;
}

/**
 * 設定頁的五列（依序）。kind：level（左右調整）／toggle（開關）。
 * 音量列另外拆成 name／bar／value 三欄（畫面固定欄寬對齊）；全部靜音時 dimmed（變暗）並在 label 加「（靜音中）」。
 */
export function settingsRows(s) {
  return [
    ...LEVEL_CHANNELS.map((id) => {
      const { bar, value } = levelParts(s[id]);
      const name = LEVEL_NAMES[id];
      return { id, kind: 'level', name, bar, value, dimmed: !!s.mute, label: `${name}　${bar}　${value}${s.mute ? MUTED_MARK : ''}` };
    }),
    { id: 'mute', kind: 'toggle', label: `全部靜音：${s.mute ? '開' : '關'}` },
    { id: 'typing', kind: 'toggle', label: `對話打字音：${s.typing ? '開' : '關'}` },
  ];
}

/** 設定頁說明文字；觸控裝置不提鍵盤操作；瀏覽器封鎖儲存空間時提醒設定只在這次有效。 */
export function settingsNote(storageAvailable, { touch = false } = {}) {
  const base = touch ? '點 ◀ ▶ 或點整列調整' : '上下選擇項目，左右鍵或 ◀ ▶ 調整\n遊戲中隨時可按 M 鍵切換靜音';
  return storageAvailable ? base : `${base}\n瀏覽器封鎖了儲存空間，設定只在這次遊玩有效`;
}

/**
 * 設定頁的操作 → 新設定。action：left／right（加減一格；開關列則切換）、confirm（點列或 Enter：音量循環、開關切換）。
 */
export function settingsAction(s, rowId, action) {
  if (LEVEL_CHANNELS.includes(rowId)) {
    if (action === 'left') return stepLevel(s, rowId, -1);
    if (action === 'right') return stepLevel(s, rowId, 1);
    if (action === 'confirm') return stepLevel(s, rowId, 1, { wrap: true });
    return { ...s };
  }
  if ((rowId === 'mute' || rowId === 'typing') && ['left', 'right', 'confirm'].includes(action)) return toggleSetting(s, rowId);
  return { ...s };
}

/**
 * 回報資訊用的聲音狀態（AudioDirector.info() → buildReportInfo 的 env.sound）。依序判斷：
 * 瀏覽器不支援（後端 none 或沒有後端）→ off/unsupported；音效目錄載入失敗 → off/catalog（這兩種取消靜音也不會有聲音，所以優先於靜音）；
 * 靜音 → muted；尚未解鎖（還沒點過畫面）→ off/locked；其他 → on＋各通道音量段數與打字音開關。
 * on／muted 時，有無法播放的音效（載入失敗、播放出錯）另附 broken 數量。
 */
export function soundStatus(info) {
  const s = info?.settings;
  // 瀏覽器不支援優先於靜音：回報時才看得出「就算取消靜音也不會有聲音」
  if (!info || !info.backend || info.backend === 'none') return { status: 'off', reason: 'unsupported' };
  if (!info.catalog) return { status: 'off', reason: 'catalog' };
  const broken = Array.isArray(info.broken) ? info.broken.length : 0;
  if (s?.mute) return broken > 0 ? { status: 'muted', broken } : { status: 'muted' };
  if (!info.unlocked) return { status: 'off', reason: 'locked' };
  // 打字音跟音效音量：音效調到 0 時打字音實際上也不響
  const on = { status: 'on', bgm: s.bgm, amb: s.amb, sfx: s.sfx, typing: !!s.typing && s.sfx > 0 };
  return broken > 0 ? { ...on, broken } : on;
}

/** M 鍵切換後的短提示。menuHint：地圖上第一次按 M 時提醒選單改用 Esc（M 以前會開選單）。 */
export function muteToast(muted, { menuHint = false } = {}) {
  return `${muted ? '已靜音' : '已開啟聲音'}${menuHint ? '（選單請按 Esc）' : ''}`;
}

/**
 * M 鍵提示的 y（邏輯座標，提示中心）：依最上層場景避開頂部介面與按鈕。
 * 地圖（UI 場景）：HUD 0～62 下方（對話選項最多 4 個時上緣約 220，不相撞）；戰鬥：行動順序列 0～44、訊息 308，放戰場下半部；
 * 夢客交談：中間的紀錄是 DOM（會蓋住畫布），放輸入框（533～579）下方；標題：副標與按鈕之間；
 * 章節結束／結局：按鈕可能排到 530／590，最上方文字從約 84 開始，放最上方；其他：面板（70～570）下方。
 */
const TOAST_Y = { UI: 90, Battle: 262, Title: 262, ChapterEnd: 40 };
export function toastY(sceneKey) {
  return TOAST_Y[sceneKey] ?? 606;
}
