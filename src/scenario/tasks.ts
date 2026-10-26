// What an episode asks of the pilot (or the policy), how it is scored, and when it ends: hover in a
// box, fly the course's gates, visit waypoints, or fly free. The same evaluators score a headless
// episode (reward, termination) and an in-app drill (the metrics behind the adaptive curriculum), so a
// policy and a person flying the same scenario are measured the same way.
import { openingCentre } from '../maps/gates';
import type { GateDef, MapDef } from '../maps/world';
import { spawnGroundZ } from '../maps/world';
import type { V3 } from '../sim/math';

export type Vec3 = [number, number, number];

export type TaskDef =
  | { type: 'free' }
  /** stay within radiusM of target (default: heightM above the spawn pad); success: inside for holdS */
  | { type: 'hover'; target?: Vec3; heightM?: number; radiusM?: number; holdS?: number }
  /** fly the map's (or the selected course's) gates in order, `laps` times: a lap is gate 0 round to gate 0 again, as the lap timer counts it */
  | { type: 'gates'; laps?: number }
  /** visit the points in order, each within radiusM */
  | { type: 'waypoints'; points: Vec3[]; radiusM?: number };

/** One state sample, in the world frame (ENU, z up) and body rates (FLU). */
export interface TaskSample {
  t: number;
  pos: V3; vel: V3;
  /** body rates, rad/s */
  w: V3;
  armed: boolean;
}

export interface TaskStatus {
  /** reward earned in this step */
  reward: number;
  /** the task is complete (success) */
  success: boolean;
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
  // gates / waypoints
  passed?: number; total?: number; splitsS?: number[]; lapTimesS?: number[];
  // every task
  distanceM: number; maxSpeedMs: number;
}

const dist = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const v = (p: Vec3): V3 => ({ x: p[0], y: p[1], z: p[2] });

/** Default hover target: heightM above the spawn pad. */
export function hoverTarget(map: MapDef, def: Extract<TaskDef, { type: 'hover' }>): V3 {
  if (def.target) return v(def.target);
  const sp = map.spawn.pos;
  return { x: sp.x, y: sp.y, z: spawnGroundZ(map) + (def.heightM ?? 3) };
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

  constructor(def: TaskDef, map: MapDef) {
    this.def = def;
    if (def.type === 'hover') { this.target = hoverTarget(map, def); this.radius = def.radiusM ?? 1.5; }
    if (def.type === 'gates') { this.gates = map.gates; this.centres = map.gates.map(openingCentre); this.laps = Math.max(1, def.laps ?? 1); }
    if (def.type === 'waypoints') { this.points = def.points.map(v); this.radius = def.radiusM ?? 1; }
  }

  /** Number of targets: gates × laps plus the finish through gate 0, or the waypoints. */
  get total(): number { return this.def.type === 'gates' ? (this.gates.length ? this.gates.length * this.laps + 1 : 0) : this.def.type === 'waypoints' ? this.points.length : 0; }

  /** Where the pilot should go next (hover target, the middle of the next gate's opening, next waypoint), or null. */
  goal(): V3 | null {
    if (this.def.type === 'hover') return this.target;
    if (this.def.type === 'gates') return this.gates.length && this.next < this.total ? this.centres[this.next % this.gates.length] : null;
    if (this.def.type === 'waypoints') return this.points[this.next] ?? null;
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
    this.ret += reward;
    return { reward, success: this.done, progress: this.progress() };
  }

  progress(): number {
    const d = this.def;
    if (d.type === 'hover') return d.holdS ? Math.min(1, this.insideRun / d.holdS) : this.seT > 0 ? this.inside / this.seT : 0;
    if (d.type === 'gates' || d.type === 'waypoints') return this.total ? Math.min(1, this.next / this.total) : 0;
    return 0;
  }

  get success(): boolean { return this.done; }

  metrics(): TaskMetrics {
    const elapsedS = this.last && !Number.isNaN(this.t0) ? this.last.t - this.t0 : 0;
    const m: TaskMetrics = { type: this.def.type, elapsedS, success: this.done, progress: this.progress(), return: this.ret, distanceM: this.distM, maxSpeedMs: this.vMax };
    if (this.def.type === 'hover') {
      const rms = this.seT > 0 ? Math.sqrt(this.se / this.seT) : 0;
      Object.assign(m, { insideS: this.inside, insideFraction: this.seT > 0 ? this.inside / this.seT : 0, rmsErrorM: rms, maxErrorM: this.eMax, normalizedError: rms / this.radius });
    }
    if (this.def.type === 'gates' || this.def.type === 'waypoints') {
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
    return m;
  }
}
