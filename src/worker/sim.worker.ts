/// <reference lib="webworker" />
// Simulation worker: Betaflight (WASM) and the physics plant in lockstep.
//
// Each physics step (default 125 µs = 8 kHz):
//   IMU sample -> bf_set_gyro_acc -> bf_step(dt) -> bf_get_motors -> ESC/motor/rotor/body step
// Slower side channels: RC link packets (ELRS rate), battery ADC (1 kHz), eRPM telemetry (every
// step), baro (100 Hz), OSD copy (50 Hz), state ring (1 kHz), telemetry to UI (20 Hz).
import { Betaflight, armingFlagNames } from '../bf/bfModule';
import { defaultCli, osdGrid, osdLayout } from '../bf/defaults';
import { buildDrone, DEFAULT_SPEC, DroneBuild, DroneSpec } from '../builder/derive';
import { MAPS } from '../maps/maps';
import { GateDef, MapDef, PrimitiveWorld } from '../maps/world';
import { isa } from '../sim/atmosphere';
import { Spectrum } from '../sim/fft';
import { QuadEnv, QuadSim } from '../sim/quad';
import { WakeField } from '../sim/wake';
import { Wind } from '../sim/wind';
import { createShared, DEFAULT_SETTINGS, FromWorker, GyroSpectrum, OSD_MAX_COLS, OSD_MAX_ROWS, R, REC, RING_DT, RING_N, Shared, SimSettings, Telemetry, ToWorker } from './shared';

/** Bump when defaultCli() changes so existing users get the new baseline. */
const DEFAULTS_VERSION = 3;

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

let sh: Shared;
let settings: SimSettings = DEFAULT_SETTINGS;
let spec: DroneSpec = DEFAULT_SPEC;
let build: DroneBuild;
let quad: QuadSim;
let map: MapDef;
let world: PrimitiveWorld;
let env: QuadEnv;
let bf: Betaflight | null = null;
let fwState = 0;

let simT = 0;
let wallStart = 0, simAtWallStart = 0;
let rcAcc = 0, battAcc = 0, baroAcc = 0, ringAcc = 0, osdAcc = 0, telAcc = 0, cliAcc = 0;
let lastOsdFrame = -1;
const motorCmd = new Uint16Array(4);
const erpm = new Float32Array(4);
const rcBuf = new Float32Array(16).fill(1500);
let armed = false;
let crashMsg: string | null = null;
let crashMsgUntil = 0;
let stepCostUs = 0;
let simRate = 1;
let lastPos = { x: 0, y: 0, z: 0 };
let nextGate = 0;
let cliOutBuf = '';
let cliQueue: { lines: string[]; id: number; out: string; idx: number; wait: number }[] = [];
let inCli = false;

// Noise-spectrum analyser: raw IMU gyro vs Betaflight's filtered gyro (debug_mode GYRO_FILTERED),
// sampled every physics step into rings, FFT'd ~10 times a second while the overlay is shown.
const SPEC_N = 2048, SPEC_MAX_HZ = 1000, SPEC_PERIOD = 0.1;
const RAD2DEG = 180 / Math.PI;
let specOn = false, specHead = 0, specFill = 0, specAcc = 0, specSawFiltered = false;
const specRaw = [new Float32Array(SPEC_N), new Float32Array(SPEC_N), new Float32Array(SPEC_N)];
const specFilt = [new Float32Array(SPEC_N), new Float32Array(SPEC_N), new Float32Array(SPEC_N)];
const specFft = new Spectrum(SPEC_N);
const dbg = new Int16Array(8);

