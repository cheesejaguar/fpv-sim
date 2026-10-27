// The lock-step flight core: Betaflight (WASM) and the physics plant, stepped together, with the
// flight controller's peripherals (RC link, battery ADC through the current sensor, barometer, u-blox
// GPS, serial blackbox) and the 1S brownout. One implementation, two hosts:
//   - the browser's simulation worker (sim.worker.ts): real-time loop, shared memory, messages;
//   - the headless environment (src/headless/env.ts): stepped by a program, as fast as it can go.
// Everything a host does differently comes in through FlightHooks (where the sticks come from,
// where logs and gate passes go, the wall clock for GPS time). With the same hooks, seeds and
// inputs, a run is bit-identical in both.
//
// Each physics step (default 125 µs = 8 kHz):
//   IMU sample -> bf_set_gyro_acc -> bf_step(dt) -> bf_get_motors -> ESC/motor/rotor/body step
import { BF_PORT, Betaflight } from '../bf/bfModule';
import { buildDrone, DroneBuild, DroneSpec } from '../builder/derive';
import { gatePassed } from '../maps/gates';
import { GateDef, LosLoss, MapDef, pilotPos, PrimitiveWorld, spawnGroundZ } from '../maps/world';
import { ActorSim, DetectEvent, LookContext, lightLevel, REF_SIZE_M } from '../sim/actors';
import { G0, isa } from '../sim/atmosphere';
import { rotateInv, subSeed, V3 } from '../sim/math';
import { QuadEnv, QuadSim } from '../sim/quad';
import { RcLink } from '../sim/rcLink';
import { WakeField } from '../sim/wake';
import { Wind } from '../sim/wind';
import { calibrateAccLevel, sampleLevelRest } from './accCal';
import { BaroModel, Brownout, CurrentSensor, seedOf } from './fcHardware';
import { runCliBatch } from './fwCli';
import { DEFAULT_SETTINGS, SimSettings } from './shared';
import { GPS_ORIGIN, UbxReceiver } from './ubxGps';

/** What the host provides. Only `sticks` is required. */
export interface FlightHooks {
  /**
   * Fill `out` (16 channels, µs) with the sticks for the RC packet being sent now (only packets the
   * link delivers ask). Values outside 800..2200 are replaced by 1500.
   */
  sticks(out: Float32Array): void;
  log?(text: string): void;
  /** the next gate of the course was passed at sim time t */
  gate?(gate: number, t: number): void;
  /** the 1S flight controller lost power ('down') or booted again ('up') */
  brownout?(ev: 'down' | 'up'): void;
  /** Betaflight's serial blackbox bytes (every 10 ms) */
  blackbox?(bytes: Uint8Array, armed: boolean): void;
  /** called once per RING_DT of sim time, before the gate check (the worker writes its state ring) */
  record?(): void;
  /** called every physics step after the FC ran, before the plant steps (the gyro spectrum) */
  afterFirmware?(dt: number): void;
  /** wall clock for the GPS's UTC time (ms since the epoch); default Date.now */
  wallMs?(): number;
  /** a detector of the map's actors began (on) or stopped holding a detection of the quad, at actor time e.t */
  detect?(e: DetectEvent): void;
}

export interface FlightCoreOptions {
  /**
   * Seeds every random stream of the run: plant noise, wind turbulence, RC link fading and packet
   * loss, barometer noise. Unset: the fixed seeds the app has always used.
   */
  seed?: number;
}

/** A crash worth flagging: ~4 m/s into something, or anything that actually damaged the quad. */
export const CRASH_MIN_MPS = 4;
/** State-ring / gate-check interval (s). */
export const RECORD_DT = 0.001;
const WAKE_DT = 0.001 - 1e-9;

const ZERO: V3 = { x: 0, y: 0, z: 0 }, UP_G: V3 = { x: 0, y: 0, z: G0 };

export class FlightCore {
  settings: SimSettings = DEFAULT_SETTINGS;
  spec!: DroneSpec;
  build!: DroneBuild;
  quad!: QuadSim;
  map!: MapDef;
  world!: PrimitiveWorld;
  env!: QuadEnv;
  bf: Betaflight | null = null;
  /** the firmware finished booting (the worker's fwState 2): a brownout recovery may power it on again */
  fwRunning = false;

