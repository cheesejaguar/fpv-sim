// What an episode asks of the pilot (or the policy), how it is scored, and when it ends: hover in a
// box, fly the course's gates, visit waypoints, deliver a payload onto a target, fly free, or the map
// actors' tasks: reach a target, keep one in the camera, fly a route without being detected. The same evaluators score a headless
// episode (reward, termination) and an in-app drill (the metrics behind the adaptive curriculum), so a
// policy and a person flying the same scenario are measured the same way.
import { openingCentre } from '../maps/gates';
import type { ActorDef, GateDef, MapDef } from '../maps/world';
import { spawnGroundZ } from '../maps/world';
import { posAt } from '../sim/actors';
import type { V3 } from '../sim/math';

export type Vec3 = [number, number, number];

export type TaskDef =
  | { type: 'free' }
  /** stay within radiusM of target (default: heightM above the spawn pad); success: inside for holdS */
  | { type: 'hover'; target?: Vec3; heightM?: number; radiusM?: number; holdS?: number }
  /** fly the map's (or the selected course's) gates in order, `laps` times: a lap is gate 0 round to gate 0 again, as the lap timer counts it */
  | { type: 'gates'; laps?: number }
  /** visit the points in order, each within radiusM */
  | { type: 'waypoints'; points: Vec3[]; radiusM?: number }
  /** get within radiusM (default: the target's own radius) of a target actor, and stay holdS (default 0) */
  | { type: 'reach-target'; target: string; radiusM?: number; holdS?: number }
  /** keep a target actor within rangeM (15) and within fovDeg (60) of the camera axis for holdS (5) in a row */
  | { type: 'track-target'; target: string; rangeM?: number; fovDeg?: number; holdS?: number }
  /** fly the points in order and / or to a target (each within radiusM, 1), detected for at most maxDetectedS (0) in all */
  | { type: 'detect-avoid'; points?: Vec3[]; target?: string; radiusM?: number; maxDetectedS?: number }
  /** release the payload (scenario ops.payload) so it lands within radiusM of target (horizontal miss) */
  | { type: 'drop'; target: Vec3; radiusM?: number };

/** One state sample, in the world frame (ENU, z up) and body rates (FLU). */
export interface TaskSample {
  t: number;
  pos: V3; vel: V3;
  /** body rates, rad/s */
  w: V3;
  armed: boolean;
  /** attitude (body FLU -> world ENU): the track-target task's camera axis */
  q?: { w: number; x: number; y: number; z: number };
  /** the map has detectors and one of them holds a detection of the quad now */
  detected?: boolean;
  /** actor time (s) for moving targets (default: t) */
  actorT?: number;
}

export interface TaskStatus {
  /** reward earned in this step */
  reward: number;
  /** the task is complete (success) */
  success: boolean;
  /** the task can no longer succeed (a drop that missed; detect-avoid: detected for too long) */
  failed?: boolean;
  /** 0..1, how much of the task is done */
  progress: number;
}

/** Summary numbers of an attempt (all optional; which ones exist depends on the task). */
export interface TaskMetrics {
  type: TaskDef['type'];
  /** seconds since the attempt started */
  elapsedS: number;
  success: boolean;
  progress: number;
  /** total reward */
  return: number;
  // hover
  insideS?: number; insideFraction?: number; rmsErrorM?: number; maxErrorM?: number;
  /** RMS error over the box radius: below 0.25 is a clean hover (the curriculum's pass mark) */
  normalizedError?: number;
  // gates / waypoints / detect-avoid
  passed?: number; total?: number; splitsS?: number[]; lapTimesS?: number[];
  // reach-target / track-target
  targetDistM?: number; minTargetDistM?: number; reachedS?: number;
  trackedS?: number; trackedFraction?: number;
  /** map with detectors: seconds the quad was detected, and when it first was (s since the start; null: never) */
  detectedS?: number; firstDetectT?: number | null;
  failed?: boolean;
  // drop
  missM?: number; impactSpeedMs?: number; impactPos?: Vec3;
  // every task
  distanceM: number; maxSpeedMs: number;
}

/** Options from the episode: the camera's uptilt (track-target's camera axis). */
export interface TaskOptions { cameraUptiltDeg?: number }

const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const v = (p: Vec3): V3 => ({ x: p[0], y: p[1], z: p[2] });

/** Default hover target: heightM above the spawn pad. */
export function hoverTarget(map: MapDef, def: Extract<TaskDef, { type: 'hover' }>): V3 {
  if (def.target) return v(def.target);
  const sp = map.spawn.pos;
  return { x: sp.x, y: sp.y, z: spawnGroundZ(map) + (def.heightM ?? 3) };
}

