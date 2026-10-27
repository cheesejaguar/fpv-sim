// Digital twin from a real flight log: take a Betaflight blackbox log (.bbl) recorded on the real
// drone, rebuild the firmware's tune from the log's own headers, fly the same stick inputs through
// the simulator (the same Betaflight, high above the ground so the flight can't hit anything), and
// compare log with log: the simulator's own blackbox, decoded by the same decoder, against the real
// one. That gives
//   - a sim-to-real gap report: per axis, how far the simulated gyro is from the real one, how
//     each tracks its setpoint and with what delay, motor output levels (thrust and weight),
//     high-frequency gyro noise (vibration);
//   - a fitted twin: the build's override scales (mass, inertia, thrust, prop torque, drag...)
//     adjusted by Nelder–Mead until the simulated flight matches the log, returned as a drone spec
//     the app, scenarios and campaigns load directly.
// The comparison runs on the firmware's own signals, so filtering, PID and mixer behaviour are the
// same on both sides; what remains is the plant.
import { DroneSpec, Overrides } from '../builder/derive';
import type { FpvEnv } from '../headless/env';
import type { Scenario } from '../scenario/scenario';
import { BblLog, bblSeries, BblSeries, decodeBbl } from './bblDecode';

// ---- the tune, from the log's headers ----

const LIST3: Record<string, [string, string, string]> = {
  rc_rates: ['roll_rc_rate', 'pitch_rc_rate', 'yaw_rc_rate'],
  rc_expo: ['roll_expo', 'pitch_expo', 'yaw_expo'],
  rates: ['roll_srate', 'pitch_srate', 'yaw_srate'],
  rate_limits: ['roll_rate_limit', 'pitch_rate_limit', 'yaw_rate_limit'],
  rollPID: ['p_roll', 'i_roll', 'd_roll'],
  pitchPID: ['p_pitch', 'i_pitch', 'd_pitch'],
  yawPID: ['p_yaw', 'i_yaw', 'd_yaw'],
  ff_weight: ['f_roll', 'f_pitch', 'f_yaw'],
  d_min: ['d_min_roll', 'd_min_pitch', 'd_min_yaw'],
};
const PAIRS: Record<string, [string, string]> = {
  dterm_lpf1_dyn_hz: ['dterm_lpf1_dyn_min_hz', 'dterm_lpf1_dyn_max_hz'],
  gyro_lpf1_dyn_hz: ['gyro_lpf1_dyn_min_hz', 'gyro_lpf1_dyn_max_hz'],
  gyro_notch_hz: ['gyro_notch1_hz', 'gyro_notch2_hz'],
  gyro_notch_cutoff: ['gyro_notch1_cutoff', 'gyro_notch2_cutoff'],
};
const ENUMS: Record<string, string[]> = {
  rates_type: ['BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK'],
  dterm_lpf1_type: ['PT1', 'BIQUAD', 'PT2', 'PT3'], dterm_lpf2_type: ['PT1', 'BIQUAD', 'PT2', 'PT3'],
  gyro_lpf1_type: ['PT1', 'BIQUAD', 'PT2', 'PT3'], gyro_lpf2_type: ['PT1', 'BIQUAD', 'PT2', 'PT3'],
  iterm_relax: ['OFF', 'RP', 'RPY', 'RP_INC', 'RPY_INC'], iterm_relax_type: ['GYRO', 'SETPOINT'],
  tpa_mode: ['PD', 'D'], feedforward_averaging: ['OFF', '2_POINT', '3_POINT', '4_POINT'],
};
/** Plain numeric settings whose header name is the CLI name. */
const SCALARS = [
  'dterm_lpf1_static_hz', 'dterm_lpf2_static_hz', 'dterm_lpf1_dyn_expo', 'yaw_lowpass_hz', 'dterm_notch_hz', 'dterm_notch_cutoff',
  'gyro_lpf1_static_hz', 'gyro_lpf2_static_hz', 'gyro_lpf1_dyn_expo', 'dyn_notch_max_hz', 'dyn_notch_min_hz', 'dyn_notch_count', 'dyn_notch_q',
  'rpm_filter_harmonics', 'rpm_filter_q', 'rpm_filter_min_hz', 'rpm_filter_fade_range_hz', 'rpm_filter_lpf_hz',
  'iterm_windup', 'iterm_relax_cutoff', 'anti_gravity_gain', 'anti_gravity_cutoff_hz', 'anti_gravity_p_gain', 'abs_control_gain',
  'feedforward_transition', 'feedforward_averaging', 'feedforward_smooth_factor', 'feedforward_jitter_factor', 'feedforward_boost', 'feedforward_max_rate_limit',
  'd_max_gain', 'd_max_advance', 'tpa_rate', 'tpa_breakpoint', 'tpa_low_rate', 'tpa_low_breakpoint', 'pidsum_limit', 'pidsum_limit_yaw',
  'thrust_linear', 'throttle_boost', 'throttle_boost_cutoff', 'motor_output_limit', 'dshot_idle_value', 'thr_mid', 'thr_expo',
  'dyn_idle_min_rpm', 'dyn_idle_p_gain', 'dyn_idle_i_gain', 'dyn_idle_d_gain', 'dyn_idle_max_increase', 'dyn_idle_start_increase',
  'vbat_sag_compensation', 'angle_limit',
];

