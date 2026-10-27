// Fault injection: what can fail on a drone, when, and how badly. A fault list is part of a
// scenario (or sent over the control API, or set in the app) and the flight core applies each
// fault at its time (src/worker/ops.ts), where the hardware it models sits: a failed motor is a dead
// ESC output, a gyro fault is in the samples Betaflight (or an external autopilot) reads, a GPS
// fault is in what the receiver reports, an RC loss is packets that never arrive. The real
// firmware then reacts to it as it would in flight (failsafe, GPS rescue, a desperate mixer).

export const FAULT_KINDS = {
  motor_failure: 'the motor stops (dead ESC output or motor): `motor` 1..n',
  motor_degraded: 'the motor delivers `value` (0..1) of its commanded power: `motor`',
  prop_damage: 'the prop loses `value` (0..1) of its thrust; 1 = the prop breaks (permanent): `motor`',
  gyro_bias: 'gyro offset of `value` deg/s on `axis`',
  gyro_noise: 'extra gyro noise, `value` deg/s RMS, on `axis`',
  gyro_stuck: 'the gyro output freezes on `axis`',
  acc_bias: 'accelerometer offset of `value` m/s² on `axis`',
  baro_drift: 'the barometric altitude drifts at `value` m/s',
  baro_failure: 'the barometer output freezes',
  gps_loss: 'the GNSS receiver loses every satellite',
  gps_degraded: 'the GNSS error grows `value` times (multipath, a bad antenna)',
  mag_interference: 'magnetometer offset of `value` gauss on `axis`',
  rc_loss: 'the RC link is cut: no packet arrives',
  video_loss: 'the video link is lost',
  battery_degraded: 'the pack ages in an instant: resistance x `value`, capacity / `value` (a failing cell; permanent)',
  payload_release: 'release the payload (an event, not a failure)',
} as const;
export type FaultKind = keyof typeof FAULT_KINDS;

export type Axis = 'x' | 'y' | 'z' | 'all';

export interface FaultSpec {
  /** start time (s from the start of the episode, or of when the faults were sent) */
  at: number;
  /** how long it lasts (s); default: to the end (permanent kinds ignore it) */
  duration?: number;
  kind: FaultKind;
  /** motor number, 1-based in Betaflight's order (motor 1 = rear right on a quad X) */
  motor?: number;
  axis?: Axis;
  value?: number;
}

/** The kinds that need a motor, an axis, or a value. */
const NEEDS_MOTOR: FaultKind[] = ['motor_failure', 'motor_degraded', 'prop_damage'];
const NEEDS_AXIS: FaultKind[] = ['gyro_bias', 'gyro_noise', 'gyro_stuck', 'acc_bias', 'mag_interference'];
const NEEDS_VALUE: FaultKind[] = ['motor_degraded', 'prop_damage', 'gyro_bias', 'gyro_noise', 'acc_bias', 'baro_drift', 'gps_degraded', 'mag_interference', 'battery_degraded'];
export const PERMANENT: FaultKind[] = ['prop_damage', 'battery_degraded', 'payload_release'];

/** Check a fault list; returns the problems (path-prefixed). */
export function checkFaults(raw: unknown, path = 'faults', motors = 8): string[] {
  const errs: string[] = [];
  if (!Array.isArray(raw)) return [`${path}: expected a list of faults`];
  raw.forEach((f, i) => {
    const p = `${path}[${i}]`;
    if (typeof f !== 'object' || f === null || Array.isArray(f)) { errs.push(`${p}: expected an object`); return; }
    const o = f as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['at', 'duration', 'kind', 'motor', 'axis', 'value'].includes(k)) errs.push(`${p}.${k}: unknown key`);
    if (!(typeof o.at === 'number' && Number.isFinite(o.at) && o.at >= 0)) errs.push(`${p}.at: expected seconds >= 0`);
    if (o.duration !== undefined && !(typeof o.duration === 'number' && o.duration > 0)) errs.push(`${p}.duration: expected seconds > 0`);
    if (typeof o.kind !== 'string' || !(o.kind in FAULT_KINDS)) { errs.push(`${p}.kind: one of ${Object.keys(FAULT_KINDS).join(', ')}`); return; }
    const kind = o.kind as FaultKind;
    if (NEEDS_MOTOR.includes(kind) && !(Number.isInteger(o.motor) && (o.motor as number) >= 1 && (o.motor as number) <= motors)) errs.push(`${p}.motor: expected a motor number 1..${motors}`);
    if (o.axis !== undefined && !['x', 'y', 'z', 'all'].includes(o.axis as string)) errs.push(`${p}.axis: x, y, z or all`);
    if (NEEDS_AXIS.includes(kind) && o.axis === undefined) errs.push(`${p}.axis: required for ${kind}`);
    if (NEEDS_VALUE.includes(kind) && !(typeof o.value === 'number' && Number.isFinite(o.value))) errs.push(`${p}.value: required for ${kind}`);
    if ((kind === 'motor_degraded' || kind === 'prop_damage') && typeof o.value === 'number' && (o.value < 0 || o.value > 1)) errs.push(`${p}.value: 0..1`);
    if ((kind === 'gps_degraded' || kind === 'battery_degraded') && typeof o.value === 'number' && o.value < 1) errs.push(`${p}.value: >= 1`);
  });
  return errs;
}

/** Axis selector as an index list. */
export const axes = (a: Axis | undefined): number[] => (a === 'x' ? [0] : a === 'y' ? [1] : a === 'z' ? [2] : [0, 1, 2]);