/** A target actor's centre (its pos is its base: half its height up). */
function targetCentre(map: MapDef, a: ActorDef, t: number, out: V3): V3 {
  posAt(a, map.paths, t, out);
  if (a.type === 'target' && a.shape !== 'sphere') out.z += a.size.z / 2;
  return out;
}

/**
 * Scores one attempt at a task, step by step. Feed it every state sample (any rate; the env does
 * every control step) and every gate pass the flight core reports.
 */
export class TaskRunner {
  readonly def: TaskDef;
  private t0 = NaN;
  private last: TaskSample | null = null;
  private ret = 0;
  private done = false;
  private distM = 0; private vMax = 0;
  // hover
  private target: V3 = { x: 0, y: 0, z: 0 };
  private radius = 1.5;
  private inside = 0; private insideRun = 0; private se = 0; private seT = 0; private eMax = 0;
  // gates / waypoints
  private points: V3[] = [];
  private gates: GateDef[] = [];
  /** the middle of each gate's opening (what the progress reward measures to) */
  private centres: V3[] = [];
  private next = 0;
  private laps = 1;
  private passTimes: number[] = [];
  private lapStarts: number[] = [];
  private prevD = NaN;
  // actor tasks
  private readonly map: MapDef;
  private actor: ActorDef | null = null;
  private tgtPos: V3 = { x: 0, y: 0, z: 0 };
  private tgtD = NaN; private tgtMin = Infinity; private reachedAt = NaN;
  private tracked = 0; private trackRun = 0; private sampledT = 0;
  private cosFov = 0.5; private rangeM = 15; private uptilt = 0;
  private detS = 0; private firstDet: number | null = null; private sawDetect = false;
  // drop
  private impact: { pos: V3; speed: number } | null = null;
  private failed = false;

  constructor(def: TaskDef, map: MapDef, opts: TaskOptions = {}) {
    this.def = def;
    this.map = map;
    if (def.type === 'hover') { this.target = hoverTarget(map, def); this.radius = def.radiusM ?? 1.5; }
    if (def.type === 'gates') { this.gates = map.gates; this.centres = map.gates.map(openingCentre); this.laps = Math.max(1, def.laps ?? 1); }
    if (def.type === 'waypoints') { this.points = def.points.map(v); this.radius = def.radiusM ?? 1; }
    if (def.type === 'reach-target' || def.type === 'track-target' || def.type === 'detect-avoid') {
      const a = def.target !== undefined ? map.actors?.find((x) => x.id === def.target && x.type === 'target') : undefined;
      if (def.target !== undefined && !a) throw new Error(`task.target: the map has no target actor "${def.target}"`);
      this.actor = a ?? null;
      if (a) targetCentre(map, a, 0, this.tgtPos);
    }
    if (def.type === 'reach-target') this.radius = def.radiusM ?? (this.actor?.type === 'target' ? this.actor.radius : 1);
    if (def.type === 'track-target') { this.rangeM = def.rangeM ?? 15; this.cosFov = Math.cos(((def.fovDeg ?? 60) / 2) * (Math.PI / 180)); this.uptilt = ((opts.cameraUptiltDeg ?? 30) * Math.PI) / 180; }
    if (def.type === 'detect-avoid') { this.points = (def.points ?? []).map(v); this.radius = def.radiusM ?? 1; }
    if (def.type === 'drop') { this.target = v(def.target); this.radius = def.radiusM ?? 2; }
  }

  /** The payload landed (drop task): scored on the horizontal miss distance. */
  onPayload(pos: V3, speed: number): number {
    if (this.def.type !== 'drop' || this.done || this.failed) return 0;
    this.impact = { pos: { ...pos }, speed };
    const miss = Math.hypot(pos.x - this.target.x, pos.y - this.target.y);
    if (miss <= this.radius) { this.done = true; this.ret += 10; return 10; }
    this.failed = true;
    return 0;
  }

  /** Number of targets: gates × laps plus the finish through gate 0, the waypoints, or detect-avoid's route. */
  get total(): number {
    const d = this.def;
    if (d.type === 'gates') return this.gates.length ? this.gates.length * this.laps + 1 : 0;
    if (d.type === 'waypoints') return this.points.length;
    if (d.type === 'detect-avoid') return this.points.length + (this.actor ? 1 : 0);
    return 0;
  }

  /** Where the pilot should go next (hover target, the middle of the next gate's opening, next waypoint, the target), or null. */
  goal(): V3 | null {
    const d = this.def;
    if (d.type === 'hover' || d.type === 'drop') return this.target;
    if (d.type === 'gates') return this.gates.length && this.next < this.total ? this.centres[this.next % this.gates.length] : null;
    if (d.type === 'waypoints') return this.points[this.next] ?? null;
    if (d.type === 'reach-target' || d.type === 'track-target') return this.tgtPos;
    if (d.type === 'detect-avoid') return this.next < this.points.length ? this.points[this.next] : this.actor && this.next < this.total ? this.tgtPos : null;
    return null;
  }

