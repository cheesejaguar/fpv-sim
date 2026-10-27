// Blackbox log decoder (src/sysid/bblDecode.ts). Two sources of logs:
//   - synthetic logs written by a port of Betaflight's own writer (blackbox_encoding.c), covering
//     every encoding and predictor, GPS / slow / event frames, P-interval skipping and the 32-bit
//     clock wrapping, checked value for value (no firmware needed);
//   - a real log: Betaflight 4.5.5 (WASM) flown in the headless simulator, its serial blackbox
//     captured as an OpenLog would, checked against the simulator's own truth (body rates, motor
//     eRPM, battery), then truncated and corrupted. Skipped without the firmware build.
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { createNodeEnv } from '../src/headless/node';
import { BBL_EVENT, BblLog, bblSeries, decodeBbl, ENCODING as E, PREDICTOR as PR } from '../src/sysid/bblDecode';

const have = existsSync(new URL('../public/bf/betaflight.mjs', import.meta.url));
const LOG_START = 'H Product:Blackbox flight data recorder by Nicholas Sherlock\n';

// ---- a port of Betaflight's blackbox writer (blackbox_encoding.c) ----

class Writer {
  b: number[] = [];
  byte(v: number) { this.b.push(v & 0xff); }
  text(s: string) { for (const c of s) this.byte(c.charCodeAt(0)); }
  uvb(v: number) { v >>>= 0; while (v > 127) { this.byte(v | 0x80); v >>>= 7; } this.byte(v); }
  svb(v: number) { v |= 0; this.uvb((v << 1) ^ (v >> 31)); }
  private sized(v: number[]) {
    let sel2 = 0;
    for (let x = 2; x >= 0; x--) { sel2 <<= 2; sel2 |= v[x] < 128 && v[x] >= -128 ? 0 : v[x] < 32768 && v[x] >= -32768 ? 1 : v[x] < 8388608 && v[x] >= -8388608 ? 2 : 3; }
    this.byte((3 << 6) | sel2);
    for (let x = 0; x < 3; x++, sel2 >>= 2) for (let k = 0; k <= (sel2 & 3); k++) this.byte(v[x] >> (8 * k));
  }
  tag2_3s32(v: number[]) {
    let sel = 0;
    for (const x of v) {
      if (x >= 32 || x < -32) { sel = 3; break; }
      if (x >= 8 || x < -8) sel = Math.max(sel, 2); else if (x >= 2 || x < -2) sel = Math.max(sel, 1);
    }
    if (sel === 0) this.byte(((v[0] & 3) << 4) | ((v[1] & 3) << 2) | (v[2] & 3));
    else if (sel === 1) { this.byte((1 << 6) | (v[0] & 0x0f)); this.byte((v[1] << 4) | (v[2] & 0x0f)); }
    else if (sel === 2) { this.byte((2 << 6) | (v[0] & 0x3f)); this.byte(v[1]); this.byte(v[2]); }
    else this.sized(v);
  }
  tag2_3sVariable(v: number[]) {
    if (v[0] >= 256 || v[0] < -256 || v[1] >= 128 || v[1] < -128 || v[2] >= 128 || v[2] < -128) this.sized(v);
    else if (v[0] >= 16 || v[0] < -16 || v[1] >= 16 || v[1] < -16 || v[2] >= 8 || v[2] < -8) {
      this.byte((2 << 6) | ((v[0] & 0xff) >> 2)); this.byte(((v[0] & 3) << 6) | ((v[1] & 0x7f) >> 1)); this.byte(((v[1] & 1) << 7) | (v[2] & 0x7f));
    } else if (v[0] >= 2 || v[0] < -2 || v[1] >= 2 || v[1] < -2 || v[2] >= 2 || v[2] < -2) {
      this.byte((1 << 6) | ((v[0] & 0x1f) << 1) | ((v[1] & 0x1f) >> 4)); this.byte(((v[1] & 0x0f) << 4) | (v[2] & 0x0f));
    } else this.byte(((v[0] & 3) << 4) | ((v[1] & 3) << 2) | (v[2] & 3));
  }
  tag8_4s16(v: number[]) {
    let sel = 0;
    for (let x = 3; x >= 0; x--) { sel <<= 2; sel |= v[x] === 0 ? 0 : v[x] < 8 && v[x] >= -8 ? 1 : v[x] < 128 && v[x] >= -128 ? 2 : 3; }
    this.byte(sel);
    let half = false, buf = 0;
    for (let x = 0; x < 4; x++, sel >>= 2) {
      switch (sel & 3) {
        case 1: if (!half) { buf = v[x] << 4; half = true; } else { this.byte(buf | (v[x] & 0x0f)); half = false; } break;
        case 2: if (!half) this.byte(v[x]); else { this.byte(buf | ((v[x] >> 4) & 0x0f)); buf = v[x] << 4; } break;
        case 3: if (!half) { this.byte(v[x] >> 8); this.byte(v[x]); } else { this.byte(buf | ((v[x] >> 12) & 0x0f)); this.byte(v[x] >> 4); buf = v[x] << 4; } break;
      }
    }
    if (half) this.byte(buf);
  }
  /** data version 1 layout (Cleanflight): 4-bit values in pairs, low nibble first; 16-bit little-endian */
  tag8_4s16v1(v: number[]) {
    const size = (x: number) => (x === 0 ? 0 : x < 8 && x >= -8 ? 1 : x < 128 && x >= -128 ? 2 : 3);
    const s = v.map(size);
    for (const p of [0, 2]) if (s[p] && s[p] <= 1 && s[p + 1] <= 1) { s[p] = 1; s[p + 1] = 0; } else { if (s[p] === 1) s[p] = 2; if (s[p + 1] === 1) s[p + 1] = 2; }
    this.byte(s[0] | (s[1] << 2) | (s[2] << 4) | (s[3] << 6));
    for (let x = 0; x < 4; x++) {
      if (s[x] === 1) { this.byte((v[x] & 0x0f) | (v[x + 1] << 4)); x++; } else if (s[x] === 2) this.byte(v[x]); else if (s[x] === 3) { this.byte(v[x]); this.byte(v[x] >> 8); }
    }
  }
  tag8_8svb(v: number[]) {
    if (v.length === 1) { this.svb(v[0]); return; }
    let h = 0;
    for (let i = v.length - 1; i >= 0; i--) { h <<= 1; if (v[i] !== 0) h |= 1; }
    this.byte(h);
    for (const x of v) if (x !== 0) this.svb(x);
  }
}