  simT = 0;   // plant time (s)
  fcT = 0;    // firmware time (s): also runs while the plant is held during CLI batches
  readonly motorCmd = new Uint16Array(4);
  readonly erpm = new Float32Array(4);
  /** the RC channels Betaflight last received (µs) */
  readonly rcBuf = new Float32Array(16).fill(1500);
  armed = false;
  // crash banner: the newest impact / damage, shown until crashMsgUntil (sim time)
  crashMsg: string | null = null;
  crashMsgUntil = 0;
  private impactMsg = ''; private damageMsg = '';
  private impactPeak = 0; private impactLastT = -1;
  /** peak approach speed of the newest impact event (m/s), and when it happened */
  lastImpact = { speed: 0, t: -1 };
  lastPos: V3 = { x: 0, y: 0, z: 0 };
  nextGate = 0;
  /** beeper / beacon seen since the host last cleared these (their patterns are faster than its updates) */
  beeperSeen = false; beaconSeen = false;

  // FC hardware imperfections (seeded per drone build) and peripherals
  rcLink: RcLink;
  baro: BaroModel;
  current = new CurrentSensor(1);
  readonly brownout = new Brownout(2.8, 0.03, 3.0, 0.8); // 0.8 s: regulator back up + MCU boot
  gps = new UbxReceiver(GPS_ORIGIN);
  diskArea = 0; rotorR = 0.05;
  /** physics steps since the run began (beginRun), or since the core was made */
  steps = 0;
  /**
   * GPS UTC time = gpsEpochMs + firmware time, instead of the host's wall clock: a seeded run must
   * never read the wall clock (null: hooks.wallMs, else Date.now)
   */
  gpsEpochMs: number | null = null;

  private linkAcc = 0; private wakeAcc = 0; private ringAcc = 0;
  private rcAcc = 0; private battAcc = 0; private baroAcc = 0; private gpsAcc = 0; private bblAcc = 0;
  // IMU sample-and-hold mirror: a slower chip (BMI270 3.2 kHz) hands Betaflight a new sample only on
  // the physics steps where it latched one (see src/sim/imu.ts holdT)
  private imuHold = 0; private imuFresh = true;
  private readonly pilotTmp: V3 = { x: 0, y: 0, z: 0 };
  private readonly wakeWind: V3 = { x: 0, y: 0, z: 0 };
  private readonly restForce: V3 = { x: 0, y: 0, z: G0 };
  seed: number | undefined;
  /**
   * The map's actors (null: none, and nothing below runs). Actor time is sim time since actorT0:
   * the map was set, the run began or the quad respawned (src/sim/actors.ts posAt).
   */
  actors: ActorSim | null = null;
  actorT0 = 0;
  /** the RC uplink's transmitter: -1 the pilot, else the index of a ground station (ActorSim.rcSite) */
  rcSiteIndex = -1;
  private readonly losTmp: LosLoss = { db: 0, hardDb: 0, foliageDb: 0 };
  private lookCtx: LookContext | null = null;

  constructor(public hooks: FlightHooks, opts: FlightCoreOptions = {}) {
    this.seed = opts.seed;
    this.rcLink = new RcLink(this.sub(0x5eed));
    this.baro = new BaroModel(this.sub(0xba50));
  }

