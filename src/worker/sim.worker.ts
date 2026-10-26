/// <reference lib="webworker" />
// Simulation worker: Betaflight (WASM) and the physics plant in lockstep (the flight core,
// flightCore.ts, shared with the headless environment), paced by the wall clock.
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
import { Betaflight, armingFlagNames } from '../bf/bfModule';
import { batteryCli, defaultCli, loopCli, osdGrid, osdLayout } from '../bf/defaults';
import { DEFAULT_SPEC, DroneBuild, DroneSpec, preloadPropTable } from '../builder/derive';
import { hasMap, MapEntry, MAPS, preloadMap, registerMap } from '../maps/maps';
import { MapDef, withCourse } from '../maps/world';
import { Spectrum } from '../sim/fft';
import { APP_VERSION } from '../ui/menu/about';
import { ACC_CAL_KEY, accBoardKey } from './accCal';
import { BblRecorder } from './bbl';
import { OverloadGovernor } from './fcHardware';
import { FlightCore } from './flightCore';
import { encodeRun, RunLog, RunRecorder, RUN_FORMAT, RUN_GPS_EPOCH_MS, RUN_VERSION } from './runLog';
import { EepromStore } from './fwCli';
import { IdbKv } from './kv';
import { createShared, FromWorker, GyroSpectrum, OSD_MAX_COLS, OSD_MAX_ROWS, R, REC, RING_N, Shared, StickSampler, Telemetry, ToWorker } from './shared';

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
let fwState = 0;

let wallStart = 0, simAtWallStart = 0;
let realtime = false; // inside loop(): sim time maps onto the wall clock (stick timestamps apply)
let osdAcc = 0, telAcc = 0, cliAcc = 0;
let lastOsdFrame = -1;
let stepCostUs = 0;
let simRate = 1;
let cliOutBuf = '';
/** physicsKey() of the settings a run began with */
let runKey = '';
/** EEPROM dirty-check pacing (pumpSideChannels): CLI traffic seen within the last CLI_HOT_S seconds */
const CLI_HOT_S = 2;
let cliHot = 0, eepAcc = 0, eepAfterDisarm = false;
const governor = new OverloadGovernor();
const bbl = new BblRecorder();
/** the reproducible run being recorded, and the last one that ended */
let run: RunRecorder | null = null;
let lastRun: RunLog | null = null;
/** the pilot's own "lower the physics rate automatically" setting, held off while a run records */
let runAutoRate: boolean | undefined;

const kv = new IdbKv(undefined, (why) => post({ type: 'log', text: `Settings storage unavailable (${why}): Betaflight changes won't be kept after a reload` }));
const eeprom = new EepromStore(kv);

// Started the moment the worker runs, before the main thread's init arrives: the firmware download
// and compile, and the stored configuration, come in while the map and the drone are prepared.
const fwPrefetch = Betaflight.prefetch(FW_URL);
const storedConfig = Promise.all([eeprom.load(), kv.get('bf-defaults-version'), kv.get('bf-fw-version'), kv.get(ACC_CAL_KEY)]);
storedConfig.catch(() => {}); // (the store never rejects; bootFirmware awaits it)

// Noise-spectrum analyser: raw IMU gyro vs Betaflight's filtered gyro (debug_mode GYRO_FILTERED),
// sampled every physics step into rings, FFT'd ~10 times a second while the overlay is shown.
const SPEC_N = 2048, SPEC_MAX_HZ = 1000, SPEC_PERIOD = 0.1;
const RAD2DEG = 180 / Math.PI;
let specOn = false, specHead = 0, specFill = 0, specAcc = 0, specSawFiltered = false;
const specRaw = [new Float32Array(SPEC_N), new Float32Array(SPEC_N), new Float32Array(SPEC_N)];
const specFilt = [new Float32Array(SPEC_N), new Float32Array(SPEC_N), new Float32Array(SPEC_N)];
const specFft = new Spectrum(SPEC_N);
const dbg = new Int16Array(8);

