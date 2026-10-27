// Reference autopilot: a simple, deterministic mission pilot that flies any task through Betaflight
// in angle mode, the way a companion computer would (sticks in, Betaflight's own attitude loop
// does the rest). It goes to the task's goal (hover point, next gate, next waypoint, drop target)
// at a cruise speed and height, holds position there, and releases a payload when its ballistic
// prediction lands on the target. It navigates on the truth, or on the GNSS solution
// (navigation: 'gnss'): then jamming and spoofing reach it as they would a real autopilot (no fix:
// it levels out and descends; a spoofed fix: it flies to the wrong place).
// It is a baseline for campaigns and a starting point, not a tuned flight stack.
import type { Action, Observation } from '../api/types';
import { G0 } from '../sim/atmosphere';

export interface PilotParams {
  /** truth, or the GNSS receiver's solution (needs the scenario's ops) */
  navigation?: 'truth' | 'gnss';
  /** cruise speed (m/s) and the most it tilts (deg) */
  cruiseMs?: number;
  maxTiltDeg?: number;
  /** height above the ground on the way (m); the goal's own height is used near it (drop: kept) */
  cruiseAglM?: number;
  /** Betaflight's angle_limit (deg): full stick = this attitude */
  angleLimitDeg?: number;
  /** the throttle stick that holds a hover (reset info drone.hoverThrottle) */
  hoverThrottle: number;
}

export class ReferencePilot {
  private p: Required<PilotParams>;
  private zInt = 0;
  /** integral of the velocity error (m/s²): trims out wind and drag */
  private ix = 0; private iy = 0;
  private lastT = 0;
  private released = false;
  /** where it let go of the payload (it holds there afterwards) */
  private holdAt: [number, number, number] | null = null;
  constructor(p: PilotParams, private task: { type: string; target?: [number, number, number] }) {
    this.p = { navigation: 'truth', cruiseMs: 6, maxTiltDeg: 30, cruiseAglM: 8, angleLimitDeg: 60, ...p };
  }

  /** The action for this observation (and whether to release the payload now). */
  act(o: Observation): { action: Action; release: boolean } {
    const p = this.p, dt = Math.max(1e-3, o.t - this.lastT);
    this.lastT = o.t;
    let pos = o.pos, vel = o.vel;
    if (p.navigation === 'gnss') {
      const fix = o.ops?.fix;
      if (!fix) {
        // no fix: level, slow descent (a real stack would land or hold on optical flow)
        const thr = this.throttle(o, -0.5 - o.vel[2], 0);
        return { action: { roll: 0, pitch: 0, yaw: 0, throttle: thr, mode: 'angle' }, release: false };
      }
      // horizontal from the receiver; height and climb rate from the barometer / accelerometer (as real stacks do)
      pos = [fix.pos[0], fix.pos[1], o.pos[2]]; vel = [fix.vel[0], fix.vel[1], o.vel[2]];
    }
    const goal = this.goal(o);
    if (!goal) return { action: { roll: 0, pitch: 0, yaw: 0, throttle: this.throttle(o, -o.vel[2], 0), mode: 'angle' }, release: false };
    const dx = goal[0] - pos[0], dy = goal[1] - pos[1], dh = Math.hypot(dx, dy);
    // horizontal: a velocity toward the goal (slowing inside 2·v²/a), then a tilt for the velocity error
    // climb out before cruising: low and far from the goal, creep sideways (trees, posts, people)
    const climbing = o.agl < p.cruiseAglM - 2 && dh > 6;
    const vMax = Math.min(climbing ? 1 : p.cruiseMs, 0.8 * dh, Math.sqrt(2 * 2.5 * dh));
    const vx = dh > 1e-6 ? (dx / dh) * vMax : 0, vy = dh > 1e-6 ? (dy / dh) * vMax : 0;
    this.ix = Math.max(-4, Math.min(4, this.ix + 0.8 * (vx - vel[0]) * dt));
    this.iy = Math.max(-4, Math.min(4, this.iy + 0.8 * (vy - vel[1]) * dt));
    const ax = 1.5 * (vx - vel[0]) + this.ix, ay = 1.5 * (vy - vel[1]) + this.iy;
    // vertical: cruise height on the way, the goal's height near it
    const ground = o.pos[2] - o.agl;
    const zGoal = this.task.type === 'drop' ? ground + p.cruiseAglM : dh > 6 ? Math.max(goal[2], ground + p.cruiseAglM) : goal[2];
    const vzCmd = Math.max(-2, Math.min(2, 0.8 * (zGoal - pos[2])));
    this.zInt = Math.max(-0.15, Math.min(0.15, this.zInt + 0.03 * (vzCmd - vel[2]) * dt + 0.01 * (zGoal - pos[2]) * dt));
    // world accel -> body heading frame -> angle-mode sticks
    const yaw = o.euler[2], c = Math.cos(yaw), s = Math.sin(yaw);
    const fwd = c * ax + s * ay, left = -s * ax + c * ay;
    const lim = (p.maxTiltDeg * Math.PI) / 180, al = (p.angleLimitDeg * Math.PI) / 180;
    const pitchA = Math.max(-lim, Math.min(lim, Math.atan2(fwd, G0)));
    const rollA = Math.max(-lim, Math.min(lim, Math.atan2(-left, G0)));
    const tilt = Math.hypot(pitchA, rollA);
    const throttle = this.throttle(o, vzCmd - vel[2], tilt);
    let release = false;
    if (this.task.type === 'drop' && !this.released && this.task.target) {
      // drag-free fall from here with the current velocity: where would it land?
      const h = pos[2] - this.task.target[2], vz = vel[2];
      const tf = (vz + Math.sqrt(vz * vz + 2 * G0 * Math.max(0, h))) / G0;
      const ix = pos[0] + vel[0] * tf, iy = pos[1] + vel[1] * tf;
      if (Math.hypot(ix - this.task.target[0], iy - this.task.target[1]) < 0.6 && Math.abs(pos[2] - zGoal) < 1.5) { release = true; this.released = true; this.holdAt = [...pos]; }
    }
    return { action: { pitch: pitchA / al, roll: rollA / al, yaw: 0, throttle, mode: 'angle' }, release };
  }

  private throttle(o: Observation, vzErr: number, tilt: number): number {
    const p = this.p;
    const want = Math.max(0.05, Math.min(1, (p.hoverThrottle + 0.08 * vzErr + this.zInt) / Math.max(0.6, Math.cos(tilt))));
    // slew-limited (2 per second): no punch that sags a high-resistance pack (Li-ion) to the floor
    const dt = Math.max(1e-3, o.t - this.lastThrT);
    this.lastThrT = o.t;
    this.thr = this.thr < 0 ? Math.min(want, p.hoverThrottle) : this.thr + Math.max(-2 * dt, Math.min(2 * dt, want - this.thr));
    return this.thr;
  }
  private thr = -1; private lastThrT = 0;

  private goal(o: Observation): [number, number, number] | null {
    if (this.task.type === 'drop' && this.task.target) {
      if (this.released) return this.holdAt;
      return this.task.target;
    }
    return o.goal;
  }
}
