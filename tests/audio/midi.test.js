// MIDI 改編工具（tools/lib/midi.mjs）：解析／寫回、換樂器與力度、換聲道、取一段小節重複（離線渲染 bgm_city 用）。
import { describe, it, expect } from 'vitest';
import { parseMidi, writeMidi, arrange, loopSection, tempoBpm, ticksPerBar } from '../../tools/lib/midi.mjs';

// 小工具：組一個 format 1 的 MIDI（division 480）
const vlq = (n) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
function track(events) {
  // events: [deltaTick, ...bytes]
  const body = [];
  for (const [d, ...bytes] of events) body.push(...vlq(d), ...bytes);
  body.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
}
function midi(tracks, division = 480) {
  return Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, tracks.length, division >> 8, division & 255, ...tracks.flat()]);
}
const BAR = 480 * 3;
const conductor = () => track([
  [0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0], // 600000 µs/拍 = 100 BPM
  [0, 0xff, 0x58, 4, 3, 2, 24, 8], // 3/4
]);
// 每小節第一拍一個音（音高＝60＋小節編號），長 1 拍；共 4 小節
const melody = (ch = 0) => {
  const ev = [[0, 0xc0 | ch, 48], [0, 0xb0 | ch, 7, 100]];
  for (let b = 0; b < 4; b++) ev.push([b === 0 ? 0 : 960, 0x90 | ch, 60 + b, 80], [480, 0x80 | ch, 60 + b, 0]);
  return track(ev);
};
const notes = (tr) => tr.filter((e) => (e.bytes[0] & 0xf0) === 0x90 && e.bytes[2] > 0);
const offs = (tr) => tr.filter((e) => (e.bytes[0] & 0xf0) === 0x80 || ((e.bytes[0] & 0xf0) === 0x90 && e.bytes[2] === 0));

describe('parseMidi／writeMidi', () => {
  it('解析出 format、division、各音軌的絕對 tick 事件', () => {
    const m = parseMidi(midi([conductor(), melody()]));
    expect(m.format).toBe(1);
    expect(m.division).toBe(480);
    expect(m.tracks).toHaveLength(2);
    expect(notes(m.tracks[1]).map((e) => e.tick)).toEqual([0, BAR, 2 * BAR, 3 * BAR]);
  });
  it('running status 也能解析', () => {
    const t = track([[0, 0x90, 60, 80], [480, 62, 80], [480, 0x80, 60, 0], [0, 62, 0]]);
    const m = parseMidi(midi([t]));
    expect(notes(m.tracks[0]).map((e) => e.bytes[1])).toEqual([60, 62]);
    expect(offs(m.tracks[0])).toHaveLength(2);
  });
  it('寫回後再解析得到相同事件（往返不失真）', () => {
    const m = parseMidi(midi([conductor(), melody()]));
    const again = parseMidi(writeMidi(m));
    expect(again).toEqual(m);
  });
  it('不是 MIDI 時丟錯', () => {
    expect(() => parseMidi(Buffer.from('RIFF0000'))).toThrow(/MIDI/);
  });
  it('tempoBpm 與 ticksPerBar 讀第一個速度與拍號', () => {
    const m = parseMidi(midi([conductor(), melody()]));
    expect(tempoBpm(m)).toBeCloseTo(100, 6);
    expect(ticksPerBar(m)).toBe(BAR);
  });
});

