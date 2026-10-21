// Flight feel of the beginner whoop, from a pilot report ("a constant left roll input I can't find",
// "a snap turn when I give it yaw", ExpressLRS radio in BLE joystick mode):
//  - the quad rests level on the pad, so the accelerometer is calibrated level and Angle mode holds
//    level hands-off (a whoop used to fall onto one duct, 13° of roll, and Angle learnt that as level)
//  - contacts stay stable on small quads and at reduced physics rates
//  - yaw tracks the stick smoothly, also through a radio that reports at 60 Hz
// Firmware tests are skipped when the Betaflight WASM hasn't been built.
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildDrone, PRESETS } from '../src/builder/derive';
import { GroundPlane, MATERIALS } from '../src/sim/contact';
import { qFromEuler } from '../src/sim/math';
import { QuadEnv, QuadParams, QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { Wind, WindParams } from '../src/sim/wind';
import { ACC_CAL_REV, accBoardKey } from '../src/worker/accCal';
import { createShared, DEFAULT_SETTINGS, StickSampler, writeStick } from '../src/worker/shared';
import { applyDefaults, bfRig, BfRig, FW_URL } from './helpers/bfRig';
import { CALM, DT } from './helpers/scenarios';

const have = existsSync(FW_URL);
const DEG = 180 / Math.PI;
const WHOOP = PRESETS.find((p) => p.name.includes('65 mm'))!;
/** The app's default wind (field map: grass). */
const DEFAULT_WIND: WindParams = { speed20ft: DEFAULT_SETTINGS.wind.speed, directionDeg: DEFAULT_SETTINGS.wind.direction, z0: 0.03, turbulence: DEFAULT_SETTINGS.wind.turbulence, gustiness: DEFAULT_SETTINGS.wind.gusts, gustMax: DEFAULT_SETTINGS.wind.speed * 0.8 };
const rollPitch = (q: { w: number; x: number; y: number; z: number }) => [
  Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)) * DEG,
  Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.y - q.z * q.x)))) * DEG,
];
const env = (wind: WindParams, mat = MATERIALS.grass): QuadEnv => ({ world: new GroundPlane(mat), wind: new Wind(wind), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false });
/** The whoop as it was before the fix: no duct rims to stand on, the pack hanging below on two centre-line spheres. */
const oldWhoopPad = (p: QuadParams): QuadParams => {
  const low = Math.min(...p.colliders.map((c) => c.pos.z - c.radius));
  return {
    ...p, colliders: p.colliders
      .filter((c) => !(c.kind === 'frame' && c.pos.z - c.radius < low + 5e-4))
      .map((c) => (c.kind === 'battery' ? { ...c, pos: { ...c.pos, y: 0 } } : c)),
  };
};

