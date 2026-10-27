// Actors: things in the world besides the quad (MapDef.actors, docs/MAP_FORMAT.md "paths and
// actors"). Shared by the simulation worker / headless core and the renderer, so no three.js and no
// state that one side would have and the other not:
//   - kinematics: where an actor is at sim time t, a pure function of the arc length travelled
//     along its path (no integration: a seeded run puts every actor in the same place, and the main
//     thread recomputes the same positions from the map and the ring's sim time);
//   - RF: free-space loss, in-band overlap, antenna pattern, interference power at a receiver;
//   - detectors: range gate -> field of view -> line of sight -> probability of detection, then a
//     seeded draw per look and m-of-n confirmation (ActorSim).
import type { ActorDef, LosLoss, MapDef, PathDef } from '../maps/world';
import { Rng, subSeed, V3 } from './math';

export type EmitterDef = Extract<ActorDef, { type: 'rf-emitter' }>;
export type StationDef = Extract<ActorDef, { type: 'ground-station' }>;
export type DetectorDef = Extract<ActorDef, { type: 'detector' }>;
export type TargetDef = Extract<ActorDef, { type: 'target' }>;

// ---------------------------------------------------------------------------------------------
// Kinematics

interface PathGeom { pts: V3[]; cum: Float64Array; len: number }
const geoms = new WeakMap<PathDef, PathGeom>();

function geomOf(p: PathDef): PathGeom {
  let g = geoms.get(p);
  if (g) return g;
  // a loop runs back to its first point
  const pts = p.mode === 'loop' && p.points.length > 1 ? [...p.points, p.points[0]] : p.points;
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  g = { pts, cum, len: pts.length ? cum[pts.length - 1] : 0 };
  geoms.set(p, g);
  return g;
}

export function pathById(paths: readonly PathDef[] | undefined, id: string | undefined): PathDef | undefined {
  if (!id || !paths) return undefined;
  for (const p of paths) if (p.id === id) return p;
  return undefined;
}

/**
 * Where along the path (arc length s, m) an actor is at sim time t, and which way it is going
 * (+1 forward, -1 back along a pingpong, 0 standing: before `delay`, or at the end of a `once`).
 */
export function pathProgress(p: PathDef, t: number): { s: number; dir: number } {
  const L = geomOf(p).len, d = (t - p.delay) * p.speed;
  if (!(L > 0) || !(p.speed > 0) || !(d > 0)) return { s: 0, dir: 0 };
  if (p.mode === 'once') return d >= L ? { s: L, dir: 0 } : { s: d, dir: 1 };
  if (p.mode === 'pingpong') { const u = d % (2 * L); return u <= L ? { s: u, dir: 1 } : { s: 2 * L - u, dir: -1 }; }
  return { s: d % L, dir: 1 };
}

/** Point at arc length s, and the unit direction of the segment it is on (forward). */
function locate(g: PathGeom, s: number, pos: V3, dir: V3 | null) {
  const { pts, cum } = g, n = pts.length;
  if (n === 1) { pos.x = pts[0].x; pos.y = pts[0].y; pos.z = pts[0].z; if (dir) { dir.x = 1; dir.y = 0; dir.z = 0; } return; }
  // the segment [k, k+1] holding s (binary search; zero-length segments skipped by the search)
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const a = pts[lo], b = pts[hi], segL = cum[hi] - cum[lo];
  const f = segL > 0 ? Math.min(1, Math.max(0, (s - cum[lo]) / segL)) : 0;
  pos.x = a.x + (b.x - a.x) * f; pos.y = a.y + (b.y - a.y) * f; pos.z = a.z + (b.z - a.z) * f;
  if (dir) {
    if (segL > 0) { dir.x = (b.x - a.x) / segL; dir.y = (b.y - a.y) / segL; dir.z = (b.z - a.z) / segL; }
    else { dir.x = 1; dir.y = 0; dir.z = 0; }
  }
}

const _dir: V3 = { x: 0, y: 0, z: 0 }, _pos: V3 = { x: 0, y: 0, z: 0 };