// The flight core, hooked up to the shared memory and the message port: sticks from the timestamped
// stick ring (in real-time stepping) or the newest poll, and the 1 kHz state ring.
const core = new FlightCore({
  sticks: (out) => {
    // the stick sample taken a fixed latency before this packet's slot (timestamped by the main
    // thread; a slow input such as a BLE radio is interpolated between its reports, see
    // StickSampler); outside real-time stepping (boot, CLI batches) simply the newest poll
    sticks.packetMs = 1000 / core.settings.rcLinkHz;
    if (!(realtime && sticks.sample(sh, wallAt(core.simT), out))) for (let i = 0; i < 16; i++) out[i] = sh.rc[i];
    run?.packet(core.steps, out);
  },
  log: (text) => post({ type: 'log', text }),
  gate: (gate, t) => post({ type: 'gate', gate, t }),
  brownout: (ev) => { if (ev === 'down') blankOsd(); },
  blackbox: (bytes, armed) => {
    const was = bbl.full;
    bbl.push(bytes, armed);
    if (bbl.full && !was) post({ type: 'log', text: 'Blackbox log full (32 MB): download or clear it to keep recording' });
  },
  record: () => writeRing(),
  afterFirmware: (dt) => { if (specOn) sampleSpectrum(dt); },
});

// ---------------------------------------------------------------------------------------------

/**
 * A map package from disk, as mapFormat.packageEntry builds it, but the package loader (~30 kB) is
 * imported when the map is first loaded instead of with the worker: most sessions never use it.
 */
function localPackageEntry(id: string, info: { name: string; author: string; license: string }, urls: Record<string, string>): MapEntry {
  return {
    name: info.name,
    credit: `Loaded from disk by ${info.author} (${info.license})`,
    community: { author: info.author, license: info.license, local: true },
    build: () => { throw new Error(`map ${id} not loaded: await preloadMap('${id}') first`); },
    prepare: async () => {
      const mf = await import('../maps/mapFormat');
      return mf.packageEntry(id, { ...info, local: true }, () => mf.urlTableSource(urls)).prepare!();
    },
  };
}

/** Load a map for the physics; on failure fly 'field'. Tells the main thread what it got. */
async function loadMap(id: string): Promise<boolean> {
  const want = id;
  let error: string | undefined;
  if (!hasMap(id)) { error = `unknown map "${id}"`; id = 'field'; }
  else await preloadMap(id).catch((e) => { console.warn(e); error = (e as Error)?.message ?? String(e); id = 'field'; });
  if (core.map && want !== core.settings.mapId) return false; // superseded by a newer map change while loading
  // (a run that began while this map was loading flew the old one: it can't go on)
  stopRun('the map changed');
  let m: MapDef;
  try { m = withCourse(MAPS[id](), core.settings.courseId); } catch (e) { error = (e as Error).message; id = 'field'; m = MAPS.field(); }
  core.setMap(m);
  post({ type: 'mapLoaded', id, requested: want, ok: !error, error });
  return true;
}

/**
 * keepBattery: carry the pack's state over; keepState: also carry the flight (pose, motors, damage)
 * over instead of respawning (a physics-rate change mid-flight).
 */
function buildQuad(keepBattery = false, keepState = false) {
  core.buildQuad(keepBattery, keepState);
  post({ type: 'built', info: serializeInfo(core.build) });
}

function serializeInfo(b: DroneBuild) {
  const i = b.info;
  return {
    ...i, components: i.components,
    params: { mass: b.params.mass, inertia: b.params.inertia, cdA: b.params.cdA, rotors: b.params.rotors.map((r) => ({ pos: r.pos, dir: r.dir, kT: r.table.kT, kQ: r.table.kQ, R: r.table.R })), battery: b.params.battery, colliders: b.params.colliders.length },
  };
}

const respawn = () => core.respawn();

/** The loop's wall-clock <-> sim-time mapping restarts from now (after boot, batches, pauses). */
function resyncClock() { wallStart = performance.now(); simAtWallStart = core.simT; }

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
      // the first attempt uses the download started at worker start; the retry bypasses the cache
      return await withTimeout(Betaflight.load(FW_URL, { signal: ac.signal, bust: attempt ? String(Date.now()) : undefined, prefetched: attempt ? undefined : fwPrefetch }), FW_TIMEOUT_MS, `no answer within ${FW_TIMEOUT_MS / 1000} s`);
    } catch (e) {
      ac.abort(); last = e;
      if (attempt === 0) post({ type: 'log', text: `Betaflight download failed (${(e as Error).message}); retrying` });
    }
  }
  throw last;
}

