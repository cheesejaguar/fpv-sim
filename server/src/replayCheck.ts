// Does a posted replay show the lap it was posted with? The relay runs this before a lap goes on the
// board. The sim runs in the pilot's browser, so a replay can't prove a lap was flown either, but a
// believable one now takes a whole trajectory that flies the track: through every gate's opening in
// order, at the posted split times, without jumps, never faster than the class flies and never
// speeding up harder than it can. Laps are public with their replays, so anything odd can be looked
// at (and removed: DELETE /leaderboard/:id).
import { CLASSES, Submission, trackKey } from './leaderboardCore';
import { MAX_REPLAY_BYTES, openReplay, readColumns, ReplayHeader } from './replayFormat';
import { TRACK_GATES, TrackGate } from './trackGates';

/** A gate pass found in the replay must lie this close (s) to the split the lap was posted with. */
export const GATE_TIME_TOL = 0.03;
/** The replay's path may miss an opening by this much (m): sampling and 1 mm rounding, not the pilot. */
export const GATE_MARGIN = 0.05;
/** Peak speed (averaged over SPEED_WINDOW s) may exceed the class's vmax by this factor + SPEED_SLACK m/s (dives, gusts). */
export const SPEED_FACTOR = 1.25, SPEED_SLACK = 2, SPEED_WINDOW = 0.1;
/** Speed may grow by at most amax · ACCEL_WINDOW + ACCEL_SLACK m/s within any ACCEL_WINDOW s. */
export const ACCEL_WINDOW = 0.25, ACCEL_SLACK = 1.5;
/** Pre-roll before gate 0 / post-roll after the finish a replay may carry (s). */
export const MAX_ROLL_S = 5;

export interface ReplayFacts { rate: number; samples: number; peakSpeed: number; peakGain: number; gateErrMs: number }
export type ReplayVerdict = { ok: true; header: ReplayHeader; facts: ReplayFacts } | { ok: false; error: string };

// ---------------------------------------------------------------------------------------------
// Gate passes (the same rules as src/maps/gates.ts gatePassed, plus a margin)

function inOpening(g: TrackGate, lat: number, z: number, m: number): boolean {
  const w = g.w, h = g.h, dz = z - g.z;
  if (Math.abs(lat) >= w / 2 + m || dz <= -m || dz >= h + m) return false;
  if (g.kind !== 'arch') return true;
  const spring = h - w / 2; // round head: inside the semicircle above the springing line
  return dz <= spring || Math.hypot(lat, dz - spring) < w / 2 + m;
}

/**
 * Where the segment a → b passes gate g the right way, as a fraction of the segment (0..1), or -1.
 * Upright gates: forwards through the opening plane inside the opening. Dive: down through the frame
 * plane inside the frame. Flag: forwards across the line through the pole, within 6 m of it.
 */
export function passFraction(g: TrackGate, ax: number, ay: number, az: number, bx: number, by: number, bz: number, m = 0): number {
  if (g.kind === 'dive') {
    if (!(az > g.z && bz <= g.z)) return -1;
    const u = (az - g.z) / (az - bz);
    const x = ax + (bx - ax) * u - g.x, y = ay + (by - ay) * u - g.y;
    const c = Math.cos(g.yaw), s = Math.sin(g.yaw);
    return Math.abs(c * x + s * y) < g.w / 2 + m && Math.abs(-s * x + c * y) < g.w / 2 + m ? u : -1;
  }
  const nx = -Math.sin(g.yaw), ny = Math.cos(g.yaw);
  const d0 = (ax - g.x) * nx + (ay - g.y) * ny, d1 = (bx - g.x) * nx + (by - g.y) * ny;
  if (!(d0 < 0 && d1 >= 0)) return -1;
  const u = d0 / (d0 - d1);
  if (g.kind === 'flag') return Math.hypot(bx - g.x, by - g.y) < 6 + m ? u : -1;
  const ix = ax + (bx - ax) * u, iy = ay + (by - ay) * u, iz = az + (bz - az) * u;
  const lat = (ix - g.x) * Math.cos(g.yaw) + (iy - g.y) * Math.sin(g.yaw);
  return inOpening(g, lat, iz, m) ? u : -1;
}