/** Where the actor is at sim time t (its own pos, or on its path). */
export function posAt(a: ActorDef, paths: readonly PathDef[] | undefined, t: number, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const p = pathById(paths, a.path);
  if (!p) { out.x = a.pos.x; out.y = a.pos.y; out.z = a.pos.z; return out; }
  locate(geomOf(p), pathProgress(p, t).s, out, null);
  return out;
}

/** The actor's velocity at sim time t (m/s; zero when it stands). */
export function velAt(a: ActorDef, paths: readonly PathDef[] | undefined, t: number, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const p = pathById(paths, a.path);
  out.x = 0; out.y = 0; out.z = 0;
  if (!p) return out;
  const { s, dir } = pathProgress(p, t);
  if (!dir) return out;
  locate(geomOf(p), s, _pos, _dir);
  const v = p.speed * dir;
  out.x = _dir.x * v; out.y = _dir.y * v; out.z = _dir.z * v;
  return out;
}

/** The way the actor faces at sim time t (rad, counter-clockwise from east): along its travel; 0 for a fixed actor. */
export function headingAt(a: ActorDef, paths: readonly PathDef[] | undefined, t: number): number {
  const p = pathById(paths, a.path);
  if (!p) return 0;
  const { s, dir } = pathProgress(p, t);
  locate(geomOf(p), s, _pos, _dir);
  const k = dir < 0 ? -1 : 1;
  return Math.atan2(_dir.y * k, _dir.x * k);
}

// ---------------------------------------------------------------------------------------------
// RF link budget

/** A receiver band: centre and width (MHz). */
export interface Band { fMHz: number; bwMHz: number }
/** ExpressLRS 2.4 GHz LoRa: 812 kHz wide around the middle of the ISM band. */
export const RC_BAND: Band = { fMHz: 2440, bwMHz: 0.812 };
/** 5.8 GHz video: one ~20 MHz channel (src/render/videoLink.ts F_MHZ). */
export const VIDEO_BAND: Band = { fMHz: 5800, bwMHz: 20 };
/** 2.4 GHz penetrates walls better than 5.8 GHz: obstruction loss scale (as src/sim/rcLink.ts). */
export const RC_OBSTRUCTION_SCALE = 0.7;

/** Free-space path loss (dB) over dKm at fMHz. */
export const fsplDb = (dKm: number, fMHz: number) => 20 * Math.log10(dKm) + 20 * Math.log10(fMHz) + 32.44;

/**
 * Share of an emitter's power (spread flat over bwMHz around fMHz) that falls inside the band.
 * A zero-width emitter is a carrier: all of it or nothing.
 */
export function bandOverlap(fMHz: number, bwMHz: number, band: Band): number {
  const bLo = band.fMHz - band.bwMHz / 2, bHi = band.fMHz + band.bwMHz / 2;
  if (!(bwMHz > 0)) return fMHz >= bLo && fMHz <= bHi ? 1 : 0;
  if (fMHz - bwMHz / 2 >= bLo && fMHz + bwMHz / 2 <= bHi) return 1; // all of it inside
  const ov = Math.min(fMHz + bwMHz / 2, bHi) - Math.max(fMHz - bwMHz / 2, bLo);
  return ov > 0 ? Math.min(1, ov / bwMHz) : 0;
}

/**
 * Gain (dB, <= 0) of a directional antenna toward `to`, relative to its boresight: a parabolic
 * main lobe (-3 dB at beam / 2 off axis) with a -25 dB floor (side and back lobes). No antenna: 0.
 */
export function antennaGainDb(ant: { yaw: number; pitch: number; beam: number } | undefined, from: V3, to: V3): number {
  if (!ant) return 0;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, d = Math.hypot(dx, dy, dz);
  if (d < 1e-9) return 0;
  const cp = Math.cos(ant.pitch);
  const c = (cp * Math.cos(ant.yaw) * dx + cp * Math.sin(ant.yaw) * dy + Math.sin(ant.pitch) * dz) / d;
  const th = Math.acos(Math.max(-1, Math.min(1, c)));
  return Math.max(-25, -12 * (th / Math.max(1e-3, ant.beam)) ** 2);
}