async function bootFirmware() {
  fwState = 1; Atomics.store(sh.ctrl, 7, 1);
  let bf: Betaflight;
  try {
    bf = core.bf = await loadFirmware();
  } catch (e) {
    core.bf = null; fwState = 3; Atomics.store(sh.ctrl, 7, 3);
    post({ type: 'fwMissing', reason: `Betaflight WASM not found (${(e as Error).message}). Build it with: npm run firmware` });
    return;
  }
  try {
    const [saved, applied, fwSeen, accKey] = await storedConfig;
    accCalKey = typeof accKey === 'string' ? accKey : undefined;
    if (saved) bf.eepromSet(saved);
    core.powerOnFirmware();
    const dt = 1 / core.settings.physicsHz;
    for (let i = 0; i < Math.round(0.5 / dt); i++) core.physicsStep(dt); // ~0.5 s boot: gyro calibration etc.
    // the image changed while booting: Betaflight could not use the stored config and reset it
    const fwReset = eeprom.check(bf) && !!saved;
    const why = !saved ? 'First boot' : fwReset ? 'Betaflight reset its stored configuration'
      : applied !== DEFAULTS_VERSION ? 'New simulator defaults' : FW_VERSION !== 'dev' && fwSeen !== FW_VERSION ? 'Firmware updated' : null;
    if (why) {
      post({ type: 'log', text: `${why}: applying fpv-sim defaults over the Betaflight CLI` });
      // on the held plant, as every later batch: the quad sits disarmed on the ground either way, and
      // the ~2.1 s of firmware time (the `save` reboot included) then costs ~0.3 s instead of ~1.5 s
      // of flying physics at 8 kHz
      await cliBatch(defaultCli(core.build));
      await kv.set('bf-defaults-version', DEFAULTS_VERSION);
    }
    // new defaults, another board, or trims from before the level calibration (ACC_CAL_REV)
    if (why || accCalStale()) await calibrateAcc();
    if (FW_VERSION !== 'dev') await kv.set('bf-fw-version', FW_VERSION);
    eeprom.check(bf); await eeprom.flush();
    fwState = 2; core.fwRunning = true; Atomics.store(sh.ctrl, 7, 2);
    post({ type: 'ready', fw: bf.version });
  } catch (e) {
    fwState = 4; Atomics.store(sh.ctrl, 7, 4);
    post({ type: 'fwMissing', reason: `Betaflight failed to boot: ${(e as Error).message}` });
    core.bf = null;
  }
}

/** The board the stored accelerometer trims were made for (accBoardKey; persisted under ACC_CAL_KEY). */
let accCalKey: string | undefined;
/** A CLI save happened: check that the accelerometer is still calibrated (`defaults` clears it). */
let accRecheck = false;

/**
 * Accelerometer level calibration (as "Calibrate accelerometer" in the Configurator, on a level
 * surface): the plant is frozen and Betaflight is fed a level, still quad while it averages its 400
 * samples and saves the trims (src/worker/accCal.ts). Never calibrate wherever the quad happens to
 * lie: a whoop resting on one duct taught Betaflight a 13° roll as level.
 */
async function calibrateAcc(): Promise<boolean> {
  const bf = core.bf;
  if (!bf) return false;
  const ok = core.calibrateAccLevel();
  if (ok) { accCalKey = accBoardKey(core.quad.imu); await kv.set(ACC_CAL_KEY, accCalKey); }
  eeprom.check(bf); await eeprom.flush();
  resyncClock();
  return ok;
}

/** The stored trims don't fit the simulated board: never calibrated, another build's IMU errors, or an older calibration. */
const accCalStale = () => !!core.bf && (!core.bf.accCalibrated() || accCalKey !== accBoardKey(core.quad.imu));

