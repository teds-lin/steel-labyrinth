// 聲音的單例與瀏覽器端初始化：選後端、讀目錄、首次手勢解鎖、分頁隱藏時暫停、M 鍵切換靜音。
// 畫面層一律 import { audio } 呼叫 audio.sfx(id)；?test=1 時是 NullBackend（不出聲、不抓任何音檔）。
import { AudioDirector } from './director.js';
import { NullBackend } from './backend-null.js';
import { WebAudioBackend } from './backend-webaudio.js';
import { chooseFormats } from './catalog.js';
import { createGestureUnlocker } from './unlock.js';
import { exploreEventKeys } from './events.js';
import { endingsOf } from '../core/ending.js';
import { session } from '../session.js';
import { muteToast } from '../ui/audio-view.js';
import { showAudioToast, audioToastText, audioToastRect } from '../ui/audio-toast.js';
import { assetUrl } from '../asset-url.js';

/** 遊戲唯一的聲音入口。設定存在 session.backend（localStorage；被封鎖時為 null → 只在記憶體）。 */
export const audio = new AudioDirector({ storage: session.backend });

/** 目前焦點在文字輸入框（名字、轉移碼、夢客交談、回報文字框）時，按鍵屬於輸入，不當快捷鍵。 */
function inTextField(el) {
  if (!el || typeof el !== 'object') return false;
  const tag = String(el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

function makeBackend(game, test) {
  if (test) return new NullBackend('null');
  const ctx = game.sound?.context;
  if (!ctx) return new NullBackend('none'); // 瀏覽器不支援 Web Audio：保持安靜
  let formats = ['m4a'];
  try {
    const probe = document.createElement('audio');
    formats = chooseFormats((t) => probe.canPlayType(t));
  } catch { /* 判斷不了就用 m4a */ }
  return new WebAudioBackend({
    ctx,
    destination: game.sound.destination,
    director: audio,
    base: new URL('audio/', document.baseURI).href,
    formats,
    // 音檔刻意不加版本：音檔與程式之間沒有「連結」關係，快取到舊音檔最多只是舊聲音再播 10 分鐘，不會壞畫面；
    // 新增的音檔是新檔名，本來就不在快取裡。不加版本可以避免每次發版都讓玩家重新下載全部音效（行動網路）。
    fetchFn: (u) => fetch(u),
  });
}

/**
 * 解鎖＝「有過使用者手勢」且「context 真的是 running」。瀏覽器允許自動播放時 context 一開始就 running，
 * 也要等第一次手勢才下載與播放。手勢用 capture 階段監聽（比遊戲的按鍵處理早），每次手勢在 context 不是 running 時
 * 自己呼叫 resume()；被拒絕（例如只按 Esc，不算使用者啟動）就等下一次手勢，不會永遠鎖住。規則在 audio/unlock.js。
 * NullBackend 沒有 context：手勢即解鎖，所以同一下的介面音也會記錄（只記錄、不出聲）。
 */
function hookUnlock(game, backend) {
  const ctx = backend.kind === 'webaudio' ? game.sound.context : null;
  createGestureUnlocker({ ctx, target: window, onUnlock: () => audio.markUnlocked() });
}

async function loadCatalog() {
  try {
    // 發布版加 ?v=<ASSET_VERSION>：保證瀏覽器的 HTTP 快取不會拿上一版的目錄配這一版的程式（每版網址不同）。
    // 注意這不等於「伺服器一定回同一版」：GitHub Pages 忽略查詢參數，快取裡沒有時拿到的永遠是伺服器上目前的檔案。
    const res = await fetch(assetUrl('audio/catalog.json'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    audio.setCatalog(await res.json());
  } catch (e) {
    audio.warnOnce('catalog-load', '音訊目錄載入失敗，遊戲將保持安靜', e?.message ?? e);
  }
}

/**
 * M 鍵：切換全部靜音並顯示短提示（任何畫面都可用；輸入框裡打字不算）。
 * M 以前在地圖上是開選單：地圖上第一次按 M 時提示附上「（選單請按 Esc）」，之後只顯示結果。
 */
function hookMuteKey(game) {
  let mapHinted = false;
  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'KeyM' || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (inTextField(ev.target) || inTextField(document.activeElement)) return;
    const menuHint = session.scene === 'Map' && !mapHinted;
    if (menuHint) mapHinted = true;
    const msg = muteToast(audio.toggleMute(), { menuHint });
    audio.noteHint(msg);
    showAudioToast(game, msg);
  });
}

/**
 * 探索音效的單一掛點：所有狀態變化都經過 session.setState → 'state' 事件（next, prev, meta）。
 * 依差異與觸發原因算出事件鍵（audio/events.js 的 exploreEventKeys），對應的 cue 查 catalog 的 events。
 */
function hookExplore() {
  session.events.on('state', (next, prev, meta) => {
    try {
      for (const k of exploreEventKeys(prev, next, meta, session.data)) audio.event(k);
    } catch (e) {
      audio.warnOnce('explore', '探索音效判斷出錯', e?.message ?? e);
    }
  });
}

/**
 * 目前畫面的選曲情境（規則在 audio/pick.js）：地圖＝目前地圖的資料；戰鬥＝遭遇資料；章節結束＝結局資料（結局畫面才有）。
 */
function musicContext(game) {
  const scene = session.scene;
  const data = session.data;
  const ctx = { scene };
  if (scene === 'Map') {
    const id = session.state?.location?.map;
    ctx.map = (data?.maps ?? []).find((m) => m?.id === id) ?? null;
  } else if (scene === 'Battle') {
    const id = game.scene.getScene('Battle')?.encounterId;
    ctx.encounter = (data?.encounters ?? []).find((e) => e?.id === id) ?? null;
  } else if (scene === 'ChapterEnd') {
    const sc = game.scene.getScene('ChapterEnd');
    const endId = sc?.texts?.ending?.id;
    ctx.ending = endId ? endingsOf(sc.chapter, data).find((e) => e?.id === endId) ?? null : null;
  }
  return ctx;
}

/**
 * 背景音樂與環境音的掛點：畫面切換（session 的 'scene' 事件）與地圖內換圖（'state' 事件的 location.map 改變）。
 * 畫面切換在場景的 create() 開頭發出，結局等資料要等 create() 跑完才有，所以延到 microtask 再判斷。
 */
function hookMusic(game) {
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      try { audio.setScene(musicContext(game)); } catch (e) { audio.warnOnce('music-ctx', '選曲判斷出錯', e?.message ?? e); }
    });
  };
  session.events.on('scene', refresh);
  session.events.on('state', (next, prev) => {
    if (session.scene === 'Map' && next?.location?.map !== prev?.location?.map) refresh();
  });
  refresh();
}