// ---------------------------------------------------------------------------------------------
// EEPROM persistence (IndexedDB)
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('fpv-sim', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvGet(key: string): Promise<any> {
  try { const db = await idb(); return await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch { return undefined; }
}
async function kvSet(key: string, v: any): Promise<void> {
  try { const db = await idb(); await new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, key); t.oncomplete = () => res(null); t.onerror = () => res(null); }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------------------------

function makeEnv(): QuadEnv {
  const w = new Wind({ speed20ft: settings.wind.speed, directionDeg: settings.wind.direction, z0: map.groundMat === 'grass' ? 0.03 : 0.3, turbulence: settings.wind.turbulence, gustiness: settings.wind.gusts, gustMax: settings.wind.speed * 0.8 + 1 });
  w.zones = map.wakeZones;
  return { world, wind: w, wake: new WakeField(), ambientC: settings.ambientC, altitudeOffset: map.elevationM, damageEnabled: settings.damage };
}

function loadMap(id: string) {
  map = (MAPS[id] ?? MAPS.field)();
  world = new PrimitiveWorld(map);
  env = makeEnv();
}

function buildQuad(keepBattery = false) {
  build = buildDrone(spec);
  const prev = quad;
  quad = new QuadSim(build.params, settings.physicsHz, spec.batterySoc, settings.ambientC);
  if (keepBattery && prev) quad.battery.s = { ...prev.battery.s };
  for (const a of quad.aero) a.propwashScale = settings.propwash;
  if (spec.overrides.propImbalance != null) for (const a of quad.aero) a.damage.imbalance = spec.overrides.propImbalance;
  respawn();
  post({ type: 'built', info: serializeInfo(build) });
}

function serializeInfo(b: DroneBuild) {
  const i = b.info;
  return {
    ...i, components: i.components,
    params: { mass: b.params.mass, inertia: b.params.inertia, cdA: b.params.cdA, rotors: b.params.rotors.map((r) => ({ pos: r.pos, dir: r.dir, kT: r.table.kT, kQ: r.table.kQ, R: r.table.R })), battery: b.params.battery, colliders: b.params.colliders.length },
  };
}

function respawn() {
  const sp = map.spawn;
  const z = map.terrain(sp.pos.x, sp.pos.y) + 0.06 - Math.min(...build.params.colliders.map((c) => c.pos.z - c.radius));
  quad.reset({ x: sp.pos.x, y: sp.pos.y, z }, sp.yaw);
  env.wake.reset();
  lastPos = { ...quad.s.pos };
  nextGate = 0;
}

// ---------------------------------------------------------------------------------------------
// Betaflight boot + CLI

async function bootFirmware() {
  fwState = 1; Atomics.store(sh.ctrl, 7, 1);
  try {
    bf = await Betaflight.load('/bf/betaflight.mjs');
  } catch (e) {
    bf = null; fwState = 3; Atomics.store(sh.ctrl, 7, 3);
    post({ type: 'fwMissing', reason: `Betaflight WASM not found (${(e as Error).message}). Build it with: npm run firmware` });
    return;
  }
  try {
    const saved: Uint8Array | undefined = await kvGet('bf-eeprom');
    if (saved && saved.length) bf.eepromSet(saved);
    bf.init();
    primeSensors();
    for (let i = 0; i < 4000; i++) stepFirmwareOnly(); // ~0.5 s boot: gyro calibration etc.
    const applied = await kvGet('bf-defaults-version');
    if (!saved || !saved.length || applied !== DEFAULTS_VERSION) {
      post({ type: 'log', text: 'First boot: applying fpv-sim defaults over the Betaflight CLI' });
      await runCliBatchSync(defaultCli(build));
      await kvSet('bf-defaults-version', DEFAULTS_VERSION);
    }
    fwState = 2; Atomics.store(sh.ctrl, 7, 2);
    post({ type: 'ready', fw: bf.version });
  } catch (e) {
    fwState = 4; Atomics.store(sh.ctrl, 7, 4);
    post({ type: 'fwMissing', reason: `Betaflight failed to boot: ${(e as Error).message}` });
    bf = null;
  }
}

function primeSensors() {
  if (!bf) return;
  const b = quad.battery.s;
  bf.setBattery(b.voltage, 0, 0);
  bf.setImu(0, 0, 0, 0, 0, 9.80665);
  rcBuf.fill(1500); rcBuf[2] = 1000; rcBuf[4] = 1000;
  bf.setRc(rcBuf);
}

/**
 * Step firmware + plant while the main loop is not driving (boot, CLI batches). The plant must run
 * so the IMU delivers its real noise and turn-on bias: Betaflight's boot gyro calibration has to
 * see the same biased signal a real FC would, otherwise the uncalibrated bias shows up as drift.
 */
function stepFirmwareOnly() {
  if (!bf) return;
  physicsStep(1 / settings.physicsHz);
}

async function runCliBatchSync(lines: string[]): Promise<string> {
  if (!bf) return '';
  let out = '';
  const enc = new TextEncoder(), dec = new TextDecoder();
  // Run the firmware (virtual time) until its replies go quiet: CLI output appears ~100 ms after
  // a command, and save/exit reboot the FC.
  const stepsPerMs = Math.round(settings.physicsHz / 1000);
  const pump = (minMs: number, maxMs: number) => {
    let quiet = 0;
    for (let ms = 0; ms < maxMs; ms += 10) {
      for (let i = 0; i < 10 * stepsPerMs; i++) stepFirmwareOnly();
      const r = bf!.serialRead(0);
      if (r.length) { out += dec.decode(r); quiet = 0; } else quiet += 10;
      if (ms >= minMs && quiet >= 150) break;
    }
  };
  bf.serialWrite(0, enc.encode('#\n')); pump(100, 1000);
  for (const l of lines) {
    if (l.startsWith('#') && l.length > 1) continue;
    bf.serialWrite(0, enc.encode(l + '\n'));
    if (l === 'save' || l === 'exit') pump(1500, 4000); else pump(20, 1000);
  }
  if (!lines.includes('save')) { bf.serialWrite(0, enc.encode('exit\n')); pump(1500, 4000); }
  await persistEeprom();
  return out;
}

async function persistEeprom() {
  if (!bf) return;
  if (bf.eepromDirty()) await kvSet('bf-eeprom', bf.eepromGet());
}

// ---------------------------------------------------------------------------------------------
// Main lockstep loop

function physicsStep(dt: number) {
  const dtUs = Math.round(dt * 1e6);
  // RC link packets
  rcAcc += dt;
  if (rcAcc >= 1 / settings.rcLinkHz) {
    rcAcc -= 1 / settings.rcLinkHz;
    for (let i = 0; i < 16; i++) rcBuf[i] = sh.rc[i] || 1500;
    bf?.setRc(rcBuf);
  }
  // sensors -> FC
  if (bf) {
    const g = quad.imu.gyroOut, a = quad.imu.accOut;
    bf.setImu(g.x, g.y, g.z, a.x, a.y, a.z);
    for (let k = 0; k < 4; k++) erpm[k] = Math.abs(quad.motors[k].erpm());
    bf.setErpm(erpm);
    battAcc += dt;
    if (battAcc >= 0.001) { battAcc = 0; const b = quad.battery.s; bf.setBattery(b.voltage, b.current, b.mAhDrawn); }
    baroAcc += dt;
    if (baroAcc >= 0.01) { baroAcc = 0; bf.setBaro(isa(quad.s.pos.z + map.elevationM).pressure); }
    bf.step(dtUs);
    armed = bf.getMotors(motorCmd);
    quad.command(motorCmd, bf.motorsReversed());
  } else {
    motorCmd.fill(0); armed = false;
    quad.command(motorCmd, false);
  }
  if (specOn) sampleSpectrum(dt);
  quad.step(dt, env);
  env.wake.step(dt, env.wind.meanAt(quad.s.pos.z, { x: 0, y: 0, z: 0 }), map.terrain(quad.s.pos.x, quad.s.pos.y));
  simT += dt;

  // state ring at 1 kHz
  ringAcc += dt;
  if (ringAcc >= RING_DT) { ringAcc -= RING_DT; writeRing(); detectGates(); }

  // crash events
  if (quad.s.maxImpact > 0) {
    const v = quad.s.maxImpact;
    quad.s.maxImpact = 0;
    if (v > 6) { crashMsg = `Impact ${v.toFixed(1)} m/s`; crashMsgUntil = simT + 2; }
  }
}

function sampleSpectrum(dt: number) {
  const g = quad.imu.gyroOut, i = specHead;
  // raw: what the IMU hands Betaflight this step, °/s; filtered: gyroADCf after every BF filter
  specRaw[0][i] = g.x * RAD2DEG; specRaw[1][i] = g.y * RAD2DEG; specRaw[2][i] = g.z * RAD2DEG;
  if (bf?.debugInto(dbg)) {
    specFilt[0][i] = dbg[0]; specFilt[1][i] = dbg[1]; specFilt[2][i] = dbg[2];
    // GYRO_FILTERED writes debug[0..2] only; other modes (e.g. RPM_FILTER) also fill debug[3..]
    if (!specSawFiltered && (dbg[0] || dbg[1] || dbg[2]) && !(dbg[3] || dbg[4] || dbg[5] || dbg[6] || dbg[7])) specSawFiltered = true;
  } else { specFilt[0][i] = 0; specFilt[1][i] = 0; specFilt[2][i] = 0; }
  specHead = (i + 1) % SPEC_N;
  if (specFill < SPEC_N) specFill++;
  specAcc += dt;
  if (specAcc >= SPEC_PERIOD && specFill === SPEC_N) { specAcc = 0; postSpectrum(dt); }
}

function postSpectrum(dt: number) {
  const binHz = 1 / (dt * SPEC_N);
  const bins = Math.min(SPEC_N / 2, Math.ceil(SPEC_MAX_HZ / binHz)) + 1;
  const raw = new Float32Array(3 * bins), filtered = new Float32Array(3 * bins);
  for (let a = 0; a < 3; a++) {
    specFft.compute(specRaw[a], specHead, raw.subarray(a * bins, (a + 1) * bins));
    specFft.compute(specFilt[a], specHead, filtered.subarray(a * bins, (a + 1) * bins));
  }
  const spec: GyroSpectrum = {
    binHz, bins, raw, filtered, hasFiltered: specSawFiltered,
    // integer °/s rounding: error up to ±0.5 °/s; slow signals near a step give σ up to 0.5 (worst case)
    filteredFloorDb: specFft.whiteFloorDb(0.5),
    motorHz: quad.motors.map((m) => Math.abs(m.rpm()) / 60),
    blades: build.info.components.prop.blades,
  };
  (self as unknown as Worker).postMessage({ type: 'spectrum', spec } satisfies FromWorker, [raw.buffer, filtered.buffer]);
}

function writeRing() {
  const head = Atomics.load(sh.ctrl, 1);
  const o = (head % RING_N) * REC, r = sh.ring, s = quad.s;
  r[o + R.t] = simT;
  r[o + R.px] = s.pos.x; r[o + R.py] = s.pos.y; r[o + R.pz] = s.pos.z;
  r[o + R.qw] = s.q.w; r[o + R.qx] = s.q.x; r[o + R.qy] = s.q.y; r[o + R.qz] = s.q.z;
  r[o + R.wx] = s.w.x; r[o + R.wy] = s.w.y; r[o + R.wz] = s.w.z;
  r[o + R.vx] = s.vel.x; r[o + R.vy] = s.vel.y; r[o + R.vz] = s.vel.z;
  for (let k = 0; k < 4; k++) { r[o + R.rpm0 + k] = quad.motors[k].rpm(); r[o + R.m0 + k] = motorCmd[k]; }
  const b = quad.battery.s;
  r[o + R.vbus] = s.vbus; r[o + R.ibus] = s.ibus; r[o + R.mah] = b.mAhDrawn; r[o + R.armed] = armed ? 1 : 0;
  r[o + R.gx] = quad.imu.gyroOut.x; r[o + R.gy] = quad.imu.gyroOut.y; r[o + R.gz] = quad.imu.gyroOut.z;
  r[o + R.thr] = (sh.rc[2] - 1000) / 1000; r[o + R.soc] = b.soc; r[o + R.battTemp] = b.tempC;
  r[o + R.motorTemp] = Math.max(...quad.motors.map((m) => m.s.tempC));
  r[o + R.vrs] = Math.max(...quad.rotorOut.map((x) => x.vrs));
  r[o + R.touching] = s.touching ? 1 : 0; r[o + R.impact] = 0;
  r[o + R.cellV] = s.vbus / quad.p.battery.cellsSeries;
  r[o + R.crashFlip] = bf?.motorsReversed() ? 1 : 0;
  r[o + R.simRate] = simRate;
  r[o + R.damage] = quad.aero.reduce((a, x) => a + (1 - x.damage.thrustFactor) + (x.damage.broken ? 1 : 0), 0);
  Atomics.store(sh.ctrl, 1, head + 1);
  Atomics.store(sh.ctrl, 5, armed ? 1 : 0);
}

function detectGates() {
  const p = quad.s.pos;
  const gates = map.gates;
  if (!gates.length) { lastPos = { ...p }; return; }
  const g: GateDef = gates[nextGate % gates.length];
  let passed = false;
  if (g.kind === 'dive') {
    if (lastPos.z > g.c.z && p.z <= g.c.z) {
      const c = Math.cos(-g.yaw), s = Math.sin(-g.yaw);
      const dx = p.x - g.c.x, dy = p.y - g.c.y;
      const lx = c * dx - s * dy, ly = s * dx + c * dy;
      passed = Math.abs(lx) < g.width / 2 && Math.abs(ly) < g.width / 2;
    }
  } else if (g.kind === 'flag') {
    // flag: count once the quad has gone around it (within 6 m and on its far side wrt travel)
    const nx = -Math.sin(g.yaw), ny = Math.cos(g.yaw);
    const d0 = (lastPos.x - g.c.x) * nx + (lastPos.y - g.c.y) * ny, d1 = (p.x - g.c.x) * nx + (p.y - g.c.y) * ny;
    passed = d0 < 0 && d1 >= 0 && Math.hypot(p.x - g.c.x, p.y - g.c.y) < 6;
  } else {
    const nx = -Math.sin(g.yaw), ny = Math.cos(g.yaw);
    const d0 = (lastPos.x - g.c.x) * nx + (lastPos.y - g.c.y) * ny, d1 = (p.x - g.c.x) * nx + (p.y - g.c.y) * ny;
    if (d0 < 0 && d1 >= 0) {
      const u = d0 / (d0 - d1);
      const ix = lastPos.x + (p.x - lastPos.x) * u, iy = lastPos.y + (p.y - lastPos.y) * u, iz = lastPos.z + (p.z - lastPos.z) * u;
      const lat = (ix - g.c.x) * Math.cos(g.yaw) + (iy - g.c.y) * Math.sin(g.yaw);
      passed = Math.abs(lat) < g.width / 2 && iz > g.c.z && iz < g.c.z + g.height;
    }
  }
  if (passed) { post({ type: 'gate', gate: g.id, t: simT }); nextGate++; }
  lastPos = { ...p };
}

function sendTelemetry() {
  const b = quad.battery.s;
  const flags = bf ? bf.armingDisableFlags() : 0;
  const tel: Telemetry = {
    t: simT, fw: bf?.version ?? 'none', armingFlags: flags, armingFlagNames: armingFlagNames(flags),
    modeFlags: bf ? bf.flightModeFlags() : 0,
    motorTemps: quad.motors.map((m) => m.s.tempC),
    rotorDamage: quad.aero.map((a) => ({ thrust: a.damage.thrustFactor, broken: a.damage.broken })),
    battery: { v: quad.s.vbus, i: quad.s.ibus, soc: b.soc, mah: b.mAhDrawn, tempC: b.tempC, sag: b.sagV, cellV: quad.s.vbus / quad.p.battery.cellsSeries },
    simRate, stepCostUs, attitudeDeg: bf ? bf.attitude() : [0, 0, 0],
    crash: simT < crashMsgUntil ? crashMsg : null,
  };
  post({ type: 'telemetry', tel });
}

function pumpSideChannels(dt: number) {
  if (!bf) return;
  osdAcc += dt;
  if (osdAcc >= 0.02) {
    osdAcc = 0;
    const f = bf.osdFrame();
    if (f !== lastOsdFrame) {
      lastOsdFrame = f;
      const { cols, rows } = bf.osdCopy(sh.osd, OSD_MAX_COLS, OSD_MAX_ROWS);
      Atomics.store(sh.ctrl, 3, cols); Atomics.store(sh.ctrl, 4, rows);
      Atomics.add(sh.ctrl, 2, 1);
    }
  }
  cliAcc += dt;
  if (cliAcc >= 0.01) {
    cliAcc = 0;
    const r = bf.serialRead(0);
    if (r.length) { cliOutBuf += new TextDecoder().decode(r); }
    if (cliOutBuf) { post({ type: 'cliOut', text: cliOutBuf }); cliOutBuf = ''; }
    if (bf.eepromDirty()) void persistEeprom();
  }
}

function loop() {
  const now = performance.now();
  if (settings.paused || fwState === 1) { wallStart = now; simAtWallStart = simT; setTimeout(loop, 10); return; }
  const target = simAtWallStart + ((now - wallStart) / 1000) * settings.timeScale;
  const dt = 1 / settings.physicsHz;
  let n = Math.floor((target - simT) / dt);
  const maxSteps = Math.floor(0.03 / dt);
  let behind = false;
  if (n > maxSteps) { n = maxSteps; behind = true; }
  const t0 = performance.now();
  for (let i = 0; i < n; i++) { physicsStep(dt); pumpSideChannels(dt); }
  const cost = performance.now() - t0;
  if (n > 0) stepCostUs = stepCostUs * 0.95 + ((cost * 1000) / n) * 0.05;
  if (behind) { wallStart = now; simAtWallStart = simT; }
  // achieved real-time factor
  const capacity = n > 0 ? (n * dt) / (cost / 1000) : 99;
  simRate = simRate * 0.9 + Math.min(capacity, 99) * 0.1;
  telAcc += n * dt;
  if (telAcc >= 0.05) { telAcc = 0; sendTelemetry(); }
  setTimeout(loop, 1);
}

// ---------------------------------------------------------------------------------------------

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': {
      sh = createShared(m.sab);
      settings = m.settings;
      spec = (m.spec as DroneSpec) ?? DEFAULT_SPEC;
      loadMap(settings.mapId);
      buildQuad();
      wallStart = performance.now(); simAtWallStart = 0;
      await bootFirmware();
      wallStart = performance.now(); simAtWallStart = simT;
      loop();
      break;
    }
    case 'spec': {
      const old = spec;
      spec = m.spec as DroneSpec;
      buildQuad();
      // keep firmware hardware settings in sync with the generated airframe
      if (bf) {
        const b = build.info.components;
        const lines = [`set motor_poles = ${b.motor.poles}`, `set motor_kv = ${Math.round(b.motor.kv)}`, `set yaw_motors_reversed = ${spec.propDirection === 'props-out' ? 'ON' : 'OFF'}`];
        if (old.video !== spec.video) {
          lines.push(`set vcd_video_system = ${osdGrid(b.video).vcd}`);
          for (const [k, v] of Object.entries(osdLayout(b.video))) lines.push(`set ${k} = ${v}`);
        }
        lines.push('save');
        await runCliBatchSync(lines);
      }
      break;
    }
    case 'settings': {
      const mapChanged = m.settings.mapId !== settings.mapId;
      const rateChanged = m.settings.physicsHz !== settings.physicsHz;
      settings = m.settings;
      if (mapChanged) { loadMap(settings.mapId); respawn(); }
      else {
        env.wind.p = { ...env.wind.p, speed20ft: settings.wind.speed, directionDeg: settings.wind.direction, turbulence: settings.wind.turbulence, gustiness: settings.wind.gusts, gustMax: settings.wind.speed * 0.8 + 1 };
        env.damageEnabled = settings.damage; env.ambientC = settings.ambientC;
      }
      for (const a of quad.aero) a.propwashScale = settings.propwash;
      if (rateChanged) buildQuad(true);
      wallStart = performance.now(); simAtWallStart = simT;
      break;
    }
    case 'reset': {
      if (m.repair) quad.repair();
      if (m.fullBattery) { buildQuad(); } else respawn();
      break;
    }
    case 'cli': {
      if (bf) bf.serialWrite(0, new TextEncoder().encode(m.text));
      inCli = true;
      break;
    }
    case 'cliBatch': {
      const out = await runCliBatchSync(m.lines);
      post({ type: 'cliBatchDone', id: m.id, output: out });
      break;
    }
    case 'spectrum': {
      specOn = m.on; specFill = 0; specAcc = 0; specSawFiltered = false;
      break;
    }
    case 'factoryReset': {
      await kvSet('bf-eeprom', new Uint8Array(0));
      if (bf) { await runCliBatchSync(['defaults nosave']); await runCliBatchSync(defaultCli(build)); await kvSet('bf-defaults-version', DEFAULTS_VERSION); }
      break;
    }
  }
};
void inCli; void cliQueue;
