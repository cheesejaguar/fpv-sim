// Lap replays, recording side: every frame, the worker's 1 kHz state ring (pose, motors, the RC
// channels Betaflight got, battery) is sampled at RATE Hz into a buffer, and Betaflight's OSD grid
// is kept as a list of changes. When race.ts completes a lap, the samples from just before gate 0
// to just after the finish become a .fpvreplay (server/src/replayFormat.ts): ~1 s of post-roll is
// waited for, then it is encoded and compressed off the frame. Only what a lap in progress (or one
// waiting to be encoded) needs is kept, so flying without gates holds a few seconds at most.
import { MAX_REPLAY_BYTES, COLUMNS, continuousQuats, encodeReplay, GatePass, OSD_CELLS, OSD_STRIDE, OsdFrame, REPLAY_VERSION, ReplayHeader } from '../../server/src/replayFormat';
import { newestTime, R, REC, RING_N, RING_DT, sampleRing, Shared } from '../worker/shared';

/** Samples per second. 100 Hz: a 60 s lap is ~40-60 KB; the player interpolates between samples. */
export const RATE = 100;
/** Seconds kept before gate 0 and after the finish (the approach and the exit, for the player). */
export const PRE_S = 1, POST_S = 1;
/** A lap whose post-roll doesn't arrive (sim paused) is encoded after this long anyway (ms of wall time). */
const POST_WAIT_MS = 2500;
const MAX_SAMPLES = Math.ceil((600 + PRE_S + POST_S + 5) * RATE);

// ring field of each recorded column (modes come from the telemetry, not the ring)
const SRC: Record<string, number> = {
  px: R.px, py: R.py, pz: R.pz, qw: R.qw, qx: R.qx, qy: R.qy, qz: R.qz,
  rpm0: R.rpm0, rpm1: R.rpm1, rpm2: R.rpm2, rpm3: R.rpm3, rc0: R.rc0, rc1: R.rc1, rc2: R.rc2, rc3: R.rc3,
  vbus: R.vbus, ibus: R.ibus, mah: R.mah, armed: R.armed, vrs: R.vrs,
};
const NC = COLUMNS.length;
const MODES = COLUMNS.findIndex((c) => c.id === 'modes');
/** ring field of column c (resolved once, not by name for every sample) */
const COL_SRC = Int32Array.from(COLUMNS, (c) => SRC[c.id] ?? -1);

/** What the header needs besides the samples (filled in by race.ts from the lap and the session). */
export type LapMeta = Omit<ReplayHeader, 'v' | 'rate' | 'n' | 't0' | 'cols' | 'osd' | 'gates'>;
/** A completed lap: sim time of its start through gate 0, gate passes (lap time, s) from the start to the finish. */
export interface LapDone { start: number; gates: GatePass[]; meta: LapMeta }

interface Pending { lap: LapDone; end: number; wall: number; done: (b: Uint8Array | null) => void }

/** Run f when the main thread is idle (after the frame being drawn), at the latest after timeoutMs. */
function whenIdle(f: () => void, timeoutMs = 1000) {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(f, { timeout: timeoutMs }); else setTimeout(f, 0);
}

export class LapRecorder {
  private cap = 0;
  private cols: Float64Array[] = [];
  /** global sample index k is sim time k / RATE; held: [first, next) */
  private first = 0;
  private next = -1;
  private rec = new Float64Array(REC);
  /** OSD: the grid as of `osdBase.ms` (full), then changes since */
  private osdBase = { t: -Infinity, cols: 30, rows: 16, ch: new Uint8Array(OSD_CELLS).fill(0x20), attr: new Uint8Array(OSD_CELLS) };
  private osdFrames: { t: number; cols: number; rows: number; idx: Uint16Array; ch: Uint8Array; attr: Uint8Array }[] = [];
  private osdSeen = { seq: -1, ch: new Uint8Array(OSD_CELLS).fill(0x20), attr: new Uint8Array(OSD_CELLS), cols: 30, rows: 16 };
  private pending: Pending[] = [];
  /** laps whose post-roll is in, waiting for an idle moment to be copied out and encoded */
  private finishing: Pending[] = [];
  /** The newest completed lap's replay (counted or not), for "Replay last lap". */
  last: { lap: LapDone; replay: Promise<Uint8Array | null> } | null = null;
  /** Record Betaflight's OSD grid (on by default). */
  osd = true;

