// Decoder for Betaflight's native blackbox log (.bbl / .bfl): the binary format its blackbox writer
// produces (src/main/blackbox/blackbox.c, blackbox_encoding.c), decoded as the reference parsers do
// (blackbox-tools src/parser.c + decoders.c, Blackbox Explorer flightlog_parser.js). Pure TypeScript,
// no Node or DOM APIs: runs in a browser worker and in Node.
//
// A file holds one or more logs back to back, each starting with the "H Product:..." header line.
// A log is ASCII header lines ("H name:value"), then binary frames, each a one-letter marker and its
// fields: I (intra: absolute main state), P (inter: deltas against the previous main frames), S
// (slow: flight modes, failsafe), G / H (GPS fix / home) and E (events: sync beep, disarm, flight
// mode change, logging resume, end of log). Every field has an encoding (how its bits are stored)
// and a predictor (what the stored value is relative to); both come from the "Field X ..." headers.
//
// Robustness, as the reference parsers: a frame only counts once the byte after it is a frame
// marker (or the end of the data); otherwise it is corrupt and the scan restarts one byte after its
// marker. After corruption the main stream waits for the next I frame (P frames need history), and
// main frames whose iteration / time go backwards or jump too far are rejected. Never throws.

const LOG_START = 'H Product:Blackbox flight data recorder by Nicholas Sherlock\n';
const MAX_FRAME_LENGTH = 256;
const MAX_TIME_JUMP = 10 * 1000000; // µs: no log misses 10 s of frames
const MAX_ITERATION_JUMP = 500 * 10;

/** Field predictors (blackbox_fielddefs.h). HOME_COORD_1 is the parser's own: the second of a lat/lon pair. */
export const PREDICTOR = {
  ZERO: 0, PREVIOUS: 1, STRAIGHT_LINE: 2, AVERAGE_2: 3, MINTHROTTLE: 4, MOTOR_0: 5, INC: 6,
  HOME_COORD: 7, P1500: 8, VBATREF: 9, LAST_MAIN_FRAME_TIME: 10, MINMOTOR: 11, HOME_COORD_1: 256,
} as const;

/** Field encodings (blackbox_fielddefs.h). */
export const ENCODING = {
  SIGNED_VB: 0, UNSIGNED_VB: 1, NEG_14BIT: 3, TAG8_8SVB: 6, TAG2_3S32: 7, TAG8_4S16: 8, NULL: 9, TAG2_3SVARIABLE: 10,
} as const;

/** Event frame types (FlightLogEvent). */
export const BBL_EVENT = {
  SYNC_BEEP: 0, AUTOTUNE_CYCLE_START: 10, AUTOTUNE_CYCLE_RESULT: 11, AUTOTUNE_TARGETS: 12, INFLIGHT_ADJUSTMENT: 13,
  LOGGING_RESUME: 14, DISARM: 15, GTUNE_CYCLE_RESULT: 20, FLIGHT_MODE: 30, TWITCH_TEST: 40, LOG_END: 255,
} as const;
const EVENT_NAME: Record<number, string> = Object.fromEntries(Object.entries(BBL_EVENT).map(([k, v]) => [v, k]));

/** One frame type's field definitions, from the "H Field X name/signed/predictor/encoding" headers. */
export interface BblFieldDef {
  names: string[];
  signed: number[];
  predictor: number[];
  encoding: number[];
}

/** The header values a decoder or analysis needs, parsed (raw strings are in BblLog.headers). */
export interface BblSysConfig {
  /** "Betaflight 4.5.5 (4.5.5) WASM" */
  firmwareRevision: string;
  /** Betaflight, INAV, Cleanflight, Baseflight, ... ('' when unknown) */
  firmwareType: string;
  /** [major, minor, patch] from the revision; null when unknown */
  firmwareVersion: [number, number, number] | null;
  dataVersion: number;
  /** "I interval" (loop iterations per I frame), "P interval" as num/denom (a main frame every denom/num iterations), "P ratio" */
  frameIntervalI: number; frameIntervalPNum: number; frameIntervalPDenom: number;
  pRatio: number | null;
  /** gyro sample period (µs), PID loop denominator: the PID loop runs every looptime·pid_process_denom µs */
  looptime: number | null;
  pid_process_denom: number;
  /** expected time between logged main frames (µs) when every frame is logged; null without looptime */
  frameIntervalUs: number | null;
  /** "blackbox_sample_rate" header when the firmware writes it (raw text), else null */
  blackbox_sample_rate: string | null;
  minthrottle: number; maxthrottle: number;
  /** motor output range [low, high] (DShot: idle value .. 2047) */
  motorOutput: [number, number];
  vbatscale: number; vbatref: number;
  /** current sensor [offset, scale] */
  currentMeter: [number, number];
  acc_1G: number;
  /** the header's gyro_scale float: deg/s per LSB on Betaflight / Cleanflight / INAV, rad/µs on Baseflight */
  gyro_scale: number;
  /** blackbox_high_resolution: gyro, rcCommand and setpoint are logged ×10 */
  highResolution: boolean;
  motorPoles: number | null;
  debugMode: number | null;
}

export interface BblEvent {
  type: number;
  name: string;
  /** µs: the event's own time (sync beep, logging resume) or the last main frame's */
  time: number;
  /** index of the main frame it precedes */
  frame: number;
  data: Record<string, number | string>;
}

