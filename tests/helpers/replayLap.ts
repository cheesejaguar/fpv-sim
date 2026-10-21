// A synthetic lap for the replay tests: a smooth path through the openings of a leaderboard track's
// real gates (server/src/trackGates.ts), in order, flown at a constant speed, sampled like the
// recorder samples the ring, and encoded as a .fpvreplay. Options bend it into the ways a forged or
// broken replay goes wrong.
import { CLASSES, minLapMs, TRACKS } from '../../server/src/leaderboardCore';
import { COLUMNS, encodeReplay, GatePass, REPLAY_VERSION, ReplayHeader } from '../../server/src/replayFormat';
import { TRACK_GATES, TrackGate } from '../../server/src/trackGates';

type V = [number, number, number];
interface Way { p: V; d: V; gate?: number } // a point the path passes, its direction there, the gate it times

const dir = (g: TrackGate): V => [-Math.sin(g.yaw), Math.cos(g.yaw), 0];
function ways(gates: readonly TrackGate[]): Way[] {
  const out: Way[] = [];
  gates.forEach((g, i) => {
    if (g.kind === 'dive') { // straight down through the frame
      out.push({ p: [g.x, g.y, g.z + 1.5], d: [0, 0, -1] }, { p: [g.x, g.y, g.z], d: [0, 0, -1], gate: i }, { p: [g.x, g.y, g.z - 1.2], d: [0, 0, -1] });
      return;
    }
    const zc = g.kind === 'flag' ? g.z + 1.5 : g.kind === 'arch' ? g.z + Math.min(g.h, g.h - g.w / 2 + 0.5) / 2 : g.z + g.h / 2;
    out.push({ p: [g.x, g.y, zc], d: dir(g), gate: i });
  });
  return out;
}

/** Point on the closed Hermite path through `w` at segment s, fraction u. */
function at(w: Way[], s: number, u: number): V {
  const a = w[s % w.length], b = w[(s + 1) % w.length];
  const k = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]) * 1.2;
  const u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  return [0, 1, 2].map((j) => h00 * a.p[j] + h10 * k * a.d[j] + h01 * b.p[j] + h11 * k * b.d[j]) as V;
}

export interface LapOpts {
  /** m/s along the path (default half the class's vmax, slower on short tracks: a lap the board accepts) */
  speed?: number;
  rate?: number;
  /** move every split by this much (s): the path no longer passes the gates at their times */
  splitShift?: number;
  /** add this much to one sample's x (m) at the middle of the lap: a teleport */
  jumpAt?: number;
  /** scale the path's timing: < 1 flies the same path faster than the header says */
  modify?: (cols: Record<string, Float64Array>, t: Float64Array) => void;
}

/** A lap on `track` (map or map:course) with drone class `cls`: its submission fields and replay bytes. */
export async function syntheticLap(track: string, cls = 'freestyle5', o: LapOpts = {}) {
  const gates = TRACK_GATES[track], w = ways(gates), rate = o.rate ?? 100;
  // arc length of each segment (dense polyline), then the time of each waypoint at constant speed
  const N = 200, segLen: number[] = [];
  for (let s = 0; s < w.length; s++) { let L = 0, prev = at(w, s, 0); for (let i = 1; i <= N; i++) { const p = at(w, s, i / N); L += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); prev = p; } segLen.push(L); }
  const total = segLen.reduce((a, b) => a + b, 0), v = o.speed ?? Math.min(CLASSES[cls].vmax * 0.5, total / ((1.5 * minLapMs(track, cls)) / 1000));
  // gate 0 is waypoint g0; lap time 0 there
  const g0 = w.findIndex((x) => x.gate === 0);
  const order = [...w.keys()].map((k) => (g0 + k) % w.length);
  const tAt: number[] = []; // lap time at each waypoint, in lap order
  let acc = 0;
  for (const k of order) { tAt.push(acc / v); acc += segLen[k]; }
  const lap = total / v;
  // position at lap time t (wrapping): find the segment, then u by arc length within it
  const pos = (t: number): V => {
    const tt = ((t % lap) + lap) % lap;
    let j = 0;
    while (j + 1 < order.length && tAt[j + 1] <= tt) j++;
    const s = order[j], dist = (tt - tAt[j]) * v;
    let L = 0, prev = at(w, s, 0);
    for (let i = 1; i <= N; i++) { const p = at(w, s, i / N); const d = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); if (L + d >= dist) { const f = d > 0 ? (dist - L) / d : 0; return [0, 1, 2].map((q) => prev[q] + (p[q] - prev[q]) * f) as V; } L += d; prev = p; }
    return at(w, s, 1);
  };
  const passes: GatePass[] = [];
  order.forEach((k, j) => { const g = w[k].gate; if (g !== undefined) passes.push({ id: gates[g].id, t: tAt[j] }); });
  passes.push({ id: gates[0].id, t: lap });
  const shifted = passes.map((p, i) => ({ ...p, t: i === 0 ? 0 : p.t + (o.splitShift ?? 0) }));
  const lapMs = Math.round(shifted[shifted.length - 1].t * 1000);
  const splitsMs = shifted.slice(1).map((p) => Math.round(p.t * 1000));
  splitsMs[splitsMs.length - 1] = lapMs;
  // samples: 1 s before gate 0 to 1 s after the finish
  const t0 = -1, n = Math.floor((lap + 2) * rate) + 1, ts = new Float64Array(n);
  const cols: Record<string, Float64Array> = Object.fromEntries(COLUMNS.map((c) => [c.id, new Float64Array(n)]));
  for (let i = 0; i < n; i++) {
    const t = t0 + i / rate, p = pos(t);
    ts[i] = t; cols.px[i] = p[0]; cols.py[i] = p[1]; cols.pz[i] = p[2];
    cols.qw[i] = 1; cols.rpm0[i] = cols.rpm1[i] = cols.rpm2[i] = cols.rpm3[i] = 20_000 + 2000 * Math.sin(t * 3);
    cols.rc0[i] = 1500 + 300 * Math.sin(t); cols.rc1[i] = 1500; cols.rc2[i] = 1600; cols.rc3[i] = 1500;
    cols.vbus[i] = 24 - t * 0.05; cols.ibus[i] = 30; cols.mah[i] = t * 8; cols.armed[i] = 1;
  }
  if (o.jumpAt !== undefined) cols.px[Math.round((o.jumpAt - t0) * rate)] += 5;
  o.modify?.(cols, ts);
  const [map, course = ''] = track.split(':');
  const header: ReplayHeader = {
    v: REPLAY_VERSION, app: 'test', date: 1_700_000_000_000, map, course, cls, summary: CLASSES[cls].name, lapMs, splitsMs,
    gates: shifted, rate, n, t0, spec: {}, timeScale: 1, physicsHz: 8000, cols: [...COLUMNS],
  };
  const replay = await encodeReplay({ header, columns: cols, osd: [] });
  return { map, course, cls, lapMs, splitsMs, replay, header, pathM: TRACKS[track].pathM, speed: v };
}
