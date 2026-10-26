// Domain randomization: distributions over drone builds and simulation settings, sampled with a
// seeded generator. A build is sampled as components plus override scales and then derived by the
// builder (derive.ts), so mass, inertia, thrust curve and battery stay physically consistent with
// each other: a heavier sampled battery moves the CG and the inertia, a different prop changes the
// whole thrust and torque table, instead of each parameter being jittered on its own.
import { DroneSpec, Overrides, PRESETS } from '../builder/derive';
import { Rng } from '../sim/math';
import type { SimSettings } from '../worker/shared';
import type { OpsConfig } from '../worker/ops';

/**
 * One randomized value: a constant, or
 *   { "uniform": [min, max] }               uniform in [min, max)
 *   { "normal": [mean, sd], "min", "max" }  normal, clipped
 *   { "loguniform": [min, max] }            uniform in log space (scales, rates)
 *   { "choice": [a, b, ...], "weights"? }   one of the values
 */
export type Dist<T = number | string> =
  | T
  | { uniform: [number, number] }
  | { normal: [number, number]; min?: number; max?: number }
  | { loguniform: [number, number] }
  | { choice: T[]; weights?: number[] };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Draw one value from a distribution (a constant is returned as is). */
export function sample<T extends number | string>(d: Dist<T>, rng: Rng): T {
  if (!isObj(d)) return d as T;
  if ('uniform' in d) { const [a, b] = d.uniform; return (a + (b - a) * rng.next()) as T; }
  if ('loguniform' in d) { const [a, b] = d.loguniform; return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * rng.next()) as T; }
  if ('normal' in d) {
    const [m, sd] = d.normal;
    const x = m + sd * rng.gauss();
    return Math.min(d.max ?? Infinity, Math.max(d.min ?? -Infinity, x)) as T;
  }
  if ('choice' in d) {
    const c = d.choice, w = d.weights;
    if (!c.length) throw new Error('choice: no values');
    if (!w) return c[Math.min(c.length - 1, Math.floor(rng.next() * c.length))];
    const total = w.reduce((a, x) => a + Math.max(0, x), 0);
    let u = rng.next() * total;
    for (let i = 0; i < c.length; i++) { u -= Math.max(0, w[i] ?? 0); if (u < 0) return c[i]; }
    return c[c.length - 1];
  }
  throw new Error(`unknown distribution ${JSON.stringify(d)}`);
}

/** Problems with a distribution (empty when it is fine). `numeric`: it must produce numbers. */
export function checkDist(d: unknown, path: string, numeric = true): string[] {
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (!isObj(d)) return (numeric ? num(d) : num(d) || typeof d === 'string' || typeof d === 'boolean') ? [] : [`${path}: expected a ${numeric ? 'number' : 'value'} or a distribution`];
  const keys = Object.keys(d);
  const pair = (x: unknown) => Array.isArray(x) && x.length === 2 && num(x[0]) && num(x[1]);
  if ('uniform' in d) return pair(d.uniform) && (d.uniform as number[])[0] <= (d.uniform as number[])[1] ? [] : [`${path}.uniform: expected [min, max]`];
  if ('loguniform' in d) return pair(d.loguniform) && (d.loguniform as number[])[0] > 0 && (d.loguniform as number[])[0] <= (d.loguniform as number[])[1] ? [] : [`${path}.loguniform: expected [min, max] with 0 < min <= max`];
  if ('normal' in d) return pair(d.normal) && (d.normal as number[])[1] >= 0 && (d.min === undefined || num(d.min)) && (d.max === undefined || num(d.max)) ? [] : [`${path}.normal: expected [mean, sd >= 0] and numeric min / max`];
  if ('choice' in d) {
    const c = d.choice;
    if (!Array.isArray(c) || !c.length) return [`${path}.choice: expected a non-empty list`];
    if (numeric && !c.every(num)) return [`${path}.choice: expected numbers`];
    if (d.weights !== undefined && !(Array.isArray(d.weights) && d.weights.length === c.length && d.weights.every((w) => num(w) && w >= 0))) return [`${path}.weights: one weight >= 0 per choice`];
    return [];
  }
  return [`${path}: unknown distribution (${keys.join(', ') || 'empty'}): use uniform, normal, loguniform or choice`];
}