export interface BblFrameStats { valid: number; corrupt: number; desync: number; bytes: number }

export interface BblStats {
  /** per frame marker (I, P, S, G, H, E) */
  frames: Record<string, BblFrameStats>;
  /** frames that did not end at a frame marker (the scan resynchronised after them) */
  corruptFrames: number;
  /** frames that decoded but were dropped: main frames out of sequence or waiting for an I frame, unknown events, GPS without home */
  desyncFrames: number;
  /** loop iterations deliberately not logged (P interval) */
  skippedIterations: number;
  /** the log closed with the "End of log" event */
  endOfLog: boolean;
  /** byte range of this log in the file */
  start: number; end: number;
}

export interface BblLog {
  index: number;
  headers: Record<string, string>;
  fields: { I?: BblFieldDef; P?: BblFieldDef; S?: BblFieldDef; G?: BblFieldDef; H?: BblFieldDef };
  sysConfig: BblSysConfig;
  /** main frames (I and P), in order */
  frameCount: number;
  /** every main-frame field by name (time in µs, loopIteration, gyroADC[0], motor[3], ...) */
  main: Record<string, Float64Array>;
  /** slow frames; `frame` = index of the main frame each one precedes */
  slow: Record<string, Float64Array>;
  /** GPS fixes (`frame` as for slow) and home positions; null when the log defines no GPS frames */
  gps: Record<string, Float64Array> | null;
  gpsHome: Record<string, Float64Array> | null;
  events: BblEvent[];
  stats: BblStats;
  /** problems that stopped or limited decoding (missing definitions, unsupported encodings) */
  errors: string[];
}

/** Decode every log in a blackbox file. */
export function decodeBbl(bytes: Uint8Array): BblLog[] {
  const starts = findAll(bytes, LOG_START);
  return starts.map((s, i) => decodeLog(bytes, s, i + 1 < starts.length ? starts[i + 1] : bytes.length, i));
}

function findAll(b: Uint8Array, needle: string): number[] {
  const n = Array.from(needle, (c) => c.charCodeAt(0)), out: number[] = [];
  outer: for (let i = b.indexOf(n[0]); i >= 0 && i <= b.length - n.length; i = b.indexOf(n[0], i + 1)) {
    for (let j = 1; j < n.length; j++) if (b[i + j] !== n[j]) continue outer;
    out.push(i);
    i += n.length - 1;
  }
  return out;
}

// ---- byte stream: reads past the end return 0 and set eof (the frame is then rejected) ----

class Stream {
  eof = false;
  constructor(public b: Uint8Array, public pos: number, public end: number) {}

  byte(): number {
    if (this.pos < this.end) return this.b[this.pos++];
    this.eof = true;
    return 0;
  }

  /** unsigned variable-byte (7 bits per byte, low first; at most 5 bytes for 32 bits) */
  unsignedVB(): number {
    let result = 0;
    for (let i = 0, shift = 0; i < 5; i++, shift += 7) {
      if (this.pos >= this.end) { this.eof = true; return 0; }
      const c = this.b[this.pos++];
      result |= (c & 0x7f) << shift;
      if (c < 128) return result >>> 0;
    }
    return 0; // too long: corrupt
  }

  /** zigzag-encoded signed variable-byte */
  signedVB(): number {
    const u = this.unsignedVB();
    return (u >>> 1) ^ -(u & 1);
  }

  /** TAG2_3S32: a 2-bit selector picks 2, 4 or 6 bits per value, or a per-value 8/16/24/32-bit size */
  tag2_3s32(out: Float64Array): void {
    let lead = this.byte();
    switch (lead >> 6) {
      case 0:
        out[0] = sx(lead >> 4, 2); out[1] = sx(lead >> 2, 2); out[2] = sx(lead, 2);
        break;
      case 1: {
        out[0] = sx(lead, 4);
        const b = this.byte();
        out[1] = sx(b >> 4, 4); out[2] = sx(b, 4);
        break;
      }
      case 2:
        out[0] = sx(lead, 6); out[1] = sx(this.byte(), 6); out[2] = sx(this.byte(), 6);
        break;
      default:
        for (let i = 0; i < 3; i++, lead >>= 2) out[i] = this.sizedInt(lead & 3);
    }
  }

  /**
   * TAG2_3SVARIABLE: like TAG2_3S32 but packed 2/2/2, 5/5/4 or 8/7/7 bits. Decoded from the writer's
   * bit layout (blackboxWriteTag2_3SVariable); Blackbox Explorer's reader of the 554/877 cases is wrong.
   */
  tag2_3sVariable(out: Float64Array): void {
    let lead = this.byte();
    switch (lead >> 6) {
      case 0:
        out[0] = sx(lead >> 4, 2); out[1] = sx(lead >> 2, 2); out[2] = sx(lead, 2);
        break;
      case 1: { // ss11 1112 2222 3333
        const b = this.byte();
        out[0] = sx(lead >> 1, 5); out[1] = sx(((lead & 1) << 4) | (b >> 4), 5); out[2] = sx(b, 4);
        break;
      }
      case 2: { // ss11 1111 1122 2222 2333 3333
        const b = this.byte(), c = this.byte();
        out[0] = sx(((lead & 0x3f) << 2) | (b >> 6), 8); out[1] = sx(((b & 0x3f) << 1) | (c >> 7), 7); out[2] = sx(c, 7);
        break;
      }
      default:
        for (let i = 0; i < 3; i++, lead >>= 2) out[i] = this.sizedInt(lead & 3);
    }
  }