  /** The flight core reports a pass of gate `id` (in course order) at sim time t. */
  onGate(id: number, t: number): number {
    if (this.def.type !== 'gates' || this.done || !this.gates.length) return 0;
    const g = this.gates[this.next % this.gates.length];
    if (g.id !== id) return 0;
    if (this.next % this.gates.length === 0) this.lapStarts.push(t);
    this.passTimes.push(t);
    this.next++;
    this.prevD = NaN;
    if (this.next >= this.total) this.done = true;
    const bonus = 10;
    this.ret += bonus;
    return bonus;
  }

  step(s: TaskSample): TaskStatus {
    if (Number.isNaN(this.t0)) this.t0 = s.t;
    const dt = this.last ? Math.max(0, s.t - this.last.t) : 0;
    if (this.last) this.distM += dist(s.pos, this.last.pos);
    this.vMax = Math.max(this.vMax, Math.hypot(s.vel.x, s.vel.y, s.vel.z));
    this.last = { ...s, pos: { ...s.pos }, vel: { ...s.vel }, w: { ...s.w } };
    let reward = 0;
    const def = this.def;
    // detections (maps with detectors): time detected, first detection
    if (s.detected !== undefined) {
      this.sawDetect = true;
      if (s.detected) { this.detS += dt; if (this.firstDet === null) this.firstDet = s.t - this.t0; }
    }
    if (this.actor) targetCentre(this.map, this.actor, s.actorT ?? s.t, this.tgtPos);
    if (def.type === 'hover' && dt > 0) {
      const e = dist(s.pos, this.target);
      // dense reward in [0, 1] per second: 1 at the target, 1/e at the box's edge
      reward = dt * Math.exp(-((e / this.radius) ** 2));
      if (e < this.radius) { this.inside += dt; this.insideRun += dt; } else this.insideRun = 0;
      this.se += e * e * dt; this.seT += dt; this.eMax = Math.max(this.eMax, e);
      if (def.holdS !== undefined && this.insideRun >= def.holdS) this.done = true;
    }
    if ((def.type === 'gates' || def.type === 'waypoints') && !this.done) {
      if (def.type === 'waypoints') {
        while (this.next < this.points.length && dist(s.pos, this.points[this.next]) < this.radius) {
          this.passTimes.push(s.t); this.next++; this.prevD = NaN; reward += 10;
        }
      }
      const g = this.goal();
      if (g) {
        // progress toward the next target: metres closed this step
        const d = dist(s.pos, g);
        if (!Number.isNaN(this.prevD)) reward += this.prevD - d;
        this.prevD = d;
      }
      if (this.next >= this.total && this.total > 0) this.done = true;
    }
    if (def.type === 'reach-target' && !this.done) {
      const d = dist(s.pos, this.tgtPos);
      this.tgtD = d; this.tgtMin = Math.min(this.tgtMin, d);
      if (!Number.isNaN(this.prevD)) reward += this.prevD - d;
      this.prevD = d;
      if (d < this.radius) { this.insideRun += dt; if (Number.isNaN(this.reachedAt)) this.reachedAt = s.t - this.t0; } else this.insideRun = 0;
      if (d < this.radius && this.insideRun >= (def.holdS ?? 0)) { this.done = true; reward += 10; }
    }
    if (def.type === 'track-target' && !this.done) {
      const d = dist(s.pos, this.tgtPos);
      this.tgtD = d; this.tgtMin = Math.min(this.tgtMin, d);
      const on = d <= this.rangeM && this.inView(s);
      this.sampledT += dt;
      if (on) { this.tracked += dt; this.trackRun += dt; reward += dt; } else this.trackRun = 0;
      if (this.trackRun >= (def.holdS ?? 5)) this.done = true;
    }
    if (def.type === 'detect-avoid' && !this.done && !this.failed) {
      while (this.next < this.total && dist(s.pos, this.next < this.points.length ? this.points[this.next] : this.tgtPos) < this.radius) {
        this.passTimes.push(s.t); this.next++; this.prevD = NaN; reward += 10;
      }
      const g = this.goal();
      if (g) { const d = dist(s.pos, g); if (!Number.isNaN(this.prevD)) reward += this.prevD - d; this.prevD = d; }
      if (s.detected) reward -= dt * 5;
      if (this.detS > (def.maxDetectedS ?? 0)) this.failed = true;
      else if (this.next >= this.total && this.total > 0) this.done = true;
    }
    if (def.type === 'drop' && !this.done && !this.failed) {
      // shaping: horizontal metres closed toward the target
      const d = Math.hypot(s.pos.x - this.target.x, s.pos.y - this.target.y);
      if (!Number.isNaN(this.prevD)) reward += this.prevD - d;
      this.prevD = d;
    }
    this.ret += reward;
    return { reward, success: this.done, failed: this.failed, progress: this.progress() };
  }