  /**
   * Begin a reproducible run on `bf`, a never-booted flight controller, with this configuration
   * image: every random stream seeded from `seed`, every peripheral and accumulator fresh, the world
   * and the quad rebuilt, the FC powered on. What follows is a pure function of the sticks of each RC
   * packet: the browser's worker records them, and the headless simulator (src/headless/replay.ts)
   * makes exactly these calls before replaying them. Settings, spec and map must be set first.
   */
  beginRun(bf: Betaflight, eeprom: Uint8Array, seed: number, gpsEpochMs: number) {
    this.seed = seed >>> 0;
    this.rcLink = new RcLink(this.sub(0x5eed));
    this.baro = new BaroModel(this.sub(0xba50));
    this.gps = new UbxReceiver(GPS_ORIGIN);
    this.gpsEpochMs = gpsEpochMs;
    this.linkAcc = 0; this.wakeAcc = 0; this.ringAcc = 0;
    this.rcAcc = 0; this.battAcc = 0; this.baroAcc = 0; this.gpsAcc = 0; this.bblAcc = 0;
    this.fcT = 0; this.steps = 0;
    this.impactPeak = 0; this.impactLastT = -Infinity; this.lastImpact = { speed: 0, t: -1 };
    this.crashMsg = null; this.crashMsgUntil = 0;
    this.armed = false; this.motorCmd.fill(0); this.rcBuf.fill(1500);
    this.brownout.reset();
    this.setMap(this.map);
    this.bf = bf;
    bf.eepromSet(eeprom);
    this.buildQuad();
    this.powerOnFirmware();
    this.fwRunning = true;
  }

  /** Leave the run's fixed GPS clock (back to the host's wall clock). */
  endRun() { this.gpsEpochMs = null; }

  /** The seed of one random stream: fixed (the app's own) when the run is unseeded. */
  private sub(k: number) { return this.seed === undefined ? k : subSeed(this.seed, k); }

  private log(t: string) { this.hooks.log?.(t); }

  makeEnv(): QuadEnv {
    const { map, settings } = this;
    const ws = map.windScale ?? 1;
    const w = new Wind({ speed20ft: settings.wind.speed * ws, directionDeg: settings.wind.direction, z0: map.groundMat === 'grass' ? 0.03 : 0.3, turbulence: settings.wind.turbulence, gustiness: settings.wind.gusts, gustMax: settings.wind.speed * 0.8 * ws }, this.sub(1234)); // calm air: no gusts
    w.zones = map.wakeZones; w.indoor = map.indoor ?? [];
    return { world: this.world, wind: w, wake: new WakeField(), ambientC: settings.ambientC, altitudeOffset: map.elevationM, damageEnabled: settings.damage };
  }

  /** Fly this map from now on (its collision world, wind, GPS origin and actors). */
  setMap(m: MapDef) {
    this.map = m;
    this.world = new PrimitiveWorld(m);
    this.env = this.makeEnv();
    this.gps.origin = { ...GPS_ORIGIN, altM: m.elevationM ?? 0 };
    // actors draw from their own stream: a map without them changes nothing else
    this.actors = m.actors?.length ? new ActorSim(m, this.sub(0xac70)) : null;
    this.resetActors();
  }

  /** Sim time of the actors (s): their paths start over when the map is set, the run begins or the quad respawns. */
  get actorT(): number { return this.simT - this.actorT0; }

  /** The actors start over from now: back at the start of their paths, detectors without looks. */
  resetActors() {
    this.actorT0 = this.simT;
    this.rcSiteIndex = -1;
    this.lookCtx = null;
    this.actors?.reset(this.sub(0xac70));
  }

  /** The wind follows changed settings without restarting its turbulence. */
  applyWindSettings() {
    const { env, map, settings } = this;
    env.wind.p = { ...env.wind.p, speed20ft: settings.wind.speed * (map.windScale ?? 1), directionDeg: settings.wind.direction, turbulence: settings.wind.turbulence, gustiness: settings.wind.gusts, gustMax: settings.wind.speed * 0.8 * (map.windScale ?? 1) };
    env.damageEnabled = settings.damage; env.ambientC = settings.ambientC;
    for (const a of this.quad.aero) a.propwashScale = settings.propwash;
  }

