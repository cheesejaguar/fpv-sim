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
import { capture, restore, Snapshot } from '../sim/saveState';
import { RcLink } from '../sim/rcLink';
import { WakeField } from '../sim/wake';
import { Wind } from '../sim/wind';
import { calibrateAccLevel, sampleLevelRest } from './accCal';
import { BaroModel, Brownout, CurrentSensor, seedOf } from './fcHardware';
import { runCliBatch } from './fwCli';
import { DEFAULT_SETTINGS, SimSettings } from './shared';
import { GPS_ORIGIN, UbxReceiver } from './ubxGps';
import { OpsConfig, OpsLayer } from './ops';
import { apLaunch, apVehicle, ApVehicle } from '../ap/apConfig';
import { AP_FRAME_DT, ApMissionItem, ApSpawn, ArduPilotLink } from '../ap/apLink';
import { missionItems } from '../ap/apMission';
import { stateJson } from '../sitl/ardupilotJson';

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
  /**
   * Starts ArduPilot's thread (src/ap/apSpawn.ts in the browser, src/ap/apNode.ts in Node) and
   * where its firmware module is: needed for builds that fly ArduPilot (planes, quads set to it).
   */
  ardupilot?: { spawn: ApSpawn; moduleUrl: (v: ApVehicle) => string | null; waitMs?: number };
}

/** A plane's hand launch: held at shoulder height until the pilot runs the motor up, then thrown. */
export interface HandLaunch {
  /** where the hand holds it (world) and its yaw */
  pos: V3; yaw: number;
  /** how long the release condition has held (s) */
  hold: number;
  /** the throw: how long the arm has been pushing (s; -1 before it starts) */
  throwT: number;
  released: boolean;
  /** nose-up attitude while held (rad; default HAND_PITCH) */
  pitch?: number;
  /** a grip that never throws (pin(): held still while a firmware boots), let go by unpin() */
  pin?: boolean;
}
/**
 * Hand-launch throw: the speed it leaves the hand with along its heading and upward (m/s), how long
 * the arm pushes (s: the IMU feels the push, as the autopilot's estimator must), the nose-up
 * attitude while held (rad).
 */
const THROW_MPS = 11, THROW_UP_MPS = 1.5, THROW_S = 0.4, HAND_PITCH = (8 * Math.PI) / 180, HAND_HEIGHT = 1.6;

/**
 * What a practice point keeps of the flight core besides the plant, its wake and Betaflight's memory:
 * the sensor, link and timing state between them (so the firmware sees the same inputs again), the
 * motor outputs, the hand launch and the gate the quad is on.
 */