/**
 * Betaflight CLI lines that rebuild the log's tune (PIDs, rates, filters, feedforward, TPA,
 * anti-gravity, dynamic idle...) from its headers. Simplified tuning is turned off so the logged
 * PID values stand as they are.
 */
export function tuneFromLog(h: Record<string, string>): string[] {
  const out: string[] = ['set simplified_pids_mode = OFF', 'set simplified_dterm_filter = OFF', 'set simplified_gyro_filter = OFF'];
  const nums = (v: string) => v.split(',').map((x) => x.trim()).filter((x) => /^-?\d+$/.test(x));
  for (const [k, names] of Object.entries(LIST3)) { const v = h[k]; if (v === undefined) continue; nums(v).slice(0, 3).forEach((x, i) => out.push(`set ${names[i]} = ${x}`)); }
  for (const [k, names] of Object.entries(PAIRS)) { const v = h[k]; if (v === undefined) continue; nums(v).slice(0, 2).forEach((x, i) => out.push(`set ${names[i]} = ${x}`)); }
  for (const [k, names] of Object.entries(ENUMS)) {
    const v = h[k];
    if (v === undefined || !/^\d+$/.test(v.trim())) continue;
    const n = names[Number(v)];
    if (n) out.push(`set ${k} = ${n}`);
  }
  for (const k of SCALARS) { const v = h[k]; if (v !== undefined && /^-?\d+$/.test(v.trim()) && !(k in ENUMS)) out.push(`set ${k} = ${v.trim()}`); }
  return out;
}

// ---- segments and resampling ----

export interface Segment { fromS: number; toS: number }

/** The first stretch of real flight (motors well above idle for half a second), at most maxS long. */
export function autoSegment(s: BblSeries, maxS = 8): Segment {
  const n = s.t.length, avg = (i: number) => s.motor.reduce((a, m) => a + m[i], 0) / s.motor.length;
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (avg(i) > 0.12) { if (start < 0) start = i; if (s.t[i] - s.t[start] >= 0.5) break; } else start = -1;
  }
  const from = start >= 0 ? s.t[start] + 0.5 : 0;
  return { fromS: from, toS: Math.min(s.t[n - 1], from + maxS) };
}

/** Linear interpolation of a series at time t (seconds, sorted ts). */
function at(ts: Float64Array, ys: Float64Array, t: number, hint = { i: 0 }): number {
  let i = hint.i;
  if (i >= ts.length || ts[i] > t) i = 0;
  while (i + 1 < ts.length && ts[i + 1] <= t) i++;
  hint.i = i;
  if (i + 1 >= ts.length) return ys[ts.length - 1];
  const a = ts[i], b = ts[i + 1];
  return b > a ? ys[i] + ((ys[i + 1] - ys[i]) * (t - a)) / (b - a) : ys[i];
}

/** Resample a series onto a grid (1 kHz from t0, n points). */
function grid(ts: Float64Array, ys: Float64Array, t0: number, n: number, dt = 0.001): Float64Array {
  const o = new Float64Array(n), h = { i: 0 };
  for (let k = 0; k < n; k++) o[k] = at(ts, ys, t0 + k * dt, h);
  return o;
}

// ---- replay ----

/** Betaflight's min_check (µs): the throttle below it is the bottom of the stick (default 1050). */
const MIN_CHECK = 1050;

