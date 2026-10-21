/// <reference lib="webworker" />
// Simulation worker: Betaflight (WASM) and the physics plant in lockstep.
//
// Each physics step (default 125 µs = 8 kHz):
//   IMU sample -> bf_set_gyro_acc -> bf_step(dt) -> bf_get_motors -> ESC/motor/rotor/body step
// Slower side channels: RC link packets (ELRS rate, sticks picked from the timestamped stick ring),
// battery ADC (1 kHz, current-sensor error), eRPM telemetry (every step), baro (100 Hz, noise + prop
// wash), u-blox GPS on UART3 (5 ms I/O), serial blackbox on UART2 (drained every 10 ms), OSD copy
// (50 Hz), state ring (1 kHz), telemetry to UI (20 Hz).
//
// Reliability: messages wait until the boot finished; firmware operations (CLI, spec changes) run one
// at a time; any uncaught error posts { type: 'fatal' } (the bridge restarts the worker once).
import { Betaflight, BF_PORT, armingFlagNames } from '../bf/bfModule';
import { batteryCli, defaultCli, loopCli, osdGrid, osdLayout } from '../bf/defaults';
import { buildDrone, DEFAULT_SPEC, DroneBuild, DroneSpec } from '../builder/derive';
import { packageEntry, urlTableSource } from '../maps/mapFormat';
import { hasMap, MAPS, preloadMap, registerMap } from '../maps/maps';
import { gatePassed } from '../maps/gates';
import { GateDef, MapDef, pilotPos, PrimitiveWorld, spawnGroundZ } from '../maps/world';
import { RcLink } from '../sim/rcLink';
import { G0, isa } from '../sim/atmosphere';
import { Spectrum } from '../sim/fft';
import { rotateInv, V3 } from '../sim/math';
import { QuadEnv, QuadSim } from '../sim/quad';
import { WakeField } from '../sim/wake';
import { Wind } from '../sim/wind';
import { BblRecorder } from './bbl';
import { BaroModel, Brownout, CurrentSensor, OverloadGovernor, seedOf } from './fcHardware';
import { EepromStore, runCliBatch } from './fwCli';
import { IdbKv } from './kv';
import { createShared, DEFAULT_SETTINGS, FromWorker, GyroSpectrum, OSD_MAX_COLS, OSD_MAX_ROWS, R, REC, RING_DT, RING_N, Shared, SimSettings, StickSampler, Telemetry, ToWorker } from './shared';
import { GPS_ORIGIN, UbxReceiver } from './ubxGps';

/** Bump when defaultCli() changes so existing users get the new baseline. */
const DEFAULTS_VERSION = 6; // 4: RSSI dBm OSD element; 5: battery follows the pack; 6: GPS, serial blackbox, beacon, small_angle 25, PID denom
const FW_URL = '/bf/betaflight.mjs';
const FW_TIMEOUT_MS = 15000;
const FW_VERSION = typeof __FW_VERSION__ === 'string' ? __FW_VERSION__ : 'dev';
/**
 * Fixed stick-to-packet latency: each RC packet carries the newest stick sample taken at least this
 * long before the packet's slot (plus StickSampler's mixer-sync offset, up to one input update).
 * Constant, and long enough that the sample has reached the stick ring by the time the worker
 * processes the packet; about what a handset's mixer + ELRS link add on a real quad.
 */
const STICK_LATENCY_MS = 2.5;
const sticks = new StickSampler(STICK_LATENCY_MS);

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
const enc = new TextEncoder(), dec = new TextDecoder();

let dead = false;
/** Stop for good and tell the main thread (it restarts the worker once, then shows the reason). */
function fatal(e: unknown) {
  if (dead) return;
  dead = true;
  const reason = e instanceof Error ? e.message || e.name : String((e as { message?: string })?.message ?? e);
  console.error('[sim worker] fatal:', e);
  try { post({ type: 'fatal', reason }); } catch { /* nothing left to do */ }
}
self.onerror = (ev) => { fatal(typeof ev === 'string' ? ev : (ev as ErrorEvent).error ?? (ev as ErrorEvent).message); return true; };
self.onunhandledrejection = (ev: PromiseRejectionEvent) => { ev.preventDefault(); fatal(ev.reason); };

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