  /**
   * keepBattery: carry the pack's state over; keepState: also carry the flight (pose, motors, damage)
   * over instead of respawning (a physics-rate change mid-flight).
   */
  buildQuad(keepBattery = false, keepState = false) {
    const { spec, settings } = this;
    this.build = buildDrone(spec);
    const prev = this.quad as QuadSim | undefined;
    const quad = new QuadSim(this.build.params, settings.physicsHz, spec.batterySoc, settings.ambientC, this.seed === undefined ? undefined : this.sub(0x9a1d));
    this.quad = quad;
    this.imuHold = 0; this.imuFresh = true;
    if (keepBattery && prev) quad.battery.s = { ...prev.battery.s };
    else this.current.reset();
    for (const a of quad.aero) a.propwashScale = settings.propwash;
    this.diskArea = this.build.params.rotors.reduce((a, r) => a + Math.PI * r.table.R * r.table.R, 0);
    this.rotorR = this.build.params.rotors[0]?.table.R ?? 0.05;
    // sensor errors belong to the board: the same build keeps the same offsets
    const seed = seedOf(`${spec.fc}|${spec.frame}|${spec.esc}|${spec.battery}` + (spec.unitSeed != null ? `|#${spec.unitSeed >>> 0}` : ''));
    if (!keepBattery) this.current = new CurrentSensor(seed);
    // (prop imbalance, including the builder override, now comes from the rotor config)
    if (keepState && prev) {
      const s = quad.s, p = prev.s;
      s.pos = { ...p.pos }; s.vel = { ...p.vel }; s.q = { ...p.q }; s.w = { ...p.w }; s.vbus = p.vbus; s.ibus = p.ibus; s.touching = p.touching;
      quad.motors.forEach((m, k) => { if (prev.motors[k]) m.s = { ...prev.motors[k].s }; });
      quad.aero.forEach((a, k) => { if (prev.aero[k]) a.damage = { ...prev.aero[k].damage }; });
      quad.motorDamage = prev.motorDamage.map((d) => ({ ...d }));
    } else this.respawn();
    // a fresh pack (or another quad) powers a browned-out FC up again
    if (this.brownout.off && !keepBattery) { this.brownout.reset(); if (this.bf && this.fwRunning) { this.bf.eepromSet(this.bf.eepromGet()); this.powerOnFirmware(); } }
  }

  /** Back on the map's spawn pad, at rest (the course starts over). */
  respawn() {
    const sp = this.map.spawn;
    const z = spawnGroundZ(this.map) + 0.06 - Math.min(...this.build.params.colliders.map((c) => c.pos.z - c.radius));
    this.quad.reset({ x: sp.pos.x, y: sp.pos.y, z }, sp.yaw);
    this.env.wake.reset(); this.wakeAcc = 0;
    this.lastPos = { ...this.quad.s.pos };
    this.nextGate = 0;
    if (this.actors) this.resetActors();
  }

  /**
   * A respawn as the pilot asks for it (reset key, pause menu): repaired, a fresh pack (a rebuilt
   * quad) or the same one, at the start or somewhere specific (yaw in degrees).
   */
  applyReset(r: { repair?: boolean; fullBattery?: boolean; at?: V3 & { yawDeg: number } }) {
    if (r.repair) this.quad.repair();
    if (r.fullBattery) this.buildQuad(); else this.respawn();
    if (r.at) this.placeAt(r.at, (r.at.yawDeg * Math.PI) / 180);
  }

  /** Put the quad somewhere specific, at rest (yaw in rad). */
  placeAt(pos: V3, yaw: number) {
    this.quad.reset({ x: pos.x, y: pos.y, z: pos.z }, yaw);
    this.env.wake.reset();
    this.lastPos = { ...this.quad.s.pos };
  }

  /** Power the FC on (first boot, or again after a brownout): chip rate, sensors, init(). */
  powerOnFirmware() {
    const bf = this.bf;
    if (!bf) return;
    bf.setGyroRate(this.quad.imu.chip.sampleRateHz); // the chip's ODR, read at boot
    this.primeSensors();
    bf.init();
    this.gps.powerOn(this.fcT);
  }

  primeSensors() {
    const bf = this.bf;
    if (!bf) return;
    const b = this.quad.battery.s;
    bf.setBattery(b.voltage, 0, this.current.mah);
    bf.setImu(0, 0, 0, 0, 0, G0);
    this.rcBuf.fill(1500); this.rcBuf[2] = 1000; this.rcBuf[4] = 1000;
    bf.setRc(this.rcBuf);
  }

