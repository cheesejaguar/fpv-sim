// Lap replays, playback side: a decoded recording (server/src/replayFormat.ts) as the state the
// frame loop renders from, in the worker ring's record layout (R / REC), so the renderer, the FPV
// camera, the props and the motor sound run unchanged on a replay. Position and attitude are cubic
// Hermite splines through the samples (tangents from their neighbours: smooth at any playback
// speed), everything else is linear. Plus the playback clock: play / pause, speed, seek, frame
// step, loop.
import type { OsdFrame, ReplayData, ReplayHeader } from '../../server/src/replayFormat';
import { OSD_CELLS } from '../../server/src/replayFormat';
import { R, REC } from '../worker/shared';

const LINEAR: [string, number][] = [['rpm0', R.rpm0], ['rpm1', R.rpm1], ['rpm2', R.rpm2], ['rpm3', R.rpm3], ['vbus', R.vbus], ['ibus', R.ibus], ['mah', R.mah], ['vrs', R.vrs], ['rc0', R.rc0], ['rc1', R.rc1], ['rc2', R.rc2], ['rc3', R.rc3]];

export class ReplayTrack {
  readonly header: ReplayHeader;
  readonly rate: number;
  readonly n: number;
  /** lap time (s) of the first and last sample */
  readonly t0: number;
  readonly t1: number;
  /** lap time (s) of the finish, and of each gate pass (start, gates…, finish) */
  readonly lap: number;
  readonly passes: number[];
  readonly osd: OsdFrame[];
  private c: Record<string, Float64Array>;
  private zero = new Float64Array(0);
  /** cells (for cellV); set by the player from the build */
  cells = 1;

  constructor(d: ReplayData) {
    const h = d.header;
    this.header = h; this.rate = h.rate; this.n = h.n; this.t0 = h.t0; this.t1 = h.t0 + (h.n - 1) / h.rate;
    this.lap = h.lapMs / 1000;
    this.passes = h.gates.map((g) => g.t);
    this.c = d.columns;
    this.osd = d.osd;
  }

  private col(id: string): Float64Array { return this.c[id] ?? this.zero; }

  /** Fill `out` (REC layout) with the state at lap time t (clamped to the recording). Always true. */
  sample(t: number, out: Float64Array): boolean {
    const f = Math.max(0, Math.min(this.n - 1, (t - this.t0) * this.rate));
    const i = Math.min(this.n - 2, Math.floor(f)), u = f - i, dt = 1 / this.rate;
    const i0 = Math.max(0, i - 1), i1 = i, i2 = i + 1, i3 = Math.min(this.n - 1, i + 2);
    // cubic Hermite (Catmull-Rom tangents) value and derivative
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
    const spline = (v: Float64Array, k: number, vk?: number) => {
      const p1 = v[i1], p2 = v[i2];
      const m1 = (v[i2] - v[i0]) / (i2 - i0), m2 = (v[i3] - v[i1]) / (i3 - i1);
      out[k] = h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2;
      if (vk !== undefined) out[vk] = (d00 * p1 + d10 * m1 + d01 * p2 + d11 * m2) / dt;
    };
    out.fill(0);
    out[R.t] = t;
    spline(this.col('px'), R.px, R.vx); spline(this.col('py'), R.py, R.vy); spline(this.col('pz'), R.pz, R.vz);
    spline(this.col('qw'), R.qw); spline(this.col('qx'), R.qx); spline(this.col('qy'), R.qy); spline(this.col('qz'), R.qz);
    const qn = Math.hypot(out[R.qw], out[R.qx], out[R.qy], out[R.qz]) || 1;
    out[R.qw] /= qn; out[R.qx] /= qn; out[R.qy] /= qn; out[R.qz] /= qn;
    for (const [id, k] of LINEAR) { const v = this.c[id]; out[k] = v ? v[i1] + (v[i2] - v[i1]) * u : 0; }
    if (!this.c.rc0) out[R.rc0] = out[R.rc1] = out[R.rc2] = out[R.rc3] = 1500;
    const armed = this.c.armed;
    out[R.armed] = armed ? armed[u < 0.5 ? i1 : i2] : 1;
    out[R.thr] = (out[R.rc2] - 1000) / 1000;
    out[R.cellV] = out[R.vbus] / Math.max(1, this.cells);
    out[R.simRate] = 1;
    return true;
  }

