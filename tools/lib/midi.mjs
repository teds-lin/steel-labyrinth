// 標準 MIDI 檔（SMF）的最小工具：解析／寫回、改編（換樂器、力度、搬聲道、拿掉聲道）、取一段小節重複。
// 只給離線渲染用（tools/audio-render.mjs → FluidSynth），不進遊戲執行期。
//
// 事件表示：{ tick（絕對）, bytes }。
//   聲道事件 bytes＝[status, d1, (d2)]（一律展開 running status）；
//   meta＝[0xff, type, ...長度 VLQ, ...資料]；sysex＝[0xf0／0xf7, ...長度 VLQ, ...資料]。
// 每個音軌最後一個事件是 end of track（[0xff, 0x2f, 0]）。

const EOT = [0xff, 0x2f, 0];

function readVlq(b, p) {
  let v = 0;
  let c;
  do {
    c = b[p++];
    v = (v << 7) | (c & 0x7f);
  } while (c & 0x80);
  return [v, p];
}

function vlq(n) {
  const out = [n & 0x7f];
  while ((n >>>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const isEot = (e) => e.bytes[0] === 0xff && e.bytes[1] === 0x2f;
const kindOf = (st) => st & 0xf0;
const dataLen = (st) => (kindOf(st) === 0xc0 || kindOf(st) === 0xd0 ? 1 : 2);
const isNoteOn = (e) => kindOf(e.bytes[0]) === 0x90 && e.bytes[0] < 0xf0 && e.bytes[2] > 0;
const isNoteOff = (e) => e.bytes[0] < 0xf0 && (kindOf(e.bytes[0]) === 0x80 || (kindOf(e.bytes[0]) === 0x90 && e.bytes[2] === 0));

/** 解析 SMF。不是 MIDI 時丟錯。 */
export function parseMidi(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const str = (p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  const u32 = (p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
  if (b.length < 14 || str(0) !== 'MThd') throw new Error('不是 MIDI 檔（缺 MThd）');
  const hlen = u32(4);
  const format = (b[8] << 8) | b[9];
  const ntr = (b[10] << 8) | b[11];
  const division = (b[12] << 8) | b[13];
  if (division & 0x8000) throw new Error('不支援 SMPTE 時間格式的 MIDI');
  let p = 8 + hlen;
  const tracks = [];
  for (let t = 0; t < ntr; t++) {
    if (str(p) !== 'MTrk') throw new Error(`MIDI 第 ${t} 個音軌缺 MTrk`);
    const end = p + 8 + u32(p + 4);
    p += 8;
    let tick = 0;
    let run = 0;
    const ev = [];
    while (p < end) {
      let d;
      [d, p] = readVlq(b, p);
      tick += d;
      let st = b[p];
      if (st & 0x80) p++;
      else st = run;
      if (st === 0xff) {
        const type = b[p++];
        const s = p;
        let len;
        [len, p] = readVlq(b, p);
        if (p + len > end) throw new Error(`MIDI 第 ${t} 個音軌的 meta 事件超出音軌結尾（檔案可能被截斷）`);
        ev.push({ tick, bytes: [0xff, type, ...b.subarray(s, p + len)] });
        p += len;
      } else if (st === 0xf0 || st === 0xf7) {
        const s = p;
        let len;
        [len, p] = readVlq(b, p);
        if (p + len > end) throw new Error(`MIDI 第 ${t} 個音軌的 sysex 超出音軌結尾（檔案可能被截斷）`);
        ev.push({ tick, bytes: [st, ...b.subarray(s, p + len)] });
        p += len;
      } else {
        if (!(st & 0x80)) throw new Error('MIDI 資料錯誤（缺狀態位元組）');
        run = st;
        const n = dataLen(st);
        if (p + n > end) throw new Error(`MIDI 第 ${t} 個音軌的事件超出音軌結尾（檔案可能被截斷）`);
        ev.push({ tick, bytes: [st, ...b.subarray(p, p + n)] });
        p += n;
      }
    }
    if (end > b.length) throw new Error(`MIDI 第 ${t} 個音軌的長度超出檔案（檔案可能被截斷）`);
    p = end;
    tracks.push(ev);
  }
  return { format, division, tracks };
}

/** 寫回 SMF（不用 running status）。音軌缺 end of track 時補在最後一個事件的位置。 */
export function writeMidi(m) {
  const out = [Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, m.format, (m.tracks.length >> 8) & 255, m.tracks.length & 255, (m.division >> 8) & 255, m.division & 255])];
  for (const tr of m.tracks) {
    const ev = tr.length && isEot(tr[tr.length - 1]) ? tr : [...tr, { tick: tr.length ? tr[tr.length - 1].tick : 0, bytes: EOT }];
    const body = [];
    let last = 0;
    for (const e of ev) {
      if (e.tick < last) throw new Error('MIDI 事件沒有依 tick 排序');
      for (const x of vlq(e.tick - last)) body.push(x);
      for (const x of e.bytes) body.push(x); // 不用展開運算子：大型音軌會超出呼叫堆疊
      last = e.tick;
    }
    const n = body.length;
    out.push(Buffer.from([0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]), Buffer.from(body));
  }
  return Buffer.concat(out);
}

const metaData = (e) => {
  const [len, p] = readVlq(e.bytes, 2);
  return e.bytes.slice(p, p + len);
};
const allEvents = (m) => m.tracks.flat();

/** 第一個速度事件的 BPM（沒有時 120）。 */
export function tempoBpm(m) {
  const t = allEvents(m).filter((e) => e.bytes[0] === 0xff && e.bytes[1] === 0x51).sort((a, b) => a.tick - b.tick)[0];
  if (!t) return 120;
  const [a, b, c] = metaData(t);
  return 60e6 / ((a << 16) | (b << 8) | c);
}

/** 第一個拍號的每小節 tick 數（沒有時 4/4）。 */
export function ticksPerBar(m) {
  const t = allEvents(m).filter((e) => e.bytes[0] === 0xff && e.bytes[1] === 0x58).sort((a, b) => a.tick - b.tick)[0];
  return t ? ticksPerBarOf(t, m.division) : m.division * 4;
}
function ticksPerBarOf(e, division) {
  const [num, pow] = metaData(e);
  return (num * division * 4) / 2 ** pow;
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/**
 * 改編：tracks[i].channel＝把該音軌的聲道事件搬到另一個聲道（先做）；
 * channels[ch]＝{ program（0～127）, velocity（力度倍率 > 0）, drop（拿掉該聲道的所有聲道事件）,
 *                controls（{ 控制器編號: 值 }，在 tick 0 設定，覆寫資料在 tick 0 的同號控制器；搬到新聲道的聲部用來帶入原聲道的音量、聲相、殘響） }。
 * 聲道沒有 program change 時，在第一個用到它的音軌的 tick 0 補一個。回傳新物件，不改輸入。
 */
export function arrange(m, { tracks = {}, channels = {} } = {}) {
  for (const [i, o] of Object.entries(tracks)) {
    if (!isInt(Number(i), 0, m.tracks.length - 1)) throw new Error(`音軌 ${i} 不存在`);
    if (o.channel !== undefined && !isInt(o.channel, 0, 15)) throw new Error(`音軌 ${i}：channel 必須是 0～15 的整數`);
  }
  for (const [ch, o] of Object.entries(channels)) {
    if (!isInt(Number(ch), 0, 15)) throw new Error(`聲道 ${ch} 不合法`);
    if (o.program !== undefined && !isInt(o.program, 0, 127)) throw new Error(`聲道 ${ch}：program 必須是 0～127 的整數`);
    if (o.velocity !== undefined && !(typeof o.velocity === 'number' && Number.isFinite(o.velocity) && o.velocity > 0)) throw new Error(`聲道 ${ch}：velocity 必須是正數`);
    for (const [cc, v] of Object.entries(o.controls ?? {})) {
      if (!isInt(Number(cc), 0, 127) || !isInt(v, 0, 127)) throw new Error(`聲道 ${ch}：controls 的控制器編號與值都必須是 0～127 的整數`);
    }
  }
  const out = structuredClone(m);
  out.tracks = out.tracks.map((tr, i) => {
    const to = tracks[i]?.channel;
    if (to === undefined) return tr;
    return tr.map((e) => (e.bytes[0] < 0xf0 ? { ...e, bytes: [(e.bytes[0] & 0xf0) | to, ...e.bytes.slice(1)] } : e));
  });
  const hasProgram = new Set();
  out.tracks = out.tracks.map((tr) => tr.flatMap((e) => {
    const st = e.bytes[0];
    if (st >= 0xf0) return [e];
    const ch = st & 0x0f;
    const o = channels[ch];
    if (!o) return [e];
    if (o.drop) return [];
    if (kindOf(st) === 0xc0) {
      hasProgram.add(ch);
      return [o.program !== undefined ? { ...e, bytes: [st, o.program] } : e];
    }
    if (isNoteOn(e) && o.velocity !== undefined) {
      return [{ ...e, bytes: [st, e.bytes[1], Math.max(1, Math.min(127, Math.round(e.bytes[2] * o.velocity)))] }];
    }
    return [e];
  }));
  for (const [chKey, o] of Object.entries(channels)) {
    const ch = Number(chKey);
    if (o.drop) continue;
    const ti = out.tracks.findIndex((tr) => tr.some((e) => e.bytes[0] < 0xf0 && (e.bytes[0] & 0x0f) === ch));
    if (ti < 0) continue;
    const ccs = new Set(Object.keys(o.controls ?? {}).map(Number));
    // controls 是覆寫：拿掉資料在 tick 0 的同號控制器（否則會排在後面、把設定值蓋掉）
    if (ccs.size) {
      out.tracks = out.tracks.map((tr) => tr.filter((e) => !(e.tick === 0 && e.bytes[0] === (0xb0 | ch) && ccs.has(e.bytes[1]))));
    }
    const add = Object.entries(o.controls ?? {}).map(([cc, v]) => ({ tick: 0, bytes: [0xb0 | ch, Number(cc), v] }));
    if (o.program !== undefined && !hasProgram.has(ch)) add.unshift({ tick: 0, bytes: [0xc0 | ch, o.program] });
    out.tracks[ti].unshift(...add);
  }
  return out;
}

/** 段前要帶到 tick 0 的 meta：速度、拍號、調號、音軌名、樂器名（各取最後一個）。 */
const SETUP_META = new Set([0x51, 0x58, 0x59, 0x03, 0x04]);

/**
 * 取 [fromBar, toBar) 小節，重複 repeats 次。段前的設定（上表的 meta、sysex、每聲道最後的 program、
 * 每個控制器最後的值、pitch bend）移到 tick 0；段內開始的音照原長度，跨過段尾的在段尾補 note off；
 * 段前開始的音（及其 note off）不帶進來。同一 tick 上依序：note off → 其他事件（換樂器、控制器、彎音）→ note on。
 * 段內不得換速度；整個檔案只能有 tick 0 的拍號（小節換算用）。
 */
export function loopSection(m, { fromBar, toBar, repeats }) {
  if (!isInt(fromBar, 0, Infinity) || !isInt(toBar, fromBar + 1, Infinity)) throw new Error('小節範圍必須是 0 ≤ fromBar < toBar 的整數');
  if (!isInt(repeats, 1, 64)) throw new Error('repeats 必須是 1～64 的整數');
  const bar = ticksPerBar(m);
  const start = fromBar * bar;
  const end = toBar * bar;
  const len = end - start;
  for (const e of allEvents(m)) {
    if (e.bytes[0] === 0xff && e.bytes[1] === 0x51 && e.tick > start && e.tick < end) throw new Error('段落中途換速度，無法算出固定的循環長度');
    // 小節位置只用第一個拍號算：檔案中途換拍號時小節會算錯，直接丟錯
    if (e.bytes[0] === 0xff && e.bytes[1] === 0x58 && e.tick > 0 && ticksPerBarOf(e, m.division) !== bar) throw new Error('MIDI 中途換拍號，無法用第一個拍號換算小節');
  }
  const tracks = m.tracks.map((tr) => {
    // 1. 段前設定：同一個鍵只留最後一個，依原始先後排（bank select 在 program 前、Reset All Controllers 在音量前）
    const setup = new Map();
    let seq = 0;
    const keep = (k, e, i) => { setup.delete(k); setup.set(k, { e, i }); };
    tr.forEach((e, i) => {
      if (e.tick > start || isEot(e)) return;
      const st = e.bytes[0];
      if (st === 0xff) {
        if (SETUP_META.has(e.bytes[1])) keep(`m${e.bytes[1]}`, e, i);
      } else if (st === 0xf0 || st === 0xf7) {
        if (e.tick < start) keep(`s${i}`, e, i);
      } else if (e.tick < start) {
        const k = kindOf(st);
        const ch = st & 0x0f;
        if (k === 0xc0) keep(`p${ch}`, e, i);
        else if (k === 0xb0) keep(`c${ch}:${e.bytes[1]}`, e, i);
        else if (k === 0xe0) keep(`b${ch}`, e, i);
      }
    });
    const head = [...setup.values()].sort((a, b) => a.i - b.i)
      .map(({ e }) => ({ tick: 0, bytes: [...e.bytes], prio: -1, seq: seq++ }));
    // 2. 段內事件：音配對 note off
    const open = new Map(); // `${ch}:${note}` → 未關的 note on（FIFO）
    const pairs = [];
    for (const e of tr) {
      if (isNoteOn(e)) {
        const k = `${e.bytes[0] & 0x0f}:${e.bytes[1]}`;
        const item = { on: e, off: null };
        (open.get(k) ?? open.set(k, []).get(k)).push(item);
        pairs.push(item);
      } else if (isNoteOff(e)) {
        const q = open.get(`${e.bytes[0] & 0x0f}:${e.bytes[1]}`);
        const item = q?.shift();
        if (item) item.off = e;
      }
    }
    const body = [];
    for (let r = 0; r < repeats; r++) {
      const off0 = r * len - start;
      for (const pr of pairs) {
        if (pr.on.tick < start || pr.on.tick >= end) continue;
        const offTick = Math.min(pr.off ? pr.off.tick : end, end);
        if (offTick <= pr.on.tick) continue; // 零長度的音（同一 tick 開又關）略過：排序後會變成先關後開，卡成長音
        const offBytes = pr.off ? [...pr.off.bytes] : [0x80 | (pr.on.bytes[0] & 0x0f), pr.on.bytes[1], 0];
        body.push({ tick: pr.on.tick + off0, bytes: [...pr.on.bytes], prio: 2, seq: seq++ });
        body.push({ tick: offTick + off0, bytes: offBytes, prio: 0, seq: seq++ });
      }
      for (const e of tr) {
        if (e.tick < start || e.tick >= end || isEot(e) || isNoteOn(e) || isNoteOff(e)) continue;
        if (e.bytes[0] === 0xff && SETUP_META.has(e.bytes[1]) && e.tick === start) continue; // 已在 head
        body.push({ tick: e.tick + off0, bytes: [...e.bytes], prio: 1, seq: seq++ }); // 換樂器、控制器、彎音排在同一 tick 的音之前
      }
    }
    const all = [...head, ...body].sort((a, b) => a.tick - b.tick || a.prio - b.prio || a.seq - b.seq);
    return [...all.map(({ tick, bytes }) => ({ tick, bytes })), { tick: repeats * len, bytes: [...EOT] }];
  });
  return { format: m.format, division: m.division, tracks };
}