let simT = 0;   // plant time (s)
let fcT = 0;    // firmware time (s): also runs while the plant is held during CLI batches
let wallStart = 0, simAtWallStart = 0;
let realtime = false; // inside loop(): sim time maps onto the wall clock (stick timestamps apply)
// 2.4 GHz RC control link: decides which RC packets arrive and feeds LQ / RSSI to Betaflight
const rcLink = new RcLink();
const pilotTmp = { x: 0, y: 0, z: 0 };
let linkAcc = 0;
let rcAcc = 0, battAcc = 0, baroAcc = 0, ringAcc = 0, osdAcc = 0, telAcc = 0, cliAcc = 0, gpsAcc = 0, bblAcc = 0;
let lastOsdFrame = -1;
const motorCmd = new Uint16Array(4);
const erpm = new Float32Array(4);
const rcBuf = new Float32Array(16).fill(1500);
let armed = false;
let crashMsg: string | null = null;
let crashMsgUntil = 0;
let impactMsg = '', damageMsg = '';
// A crash worth flagging: ~4 m/s into something (a whoop rarely reaches the old 6 m/s threshold),
// or anything that actually damaged the quad.
const CRASH_MIN_MPS = 4;
let impactPeak = 0, impactLastT = -1;
let stepCostUs = 0;
let simRate = 1;
let lastPos = { x: 0, y: 0, z: 0 };
let nextGate = 0;
let cliOutBuf = '';
// beeper / beacon seen since the last telemetry message (their patterns are faster than 20 Hz)
let beeperSeen = false, beaconSeen = false;

// FC hardware imperfections (seeded per drone build) and peripherals
const baro = new BaroModel();
let current = new CurrentSensor(1);
const brownout = new Brownout(2.8, 0.03, 3.0, 0.8); // 0.8 s: regulator back up + MCU boot
const governor = new OverloadGovernor();
const gps = new UbxReceiver(GPS_ORIGIN);
const bbl = new BblRecorder();
let diskArea = 0, rotorR = 0.05;
// IMU sample-and-hold mirror: a slower chip (BMI270 3.2 kHz) hands Betaflight a new sample only on
// the physics steps where it latched one (see src/sim/imu.ts holdT)
let imuHold = 0, imuFresh = true;

const kv = new IdbKv(undefined, (why) => post({ type: 'log', text: `Settings storage unavailable (${why}): Betaflight changes won't be kept after a reload` }));
const eeprom = new EepromStore(kv);

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

function makeEnv(): QuadEnv {
  const ws = map.windScale ?? 1;
  const w = new Wind({ speed20ft: settings.wind.speed * ws, directionDeg: settings.wind.direction, z0: map.groundMat === 'grass' ? 0.03 : 0.3, turbulence: settings.wind.turbulence, gustiness: settings.wind.gusts, gustMax: settings.wind.speed * 0.8 * ws }); // calm air: no gusts
  w.zones = map.wakeZones; w.indoor = map.indoor ?? [];
  return { world, wind: w, wake: new WakeField(), ambientC: settings.ambientC, altitudeOffset: map.elevationM, damageEnabled: settings.damage };
}

/** Load a map for the physics; on failure fly 'field'. Tells the main thread what it got. */
async function loadMap(id: string): Promise<boolean> {
  const want = id;
  let error: string | undefined;
  if (!hasMap(id)) { error = `unknown map "${id}"`; id = 'field'; }
  else await preloadMap(id).catch((e) => { console.warn(e); error = (e as Error)?.message ?? String(e); id = 'field'; });
  if (map && want !== settings.mapId) return false; // superseded by a newer map change while loading
  let m: MapDef;
  try { m = MAPS[id](); } catch (e) { error = (e as Error).message; id = 'field'; m = MAPS.field(); }
  map = m;
  world = new PrimitiveWorld(map);
  env = makeEnv();
  gps.origin = { ...GPS_ORIGIN, altM: map.elevationM ?? 0 };
  post({ type: 'mapLoaded', id, requested: want, ok: !error, error });
  return true;
}

/**
 * keepBattery: carry the pack's state over; keepState: also carry the flight (pose, motors, damage)
 * over instead of respawning (a physics-rate change mid-flight).
 */