  /** Samples held right now (tests, debugging). */
  get held() { return this.next < 0 ? 0 : this.next - this.first; }

  /**
   * Pull new ring samples; call every frame. keepFrom: sim time of the oldest sample still needed
   * (the lap in progress' start minus the pre-roll), or null when no lap is running. modes:
   * Betaflight's flight mode flags now.
   */
  pump(sh: Shared, keepFrom: number | null, modes = 0, now = performance.now()) {
    const head = newestTime(sh);
    if (head > 0) {
      const span = (RING_N - 8) * RING_DT;
      // first call, a stall longer than the ring holds, or a restarted clock: start over from what the ring has
      if (this.next < 0 || head * RATE - this.next > span * RATE || this.next / RATE > head + 1) {
        this.next = this.first = Math.ceil((head - span) * RATE);
        this.osdFrames = [];
        for (const p of this.pending.splice(0)) p.done(null); // their samples are gone
      }
      for (; this.next / RATE <= head; this.next++) {
        if (!sampleRing(sh, this.next / RATE, this.rec)) break;
        this.store(this.next, modes);
      }
      if (this.osd) this.pumpOsd(sh, head);
    }
    // finish laps whose post-roll is in (or that waited long enough): not in this frame (the copy and
    // the column encoding take a few ms for a long lap) but when the main thread is next idle; their
    // samples stay held until then
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (!(this.next / RATE > p.end + POST_S || now - p.wall > POST_WAIT_MS)) continue;
      this.pending.splice(i, 1); this.finishing.push(p);
      whenIdle(() => { const k = this.finishing.indexOf(p); if (k >= 0) this.finishing.splice(k, 1); void this.finish(p); });
    }
    // forget what no lap needs any more
    let keep = this.next / RATE - PRE_S - 0.5; // (a gate message arrives a little after the pass)
    if (keepFrom !== null) keep = Math.min(keep, keepFrom);
    for (const p of this.pending) keep = Math.min(keep, p.lap.start - PRE_S);
    for (const p of this.finishing) keep = Math.min(keep, p.lap.start - PRE_S);
    const k = Math.max(this.first, Math.min(this.next, Math.floor(keep * RATE)));
    if (k > this.first) this.first = k;
    if (this.next - this.first > MAX_SAMPLES) this.first = this.next - MAX_SAMPLES;
    this.dropOsd(this.first / RATE);
  }

  /** race.ts completed a lap: its replay, once the post-roll is in and it is encoded (null if the samples are gone). */
  finishLap(lap: LapDone, now = performance.now()): Promise<Uint8Array | null> {
    const end = lap.start + lap.gates[lap.gates.length - 1].t;
    const replay = new Promise<Uint8Array | null>((done) => this.pending.push({ lap, end, wall: now, done }));
    this.last = { lap, replay };
    return replay;
  }

  private store(k: number, modes: number) {
    if (k - this.first >= this.cap) this.grow(k - this.first + 1);
    const i = k % this.cap, r = this.rec;
    for (let c = 0; c < NC; c++) this.cols[c][i] = c === MODES ? modes : COL_SRC[c] >= 0 ? r[COL_SRC[c]] : NaN;
  }

  private grow(need: number) {
    const cap = Math.min(MAX_SAMPLES + 1, Math.max(4096, this.cap * 2, need));
    if (need > cap) { this.first = this.next - MAX_SAMPLES; return; } // (pump trims to MAX_SAMPLES)
    const cols = COLUMNS.map(() => new Float64Array(cap));
    for (let k = this.first; k < this.next; k++) for (let c = 0; c < NC; c++) cols[c][k % cap] = this.cols[c][k % this.cap];
    this.cols = cols; this.cap = cap;
  }

  private pumpOsd(sh: Shared, t: number) {
    const seq = Atomics.load(sh.ctrl, 2);
    const s = this.osdSeen;
    if (seq === s.seq) return;
    s.seq = seq;
    const cols = Atomics.load(sh.ctrl, 3) || 30, rows = Atomics.load(sh.ctrl, 4) || 16;
    const idx: number[] = [], ch: number[] = [], attr: number[] = [];
    for (let i = 0; i < OSD_CELLS; i++) {
      const c = sh.osd[i], a = sh.osd[OSD_CELLS + i];
      if (c !== s.ch[i] || a !== s.attr[i]) { idx.push(i); ch.push(c); attr.push(a); s.ch[i] = c; s.attr[i] = a; }
    }
    if (!idx.length && cols === s.cols && rows === s.rows) return;
    s.cols = cols; s.rows = rows;
    this.osdFrames.push({ t, cols, rows, idx: Uint16Array.from(idx), ch: Uint8Array.from(ch), attr: Uint8Array.from(attr) });
  }

  /** Fold OSD changes older than t into the base grid. */
  private dropOsd(t: number) {
    const b = this.osdBase;
    let n = 0;
    for (const f of this.osdFrames) {
      if (f.t >= t) break;
      for (let k = 0; k < f.idx.length; k++) { b.ch[f.idx[k]] = f.ch[k]; b.attr[f.idx[k]] = f.attr[k]; }
      b.cols = f.cols; b.rows = f.rows; b.t = f.t; n++;
    }
    if (n) this.osdFrames.splice(0, n);
  }

  /** The OSD of the window [t0, ∞) as frames relative to t0: a full grid first, then the changes. */
  private osdWindow(t0: number): OsdFrame[] {
    const b = this.osdBase, ch = b.ch.slice(), attr = b.attr.slice();
    let cols = b.cols, rows = b.rows, k = 0;
    for (; k < this.osdFrames.length && this.osdFrames[k].t <= t0; k++) {
      const f = this.osdFrames[k];
      for (let j = 0; j < f.idx.length; j++) { ch[f.idx[j]] = f.ch[j]; attr[f.idx[j]] = f.attr[j]; }
      cols = f.cols; rows = f.rows;
    }
    const key: number[] = [];
    for (let i = 0; i < OSD_CELLS; i++) if ((i % OSD_STRIDE) < cols && ch[i] !== 0x20 && ch[i] !== 0) key.push(i);
    const out: OsdFrame[] = [{ ms: 0, cols, rows, idx: Uint16Array.from(key), ch: Uint8Array.from(key, (i) => ch[i]), attr: Uint8Array.from(key, (i) => attr[i]) }];
    for (; k < this.osdFrames.length; k++) { const f = this.osdFrames[k]; out.push({ ms: (f.t - t0) * 1000, cols: f.cols, rows: f.rows, idx: f.idx, ch: f.ch, attr: f.attr }); }
    return out;
  }

  private async finish(p: Pending) {
    try {
      const { lap } = p;
      const k0 = Math.max(this.first, Math.ceil((lap.start - PRE_S) * RATE));
      const k1 = Math.min(this.next - 1, Math.floor((p.end + POST_S) * RATE));
      // the whole lap must be there (a stall longer than the ring can lose its start)
      if (k0 > Math.floor(lap.start * RATE) || k1 < Math.ceil(p.end * RATE)) { p.done(null); return; }
      const n = k1 - k0 + 1;
      const columns: Record<string, Float64Array> = {};
      COLUMNS.forEach((c, j) => { const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = this.cols[j][(k0 + i) % this.cap]; columns[c.id] = v; });
      const osd = this.osd ? this.osdWindow(k0 / RATE).filter((f) => f.ms <= (n / RATE) * 1000) : [];
      p.done(await encodeLap(lap, columns, k0 / RATE - lap.start, osd));
    } catch (e) {
      console.warn('lap replay not recorded', e);
      p.done(null);
    }
  }
}

/** Encode a lap; a long one that comes out over MAX_REPLAY_BYTES is thinned to half the rate (then a quarter …). */
export async function encodeLap(lap: LapDone, columns: Record<string, Float64Array>, t0: number, osd: OsdFrame[], rate = RATE): Promise<Uint8Array> {
  continuousQuats(columns.qw, columns.qx, columns.qy, columns.qz);
  for (let step = 1; ; step *= 2) {
    const cols: Record<string, Float64Array> = {};
    for (const [id, v] of Object.entries(columns)) cols[id] = step === 1 ? v : v.filter((_, i) => i % step === 0);
    const n = cols.px.length;
    const header: ReplayHeader = { ...lap.meta, v: REPLAY_VERSION, gates: lap.gates, rate: rate / step, n, t0, cols: [...COLUMNS] };
    // the OSD is the first thing to go when it doesn't fit
    const bytes = await encodeReplay({ header, columns: cols, osd: step === 1 ? osd : [] });
    if (bytes.length <= MAX_REPLAY_BYTES || rate / step <= 25) return bytes;
  }
}