// ---------------------------------------------------------------------------------------------

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** Check a replay against the lap it was posted with (already validated by parseSubmission). */
export async function checkReplay(bytes: Uint8Array, sub: Submission): Promise<ReplayVerdict> {
  const fail = (error: string): ReplayVerdict => ({ ok: false, error: `replay: ${error}` });
  if (bytes.length > MAX_REPLAY_BYTES) return fail('too big');
  let opened: Awaited<ReturnType<typeof openReplay>>;
  try { opened = await openReplay(bytes); } catch (e) { return fail((e as Error).message); }
  const h = opened.header, track = trackKey(sub.map, sub.course), gates = TRACK_GATES[track], cls = CLASSES[sub.cls];
  if (!gates || !cls) return fail('no gate data for this track');
  // the lap it says it is
  if (h.map !== sub.map || h.course !== sub.course || h.cls !== sub.cls) return fail('recorded on another track or drone class');
  if (h.timeScale !== 1) return fail('recorded in slow motion');
  if (Math.round(h.lapMs) !== sub.lapMs || h.splitsMs.length !== sub.splitsMs.length || h.splitsMs.some((s, i) => Math.round(s) !== sub.splitsMs[i])) return fail('lap time or splits differ from the posted lap');
  // gate 0, every gate in order, gate 0 again: at the posted splits
  const passes = h.gates;
  if (passes.length !== gates.length + 1 || passes.some((p, i) => p.id !== gates[i % gates.length].id)) return fail('gates not passed in the track’s order');
  const expect = [0, ...sub.splitsMs.map((s) => s / 1000)];
  if (passes.some((p, i) => !near(p.t, expect[i], 0.0015))) return fail('gate times differ from the splits');
  // samples cover the lap, at a sane rate, without a long pre / post roll
  const dt = 1 / h.rate, lap = sub.lapMs / 1000, tEnd = h.t0 + (h.n - 1) * dt;
  if (h.rate < 25 || h.rate > 500) return fail('sample rate out of range');
  if (h.t0 > 0 || h.t0 < -MAX_ROLL_S || tEnd < lap || tEnd > lap + MAX_ROLL_S) return fail('samples don’t cover the lap');
  let px: Float64Array, py: Float64Array, pz: Float64Array;
  try { ({ px, py, pz } = readColumns(opened, ['px', 'py', 'pz'], false).columns); } catch (e) { return fail((e as Error).message); }
  // (only the lap itself is checked: what happens in the pre / post roll doesn't count)
  const i0 = Math.max(0, Math.floor(-h.t0 / dt) - 1), i1 = Math.min(h.n - 1, Math.ceil((lap - h.t0) / dt) + 1);
  // no jumps: one sample to the next within what the class could fly (impacts only slow it down)
  const maxStep = cls.vmax * SPEED_FACTOR * 1.5 * dt + 0.02;
  for (let i = i0 + 1; i <= i1; i++) {
    const s = Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1], pz[i] - pz[i - 1]);
    if (!(s <= maxStep)) return fail(`jumps ${s.toFixed(2)} m between two samples at ${(h.t0 + i * dt).toFixed(2)} s`);
  }
  // speed: averaged over SPEED_WINDOW (k samples), at every sample
  const k = Math.max(1, Math.round(SPEED_WINDOW * h.rate)), m = Math.max(1, Math.round(ACCEL_WINDOW * h.rate));
  const speed = new Float64Array(Math.max(0, i1 - i0 - k + 1));
  let peak = 0;
  for (let j = 0; j < speed.length; j++) {
    const a = i0 + j, b = a + k;
    const v = Math.hypot(px[b] - px[a], py[b] - py[a], pz[b] - pz[a]) / (k * dt);
    speed[j] = v; if (v > peak) peak = v;
  }
  const vLimit = cls.vmax * SPEED_FACTOR + SPEED_SLACK;
  if (peak > vLimit) return fail(`${peak.toFixed(1)} m/s is faster than this drone class flies (${vLimit.toFixed(0)} m/s)`);
  // speeding up: never faster than full thrust plus gravity allows
  const gLimit = cls.amax * ACCEL_WINDOW + ACCEL_SLACK;
  let gain = 0;
  for (let j = 0; j + m < speed.length; j++) { const g = speed[j + m] - speed[j]; if (g > gain) gain = g; }
  if (gain > gLimit) return fail(`speeds up by ${gain.toFixed(1)} m/s in ${ACCEL_WINDOW} s, more than this drone class can (${gLimit.toFixed(0)} m/s)`);
  // the path passes each gate's opening near its split time
  let worst = 0;
  for (let p = 0; p < passes.length; p++) {
    const g = gates[p % gates.length], t = passes[p].t;
    const from = Math.max(1, Math.floor((t - h.t0 - 0.15) / dt)), to = Math.min(h.n - 1, Math.ceil((t - h.t0 + 0.15) / dt));
    let best = Infinity;
    for (let i = from; i <= to; i++) {
      const u = passFraction(g, px[i - 1], py[i - 1], pz[i - 1], px[i], py[i], pz[i], GATE_MARGIN);
      if (u >= 0) { const e = Math.abs(h.t0 + (i - 1 + u) * dt - t); if (e < best) best = e; }
    }
    const name = p === 0 ? 'the start gate' : p === passes.length - 1 ? 'the finish gate' : `gate ${p + 1}`;
    if (!(best <= GATE_TIME_TOL)) return fail(`the path doesn’t pass through ${name} when the lap timed it`);
    worst = Math.max(worst, best);
  }
  return { ok: true, header: h, facts: { rate: h.rate, samples: h.n, peakSpeed: peak, peakGain: gain, gateErrMs: worst * 1000 } };
}