  /**
   * Inputs to the FC that don't depend on whether the plant flies: RC link packets and link stats,
   * battery ADC, baro, GPS UART, blackbox UART. held: the plant is frozen (no current, no motion).
   */
  fcInputs(dt: number, held: boolean) {
    const bf = this.bf;
    if (!bf) return;
    const { quad, settings, rcLink, rcBuf, map } = this;
    this.rcAcc += dt;
    this.linkAcc += dt;
    if (this.linkAcc >= 0.05) {
      // slowly varying uplink budget: range, walls, fading (pilot stands at the map's pilot spot)
      rcLink.txPowerMw = settings.rcTxPowerMw ?? 250;
      rcLink.rateHz = settings.rcLinkHz;
      const act = this.actors;
      if (act) {
        // the map's actors: the best uplink site (pilot or a ground station), jammers in the band
        const t = this.actorT, obs = (a: V3, b: V3) => this.world.obstructionDb(a, b);
        const site = act.rcSite(t, pilotPos(map, this.pilotTmp), rcLink.txPowerMw, quad.s.pos, obs, this.rcSiteIndex);
        this.rcSiteIndex = site.index;
        rcLink.txPowerMw = site.txPowerMw; rcLink.txGainDbi = site.gainDbi;
        rcLink.updateBudget(this.world, site.pos, quad.s.pos, this.linkAcc, act.rcInterferenceMw(t, quad.s.pos, obs, rcLink.rxGainDbi));
      } else rcLink.updateBudget(this.world, pilotPos(map, this.pilotTmp), quad.s.pos, this.linkAcc);
      this.linkAcc = 0;
    }
    if (this.rcAcc >= 1 / settings.rcLinkHz) {
      this.rcAcc -= 1 / settings.rcLinkHz;
      // a lost packet is really lost: Betaflight sees no new frame (and fails safe if it persists)
      if (rcLink.packet()) {
        this.hooks.sticks(rcBuf);
        for (let i = 0; i < 16; i++) if (!(rcBuf[i] >= 800 && rcBuf[i] <= 2200)) rcBuf[i] = 1500;
        bf.setRc(rcBuf);
      }
      bf.setLinkStats(rcLink.lq, Math.round(rcLink.rssiDbm), rcLink.rfMode);
    }
    this.battAcc += dt;
    if (this.battAcc >= 0.001) {
      const b = quad.battery.s;
      const amps = this.current.step(held ? 0 : b.current, this.battAcc); // the sensor's reading, mAh integrated from it
      bf.setBattery(b.voltage, amps, this.current.mah);
      this.battAcc = 0;
    }
    this.baroAcc += dt;
    if (this.baroAcc >= 0.01) {
      this.baroAcc = 0;
      const air = isa(quad.s.pos.z + map.elevationM, settings.ambientC - 15);
      const thrust = quad.rotorOut.reduce((a, o) => a + o.thrust, 0);
      bf.setBaro(this.baro.read(air.pressure, air.rho, quad.s.pos.z - map.terrain(quad.s.pos.x, quad.s.pos.y), thrust, this.diskArea, this.rotorR));
    }
    this.gpsAcc += dt;
    if (this.gpsAcc >= 0.005) {
      this.gpsAcc = 0;
      this.gps.fromFc(bf.serialRead(BF_PORT.gps));
      const p = quad.s.pos, v = quad.s.vel;
      const wall = this.gpsEpochMs !== null ? this.gpsEpochMs + this.fcT * 1000 : this.hooks.wallMs ? this.hooks.wallMs() : Date.now();
      const out = this.gps.tick(this.fcT, { e: p.x, n: p.y, u: p.z, ve: held ? 0 : v.x, vn: held ? 0 : v.y, vu: held ? 0 : v.z }, wall);
      if (out.length) bf.serialWrite(BF_PORT.gps, out);
    }
    this.bblAcc += dt;
    if (this.bblAcc >= 0.01) {
      this.bblAcc = 0;
      const bytes = bf.serialRead(BF_PORT.blackbox);
      this.hooks.blackbox?.(bytes, this.armed);
    }
  }