describe('arrange：換樂器、力度、搬聲道、拿掉聲道', () => {
  it('換 program（原本就有 program change 的聲道）', () => {
    const m = arrange(parseMidi(midi([conductor(), melody()])), { channels: { 0: { program: 21 } } });
    const pc = m.tracks[1].filter((e) => (e.bytes[0] & 0xf0) === 0xc0);
    expect(pc.map((e) => e.bytes[1])).toEqual([21]);
  });
  it('聲道沒有 program change 時在 tick 0 補一個', () => {
    const t = track([[0, 0x92, 60, 80], [480, 0x82, 60, 0]]);
    const m = arrange(parseMidi(midi([t])), { channels: { 2: { program: 32 } } });
    expect(m.tracks[0][0]).toMatchObject({ tick: 0, bytes: [0xc2, 32] });
  });
  it('力度依比例縮放並夾在 1～127（note on 力度 0 等於 note off，不可被改成非 0）', () => {
    const t = track([[0, 0x90, 60, 100], [0, 0x90, 61, 2], [480, 0x90, 60, 0], [0, 0x90, 61, 0]]);
    const m = arrange(parseMidi(midi([t])), { channels: { 0: { velocity: 0.5 } } });
    expect(m.tracks[0].filter((e) => e.bytes[0] < 0xf0).map((e) => e.bytes[2])).toEqual([50, 1, 0, 0]);
    const loud = arrange(parseMidi(midi([t])), { channels: { 0: { velocity: 3 } } });
    expect(loud.tracks[0][0].bytes[2]).toBe(127);
  });
  it('把某個音軌的事件搬到另一個聲道（同聲道的兩個聲部才能用不同樂器）', () => {
    const m = arrange(parseMidi(midi([conductor(), melody(0), melody(0)])), { tracks: { 2: { channel: 6 } }, channels: { 6: { program: 49 } } });
    expect(notes(m.tracks[1]).every((e) => (e.bytes[0] & 0x0f) === 0)).toBe(true);
    expect(notes(m.tracks[2]).every((e) => (e.bytes[0] & 0x0f) === 6)).toBe(true);
    expect(m.tracks[2].filter((e) => (e.bytes[0] & 0xf0) === 0xc0).map((e) => e.bytes)).toEqual([[0xc6, 49]]);
  });
  it('drop：拿掉該聲道的所有聲道事件（meta 保留）', () => {
    const m = arrange(parseMidi(midi([conductor(), melody(5)])), { channels: { 5: { drop: true } } });
    expect(m.tracks[1].filter((e) => e.bytes[0] < 0xf0)).toEqual([]);
  });
  it('不改到輸入物件', () => {
    const src = parseMidi(midi([conductor(), melody()]));
    const copy = structuredClone(src);
    arrange(src, { channels: { 0: { program: 21, velocity: 0.5 } } });
    expect(src).toEqual(copy);
  });
  it('設定不合法時丟錯（program 超出 0～127、聲道超出 0～15、velocity 非正數）', () => {
    const m = parseMidi(midi([conductor(), melody()]));
    expect(() => arrange(m, { channels: { 0: { program: 128 } } })).toThrow();
    expect(() => arrange(m, { channels: { 16: { program: 1 } } })).toThrow();
    expect(() => arrange(m, { channels: { 0: { velocity: 0 } } })).toThrow();
    expect(() => arrange(m, { tracks: { 1: { channel: 9.5 } } })).toThrow();
  });
});

describe('loopSection：取 [起, 迄) 小節重複 n 次（第 2 次起前面已有殘響，取第 2 次就是無縫循環）', () => {
  it('段內的音依序重複；段前的設定（速度、拍號、program、控制器）移到 tick 0', () => {
    const m = loopSection(parseMidi(midi([conductor(), melody()])), { fromBar: 1, toBar: 3, repeats: 2 });
    expect(notes(m.tracks[1]).map((e) => [e.tick, e.bytes[1]])).toEqual([
      [0, 61], [BAR, 62], [2 * BAR, 61], [3 * BAR, 62],
    ]);
    expect(m.tracks[0].filter((e) => e.bytes[0] === 0xff && e.bytes[1] === 0x51).map((e) => e.tick)).toEqual([0]);
    const setup = m.tracks[1].filter((e) => e.tick === 0 && ((e.bytes[0] & 0xf0) === 0xc0 || (e.bytes[0] & 0xf0) === 0xb0));
    expect(setup.map((e) => e.bytes)).toEqual([[0xc0, 48], [0xb0, 7, 100]]);
  });
  it('跨過段尾的音在段尾補 note off；段前開始的音的 note off 不帶進來', () => {
    // 從第 0 拍開始、長 2 小節的音，取第 1～2 小節：開頭不應出現孤立的 note off；取第 0～1 小節：段尾要補 note off
    const t = track([[0, 0x90, 60, 80], [2 * BAR, 0x80, 60, 0], [0, 0x90, 64, 80], [480, 0x80, 64, 0]]);
    const a = loopSection(parseMidi(midi([conductor(), t])), { fromBar: 1, toBar: 3, repeats: 1 });
    expect(offs(a.tracks[1]).map((e) => e.tick)).toEqual([BAR + 480]);
    const b = loopSection(parseMidi(midi([conductor(), t])), { fromBar: 0, toBar: 1, repeats: 2 });
    expect(offs(b.tracks[1]).map((e) => e.tick)).toEqual([BAR, 2 * BAR]);
    expect(notes(b.tracks[1]).map((e) => e.tick)).toEqual([0, BAR]);
  });
  it('同一 tick 上 note off 排在 note on 前面（重複接縫的同音不會被提早關掉）', () => {
    const t = track([[0, 0x90, 60, 80], [BAR, 0x80, 60, 0]]);
    const m = loopSection(parseMidi(midi([conductor(), t])), { fromBar: 0, toBar: 1, repeats: 2 });
    const at = m.tracks[1].filter((e) => e.tick === BAR && e.bytes[0] < 0xf0).map((e) => e.bytes[0] & 0xf0);
    expect(at).toEqual([0x80, 0x90]);
  });
  it('每個音軌結尾都有 end of track，位置在 repeats × 段長', () => {
    const m = loopSection(parseMidi(midi([conductor(), melody()])), { fromBar: 0, toBar: 2, repeats: 3 });
    for (const tr of m.tracks) {
      const last = tr[tr.length - 1];
      expect(last.bytes).toEqual([0xff, 0x2f, 0]);
      expect(last.tick).toBe(6 * BAR);
    }
  });
  it('段落中途換速度不支援（循環長度算不準）→ 丟錯', () => {
    const c = track([[0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0], [0, 0xff, 0x58, 4, 3, 2, 24, 8], [BAR, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]]);
    expect(() => loopSection(parseMidi(midi([c, melody()])), { fromBar: 0, toBar: 3, repeats: 2 })).toThrow(/速度/);
  });
  it('參數不合法時丟錯', () => {
    const m = parseMidi(midi([conductor(), melody()]));
    expect(() => loopSection(m, { fromBar: 2, toBar: 2, repeats: 2 })).toThrow();
    expect(() => loopSection(m, { fromBar: 0, toBar: 2, repeats: 0 })).toThrow();
  });
});