describe('on the pad', () => {
  test.each(PRESETS.map((p) => [p.name, p] as const))('%s rests level after the spawn drop, in the default wind', (_n, spec) => {
    const p = buildDrone(spec).params, q = new QuadSim(p, 8000), e = env(DEFAULT_WIND);
    q.reset({ x: 0, y: 0, z: 0.06 - Math.min(...p.colliders.map((c) => c.pos.z - c.radius)) }); // as the worker spawns it
    for (let i = 0; i < 4 * 8000; i++) { q.command([0, 0, 0, 0], false); q.step(DT, e); }
    const [r, pt] = rollPitch(q.s.q);
    expect(Math.abs(r)).toBeLessThan(1); expect(Math.abs(pt)).toBeLessThan(1);
    expect(q.s.touching).toBe(true);
  });

  test('ducted frames report the duct bottom they stand on (for the 3D model)', () => {
    for (const spec of PRESETS) {
      const b = buildDrone(spec), low = Math.min(...b.params.colliders.map((c) => c.pos.z - c.radius)) + b.info.cgMm.z / 1000;
      if (!b.info.components.frame.ducted) { expect(b.info.ductBottomMm).toBeUndefined(); continue; }
      expect(b.info.ductBottomMm!, spec.name).toBeCloseTo(low * 1000, 3);
    }
  }, 60000);

  test('the old whoop collider set fell over onto one duct (what Angle mode then learnt as level)', () => {
    const p = oldWhoopPad(buildDrone(WHOOP).params), q = new QuadSim(p, 8000), e = env(DEFAULT_WIND);
    q.reset({ x: 0, y: 0, z: 0.06 - Math.min(...p.colliders.map((c) => c.pos.z - c.radius)) });
    for (let i = 0; i < 4 * 8000; i++) { q.command([0, 0, 0, 0], false); q.step(DT, e); }
    expect(Math.abs(rollPitch(q.s.q)[0])).toBeGreaterThan(10);
  });

  test.each([8000, 4000, 2000])('contacts stay stable at %i Hz: drops of a whoop and a 5" settle', (hz) => {
    const rows: string[] = [];
    for (const spec of [WHOOP, PRESETS[0]]) for (const mat of [MATERIALS.grass, MATERIALS.concrete]) {
      for (const [r0, p0, h] of [[0, 0, 0.05], [180, 0, 0.05], [20, 5, 0.1], [60, -10, 0.1], [0, 0, 1]]) {
        const p = buildDrone(spec).params, q = new QuadSim(p, hz), e = env(CALM, mat);
        q.reset({ x: 0, y: 0, z: h - Math.min(...p.colliders.map((c) => c.pos.z - c.radius)) });
        q.s.q = qFromEuler(r0 / DEG, p0 / DEG, 0);
        let wEnd = 0, zMax = 0, landed = false;
        for (let i = 1; i <= 3 * hz; i++) {
          q.command([0, 0, 0, 0], false); q.step(1 / hz, e);
          landed ||= q.s.touching;
          if (landed) zMax = Math.max(zMax, q.s.pos.z);
          if (i > 2.5 * hz) wEnd = Math.max(wEnd, Math.hypot(q.s.w.x, q.s.w.y, q.s.w.z) * DEG);
        }
        rows.push(`${spec.name.slice(0, 18)} ${mat.name} r${r0} p${p0} from ${h} m: end ${wEnd.toFixed(1)} deg/s, ${(zMax * 100).toFixed(0)} cm max after touching`);
        expect(Number.isFinite(q.s.pos.z) && !q.s.crashed, rows.at(-1)).toBe(true);
        expect(wEnd, rows.at(-1)).toBeLessThan(15);               // at rest, not rattling or spinning
        expect(zMax, rows.at(-1)).toBeLessThan(h + 0.25);        // no bounce launching it into the air
      }
    }
  }, 120000);
});

describe('accelerometer calibration bookkeeping', () => {
  test('the stored trims are tied to the simulated board: another build is recalibrated, the same one is not', () => {
    const key = (s: (typeof PRESETS)[number]) => accBoardKey(new QuadSim(buildDrone(s).params, 8000).imu);
    expect(key(WHOOP)).toBe(key(WHOOP));
    expect(key(WHOOP).startsWith(`${ACC_CAL_REV}:`)).toBe(true);
    // same FC and frame, other parts: the per-build IMU errors differ, so the old trims don't fit
    const a = PRESETS.find((p) => p.name === '5" Freestyle 6S')!, b = PRESETS.find((p) => p.name === '5" HDZero 6S')!;
    expect(a.fc).toBe(b.fc); expect(a.frame).toBe(b.frame);
    expect(key(a)).not.toBe(key(b));
    expect(new Set(PRESETS.map(key)).size).toBe(PRESETS.length);
  });
});

/** Arm in Angle (AUX2 high) or acro, climb to ~1.5 m and hold it with the throttle only (the pilot's
 *  left thumb); roll / pitch / yaw sticks centred. Returns mean roll / pitch and drift speed over 4 s. */