interface FieldSpec { name: string; signed: 0 | 1; ip: number; ie: number; pp: number; pe: number }

interface Ctx { minthrottle: number; motorLow: number; vbatref: number; home: number[]; lastMainTime: number; dataVersion: number }

/** Write one frame's fields as Betaflight does: the residual against the predictor, in the field's encoding. */
function writeFields(w: Writer, names: string[], pred: number[], enc: number[], cur: number[], p1: number[] | null, p2: number[] | null, c: Ctx) {
  const resid = (i: number) => {
    const v = cur[i];
    switch (pred[i]) {
      case PR.ZERO: return v;
      case PR.PREVIOUS: return v - p1![i];
      case PR.STRAIGHT_LINE: return (v - (2 * p1![i] - p2![i])) | 0;
      case PR.AVERAGE_2: return v - Math.trunc((p1![i] + p2![i]) / 2);
      case PR.MINTHROTTLE: return v - c.minthrottle;
      case PR.MOTOR_0: return v - cur[names.indexOf('motor[0]')];
      case PR.HOME_COORD: return v - c.home[names[i].endsWith('[0]') ? 0 : 1];
      case PR.P1500: return v - 1500;
      case PR.VBATREF: return v - c.vbatref;
      case PR.LAST_MAIN_FRAME_TIME: return v - c.lastMainTime;
      case PR.MINMOTOR: return v - c.motorLow;
      default: throw new Error(`predictor ${pred[i]}`);
    }
  };
  for (let i = 0; i < names.length;) {
    if (pred[i] === PR.INC) { i++; continue; }
    const group = (n: number) => { const out: number[] = []; for (let k = 0; k < n; k++) out.push(resid(i + k)); i += n; return out; };
    switch (enc[i]) {
      case E.SIGNED_VB: w.svb(resid(i++)); break;
      case E.UNSIGNED_VB: w.uvb(resid(i++)); break;
      case E.NEG_14BIT: w.uvb(-resid(i++) & 0x3fff); break;
      case E.NULL: i++; break;
      case E.TAG8_4S16: { const g = group(4); if (c.dataVersion < 2) w.tag8_4s16v1(g); else w.tag8_4s16(g); break; }
      case E.TAG2_3S32: w.tag2_3s32(group(3)); break;
      case E.TAG2_3SVARIABLE: w.tag2_3sVariable(group(3)); break;
      case E.TAG8_8SVB: { let n = 1; while (n < 8 && i + n < names.length && enc[i + n] === E.TAG8_8SVB) n++; w.tag8_8svb(group(n)); break; }
      default: throw new Error(`encoding ${enc[i]}`);
    }
  }
}

function header(w: Writer, lines: [string, string | number][]) {
  w.text(LOG_START);
  for (const [k, v] of lines) w.text(`H ${k}:${v}\n`);
}
function fieldHeaders(t: string, specs: { name: string; signed: number; p: number; e: number }[], withSigned = true): [string, string][] {
  return [
    [`Field ${t} name`, specs.map((s) => s.name).join(',')],
    ...(withSigned ? [[`Field ${t} signed`, specs.map((s) => s.signed).join(',')] as [string, string]] : []),
    [`Field ${t} predictor`, specs.map((s) => s.p).join(',')],
    [`Field ${t} encoding`, specs.map((s) => s.e).join(',')],
  ];
}

// deterministic pseudo-random numbers
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