  /** little-endian signed int of 1..4 bytes (size code 0..3) */
  private sizedInt(code: number): number {
    const b0 = this.byte();
    if (code === 0) return sx(b0, 8);
    const b1 = this.byte();
    if (code === 1) return sx(b0 | (b1 << 8), 16);
    const b2 = this.byte();
    if (code === 2) return sx(b0 | (b1 << 8) | (b2 << 16), 24);
    return b0 | (b1 << 8) | (b2 << 16) | (this.byte() << 24);
  }

  /** TAG8_4S16: a selector byte gives each of 4 values 0, 4, 8 or 16 bits; v2 packs nibbles, high first */
  tag8_4s16(out: Float64Array, version: number): void {
    let sel = this.byte();
    if (version < 2) {
      for (let i = 0; i < 4; i++, sel >>= 2) {
        switch (sel & 3) {
          case 0: out[i] = 0; break;
          case 1: { // two 4-bit values in one byte, low nibble first
            const c = this.byte();
            out[i] = sx(c, 4);
            if (++i < 4) out[i] = sx(c >> 4, 4);
            sel >>= 2;
            break;
          }
          case 2: out[i] = sx(this.byte(), 8); break;
          default: { const lo = this.byte(); out[i] = sx(lo | (this.byte() << 8), 16); }
        }
      }
      return;
    }
    let half = false, buf = 0;
    for (let i = 0; i < 4; i++, sel >>= 2) {
      switch (sel & 3) {
        case 0: out[i] = 0; break;
        case 1:
          if (!half) { buf = this.byte(); out[i] = sx(buf >> 4, 4); } else out[i] = sx(buf, 4);
          half = !half;
          break;
        case 2:
          if (!half) out[i] = sx(this.byte(), 8);
          else { const hi = buf << 4; buf = this.byte(); out[i] = sx(hi | (buf >> 4), 8); }
          break;
        default:
          if (!half) { const hi = this.byte(); out[i] = sx((hi << 8) | this.byte(), 16); } else {
            const c1 = this.byte(), c2 = this.byte();
            out[i] = sx(((buf & 0x0f) << 12) | (c1 << 4) | (c2 >> 4), 16);
            buf = c2;
          }
      }
    }
  }

  /** TAG8_8SVB: a bitmask byte of which of up to 8 values are non-zero, then those as signed VB (one value: no header) */
  tag8_8svb(out: Float64Array, count: number): void {
    if (count === 1) { out[0] = this.signedVB(); return; }
    const header = this.byte();
    for (let i = 0; i < count; i++) out[i] = header & (1 << i) ? this.signedVB() : 0;
  }
}

/** sign-extend the low `bits` bits */
function sx(v: number, bits: number): number {
  const s = 32 - bits;
  return ((v << s) >> s);
}

// ---- headers ----

function parseFirmware(rev: string): { type: string; version: [number, number, number] | null } {
  const m = /((?:Beta|Race|Clean|Base|Butter)flight)\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(rev) ?? /(INAV).*?\s(\d+)\.(\d+)(?:\.(\d+))?/i.exec(rev);
  if (!m) return { type: '', version: null };
  const type = /^(race|butter)flight$/i.test(m[1]) ? 'Betaflight' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return { type: type === 'Inav' ? 'INAV' : type, version: [+m[2], +m[3], m[4] ? +m[4] : 0] };
}

const int = (s: string | undefined, dflt: number) => { const v = s === undefined ? NaN : parseInt(s, 10); return Number.isFinite(v) ? v : dflt; };
const ints = (s: string | undefined) => (s ?? '').split(',').map((x) => parseInt(x, 10));

function hexFloat(s: string | undefined): number | null {
  if (!s) return null;
  const u = parseInt(s, 16);
  if (!Number.isFinite(u)) return null;
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, u >>> 0);
  return dv.getFloat32(0);
}

