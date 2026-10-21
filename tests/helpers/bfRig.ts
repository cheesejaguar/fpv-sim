// Closed loop as the worker runs it: real Betaflight WASM + the generated plant, IMU handed over on
// the chip's fresh samples (BMI270 3.2 kHz sample-and-hold), RC packets at a fixed link rate, eRPM
// telemetry, battery ADC. Used by the flight-feel tests (yaw response, hands-off hover, stick path).
import { pathToFileURL } from 'node:url';
import { Betaflight } from '../../src/bf/bfModule';
import { defaultCli } from '../../src/bf/defaults';
import { buildDrone, DroneSpec } from '../../src/builder/derive';
import { GroundPlane } from '../../src/sim/contact';
import { QuadEnv, QuadParams, QuadSim } from '../../src/sim/quad';
import { WakeField } from '../../src/sim/wake';
import { Wind, WindParams } from '../../src/sim/wind';
import { calibrateAccLevel, sampleLevelRest } from '../../src/worker/accCal';

export const FW_URL = new URL('../../public/bf/betaflight.mjs', import.meta.url);
export const DT = 125e-6;
const G = 9.80665;
const enc = new TextEncoder(), dec = new TextDecoder();
export const CALM_AIR: WindParams = { speed20ft: 0, directionDeg: 0, z0: 0.03, turbulence: 0, gustiness: 0, gustMax: 0 };

export async function loadFirmware(): Promise<Betaflight> {
  const mod = await import(/* @vite-ignore */ pathToFileURL(FW_URL.pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);
  return Betaflight.fromFactory(mod.default);
}

export interface BfRigOpts { wind?: WindParams; rcHz?: number; params?: (p: QuadParams) => QuadParams }

export async function bfRig(spec: DroneSpec, opts: BfRigOpts = {}) {
  const bf = await loadFirmware();
  const build = buildDrone(spec);
  if (opts.params) build.params = opts.params(build.params);
  const quad = new QuadSim(build.params, 8000);
  const env: QuadEnv = { world: new GroundPlane(), wind: new Wind(opts.wind ?? CALM_AIR), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false };
  // spawn as the worker does: 6 cm above the ground, level
  const spawnZ = 0.06 - Math.min(...build.params.colliders.map((c) => c.pos.z - c.radius));
  quad.reset({ x: 0, y: 0, z: spawnZ });
  const rc = new Float32Array(16).fill(1500); rc[2] = 1000; rc[4] = 1000; rc[5] = 1000; rc[6] = 1000; rc[7] = 1000;
  const mot = new Uint16Array(4), erpm = new Float32Array(4);
  const odr = build.params.imuChip.sampleRateHz, pkt = 1 / (opts.rcHz ?? 250);
  let rcAcc = 0, hold = 0, t = 0;
  /** called right before each RC packet is handed over (a test can change rc[] per packet) */
  let onPacket: ((t: number) => void) | null = null;
  const hooks: ((t: number) => void)[] = [];
  /** the plant frozen, the IMU reading a level, still quad (the worker's held accelerometer calibration) */
  let heldLevel = false;
  const step = () => {
    if (heldLevel) sampleLevelRest(quad.imu, quad.p.mass, DT);
    hold += DT; const fresh = odr >= 8000 || hold >= 1 / odr - 1e-9;
    if (fresh && odr < 8000) { hold -= 1 / odr; if (hold > DT) hold = 0; }
    const g = quad.imu.gyroOut, a = quad.imu.accOut;
    if (fresh) bf.setImu(g.x, g.y, g.z, a.x, a.y, a.z);
    for (let k = 0; k < 4; k++) erpm[k] = Math.abs(quad.motors[k].erpm());
    bf.setErpm(erpm);
    bf.setBattery(quad.battery.s.voltage, quad.battery.s.current, quad.battery.s.mAhDrawn);
    rcAcc += DT;
    if (rcAcc >= pkt - 1e-9) { rcAcc -= pkt; onPacket?.(t); bf.setRc(rc); bf.setLinkStats(100, -40, 2); }
    bf.step(125); t += DT;
    const armed = bf.getMotors(mot);
    if (!heldLevel) { quad.command(mot, bf.motorsReversed()); quad.step(DT, env); }
    for (const h of hooks) h(t);
    return armed;
  };
  /** The worker's accelerometer calibration (src/worker/accCal.ts): plant frozen, IMU level and still. */
  const calibrateAccLevelled = () => {
    heldLevel = true;
    try { return calibrateAccLevel(bf, 8000, () => step()); } finally { heldLevel = false; }
  };
  const run = (s: number) => { let armed = false; for (let i = 0, n = Math.round(s / DT); i < n; i++) armed = step(); return armed; };
  const cli = (lines: string[]) => {
    let out = '';
    bf.serialWrite(0, enc.encode('#\n')); run(0.3); out += dec.decode(bf.serialRead(0));
    for (const l of lines) { if (l.startsWith('#')) continue; bf.serialWrite(0, enc.encode(l + '\n')); run(l === 'save' ? 2.5 : 0.12); out += dec.decode(bf.serialRead(0)); }
    if (!lines.includes('save')) { bf.serialWrite(0, enc.encode('exit\n')); run(2.5); out += dec.decode(bf.serialRead(0)); }
    return out;
  };
  bf.setGyroRate(odr);
  bf.setBattery(quad.battery.s.voltage, 0, 0); bf.setImu(0, 0, 0, 0, 0, G); bf.init();
  /** Hover throttle in µs from the builder's estimate (BF idle offset 5.5 %). */
  const hoverUs = () => 1000 + 1000 * (0.055 + build.info.hoverThrottle * 0.945);
  return {
    bf, quad, env, rc, build, run, cli, hooks, hoverUs, time: () => t, calibrateAccLevelled,
    setOnPacket: (f: ((t: number) => void) | null) => { onPacket = f; },
  };
}

export type BfRig = Awaited<ReturnType<typeof bfRig>>;

/** First boot: settle, apply the simulator defaults (+ extra lines), save. */
export function applyDefaults(r: BfRig, extra: string[] = []) {
  r.run(0.5);
  return r.cli([...defaultCli(r.build).filter((l) => l !== 'save'), ...extra, 'save']);
}