  /** Hand Betaflight the IMU sample if the chip latched a new one, then run the FC for dt. */
  stepFirmware(dt: number) {
    const bf = this.bf;
    if (!bf) return;
    if (this.imuFresh) {
      const g = this.quad.imu.gyroOut, a = this.quad.imu.accOut;
      bf.setImu(g.x, g.y, g.z, a.x, a.y, a.z);
      this.imuFresh = false;
    }
    bf.step(Math.round(dt * 1e6));
    this.fcT += dt;
    // (once seen, not asked again until the host reports and clears it)
    if (!this.beeperSeen && bf.beeper()) this.beeperSeen = true;
    if (!this.beaconSeen && bf.beacon()) this.beaconSeen = true;
  }

  /** Track whether the IMU sample taken this step is a new one (call after every imu.sample). */
  noteImuSample(dt: number) {
    const quad = this.quad;
    const own = (quad.imu as { gyroFresh?: boolean }).gyroFresh; // if the IMU model exposes it, trust it
    const hz = quad.imu.chip.sampleRateHz;
    this.imuHold += dt;
    let fresh = this.imuHold >= 1 / hz - 1e-9;
    if (fresh) { this.imuHold -= 1 / hz; if (this.imuHold > dt) this.imuHold = 0; }
    if (hz >= quad.physicsHz) fresh = true;
    this.imuFresh = typeof own === 'boolean' ? own : fresh;
  }

  /**
   * The plant holds still (no integration) while firmware time passes: the IMU reads the quad at rest
   * in its current attitude, or sitting level (accelerometer calibration), with gravity only and the
   * chip's own bias and noise; the motors don't act.
   */
  heldStep(dt: number, level = false) {
    const bf = this.bf;
    if (!bf) return;
    const quad = this.quad;
    this.fcInputs(dt, true);
    if (level) sampleLevelRest(quad.imu, quad.p.mass, dt);
    else { rotateInv(this.restForce, quad.s.q, UP_G); quad.imu.sample(ZERO, this.restForce, ZERO, ZERO, quad.p.mass, dt); }
    this.noteImuSample(dt);
    for (let k = 0; k < 4; k++) this.erpm[k] = Math.abs(quad.motors[k]?.erpm() ?? 0);
    bf.setErpm(this.erpm);
    this.stepFirmware(dt);
    this.armed = bf.getMotors(this.motorCmd);
  }

  /** Firmware time passes by ms while the plant holds still (CLI batches). */
  advanceFirmware(ms: number) {
    const dt = 1 / this.settings.physicsHz;
    for (let i = 0, n = Math.round(ms / 1000 / dt); i < n; i++) this.heldStep(dt);
  }

  /** Run CLI lines on the held plant (see runCliBatch); the host persists the EEPROM if they saved. */
  cliBatch(lines: string[]): string {
    return this.bf ? runCliBatch(this.bf, lines, (ms) => this.advanceFirmware(ms)) : '';
  }

  /**
   * Accelerometer level calibration on a frozen, level plant (accCal.ts): true once Betaflight
   * finished it (it saves the trims itself: the EEPROM goes dirty).
   */
  calibrateAccLevel(): boolean {
    return !!this.bf && calibrateAccLevel(this.bf, this.settings.physicsHz, (dt) => this.heldStep(dt, true));
  }