/**
 * Run CLI lines on the firmware, persist the EEPROM if they saved. The plant is held at rest
 * meanwhile: opening Settings -> Betaflight (~44 `get`s) or importing a diff must not let a quad
 * that is paused in the air fall and crash (and the first boot's defaults run on a quad that sits on
 * the ground anyway).
 */
async function cliBatch(lines: string[]): Promise<string> {
  const bf = core.bf;
  if (!bf) return '';
  const out = core.cliBatch(lines);
  eeprom.check(bf);
  await eeprom.flush();
  resyncClock();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Main lockstep loop

/** Wall-clock time (ms since the epoch) at which the loop meant to simulate sim time t. */
const wallAt = (t: number) => performance.timeOrigin + wallStart + ((t - simAtWallStart) * 1000) / (core.settings.timeScale || 1);

/** A browned-out FC draws no OSD (its OSD chip / displayport is dead too). */
function blankOsd() {
  sh.osd.fill(0x20, 0, OSD_MAX_COLS * OSD_MAX_ROWS); sh.osd.fill(0, OSD_MAX_COLS * OSD_MAX_ROWS);
  Atomics.add(sh.ctrl, 2, 1);
}

function sampleSpectrum(dt: number) {
  const g = core.quad.imu.gyroOut, i = specHead, bf = core.bf;
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
    motorHz: core.quad.motors.map((m) => Math.abs(m.rpm()) / 60),
    blades: core.build.info.components.prop.blades,
  };
  (self as unknown as Worker).postMessage({ type: 'spectrum', spec } satisfies FromWorker, [raw.buffer, filtered.buffer]);
}

function writeRing() {
  const { quad, bf, motorCmd, rcBuf, armed, simT } = core;
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
  r[o + R.damage] = core.damageTotal();
  r[o + R.rc0] = rcBuf[0]; r[o + R.rc1] = rcBuf[1]; r[o + R.rc2] = rcBuf[2]; r[o + R.rc3] = rcBuf[3];
  Atomics.store(sh.ctrl, 1, head + 1);
  Atomics.store(sh.ctrl, 5, armed ? 1 : 0);
  // live buzzer / DShot beacon bits for sample-accurate audio: bit 0 beeper, bit 1 beacon
  Atomics.store(sh.ctrl, 9, bf && !core.brownout.off ? (bf.beeper() ? 1 : 0) | (bf.beacon() ? 2 : 0) : 0);
}

function sendTelemetry() {
  const { quad, bf, simT } = core;
  const b = quad.battery.s;
  const on = bf && !core.brownout.off ? bf : null;
  const flags = on ? on.armingDisableFlags() : 0;
  const gi = on?.gpsInfo() ?? null;
  const tel: Telemetry = {
    t: simT, fw: bf?.version ?? 'none', armingFlags: flags, armingFlagNames: armingFlagNames(flags),
    modeFlags: on ? on.flightModeFlags() : 0,
    motorTemps: quad.motors.map((m) => m.s.tempC),
    rotorDamage: quad.aero.map((a) => ({ thrust: a.damage.thrustFactor, broken: a.damage.broken })),
    battery: { v: quad.s.vbus, i: quad.s.ibus, soc: b.soc, mah: b.mAhDrawn, tempC: b.tempC, sag: b.sagV, cellV: quad.s.vbus / quad.p.battery.cellsSeries },
    simRate, stepCostUs, attitudeDeg: on ? on.attitude() : [0, 0, 0],
    crash: simT < core.crashMsgUntil ? core.crashMsg : null,
    beeper: core.beeperSeen, beacon: core.beaconSeen, cpuLoad: on ? on.cpuLoad() : 0,
    gps: gi ? { fix: gi.fix, sats: gi.numSat, homeDistM: gi.homeDistM, homeDirDeg: gi.homeDirDeg } : null,
    impact: core.lastImpact,
  };
  core.beeperSeen = false; core.beaconSeen = false;
  post({ type: 'telemetry', tel });
}