function handsOffHover(r: BfRig, angle: boolean) {
  r.rc[5] = angle ? 2000 : 1000;
  r.rc[4] = 1900; r.run(0.3);
  const hov = r.hoverUs();
  let trim = 0;
  r.setOnPacket(() => {
    const s = r.quad.s, e = 1.5 - s.pos.z;
    trim = Math.max(-150, Math.min(150, trim + 0.4 * e)); // the pilot settles on the real hover throttle
    r.rc[2] = Math.max(1000, Math.min(2000, hov + trim + 100 * e - 60 * s.vel.z));
  });
  r.run(4); // take off and settle
  const p0 = { ...r.quad.s.pos };
  let sr = 0, sp = 0, n = 0;
  for (let i = 0; i < 40; i++) { r.run(0.1); const [ro, pi] = rollPitch(r.quad.s.q); sr += ro; sp += pi; n++; }
  const p1 = r.quad.s.pos;
  r.setOnPacket(null);
  return { roll: sr / n, pitch: sp / n, speed: Math.hypot(p1.x - p0.x, p1.y - p0.y) / 4, side: (p1.y - p0.y) / 4, alt: p1.z };
}

describe.skipIf(!have)('hands-off hover (real Betaflight)', () => {
  test('whoop, worker-style boot on the pad: Angle holds level, no sideways drift with the wind off', async () => {
    const r = await bfRig(WHOOP);
    r.run(2); // dropped onto the pad, settles
    applyDefaults(r);
    expect(r.calibrateAccLevelled()).toBe(true);
    r.run(3);
    expect(r.bf.armingDisableFlags()).toBe(0);
    const a = handsOffHover(r, true);
    console.log(`Angle hands-off: mean roll ${a.roll.toFixed(2)}°, pitch ${a.pitch.toFixed(2)}°, drift ${a.speed.toFixed(3)} m/s, alt ${a.alt.toFixed(2)} m`);
    expect(Math.abs(a.roll)).toBeLessThan(1); expect(Math.abs(a.pitch)).toBeLessThan(1);
    expect(a.speed).toBeLessThan(0.15);
    expect(Math.abs(a.alt - 1.5)).toBeLessThan(0.5);
  }, 120000);

  test('whoop in acro: hands-off it keeps the attitude it took off with (level pad), little drift', async () => {
    const r = await bfRig(WHOOP);
    r.run(2); applyDefaults(r); r.calibrateAccLevelled(); r.run(3);
    const a = handsOffHover(r, false);
    console.log(`Acro hands-off: mean roll ${a.roll.toFixed(2)}°, pitch ${a.pitch.toFixed(2)}°, drift ${a.speed.toFixed(3)} m/s`);
    expect(Math.abs(a.roll)).toBeLessThan(2); expect(Math.abs(a.pitch)).toBeLessThan(2);
    expect(a.speed).toBeLessThan(0.3);
  }, 120000);

  test('control: calibrating where the old whoop lay (on one duct) gives the reported constant left roll', async () => {
    const r = await bfRig(WHOOP, { params: oldWhoopPad });
    r.run(3); applyDefaults(r);
    r.bf.calibrateAcc(); for (let i = 0; i < 3 / DT && r.bf.accCalibrating(); i++) r.run(DT); // the old live calibration
    r.run(3);
    const a = handsOffHover(r, true);
    console.log(`old pad + live calibration, Angle hands-off: mean roll ${a.roll.toFixed(1)}°, sideways ${a.side.toFixed(2)} m/s (+ = left)`);
    expect(Math.abs(a.roll)).toBeGreaterThan(8);
    expect(Math.abs(a.side)).toBeGreaterThan(1);
  }, 120000);
});

// ---------------------------------------------------------------------------------------------
// yaw