  /** Betaflight flight mode flags at t. */
  modesAt(t: number): number {
    const v = this.c.modes;
    if (!v) return 0;
    return v[Math.max(0, Math.min(this.n - 1, Math.round((t - this.t0) * this.rate)))];
  }

  /** Gate passes completed by lap time t: 0 before the start, passes.length after the finish. */
  passed(t: number): number { let k = 0; while (k < this.passes.length && this.passes[k] <= t) k++; return k; }
}

/**
 * Betaflight's OSD grid at a replay time, laid out like the shared OSD memory (chars, then
 * attributes, 64 columns per row; ctrl[2] counts frames, [3] / [4] the grid size), so the
 * OsdRenderer draws it as it draws the live OSD.
 */
export class OsdPlayback {
  readonly ctrl = new Int32Array(16);
  readonly osd = new Uint8Array(2 * OSD_CELLS);
  private k = 0; // frames applied
  constructor(private frames: OsdFrame[]) { this.reset(); this.ctrl[2] = 1; }

  private reset() {
    this.osd.fill(0x20, 0, OSD_CELLS); this.osd.fill(0, OSD_CELLS);
    this.k = 0; this.ctrl[3] = 30; this.ctrl[4] = 16;
  }

  /** Show the grid as of `ms` after the replay's first sample. */
  seek(ms: number) {
    let changed = false;
    if (this.k > 0 && this.frames[this.k - 1].ms > ms) { this.reset(); changed = true; }
    const start = this.k;
    for (; this.k < this.frames.length && this.frames[this.k].ms <= ms; this.k++) {
      const f = this.frames[this.k];
      for (let j = 0; j < f.idx.length; j++) { this.osd[f.idx[j]] = f.ch[j]; this.osd[OSD_CELLS + f.idx[j]] = f.attr[j]; }
      this.ctrl[3] = f.cols; this.ctrl[4] = f.rows;
    }
    if (changed || this.k !== start) this.ctrl[2]++;
  }
}

// ---------------------------------------------------------------------------------------------

export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4] as const;

/**
 * Playback time (lap time, s) between `min` and `max`. tick() advances it by wall time × speed while
 * playing; at the end it stops, or with loop on starts over. `seq` changes on every jump (seek,
 * step, restart, loop), so a camera that only moves forward knows to start again.
 */
export class ReplayClock {
  t: number;
  playing = true;
  loop = false;
  speedIdx: number = SPEEDS.indexOf(1);
  seq = 0;
  constructor(readonly min: number, readonly max: number, readonly frame = 1 / 100, start = min) { this.t = Math.max(min, Math.min(max, start)); }

  get speed(): number { return SPEEDS[this.speedIdx]; }
  get atEnd(): boolean { return this.t >= this.max; }

  /** Advance by dt seconds of wall time. */
  tick(dt: number) {
    if (!this.playing || !(dt > 0)) return;
    this.t += Math.min(dt, 0.25) * this.speed; // (a hidden tab's long gap doesn't skip ahead)
    if (this.t < this.max) return;
    if (this.loop) { this.t = this.min + ((this.t - this.min) % (this.max - this.min || 1)); this.seq++; }
    else { this.t = this.max; this.playing = false; }
  }

  play() { if (this.atEnd) this.seek(this.min); this.playing = true; }
  pause() { this.playing = false; }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  seek(t: number) { const c = Math.max(this.min, Math.min(this.max, t)); if (c !== this.t) { this.t = c; this.seq++; } }
  /** One sample forward / back (pauses: frame stepping is for looking closely). */
  step(d: 1 | -1) { this.playing = false; this.seek(this.min + (Math.round((this.t - this.min) / this.frame) + d) * this.frame); }
  restart() { this.seek(this.min); this.seq++; this.playing = true; }
  setSpeed(i: number) { this.speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i)); }
  faster() { this.setSpeed(this.speedIdx + 1); }
  slower() { this.setSpeed(this.speedIdx - 1); }
}