function pumpSideChannels(dt: number) {
  const bf = core.bf;
  if (!bf || core.brownout.off) return;
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
    const dtc = cliAcc;
    cliAcc = 0;
    const r = bf.serialRead(0);
    if (r.length) { cliOutBuf += dec.decode(r, { stream: true }); cliHot = CLI_HOT_S; }
    if (cliOutBuf) { post({ type: 'cliOut', text: cliOutBuf }); cliOutBuf = ''; }
    // CLI / OSD-menu `save`: store the new image. The check hashes the whole 32 KB image (~43 µs):
    // every 10 ms while the CLI console is in use, else 10 times a second, never while armed (no
    // save is possible then; checked once right after the disarm instead)
    cliHot = Math.max(0, cliHot - dtc);
    eepAcc += dtc;
    if (core.armed) eepAfterDisarm = true;
    else if (cliHot > 0 || eepAfterDisarm || eepAcc >= 0.1) {
      eepAcc = 0; eepAfterDisarm = false;
      if (eeprom.check(bf)) accRecheck = true;
    }
  }
}

let lastTickWall = 0;
/** One loop iteration; returns the delay until the next one (ms). */
function tick(): number {
  const now = performance.now();
  const wallDt = Math.min(0.5, (now - lastTickWall) / 1000); lastTickWall = now;
  const settings = core.settings;
  if (settings.paused || fwState === 1) { resyncClock(); return 10; }
  const target = simAtWallStart + ((now - wallStart) / 1000) * settings.timeScale;
  const dt = 1 / settings.physicsHz;
  let n = Math.floor((target - core.simT) / dt);
  const maxSteps = Math.floor(0.03 / dt);
  let behind = false;
  if (n > maxSteps) { n = maxSteps; behind = true; }
  const t0 = performance.now();
  realtime = true;
  try { for (let i = 0; i < n; i++) { core.physicsStep(dt); pumpSideChannels(dt); } } finally { realtime = false; }
  const cost = performance.now() - t0;
  if (n > 0) stepCostUs = stepCostUs * 0.95 + ((cost * 1000) / n) * 0.05;
  if (behind) resyncClock();
  // achievable real-time factor
  const capacity = n > 0 ? (n * dt) / Math.max(1e-6, cost / 1000) : 99;
  simRate = simRate * 0.9 + Math.min(capacity, 99) * 0.1;
  if (n > 0) {
    const hz = governor.update(simRate, settings.timeScale, wallDt, settings.physicsHz, settings.autoRate !== false && !run);
    if (hz) {
      core.settings = { ...settings, physicsHz: hz };
      buildQuad(true, true); // same flight, new step size
      post({ type: 'overload', simRate, physicsHz: hz });
      resyncClock();
    }
  }
  telAcc += n * dt;
  if (telAcc >= 0.05) { telAcc = 0; sendTelemetry(); }
  // a CLI `defaults` / acc_calibration change left the accelerometer uncalibrated: the simulator has
  // no Calibrate button, so redo the level calibration (disarmed, after any queued firmware work)
  if (accRecheck && !core.armed && fwState === 2) {
    accRecheck = false;
    if (accCalStale()) fwOps = fwOps.then(() => guarded(async () => { if (core.bf && fwState === 2 && !core.armed && accCalStale()) await calibrateAcc(); }));
  }
  // behind, or a millisecond of steps is due already (this tick took that long): go on at once
  if (behind || simAtWallStart + ((performance.now() - wallStart) / 1000) * core.settings.timeScale - core.simT >= 0.001) return 0;
  return 1;
}

/**
 * Next loop iteration: delay 0 yields through a MessageChannel (a task, so messages still get in,
 * without the timer's 1 ms minimum, which becomes 4 ms once timeouts nest five deep: a worker that
 * is behind would idle 4 ms per iteration and the overload governor would see a slower machine).
 */
const loopChannel = new MessageChannel();
loopChannel.port1.onmessage = () => loop();
function loop() {
  if (dead) return;
  let delay: number;
  try { delay = tick(); } catch (e) { fatal(e); return; }
  if (delay <= 0) loopChannel.port2.postMessage(0); else setTimeout(loop, delay);
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
  if (m.type === 'spec' || m.type === 'cli' || m.type === 'cliBatch' || m.type === 'factoryReset' || m.type === 'runStart' || m.type === 'runStop' || m.type === 'sync') fwOps = fwOps.then(() => guarded(() => firmwareOp(m)));
  else void guarded(() => handle(m));
}

