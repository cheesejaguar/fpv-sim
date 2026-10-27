// Headless environment: the flight core (Betaflight WASM + the physics plant, src/worker/
// flightCore.ts, the same code the browser runs) driven by a program instead of a pilot and a clock.
// Gym-style: reset(scenario, seed) -> observation; step(action) -> observation, reward, terminated,
// truncated, info. Deterministic: an episode is a pure function of the scenario, its seed, the
// actions and the firmware build. No rendering; no browser or Node APIs (the host provides the
// firmware and, for package maps, fetch): it runs in Node (src/headless/node.ts) and in a worker.
import { Betaflight, armingFlagNames } from '../bf/bfModule';
import { defaultCli, simHardwareCli } from '../bf/defaults';
import { cliErrors as cliErr, planDiffImport } from '../bf/diffImport';
import { DroneBuild, DroneSpec, preloadPropTable } from '../builder/derive';
import { MAPS, preloadMap } from '../maps/maps';
import { MapDef, spawnGroundZ, withCourse, withSpawn } from '../maps/world';
import { posAt, randomizeActors, velAt } from '../sim/actors';
import { subSeed, V3 } from '../sim/math';
import { Action, applyAction, AUX, MODE_US, Observation, ObservedActors, probeDirections, rot, rotInv } from '../api/types';
import { resolveEpisode, Episode, MapFacts, mapFacts, Scenario, defaultScenario, parseScenario } from '../scenario/scenario';
import { TaskMetrics, TaskRunner } from '../scenario/tasks';
import { FlightCore } from '../worker/flightCore';
import { OpsConfig, OpsEvent } from '../worker/ops';
import type { FaultSpec } from '../sim/faults';

export interface StepResult {
  obs: Observation;
  reward: number;
  /** the episode ended by itself: task complete, crash, left the map */
  terminated: boolean;
  /** the episode hit its time limit */
  truncated: boolean;
  info: { reason?: 'success' | 'failure' | 'crash' | 'out_of_bounds' | 'timeout' | 'detected'; metrics: TaskMetrics; events: EnvEvent[] };
}

export type EnvEvent = { type: 'gate'; gate: number; t: number } | { type: 'impact'; speed: number; t: number } | { type: 'log'; text: string; t: number } | OpsEvent
  /** a detector of the map's actors began (on) or stopped holding a detection of the quad */
  | { type: 'detect'; detector: string; on: boolean; t: number };

export interface EnvOptions {
  /** a fresh, un-booted flight controller (each reset boots a new one: no state carries over) */
  firmware: () => Promise<Betaflight>;
}

/** The derived numbers of the episode's build (the drone builder's panel). */
export interface DroneFacts {
  auwG: number; thrustToWeight: number;
  /** the throttle stick (0..1) that holds a hover with a full pack, Betaflight's idle offset included */
  hoverThrottle: number;
  hoverRpm: number; frameFreqHz: number;
  massKg: number; inertia: { xx: number; yy: number; zz: number };
  cells: number; capacityMah: number;
}

export function droneFacts(b: DroneBuild): DroneFacts {
  const i = b.info;
  return {
    auwG: i.auwG, thrustToWeight: i.thrustToWeight,
    hoverThrottle: 0.055 + i.hoverThrottle * 0.945, // the stick that gives this motor output past dynamic idle (as scripts/bench-sim.mjs)
    hoverRpm: i.hoverRpm, frameFreqHz: i.frameFreqHz,
    massKg: b.params.mass, inertia: { xx: b.params.inertia.xx, yy: b.params.inertia.yy, zz: b.params.inertia.zz },
    cells: b.params.battery.cellsSeries, capacityMah: i.components.battery.capacityMah,
  };
}

/** Fixed UTC epoch for the simulated GPS (2026-01-01): a seeded run never reads the wall clock. */
const GPS_EPOCH_MS = Date.UTC(2026, 0, 1);