function sysConfigOf(h: Record<string, string>): BblSysConfig {
  const rev = h['Firmware revision'] ?? '';
  const fw = parseFirmware(rev);
  // older Cleanflight / Baseflight logs say which in "Firmware type" and have no revision
  if (!fw.type && h['Firmware type']) fw.type = h['Firmware type'] === 'Cleanflight' ? 'Cleanflight' : 'Baseflight';
  // "P interval": "num/denom" (older firmware) or Betaflight's "denom" (a P frame every denom iterations)
  const iInterval = Math.max(1, int(h['I interval'], 32));
  let pNum = 1, pDenom = 1;
  const pi = h['P interval'];
  if (pi !== undefined) {
    const k = pi.indexOf('/');
    if (k >= 0) { pNum = int(pi.slice(0, k), 1); pDenom = int(pi.slice(k + 1), 1); } else pDenom = int(pi, 1);
  }
  if (pDenom < 1) pDenom = iInterval; // P interval 0: only I frames
  pNum = Math.min(Math.max(1, pNum), pDenom);
  const minthrottle = int(h.minthrottle, 1150), maxthrottle = int(h.maxthrottle, 1850);
  const mo = ints(h.motorOutput);
  const cm = ints(h.currentSensor ?? h.currentMeter);
  const looptime = h.looptime !== undefined ? int(h.looptime, NaN) : NaN;
  const denom = int(h.pid_process_denom, 1);
  return {
    firmwareRevision: rev,
    firmwareType: fw.type,
    firmwareVersion: fw.version,
    dataVersion: int(h['Data version'], 1),
    frameIntervalI: iInterval,
    frameIntervalPNum: pNum, frameIntervalPDenom: pDenom,
    pRatio: h['P ratio'] !== undefined ? int(h['P ratio'], NaN) : null,
    looptime: Number.isFinite(looptime) ? looptime : null,
    pid_process_denom: denom,
    frameIntervalUs: Number.isFinite(looptime) ? (looptime * denom * pDenom) / pNum : null,
    blackbox_sample_rate: h.blackbox_sample_rate ?? null,
    minthrottle, maxthrottle,
    motorOutput: mo.length >= 2 && Number.isFinite(mo[0]) && Number.isFinite(mo[1]) ? [mo[0], mo[1]] : [minthrottle, maxthrottle],
    vbatscale: int(h.vbatscale ?? h.vbat_scale, 110),
    vbatref: int(h.vbatref, 4095),
    currentMeter: [Number.isFinite(cm[0]) ? cm[0] : 0, Number.isFinite(cm[1]) ? cm[1] : 400],
    acc_1G: int(h.acc_1G, 1),
    gyro_scale: hexFloat(h.gyro_scale ?? h['gyro.scale']) ?? 1,
    highResolution: int(h.blackbox_high_resolution, 0) > 0,
    motorPoles: h.motor_poles !== undefined ? int(h.motor_poles, NaN) : null,
    debugMode: h.debug_mode !== undefined ? int(h.debug_mode, NaN) : null,
  };
}

// ---- columns that grow geometrically ----

class Columns {
  n = 0;
  cols: Float64Array[];
  constructor(public names: string[], cap = 1024) { this.cols = names.map(() => new Float64Array(cap)); }

  push(row: ArrayLike<number>, extra?: number): void {
    const cols = this.cols, n = this.n;
    if (n === cols[0].length) for (let k = 0; k < cols.length; k++) { const c = new Float64Array(n * 2); c.set(cols[k]); cols[k] = c; }
    const m = row.length < cols.length ? row.length : cols.length;
    for (let k = 0; k < m; k++) cols[k][n] = row[k];
    if (extra !== undefined) cols[cols.length - 1][n] = extra;
    this.n = n + 1;
  }

  /** columns by name, trimmed to length (a copy only when much of the capacity is unused) */
  record(): Record<string, Float64Array> {
    const out: Record<string, Float64Array> = {};
    this.names.forEach((name, k) => { const c = this.cols[k]; out[name] = this.n * 4 >= c.length * 3 ? c.subarray(0, this.n) : c.slice(0, this.n); });
    return out;
  }
}

// ---- one log ----

interface FrameDef extends BblFieldDef {
  count: number;
  /** after prediction: 0 = wrap to int32, 1 = to uint32 */
  unsigned: Uint8Array;
}