// Main fields: every encoding (in P frames) and every main-frame predictor (in I and P frames).
const MAIN: FieldSpec[] = [
  { name: 'loopIteration', signed: 0, ip: PR.ZERO, ie: E.UNSIGNED_VB, pp: PR.INC, pe: E.NULL },
  { name: 'time', signed: 0, ip: PR.ZERO, ie: E.UNSIGNED_VB, pp: PR.STRAIGHT_LINE, pe: E.SIGNED_VB },
  ...[0, 1, 2].map((k) => ({ name: `sv[${k}]`, signed: 1 as const, ip: PR.ZERO, ie: E.SIGNED_VB, pp: PR.PREVIOUS, pe: E.TAG2_3SVARIABLE })),
  ...[0, 1, 2, 3].map((k) => ({ name: `q[${k}]`, signed: 1 as const, ip: PR.ZERO, ie: E.SIGNED_VB, pp: PR.PREVIOUS, pe: E.TAG8_4S16 })),
  ...[0, 1, 2].map((k) => ({ name: `r[${k}]`, signed: 1 as const, ip: PR.ZERO, ie: E.SIGNED_VB, pp: PR.AVERAGE_2, pe: E.TAG2_3S32 })),
  ...[0, 1, 2, 3, 4].map((k) => ({ name: `v[${k}]`, signed: 1 as const, ip: PR.ZERO, ie: E.SIGNED_VB, pp: PR.PREVIOUS, pe: E.TAG8_8SVB })),
  { name: 'big', signed: 1, ip: PR.ZERO, ie: E.SIGNED_VB, pp: PR.STRAIGHT_LINE, pe: E.SIGNED_VB },
  { name: 'u', signed: 0, ip: PR.ZERO, ie: E.UNSIGNED_VB, pp: PR.PREVIOUS, pe: E.UNSIGNED_VB },
  { name: 'vbatLatest', signed: 0, ip: PR.VBATREF, ie: E.NEG_14BIT, pp: PR.PREVIOUS, pe: E.TAG8_8SVB },
  { name: 'thr', signed: 0, ip: PR.MINTHROTTLE, ie: E.UNSIGNED_VB, pp: PR.PREVIOUS, pe: E.SIGNED_VB },
  { name: 'servo[5]', signed: 0, ip: PR.P1500, ie: E.SIGNED_VB, pp: PR.PREVIOUS, pe: E.SIGNED_VB },
  { name: 'motor[0]', signed: 0, ip: PR.MINMOTOR, ie: E.UNSIGNED_VB, pp: PR.AVERAGE_2, pe: E.SIGNED_VB },
  { name: 'motor[1]', signed: 0, ip: PR.MOTOR_0, ie: E.SIGNED_VB, pp: PR.AVERAGE_2, pe: E.SIGNED_VB },
];
const SLOW = [{ name: 'flightModeFlags', signed: 0, p: 0, e: E.UNSIGNED_VB }, ...[0, 1, 2].map((k) => ({ name: `sx[${k}]`, signed: 1, p: 0, e: E.TAG2_3SVARIABLE }))];
const GPS = [
  { name: 'time', signed: 0, p: PR.LAST_MAIN_FRAME_TIME, e: E.UNSIGNED_VB },
  { name: 'GPS_numSat', signed: 0, p: 0, e: E.UNSIGNED_VB },
  { name: 'GPS_coord[0]', signed: 1, p: PR.HOME_COORD, e: E.SIGNED_VB },
  { name: 'GPS_coord[1]', signed: 1, p: PR.HOME_COORD, e: E.SIGNED_VB },
  { name: 'GPS_altitude', signed: 1, p: 0, e: E.SIGNED_VB },
];
const HOME = [{ name: 'GPS_home[0]', signed: 1, p: 0, e: E.SIGNED_VB }, { name: 'GPS_home[1]', signed: 1, p: 0, e: E.SIGNED_VB }];

/**
 * A synthetic log with known values: I frames every `iInterval` iterations, a P frame on every
 * iteration the P interval logs, residuals in every size class of every encoding. `t0` near 2^32
 * makes the firmware clock wrap.
 */
