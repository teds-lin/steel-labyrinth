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
}
