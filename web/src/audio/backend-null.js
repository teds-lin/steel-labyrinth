// 不出聲的後端：?test=1（E2E）與瀏覽器沒有 Web Audio 時使用。
// 不建立 AudioContext、不發任何網路請求；「要求播放了什麼」由 AudioDirector 的 lastSfx 記錄。
export class NullBackend {
  constructor(kind = 'null') {
    this.kind = kind;
    this.gains = null;
  }

  applyGains(g) { this.gains = { ...g }; }

  preload() { /* 不抓檔 */ }

  playSfx() { /* 不出聲 */ }

  playSynth() { /* 不出聲 */ }

  // 背景音樂與環境音（M6 P3）：實際播什麼由 AudioDirector 記錄（__SL.audio() 的 bgm／amb／music）
  playLoop() { /* 不出聲 */ }

  stopLoop() { /* 不出聲 */ }

  pauseLoop() { return 0; }

  duck() { /* 不出聲 */ }

  clearPaused() { /* 沒有記憶體要管 */ }
}