async function init(m: Extract<ToWorker, { type: 'init' }>) {
  if (sh) return; // only once
  sh = createShared(m.sab);
  core.settings = m.settings;
  core.spec = (m.spec as DroneSpec) ?? DEFAULT_SPEC;
  core.simT = m.t0 ?? 0;
  // the prop's precomputed BEMT table comes in alongside the map (else buildQuad spends ~1.2 s on it)
  await Promise.all([loadMap(core.settings.mapId), preloadPropTable(core.spec.prop)]);
  buildQuad();
  resyncClock();
  await bootFirmware();
  resyncClock();
  initDone = true;
  for (const q of early.splice(0)) dispatch(q);
  lastTickWall = performance.now();
  loop();
}

/** The physics-relevant settings (a change ends a reproducible run; pausing and the time scale don't). */
const physicsKey = (s: typeof core.settings) => JSON.stringify({ ...s, paused: false, timeScale: 1 });

/** End the run being recorded (it stays available as the last run). */
function stopRun(reason: string) {
  if (!run) return;
  lastRun = run.finish(core.steps, reason);
  run = null;
  core.endRun();
  core.settings = { ...core.settings, autoRate: runAutoRate };
  post({ type: 'runState', active: false, reason });
}

async function firmwareOp(m: ToWorker) {
  // anything that changes the flight controller or the airframe ends a reproducible run
  if (run && (m.type === 'spec' || m.type === 'cli' || m.type === 'cliBatch' || m.type === 'factoryReset')) stopRun(m.type === 'spec' ? 'the drone changed' : 'Betaflight was configured');
  switch (m.type) {
    case 'sync': post({ type: 'synced', id: m.id }); break;
    case 'runStart': {
      const bf = core.bf;
      if (!bf || fwState !== 2) { post({ type: 'log', text: 'Reproducible run: Betaflight is not running' }); break; }
      stopRun('a new run started');
      // a never-booted FC with the current configuration, the world and the quad rebuilt, every random
      // stream seeded: what follows depends only on the sticks of each RC packet, which are recorded
      const eeprom = bf.eepromGet().slice();
      const fresh = await bf.spawn();
      runAutoRate = core.settings.autoRate;
      core.settings = { ...core.settings, autoRate: false };
      core.beginRun(fresh, eeprom, m.seed, RUN_GPS_EPOCH_MS);
      governor.reset();
      run = new RunRecorder({
        format: RUN_FORMAT, version: RUN_VERSION, app: `fpv-sim ${APP_VERSION}`, firmware: fresh.version, firmwareBuild: FW_VERSION,
        created: new Date().toISOString(), seed: m.seed >>> 0, mapId: core.map.id, courseId: core.settings.courseId ?? '',
        settings: { ...core.settings, paused: false, timeScale: 1 }, spec: structuredClone(core.spec), eeprom,
      });
      runKey = physicsKey(core.settings);
      post({ type: 'built', info: serializeInfo(core.build) });
      post({ type: 'runState', active: true, seed: m.seed >>> 0 });
      post({ type: 'log', text: `Reproducible run started (seed ${m.seed >>> 0}): Betaflight rebooted, the quad is on the pad` });
      resyncClock();
      break;
    }
    case 'runStop': {
      stopRun('stopped');
      const r = lastRun;
      const data = r ? (await encodeRun(r)).slice().buffer : new ArrayBuffer(0);
      const seconds = r ? r.steps / r.settings.physicsHz : 0;
      (self as unknown as Worker).postMessage({ type: 'run', id: m.id, data, seconds, reason: r?.end ?? 'no run' } satisfies FromWorker, [data]);
      break;
    }
    case 'spec': {
      await preloadPropTable((m.spec as DroneSpec).prop);
      const old = core.spec;
      const spec = core.spec = m.spec as DroneSpec;
      buildQuad();
      // keep firmware hardware settings in sync with the generated airframe
      const bf = core.bf;
      if (bf && fwState === 2) {
        const build = core.build, b = build.info.components;
        bf.setGyroRate(core.quad.imu.chip.sampleRateHz); // a different FC: its gyro rate applies from the reboot on save
        const lines = [`set motor_poles = ${b.motor.poles}`, `set motor_kv = ${Math.round(b.motor.kv)}`, `set yaw_motors_reversed = ${spec.propDirection === 'props-out' ? 'ON' : 'OFF'}`, ...batteryCli(build), ...loopCli(build)];
        if (old.video !== spec.video) {
          lines.push(`set vcd_video_system = ${osdGrid(b.video).vcd}`);
          for (const [k, v] of Object.entries(osdLayout(b.video))) lines.push(`set ${k} = ${v}`);
        }
        if ((old.frame === 'f7-lr') !== (spec.frame === 'f7-lr')) lines.push(`set failsafe_procedure = ${spec.frame === 'f7-lr' ? 'GPS-RESCUE' : 'DROP'}`);
        lines.push('save');
        await cliBatch(lines);
        // another board (its own accelerometer offsets and misalignment): calibrate it level
        if (accCalStale()) await calibrateAcc();
      }
      break;
    }
    case 'cli': {
      if (core.bf && fwState === 2) { core.bf.serialWrite(0, enc.encode(m.text)); cliHot = CLI_HOT_S; } // replies come back through pumpSideChannels
      break;
    }
    case 'cliBatch': {
      const out = core.bf && fwState === 2 ? await cliBatch(m.lines) : '';
      // (an imported diff never carries acc_calibration, but `defaults` in a batch clears it)
      if (core.bf && fwState === 2 && !core.armed && accCalStale()) await calibrateAcc();
      post({ type: 'cliBatchDone', id: m.id, output: out });
      break;
    }
    case 'factoryReset': {
      await eeprom.save(new Uint8Array(0));
      if (core.bf && fwState === 2) {
        await cliBatch(['defaults nosave']);
        await cliBatch(defaultCli(core.build));
        await calibrateAcc();
        await kv.set('bf-defaults-version', DEFAULTS_VERSION);
      }
      break;
    }
  }
}