const rate = (us: number) => { const x = Math.max(-1, Math.min(1, (us - 1500) / 500)); return x * 70 + 600 * Math.abs(x) * x; }; // BF 4.5 default ACTUAL rates
const ss = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** A pilot's yaw flick: to 60 % stick in 80 ms, held, back; then a slower 40 % the other way. */
const flick = (t: number) => 1500 + 300 * (ss(t / 0.08) - ss((t - 0.43) / 0.08)) - 200 * (ss((t - 0.9) / 0.15) - ss((t - 1.3) / 0.2));

async function hoveringWhoop() {
  const r = await bfRig(WHOOP);
  applyDefaults(r); r.calibrateAccLevelled(); r.run(3);
  r.rc[4] = 1900; r.run(0.3);
  const hov = r.hoverUs();
  r.rc[2] = hov + 150; r.run(0.6); r.rc[2] = hov; r.run(1.0);
  return r;
}

/** Yaw rate (BF sign: nose right +) and motor spread (max - min DShot) at every physics step while fn runs. */
function record(r: BfRig, s: number) {
  const W: number[] = [], M: number[] = [];
  const h = () => { W.push(-r.quad.s.w.z * DEG); const m = r.quad.motors.map((x) => x.s.dshotCmd); M.push(Math.max(...m) - Math.min(...m)); };
  r.hooks.push(h); r.run(s); r.hooks.splice(r.hooks.indexOf(h), 1);
  return { W, M };
}
const p99 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.99)];
const yawAccel = (W: number[]) => { const a: number[] = []; for (let i = 16; i < W.length; i += 4) a.push(Math.abs(W[i] - W[i - 16]) / (16 * DT)); return a; };

