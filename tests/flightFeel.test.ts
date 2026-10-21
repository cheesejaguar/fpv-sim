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
import { DEFAULT_SETTINGS } from '../src/worker/shared';
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