async function handle(m: ToWorker) {
  switch (m.type) {
    case 'settings': {
      const prev = core.settings;
      if (run && physicsKey({ ...m.settings, autoRate: false }) !== runKey) stopRun('the simulation settings changed');
      // (a run keeps the physics rate fixed)
      if (run) { runAutoRate = m.settings.autoRate; m = { ...m, settings: { ...m.settings, autoRate: false } }; }
      const mapChanged = m.settings.mapId !== prev.mapId || (m.settings.courseId ?? '') !== (prev.courseId ?? '');
      const rateChanged = m.settings.physicsHz !== prev.physicsHz;
      core.settings = m.settings;
      if (!core.env || !core.quad) break;
      if (mapChanged) { if (await loadMap(core.settings.mapId)) respawn(); for (const a of core.quad.aero) a.propwashScale = core.settings.propwash; }
      else core.applyWindSettings();
      if (rateChanged) { governor.reset(); buildQuad(true); }
      resyncClock();
      break;
    }
    case 'registerMap': {
      // a map package loaded from disk (blob: URLs from the main thread); registered at once, so a
      // settings message right behind it finds the map
      registerMap(m.id, localPackageEntry(m.id, m.info, m.urls));
      if (run && core.settings.mapId === m.id) stopRun('the map was reloaded');
      if (core.settings.mapId === m.id && core.quad) { if (await loadMap(m.id)) respawn(); }
      break;
    }
    case 'reset': {
      if (!core.quad) break;
      const ev = { repair: !!m.repair, fullBattery: !!m.fullBattery, at: m.at ? { ...m.at } : undefined };
      run?.events.push({ k: core.steps, type: 'reset', ...ev });
      // (at: a debug / test hook, and the control API's teleport)
      core.applyReset(ev);
      if (m.fullBattery) post({ type: 'built', info: serializeInfo(core.build) });
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