/**
 * Power an emitter at ePos puts into a receiver at rx (dBm, before band overlap and duty):
 * EIRP + antenna pattern − FSPL − obstruction + receive antenna gain.
 */
export function emitterRxDbm(e: EmitterDef, ePos: V3, rx: V3, obstructionDb: number, rxGainDbi = 0): number {
  const d = Math.max(0.5, Math.hypot(rx.x - ePos.x, rx.y - ePos.y, rx.z - ePos.z));
  return e.eirpDbm + antennaGainDb(e.antenna, ePos, rx) - fsplDb(d / 1000, e.freqMHz) - obstructionDb + rxGainDbi;
}

/** Mean in-band interference (mW) an emitter puts into a receiver of `band` (its duty cycle averaged). */
export function interferenceMw(e: EmitterDef, ePos: V3, rx: V3, band: Band, obstructionDb: number, rxGainDbi = 0): number {
  const ov = bandOverlap(e.freqMHz, e.bwMHz, band);
  if (!(ov > 0) || !(e.duty > 0)) return 0;
  return 10 ** (emitterRxDbm(e, ePos, rx, obstructionDb, rxGainDbi) / 10) * ov * Math.min(1, e.duty);
}

/** Obstruction loss between two points (dB): PrimitiveWorld.obstructionDb. */
export type ObstructionFn = (a: V3, b: V3) => number;

/** Total in-band interference (mW) of every emitter of `emitters` at rx, at sim time t. */
export function totalInterferenceMw(emitters: readonly EmitterDef[], paths: readonly PathDef[] | undefined, t: number, rx: V3, band: Band, obstruction: ObstructionFn, obsScale: number, rxGainDbi: number): number {
  let sum = 0;
  for (const e of emitters) {
    if (!(bandOverlap(e.freqMHz, e.bwMHz, band) > 0) || !(e.duty > 0)) continue;
    const p = posAt(e, paths, t, _ePos);
    sum += interferenceMw(e, p, rx, band, obsScale * obstruction(p, rx), rxGainDbi);
  }
  return sum;
}
const _ePos: V3 = { x: 0, y: 0, z: 0 };

/** Signal over noise + interference (dB), with noise as a level in dBm and interference in mW. */
export const sinrDb = (signalDbm: number, noiseDbm: number, interfMw: number) => signalDbm - 10 * Math.log10(10 ** (noiseDbm / 10) + interfMw);

// ---------------------------------------------------------------------------------------------
// Detectors

/** Size (m) of the quad a detector's r50M is quoted for: a 5-inch, about 0.35 m across its props. */
export const REF_SIZE_M = 0.35;

/** How well a camera sees in the map's light (1 = daylight). */
export function lightLevel(sky: MapDef['sky']): number {
  return sky === 'night' ? 0.3 : sky === 'dusk' ? 0.55 : sky === 'overcast' ? 0.85 : 1;
}

/** What a look needs to know besides the geometry. */
export interface LookContext {
  /** the quad's size (m across, props included) */
  sizeM: number;
  /** the quad's video transmitter output (dBm) */
  vtxDbm: number;
  /** lightLevel of the map */
  light: number;
  /** line of sight (PrimitiveWorld.losLoss) */
  los(a: V3, b: V3): LosLoss;
}