function synthLog(o: { seed: number; frames: number; dataVersion: number; iInterval: number; pInterval: string; t0: number; gps?: boolean; resumeAt?: number }) {
  const rnd = rng(o.seed), w = new Writer();
  const c: Ctx = { minthrottle: 1070, motorLow: 48, vbatref: 2519, home: [473977000, 85000000], lastMainTime: 0, dataVersion: o.dataVersion };
  const [num, denom] = o.pInterval.includes('/') ? o.pInterval.split('/').map(Number) : [1, Number(o.pInterval)];
  const logged = (it: number) => ((it % o.iInterval) + num - 1) % denom < num;
  header(w, [
    ['Data version', o.dataVersion],
    ...fieldHeaders('I', MAIN.map((f) => ({ name: f.name, signed: f.signed, p: f.ip, e: f.ie }))),
    ...fieldHeaders('P', MAIN.map((f) => ({ name: f.name, signed: f.signed, p: f.pp, e: f.pe })), false),
    ...fieldHeaders('S', SLOW),
    ...(o.gps ? [...fieldHeaders('H', HOME), ...fieldHeaders('G', GPS)] : []),
    ['Firmware type', 'Cleanflight'], ['Firmware revision', 'Betaflight 4.5.5 (test) SYNTH'],
    ['I interval', o.iInterval], ['P interval', o.pInterval], ['minthrottle', c.minthrottle], ['maxthrottle', 2000],
    ['gyro_scale', '0x3f800000'], ['motorOutput', `${c.motorLow},2047`], ['vbatref', c.vbatref], ['looptime', 125], ['pid_process_denom', 2],
  ]);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  // residual classes per encoding (TAG2_3SVARIABLE: the writer's 8/7/7-bit case only round-trips
  // values that fit its fields, so stay inside them)
  const RES: Record<number, number[]> = {
    [E.TAG2_3SVARIABLE]: [0, -2, 1, -16, 15, 7, -8, 60, -64, 1000, -70000, 9000000, -2000000000],
    [E.TAG8_4S16]: [0, 0, 3, -8, 7, 100, -128, 127, 20000, -32768, 32767],
    [E.TAG2_3S32]: [0, 1, -2, 5, -8, 30, -32, 120, -128, 30000, -32768, 8000000, -8388608, 300000000],
    [E.TAG8_8SVB]: [0, 0, 1, -1, 63, -64, 8191, -1000000],
    [E.SIGNED_VB]: [0, 1, -1, 63, -64, 8191, -8192, 1048575, -1048576, 268435455, -268435456],
    [E.UNSIGNED_VB]: [0, 1, 127, 16383, 2097151, 1000000],
  };
  const rows: number[][] = [], gpsRows: number[][] = [], homeRows: number[][] = [], slowRows: number[][] = [];
  const events: { type: number; frame: number; data: Record<string, number> }[] = [];
  let p1: number[] | null = null, p2: number[] | null = null, it = 0, t = o.t0;
  for (let n = 0; n < o.frames;) {
    if (!logged(it)) { it++; t += 125; continue; }
    const isI = it % o.iInterval === 0;
    if (o.resumeAt !== undefined && n === o.resumeAt) {
      // logging paused and resumed: a jump no frame-to-frame check would accept, announced by the event
      it += 100000 * o.iInterval; t += 60e6;
      w.byte(69); w.byte(BBL_EVENT.LOGGING_RESUME); w.uvb(it); w.uvb(t);
      events.push({ type: BBL_EVENT.LOGGING_RESUME, frame: n, data: { logIteration: it, currentTime: t } });
      p1 = p2 = null;
    }
    const iFrame = isI || !p1; // after a resume the writer starts with an I frame
    const row = MAIN.map((f, i) => {
      if (f.name === 'loopIteration') return it;
      if (f.name === 'time') return t + Math.floor(rnd() * 7); // loop jitter
      if (iFrame || !p1) {
        if (f.name === 'thr') return c.minthrottle + Math.floor(rnd() * 900) - 50;
        if (f.name === 'servo[5]') return 1000 + Math.floor(rnd() * 1000);
        if (f.name === 'vbatLatest') return 2400 + Math.floor(rnd() * 200);
        if (f.name.startsWith('motor')) return c.motorLow + Math.floor(rnd() * 2000) - 60; // below the minimum too
        if (f.name === 'u') return Math.floor(rnd() * 4e9);
        return Math.floor((rnd() - 0.5) * 2e6);
      }
      // P frame: pick the residual, the value follows from the predictor (kept inside 32 bits)
      const r = pick(RES[f.pe] ?? [0, 1, -1, 1000, -1000]);
      const base = f.pp === PR.PREVIOUS ? p1[i] : f.pp === PR.AVERAGE_2 ? Math.trunc((p1[i] + p2![i]) / 2) : 2 * p1[i] - p2![i];
      // stay inside 32 bits (a straight line can run away: clamp it, the residual then wraps as in C)
      const lo = f.signed ? -(2 ** 31) : 0, hi = f.signed ? 2 ** 31 - 1 : 2 ** 32 - 1;
      let v = base + r;
      if (v < lo || v > hi) v = f.pp === PR.STRAIGHT_LINE ? Math.max(lo, Math.min(hi, v)) : base - r;
      if (f.name.startsWith('motor') || f.name === 'thr' || f.name === 'servo[5]' || f.name === 'vbatLatest') v = Math.max(0, Math.min(5000, v));
      return v;
    });
    // written values are 32-bit: the clock wraps
    const written = row.slice();
    written[1] = row[1] % 2 ** 32;
    w.byte(iFrame ? 73 : 80);
    if (iFrame) writeFields(w, MAIN.map((f) => f.name), MAIN.map((f) => f.ip), MAIN.map((f) => f.ie), written, null, null, c);
    else writeFields(w, MAIN.map((f) => f.name), MAIN.map((f) => f.pp), MAIN.map((f) => f.pe), row, p1, p2, c);
    if (iFrame) { p1 = p2 = row; } else { p2 = p1; p1 = row; }
    rows.push(row);
    c.lastMainTime = row[1];
    n++; it++; t += 125;
    // slow, GPS and event frames between main frames
    if (n % 37 === 5) {
      const s = [Math.floor(rnd() * 1e6), pick([0, -2, 15, -128]), pick([1, -16, 63, -64, 1000]), pick([-8, 7, 60, -2000000])];
      w.byte(83); writeFields(w, SLOW.map((f) => f.name), SLOW.map((f) => f.p), SLOW.map((f) => f.e), s, null, null, c);
      slowRows.push([...s, n]);
    }
    if (o.gps && n % 50 === 10) {
      if (n % 200 === 10) {
        c.home = [c.home[0] + Math.floor(rnd() * 1000), c.home[1] - Math.floor(rnd() * 1000)];
        w.byte(72); writeFields(w, HOME.map((f) => f.name), HOME.map((f) => f.p), HOME.map((f) => f.e), c.home, null, null, c);
        homeRows.push([...c.home, n]);
      }
      const g = [c.lastMainTime + 37, 12, c.home[0] + Math.floor((rnd() - 0.5) * 5e4), c.home[1] + Math.floor((rnd() - 0.5) * 5e4), 1234];
      w.byte(71); writeFields(w, GPS.map((f) => f.name), GPS.map((f) => f.p), GPS.map((f) => f.e), g.map((x, i) => (i === 0 ? x % 2 ** 32 : x)), null, null, { ...c, lastMainTime: c.lastMainTime % 2 ** 32 });
      gpsRows.push([...g, n]);
    }
    if (n === 3) { w.byte(69); w.byte(BBL_EVENT.SYNC_BEEP); w.uvb(o.t0 - 1000); events.push({ type: BBL_EVENT.SYNC_BEEP, frame: n, data: { time: o.t0 - 1000 } }); }
    if (n === 20) { w.byte(69); w.byte(BBL_EVENT.FLIGHT_MODE); w.uvb(5); w.uvb(1); events.push({ type: BBL_EVENT.FLIGHT_MODE, frame: n, data: { flags: 5, lastFlags: 1 } }); }
    if (n === 21) { w.byte(69); w.byte(BBL_EVENT.INFLIGHT_ADJUSTMENT); w.byte(7); w.svb(-42); events.push({ type: BBL_EVENT.INFLIGHT_ADJUSTMENT, frame: n, data: { func: 7, value: -42 } }); }
    if (n === 22) {
      w.byte(69); w.byte(BBL_EVENT.INFLIGHT_ADJUSTMENT); w.byte(128 + 3);
      const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, 1.5, true); for (let k = 0; k < 4; k++) w.byte(dv.getUint8(k));
      events.push({ type: BBL_EVENT.INFLIGHT_ADJUSTMENT, frame: n, data: { func: 3, value: 1.5 } });
    }
  }
  w.byte(69); w.byte(BBL_EVENT.DISARM); w.uvb(4);
  w.byte(69); w.byte(BBL_EVENT.LOG_END); w.text('End of log\0');
  events.push({ type: BBL_EVENT.DISARM, frame: o.frames, data: { reason: 4 } }, { type: BBL_EVENT.LOG_END, frame: o.frames, data: {} });
  return { bytes: Uint8Array.from(w.b), rows, slowRows, gpsRows, homeRows, events };
}