export interface ReplayOptions {
  spec: DroneSpec;
  /** CLI lines for the firmware (default: the tune rebuilt from the log's headers) */
  cli?: string[];
  segment?: Segment;
  seed?: number;
  /** extra height above the replay altitude (m) */
  heightM?: number;
  /** trim the throttle so the simulated height follows the log's baroAlt (default true, when logged) */
  matchAltitude?: boolean;
}

/** Fly the log's sticks through the simulator; returns the simulator's own blackbox log of it. */
export async function replayLog(env: FpvEnv, real: BblLog, o: ReplayOptions): Promise<{ sim: BblLog; segment: Segment; cliErrors: string[] }> {
  const s = bblSeries(real);
  if (!s.rcCommand) throw new Error('the log has no rcCommand fields (needed to replay its sticks)');
  const seg = o.segment ?? autoSegment(s);
  const dur = seg.toS - seg.fromS;
  if (!(dur > 0.5)) throw new Error('the log has no stretch of flight to replay');
  const sc: Scenario = {
    format: 'fpvsim-scenario', version: 1, seed: o.seed ?? 1,
    map: { id: 'field' }, drone: { spec: o.spec },
    sim: { wind: { speed: 0, direction: 0, turbulence: 0, gusts: 0 }, damage: false },
    firmware: { cli: o.cli ?? tuneFromLog(real.headers) },
    start: { armed: true, mode: 'acro', pos: [0, 0, 150 + (o.heightM ?? 0)] },
    episode: { maxSeconds: dur + 0.5, controlHz: 1000, endOnCrash: false, endOutOfBounds: false },
  };
  const r = await env.reset({ scenario: sc });
  const chunks: Uint8Array[] = [];
  env.core.hooks.blackbox = (b) => { if (b.length) chunks.push(b.slice()); };
  const rc = s.rcCommand, h = [{ i: 0 }, { i: 0 }, { i: 0 }, { i: 0 }, { i: 0 }];
  const steps = Math.round(dur * 1000);
  // Altitude-matched throttle: in an open-loop replay a drone with another thrust-to-weight climbs
  // or sinks away from the real one, and climb speed changes what each prop delivers (an
  // accelerometer can't see it: any steady climb reads 1 g). A trim on the throttle keeps the
  // simulated height change on the logged barometric one, so both fly the same vertical profile and
  // the difference shows where it belongs: in the motor outputs that profile took (compareLogs'
  // motor term).
  const baro = o.matchAltitude === false ? null : real.main.baroAlt;
  const z0 = env.core.quad.s.pos.z, alt0 = baro ? at(s.t, baro, seg.fromS) / 100 : 0;
  let trim = 0, vr = 0, prevAlt = NaN;
  for (let k = 0; k < steps; k++) {
    const t = seg.fromS + (k + 0.5) / 1000;
    // rcCommand: roll / pitch stick deflection (µs from centre), yaw negated (Betaflight's
    // updateRcCommands flips it); throttle as Betaflight rescaled it from min_check
    // (rcLookupThrottle): back to the receiver's µs
    const roll = 1500 + at(s.t, rc[0], t, h[0]), pitch = 1500 + at(s.t, rc[1], t, h[1]), yaw = 1500 - at(s.t, rc[2], t, h[2]);
    const thr = MIN_CHECK + ((at(s.t, rc[3], t, h[3]) - 1000) * (2000 - MIN_CHECK)) / 1000;
    let u = 0;
    if (baro) {
      // the logged height change (BF's own filtered baro), its rate through a 0.3 s low-pass
      const alt = at(s.t, baro, t, h[4]) / 100 - alt0;
      if (!Number.isNaN(prevAlt)) vr += ((alt - prevAlt) * 1000 - vr) * (0.001 / 0.3);
      prevAlt = alt;
      const q = env.core.quad.s, e = alt - (q.pos.z - z0), ev = vr - q.vel.z;
      trim = Math.max(-300, Math.min(300, trim + 10 * e * 0.001));
      u = trim + 15 * e + 25 * ev;
    }
    env.step({ rc: [roll, pitch, Math.max(1000, Math.min(2000, thr + u)), yaw] });
  }
  // disarm: Betaflight closes the log
  for (let k = 0; k < 60; k++) env.step({ arm: false, rc: [1500, 1500, 1000, 1500] });
  env.core.hooks.blackbox = undefined;
  const bytes = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let off = 0; for (const c of chunks) { bytes.set(c, off); off += c.length; }
  const logs = decodeBbl(bytes).filter((l) => l.frameCount > 10);
  if (!logs.length) throw new Error('the simulator produced no blackbox log');
  return { sim: logs[logs.length - 1], segment: seg, cliErrors: r.info.cliErrors };
}