export interface Look {
  range: number;
  inRange: boolean; inFov: boolean;
  /** nothing solid in the way (an rf look always "sees": walls only weaken it) */
  clear: boolean;
  /** probability that this look detects the quad */
  pd: number;
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

/** A vector from the sensor in its own frame: azimuth (left +) and elevation (up +), rad. */
export function sensorAngles(d: Pick<DetectorDef, 'yaw' | 'pitch'>, v: V3): { az: number; el: number } {
  const cy = Math.cos(d.yaw), sy = Math.sin(d.yaw), cp = Math.cos(d.pitch), sp = Math.sin(d.pitch);
  const x1 = cy * v.x + sy * v.y, y1 = -sy * v.x + cy * v.y, z1 = v.z;
  const x2 = cp * x1 + sp * z1, z2 = -sp * x1 + cp * z1;
  return { az: Math.atan2(y1, x2), el: Math.atan2(z2, Math.hypot(x2, y1)) };
}

/** Is the direction v (from the sensor) inside its field of view? */
export function inFov(d: Pick<DetectorDef, 'yaw' | 'pitch' | 'fovH' | 'fovV'>, v: V3): boolean {
  const allAz = d.fovH >= 2 * Math.PI - 1e-6, allEl = d.fovV >= Math.PI - 1e-6;
  if (allAz && allEl) return true;
  const { az, el } = sensorAngles(d, v);
  return (allAz || Math.abs(az) <= d.fovH / 2) && (allEl || Math.abs(el) <= d.fovV / 2);
}

/**
 * One look of a detector at sensor position s for a quad at q: range gate, field of view, line of
 * sight, then the probability of detection of its sensor:
 *   camera: logistic in range around r50M scaled by the quad's size and the light, times what
 *           foliage in the way lets through;
 *   radar:  SNR ∝ RCS / r⁴ (RCS ∝ size²), 0 dB at r50M, through a logistic; foliage costs twice
 *           (there and back);
 *   rf:     the quad's VTX power − FSPL at 5.8 GHz − obstruction against sensitivityDbm.
 */
export function lookAt(d: DetectorDef, s: V3, q: V3, ctx: LookContext): Look {
  const v = { x: q.x - s.x, y: q.y - s.y, z: q.z - s.z };
  const range = Math.hypot(v.x, v.y, v.z);
  const out: Look = { range, inRange: range <= d.rangeM, inFov: false, clear: false, pd: 0 };
  if (!out.inRange) return out;
  out.inFov = inFov(d, v);
  if (!out.inFov) return out;
  const los = ctx.los(s, q);
  if (d.sensor === 'rf') {
    out.clear = true;
    const rx = ctx.vtxDbm - fsplDb(Math.max(0.5, range) / 1000, VIDEO_BAND.fMHz) - los.db;
    out.pd = logistic((rx - d.sensitivityDbm) / 1.5);
    return out;
  }
  out.clear = !(los.hardDb > 0);
  if (!out.clear) return out;
  const size = Math.max(0.02, ctx.sizeM) / REF_SIZE_M;
  if (d.sensor === 'camera') {
    const r50 = Math.max(0.1, d.r50M * size * ctx.light);
    out.pd = logistic(-(range - r50) / Math.max(0.5, 0.12 * r50)) * 10 ** (-los.foliageDb / 10);
  } else {
    const snr = 40 * Math.log10(d.r50M / Math.max(0.1, range)) + 20 * Math.log10(size) - 2 * los.foliageDb;
    out.pd = logistic(snr / 1.5);
  }
  return out;
}

/** A detector's state: its looks (newest in bit 0) and whether it holds a detection. */
interface DetectorState { d: DetectorDef; index: number; rng: Rng; hist: number; looks: number; on: boolean; mask: number; period: number; periodHz: number }

const popcount = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24); };

/** A detection starting (on) or ending at sim time t (actor time). */
export interface DetectEvent { index: number; id: string; name: string; t: number; on: boolean }

/**
 * The simulation side of a map's actors: detector state (look history, m-of-n confirmation, a
 * seeded stream per detector), which targets the quad is at, and the link-budget sums the flight
 * core needs. Times are actor time (FlightCore.actorT: sim time since the actors started).
 */
export class ActorSim {
  readonly map: MapDef;
  readonly emitters: EmitterDef[];
  readonly stations: StationDef[];
  readonly detectors: DetectorDef[];
  readonly targets: TargetDef[];
  private st: DetectorState[] = [];
  /** bit k: detector k (map order, first 32) holds a detection */
  detectedMask = 0;
  /** bit k: the quad is within target k's radius (map order, first 31) */
  targetMask = 0;
  /** the newest look of each detector (for HUD / debugging) */
  readonly lastLook: (Look | null)[];
  private sPos: V3 = { x: 0, y: 0, z: 0 };
  private tPos: V3 = { x: 0, y: 0, z: 0 };