/** Randomization of the drone: whole presets, single components, and the build's own numbers. */
export interface DroneDist {
  /** fly one of these presets (names from PRESETS); unset: the scenario's drone */
  preset?: Dist<string>;
  /** components by catalogue id: frame, motor, prop, battery, esc, fc, video */
  parts?: Partial<Record<'frame' | 'motor' | 'prop' | 'battery' | 'esc' | 'fc' | 'video', Dist<string>>>;
  /** builder overrides (Overrides: massScale, inertiaScale, propThrustScale, kv, ...) */
  overrides?: Partial<Record<keyof Overrides, Dist<number>>>;
  cameraUptiltDeg?: Dist<number>;
  batterySoc?: Dist<number>;
  batteryAge?: Dist<number>;
  extraMassG?: Dist<number>;
  extraMassZmm?: Dist<number>;
  motorTiltDeg?: Dist<number>;
  /** a new unit per episode: its own IMU offsets, cell spread and arm detuning (default true) */
  unit?: boolean;
}

/** Randomization of the conditions (SimSettings fields; wind by its parts). */
export interface SimDist {
  windSpeed?: Dist<number>;
  windDirection?: Dist<number>;
  windTurbulence?: Dist<number>;
  windGusts?: Dist<number>;
  ambientC?: Dist<number>;
  propwash?: Dist<number>;
  rcLinkHz?: Dist<number>;
  rcTxPowerMw?: Dist<number>;
}

/** Randomization of the start: offsets from the start pose, and the initial motion. */
export interface StartDist {
  dx?: Dist<number>; dy?: Dist<number>; dz?: Dist<number>;
  yawDeg?: Dist<number>;
}

export interface Randomization {
  drone?: DroneDist;
  sim?: SimDist;
  start?: StartDist;
  ops?: OpsDist;
}

const PART_KEYS = ['frame', 'motor', 'prop', 'battery', 'esc', 'fc', 'video'] as const;

/**
 * A drone build drawn from `d`, based on `base` (the scenario's drone). Component ids and preset
 * names are not checked here: the scenario validator does that, and the builder rejects unknown ids.
 */
export function sampleBuild(base: DroneSpec, d: DroneDist | undefined, rng: Rng): DroneSpec {
  let spec: DroneSpec = structuredClone(base);
  if (!d) return spec;
  if (d.preset !== undefined) {
    const name = sample(d.preset, rng);
    const p = PRESETS.find((x) => x.name === name);
    if (!p) throw new Error(`randomize.drone.preset: no preset named "${name}"`);
    spec = structuredClone(p);
  }
  for (const k of PART_KEYS) { const pd = d.parts?.[k]; if (pd !== undefined) spec[k] = sample(pd, rng); }
  if (d.overrides) {
    const ov = { ...spec.overrides } as Record<string, number>;
    for (const [k, v] of Object.entries(d.overrides)) if (v !== undefined) ov[k] = sample(v, rng);
    spec.overrides = ov;
  }
  if (d.cameraUptiltDeg !== undefined) spec.cameraUptiltDeg = sample(d.cameraUptiltDeg, rng);
  if (d.batterySoc !== undefined) spec.batterySoc = Math.min(1, Math.max(0.05, sample(d.batterySoc, rng)));
  if (d.batteryAge !== undefined) spec.batteryAge = Math.min(5, Math.max(1, sample(d.batteryAge, rng)));
  if (d.extraMassG !== undefined) spec.extraMassG = Math.max(0, sample(d.extraMassG, rng));
  if (d.extraMassZmm !== undefined) spec.extraMassZmm = sample(d.extraMassZmm, rng);
  if (d.motorTiltDeg !== undefined) spec.motorTiltDeg = sample(d.motorTiltDeg, rng);
  if (d.unit !== false) spec.unitSeed = Math.floor(rng.next() * 4294967296);
  return spec;
}