const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

function expectColumns(rec: Record<string, Float64Array>, names: string[], rows: number[][]) {
  expect(rec[names[0]].length).toBe(rows.length);
  names.forEach((name, k) => expect(Array.from(rec[name]), name).toEqual(rows.map((r) => r[k])));
}

describe('synthetic logs from a port of Betaflight\'s writer', () => {
  const a = synthLog({ seed: 1, frames: 900, dataVersion: 2, iInterval: 32, pInterval: '1/2', t0: 2 ** 32 - 30000, gps: true });
  const b = synthLog({ seed: 2, frames: 400, dataVersion: 1, iInterval: 16, pInterval: '4', t0: 5_000_000, resumeAt: 150 });
  const logs = decodeBbl(cat(new Uint8Array([0, 1, 2, 3]), a.bytes, b.bytes)); // leading garbage, two logs

  test('every encoding and predictor decodes to the written values, across the clock wrap', () => {
    expect(logs).toHaveLength(2);
    const [la] = logs;
    expect(la.errors).toEqual([]);
    expect(la.stats.corruptFrames).toBe(0);
    expect(la.stats.desyncFrames).toBe(0);
    expect(la.stats.endOfLog).toBe(true);
    expect(la.frameCount).toBe(900);
    expectColumns(la.main, MAIN.map((f) => f.name), a.rows);
    expect(la.main.time[899]).toBeGreaterThan(2 ** 32); // unwrapped
    expect(la.sysConfig.dataVersion).toBe(2);
    expect(la.sysConfig.frameIntervalPNum).toBe(1);
    expect(la.sysConfig.frameIntervalPDenom).toBe(2);
    expect(la.sysConfig.frameIntervalUs).toBe(125 * 2 * 2);
    // INC: one iteration skipped between logged frames
    expect(la.main.loopIteration[1] - la.main.loopIteration[0]).toBe(2);
    expect(la.stats.skippedIterations).toBe(899);
    // motors below the minimum output stay negative relative to it (signed, like Blackbox Explorer)
    expect(Math.min(...la.main['motor[0]'])).toBeLessThan(48);
    expect(la.fields.P?.names).toEqual(la.fields.I?.names);
  });

  test('slow, GPS home, GPS (home and last-main-time predictors) and event frames', () => {
    const [la] = logs;
    expectColumns(la.slow, [...SLOW.map((f) => f.name), 'frame'], a.slowRows);
    expectColumns(la.gpsHome!, ['GPS_home[0]', 'GPS_home[1]', 'frame'], a.homeRows);
    expectColumns(la.gps!, [...GPS.map((f) => f.name), 'frame'], a.gpsRows);
    expect(la.events.map((e) => ({ type: e.type, frame: e.frame, data: e.data }))).toEqual(a.events);
    expect(la.events.map((e) => e.name)).toEqual(['SYNC_BEEP', 'FLIGHT_MODE', 'INFLIGHT_ADJUSTMENT', 'INFLIGHT_ADJUSTMENT', 'DISARM', 'LOG_END']);
    expect(la.events[0].time).toBe(2 ** 32 - 31000);
  });

  test('data version 1, Betaflight-style P interval, logging resume', () => {
    const lb = logs[1];
    expect(lb.errors).toEqual([]);
    expect(lb.stats.corruptFrames).toBe(0);
    expect(lb.sysConfig.dataVersion).toBe(1);
    expect(lb.sysConfig.frameIntervalPDenom).toBe(4);
    expectColumns(lb.main, MAIN.map((f) => f.name), b.rows);
    expect(lb.main.loopIteration[1] - lb.main.loopIteration[0]).toBe(4);
    expect(lb.events.map((e) => e.type)).toEqual(b.events.map((e) => e.type));
    // without the resume event the jump would be rejected
    expect(lb.main.time[150] - lb.main.time[149]).toBeGreaterThan(59e6);
  });

  test('a log with missing definitions or an unknown encoding is reported, not thrown', () => {
    const w = new Writer();
    header(w, [['Data version', 2], ['Field I name', 'loopIteration,time'], ['Field I predictor', '0,0'], ['Field I encoding', '1,42'], ['Field P predictor', '6,2'], ['Field P encoding', '9,0']]);
    w.byte(73); w.uvb(0); w.uvb(1000); w.byte(73);
    const [bad] = decodeBbl(Uint8Array.from(w.b));
    expect(bad.frameCount).toBe(0);
    expect(bad.errors.join()).toMatch(/unsupported field encoding 42/);
    const [none] = decodeBbl(new TextEncoder().encode(`${LOG_START}H Data version:2\nIPPP`));
    expect(none.errors.join()).toMatch(/no I frame definitions/);
    expect(decodeBbl(new Uint8Array(0))).toEqual([]);
  });

  test('truncated at every byte: never throws, frames decoded are a prefix of the full decode', () => {
    const full = logs[0];
    for (let cut = 1; cut < a.bytes.length; cut += 97) {
      const [l] = decodeBbl(a.bytes.subarray(0, cut));
      if (!l || !l.frameCount) continue; // cut inside the header
      expect(l.stats.endOfLog).toBe(false);
      const n = l.frameCount;
      expect(Array.from(l.main.time)).toEqual(Array.from(full.main.time.subarray(0, n)));
    }
  });
});