export class FpvEnv {
  core!: FlightCore;
  episode!: Episode;
  scenario!: Scenario;
  private task!: TaskRunner;
  private rc = new Float32Array(16).fill(1500);
  private t0 = 0;
  private events: EnvEvent[] = [];
  private probeDirs: V3[] = [];
  private stepImpact = 0;
  private ended = false;
  /** episodes started by reset() without a seed (episode k gets subSeed(scenario seed, k)) */
  private episodeCount = 0;
  /** every firmware / simulator message as it happens (also during reset) */
  onLog: ((text: string) => void) | null = null;

  constructor(private opts: EnvOptions) {}

  /** Simulation time of the episode (s). */
  get time(): number { return this.core ? this.core.simT - this.t0 : 0; }

  /**
   * Start an episode: build the scenario's drone and world, boot a fresh Betaflight (the
   * simulator's defaults, the scenario's CLI, level accelerometer calibration, the boot grace),
   * place the quad, arm it if the scenario says so. `seed`: this episode's seed (repeat an episode
   * exactly); default: the next one of the scenario's sequence.
   */
  async reset(o: { scenario?: Scenario | unknown; seed?: number } = {}): Promise<{ obs: Observation; info: { seed: number; episode: Episode; bootS: number; cliErrors: string[]; drone: DroneFacts } }> {
    // what the scenario's map has (spawns, actors, wind): it is loaded first, so ids on it can be checked
    const facts = new Map<string, MapFacts | null>();
    const factsOf = (id: string) => {
      if (!facts.has(id)) { let f: MapFacts | null = null; try { f = id in MAPS ? mapFacts(MAPS[id]()) : null; } catch { /* not loaded */ } facts.set(id, f); }
      return facts.get(id)!;
    };
    const rawMap = (o.scenario as { map?: { id?: unknown } } | undefined)?.map?.id;
    const wantMap = typeof rawMap === 'string' ? rawMap : o.scenario === undefined ? this.scenario?.map?.id ?? 'field' : 'field';
    if (wantMap in MAPS) await preloadMap(wantMap).catch(() => { /* reported by the parser / the reset below */ });
    if (o.scenario !== undefined) {
      const { scenario, errors } = parseScenario(o.scenario, (id) => id in MAPS, factsOf);
      if (!scenario) throw new Error(`invalid scenario:\n  ${errors.join('\n  ')}`);
      this.scenario = scenario;
      this.episodeCount = 0;
    }
    this.scenario ??= defaultScenario({ map: { id: 'field' } });
    const sc = this.scenario;
    const seed = o.seed ?? subSeed(sc.seed ?? 0, this.episodeCount);
    this.episodeCount++;
    const ep = resolveEpisode(sc, seed, factsOf(sc.map?.id ?? 'field'));
    // a diff all decides the prop direction (as the app's import does)
    const plan = ep.cli.length ? planDiffImport(ep.cli.join('\n')) : null;
    const spec: DroneSpec = plan?.propsOut != null ? { ...ep.spec, propDirection: plan.propsOut ? 'props-out' : 'props-in' } : ep.spec;
    this.episode = { ...ep, spec };

    await Promise.all([preloadMap(ep.mapId), preloadPropTable(spec.prop)]);
    this.events = [];
    const core = this.core = new FlightCore({
      sticks: (out) => out.set(this.rc),
      log: (text) => { this.events.push({ type: 'log', text, t: this.time }); this.onLog?.(text); },
      gate: (gate, t) => { this.events.push({ type: 'gate', gate, t: t - this.t0 }); this.task?.onGate(gate, t - this.t0); },
      // (actor time is episode time: the actors start with the episode)
      detect: (e) => this.events.push({ type: 'detect', detector: e.id, on: e.on, t: e.t }),
    }, { seed });
    core.gpsEpochMs = GPS_EPOCH_MS;
    core.settings = ep.settings;
    core.spec = spec;
    let map: MapDef = withSpawn(withCourse(MAPS[ep.mapId](), ep.courseId), ep.settings.spawnId);
    if (ep.actors) map = randomizeActors(map, ep.actors);
    core.setMap(map);
    core.buildQuad();

    // boot as the worker does on a first boot: 0.5 s on the pad, the defaults over the CLI (plant
    // held), level accelerometer calibration, then the scenario's own configuration
    const bf = core.bf = await this.opts.firmware();
    this.rc.fill(1500); this.rc[2] = 1000; this.rc[AUX.arm] = 1000; this.rc[AUX.mode] = MODE_US[ep.start.mode]; this.rc[AUX.turtle] = 1000; this.rc[AUX.beeper] = 1000;
    core.powerOnFirmware();
    const dt = 1 / ep.settings.physicsHz;
    for (let i = 0; i < Math.round(0.5 / dt); i++) core.physicsStep(dt);
    const errs = cliErr(core.cliBatch(defaultCli(core.build)));
    if (errs.length) throw new Error(`Betaflight rejected the simulator defaults: ${errs.join('; ')}`);
    if (!core.calibrateAccLevel()) throw new Error('accelerometer calibration did not finish');
    const cliErrors: string[] = [];
    if (plan) {
      const keepOsd = plan.apply.some((l) => /^set osd_\w+_pos\b/.test(l));
      cliErrors.push(...cliErr(core.cliBatch([...plan.apply, ...simHardwareCli(core.build, { keepOsdLayout: keepOsd, propsOut: plan.propsOut }), 'save'])));
      // (`save` reboots the FC: its gyro calibrates again below)
    }
    core.fwRunning = true;
    // Betaflight's boot grace and gyro calibration, with the quad still on the pad, disarmed
    const bootDeadline = core.simT + 8;
    while (bf.armingDisableFlags() !== 0 && core.simT < bootDeadline) for (let i = 0; i < 80; i++) core.physicsStep(dt);
    if (ep.start.armed) {
      this.rc[AUX.arm] = 1900;
      for (let i = 0; i < Math.round(0.3 / dt) && !core.armed; i++) core.physicsStep(dt);
      if (!core.armed) throw new Error(`could not arm: ${armingFlagNames(bf.armingDisableFlags()).join(', ') || 'unknown reason'}`);
    }
    const bootS = core.simT;
    // the start pose (after the boot: the quad calibrates on the pad, then is put where it starts)
    const sp = core.map.spawn;
    const off = ep.start.offset;
    const yaw = ((ep.start.yawDeg ?? (sp.yaw * 180) / Math.PI) + ep.start.yawOffsetDeg) * (Math.PI / 180);
    if (ep.start.pos || off.some((x) => x !== 0) || ep.start.yawOffsetDeg !== 0 || ep.start.yawDeg !== null) {
      const base = ep.start.pos ? { x: ep.start.pos[0], y: ep.start.pos[1], z: ep.start.pos[2] } : { x: sp.pos.x, y: sp.pos.y, z: core.quad.s.pos.z };
      const pos = { x: base.x + off[0], y: base.y + off[1], z: base.z + off[2] };
      // never below the ground (a jittered pad start would start inside it)
      const floor = (ep.start.pos ? core.map.terrain(pos.x, pos.y) : spawnGroundZ(core.map)) + 0.06 - Math.min(...core.build.params.colliders.map((c) => c.pos.z - c.radius));
      pos.z = Math.max(pos.z, floor);
      core.placeAt(pos, yaw);
    } else core.respawn();
    core.nextGate = 0;
    this.t0 = core.simT;
    // the actors start with the episode (their clock, their detectors' looks)
    core.resetActors();
    this.task = new TaskRunner(ep.task, core.map, { cameraUptiltDeg: spec.cameraUptiltDeg });
    // the operational layer starts with the episode (its times are episode times)
    this.applyOps(ep.ops ?? (ep.nav ? {} : null));
    this.probeDirs = probeDirections(ep.probes);
    this.ended = false;
    this.events = [];
    return { obs: this.observe(), info: { seed, episode: this.episode, bootS, cliErrors, drone: droneFacts(core.build) } };
  }