  constructor(map: MapDef, seed: number) {
    this.map = map;
    const a = map.actors ?? [];
    this.emitters = a.filter((x): x is EmitterDef => x.type === 'rf-emitter');
    this.stations = a.filter((x): x is StationDef => x.type === 'ground-station');
    this.detectors = a.filter((x): x is DetectorDef => x.type === 'detector');
    this.targets = a.filter((x): x is TargetDef => x.type === 'target');
    this.lastLook = this.detectors.map(() => null);
    this.reset(seed);
  }

  /** Every detector forgets its looks; its stream starts again from `seed`. */
  reset(seed: number) {
    this.st = this.detectors.map((d, index) => {
      const n = Math.max(1, Math.min(32, Math.round(d.confirmN)));
      return { d, index, rng: new Rng(subSeed(seed >>> 0, index + 1)), hist: 0, looks: 0, on: false, mask: n >= 32 ? -1 : (1 << n) - 1, period: 0, periodHz: 0 };
    });
    this.detectedMask = 0; this.targetMask = 0;
    this.lastLook.fill(null);
  }

  get hasRc(): boolean { return this.emitters.some((e) => bandOverlap(e.freqMHz, e.bwMHz, RC_BAND) > 0) || this.stations.some((s) => s.link !== 'video'); }

  /** RC interference (mW) at the quad's receiver at actor time t. */
  rcInterferenceMw(t: number, rx: V3, obstruction: ObstructionFn, rxGainDbi = 2): number {
    return this.emitters.length ? totalInterferenceMw(this.emitters, this.map.paths, t, rx, RC_BAND, obstruction, RC_OBSTRUCTION_SCALE, rxGainDbi) : 0;
  }

  /**
   * The uplink transmitter: the pilot's radio or a ground station with an `rc` link, whichever
   * reaches the quad best (deterministic budget, no fading; a site must beat the current one by
   * hysteresisDb to take over). Returns the station index, or -1 for the pilot.
   */
  rcSite(t: number, pilot: V3, pilotMw: number, quad: V3, obstruction: ObstructionFn, current = -1, hysteresisDb = 3): { index: number; pos: V3; txPowerMw: number; gainDbi: number } {
    const budget = (pos: V3, mw: number, gain: number) => 10 * Math.log10(Math.max(1, mw)) + gain - fsplDb(Math.max(0.5, Math.hypot(quad.x - pos.x, quad.y - pos.y, quad.z - pos.z)) / 1000, RC_BAND.fMHz) - RC_OBSTRUCTION_SCALE * obstruction(pos, quad);
    let best = { index: -1, pos: pilot, txPowerMw: pilotMw, gainDbi: 2 };
    const cand: { index: number; pos: V3; txPowerMw: number; gainDbi: number; db: number }[] = [{ ...best, db: budget(pilot, pilotMw, 2) }];
    this.stations.forEach((s, index) => {
      if (s.link === 'video') return;
      const pos = posAt(s, this.map.paths, t), mw = s.txPowerMw ?? pilotMw;
      cand.push({ index, pos, txPowerMw: mw, gainDbi: s.gainDbi, db: budget(pos, mw, s.gainDbi) });
    });
    let top = cand[0];
    for (const c of cand) if (c.db > top.db) top = c;
    const cur = cand.find((c) => c.index === current);
    const pick = cur && top.db < cur.db + hysteresisDb ? cur : top;
    best = { index: pick.index, pos: pick.pos, txPowerMw: pick.txPowerMw, gainDbi: pick.gainDbi };
    return best;
  }