describe('第 1 輪審查修正', () => {
  const chOf = (tr, tick) => tr.filter((e) => e.tick === tick && e.bytes[0] < 0xf0).map((e) => e.bytes[0] & 0xf0);
  it('同一 tick 上：note off → 換樂器／控制器／彎音 → note on（換樂器在音之前才會用新樂器發聲）', () => {
    const t = track([[0, 0xc0, 1], [0, 0xe0, 0, 64], [0, 0x90, 60, 80], [BAR, 0x80, 60, 0], [0, 0xc0, 5], [0, 0xb0, 7, 90], [0, 0x90, 62, 80], [480, 0x80, 62, 0]]);
    const m = loopSection(parseMidi(midi([conductor(), t])), { fromBar: 0, toBar: 2, repeats: 1 });
    expect(chOf(m.tracks[1], 0)).toEqual([0xc0, 0xe0, 0x90]);
    expect(chOf(m.tracks[1], BAR)).toEqual([0x80, 0xc0, 0xb0, 0x90]);
  });
  it('段前設定依原始先後、同鍵只留最後一個（bank select 在 program 前；Reset All Controllers 在音量前）', () => {
    const t = track([[0, 0xc0, 5], [0, 0xb0, 0, 1], [0, 0xc0, 6], [0, 0xb0, 7, 30], [0, 0xb0, 121, 0], [0, 0xb0, 7, 90], [0, 0xe0, 0, 70], [BAR, 0x90, 60, 80], [480, 0x80, 60, 0]]);
    const m = loopSection(parseMidi(midi([conductor(), t])), { fromBar: 1, toBar: 2, repeats: 1 });
    expect(m.tracks[1].filter((e) => e.tick === 0 && [0xb0, 0xc0].includes(e.bytes[0])).map((e) => e.bytes)).toEqual([[0xb0, 0, 1], [0xc0, 6], [0xb0, 121, 0], [0xb0, 7, 90]]);
    expect(m.tracks[1].find((e) => (e.bytes[0] & 0xf0) === 0xe0)).toMatchObject({ tick: 0, bytes: [0xe0, 0, 70] }); // 段前彎音帶入
  });
  it('同音重疊時依 FIFO 配對 note off', () => {
    const t = track([[0, 0x90, 60, 80], [240, 0x90, 60, 70], [240, 0x80, 60, 0], [240, 0x80, 60, 0]]);
    const m = loopSection(parseMidi(midi([conductor(), t])), { fromBar: 0, toBar: 1, repeats: 1 });
    const ev = m.tracks[1].filter((e) => e.bytes[0] < 0xf0).map((e) => [e.tick, e.bytes[0] & 0xf0, e.bytes[2]]);
    expect(ev).toEqual([[0, 0x90, 80], [240, 0x90, 70], [480, 0x80, 0], [720, 0x80, 0]]);
  });
  it('檔案中途換拍號：丟錯（小節會算錯）', () => {
    const c = track([[0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0], [0, 0xff, 0x58, 4, 4, 2, 24, 8], [1920 * 2, 0xff, 0x58, 4, 3, 2, 24, 8]]);
    expect(() => loopSection(parseMidi(midi([c, melody()])), { fromBar: 2, toBar: 3, repeats: 2 })).toThrow(/拍號/);
  });
  it('controls：在 tick 0 補上控制器（搬到新聲道的聲部帶入原聲道的音量、聲相、殘響）', () => {
    const t = track([[0, 0x92, 60, 80], [480, 0x82, 60, 0]]);
    const m = arrange(parseMidi(midi([t])), { channels: { 2: { program: 49, controls: { 7: 117, 10: 64, 91: 0 } } } });
    expect(m.tracks[0].slice(0, 4).map((e) => e.bytes)).toEqual([[0xc2, 49], [0xb2, 7, 117], [0xb2, 10, 64], [0xb2, 91, 0]]);
    expect(() => arrange(parseMidi(midi([t])), { channels: { 2: { controls: { 7: 200 } } } })).toThrow();
  });
  it('sysex、多位元組長度的 meta、meta 之後接 running status 都能往返', () => {
    const text = Array.from({ length: 200 }, () => 0x41);
    const t = track([[0, 0xf0, 3, 0x7e, 0x7f, 0xf7], [0, 0xff, 0x01, 0x81, 0x48, ...text], [0, 0x90, 60, 80], [0, 0xff, 0x01, 1, 0x42], [480, 60, 0]]);
    const m = parseMidi(midi([t]));
    expect(m.tracks[0].map((e) => e.bytes[0])).toEqual([0xf0, 0xff, 0x90, 0xff, 0x90, 0xff]);
    expect(m.tracks[0][1].bytes.length).toBe(2 + 2 + 200);
    expect(parseMidi(writeMidi(m))).toEqual(m);
  });
  it('format 0（單一音軌、多聲道）也能處理', () => {
    const t = track([[0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0], [0, 0xff, 0x58, 4, 3, 2, 24, 8], [0, 0x90, 60, 80], [0, 0x91, 40, 80], [480, 0x80, 60, 0], [0, 0x81, 40, 0]]);
    const buf = midi([t]);
    buf[9] = 0; // format 0
    const m = arrange(parseMidi(buf), { channels: { 1: { drop: true } } });
    expect(m.format).toBe(0);
    expect(loopSection(m, { fromBar: 0, toBar: 1, repeats: 2 }).tracks[0].filter((e) => e.bytes[0] < 0xf0).map((e) => [e.tick, e.bytes[0]])).toEqual([[0, 0x90], [480, 0x80], [BAR, 0x90], [BAR + 480, 0x80]]);
  });
  it('截斷的檔案：丟錯，不產生殘缺事件', () => {
    const buf = midi([conductor(), melody()]);
    expect(() => parseMidi(buf.subarray(0, buf.length - 6))).toThrow(/截斷/);
  });
  it('大型音軌（6 萬個事件）寫得出來（不會超出呼叫堆疊）', () => {
    const tr = [];
    for (let i = 0; i < 30000; i++) tr.push({ tick: i * 10, bytes: [0x90, 60, 80] }, { tick: i * 10 + 5, bytes: [0x80, 60, 0] });
    const out = writeMidi({ format: 0, division: 480, tracks: [tr] });
    expect(parseMidi(out).tracks[0]).toHaveLength(60001);
  });
});

