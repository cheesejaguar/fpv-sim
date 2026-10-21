// Closed-loop integration: the real Betaflight WASM build flying the generated plant, in Node.
// Skipped when the firmware hasn't been built (npm run firmware).
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { Betaflight } from '../src/bf/bfModule';
import { defaultCli } from '../src/bf/defaults';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { GroundPlane } from '../src/sim/contact';
import { QuadEnv, QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { Wind } from '../src/sim/wind';

const FW = new URL('../public/bf/betaflight.mjs', import.meta.url);
const have = existsSync(FW);
const DT_US = 125, DT = DT_US / 1e6;

async function rig() {
  if (process.env.NOBIAS) { const { GYRO_CHIPS } = await import('../src/sim/imu'); GYRO_CHIPS.ICM42688P.turnOnBiasDps = 0; GYRO_CHIPS.ICM42688P.gyroBiasWalk = 0; }
  const mod = await import(/* @vite-ignore */ pathToFileURL(FW.pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);
  const bf = await Betaflight.fromFactory(mod.default);
  const build = buildDrone(DEFAULT_SPEC);
  const quad = new QuadSim(build.params, 8000);
  const env: QuadEnv = { world: new GroundPlane(), wind: new Wind({ speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 }), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false };
  quad.reset({ x: 0, y: 0, z: 0.04 });
  const rc = new Float32Array(16).fill(1500); rc[2] = 1000; rc[4] = 1000; rc[5] = 1000; rc[6] = 1000; rc[7] = 1000;
  const mot = new Uint16Array(4), erpm = new Float32Array(4);
  let rcAcc = 0;
  const step = () => {
    const g = quad.imu.gyroOut, a = quad.imu.accOut;
    bf.setImu(g.x, g.y, g.z, a.x, a.y, a.z);
    for (let k = 0; k < 4; k++) erpm[k] = Math.abs(quad.motors[k].erpm());
    bf.setErpm(erpm);
    bf.setBattery(quad.battery.s.voltage, quad.battery.s.current, quad.battery.s.mAhDrawn);
    rcAcc += DT; if (rcAcc >= 0.004) { rcAcc = 0; bf.setRc(rc); }
    bf.step(DT_US);
    const armed = bf.getMotors(mot);
    quad.command(mot, bf.motorsReversed());
    quad.step(DT, env);
    return armed;
  };
  const run = (s: number) => { let armed = false; for (let i = 0; i < s / DT; i++) armed = step(); return armed; };
  const cli = (lines: string[]) => {
    const enc = new TextEncoder(), dec = new TextDecoder();
    let out = '';
    bf.serialWrite(0, enc.encode('#\n')); run(0.3); out += dec.decode(bf.serialRead(0));
    for (const l of lines) { if (l.startsWith('#')) continue; bf.serialWrite(0, enc.encode(l + '\n')); run(l === 'save' ? 2.5 : 0.12); out += dec.decode(bf.serialRead(0)); }
    return out;
  };
  bf.setBattery(quad.battery.s.voltage, 0, 0);
  bf.setImu(0, 0, 0, 0, 0, 9.80665);
  bf.init();
  return { bf, quad, rc, run, cli, build };
}

describe.skipIf(!have)('Betaflight WASM closed loop', () => {
  test('boots, takes defaults, arms, hovers level with little drift', async () => {
    const r = await rig();
    r.run(1);
    const out = r.cli(defaultCli(r.build));
    expect(out).toContain('saving');
    r.run(4); // boot grace + gyro calibration on the real (biased, noisy) IMU signal
    expect(r.bf.armingDisableFlags()).toBe(0);
    r.rc[4] = 1900; // arm
    expect(r.run(0.3)).toBe(true);
    // climb then hold roughly hover-ish throttle; acro, sticks centred
    r.rc[2] = 1500; r.run(1.0);
    r.rc[2] = 1330; r.run(3.0);
    const q = r.quad.s.q;
    const tilt = Math.acos(Math.min(1, 1 - 2 * (q.x * q.x + q.y * q.y))) * 180 / Math.PI;
    const yaw0 = 2 * Math.atan2(q.z, q.w);
    r.run(5);
    const yaw1 = 2 * Math.atan2(r.quad.s.q.z, r.quad.s.q.w);
    const drift = Math.abs(((yaw1 - yaw0) * 180) / Math.PI) / 5;
    console.log(`alt ${r.quad.s.pos.z.toFixed(1)} m, tilt ${tilt.toFixed(2)} deg, yaw drift ${drift.toFixed(3)} deg/s, V ${r.quad.s.vbus.toFixed(2)}, I ${r.quad.s.ibus.toFixed(1)}`);
    expect(tilt).toBeLessThan(3);
    expect(drift).toBeLessThan(0.15);
    expect(r.quad.s.pos.z).toBeGreaterThan(2);
  }, 120000);

  test('roll stick produces a right roll at about the configured rate', async () => {
    const r = await rig();
    r.run(1); r.cli(defaultCli(r.build)); r.run(4);
    r.rc[4] = 1900; r.run(0.3);
    r.rc[2] = 1500; r.run(1.0);
    r.rc[0] = 2000; // full right roll
    r.run(0.25);
    const p = r.quad.s.w.x; // FLU: +x = right wing down
    console.log(`full-stick roll rate ${(p * 180 / Math.PI).toFixed(0)} deg/s`);
    expect(p * 180 / Math.PI).toBeGreaterThan(450); // BF 4.5 default actual rates: 670 deg/s max
    expect(p * 180 / Math.PI).toBeLessThan(800);
  }, 120000);
});
