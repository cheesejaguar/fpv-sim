// The API's vocabulary, shared by the headless environment and the live game: actions (what a pilot
// or a program does with the sticks and switches), observations (what it gets back), the fixed
// numeric layout of an observation, and the proximity probes. No simulation code: the browser loads
// this without the flight core.
import type { FlightMode } from '../scenario/scenario';
import type { V3 } from '../sim/math';

/** Channel values (µs) of the simulator's mode mapping (src/bf/defaults.ts). */
export const AUX = { arm: 4, mode: 5, turtle: 6, beeper: 7 } as const;
export const MODE_US: Record<FlightMode, number> = { acro: 1000, horizon: 1500, angle: 2000 };

/**
 * What the pilot does for one control period. Sticks are normalized: roll, pitch, yaw in [-1, 1]
 * (right / forward / clockwise positive, as on a Mode 2 radio), throttle in [0, 1]; or raw RC
 * channels in µs (`rc`, up to 16, AETR order) for full control. arm / mode / turtle / beeper set the
 * AUX switches (they stay where they were left).
 */
export interface Action {
  roll?: number; pitch?: number; yaw?: number; throttle?: number;
  rc?: number[];
  arm?: boolean;
  mode?: FlightMode;
  turtle?: boolean;
  beeper?: boolean;
}

export interface Observation {
  /** episode time (s) */
  t: number;
  /** position (m, ENU: x east, y north, z up), velocity (m/s, world) */
  pos: [number, number, number]; vel: [number, number, number];
  /** attitude quaternion w, x, y, z (body FLU -> world ENU) */
  quat: [number, number, number, number];
  /** roll, pitch, yaw (rad): roll right-wing-down positive, pitch nose-up positive, yaw (heading) counter-clockwise from east */
  euler: [number, number, number];
  /** true body rates (rad/s, FLU) and the gyro as the flight controller reads it (noise, bias, vibration) */
  rates: [number, number, number]; gyro: [number, number, number];
  /** specific force from the accelerometer (m/s², body FLU); null in the live game */
  acc: [number, number, number] | null;
  /** motor speeds (rpm) and Betaflight's motor commands (DShot 0..2047) */
  motorRpm: number[]; motorCmd: number[];
  /** the RC channels Betaflight last received (µs): roll, pitch, throttle, yaw */
  rc: [number, number, number, number];
  battery: { v: number; i: number; soc: number; mah: number; cellV: number };
  armed: boolean;
  armingFlags: string[];
  /** height above the ground below (m) */
  agl: number;
  /** where the task wants the quad next (world, m) and that vector in the body frame; null when none */
  goal: [number, number, number] | null; goalBody: [number, number, number] | null;
  /** proximity probes: distance (m) along each probe direction (probeDirs), probeRangeM when nothing is hit */
  probes: number[];
  /** next gate of the course (index), gates in the course */
  gate: { next: number; total: number };
  /** peak impact speed in this step (m/s, 0 = none) and total prop damage */
  impact: number; damage: number;
}

/** Write an action into RC channels (µs): the given sticks and switches change, the rest stay. */
export function applyAction(rc: Float32Array, a: Action): void {
  if (a.rc) for (let i = 0; i < Math.min(16, a.rc.length); i++) if (Number.isFinite(a.rc[i])) rc[i] = a.rc[i];
  const axis = (x: number | undefined, i: number) => { if (x !== undefined && Number.isFinite(x)) rc[i] = 1500 + 500 * Math.max(-1, Math.min(1, x)); };
  axis(a.roll, 0); axis(a.pitch, 1); axis(a.yaw, 3);
  if (a.throttle !== undefined && Number.isFinite(a.throttle)) rc[2] = 1000 + 1000 * Math.max(0, Math.min(1, a.throttle));
  if (a.arm !== undefined) rc[AUX.arm] = a.arm ? 1900 : 1000;
  if (a.mode !== undefined) rc[AUX.mode] = MODE_US[a.mode];
  if (a.turtle !== undefined) rc[AUX.turtle] = a.turtle ? 1900 : 1000;
  if (a.beeper !== undefined) rc[AUX.beeper] = a.beeper ? 1900 : 1000;
}

/** Unit vectors on a Fibonacci sphere (body frame), as HyperDrone's collision probes. */
export function probeDirections(n: number): V3[] {
  const out: V3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(Math.max(0, 1 - z * z)), a = i * ga;
    out.push({ x: r * Math.cos(a), y: r * Math.sin(a), z });
  }
  return out;
}

/** Fixed-order numeric vector of an observation (the layout obsVectorLabels names). */
export function obsVector(o: Observation): number[] {
  const g = o.goalBody ?? [0, 0, 0];
  return [...o.pos, ...o.vel, ...o.quat, ...o.rates, ...o.gyro, ...(o.acc ?? [0, 0, 0]), ...o.motorRpm.map((r) => r / 10000), o.battery.cellV, o.armed ? 1 : 0, o.agl, ...g, ...o.probes];
}

export function obsVectorLabels(probes: number): string[] {
  const xyz = (p: string) => [`${p}.x`, `${p}.y`, `${p}.z`];
  return [...xyz('pos'), ...xyz('vel'), 'quat.w', 'quat.x', 'quat.y', 'quat.z', ...xyz('rates'), ...xyz('gyro'), ...xyz('acc'),
    'rpm0/1e4', 'rpm1/1e4', 'rpm2/1e4', 'rpm3/1e4', 'cellV', 'armed', 'agl', ...xyz('goalBody'), ...Array.from({ length: probes }, (_, i) => `probe${i}`)];
}

export function rot(q: { w: number; x: number; y: number; z: number }, v: V3): V3 {
  // v' = q v q*
  const { w, x, y, z } = q;
  const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
  return { x: v.x + w * tx + (y * tz - z * ty), y: v.y + w * ty + (z * tx - x * tz), z: v.z + w * tz + (x * ty - y * tx) };
}
export function rotInv(q: { w: number; x: number; y: number; z: number }, v: V3): V3 { return rot({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, v); }