// ---- comparison ----

export interface AxisGap {
  /** RMS of simulated minus real gyro below ~40 Hz (deg/s), and the real gyro's RMS for scale */
  gyroErrRms: number; gyroRms: number;
  /** correlation of the simulated and real gyro */
  corr: number;
  /** RMS of gyro minus setpoint (tracking error), real and simulated (deg/s) */
  trackRms: { real: number; sim: number };
  /** delay from setpoint to gyro (ms), real and simulated */
  lagMs: { real: number; sim: number };
  /** gyro noise above ~100 Hz (deg/s RMS), real and simulated: vibration and filtering */
  noiseRms: { real: number; sim: number };
  /**
   * the controller's effort (P + I + D + feedforward, below ~10 Hz): RMS of the difference and the
   * real effort's RMS. The PID loop makes both drones track their setpoints; what it took to do so
   * is where inertia, thrust and torque authority show
   */
  effortErrRms: number; effortRms: number;
}

export interface GapReport {
  segment: Segment;
  /** seconds compared */
  seconds: number;
  /** where the simulated log sits on the real one's clock (s) */
  offsetS: number;
  axes: { roll: AxisGap; pitch: AxisGap; yaw: AxisGap };
  /** mean motor output (0..1): real vs simulated (hover thrust balance: weight against thrust) */
  motorMean: { real: number; sim: number };
  /** RMS difference of the four-motor average */
  motorErrRms: number;
  /**
   * vertical specific force along the body z axis (g, the accelerometer): thrust over mass. In acro
   * the throttle sets the motors, so a heavier or weaker drone shows here, not in the motor outputs
   */
  accZ: { real: number; sim: number; errRms: number } | null;
  /** the single number the fit minimises */
  cost: number;
}

const rms = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); };
const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / Math.max(1, a.length); };
const sub = (a: Float64Array, b: Float64Array) => a.map((x, i) => x - b[i]);
function corr(a: Float64Array, b: Float64Array) {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
/** Lag (samples, 0..max) at which y best follows x. */
function lag(x: Float64Array, y: Float64Array, max: number): number {
  let best = 0, bv = -Infinity;
  for (let L = 0; L <= max; L++) {
    let s = 0;
    for (let i = 0; i + L < x.length; i++) s += x[i] * y[i + L];
    if (s > bv) { bv = s; best = L; }
  }
  return best;
}
/** Low-pass: a centred 11 ms moving average (first null ~90 Hz, -3 dB ~40 Hz). */
function lp(a: Float64Array, w = 5): Float64Array {
  const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) { let s = 0, c = 0; for (let j = Math.max(0, i - w); j <= Math.min(a.length - 1, i + w); j++) { s += a[j]; c++; } o[i] = s / c; }
  return o;
}

/** High-pass by subtracting a 5 ms moving average. */
function hp(a: Float64Array, w = 5): Float64Array {
  const o = new Float64Array(a.length);
  let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= w) s -= a[i - w]; o[i] = a[i] - s / Math.min(i + 1, w); }
  return o;
}