  /** Replace the operational configuration (null: none); its times count from the episode start. */
  applyOps(config: OpsConfig | null) {
    const core = this.core;
    core.setOps(config, this.t0);
    if (core.ops) core.ops.onEvent = (e) => {
      this.events.push(e);
      if (e.type === 'payload_impact') this.task?.onPayload(e.pos, e.speed);
    };
  }

  /**
   * Inject faults now (their `at` counts from now; see src/sim/faults.ts). An episode without an ops
   * configuration gets an empty one first.
   */
  injectFaults(faults: FaultSpec[]) {
    if (!this.core.ops) this.applyOps({});
    this.core.ops!.schedule(faults.map((f) => ({ ...f, at: this.time + f.at })));
  }

  /** RC link margin / jamming / GNSS planning map over a square (see OpsLayer.linkMap). */
  linkMap(o: { centre?: [number, number]; halfM?: number; n?: number; heightM?: number } = {}) {
    const core = this.core;
    if (!core.ops) this.applyOps({});
    const p = core.quad.s.pos;
    return core.ops!.linkMap(core, { centre: o.centre ?? [p.x, p.y], halfM: o.halfM ?? 200, n: o.n ?? 21, heightM: o.heightM ?? 20, txPowerMw: core.settings.rcTxPowerMw ?? 250, rateHz: core.settings.rcLinkHz });
  }