describe.skipIf(!have)('whoop yaw (real Betaflight, stock 4.5 tune)', () => {
  test('a yaw step tracks the setpoint without a snap or overshoot', async () => {
    const r = await hoveringWhoop();
    const rows: string[] = [];
    for (const [us, label] of [[1750, '50 %'], [2000, '100 %'], [1625, '25 %']] as const) {
      r.rc[3] = us; const { W } = record(r, 0.6);
      const sp = rate(us), w0 = W[0];
      const t90 = W.findIndex((w) => (w - w0) / (sp - w0) >= 0.9) * DT;
      const peak = Math.max(...W), over = (peak - sp) / sp;
      rows.push(`${label} step to ${sp} deg/s: 90 % in ${(t90 * 1000).toFixed(0)} ms, peak ${peak.toFixed(0)} (${(100 * over).toFixed(0)} % over), end ${W.at(-1)!.toFixed(0)}`);
      expect(t90, rows.at(-1)).toBeGreaterThan(0.005);    // the motors / props need time: no instant jump
      expect(t90, rows.at(-1)).toBeLessThan(0.1);
      expect(over, rows.at(-1)).toBeLessThan(0.3);
      expect(Math.abs(W.at(-1)! - sp), rows.at(-1)).toBeLessThan(0.08 * sp + 10);
      r.rc[3] = 1500; record(r, 0.6);
    }
    console.log(rows.join('\n'));
  }, 120000);

  test('a yaw flick: the yaw rate follows the stick, never runs ahead of it', async () => {
    const r = await hoveringWhoop();
    const t0 = r.time();
    r.setOnPacket((t) => { r.rc[3] = flick(t - t0 - 0.0025); });
    const { W } = record(r, 1.8);
    r.setOnPacket(null);
    // the yaw rate may lag the setpoint by up to 60 ms, but never leave the band the setpoint spanned
    // over that time by more than 12 % of the flick + 15 deg/s: no snap ahead of the stick, only the
    // small bounce-back a stock yaw tune has after a stop (BF 4.5 defaults: P 45, I 80, F 120, no D)
    const sp = W.map((_, i) => rate(flick(i * DT - 0.0025))), lagN = Math.round(0.06 / DT);
    const tol = 0.12 * Math.max(...sp.map(Math.abs)) + 15;
    let worst = -Infinity, iw = 0;
    for (let i = 0; i < W.length; i++) {
      let lo = Infinity, hi = -Infinity;
      for (let j = Math.max(0, i - lagN); j <= i; j++) { lo = Math.min(lo, sp[j]); hi = Math.max(hi, sp[j]); }
      const x = Math.max(W[i] - (hi + tol), (lo - tol) - W[i]);
      if (x > worst) { worst = x; iw = i; }
    }
    const acc = Math.max(...yawAccel(W));
    console.log(`yaw flick: closest to leaving the lagged setpoint band at ${(iw * DT * 1000).toFixed(0)} ms (yaw ${W[iw].toFixed(0)}, setpoint ${sp[iw].toFixed(0)} deg/s, margin ${(-worst).toFixed(0)}), peak yaw acceleration ${(acc / 1000).toFixed(1)}k deg/s²`);
    expect(worst).toBeLessThan(0);
    // the flick itself asks for 1.5 * 258 deg/s / 80 ms = 4.8k deg/s²: tracking it, not slamming the motors
    expect(acc).toBeLessThan(15000);
  }, 120000);

  test('the same flick through a radio in BLE joystick mode (60 Hz reports): no snap', async () => {
    const run = async (src: 'smooth' | 'stair' | 'interp') => {
      const r = await hoveringWhoop();
      const sh = createShared(), ch = new Float32Array(16).fill(1500), got = new Float32Array(16);
      const sampler = new StickSampler(2.5); // the worker's STICK_LATENCY_MS
      if (src === 'stair') sampler.maxInterpMs = 0; // the code before: the newest report per packet
      const toMs = (t: number) => 1.7e12 + t * 1000;
      // reports every 16.7 ms (±0.5 ms), stamped on arrival, visible at the browser's next 4 ms poll;
      // 1 s of warm-up with ±1 µs of gimbal noise so the input rate is known when the flick starts
      const reports: { t: number; vis: number }[] = [];
      for (let k = 0; k < 180; k++) { const t = k / 60 + 0.0005 * Math.sin(k * 7.3); reports.push({ t, vis: Math.ceil((t - 0.0013) / 0.004) * 0.004 + 0.0013 }); }
      const t0 = r.time();
      let ri = -1, poll = 0;
      r.setOnPacket((tAbs) => {
        const t = tAbs - t0;
        if (src === 'smooth') { r.rc[3] = flick(t - 1 - 0.0025); return; }
        for (; poll <= t; poll += 0.00125) {
          while (ri + 1 < reports.length && reports[ri + 1].vis <= poll) ri++;
          const rt = ri >= 0 ? reports[ri].t : 0;
          ch[3] = flick(rt - 1) + (rt < 1 ? (ri % 2) : 0); writeStick(sh, toMs(rt), ch);
        }
        sampler.sample(sh, toMs(t), got); r.rc[3] = got[3];
      });
      r.run(1);
      const rec = record(r, 1.8);
      r.setOnPacket(null);
      return { accel: p99(yawAccel(rec.W)), spread: Math.max(...rec.M), sampler };
    };
    const smooth = await run('smooth'), stair = await run('stair'), interp = await run('interp');
    console.log([smooth, stair, interp].map((x, i) => `${['smooth 250 Hz stick', '60 Hz staircase', '60 Hz reconstructed'][i]}: yaw acceleration p99 ${(x.accel / 1000).toFixed(1)}k deg/s², motor spread up to ${x.spread}`).join('\n'));
    expect(interp.sampler.inputMs).toBeCloseTo(1000 / 60, 0);
    // the staircase slammed the motors: the measurement sees the snap
    expect(stair.spread).toBeGreaterThan(1.4 * smooth.spread);
    expect(stair.accel).toBeGreaterThan(1.25 * smooth.accel);
    // reconstructed between reports it flies like a smooth stick
    expect(interp.spread).toBeLessThan(1.25 * smooth.spread);
    expect(interp.accel).toBeLessThan(1.2 * smooth.accel);
  }, 180000);
});