/** Compare the simulated log with the real one over the segment. */
export function compareLogs(real: BblLog, sim: BblLog, seg: Segment): GapReport {
  const R = bblSeries(real), S = bblSeries(sim);
  if (!R.gyro || !S.gyro || !R.setpoint || !S.setpoint) throw new Error('both logs need gyro and setpoint fields');
  // the simulated log starts at its arming; find its offset on the real clock from the setpoints (same sticks, same rates)
  const n = Math.floor((seg.toS - seg.fromS - 0.6) * 1000);
  const t0 = seg.fromS + 0.5; // skip the first half second (the replay's start transient)
  const rSp = [0, 1, 2].map((a) => grid(R.t, R.setpoint![a], t0, n));
  let bestOff = 0, bestErr = Infinity;
  const simStart = (S.t[0] ?? 0);
  // the simulated log starts at its arming, a little before the replayed sticks: search -1 .. +0.3 s
  for (let d = -1000; d <= 300; d += 2) {
    const off = seg.fromS - simStart + d / 1000;
    let e = 0;
    for (let a = 0; a < 3; a++) { const sp = grid(S.t, S.setpoint![a], t0 - off, n); for (let i = 0; i < n; i += 4) e += (sp[i] - rSp[a][i]) ** 2; }
    if (e < bestErr) { bestErr = e; bestOff = off; }
  }
  for (let d = -2; d <= 2; d++) {
    const off = bestOff + d / 1000;
    let e = 0;
    for (let a = 0; a < 3; a++) { const sp = grid(S.t, S.setpoint![a], t0 - off, n); for (let i = 0; i < n; i++) e += (sp[i] - rSp[a][i]) ** 2; }
    if (e < bestErr) { bestErr = e; bestOff = off; }
  }
  const axis = (a: number): AxisGap => {
    const gr = grid(R.t, R.gyro![a], t0, n), gs = grid(S.t, S.gyro![a], t0 - bestOff, n);
    const sr = rSp[a], ss = grid(S.t, S.setpoint![a], t0 - bestOff, n);
    // the dynamics compare below ~30 Hz: vibration noise is uncorrelated between two flights and is
    // reported on its own (noiseRms)
    const lr = lp(gr), ls = lp(gs);
    const effort = (x: BblLog, off: number) => {
      const m = x.main, t = (x === real ? R : S).t;
      const sum = new Float64Array(m.time.length);
      for (const f of [`axisP[${a}]`, `axisI[${a}]`, `axisD[${a}]`, `axisF[${a}]`]) { const c = m[f]; if (c) for (let i = 0; i < sum.length; i++) sum[i] += c[i]; }
      return lp(grid(t, sum, t0 - off, n), 25); // ~10 Hz: the manoeuvres, not the noise P and D carry
    };
    const er = effort(real, 0), es = effort(sim, bestOff);
    return {
      effortErrRms: rms(sub(es, er)), effortRms: rms(er),
      gyroErrRms: rms(sub(ls, lr)), gyroRms: rms(lr), corr: corr(ls, lr),
      trackRms: { real: rms(sub(gr, sr)), sim: rms(sub(gs, ss)) },
      lagMs: { real: lag(sr, gr, 60), sim: lag(ss, gs, 60) },
      noiseRms: { real: rms(hp(gr)), sim: rms(hp(gs)) },
    };
  };
  const axes = { roll: axis(0), pitch: axis(1), yaw: axis(2) };
  const mAvg = (x: BblSeries, off: number) => { const g = x.motor.map((m) => grid(x.t, m, t0 - off, n)); return g[0].map((_, i) => g.reduce((s, m) => s + m[i], 0) / g.length); };
  const mr = mAvg(R, 0), ms = mAvg(S, bestOff);
  const motorMean = { real: mean(mr), sim: mean(ms) };
  const motorErrRms = rms(sub(ms, mr));
  const az = (x: BblLog, off: number) => { const c = x.main['accSmooth[2]'], t = bblSeries(x).t; return c ? grid(t, c.map((v) => v / (x.sysConfig.acc_1G || 1)), t0 - off, n) : null; };
  const ar = az(real, 0), as = az(sim, bestOff);
  const accZ = ar && as ? { real: mean(ar), sim: mean(as), errRms: rms(sub(as, ar)) } : null;
  // the rotations carry the plant's inertia, thrust and torque authority: the fit's cost. The height
  // profile is matched by the replay's throttle trim, and what that took shows in the motors
  // (motorMean): reported, not fitted, since a short log only weakly separates thrust from weight
  // there (baro lag, the start transient)
  const gyroTerm = (axes.roll.gyroErrRms / (axes.roll.gyroRms + 5) + axes.pitch.gyroErrRms / (axes.pitch.gyroRms + 5) + axes.yaw.gyroErrRms / (axes.yaw.gyroRms + 5)) / 3;
  const effortTerm = (axes.roll.effortErrRms / (axes.roll.effortRms + 5) + axes.pitch.effortErrRms / (axes.pitch.effortRms + 5) + axes.yaw.effortErrRms / (axes.yaw.effortRms + 5)) / 3;
  const cost = gyroTerm + effortTerm;
  return { segment: seg, seconds: n / 1000, offsetS: bestOff, axes, motorMean, motorErrRms, accZ, cost };
}

// ---- fitting ----