function buildQuad(keepBattery = false, keepState = false) {
  build = buildDrone(spec);
  const prev = quad;
  quad = new QuadSim(build.params, settings.physicsHz, spec.batterySoc, settings.ambientC);
  imuHold = 0; imuFresh = true;
  if (keepBattery && prev) quad.battery.s = { ...prev.battery.s };
  else current.reset();
  for (const a of quad.aero) a.propwashScale = settings.propwash;
  diskArea = build.params.rotors.reduce((a, r) => a + Math.PI * r.table.R * r.table.R, 0);
  rotorR = build.params.rotors[0]?.table.R ?? 0.05;
  // sensor errors belong to the board: the same build keeps the same offsets
  const seed = seedOf(`${spec.fc}|${spec.frame}|${spec.esc}|${spec.battery}`);
  if (!keepBattery) current = new CurrentSensor(seed);
  // (prop imbalance, including the builder override, now comes from the rotor config)
  if (keepState && prev) {
    const s = quad.s, p = prev.s;
    s.pos = { ...p.pos }; s.vel = { ...p.vel }; s.q = { ...p.q }; s.w = { ...p.w }; s.vbus = p.vbus; s.ibus = p.ibus; s.touching = p.touching;
    quad.motors.forEach((m, k) => { if (prev.motors[k]) m.s = { ...prev.motors[k].s }; });
    quad.aero.forEach((a, k) => { if (prev.aero[k]) a.damage = { ...prev.aero[k].damage }; });
    quad.motorDamage = prev.motorDamage.map((d) => ({ ...d }));
  } else respawn();
  // a fresh pack (or another quad) powers a browned-out FC up again
  if (brownout.off && !keepBattery) { brownout.reset(); if (bf && fwState === 2) { bf.eepromSet(bf.eepromGet()); powerOnFirmware(); } }
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
  const z = spawnGroundZ(map) + 0.06 - Math.min(...build.params.colliders.map((c) => c.pos.z - c.radius));
  quad.reset({ x: sp.pos.x, y: sp.pos.y, z }, sp.yaw);
  env.wake.reset();
  lastPos = { ...quad.s.pos };
  nextGate = 0;
}

/** The loop's wall-clock <-> sim-time mapping restarts from now (after boot, batches, pauses). */
function resyncClock() { wallStart = performance.now(); simAtWallStart = simT; }

// ---------------------------------------------------------------------------------------------
// Betaflight boot + CLI

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => rej(new Error(what)), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

/** Download + instantiate the firmware: 15 s timeout, one retry that bypasses the HTTP cache. */
async function loadFirmware(): Promise<Betaflight> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    try {
      return await withTimeout(Betaflight.load(FW_URL, { signal: ac.signal, bust: attempt ? String(Date.now()) : undefined }), FW_TIMEOUT_MS, `no answer within ${FW_TIMEOUT_MS / 1000} s`);
    } catch (e) {
      ac.abort(); last = e;
      if (attempt === 0) post({ type: 'log', text: `Betaflight download failed (${(e as Error).message}); retrying` });
    }
  }
  throw last;
}

/** Power the FC on (first boot, or again after a brownout): chip rate, sensors, init(). */
function powerOnFirmware() {
  if (!bf) return;
  bf.setGyroRate(quad.imu.chip.sampleRateHz); // the chip's ODR, read at boot
  primeSensors();
  bf.init();
  gps.powerOn(fcT);
}