  /** Release the payload now; false if there is none (or it is gone). */
  release(): boolean { return this.core.ops?.release(this.core) ?? false; }

  /** Set the sticks / switches the FC receives from now on (also used by real-time hosts). */
  setAction(a: Action) { applyAction(this.rc, a); }

  /** Advance the simulation by n physics steps with the current sticks (no task bookkeeping). */
  advance(nSteps: number) {
    const core = this.core, dt = 1 / core.settings.physicsHz;
    for (let i = 0; i < nSteps; i++) {
      core.physicsStep(dt);
      if (core.lastImpact.t === core.simT) this.stepImpact = Math.max(this.stepImpact, core.lastImpact.speed);
    }
  }

  /**
   * One control period with this action (or `physicsSteps` physics steps: a real-time host steps
   * whatever the wall clock allows).
   */
  step(action: Action = {}, physicsSteps?: number): StepResult {
    if (!this.core) throw new Error('reset() first');
    const ep = this.episode, core = this.core;
    this.setAction(action);
    // (events since the last step, e.g. a payload released between steps, belong to this one)
    this.stepImpact = 0;
    const n = physicsSteps ?? Math.max(1, Math.round(core.settings.physicsHz / ep.controlHz));
    this.advance(n);
    if (this.stepImpact > 0) this.events.push({ type: 'impact', speed: this.stepImpact, t: this.time });
    const s = core.quad.s;
    const act = core.actors;
    const st = this.task.step({ t: this.time, pos: s.pos, vel: s.vel, w: s.w, armed: core.armed, q: s.q, actorT: core.actorT, ...(act && act.detectors.length ? { detected: act.anyDetected } : {}) });
    let reason: StepResult['info']['reason'];
    if (st.success) reason = 'success';
    else if (st.failed) reason = this.episode.task.type === 'detect-avoid' ? 'detected' : 'failure'; // (detect-avoid: detected for too long)
    else if (ep.endOnCrash && this.stepImpact >= ep.crashSpeedMs) reason = 'crash';
    else if (ep.endOutOfBounds && this.outOfBounds()) reason = 'out_of_bounds';
    const truncated = !reason && this.time >= ep.maxSeconds - 1e-9;
    if (truncated) reason = 'timeout';
    this.ended = !!reason;
    const events = this.events;
    this.events = [];
    return { obs: this.observe(), reward: st.reward, terminated: !!reason && !truncated, truncated, info: { reason, metrics: this.task.metrics(), events } };
  }

  /** The episode has ended (step() after that keeps simulating, but the task is over). */
  get done(): boolean { return this.ended; }

  private outOfBounds(): boolean {
    const m = this.core.map, p = this.core.quad.s.pos;
    return Math.abs(p.x) > m.size || Math.abs(p.y) > m.size || p.z < m.terrain(p.x, p.y) - 2 || p.z > m.terrain(p.x, p.y) + 1000;
  }