/** Settings with the randomized conditions drawn. */
export function sampleSim(base: SimSettings, d: SimDist | undefined, rng: Rng): SimSettings {
  const s: SimSettings = { ...base, wind: { ...base.wind } };
  if (!d) return s;
  if (d.windSpeed !== undefined) s.wind.speed = Math.max(0, sample(d.windSpeed, rng));
  if (d.windDirection !== undefined) s.wind.direction = ((sample(d.windDirection, rng) % 360) + 360) % 360;
  if (d.windTurbulence !== undefined) s.wind.turbulence = Math.max(0, sample(d.windTurbulence, rng));
  if (d.windGusts !== undefined) s.wind.gusts = Math.max(0, sample(d.windGusts, rng));
  if (d.ambientC !== undefined) s.ambientC = sample(d.ambientC, rng);
  if (d.propwash !== undefined) s.propwash = Math.max(0, sample(d.propwash, rng));
  if (d.rcLinkHz !== undefined) s.rcLinkHz = sample(d.rcLinkHz, rng);
  if (d.rcTxPowerMw !== undefined) s.rcTxPowerMw = Math.max(1, sample(d.rcTxPowerMw, rng));
  return s;
}

/** Start offsets drawn (zeros where the scenario randomizes nothing). */
export function sampleStart(d: StartDist | undefined, rng: Rng): { dx: number; dy: number; dz: number; yawDeg: number } {
  const v = (x: Dist<number> | undefined) => (x === undefined ? 0 : sample(x, rng));
  return { dx: v(d?.dx), dy: v(d?.dy), dz: v(d?.dz), yawDeg: v(d?.yawDeg) };
}

/** Randomization of the operational environment (scenario `randomize.ops`). */
export interface OpsDist {
  /** keep this many of the listed faults, picked at random (the rest never happen) */
  faultPick?: number;
  /** every fault starts at a time drawn from this (s) */
  faultAt?: Dist<number>;
  /** every motor fault hits a motor drawn from this (1-based) */
  faultMotor?: Dist<number>;
  /** every emitter's power is scaled by a draw from this */
  erpScale?: Dist<number>;
  /** every emitter moves by a draw from this along x and along y (m) */
  emitterOffsetM?: Dist<number>;
  /** the payload's mass (g) */
  payloadMassG?: Dist<number>;
}

/** An ops configuration with its randomization drawn (a copy; the scenario is untouched). */
export function sampleOps(base: OpsConfig, d: OpsDist | undefined, rng: Rng): OpsConfig {
  const o: OpsConfig = structuredClone(base);
  if (!d) return o;
  if (o.faults?.length) {
    let f = o.faults;
    if (d.faultPick !== undefined && d.faultPick < f.length) {
      const idx = f.map((_, i) => i);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      f = idx.slice(0, d.faultPick).sort((a, b) => a - b).map((i) => f[i]);
    }
    for (const x of f) {
      if (d.faultAt !== undefined) x.at = Math.max(0, sample(d.faultAt, rng));
      if (d.faultMotor !== undefined && x.motor !== undefined) x.motor = Math.round(sample(d.faultMotor, rng));
    }
    o.faults = f;
  }
  for (const e of o.emitters ?? []) {
    if (d.erpScale !== undefined) e.erpW *= Math.max(0, sample(d.erpScale, rng));
    if (d.emitterOffsetM !== undefined) { e.pos = [e.pos[0] + sample(d.emitterOffsetM, rng), e.pos[1] + sample(d.emitterOffsetM, rng), e.pos[2]]; }
  }
  if (o.payload && d.payloadMassG !== undefined) o.payload.massG = Math.max(1, sample(d.payloadMassG, rng));
  return o;
}