function decodeLog(bytes: Uint8Array, start: number, end: number, index: number): BblLog {
  const headers: Record<string, string> = {};
  const raw: Record<string, Partial<BblFieldDef>> = {};
  const errors: string[] = [];
  const isMarker = (c: number) => c === 73 || c === 80 || c === 83 || c === 71 || c === 72 || c === 69; // I P S G H E

  // header lines until the first frame marker (garbage between them is skipped, as Explorer does)
  let pos = start;
  while (pos < end) {
    const c = bytes[pos];
    if (c === 72 && bytes[pos + 1] === 32) { // "H "
      let nl = pos + 2;
      const lim = Math.min(end, pos + 2 + 1024);
      while (nl < lim && bytes[nl] !== 10 && bytes[nl] !== 0) nl++;
      if (nl >= lim || bytes[nl] !== 10) { pos++; continue; } // not a complete header line
      const line = latin1(bytes, pos + 2, nl);
      const k = line.indexOf(':');
      if (k > 0) {
        const name = line.slice(0, k), value = line.slice(k + 1);
        headers[name] = value;
        const f = /^Field (.) (name|signed|predictor|encoding)$/.exec(name);
        if (f) {
          const d = (raw[f[1]] ??= {});
          if (f[2] === 'name') d.names = value.split(',').map((s) => s.replace(/^gyroData/, 'gyroADC'));
          else d[f[2] as 'signed' | 'predictor' | 'encoding'] = ints(value).map((x) => (Number.isFinite(x) ? x : -1));
        }
      }
      pos = nl + 1;
    } else if (isMarker(c)) break;
    else pos++;
  }
  const sc = sysConfigOf(headers);
  const dataStart = pos;

  // frame definitions; P frames share the I frame's names and signedness
  const defs: Partial<Record<'I' | 'P' | 'S' | 'G' | 'H', FrameDef>> = {};
  const fields: BblLog['fields'] = {};
  if (raw.P && raw.I) { raw.P.names = raw.I.names; raw.P.signed = raw.I.signed; }
  for (const t of ['I', 'P', 'S', 'G', 'H'] as const) {
    const r = raw[t];
    if (!r) continue;
    const names = r.names ?? [], count = names.length;
    const def: FrameDef = { names, signed: r.signed ?? [], predictor: (r.predictor ?? []).slice(), encoding: r.encoding ?? [], count, unsigned: new Uint8Array(count) };
    fields[t] = { names: def.names, signed: def.signed.slice(0, count), predictor: def.predictor.slice(0, count), encoding: def.encoding.slice(0, count) };
    if (!count || def.predictor.length < count || def.encoding.length < count) { errors.push(`incomplete definition of ${t} frames`); continue; }
    // signed fields wrap to int32, unsigned to uint32, except motors (logged unsigned but negative below
    // the minimum output: Blackbox Explorer shows them signed)
    for (let i = 0; i < count; i++) def.unsigned[i] = !def.signed[i] && !/^motor\[/.test(names[i]) ? 1 : 0;
    if (t === 'G') for (let i = 1; i < count; i++) if (def.predictor[i - 1] === PREDICTOR.HOME_COORD && def.predictor[i] === PREDICTOR.HOME_COORD) def.predictor[i] = PREDICTOR.HOME_COORD_1;
    defs[t] = def;
  }
  const I = defs.I, P = defs.P;
  if (!I) errors.push('no I frame definitions: header missing or corrupt');
  else if (!P) errors.push('no P frame definitions: header missing or corrupt');
  const mainNames = I?.names ?? [];
  const nMain = I?.count ?? 0;
  const tIdx = mainNames.indexOf('time'), itIdx = mainNames.indexOf('loopIteration');
  const motor0 = mainNames.indexOf('motor[0]');
  const homeIdx = [defs.H?.names.indexOf('GPS_home[0]') ?? -1, defs.H?.names.indexOf('GPS_home[1]') ?? -1];
  const gpsTimeIdx = defs.G?.names.indexOf('time') ?? -1;

  // decoder state
  const ring = [new Float64Array(nMain), new Float64Array(nMain), new Float64Array(nMain)];
  let ci = 0, prev: Float64Array | null = null, prev2: Float64Array | null = null;
  let mainValid = false;
  let lastIter = -1, lastTime = -1, rollover = 0, lastSkipped = 0;
  const slowRow = new Float64Array(defs.S?.count ?? 0), gpsRow = new Float64Array(defs.G?.count ?? 0);
  const homeRow = new Float64Array(defs.H?.count ?? 0), home = new Float64Array(defs.H?.count ?? 0);
  let homeValid = false;
  const vals = new Float64Array(8);
  let fatal = '';

  const main = new Columns(mainNames, 4096);
  const slow = new Columns([...(defs.S?.names ?? []), 'frame'], 64);
  const gps = defs.G ? new Columns([...defs.G.names, 'frame'], 256) : null;
  const gpsHome = defs.H ? new Columns([...defs.H.names, 'frame'], 16) : null;
  const events: BblEvent[] = [];
  const stats: BblStats = { frames: {}, corruptFrames: 0, desyncFrames: 0, skippedIterations: 0, endOfLog: false, start, end };

  const s = new Stream(bytes, dataStart, end);

  const shouldHaveFrame = (i: number) => ((i % sc.frameIntervalI) + sc.frameIntervalPNum - 1) % sc.frameIntervalPDenom < sc.frameIntervalPNum;
  /** iterations deliberately not logged between the last main frame and the next one */
  const skippedToNext = () => {
    if (lastIter < 0) return 0;
    let n = 0;
    for (let i = lastIter + 1; !shouldHaveFrame(i) && n < MAX_ITERATION_JUMP; i++) n++;
    return n;
  };
  const skippedTo = (target: number) => {
    if (lastIter < 0) return 0;
    let n = 0;
    for (let i = lastIter + 1; i < target && i < lastIter + MAX_ITERATION_JUMP; i++) if (!shouldHaveFrame(i)) n++;
    return n;
  };

  const predictOther = (def: FrameDef, pr: number, v: number, cur: Float64Array, p1: Float64Array | null, p2: Float64Array | null, i: number): number => {
    switch (pr) {
      case PREDICTOR.STRAIGHT_LINE: if (p1 && p2) v += 2 * p1[i] - p2[i]; break;
      case PREDICTOR.MINTHROTTLE: v += sc.minthrottle; break;
      case PREDICTOR.MOTOR_0:
        if (motor0 < 0 || (def !== I && def !== P)) { fatal = 'motor[0] predictor without a motor[0] field'; break; }
        v += cur[motor0];
        break;
      case PREDICTOR.HOME_COORD: case PREDICTOR.HOME_COORD_1: {
        const k = homeIdx[pr === PREDICTOR.HOME_COORD ? 0 : 1];
        if (k < 0) { fatal = 'GPS home predictor without GPS home frame definitions'; break; }
        v += home[k];
        break;
      }
      case PREDICTOR.P1500: v += 1500; break;
      case PREDICTOR.VBATREF: v += sc.vbatref; break;
      case PREDICTOR.LAST_MAIN_FRAME_TIME: if (prev && tIdx >= 0) v += prev[tIdx]; break;
      case PREDICTOR.MINMOTOR: v += sc.motorOutput[0]; break;
      default: fatal = `unsupported field predictor ${pr}`;
    }
    return v;
  };
  /** the field's value from its stored residual (the common predictors inline: this is the hot path) */
  const predict = (def: FrameDef, i: number, pr: number, v: number, cur: Float64Array, p1: Float64Array | null, p2: Float64Array | null): number => {
    if (pr === PREDICTOR.PREVIOUS) { if (p1) v += p1[i]; } else if (pr === PREDICTOR.AVERAGE_2) { if (p1 && p2) v += Math.trunc((p1[i] + p2[i]) / 2); } else if (pr !== PREDICTOR.ZERO) v = predictOther(def, pr, v, cur, p1, p2, i);
    return def.unsigned[i] ? v >>> 0 : v | 0;
  };

  /** decode one frame's fields into cur (false: an encoding or predictor this decoder can't handle) */
  const parseFrame = (def: FrameDef, cur: Float64Array, p1: Float64Array | null, p2: Float64Array | null, skipped: number): boolean => {
    const { predictor, encoding, count } = def;
    let i = 0;
    while (i < count) {
      const pr = predictor[i];
      if (pr === PREDICTOR.INC) {
        cur[i] = (skipped + 1 + (p1 ? p1[i] : 0)) >>> 0;
        i++;
        continue;
      }
      let v: number, group = 0;
      switch (encoding[i]) {
        case ENCODING.SIGNED_VB: v = s.signedVB(); break;
        case ENCODING.UNSIGNED_VB: v = s.unsignedVB(); break;
        case ENCODING.NEG_14BIT: v = -sx(s.unsignedVB(), 14); break;
        case ENCODING.NULL: v = 0; break;
        case ENCODING.TAG8_4S16: s.tag8_4s16(vals, sc.dataVersion); group = 4; break;
        case ENCODING.TAG2_3S32: s.tag2_3s32(vals); group = 3; break;
        case ENCODING.TAG2_3SVARIABLE: s.tag2_3sVariable(vals); group = 3; break;
        case ENCODING.TAG8_8SVB: {
          let j = i + 1;
          while (j < i + 8 && j < count && encoding[j] === ENCODING.TAG8_8SVB) j++;
          group = j - i;
          s.tag8_8svb(vals, group);
          break;
        }
        default:
          fatal = `unsupported field encoding ${encoding[i]}`;
          return false;
      }
      if (group) {
        for (let j = 0; j < group && i < count; j++, i++) cur[i] = predict(def, i, predictor[i], vals[j], cur, p1, p2);
      } else {
        cur[i] = predict(def, i, pr, v!, cur, p1, p2);
        i++;
      }
    }
    return !fatal;
  };

  const invalidate = () => { mainValid = false; prev = prev2 = null; };
  /** the 32-bit µs clock wraps every ~71.6 min: carry it (returns the carry, kept only if the frame is accepted) */
  const unwrapTime = (cur: Float64Array): number => {
    if (tIdx < 0) return rollover;
    const t = cur[tIdx] % 4294967296, last = lastTime % 4294967296;
    const carry = lastTime >= 0 && t < last && t - last + 4294967296 < MAX_TIME_JUMP ? rollover + 4294967296 : rollover;
    cur[tIdx] = t + carry;
    return carry;
  };
  const inSequence = (cur: Float64Array) => {
    const it = itIdx >= 0 ? cur[itIdx] : lastIter, t = tIdx >= 0 ? cur[tIdx] : lastTime;
    return it >= lastIter && it < lastIter + MAX_ITERATION_JUMP && t >= lastTime && t < lastTime + MAX_TIME_JUMP;
  };
  const acceptMain = (cur: Float64Array) => {
    lastIter = itIdx >= 0 ? cur[itIdx] : lastIter + 1;
    lastTime = tIdx >= 0 ? cur[tIdx] : lastTime;
    main.push(cur);
  };

  // frame type -> parse, complete (complete returns whether the frame was accepted)
  let curEvent: BblEvent | null = null;
  // (a frame that can't be decoded sets `fatal`: it then counts as corrupt)
  const parse = (m: number): void => {
    switch (m) {
      case 73: parseFrame(I!, ring[ci], prev, null, 0); break; // an I frame's PREVIOUS predictor uses the last frame
      case 80: lastSkipped = skippedToNext(); parseFrame(P!, ring[ci], prev, prev2, lastSkipped); break;
      case 83: parseFrame(defs.S!, slowRow, null, null, 0); break;
      case 71: parseFrame(defs.G!, gpsRow, null, null, 0); break;
      case 72: parseFrame(defs.H!, homeRow, null, null, 0); break;
      default: curEvent = parseEvent(s, lastTime, main.n, rollover);
    }
  };
  const complete = (m: number): boolean => {
    switch (m) {
      case 73: {
        const cur = ring[ci], carry = unwrapTime(cur);
        if (lastIter >= 0 && !inSequence(cur)) { invalidate(); return false; }
        rollover = carry;
        stats.skippedIterations += itIdx >= 0 ? skippedTo(cur[itIdx]) : 0;
        acceptMain(cur);
        mainValid = true;
        prev = prev2 = cur;
        ci = (ci + 1) % 3;
        return true;
      }
      case 80: {
        if (!mainValid) return false; // a P frame can't resynchronise the stream
        const cur = ring[ci], carry = unwrapTime(cur);
        if (!inSequence(cur)) { invalidate(); return false; }
        rollover = carry;
        stats.skippedIterations += lastSkipped;
        acceptMain(cur);
        prev2 = prev; prev = cur;
        ci = (ci + 1) % 3;
        return true;
      }
      case 83: slow.push(slowRow, main.n); return true;
      case 72: home.set(homeRow); homeValid = true; gpsHome!.push(homeRow, main.n); return true;
      case 71:
        if (!homeValid) return false; // coordinates are relative to home
        if (gpsTimeIdx >= 0) gpsRow[gpsTimeIdx] += rollover;
        gps!.push(gpsRow, main.n);
        return true;
      default: {
        const ev = curEvent;
        if (!ev) return false;
        // logging resumed after a pause: accept the jump in iteration and time
        if (ev.type === BBL_EVENT.LOGGING_RESUME) { lastIter = +ev.data.logIteration; lastTime = +ev.data.currentTime; }
        if (ev.type === BBL_EVENT.LOG_END) stats.endOfLog = true;
        events.push(ev);
        return true;
      }
    }
  };

  // frames: a frame counts once the byte after it is a frame marker or the end of the data
  let last = -1, frameStart = 0, prematureEof = false;
  if (I && P) {
    for (;;) {
      const atEnd = s.pos >= s.end;
      const cmd = atEnd ? -1 : bytes[s.pos++];
      if (last >= 0) {
        const size = s.pos - frameStart;
        const st = (stats.frames[String.fromCharCode(last)] ??= { valid: 0, corrupt: 0, desync: 0, bytes: 0 });
        if (size <= MAX_FRAME_LENGTH && !fatal && (isMarker(cmd) || (cmd < 0 && !prematureEof))) {
          if (complete(last)) { st.valid++; st.bytes += size - (cmd < 0 ? 0 : 1); } else { st.desync++; stats.desyncFrames++; }
        } else {
          // corrupt: resynchronise from the byte after its marker
          if (fatal && !errors.includes(fatal)) errors.push(fatal);
          st.corrupt++; stats.corruptFrames++;
          invalidate();
          s.pos = frameStart + 1; s.eof = false;
          last = -1; prematureEof = false; fatal = '';
          continue;
        }
      }
      if (cmd < 0 || stats.endOfLog) break;
      frameStart = s.pos - 1;
      const known = cmd === 69 || (cmd === 73 && I) || (cmd === 80 && P) || (cmd === 83 && defs.S) || (cmd === 71 && defs.G) || (cmd === 72 && defs.H);
      if (known) {
        last = cmd;
        parse(cmd);
        prematureEof = s.eof;
      } else {
        invalidate(); // a byte that isn't a frame we know: lost sync
        last = -1;
      }
    }
  }
  return {
    index, headers, fields, sysConfig: sc,
    frameCount: main.n,
    main: main.record(),
    slow: slow.record(),
    gps: gps?.record() ?? null,
    gpsHome: gpsHome?.record() ?? null,
    events, stats, errors,
  };
}

function latin1(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** Decode an event frame's payload (null: not an event we know, so probably garbage that looked like one). */
function parseEvent(s: Stream, lastTime: number, frame: number, rollover: number): BblEvent | null {
  const type = s.byte();
  const data: Record<string, number | string> = {};
  let time = lastTime;
  switch (type) {
    case BBL_EVENT.SYNC_BEEP: time = data.time = s.unsignedVB() + rollover; break;
    case BBL_EVENT.FLIGHT_MODE: data.flags = s.unsignedVB(); data.lastFlags = s.unsignedVB(); break;
    case BBL_EVENT.DISARM: data.reason = s.unsignedVB(); break;
    case BBL_EVENT.INFLIGHT_ADJUSTMENT: {
      const f = s.byte();
      data.func = f & 127;
      if (f < 128) data.value = s.signedVB();
      else { const dv = new DataView(new ArrayBuffer(4)); for (let i = 0; i < 4; i++) dv.setUint8(3 - i, s.byte()); data.value = dv.getFloat32(0); }
      break;
    }
    case BBL_EVENT.LOGGING_RESUME:
      data.logIteration = s.unsignedVB();
      time = data.currentTime = s.unsignedVB() + rollover;
      break;
    case BBL_EVENT.AUTOTUNE_CYCLE_START: {
      data.phase = s.byte();
      const c = s.byte();
      data.cycle = c & 0x7f; data.rising = (c >> 7) & 1;
      data.p = s.byte(); data.i = s.byte(); data.d = s.byte();
      break;
    }
    case BBL_EVENT.AUTOTUNE_CYCLE_RESULT: data.overshot = s.byte(); data.p = s.byte(); data.i = s.byte(); data.d = s.byte(); break;
    case BBL_EVENT.AUTOTUNE_TARGETS: {
      const s16 = () => { const lo = s.byte(); return sx(lo | (s.byte() << 8), 16); };
      data.currentAngle = s16() / 10; data.targetAngle = sx(s.byte(), 8); data.targetAngleAtPeak = sx(s.byte(), 8);
      data.firstPeakAngle = s16() / 10; data.secondPeakAngle = s16() / 10;
      break;
    }
    case BBL_EVENT.GTUNE_CYCLE_RESULT: { data.axis = s.byte(); data.gyroAVG = s.signedVB(); const lo = s.byte(); data.newP = sx(lo | (s.byte() << 8), 16); break; }
    case BBL_EVENT.TWITCH_TEST: {
      data.stage = s.byte();
      const dv = new DataView(new ArrayBuffer(4));
      for (let i = 0; i < 4; i++) dv.setUint8(3 - i, s.byte());
      data.value = dv.getFloat32(0);
      break;
    }
    case BBL_EVENT.LOG_END: {
      const msg = 'End of log\0';
      for (let i = 0; i < msg.length; i++) if (s.byte() !== msg.charCodeAt(i)) return null;
      s.end = s.pos; // this log is done
      break;
    }
    default: return null;
  }
  return { type, name: EVENT_NAME[type] ?? `EVENT_${type}`, time, frame, data };
}

// ---- physical units ----

export interface BblSeries {
  /** s since the first main frame */
  t: Float64Array;
  /** filtered gyro (gyroADC) and raw gyro (gyroUnfilt), deg/s, Betaflight axes (roll, pitch, yaw) */
  gyro: [Float64Array, Float64Array, Float64Array] | null;
  gyroUnfilt: [Float64Array, Float64Array, Float64Array] | null;
  /** rate setpoint fed to the PID controller, deg/s */
  setpoint: [Float64Array, Float64Array, Float64Array] | null;
  /** rcCommand: roll, pitch, yaw stick deflection (-500..500), throttle (µs, 1000..2000) */
  rcCommand: Float64Array[] | null;
  /** motor outputs normalised over the motorOutput range: 0 = low (idle), 1 = high */
  motor: Float64Array[];
  /** electrical RPM per motor (bidirectional DShot telemetry) */
  eRPM: Float64Array[] | null;
  /** battery voltage (V) and current (A) */
  vbat: Float64Array | null;
  amperage: Float64Array | null;
}

/** Convert a decoded log's main stream to physical units. */
export function bblSeries(log: BblLog): BblSeries {
  const sc = log.sysConfig, m = log.main, n = log.frameCount;
  const map = (src: Float64Array, f: (v: number) => number) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = f(src[i]); return o; };
  const axes = (base: string, f: (v: number) => number, k = 3) => {
    const out: Float64Array[] = [];
    for (let i = 0; i < k; i++) { const c = m[`${base}[${i}]`]; if (!c) return null; out.push(map(c, f)); }
    return out;
  };
  const series = (base: string) => Object.keys(m).filter((k) => k.startsWith(`${base}[`)).sort((a, b) => parseInt(a.slice(base.length + 1), 10) - parseInt(b.slice(base.length + 1), 10));
  const hr = sc.highResolution ? 10 : 1;
  // Baseflight's gyro_scale gives rad/µs per LSB; everything since gives deg/s
  const gyroK = (sc.firmwareType === 'Baseflight' ? (sc.gyro_scale * 1e6 * 180) / Math.PI : sc.gyro_scale) / hr;
  const time = m.time;
  const t0 = n ? time[0] : 0;
  const ver = sc.firmwareVersion ?? [0, 0, 0];
  const atLeast = (a: number, b: number, c = 0) => ver[0] > a || (ver[0] === a && (ver[1] > b || (ver[1] === b && ver[2] >= c)));
  const bf = sc.firmwareType === 'Betaflight', modern = sc.firmwareType === 'INAV' || (sc.firmwareType === 'Cleanflight' && atLeast(2, 0));
  // vbat: 0.01 V since Betaflight 4.0, 0.1 V from 3.1, else ADC counts; current: 0.01 A from 3.1, else ADC counts
  const vbatK = (bf && atLeast(4, 0)) || sc.firmwareType === 'INAV' ? 0.01 : (bf && atLeast(3, 1)) || modern ? 0.1 : null;
  const [lo, hi] = sc.motorOutput, span = hi - lo || 1;
  const rc = axes('rcCommand', (v) => v / hr, 3);
  if (rc && m['rcCommand[3]']) rc.push(map(m['rcCommand[3]'], (v) => v / hr));
  return {
    t: time ? map(time, (v) => (v - t0) / 1e6) : new Float64Array(n),
    gyro: axes('gyroADC', (v) => v * gyroK) as BblSeries['gyro'],
    gyroUnfilt: axes('gyroUnfilt', (v) => v * gyroK) as BblSeries['gyroUnfilt'],
    setpoint: axes('setpoint', (v) => v / hr) as BblSeries['setpoint'],
    rcCommand: rc,
    motor: series('motor').map((k) => map(m[k], (v) => (v - lo) / span)),
    // Betaflight logs eRPM / 100
    eRPM: m['eRPM[0]'] ? series('eRPM').map((k) => map(m[k], (v) => v * 100)) : null,
    vbat: m.vbatLatest ? map(m.vbatLatest, vbatK ? (v) => v * vbatK : (v) => (v * 330 * sc.vbatscale) / 4095 / 1000) : null,
    amperage: m.amperageLatest ? map(m.amperageLatest, (bf && atLeast(3, 1)) || modern ? (v) => v / 100 : (v) => (((v * 3300) / 4095 - sc.currentMeter[0]) * 10) / sc.currentMeter[1]) : null,
  };
}