  /** One physics step of dt seconds: sensors -> FC -> motors -> plant, then the 1 kHz record and crash bookkeeping. */
  physicsStep(dt: number) {
    const { bf, quad, brownout } = this;
    // 1S boards: the FC browns out when the pack sags too far, and boots again once it recovers
    if (bf && quad.p.battery.cellsSeries === 1) {
      const ev = brownout.update(quad.s.vbus, dt);
      if (ev === 'down') { this.log(`Flight controller brownout: the 1S pack sagged to ${quad.s.vbus.toFixed(2)} V (FC rebooting, motors off)`); this.hooks.brownout?.('down'); }
      if (ev === 'up') { bf.eepromSet(bf.eepromGet()); this.powerOnFirmware(); this.log('Flight controller rebooted after the brownout (arm switch must be cycled)'); this.hooks.brownout?.('up'); }
    }
    // sensors -> FC
    if (bf && !brownout.off) {
      this.fcInputs(dt, false);
      for (let k = 0; k < 4; k++) this.erpm[k] = Math.abs(quad.motors[k].erpm());
      bf.setErpm(this.erpm);
      this.stepFirmware(dt);
      this.armed = bf.getMotors(this.motorCmd);
      quad.command(this.motorCmd, bf.motorsReversed());
    } else {
      this.motorCmd.fill(0); this.armed = false;
      quad.command(this.motorCmd, false);
    }
    this.hooks.afterFirmware?.(dt);
    quad.step(dt, this.env);
    this.noteImuSample(dt);
    // the prop-wash puffs drift with the mean wind: advanced once per ms with the time gathered, not
    // every 125 µs step (their motion is far slower than that; WakeField.step takes any dt)
    this.wakeAcc += dt;
    if (this.wakeAcc >= WAKE_DT) {
      this.env.wake.step(this.wakeAcc, this.env.wind.meanAt(quad.s.pos.z, this.wakeWind), this.map.terrain(quad.s.pos.x, quad.s.pos.y));
      this.wakeAcc = 0;
    }
    this.simT += dt;
    this.steps++;
    // detectors look on a step-count cadence
    if (this.actors?.detectors.length) this.actors.stepDetectors(this.steps, this.settings.physicsHz, this.actorT, quad.s.pos, this.lookContext(), this.hooks.detect);

    // state record + gate check at 1 kHz (with which targets the quad is at)
    this.ringAcc += dt;
    if (this.ringAcc >= RECORD_DT) { this.ringAcc -= RECORD_DT; this.actors?.record(this.actorT, quad.s.pos); this.hooks.record?.(); this.detectGates(); }

    // crash events
    // An impact spans many physics steps while the contact decelerates the quad; report the peak
    // approach speed of the event (the first steps), not whichever step happened to be last.
    const simT = this.simT;
    if (quad.s.maxImpact > 0) {
      const v = quad.s.maxImpact;
      quad.s.maxImpact = 0;
      if (simT - this.impactLastT > 0.15) this.impactPeak = 0; // a new impact event
      this.impactLastT = simT;
      if (v > this.impactPeak) {
        this.impactPeak = v;
        this.lastImpact = { speed: v, t: simT };
        if (v > CRASH_MIN_MPS) { this.impactMsg = `Impact ${v.toFixed(1)} m/s`; this.damageMsg = ''; this.crashMsgUntil = simT + 2; this.crashMsg = this.impactMsg; }
      }
    }
    // damage from this crash (rolled by the quad once per impact event): name it on the banner
    // (the core consumes the log, so a rebuilt quad with a restarted clock can't confuse it)
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
        this.damageMsg = bits.join(' · ');
        if (simT >= this.crashMsgUntil) this.impactMsg = 'Crash';
        this.crashMsgUntil = simT + 3;
        this.crashMsg = `${this.impactMsg} · ${this.damageMsg}`;
      }
    }
  }

  /** What a detector's look needs to know about the quad and the map (rebuilt with the actors). */
  private lookContext(): LookContext {
    if (this.lookCtx) return this.lookCtx;
    const c = this.build.info.components;
    // across the props: the motor diagonal plus one prop diameter (a 5": ~0.35 m)
    const sizeM = c.frame.wheelbaseMm / 1000 + c.prop.diameterIn * 0.0254;
    return this.lookCtx = {
      sizeM: Number.isFinite(sizeM) && sizeM > 0 ? sizeM : REF_SIZE_M,
      vtxDbm: 10 * Math.log10(Math.max(1, c.video.vtxPowerMw)),
      light: lightLevel(this.map.sky),
      los: (a, b) => this.world.losLoss(a, b, this.losTmp),
    };
  }

  detectGates() {
    const p = this.quad.s.pos;
    const gates = this.map.gates;
    if (!gates.length) { this.lastPos = { ...p }; return; }
    const g: GateDef = gates[this.nextGate % gates.length];
    const passed = gatePassed(g, this.lastPos, p);
    if (passed) { this.hooks.gate?.(g.id, this.simT); this.nextGate++; }
    this.lastPos = { ...p };
  }

  /** Total prop damage (0 = pristine; a broken prop counts 1 plus its thrust loss). */
  damageTotal(): number {
    return this.quad.aero.reduce((a, x) => a + (1 - x.damage.thrustFactor) + (x.damage.broken ? 1 : 0), 0);
  }
}