const POINT_FIELDS = [
  'motorCmd', 'erpm', 'rcBuf', 'escCmd', 'armed', 'nextGate', 'hand', 'fcGyro', 'fcAcc', 'beeperSeen', 'beaconSeen',
  'linkAcc', 'wakeAcc', 'ringAcc', 'rcAcc', 'battAcc', 'baroAcc', 'gpsAcc', 'bblAcc', 'imuHold', 'imuFresh', 'baro', 'current', 'brownout',
] as const;
const NO_SHARED = new Set<object>();
/** Longest a recall holds the arm switch as it was at the practice point (s; see rcPacket). */
const ARM_HOLD_S = 1;

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
   * The operational layer (ops.ts): radio environment and jamming, fibre link, faults, payload,
   * navigation sensors. null: none of it (the plain simulator).
   */
  ops: OpsLayer | null = null;
  /** the IMU sample the firmware last read (the chip's output, or what a sensor fault made of it) */
  fcGyro: V3 = { x: 0, y: 0, z: 0 }; fcAcc: V3 = { x: 0, y: 0, z: G0 };
  /**
   * Motor throttles (0..1, Betaflight's motor order) from an external autopilot (src/sitl/): used
   * instead of the firmware when there is no Betaflight (bf null).
   */
  external: Float32Array | null = null;
  /** ArduPilot (planes, quads set to it): the lock-step link to its firmware thread, null for Betaflight */
  ap: ArduPilotLink | null = null;
  /** a plane waiting in the pilot's hand (respawn), until thrown */
  hand: HandLaunch | null = null;
  private apAcc = 0;
  /** the map's mission went to this ArduPilot (uploaded once it has a GPS fix; again after a map change) */
  private apMissionSent = false;
  /** firmware time of the last RC packet that arrived (ArduPilot gets the sticks until 100 ms without one) */
  private apRcT = -Infinity;
  /** firmware time of the last automatic power cycle (a hung or exited ArduPilot restarts at most every 5 s) */
  private apRestartT = -Infinity;
  /** the IMU samples of the current 1 ms ArduPilot frame, summed (it gets their mean, as a sensor's own filter would) */
  private readonly apG: V3 = { x: 0, y: 0, z: 0 }; private readonly apA: V3 = { x: 0, y: 0, z: 0 }; private apN = 0;
  private readonly apOpts: FlightCoreOptions['ardupilot'];
  private readonly windTmp: V3 = { x: 0, y: 0, z: 0 }; private readonly airTmp: V3 = { x: 0, y: 0, z: 0 };
  /** motor commands as the ESCs receive them (after motor faults) */
  readonly escCmd = new Uint16Array(4);
  private gpsCep0 = 0;
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
    this.apOpts = opts.ardupilot;
    this.rcLink = new RcLink(this.sub(0x5eed));
    this.baro = new BaroModel(this.sub(0xba50));
    // (a seeded episode's own GPS error stream: with a fixed seed every episode drew the same errors)
    if (this.seed !== undefined) this.gps = new UbxReceiver(GPS_ORIGIN, this.sub(0x6a5));
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
    // (keeps the map's origin: a map with its own geo origin used to fall back to the default one;
    // the error stream's seed stays fixed, as recorded runs were made with it)
    this.gps = new UbxReceiver({ ...this.gps.origin });
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

  /**
   * Apply an operational configuration (null: remove it). Its times count from now (or from core
   * time t0). Seeded from the core's seed.
   */
  setOps(config: OpsConfig | null, t0 = this.simT) {
    // (built first: a configuration that throws leaves the current one in place)
    const next = config ? new OpsLayer(config, t0, this.seed ?? 0x0b5) : null;
    if (this.ops && this.quad) { this.ops.detach(this); this.gps.cepM = this.gpsCep0 || this.gps.cepM; }
    this.ops = next;
    if (this.ops && this.quad) this.ops.attach(this, true);
  }

  /** where the pilot (and the RC transmitter and video receiver) stands */
  pilot(): V3 { return pilotPos(this.map, this.pilotTmp); }

  /** Fly this map from now on (its collision world, wind, GPS origin and actors). */
  setMap(m: MapDef) {
    this.point = null;
    this.map = m;
    this.apMissionSent = false;
    this.world = new PrimitiveWorld(m);
    this.env = this.makeEnv();
    this.gps.origin = { lat: m.geo?.lat ?? GPS_ORIGIN.lat, lon: m.geo?.lon ?? GPS_ORIGIN.lon, altM: m.elevationM ?? 0 };
    // ArduPilot's home (lat, lon, altitude) is fixed when it boots: power-cycle it on the new map's
    if (this.ap) this.startArduPilot();
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
    this.point = null; // (another quad, or the same at another physics rate)
    this.build = buildDrone(spec);
    const prev = this.quad as QuadSim | undefined;
    const quad = new QuadSim(this.build.params, settings.physicsHz, spec.batterySoc, settings.ambientC, this.seed === undefined ? undefined : this.sub(0x9a1d));
    this.quad = quad;
    this.ops?.attach(this, true);
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
    // a plane starts in the pilot's hand, ready to be thrown
    this.hand = this.build.info.plane ? { pos: { x: sp.pos.x, y: sp.pos.y, z: spawnGroundZ(this.map) + HAND_HEIGHT }, yaw: sp.yaw, hold: 0, throwT: -1, released: false } : null;
    if (this.hand) this.holdInHand();
    this.env.wake.reset(); this.wakeAcc = 0;
    this.lastPos = { ...this.quad.s.pos };
    this.nextGate = 0;
    if (this.actors) this.resetActors();
    this.ops?.attach(this, false);
  }

  /**
   * A respawn as the pilot asks for it (reset key, pause menu): repaired, a fresh pack (a rebuilt
   * quad) or the same one, at the start or somewhere specific (yaw in degrees).
   */
  applyReset(r: { repair?: boolean; fullBattery?: boolean; at?: V3 & { yawDeg: number } }) {
    if (r.repair) this.quad.repair();
    if (r.fullBattery) this.buildQuad(); else this.respawn();
    if (r.at) this.placeAt(r.at, (r.at.yawDeg * Math.PI) / 180);
    this.apAfterTeleport();
  }

  /**
   * After a respawn or a teleport, an ArduPilot build is power-cycled (as a pilot re-plugs the pack
   * after a crash): its EKF has no way to learn of the jump and kept tens of degrees of attitude
   * error for seconds, and its heading 160° off after 5 s, with arming allowed at once.
   */
  apAfterTeleport() { if (this.ap) this.startArduPilot(); }

  /**
   * Put the quad somewhere specific, at rest (yaw in rad), never under the ground: a teleport below
   * it (API, debug) buried the quad metres deep and the contact springs flung it out at km/s.
   */
  placeAt(pos: V3, yaw: number) {
    this.hand = null;
    const floor = this.world.groundHeight(pos.x, pos.y) + 0.06 - Math.min(...this.build.params.colliders.map((c) => c.pos.z - c.radius));
    this.quad.reset({ x: pos.x, y: pos.y, z: Math.max(pos.z, floor) }, yaw);
    this.env.wake.reset();
    this.lastPos = { ...this.quad.s.pos };
  }

  /** Power the FC on (first boot, or again after a brownout): chip rate, sensors, init(). */
  powerOnFirmware() {
    const bf = this.bf;
    if (!bf) return;
    this.point = null; // (a rebooted firmware: its memory from before means nothing now)
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
  /** One RC packet slot: true when the link delivered it (the sticks are then in rcBuf). */
  private rcPacket(): boolean {
    if (!this.rcLink.packet()) return false;
    const rcBuf = this.rcBuf;
    this.hooks.sticks(rcBuf);
    for (let i = 0; i < 16; i++) if (!(rcBuf[i] >= 800 && rcBuf[i] <= 2200)) rcBuf[i] = 1500;
    // just back at a practice point: the arm switch (AUX1) stays as it was there until the pilot's
    // own stream agrees (it is sampled a little in the past, and the page puts a toggle arm back only
    // as the jump happens: one stale packet disarmed the restored, flying quad), at most ARM_HOLD_S
    if (this.simT < this.armHoldUntil) {
      if ((rcBuf[4] > 1500) === (this.armHoldUs > 1500)) this.armHoldUntil = -Infinity;
      else rcBuf[4] = this.armHoldUs;
    }
    return true;
  }

  /** The RC link's budget (range, walls, fading, interference), every 50 ms. */
  private linkBudget(dt: number) {
    const { quad, settings, rcLink, map } = this;
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
      this.ops?.updateLinks(this);
    }
  }

  fcInputs(dt: number, held: boolean) {
    const bf = this.bf;
    if (!bf) return;
    const { quad, settings, rcLink, rcBuf, map } = this;
    this.rcAcc += dt;
    this.linkBudget(dt);
    if (this.rcAcc >= 1 / settings.rcLinkHz) {
      this.rcAcc -= 1 / settings.rcLinkHz;
      // a lost packet is really lost: Betaflight sees no new frame (and fails safe if it persists)
      if (this.rcPacket()) bf.setRc(rcBuf);
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
      const pa = this.baro.read(air.pressure, air.rho, quad.s.pos.z - map.terrain(quad.s.pos.x, quad.s.pos.y), thrust, this.diskArea, this.rotorR);
      bf.setBaro(this.ops ? this.ops.baro(pa, air.rho) : pa);
    }
    this.gpsAcc += dt;
    if (this.gpsAcc >= 0.005) {
      this.gpsAcc = 0;
      this.gps.fromFc(bf.serialRead(BF_PORT.gps));
      const p = quad.s.pos, v = quad.s.vel;
      const wall = this.gpsEpochMs !== null ? this.gpsEpochMs + this.fcT * 1000 : this.hooks.wallMs ? this.hooks.wallMs() : Date.now();
      let out: Uint8Array;
      if (this.ops) {
        // jamming, spoofing and GNSS faults: fewer satellites, a larger error, a counterfeit position
        const rep = this.ops.gnssReport(), o = rep.offset;
        this.gpsCep0 ||= this.gps.cepM;
        this.gps.cepM = this.gpsCep0 * rep.cepScale;
        out = this.gps.tick(this.fcT, { e: p.x + (o?.x ?? 0), n: p.y + (o?.y ?? 0), u: p.z + (o?.z ?? 0), ve: held ? 0 : v.x, vn: held ? 0 : v.y, vu: held ? 0 : v.z }, wall, rep.numSV);
      } else out = this.gps.tick(this.fcT, { e: p.x, n: p.y, u: p.z, ve: held ? 0 : v.x, vn: held ? 0 : v.y, vu: held ? 0 : v.z }, wall);
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
      let g = this.quad.imu.gyroOut, a = this.quad.imu.accOut;
      if (this.ops?.imuTouched) { g = this.ops.gyro(g); a = this.ops.acc(a); }
      this.fcGyro = g; this.fcAcc = a;
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
    this.point = null; // (its configuration changes: a restored memory would undo them)
    return this.bf ? runCliBatch(this.bf, lines, (ms) => this.advanceFirmware(ms)) : '';
  }

  /**
   * Accelerometer level calibration on a frozen, level plant (accCal.ts): true once Betaflight
   * finished it (it saves the trims itself: the EEPROM goes dirty).
   */
  calibrateAccLevel(): boolean {
    this.point = null;
    return !!this.bf && calibrateAccLevel(this.bf, this.settings.physicsHz, (dt) => this.heldStep(dt, true));
  }

  /** One physics step of dt seconds: sensors -> FC -> motors -> plant, then the 1 kHz record and crash bookkeeping. */
  physicsStep(dt: number) {
    const { bf, quad, brownout } = this;
    // 1S boards: the FC browns out when the pack sags too far, and boots again once it recovers
    if (bf && !this.ap && quad.p.battery.cellsSeries === 1) {
      const ev = brownout.update(quad.s.vbus, dt);
      if (ev === 'down') { this.log(`Flight controller brownout: the 1S pack sagged to ${quad.s.vbus.toFixed(2)} V (FC rebooting, motors off)`); this.hooks.brownout?.('down'); }
      if (ev === 'up') { bf.eepromSet(bf.eepromGet()); this.powerOnFirmware(); this.log('Flight controller rebooted after the brownout (arm switch must be cycled)'); this.hooks.brownout?.('up'); }
    }
    // sensors -> FC (ArduPilot when the build flies it: a Betaflight instance stays loaded, unused)
    if (this.ap) {
      this.apStep(dt);
    } else if (bf && !brownout.off) {
      this.fcInputs(dt, false);
      for (let k = 0; k < 4; k++) this.erpm[k] = Math.abs(quad.motors[k].erpm());
      bf.setErpm(this.erpm);
      this.stepFirmware(dt);
      this.armed = bf.getMotors(this.motorCmd);
      if (this.ops?.motorsTouched) { this.escCmd.set(this.motorCmd); this.ops.motors(this.escCmd); quad.command(this.escCmd, bf.motorsReversed()); }
      else quad.command(this.motorCmd, bf.motorsReversed());
    } else if (this.external) {
      // an external autopilot (PX4 / ArduPilot SITL) drives the ESCs: 0 stops a motor, 0..1 is the throttle
      const ext = this.external;
      let any = false;
      for (let k = 0; k < this.motorCmd.length; k++) {
        const x = ext[k] ?? 0;
        this.motorCmd[k] = x > 0 ? Math.round(48 + Math.min(1, x) * 1999) : 0;
        if (x > 0) any = true;
      }
      this.armed = any;
      if (this.ops?.motorsTouched) { this.escCmd.set(this.motorCmd); this.ops.motors(this.escCmd); quad.command(this.escCmd, false); }
      else quad.command(this.motorCmd, false);
    } else {
      this.motorCmd.fill(0); this.armed = false;
      quad.command(this.motorCmd, false);
    }
    this.hooks.afterFirmware?.(dt);
    const hand = this.hand && !this.hand.released ? this.hand : null;
    if (hand) this.handForce(+1, dt);
    quad.step(dt, this.env);
    // (the hand keeps its grip on the attitude through the push, as a thrown plane leaves the hand level)
    if (hand) { this.handForce(-1, dt); this.holdAttitude(); if (hand.throwT < 0) this.handRelease(dt); }
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
    if (this.ringAcc >= RECORD_DT) { this.ringAcc -= RECORD_DT; this.actors?.record(this.actorT, quad.s.pos); this.ops?.tick(this, RECORD_DT); this.hooks.record?.(); this.detectGates(); }

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

  // ---------- ArduPilot ----------

  /** Which ArduPilot vehicle the current build flies (null: Betaflight). */
  get apVehicle(): ApVehicle | null { return this.spec ? apVehicle(this.spec) : null; }

  /**
   * Start ArduPilot for the current build (any previous instance stops: a power cycle). Its home is
   * the map's GPS origin; it boots facing the spawn's heading.
   */
  startArduPilot(): ArduPilotLink | null {
    this.stopArduPilot();
    const v = this.apVehicle, o = this.apOpts;
    if (!v) return null;
    const url = o?.moduleUrl(v);
    if (!o || !url) { this.log(`ArduPilot is not available here (no firmware build: bash firmware/apwasm/build.sh)`); return null; }
    const headingDeg = 90 - (this.map.spawn.yaw * 180) / Math.PI;
    const launch = apLaunch(this.build, { ...this.gps.origin }, headingDeg);
    this.ap = new ArduPilotLink(v, { moduleUrl: url, files: launch.files, args: launch.args, cwd: launch.cwd }, o.spawn, (t) => this.log(t));
    this.apAcc = 0; this.apRcT = -Infinity; this.apMissionSent = false; this.apRestored = false;
    this.apG.x = this.apG.y = this.apG.z = this.apA.x = this.apA.y = this.apA.z = 0; this.apN = 0;
    if (this.apStore.spec !== this.spec) this.apStore = { spec: this.spec, params: {}, mission: null };
    this.motorCmd.fill(0); this.armed = false;
    this.log(`Ardu${v === 'plane' ? 'Plane' : 'Copter'} 4.7.2 starting (WebAssembly)`);
    return this.ap;
  }

  stopArduPilot() { this.ap?.terminate(); this.ap = null; }

  // ---------- practice points ----------

  /**
   * A practice point, like a skateboarding game's marker: the flight exactly as it is now (the plant,
   * its own prop wash, Betaflight's memory and the sensor and timing state between them) to come
   * back to with recallPoint() and fly the same moment again, as many times as it takes. The world
   * keeps going: time, wind, actors, the operational layer. Respawns keep it; another quad, map,
   * firmware reboot or configuration change clears it. Betaflight builds only: ArduPilot runs in
   * its own thread and cannot be rewound (it reboots after a jump).
   */
  private point: { quad: Snapshot; wake: Snapshot; bf: Uint8Array | null; core: Snapshot } | null = null;
  /** after a recall: the arm channel held as it was at the point, until this sim time (rcPacket) */
  private armHoldUntil = -Infinity; private armHoldUs = 1000;
  get hasPoint(): boolean { return this.point !== null; }

  /** Keep the flight as it is now as the practice point; null, or why it can't. */
  markPoint(): string | null {
    if (this.ap || this.apVehicle) return 'Practice points need a Betaflight build: ArduPilot can\'t follow a jump (it reboots after one)';
    if (!this.quad) return 'no quad yet';
    const o: Record<string, unknown> = {};
    for (const k of POINT_FIELDS) o[k] = this[k];
    this.point = {
      quad: this.quad.saveState(), wake: capture(this.env.wake, NO_SHARED),
      bf: this.bf && this.fwRunning ? this.bf.saveState() : null, core: capture(o, NO_SHARED),
    };
    return null;
  }

  /** Back to the practice point (false: there is none). */
  recallPoint(): boolean {
    const pt = this.point;
    if (!pt) return false;
    this.quad.loadState(pt.quad);
    restore(this.env.wake, pt.wake, NO_SHARED);
    restore(this, pt.core, NO_SHARED);
    if (pt.bf && this.bf) this.bf.loadState(pt.bf);
    // no gate crossing along the jump, no crash banner from the attempt before
    this.lastPos = { ...this.quad.s.pos };
    this.crashMsg = null; this.crashMsgUntil = 0; this.lastImpact = { speed: 0, t: -1 };
    this.impactPeak = 0; this.impactLastT = -1; this.impactMsg = ''; this.damageMsg = '';
    this.armHoldUs = this.rcBuf[4]; this.armHoldUntil = this.simT + ARM_HOLD_S;
    return true;
  }

  clearPoint() { this.point = null; }

  /**
   * Hold the plant still where it is (level, at its heading) until unpin(): an ArduPilot build
   * booting at a start or teleport pose in mid-air would otherwise fall while it waits for its GPS
   * fix. A plane already in the hand stays there. Returns whether it pinned.
   */
  pin(): boolean {
    if (this.hand) return false;
    const q = this.quad.s.q, yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
    this.hand = { pos: { ...this.quad.s.pos }, yaw, hold: 0, throwT: -1, released: false, pitch: 0, pin: true };
    this.holdInHand();
    return true;
  }
  unpin() { if (this.hand?.pin) { this.hand = null; const s = this.quad.s; s.vel = { x: 0, y: 0, z: 0 }; s.w = { x: 0, y: 0, z: 0 }; } }

  /**
   * What a ground station stored on the flight controller (parameters, a mission), kept across
   * ArduPilot power cycles (respawns, teleports, map changes, hang restarts) as its EEPROM keeps them:
   * each start is a fresh WebAssembly instance with the build's parameters only. A new drone starts
   * clean. (Changes a GCS makes over the raw MAVLink pass-through are not seen here.)
   */
  private apStore: { spec: DroneSpec | null; params: Record<string, number>; mission: ApMissionItem[] | null } = { spec: null, params: {}, mission: null };
  private apRestored = false;
  /** Set ArduPilot parameters now and after every later power cycle of this drone. */
  apSetParams(params: Record<string, number>) { Object.assign(this.apStore.params, params); this.ap?.hub.setParams(params); }
  /** Upload a mission now; it is uploaded again after every later power cycle of this drone. */
  apUploadMission(items: ApMissionItem[], done: (ok: boolean, why: string) => void) {
    this.apStore.mission = items;
    if (this.ap) this.ap.hub.uploadMission(items, done); else done(false, 'ArduPilot is not running');
  }

  /** The plant's state for ArduPilot's SITL JSON backend (sensors are ArduPilot's own SITL models). */
  private apStateLine(withRc: boolean): string {
    const quad = this.quad, s = quad.s, ap = this.ap!;
    // airspeed: the body-x component of the motion through the air (a pitot along the fuselage)
    const wind = this.env.wind.at(s.pos, this.windTmp);
    const air = this.airTmp; air.x = s.vel.x - wind.x; air.y = s.vel.y - wind.y; air.z = s.vel.z - wind.z;
    const airB = rotateInv(this.airTmp, s.q, air);
    // the frame's mean IMU sample: one instantaneous sample per 1 ms let the plant's 1-2 kHz
    // vibration alias down into ArduPilot's control band
    const n = this.apN, g = this.apG, a = this.apA;
    const imu = n ? { gyro: { x: g.x / n, y: g.y / n, z: g.z / n }, acc: { x: a.x / n, y: a.y / n, z: a.z / n } } : { gyro: quad.imu.gyroOut, acc: quad.imu.accOut };
    g.x = g.y = g.z = a.x = a.y = a.z = 0; this.apN = 0;
    let rc: number[] | undefined;
    if (withRc) {
      rc = Array.from(this.rcBuf.subarray(0, 12), Math.round);
      rc[1] = 3000 - rc[1]; // ArduPilot: pitch forward = low PWM
    }
    return stateJson({
      time: ap.apTime + AP_FRAME_DT,
      pos: s.pos, vel: s.vel, q: s.q,
      gyro: this.fcGyro = this.ops?.imuTouched ? this.ops.gyro(imu.gyro) : imu.gyro,
      accel: this.fcAcc = this.ops?.imuTouched ? this.ops.acc(imu.acc) : imu.acc,
      // SITL's pitot reads equivalent airspeed: true airspeed × sqrt(rho / rho0)
      airspeed: Math.max(0, airB.x) * Math.sqrt(isa(s.pos.z + this.map.elevationM, this.settings.ambientC - 15).rho / 1.225),
      battery: { voltage: s.vbus, current: s.ibus },
      rc,
    });
  }

  /** One physics step's worth of ArduPilot: RC packets, the 1 kHz lock-step frame, outputs to the ESCs and servos. */
  private apStep(dt: number) {
    const ap = this.ap!, quad = this.quad;
    this.linkBudget(dt);
    this.rcAcc += dt;
    if (this.rcAcc >= 1 / this.settings.rcLinkHz) {
      this.rcAcc -= 1 / this.settings.rcLinkHz;
      if (this.rcPacket()) this.apRcT = this.fcT;
    }
    const io = quad.imu.gyroOut, ao = quad.imu.accOut;
    this.apG.x += io.x; this.apG.y += io.y; this.apG.z += io.z; this.apA.x += ao.x; this.apA.y += ao.y; this.apA.z += ao.z; this.apN++;
    this.apAcc += dt;
    if (this.apAcc >= AP_FRAME_DT - 1e-9) {
      this.apAcc -= AP_FRAME_DT;
      // (SITL's RC input samples whichever frame its 50 Hz poll lands on: every frame carries the
      // sticks while the link is up; a link silent for 100 ms sends none and ArduPilot fails safe)
      if (ap.live || ap.status === 'running') ap.exchange(this.apStateLine(this.fcT - this.apRcT < 0.1), this.apOpts?.waitMs ?? 100);
      // hung (a reboot request panics under WebAssembly) or exited after it had flown: the outputs
      // are cut (the link zeroes them) and it is power-cycled, as the pilot / GCS asked
      if ((ap.hung || (ap.live && ap.status === 'exited')) && this.fcT - this.apRestartT > 5) {
        this.apRestartT = this.fcT;
        this.log('ArduPilot stopped: power-cycling it');
        this.startArduPilot();
        return;
      }
      ap.hub.pump(AP_FRAME_DT);
      this.armed = ap.hub.tel.armed;
      // after a power cycle: what a ground station had stored (apStore)
      if (!this.apRestored && ap.hub.tel.connected) {
        this.apRestored = true;
        if (Object.keys(this.apStore.params).length) ap.hub.setParams(this.apStore.params);
      }
      const ms = this.map.mission, stored = this.apStore.mission;
      if ((ms || stored) && !this.apMissionSent && ap.hub.tel.connected && ap.hub.tel.gpsFix >= 3) {
        this.apMissionSent = true;
        if (stored) ap.hub.uploadMission(stored, (ok, why) => this.log(ok ? `Mission restored: ${stored.length} items` : `The stored mission was not restored: ${why}`));
        else if (ms) ap.hub.uploadMission(missionItems(ms, ap.vehicle, this.gps.origin, spawnGroundZ(this.map)), (ok, why) =>
          this.log(ok ? `Mission loaded: ${ms.points.length} waypoints, then ${ms.end === 'rtl' ? 'home' : ms.end} (AUX4 flies it)` : `The map's mission was not loaded: ${why}`));
      }
      this.fcT += AP_FRAME_DT;
    }
    // outputs: PWM 1000..2000 to the ESCs (DShot 48..2047; at or below 1000 the motor stops), the rest to the servos
    const pwm = ap.pwm, plane = this.build.info.plane;
    const toEsc = (us: number) => (us > 1000 ? Math.round(48 + Math.min(1, (us - 1000) / 1000) * 1999) : 0);
    if (plane) {
      for (let k = 0; k < this.motorCmd.length; k++) this.motorCmd[k] = k < plane.motorChannels.length ? toEsc(pwm[plane.motorChannels[k]]) : 0;
      quad.servos(pwm);
    } else for (let k = 0; k < this.motorCmd.length; k++) this.motorCmd[k] = toEsc(pwm[k]);
    if (this.ops?.motorsTouched) { this.escCmd.set(this.motorCmd); this.ops.motors(this.escCmd); quad.command(this.escCmd, false); }
    else quad.command(this.motorCmd, false);
  }

  // ---------- a plane's hand launch ----------

  /** The hand's grip: the plane at the hand, wings level, nose a little up, still. */
  private holdInHand() {
    const h = this.hand!, s = this.quad.s;
    s.pos = { ...h.pos }; s.vel = { x: 0, y: 0, z: 0 }; s.w = { x: 0, y: 0, z: 0 };
    this.holdAttitude();
  }

  private holdAttitude() {
    const h = this.hand!, s = this.quad.s;
    // yaw about z, then the nose up (a rotation about the body's -y)
    const pitch = h.pitch ?? HAND_PITCH;
    const cy = Math.cos(h.yaw / 2), sy = Math.sin(h.yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
    s.q = { w: cy * cp, x: sy * sp, y: -cy * sp, z: sy * cp };
    s.w.x = s.w.y = s.w.z = 0;
  }

  /**
   * The hand's force on the plane, added to the plant's external force for one step (sign +1
   * before, -1 after): holding, a stiff spring and damper on its position against gravity and
   * thrust; throwing, gravity's support and the push along the heading that reaches the throw speed
   * in THROW_S, then it lets go.
   */
  private handForce(sign: 1 | -1, dt: number) {
    const h = this.hand!, s = this.quad.s, m = this.quad.p.mass, f = this.quad.extForce, F = this.handF;
    if (sign > 0) {
      if (h.throwT < 0) {
        const k = m * 400, c = 2 * m * 20;
        F.x = k * (h.pos.x - s.pos.x) - c * s.vel.x;
        F.y = k * (h.pos.y - s.pos.y) - c * s.vel.y;
        F.z = m * G0 + k * (h.pos.z - s.pos.z) - c * s.vel.z;
      } else {
        const a = THROW_MPS / THROW_S, fx = Math.cos(h.yaw), fy = Math.sin(h.yaw);
        F.x = m * a * fx; F.y = m * a * fy; F.z = m * (G0 + THROW_UP_MPS / THROW_S);
      }
    }
    f.x += sign * F.x; f.y += sign * F.y; f.z += sign * F.z;
    if (sign < 0 && h.throwT >= 0) {
      h.throwT += dt;
      if (h.throwT >= THROW_S) { h.released = true; this.log('Hand launch'); }
    }
  }
  private readonly handF: V3 = { x: 0, y: 0, z: 0 };

  /**
   * Throw when the pilot means it: the motor run up to launch power, past 65 % (ACRO, FBWA, MANUAL:
   * a heavy wing thrown at part throttle sinks in), or, armed, the throttle stick past 80 % (AUTO's
   * takeoff keeps the motor off until it feels the throw), for 0.3 s.
   */
  private handRelease(dt: number) {
    const h = this.hand!;
    if (h.pin) return;
    const motor = this.motorCmd.reduce((a, c) => Math.max(a, c), 0);
    const want = motor > 48 + 0.65 * 1999 || (this.armed && this.rcBuf[2] > 1800);
    h.hold = want ? h.hold + dt : 0;
    if (h.hold >= 0.3) h.throwT = 0;
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