// ---- the real thing: Betaflight 4.5.5 flown in the simulator ----

interface Capture {
  bytes: Uint8Array;
  /** at every physics step: firmware time (s), true body rates (FLU, rad/s), motor eRPM, battery volts */
  fcT: Float64Array; w: Float64Array[]; erpm: Float64Array[]; volts: Float64Array;
  /** firmware time of each arming */
  armedAt: number[];
}

/** Two armed sessions: stick sines at two throttle levels, disarm, respawn, a short second flight. */
async function fly(): Promise<Capture> {
  const env = await createNodeEnv();
  await env.reset({ scenario: { format: 'fpvsim-scenario', version: 1, seed: 7, map: { id: 'field' }, drone: { preset: '5" Freestyle 6S' }, start: { armed: false, mode: 'acro' }, episode: { maxSeconds: 60, controlHz: 100 } } });
  const core = env.core, quad = core.quad;
  const chunks: Uint8Array[] = [];
  core.hooks.blackbox = (b) => { if (b.length) chunks.push(b.slice()); };
  const fcT: number[] = [], w: number[][] = [[], [], []], erpm: number[][] = [[], [], [], []], volts: number[] = [], armedAt: number[] = [];
  let was = false;
  core.hooks.afterFirmware = () => {
    fcT.push(core.fcT);
    w[0].push(quad.s.w.x); w[1].push(quad.s.w.y); w[2].push(quad.s.w.z);
    for (let k = 0; k < 4; k++) erpm[k].push(quad.motors[k].erpm());
    volts.push(quad.battery.s.voltage);
    if (core.armed && !was) armedAt.push(core.fcT);
    was = core.armed;
  };
  const sticks = (t: number) => ({ roll: 0.3 * Math.sin(t * 5), pitch: 0.2 * Math.sin(t * 3), yaw: 0.2 * Math.cos(t * 4) });
  for (let i = 0; i < 20; i++) env.step({ arm: false, throttle: 0 });
  for (let i = 0; i < 320; i++) {
    const t = i / 100;
    env.step({ arm: true, throttle: t < 0.3 ? 0 : t < 1.5 ? 0.35 : t < 2.7 ? 0.55 : 0.35, ...sticks(t) });
  }
  for (let i = 0; i < 50; i++) env.step({ arm: false, throttle: 0 }); // Betaflight writes the log end
  // second session: back on the pad, wait until Betaflight allows arming, flip the switch again
  core.respawn();
  for (let i = 0; i < 400 && env.step({ arm: false, throttle: 0 }).obs.armingFlags.length; i++);
  for (let i = 0; i < 130; i++) env.step({ arm: true, throttle: i < 30 ? 0 : 0.4, ...sticks(i / 100) });
  for (let i = 0; i < 50; i++) env.step({ arm: false, throttle: 0 });
  const f = (a: number[]) => Float64Array.from(a);
  return { bytes: cat(...chunks), fcT: f(fcT), w: w.map(f), erpm: erpm.map(f), volts: f(volts), armedAt };
}

/** Value of a per-physics-step series at firmware time t (s). */
function at(cap: Capture, s: Float64Array, t: number): number {
  const ft = cap.fcT;
  let lo = 0, hi = ft.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ft[m] <= t) lo = m; else hi = m; }
  return s[lo];
}

/**
 * The firmware's clock (the log's time) and the simulator's fcT differ by a constant. The first
 * frame is logged after the header went out, so it lies a little after arming: search that window
 * for the offset where the logged gyro best matches the true body rates.
 */
function gyroFit(cap: Capture, log: BblLog, from = 0, to = log.frameCount, range?: [number, number]) {
  const g = bblSeries(log).gyro!, time = log.main.time;
  const off0 = cap.armedAt[0] - time[0] / 1e6;
  const [a, b] = range ?? [off0, off0 + 0.5];
  const err = (off: number, step: number) => {
    let e = 0, n = 0, max = 0;
    for (let i = from; i < to; i += step) {
      const t = time[i] / 1e6 + off;
      for (let k = 0; k < 3; k++) { const d = g[k][i] - (at(cap, cap.w[k], t) * 180) / Math.PI; e += d * d; n++; max = Math.max(max, Math.abs(d)); }
    }
    return { rms: Math.sqrt(e / n), max };
  };
  let best = { off: a, rms: Infinity };
  for (let off = a; off <= b; off += 1 / 8000) { const r = err(off, 8).rms; if (r < best.rms) best = { off, rms: r }; }
  return { off: best.off, ...err(best.off, 1) };
}