  /**
   * After a physics step: every detector whose look is due at this step count (one look each
   * round(physicsHz / rateHz) steps) looks, draws, and updates its m-of-n state. Events go to onEvent.
   */
  stepDetectors(steps: number, physicsHz: number, t: number, quad: V3, ctx: LookContext, onEvent?: (e: DetectEvent) => void) {
    for (const s of this.st) {
      if (s.periodHz !== physicsHz) { s.periodHz = physicsHz; s.period = Math.max(1, Math.round(physicsHz / Math.max(0.01, s.d.rateHz))); }
      if (steps % s.period !== 0) continue;
      this.look(s, t, quad, ctx, onEvent);
    }
  }

  private look(s: DetectorState, t: number, quad: V3, ctx: LookContext, onEvent?: (e: DetectEvent) => void) {
    const d = s.d;
    const look = lookAt(d, posAt(d, this.map.paths, t, this.sPos), quad, ctx);
    this.lastLook[s.index] = look;
    // one draw per look whatever the geometry, so the stream never depends on where the quad was
    const hit = s.rng.next() < look.pd;
    s.hist = ((s.hist << 1) | (hit ? 1 : 0)) & s.mask;
    s.looks++;
    const on = popcount(s.hist) >= Math.max(1, d.confirmM);
    if (on === s.on) return;
    s.on = on;
    if (s.index < 32) this.detectedMask = on ? (this.detectedMask | (1 << s.index)) : (this.detectedMask & ~(1 << s.index));
    onEvent?.({ index: s.index, id: d.id, name: d.name, t, on });
  }

  /** The 1 kHz record: which targets the quad is at. */
  record(t: number, quad: V3) {
    let m = 0;
    for (let k = 0; k < this.targets.length && k < 31; k++) {
      const a = this.targets[k], p = posAt(a, this.map.paths, t, this.tPos);
      if (Math.hypot(quad.x - p.x, quad.y - p.y, quad.z - p.z) <= a.radius) m |= 1 << k;
    }
    this.targetMask = m;
  }

  /** Ids of the detectors holding a detection now. */
  detectedIds(): string[] { return this.st.filter((s) => s.on).map((s) => s.d.id); }
  get anyDetected(): boolean { return this.st.some((s) => s.on); }
}

/** The detector ids a ctrl[10] bitmask names (map order). */
export function detectedFromMask(map: MapDef, mask: number): DetectorDef[] {
  const out: DetectorDef[] = [];
  let k = 0;
  for (const a of map.actors ?? []) if (a.type === 'detector') { if (k < 32 && mask & (1 << k)) out.push(a); k++; }
  return out;
}

/**
 * The map with its actors randomized (scenario randomize.actors): fixed actors moved by up to
 * jitterM in x and y (solid targets excepted), each path shifted as a whole by up to jitterM, and
 * path k's speed scaled by speedScale[k] (1 past the list's end). The jitter comes from a stream
 * seeded with `seed`, in map order: fixed actors, then paths.
 */
export function randomizeActors(map: MapDef, o: { jitterM: number; speedScale: readonly number[]; seed: number }): MapDef {
  if (!map.actors?.length && !map.paths?.length) return map;
  const rng = new Rng(o.seed >>> 0);
  const j = () => (rng.next() * 2 - 1) * o.jitterM;
  // (a solid target is part of the collision world: it stays where the map puts it)
  const actors = (map.actors ?? []).map((a) => (a.path || (a.type === 'target' && a.solid) ? { ...a } : { ...a, pos: { x: a.pos.x + j(), y: a.pos.y + j(), z: a.pos.z } }));
  const paths = (map.paths ?? []).map((p, i) => {
    const dx = j(), dy = j(), k = o.speedScale[i] ?? 1;
    return { ...p, speed: p.speed * k, points: p.points.map((q) => ({ x: q.x + dx, y: q.y + dy, z: q.z })) };
  });
  // a path actor's pos is its path's first point
  for (const a of actors) if (a.path) { const p = paths.find((x) => x.id === a.path); if (p) a.pos = { ...p.points[0] }; }
  const out: MapDef = { ...map, actors };
  if (map.paths) out.paths = paths;
  return out;
}