export function initAudio(game, { test = false } = {}) {
  try {
    if (!test && game.sound) {
      // 失焦（例如點進 Turnstile 的 iframe）不暫停；改由 visibilitychange 處理分頁隱藏
      game.sound.pauseOnBlur = false;
    }
    const backend = makeBackend(game, test);
    audio.frame = () => game.loop?.frame ?? null;
    audio.attach(backend);
    hookUnlock(game, backend);
    {
      // 分頁隱藏／回來：掛 Phaser 的 HIDDEN／VISIBLE 事件（Phaser 依 visibilitychange 發出，同時也會停止／恢復遊戲迴圈）。
      // 這裡只暫停／恢復聲音（director 轉給後端；隱藏時隨機單次音不響）；遊戲迴圈由 Phaser 自己處理。
      // Phaser 3.88+ 在 VISIBLE 時另有 iOS 的 suspend→resume 修正，保留不動。
      const hidden = (v) => () => audio.setHidden(v);
      game.events.on(Phaser.Core.Events.HIDDEN, hidden(true));
      game.events.on(Phaser.Core.Events.VISIBLE, hidden(false));
    }
    if (typeof backend.resetOffline === 'function') {
      // 網路斷過一次不代表整局安靜：恢復連線或分頁回到前景時解除斷路，重新下載還沒載入的音檔
      const retry = () => { try { backend.resetOffline(); } catch { /* 不影響遊戲 */ } };
      window.addEventListener('online', retry);
      game.events.on(Phaser.Core.Events.VISIBLE, retry);
    }
    hookMuteKey(game);
    hookExplore();
    hookMusic(game);
    loadCatalog();
  } catch (e) {
    audio.warnOnce('init', '聲音初始化失敗，遊戲將保持安靜', e?.message ?? e);
  }
}

/** E2E 用（__SL.audio()）：director 的摘要＋目前畫面上的靜音提示。 */
export function audioDebugInfo() {
  return { ...audio.info(), toast: audioToastText(), toastRect: audioToastRect(), real: audio.backend?.debugInfo?.() ?? null };
}