  /** The target within the task's field of view around the camera axis (body forward, tilted up by the uptilt). */
  private inView(s: TaskSample): boolean {
    const q = s.q;
    if (!q) return false;
    const cu = Math.cos(this.uptilt), su = Math.sin(this.uptilt);
    // camera axis in the body (FLU): forward, pitched up; rotated into the world by q
    const bx = cu, bz = su;
    const tx = 2 * (q.y * bz), ty = 2 * (q.z * bx - q.x * bz), tz = 2 * (-q.y * bx);
    const ax = bx + q.w * tx + (q.y * tz - q.z * ty), ay = q.w * ty + (q.z * tx - q.x * tz), az = bz + q.w * tz + (q.x * ty - q.y * tx);
    const dx = this.tgtPos.x - s.pos.x, dy = this.tgtPos.y - s.pos.y, dz = this.tgtPos.z - s.pos.z, d = Math.hypot(dx, dy, dz);
    if (d < 1e-6) return true;
    return (ax * dx + ay * dy + az * dz) / (d * Math.hypot(ax, ay, az)) >= this.cosFov;
  }

  progress(): number {
    const d = this.def;
    if (d.type === 'hover') return d.holdS ? Math.min(1, this.insideRun / d.holdS) : this.seT > 0 ? this.inside / this.seT : 0;
    if (d.type === 'gates' || d.type === 'waypoints' || d.type === 'detect-avoid') return this.total ? Math.min(1, this.next / this.total) : 0;
    if (d.type === 'reach-target') return this.done ? 1 : d.holdS ? Math.min(1, this.insideRun / d.holdS) : 0;
    if (d.type === 'track-target') return Math.min(1, this.trackRun / (d.holdS ?? 5));
    if (d.type === 'drop') return this.done ? 1 : 0;
    return 0;
  }

  get success(): boolean { return this.done; }
  /** detect-avoid: detected for longer than allowed */
  get hasFailed(): boolean { return this.failed; }

  metrics(): TaskMetrics {
    const elapsedS = this.last && !Number.isNaN(this.t0) ? this.last.t - this.t0 : 0;
    const m: TaskMetrics = { type: this.def.type, elapsedS, success: this.done, progress: this.progress(), return: this.ret, distanceM: this.distM, maxSpeedMs: this.vMax };
    if (this.def.type === 'hover') {
      const rms = this.seT > 0 ? Math.sqrt(this.se / this.seT) : 0;
      Object.assign(m, { insideS: this.inside, insideFraction: this.seT > 0 ? this.inside / this.seT : 0, rmsErrorM: rms, maxErrorM: this.eMax, normalizedError: rms / this.radius });
    }
    if (this.def.type === 'gates' || this.def.type === 'waypoints' || this.def.type === 'detect-avoid') {
      const t0 = this.def.type === 'gates' ? this.lapStarts[0] ?? this.t0 : this.t0;
      m.passed = this.next; m.total = this.total;
      m.splitsS = this.passTimes.map((t) => t - t0);
      if (this.def.type === 'gates') {
        const laps: number[] = [];
        // a lap: gate 0 round to gate 0 again
        for (let k = 0; k + 1 < this.lapStarts.length; k++) laps.push(this.lapStarts[k + 1] - this.lapStarts[k]);
        m.lapTimesS = laps;
      }
    }
    if (this.def.type === 'reach-target' || this.def.type === 'track-target') {
      m.targetDistM = Number.isNaN(this.tgtD) ? dist(this.last?.pos ?? this.tgtPos, this.tgtPos) : this.tgtD;
      m.minTargetDistM = Number.isFinite(this.tgtMin) ? this.tgtMin : m.targetDistM;
      if (this.def.type === 'reach-target' && !Number.isNaN(this.reachedAt)) m.reachedS = this.reachedAt;
      if (this.def.type === 'track-target') { m.trackedS = this.tracked; m.trackedFraction = this.sampledT > 0 ? this.tracked / this.sampledT : 0; }
    }
    if (this.sawDetect) { m.detectedS = this.detS; m.firstDetectT = this.firstDet; }
    if (this.failed) m.failed = true;
    if (this.def.type === 'drop' && this.impact) {
      const p = this.impact.pos;
      Object.assign(m, { missM: Math.hypot(p.x - this.target.x, p.y - this.target.y), impactSpeedMs: this.impact.speed, impactPos: [p.x, p.y, p.z] });
    }
    return m;
  }
}