async function bootFirmware() {
  fwState = 1; Atomics.store(sh.ctrl, 7, 1);
  try {
    bf = await loadFirmware();
  } catch (e) {
    bf = null; fwState = 3; Atomics.store(sh.ctrl, 7, 3);
    post({ type: 'fwMissing', reason: `Betaflight WASM not found (${(e as Error).message}). Build it with: npm run firmware` });
    return;
  }
  try {
    const [saved, applied, fwSeen] = await Promise.all([eeprom.load(), kv.get('bf-defaults-version'), kv.get('bf-fw-version')]);
    if (saved) bf.eepromSet(saved);
    powerOnFirmware();
    const dt = 1 / settings.physicsHz;
    for (let i = 0; i < Math.round(0.5 / dt); i++) physicsStep(dt); // ~0.5 s boot: gyro calibration etc.
    // the image changed while booting: Betaflight could not use the stored config and reset it
    const fwReset = eeprom.check(bf) && !!saved;
    const why = !saved ? 'First boot' : fwReset ? 'Betaflight reset its stored configuration'
      : applied !== DEFAULTS_VERSION ? 'New simulator defaults' : FW_VERSION !== 'dev' && fwSeen !== FW_VERSION ? 'Firmware updated' : null;
    if (why) {
      post({ type: 'log', text: `${why}: applying fpv-sim defaults over the Betaflight CLI` });
      await cliBatch(defaultCli(build), true);
      await kv.set('bf-defaults-version', DEFAULTS_VERSION);
    }
    if (why || !bf.accCalibrated()) calibrateAcc(true);
    if (FW_VERSION !== 'dev') await kv.set('bf-fw-version', FW_VERSION);
    eeprom.check(bf); await eeprom.flush();
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
  bf.setBattery(b.voltage, 0, current.mah);
  bf.setImu(0, 0, 0, 0, 0, G0);
  rcBuf.fill(1500); rcBuf[2] = 1000; rcBuf[4] = 1000;
  bf.setRc(rcBuf);
}

/**
 * Accelerometer level calibration (as "Calibrate accelerometer" in the Configurator), quad still
 * on its spawn: Betaflight averages 400 samples and saves the offsets itself (persisted on the next
 * EEPROM check). live: the plant flies meanwhile (boot), else it holds still.
 */
function calibrateAcc(live: boolean): boolean {
  if (!bf || !bf.calibrateAcc()) return false;
  const dt = 1 / settings.physicsHz;
  for (let i = 0; i < 3 / dt && bf.accCalibrating(); i++) { if (live) physicsStep(dt); else heldStep(dt); }
  return !bf.accCalibrating();
}

/** Firmware time passes by ms; live: the plant flies (boot), else it holds still (CLI batches). */
function advanceFirmware(ms: number, live: boolean) {
  const dt = 1 / settings.physicsHz;
  for (let i = 0, n = Math.round(ms / 1000 / dt); i < n; i++) { if (live) physicsStep(dt); else heldStep(dt); }
}

/**
 * Run CLI lines on the firmware, persist the EEPROM if they saved. After boot the plant is held at
 * rest meanwhile: opening Settings -> Betaflight (~44 `get`s) or importing a diff must not let a
 * quad that is paused in the air fall and crash.
 */
async function cliBatch(lines: string[], live = false): Promise<string> {
  if (!bf) return '';
  const out = runCliBatch(bf, lines, (ms) => advanceFirmware(ms, live));
  eeprom.check(bf);
  await eeprom.flush();
  resyncClock();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Main lockstep loop

/** Wall-clock time (ms since the epoch) at which the loop meant to simulate sim time t. */
const wallAt = (t: number) => performance.timeOrigin + wallStart + ((t - simAtWallStart) * 1000) / (settings.timeScale || 1);

/**
 * Inputs to the FC that don't depend on whether the plant flies: RC link packets and link stats,
 * battery ADC, baro, GPS UART, blackbox UART. held: the plant is frozen (no current, no motion).
 */
function fcInputs(dt: number, held: boolean) {
  if (!bf) return;
  rcAcc += dt;
  linkAcc += dt;
  if (linkAcc >= 0.05) {
    // slowly varying uplink budget: range, walls, fading (pilot stands at the map's pilot spot)
    rcLink.txPowerMw = settings.rcTxPowerMw ?? 250;
    rcLink.rateHz = settings.rcLinkHz;
    rcLink.updateBudget(world, pilotPos(map, pilotTmp), quad.s.pos, linkAcc);
    linkAcc = 0;
  }
  if (rcAcc >= 1 / settings.rcLinkHz) {
    rcAcc -= 1 / settings.rcLinkHz;
    // a lost packet is really lost: Betaflight sees no new frame (and fails safe if it persists)
    if (rcLink.packet()) {
      // the newest stick sample taken a fixed latency before this packet's slot (timestamped by the
      // main thread); outside real-time stepping (boot, CLI batches) simply the newest poll
      if (!(realtime && sticks.sample(sh, wallAt(simT), rcBuf))) for (let i = 0; i < 16; i++) rcBuf[i] = sh.rc[i];
      for (let i = 0; i < 16; i++) if (!(rcBuf[i] >= 800 && rcBuf[i] <= 2200)) rcBuf[i] = 1500;
      bf.setRc(rcBuf);
    }
    bf.setLinkStats(rcLink.lq, Math.round(rcLink.rssiDbm), rcLink.rfMode);
  }
  battAcc += dt;
  if (battAcc >= 0.001) {
    const b = quad.battery.s;
    const amps = current.step(held ? 0 : b.current, battAcc); // the sensor's reading, mAh integrated from it
    bf.setBattery(b.voltage, amps, current.mah);
    battAcc = 0;
  }
  baroAcc += dt;
  if (baroAcc >= 0.01) {
    baroAcc = 0;
    const air = isa(quad.s.pos.z + map.elevationM, settings.ambientC - 15);
    const thrust = quad.rotorOut.reduce((a, o) => a + o.thrust, 0);
    bf.setBaro(baro.read(air.pressure, air.rho, quad.s.pos.z - map.terrain(quad.s.pos.x, quad.s.pos.y), thrust, diskArea, rotorR));
  }
  gpsAcc += dt;
  if (gpsAcc >= 0.005) {
    gpsAcc = 0;
    gps.fromFc(bf.serialRead(BF_PORT.gps));
    const p = quad.s.pos, v = quad.s.vel;
    const out = gps.tick(fcT, { e: p.x, n: p.y, u: p.z, ve: held ? 0 : v.x, vn: held ? 0 : v.y, vu: held ? 0 : v.z }, Date.now());
    if (out.length) bf.serialWrite(BF_PORT.gps, out);
  }
  bblAcc += dt;
  if (bblAcc >= 0.01) {
    bblAcc = 0;
    const was = bbl.full;
    bbl.push(bf.serialRead(BF_PORT.blackbox), armed);
    if (bbl.full && !was) post({ type: 'log', text: 'Blackbox log full (32 MB): download or clear it to keep recording' });
  }
}

/** Hand Betaflight the IMU sample if the chip latched a new one, then run the FC for dt. */
function stepFirmware(dt: number) {
  if (!bf) return;
  if (imuFresh) {
    const g = quad.imu.gyroOut, a = quad.imu.accOut;
    bf.setImu(g.x, g.y, g.z, a.x, a.y, a.z);
    imuFresh = false;
  }
  bf.step(Math.round(dt * 1e6));
  fcT += dt;
  if (bf.beeper()) beeperSeen = true;
  if (bf.beacon()) beaconSeen = true;
}

/** Track whether the IMU sample taken this step is a new one (call after every imu.sample). */
function noteImuSample(dt: number) {
  const own = (quad.imu as { gyroFresh?: boolean }).gyroFresh; // if the IMU model exposes it, trust it
  const hz = quad.imu.chip.sampleRateHz;
  imuHold += dt;
  let fresh = imuHold >= 1 / hz - 1e-9;
  if (fresh) { imuHold -= 1 / hz; if (imuHold > dt) imuHold = 0; }
  if (hz >= quad.physicsHz) fresh = true;
  imuFresh = typeof own === 'boolean' ? own : fresh;
}

const ZERO: V3 = { x: 0, y: 0, z: 0 }, UP_G: V3 = { x: 0, y: 0, z: G0 }, restForce: V3 = { x: 0, y: 0, z: G0 };
/**
 * The plant holds still (no integration) while firmware time passes: the IMU reads the quad at rest
 * in its current attitude (gravity only, the chip's own bias and noise), the motors don't act.
 */
function heldStep(dt: number) {
  if (!bf) return;
  fcInputs(dt, true);
  rotateInv(restForce, quad.s.q, UP_G);
  quad.imu.sample(ZERO, restForce, ZERO, ZERO, quad.p.mass, dt);
  noteImuSample(dt);
  for (let k = 0; k < 4; k++) erpm[k] = Math.abs(quad.motors[k]?.erpm() ?? 0);
  bf.setErpm(erpm);
  stepFirmware(dt);
  armed = bf.getMotors(motorCmd);
}

function physicsStep(dt: number) {
  // 1S boards: the FC browns out when the pack sags too far, and boots again once it recovers
  if (bf && quad.p.battery.cellsSeries === 1) {
    const ev = brownout.update(quad.s.vbus, dt);
    if (ev === 'down') { post({ type: 'log', text: `Flight controller brownout: the 1S pack sagged to ${quad.s.vbus.toFixed(2)} V (FC rebooting, motors off)` }); blankOsd(); }
    if (ev === 'up') { bf.eepromSet(bf.eepromGet()); powerOnFirmware(); post({ type: 'log', text: 'Flight controller rebooted after the brownout (arm switch must be cycled)' }); }
  }
  // sensors -> FC
  if (bf && !brownout.off) {
    fcInputs(dt, false);
    for (let k = 0; k < 4; k++) erpm[k] = Math.abs(quad.motors[k].erpm());
    bf.setErpm(erpm);
    stepFirmware(dt);
    armed = bf.getMotors(motorCmd);
    quad.command(motorCmd, bf.motorsReversed());
  } else {
    motorCmd.fill(0); armed = false;
    quad.command(motorCmd, false);
  }
  if (specOn) sampleSpectrum(dt);
  quad.step(dt, env);
  noteImuSample(dt);
  env.wake.step(dt, env.wind.meanAt(quad.s.pos.z, { x: 0, y: 0, z: 0 }), map.terrain(quad.s.pos.x, quad.s.pos.y));
  simT += dt;

  // state ring at 1 kHz
  ringAcc += dt;
  if (ringAcc >= RING_DT) { ringAcc -= RING_DT; writeRing(); detectGates(); }

  // crash events
  // An impact spans many physics steps while the contact decelerates the quad; report the peak
  // approach speed of the event (the first steps), not whichever step happened to be last.
  if (quad.s.maxImpact > 0) {
    const v = quad.s.maxImpact;
    quad.s.maxImpact = 0;
    if (simT - impactLastT > 0.15) impactPeak = 0; // a new impact event
    impactLastT = simT;
    if (v > impactPeak) {
      impactPeak = v;
      if (v > CRASH_MIN_MPS) { impactMsg = `Impact ${v.toFixed(1)} m/s`; damageMsg = ''; crashMsgUntil = simT + 2; }
    }
  }
  // damage from this crash (rolled by the quad once per impact event): name it on the banner
  // (the worker consumes the log, so a rebuilt quad with a restarted clock can't confuse it)
  if (quad.damageLog.length) {
    const fresh = quad.damageLog.splice(0);
    const n = (part: string) => fresh.filter((d) => d.part === part).length;
    const bits = [
      n('break') && `${n('break') > 1 ? n('break') + ' props' : 'prop'} broken`,
      n('chip') && `${n('chip') > 1 ? n('chip') + ' props' : 'prop'} chipped`,
      n('shaft') && `motor shaft bent`,
      n('arm') && `arm bent`,
    ].filter(Boolean);
    if (bits.length) {
      damageMsg = bits.join(' · ');
      if (simT >= crashMsgUntil) impactMsg = 'Crash';
      crashMsgUntil = simT + 3;
    }
  }
  crashMsg = impactMsg ? (damageMsg ? `${impactMsg} · ${damageMsg}` : impactMsg) : null;
}

/** A browned-out FC draws no OSD (its OSD chip / displayport is dead too). */
function blankOsd() {
  sh.osd.fill(0x20, 0, OSD_MAX_COLS * OSD_MAX_ROWS); sh.osd.fill(0, OSD_MAX_COLS * OSD_MAX_ROWS);
  Atomics.add(sh.ctrl, 2, 1);
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
  // live buzzer / DShot beacon bits for sample-accurate audio: bit 0 beeper, bit 1 beacon
  Atomics.store(sh.ctrl, 9, bf && !brownout.off ? (bf.beeper() ? 1 : 0) | (bf.beacon() ? 2 : 0) : 0);
}

function detectGates() {
  const p = quad.s.pos;
  const gates = map.gates;
  if (!gates.length) { lastPos = { ...p }; return; }
  const g: GateDef = gates[nextGate % gates.length];
  const passed = gatePassed(g, lastPos, p);
  if (passed) { post({ type: 'gate', gate: g.id, t: simT }); nextGate++; }
  lastPos = { ...p };
}

function sendTelemetry() {
  const b = quad.battery.s;
  const on = bf && !brownout.off ? bf : null;
  const flags = on ? on.armingDisableFlags() : 0;
  const gi = on?.gpsInfo() ?? null;
  const tel: Telemetry = {
    t: simT, fw: bf?.version ?? 'none', armingFlags: flags, armingFlagNames: armingFlagNames(flags),
    modeFlags: on ? on.flightModeFlags() : 0,
    motorTemps: quad.motors.map((m) => m.s.tempC),
    rotorDamage: quad.aero.map((a) => ({ thrust: a.damage.thrustFactor, broken: a.damage.broken })),
    battery: { v: quad.s.vbus, i: quad.s.ibus, soc: b.soc, mah: b.mAhDrawn, tempC: b.tempC, sag: b.sagV, cellV: quad.s.vbus / quad.p.battery.cellsSeries },
    simRate, stepCostUs, attitudeDeg: on ? on.attitude() : [0, 0, 0],
    crash: simT < crashMsgUntil ? crashMsg : null,
    beeper: beeperSeen, beacon: beaconSeen, cpuLoad: on ? on.cpuLoad() : 0,
    gps: gi ? { fix: gi.fix, sats: gi.numSat, homeDistM: gi.homeDistM, homeDirDeg: gi.homeDirDeg } : null,
  };
  beeperSeen = false; beaconSeen = false;
  post({ type: 'telemetry', tel });
}

function pumpSideChannels(dt: number) {
  if (!bf || brownout.off) return;
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
    if (r.length) cliOutBuf += dec.decode(r, { stream: true });
    if (cliOutBuf) { post({ type: 'cliOut', text: cliOutBuf }); cliOutBuf = ''; }
    eeprom.check(bf); // CLI / OSD-menu / MSP `save`: store the new image
  }
}

let lastTickWall = 0;
/** One loop iteration; returns the delay until the next one (ms). */
function tick(): number {
  const now = performance.now();
  const wallDt = Math.min(0.5, (now - lastTickWall) / 1000); lastTickWall = now;
  if (settings.paused || fwState === 1) { resyncClock(); return 10; }
  const target = simAtWallStart + ((now - wallStart) / 1000) * settings.timeScale;
  const dt = 1 / settings.physicsHz;
  let n = Math.floor((target - simT) / dt);
  const maxSteps = Math.floor(0.03 / dt);
  let behind = false;
  if (n > maxSteps) { n = maxSteps; behind = true; }
  const t0 = performance.now();
  realtime = true;
  try { for (let i = 0; i < n; i++) { physicsStep(dt); pumpSideChannels(dt); } } finally { realtime = false; }
  const cost = performance.now() - t0;
  if (n > 0) stepCostUs = stepCostUs * 0.95 + ((cost * 1000) / n) * 0.05;
  if (behind) resyncClock();
  // achievable real-time factor
  const capacity = n > 0 ? (n * dt) / Math.max(1e-6, cost / 1000) : 99;
  simRate = simRate * 0.9 + Math.min(capacity, 99) * 0.1;
  if (n > 0) {
    const hz = governor.update(simRate, settings.timeScale, wallDt, settings.physicsHz, settings.autoRate !== false);
    if (hz) {
      settings = { ...settings, physicsHz: hz };
      buildQuad(true, true); // same flight, new step size
      post({ type: 'overload', simRate, physicsHz: hz });
      resyncClock();
    }
  }
  telAcc += n * dt;
  if (telAcc >= 0.05) { telAcc = 0; sendTelemetry(); }
  return 1;
}

function loop() {
  if (dead) return;
  let delay: number;
  try { delay = tick(); } catch (e) { fatal(e); return; }
  setTimeout(loop, delay);
}

// ---------------------------------------------------------------------------------------------
// Messages. Nothing but 'init' runs before the boot has finished (they are queued, then handled in
// order); firmware operations run strictly one after the other.

let initDone = false;
const early: ToWorker[] = [];
let fwOps: Promise<void> = Promise.resolve();

async function guarded(fn: () => unknown): Promise<void> {
  if (dead) return;
  try { await fn(); } catch (e) { fatal(e); }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  if (dead) return;
  const m = ev.data;
  if (m.type === 'init') { void guarded(() => init(m)); return; }
  if (!initDone) { early.push(m); return; }
  dispatch(m);
};

function dispatch(m: ToWorker) {
  if (m.type === 'spec' || m.type === 'cli' || m.type === 'cliBatch' || m.type === 'factoryReset') fwOps = fwOps.then(() => guarded(() => firmwareOp(m)));
  else void guarded(() => handle(m));
}

async function init(m: Extract<ToWorker, { type: 'init' }>) {
  if (sh) return; // only once
  sh = createShared(m.sab);
  settings = m.settings;
  spec = (m.spec as DroneSpec) ?? DEFAULT_SPEC;
  simT = m.t0 ?? 0;
  await loadMap(settings.mapId);
  buildQuad();
  resyncClock();
  await bootFirmware();
  resyncClock();
  initDone = true;
  for (const q of early.splice(0)) dispatch(q);
  lastTickWall = performance.now();
  loop();
}

async function firmwareOp(m: ToWorker) {
  switch (m.type) {
    case 'spec': {
      const old = spec;
      spec = m.spec as DroneSpec;
      buildQuad();
      // keep firmware hardware settings in sync with the generated airframe
      if (bf && fwState === 2) {
        const b = build.info.components;
        bf.setGyroRate(quad.imu.chip.sampleRateHz); // a different FC: its gyro rate applies from the reboot on save
        const lines = [`set motor_poles = ${b.motor.poles}`, `set motor_kv = ${Math.round(b.motor.kv)}`, `set yaw_motors_reversed = ${spec.propDirection === 'props-out' ? 'ON' : 'OFF'}`, ...batteryCli(build), ...loopCli(build)];
        if (old.video !== spec.video) {
          lines.push(`set vcd_video_system = ${osdGrid(b.video).vcd}`);
          for (const [k, v] of Object.entries(osdLayout(b.video))) lines.push(`set ${k} = ${v}`);
        }
        if ((old.frame === 'f7-lr') !== (spec.frame === 'f7-lr')) lines.push(`set failsafe_procedure = ${spec.frame === 'f7-lr' ? 'GPS-RESCUE' : 'DROP'}`);
        lines.push('save');
        await cliBatch(lines);
        // another board: calibrate its accelerometer on the pad (the quad was just respawned level)
        if (old.fc !== spec.fc || old.frame !== spec.frame) { calibrateAcc(false); eeprom.check(bf); await eeprom.flush(); resyncClock(); }
      }
      break;
    }
    case 'cli': {
      if (bf && fwState === 2) bf.serialWrite(0, enc.encode(m.text)); // replies come back through pumpSideChannels
      break;
    }
    case 'cliBatch': {
      const out = bf && fwState === 2 ? await cliBatch(m.lines) : '';
      post({ type: 'cliBatchDone', id: m.id, output: out });
      break;
    }
    case 'factoryReset': {
      await eeprom.save(new Uint8Array(0));
      if (bf && fwState === 2) {
        await cliBatch(['defaults nosave']);
        await cliBatch(defaultCli(build));
        calibrateAcc(false); eeprom.check(bf); await eeprom.flush(); resyncClock();
        await kv.set('bf-defaults-version', DEFAULTS_VERSION);
      }
      break;
    }
  }
}

async function handle(m: ToWorker) {
  switch (m.type) {
    case 'settings': {
      const mapChanged = m.settings.mapId !== settings.mapId;
      const rateChanged = m.settings.physicsHz !== settings.physicsHz;
      settings = m.settings;
      if (!env || !quad) break;
      if (mapChanged) { if (await loadMap(settings.mapId)) respawn(); }
      else {
        env.wind.p = { ...env.wind.p, speed20ft: settings.wind.speed * (map.windScale ?? 1), directionDeg: settings.wind.direction, turbulence: settings.wind.turbulence, gustiness: settings.wind.gusts, gustMax: settings.wind.speed * 0.8 * (map.windScale ?? 1) };
        env.damageEnabled = settings.damage; env.ambientC = settings.ambientC;
      }
      for (const a of quad.aero) a.propwashScale = settings.propwash;
      if (rateChanged) { governor.reset(); buildQuad(true); }
      resyncClock();
      break;
    }
    case 'registerMap': {
      // a map package loaded from disk (blob: URLs from the main thread)
      registerMap(m.id, packageEntry(m.id, { ...m.info, local: true }, () => urlTableSource(m.urls)));
      if (settings.mapId === m.id && quad) { if (await loadMap(m.id)) respawn(); }
      break;
    }
    case 'reset': {
      if (!quad) break;
      if (m.repair) quad.repair();
      if (m.fullBattery) { buildQuad(); } else respawn();
      // debug / test hook: put the quad somewhere specific (e.g. inside a building)
      if (m.at) { quad.reset({ x: m.at.x, y: m.at.y, z: m.at.z }, (m.at.yawDeg * Math.PI) / 180); env.wake.reset(); lastPos = { ...quad.s.pos }; }
      break;
    }
    case 'spectrum': {
      specOn = m.on; specFill = 0; specAcc = 0; specSawFiltered = false;
      break;
    }
    case 'getBbl': {
      const data = bbl.export();
      (self as unknown as Worker).postMessage({ type: 'bbl', id: m.id, data, sessions: bbl.count } satisfies FromWorker, [data]);
      break;
    }
    case 'clearBbl': bbl.clear(); break;
  }
}