describe('第 2 輪審查修正', () => {
  it('零長度的音（同一 tick 開又關）略過，不會變成卡住的長音', () => {
    const t = track([[0, 0x99, 36, 100], [0, 0x89, 36, 0], [480, 0x90, 60, 80], [480, 0x80, 60, 0]]);
    const m = loopSection(parseMidi(midi([conductor(), t])), { fromBar: 0, toBar: 1, repeats: 1 });
    expect(m.tracks[1].filter((e) => e.bytes[0] < 0xf0).map((e) => [e.tick, e.bytes[0], e.bytes[1]])).toEqual([[480, 0x90, 60], [960, 0x80, 60]]);
  });
  it('中途重寫相同的拍號不算換拍號；不同才丟錯', () => {
    const same = track([[0, 0xff, 0x51, 3, 0x09, 0x27, 0xc0], [0, 0xff, 0x58, 4, 3, 2, 24, 8], [BAR * 2, 0xff, 0x58, 4, 3, 2, 24, 8]]);
    expect(() => loopSection(parseMidi(midi([same, melody()])), { fromBar: 1, toBar: 3, repeats: 2 })).not.toThrow();
  });
  it('controls 覆寫資料在 tick 0 的同號控制器', () => {
    const t = track([[0, 0xb2, 7, 50], [0, 0x92, 60, 80], [480, 0x82, 60, 0]]);
    const m = arrange(parseMidi(midi([t])), { channels: { 2: { controls: { 7: 117 } } } });
    expect(m.tracks[0].filter((e) => e.bytes[0] === 0xb2).map((e) => e.bytes[2])).toEqual([117]);
  });
});
