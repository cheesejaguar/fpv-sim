#!/usr/bin/env node
// Closed-loop benchmark: the real Betaflight WASM build + the plant on a real map, stepped the way
// src/worker/sim.worker.ts does it (8 kHz lock-step, RC / battery / serial side channels, wind, the
// wake field advanced once per ms). Reports µs per physics step, best of `runs`, for the quad
// resting on the spawn pad (disarmed: every collider sphere in contact) and for flight (~3 m,
// wobbling circuit). A step must stay under 125 µs to keep real time at 8 kHz.
//
//   node scripts/bench-sim.mjs [map=field] [preset=0] [flightSeconds=8] [runs=3]
import { performance } from 'node:perf_hooks';
import { loadTs } from './lib/load-ts.mjs';

const [mapId = 'field', presetIx = '0', secs = '8', runs = '3'] = process.argv.slice(2);
const { mods, close } = await loadTs('src/bf/bfModule.ts', 'src/bf/defaults.ts', 'src/builder/derive.ts', 'src/maps/maps.ts', 'src/maps/world.ts', 'src/sim/quad.ts', 'src/sim/wake.ts', 'src/sim/wind.ts', 'src/worker/accCal.ts');
const [{ Betaflight, BF_PORT }, { defaultCli }, { buildDrone, PRESETS }, { MAPS, preloadMap }, { PrimitiveWorld, spawnGroundZ }, { QuadSim }, { WakeField }, { Wind }, { calibrateAccLevel, sampleLevelRest }] = mods;
const fw = await import(new URL('../public/bf/betaflight.mjs', import.meta.url).href);
const bf = await Betaflight.fromFactory(fw.default);

const DT = 1 / 8000;
const build = buildDrone(PRESETS[Number(presetIx)]);
const quad = new QuadSim(build.params, 8000, 1, 20);
await preloadMap(mapId);
const map = MAPS[mapId]();
const ws = map.windScale ?? 1;
const wind = new Wind({ speed20ft: 2.5 * ws, directionDeg: 240, z0: map.groundMat === 'grass' ? 0.03 : 0.3, turbulence: 1, gustiness: 2, gustMax: 2 * ws });
wind.zones = map.wakeZones; wind.indoor = map.indoor ?? [];
const env = { world: new PrimitiveWorld(map), wind, wake: new WakeField(), ambientC: 20, altitudeOffset: map.elevationM, damageEnabled: true };
const sp = map.spawn;
quad.reset({ x: sp.pos.x, y: sp.pos.y, z: spawnGroundZ(map) + 0.06 - Math.min(...build.params.colliders.map((c) => c.pos.z - c.radius)) }, sp.yaw);

const rc = new Float32Array(16).fill(1500); rc[2] = 1000; rc[4] = 1000; rc[5] = 1000; rc[6] = 1000; rc[7] = 1000;
const mot = new Uint16Array(4), erpm = new Float32Array(4), meanWind = { x: 0, y: 0, z: 0 };
const odr = build.params.imuChip.sampleRateHz;
let hold = 0, rcAcc = 0, battAcc = 0, serAcc = 0, wakeAcc = 0, heldLevel = false;
function step(live = true) {
  if (heldLevel) sampleLevelRest(quad.imu, quad.p.mass, DT);
  rcAcc += DT; if (rcAcc >= 1 / 250 - 1e-9) { rcAcc -= 1 / 250; bf.setRc(rc); bf.setLinkStats(100, -40, 2); }
  battAcc += DT; if (battAcc >= 0.001) { battAcc = 0; bf.setBattery(quad.battery.s.voltage, quad.battery.s.current, quad.battery.s.mAhDrawn); }
  serAcc += DT; if (serAcc >= 0.01) { serAcc = 0; bf.serialRead(BF_PORT.blackbox); bf.serialRead(BF_PORT.gps); bf.serialRead(BF_PORT.cli); }
  for (let k = 0; k < 4; k++) erpm[k] = Math.abs(quad.motors[k].erpm());
  bf.setErpm(erpm);
  hold += DT; const fresh = odr >= 8000 || hold >= 1 / odr - 1e-9;
  if (fresh && odr < 8000) { hold -= 1 / odr; if (hold > DT) hold = 0; }
  if (fresh) { const g = quad.imu.gyroOut, a = quad.imu.accOut; bf.setImu(g.x, g.y, g.z, a.x, a.y, a.z); }
  bf.step(125); bf.beeper(); bf.beacon();
  const armed = bf.getMotors(mot);
  if (live && !heldLevel) {
    quad.command(mot, bf.motorsReversed()); quad.step(DT, env);
    wakeAcc += DT;
    if (wakeAcc >= 0.001 - 1e-9) { env.wake.step(wakeAcc, env.wind.meanAt(quad.s.pos.z, meanWind), map.terrain(quad.s.pos.x, quad.s.pos.y)); wakeAcc = 0; }
  }
  return armed;
}
const run = (s) => { for (let i = 0, n = Math.round(s / DT); i < n; i++) step(); };
const enc = new TextEncoder();
const cli = (lines) => { for (const l of ['#', ...lines]) { if (l.startsWith('# ')) continue; bf.serialWrite(BF_PORT.cli, enc.encode(l + '\n')); run(l === 'save' ? 2.5 : 0.12); bf.serialRead(BF_PORT.cli); } };
/** µs per step over `s` seconds of simulation; `sticks` (optional) runs every 32 steps */
const timed = (s, sticks) => { const n = Math.round(s / DT), t0 = performance.now(); for (let i = 0; i < n; i++) { if (sticks && i % 32 === 0) sticks(i * DT); step(); } return ((performance.now() - t0) * 1000) / n; };

// boot as the worker does: defaults over the CLI, level accelerometer calibration, gyro calibration
bf.setGyroRate(odr); bf.setBattery(quad.battery.s.voltage, 0, 0); bf.setImu(0, 0, 0, 0, 0, 9.80665); bf.init();
run(0.5); cli(defaultCli(build));
heldLevel = true; calibrateAccLevel(bf, 8000, () => step(false)); heldLevel = false;
run(4);
const best = (f) => Math.min(...Array.from({ length: Number(runs) }, f));
const rest = best(() => timed(2));
rc[4] = 1900; rc[5] = 1900; run(0.5); // arm, angle mode
const hover = 1000 + 1000 * (0.055 + build.info.hoverThrottle * 0.945);
const sticks = (t) => { // climb to ~3 m, then a wobbling circuit
  rc[2] = Math.max(1050, Math.min(1900, hover + 60 * (3 - quad.s.pos.z) - 40 * quad.s.vel.z));
  rc[0] = 1500 + 120 * Math.sin(t * 0.9); rc[1] = 1500 + 80 * Math.sin(t * 0.5 + 1); rc[3] = 1500 + 60 * Math.sin(t * 0.3);
};
timed(2, sticks); // climb + warm-up
const flight = best(() => timed(Number(secs), sticks));
console.log(JSON.stringify({ map: mapId, preset: PRESETS[Number(presetIx)].name, armed: bf.getMotors(mot), restUsPerStep: +rest.toFixed(2), flightUsPerStep: +flight.toFixed(2), altM: +quad.s.pos.z.toFixed(1) }));
await close();