  /** Metrics of the episode so far. */
  metrics(): TaskMetrics { return this.task.metrics(); }

  /**
   * Betaflight CLI lines (the plant is held while they run); returns the output. Betaflight only
   * opens its CLI while disarmed: disarm first (step({ arm: false })). End with `save` to keep a
   * change (it reboots the FC, which recalibrates its gyro on the next steps).
   */
  cli(lines: string[]): string {
    if (this.core.armed) throw new Error('Betaflight ignores the CLI while armed: disarm first');
    return this.core.cliBatch(lines);
  }

  observe(): Observation {
    const core = this.core, quad = core.quad, s = quad.s, bf = core.bf;
    const q = s.q;
    // ZYX Euler from the body->world quaternion
    const roll = Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
    const pitch = -Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.y - q.z * q.x))));
    const yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
    const touched = core.ops?.imuTouched, g = touched ? core.fcGyro : quad.imu.gyroOut, a = touched ? core.fcAcc : quad.imu.accOut, b = quad.battery.s;
    const goal = this.task?.goal() ?? null;
    let goalBody: [number, number, number] | null = null;
    if (goal) {
      const d = { x: goal.x - s.pos.x, y: goal.y - s.pos.y, z: goal.z - s.pos.z };
      const r = rotInv(q, d);
      goalBody = [r.x, r.y, r.z];
    }
    const probes = this.probeDirs.map((dirB) => {
      const dw = rot(q, dirB);
      const d = core.world.raycast(s.pos, dw, this.episode.probeRangeM);
      return Math.min(d, this.episode.probeRangeM);
    });
    const flags = bf ? bf.armingDisableFlags() : 0;
    return {
      t: this.time,
      pos: [s.pos.x, s.pos.y, s.pos.z], vel: [s.vel.x, s.vel.y, s.vel.z],
      quat: [q.w, q.x, q.y, q.z], euler: [roll, pitch, yaw],
      rates: [s.w.x, s.w.y, s.w.z], gyro: [g.x, g.y, g.z], acc: [a.x, a.y, a.z],
      motorRpm: quad.motors.map((m) => m.rpm()), motorCmd: Array.from(core.motorCmd),
      rc: [core.rcBuf[0], core.rcBuf[1], core.rcBuf[2], core.rcBuf[3]],
      battery: { v: s.vbus, i: s.ibus, soc: b.soc, mah: b.mAhDrawn, cellV: s.vbus / quad.p.battery.cellsSeries },
      armed: core.armed, armingFlags: armingFlagNames(flags),
      agl: s.pos.z - core.map.terrain(s.pos.x, s.pos.y),
      goal: goal ? [goal.x, goal.y, goal.z] : null, goalBody,
      probes,
      gate: { next: core.map.gates.length ? core.nextGate % core.map.gates.length : 0, total: core.map.gates.length },
      impact: this.stepImpact, damage: core.damageTotal(),
      ...(this.episode.nav && core.ops ? { nav: core.ops.navSensors(core) } : {}),
      ...(core.ops && this.episode.ops ? { ops: core.ops.status(core) } : {}),
      ...(this.episode.observeActors && { actors: this.observeActors() }),
    };
  }

  /** observations.actors: targets (map order), detections, RC margin. */
  private observeActors(): ObservedActors {
    const core = this.core, m = core.map, t = core.actorT;
    const targets = (m.actors ?? []).filter((a) => a.type === 'target').map((a) => {
      const p = posAt(a, m.paths, t), v = velAt(a, m.paths, t);
      return { id: a.id, pos: [p.x, p.y, p.z] as [number, number, number], vel: [v.x, v.y, v.z] as [number, number, number] };
    });
    return { targets, detected: core.actors?.detectedIds() ?? [], rcMarginDb: core.rcLink.marginDb };
  }
}

export { applyAction, AUX, MODE_US, obsVector, obsVectorLabels, probeDirections } from '../api/types';
export type { Action, Observation } from '../api/types';