export type FitParam = 'massScale' | 'inertiaScale' | 'propThrustScale' | 'propTorqueScale' | 'cdAScale';

export interface FitResult {
  spec: DroneSpec;
  overrides: Partial<Overrides>;
  before: GapReport;
  after: GapReport;
  evals: number;
  history: { x: Record<string, number>; cost: number }[];
  cliErrors: string[];
}

/** Nelder–Mead on f over R^n (minimisation), from x0 with step `step`. */
export async function nelderMead(f: (x: number[]) => Promise<number>, x0: number[], step: number, maxEvals: number): Promise<{ x: number[]; f: number; evals: number }> {
  const n = x0.length;
  let evals = 0;
  const F = async (x: number[]) => { evals++; return f(x); };
  let simplex = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step : v)))];
  let vals: number[] = [];
  for (const p of simplex) vals.push(await F(p));
  while (evals < maxEvals) {
    const idx = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = idx.map((i) => simplex[i]); vals = idx.map((i) => vals[i]);
    if (Math.abs(vals[n] - vals[0]) < 1e-4 * (Math.abs(vals[0]) + 1e-9) && evals > 2 * n + 2) break;
    const c = x0.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p[j], 0) / n);
    const w = simplex[n];
    const xr = c.map((v, j) => v + (v - w[j])), fr = await F(xr);
    if (fr < vals[0]) {
      const xe = c.map((v, j) => v + 2 * (v - w[j])), fe = await F(xe);
      if (fe < fr) { simplex[n] = xe; vals[n] = fe; } else { simplex[n] = xr; vals[n] = fr; }
    } else if (fr < vals[n - 1]) { simplex[n] = xr; vals[n] = fr; }
    else {
      const xc = c.map((v, j) => v + 0.5 * (w[j] - v)), fc = await F(xc);
      if (fc < vals[n]) { simplex[n] = xc; vals[n] = fc; }
      else for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); vals[i] = await F(simplex[i]); }
    }
  }
  const b = vals.indexOf(Math.min(...vals));
  return { x: simplex[b], f: vals[b], evals };
}

/**
 * Fit the build's override scales so the simulated flight matches the log. `params`: which scales
 * (default thrust, inertia, prop torque: put the drone's weighed mass in the spec, since a log can
 * only show thrust over mass); they are searched in log space around the spec's own values.
 */
export async function fitTwin(env: FpvEnv, real: BblLog, o: ReplayOptions & { params?: FitParam[]; maxEvals?: number; onEval?: (x: Record<string, number>, g: GapReport) => void }): Promise<FitResult> {
  // mass and thrust (and inertia, for the rotations) only show as their ratios: weigh the drone and
  // fit the rest
  const params = o.params ?? ['propThrustScale', 'inertiaScale', 'propTorqueScale'];
  const base = { ...(o.spec.overrides ?? {}) } as Partial<Overrides>;
  const s0 = autoSegment(bblSeries(real));
  const seg = o.segment ?? s0;
  const history: FitResult['history'] = [];
  let cliErrors: string[] = [];
  const specAt = (x: number[]): DroneSpec => {
    const ov: Partial<Overrides> = { ...base };
    params.forEach((p, i) => { ov[p] = (base[p] ?? 1) * Math.exp(x[i]); });
    return { ...o.spec, overrides: ov };
  };
  const run = async (x: number[]) => {
    const sp = specAt(x);
    // (no altitude trim while fitting: its throttle changes would move Betaflight's TPA and with it the
    // rate response the fit is reading)
    const r = await replayLog(env, real, { matchAltitude: false, ...o, spec: sp, segment: seg });
    cliErrors = r.cliErrors;
    const g = compareLogs(real, r.sim, seg);
    const rec = Object.fromEntries(params.map((p, i) => [p, sp.overrides[p] as number]));
    history.push({ x: rec, cost: g.cost });
    o.onEval?.(rec, g);
    return g;
  };
  const before = await run(params.map(() => 0));
  const best = await nelderMead(async (x) => (x.some((v) => Math.abs(v) > 1.2) ? 1e3 : (await run(x)).cost), params.map(() => 0), 0.15, o.maxEvals ?? 40);
  const spec = specAt(best.x);
  const after = await run(best.x);
  return { spec, overrides: spec.overrides, before, after, evals: best.evals + 2, history, cliErrors };
}