describe.skipIf(!have)('a real Betaflight 4.5.5 log from the simulator', () => {
  let cap: Capture, logs: BblLog[];
  beforeAll(async () => {
    cap = await fly();
    logs = decodeBbl(cap.bytes);
  }, 120000);

  test('header: firmware, field definitions, loop timing', () => {
    expect(logs).toHaveLength(2);
    const l = logs[0], sc = l.sysConfig;
    expect(l.errors).toEqual([]);
    expect(l.headers['Firmware revision']).toMatch(/^Betaflight 4\.5\.5 /);
    expect(sc.firmwareType).toBe('Betaflight');
    expect(sc.firmwareVersion).toEqual([4, 5, 5]);
    expect(sc.dataVersion).toBe(2);
    expect(sc.looptime).toBe(125); // 8 kHz gyro
    expect(sc.pid_process_denom).toBeGreaterThanOrEqual(1);
    expect(sc.frameIntervalPNum).toBe(1);
    expect(sc.frameIntervalPDenom).toBe(4); // blackbox_sample_rate = 1/4
    expect(sc.pRatio).toBe(sc.frameIntervalI / sc.frameIntervalPDenom);
    expect(sc.gyro_scale).toBe(1);
    expect(sc.acc_1G).toBeGreaterThan(0);
    expect(sc.motorOutput[1]).toBe(2047); // DShot
    const I = l.fields.I!;
    for (const name of ['loopIteration', 'time', 'gyroADC[0]', 'gyroADC[2]', 'setpoint[0]', 'rcCommand[3]', 'motor[0]', 'motor[3]', 'eRPM[0]', 'vbatLatest']) expect(I.names).toContain(name);
    expect(I.predictor).toHaveLength(I.names.length);
    expect(l.fields.P!.encoding).toHaveLength(I.names.length);
    expect(l.fields.S!.names).toContain('flightModeFlags');
  });

  test('frames: none corrupt, time strictly increasing at looptime x pid denom x P interval', () => {
    for (const l of logs) {
      const sc = l.sysConfig, n = l.frameCount, { time, loopIteration } = l.main;
      expect(l.stats.corruptFrames).toBe(0);
      expect(l.stats.endOfLog).toBe(true);
      expect(n).toBeGreaterThan(1500);
      let bad = 0;
      for (let i = 1; i < n; i++) if (!(time[i] > time[i - 1]) || loopIteration[i] - loopIteration[i - 1] !== sc.frameIntervalPDenom) bad++;
      expect(bad).toBe(0);
      // every logged iteration is there: the duration is (frames - 1) intervals, within loop jitter
      const dt = (time[n - 1] - time[0]) / (n - 1);
      expect(Math.abs(dt - sc.frameIntervalUs!)).toBeLessThan(0.02 * sc.frameIntervalUs!);
      // an I frame every I interval: P ratio main frames
      expect(Math.abs(l.stats.frames.I.valid - n / sc.pRatio!)).toBeLessThanOrEqual(1);
      expect(l.stats.frames.P.valid + l.stats.frames.I.valid).toBe(n);
      const names = l.events.map((e) => e.name);
      expect(names).toContain('DISARM');
      expect(names[names.length - 1]).toBe('LOG_END');
    }
  });

  test('the logged gyro matches the simulator\'s true body rates', () => {
    const l = logs[0], g = bblSeries(l).gyro!;
    const peak = Math.max(...g.map((a) => Math.max(...a.map(Math.abs))));
    expect(peak).toBeGreaterThan(60); // the sticks moved it
    const fit = gyroFit(cap, l);
    // Betaflight's axes: roll right, pitch nose down, yaw nose left positive = FLU (x, y, z)
    expect(fit.rms).toBeLessThan(3);
    expect(fit.max).toBeLessThan(20);
    // the clocks run at the same rate: both halves give the same offset
    const half = l.frameCount >> 1;
    const r: [number, number] = [fit.off - 0.005, fit.off + 0.005];
    const a = gyroFit(cap, l, 0, half, r), b = gyroFit(cap, l, half, l.frameCount, r);
    expect(Math.abs(a.off - b.off)).toBeLessThan(0.0006);
    // second session on the same clock
    expect(logs[1].main.time[0]).toBeGreaterThan(l.main.time[l.frameCount - 1]);
    expect(logs[1].main.loopIteration[0]).toBe(0);
    const fit2 = gyroFit(cap, logs[1], 0, logs[1].frameCount, r);
    expect(fit2.rms).toBeLessThan(3);
  });

  test('motors in range and following throttle; eRPM and battery match the plant', () => {
    const l = logs[0], s = bblSeries(l), n = l.frameCount;
    const off = gyroFit(cap, l).off;
    // throttle plateaus (rcCommand[3] is after Betaflight's throttle curve): 0.55 at the top, 0.35 below
    const top = Math.max(...s.rcCommand![3]);
    let lo = 0, nlo = 0, hi = 0, nhi = 0;
    expect(Math.min(...s.motor.map((m) => Math.min(...m)))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...s.motor.map((m) => Math.max(...m)))).toBeLessThanOrEqual(1);
    for (let i = 0; i < n; i++) {
      const mean = s.motor.reduce((a, m) => a + m[i], 0) / 4;
      const thr = s.rcCommand![3][i];
      if (thr > 1100 && thr < top - 60) { lo += mean; nlo++; }
      if (thr > top - 10) { hi += mean; nhi++; }
    }
    expect(nlo).toBeGreaterThan(500);
    expect(nhi).toBeGreaterThan(500);
    expect(hi / nhi).toBeGreaterThan(lo / nlo + 0.08);
    // eRPM (bidirectional DShot telemetry, logged / 100) against the motor model, motor for motor
    const rel: number[] = [];
    for (let i = 0; i < n; i += 10) for (let k = 0; k < 4; k++) {
      const truth = at(cap, cap.erpm[k], l.main.time[i] / 1e6 + off);
      if (truth > 20000) rel.push(Math.abs(s.eRPM![k][i] / truth - 1));
    }
    rel.sort((a, b) => a - b);
    expect(rel.length).toBeGreaterThan(1000);
    expect(rel[rel.length >> 1]).toBeLessThan(0.03);
    // battery voltage (0.01 V since 4.0; Betaflight samples its ADC at its own rate, so the sag
    // transients of a throttle step differ for a moment) and current
    const dv: number[] = [];
    for (let i = 0; i < n; i += 10) dv.push(Math.abs(s.vbat![i] - at(cap, cap.volts, l.main.time[i] / 1e6 + off)));
    dv.sort((a, b) => a - b);
    expect(dv[dv.length >> 1]).toBeLessThan(0.05);
    expect(Math.max(...s.amperage!)).toBeGreaterThan(5);
  });

  test('a truncated copy decodes up to the cut; the log end lost is reported', () => {
    const full = logs[0], { start, end } = full.stats;
    // cut in the middle of the data: a prefix of the frames, no end-of-log
    const [mid] = decodeBbl(cap.bytes.subarray(start, (start + end) >> 1));
    expect(mid.stats.endOfLog).toBe(false);
    expect(mid.frameCount).toBeGreaterThan(full.frameCount * 0.4);
    expect(mid.frameCount).toBeLessThan(full.frameCount * 0.6);
    for (const k of ['time', 'gyroADC[0]', 'motor[3]', 'eRPM[2]']) expect(Array.from(mid.main[k])).toEqual(Array.from(full.main[k].subarray(0, mid.frameCount)));
    // cut inside the final "End of log" event: every frame, the truncated event counted as corrupt
    const [tail] = decodeBbl(cap.bytes.subarray(start, end - 5));
    expect(tail.stats.endOfLog).toBe(false);
    expect(tail.stats.corruptFrames).toBeGreaterThanOrEqual(1);
    expect(tail.frameCount).toBe(full.frameCount);
    expect(tail.events.map((e) => e.name)).not.toContain('LOG_END');
  });

  test('a corrupted byte: reported, the stream resynchronises at the next I frame', () => {
    const full = logs[0], { start, end } = full.stats, sc = full.sysConfig;
    const copy = cap.bytes.slice(start, end);
    // find the marker of an I frame in the middle ('I', loopIteration, time as unsigned VB) and break it
    const k = full.main.loopIteration.findIndex((it, i) => i > full.frameCount / 2 && it % sc.frameIntervalI === 0);
    const w = new Writer(); w.byte(73); w.uvb(full.main.loopIteration[k]); w.uvb(full.main.time[k]);
    const at0 = indexOf(copy, w.b);
    expect(at0).toBeGreaterThan(0);
    copy[at0] = 0;
    const [l] = decodeBbl(copy);
    expect(l.stats.corruptFrames).toBeGreaterThanOrEqual(1);
    // lost: the broken I frame and the P frames that depended on it, until the next I frame
    const lost = full.frameCount - l.frameCount;
    expect(lost).toBeGreaterThanOrEqual(1);
    expect(lost).toBeLessThanOrEqual(sc.pRatio! + 1);
    const tNext = full.main.time[k + sc.pRatio!];
    const j0 = l.main.time.indexOf(tNext), i0 = k + sc.pRatio!;
    expect(j0).toBeGreaterThan(0);
    for (const f of ['time', 'gyroADC[1]', 'setpoint[2]', 'motor[0]', 'vbatLatest']) expect(Array.from(l.main[f].subarray(j0))).toEqual(Array.from(full.main[f].subarray(i0)));
    // frames before the damage are untouched
    expect(Array.from(l.main.time.subarray(0, k - 1))).toEqual(Array.from(full.main.time.subarray(0, k - 1)));
  });

  test('any single flipped byte: never throws, reported, most frames survive, time stays monotonic', () => {
    const full = logs[0], { start, end } = full.stats;
    const data0 = start + indexOf(cap.bytes.subarray(start, end), [10, 73]) + 1; // first frame after the header
    let reported = 0;
    const kept: number[] = [];
    for (let p = data0 + 1000; p < end - 100; p += Math.floor((end - data0) / 61)) {
      const copy = cap.bytes.slice(start, end);
      copy[p - start] ^= 0x5a;
      const [l] = decodeBbl(copy);
      if (l.stats.corruptFrames + l.stats.desyncFrames > 0) reported++;
      kept.push(l.frameCount / full.frameCount);
      for (let i = 1; i < l.frameCount; i++) if (!(l.main.time[i] > l.main.time[i - 1])) throw new Error(`time not increasing at ${i} (flip at ${p})`);
    }
    expect(reported).toBeGreaterThan(kept.length * 0.8);
    // usually only the frames up to the next I frame are lost; a flip in a time field that pushes the
    // clock ahead loses the frames until real time catches up (as with blackbox-tools)
    kept.sort((a, b) => a - b);
    expect(kept[kept.length >> 1]).toBeGreaterThan(0.97);
    expect(kept.filter((k) => k < 0.9).length).toBeLessThanOrEqual(kept.length * 0.1);
  });

  test('decodes fast: 100 sessions back to back', () => {
    const big = cat(...Array.from({ length: 100 }, () => cap.bytes.subarray(logs[0].stats.start, logs[0].stats.end)));
    const t0 = performance.now();
    const all = decodeBbl(big);
    const ms = performance.now() - t0;
    const frames = all.reduce((a, l) => a + l.frameCount, 0);
    console.log(`decoded ${frames} frames (${(big.length / 1e6).toFixed(1)} MB) in ${ms.toFixed(0)} ms`);
    expect(all).toHaveLength(100);
    expect(frames).toBe(100 * logs[0].frameCount);
    expect(ms).toBeLessThan(15000);
  }, 60000);
});

function indexOf(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
