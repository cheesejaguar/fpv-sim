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
import { spawnGroundZ, withCourse } from '../maps/world';
import { subSeed, V3 } from '../sim/math';
import { Action, applyAction, AUX, MODE_US, Observation, probeDirections, rot, rotInv } from '../api/types';
import { resolveEpisode, Episode, Scenario, defaultScenario, parseScenario } from '../scenario/scenario';
import { TaskMetrics, TaskRunner } from '../scenario/tasks';
import { FlightCore } from '../worker/flightCore';

export interface StepResult {
  obs: Observation;
  reward: number;
  /** the episode ended by itself: task complete, crash, left the map */
  terminated: boolean;
  /** the episode hit its time limit */
  truncated: boolean;
  info: { reason?: 'success' | 'crash' | 'out_of_bounds' | 'timeout'; metrics: TaskMetrics; events: EnvEvent[] };
}

export type EnvEvent = { type: 'gate'; gate: number; t: number } | { type: 'impact'; speed: number; t: number } | { type: 'log'; text: string; t: number };

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
    if (o.scenario !== undefined) {
      const { scenario, errors } = parseScenario(o.scenario, (id) => id in MAPS);
      if (!scenario) throw new Error(`invalid scenario:\n  ${errors.join('\n  ')}`);
      this.scenario = scenario;
      this.episodeCount = 0;
    }
    this.scenario ??= defaultScenario({ map: { id: 'field' } });
    const sc = this.scenario;
    const seed = o.seed ?? subSeed(sc.seed ?? 0, this.episodeCount);
    this.episodeCount++;
    const ep = resolveEpisode(sc, seed);
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
    }, { seed });
    core.gpsEpochMs = GPS_EPOCH_MS;
    core.settings = ep.settings;
    core.spec = spec;
    core.setMap(withCourse(MAPS[ep.mapId](), ep.courseId));
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
    this.task = new TaskRunner(ep.task, core.map);
    this.probeDirs = probeDirections(ep.probes);
    this.ended = false;
    this.events = [];
    return { obs: this.observe(), info: { seed, episode: this.episode, bootS, cliErrors, drone: droneFacts(core.build) } };
  }

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
    this.events = [];
    this.stepImpact = 0;
    const n = physicsSteps ?? Math.max(1, Math.round(core.settings.physicsHz / ep.controlHz));
    this.advance(n);
    if (this.stepImpact > 0) this.events.push({ type: 'impact', speed: this.stepImpact, t: this.time });
    const s = core.quad.s;
    const st = this.task.step({ t: this.time, pos: s.pos, vel: s.vel, w: s.w, armed: core.armed });
    let reason: StepResult['info']['reason'];
    if (st.success) reason = 'success';
    else if (ep.endOnCrash && this.stepImpact >= ep.crashSpeedMs) reason = 'crash';
    else if (ep.endOutOfBounds && this.outOfBounds()) reason = 'out_of_bounds';
    const truncated = !reason && this.time >= ep.maxSeconds - 1e-9;
    if (truncated) reason = 'timeout';
    this.ended = !!reason;
    return { obs: this.observe(), reward: st.reward, terminated: !!reason && !truncated, truncated, info: { reason, metrics: this.task.metrics(), events: this.events } };
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
    const g = quad.imu.gyroOut, a = quad.imu.accOut, b = quad.battery.s;
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
    };
  }
}

export { applyAction, AUX, MODE_US, obsVector, obsVectorLabels, probeDirections } from '../api/types';
export type { Action, Observation } from '../api/types';
