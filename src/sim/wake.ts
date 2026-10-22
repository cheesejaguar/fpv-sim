// Lagrangian rotor-wake model. Each rotor periodically sheds a "puff" carrying the far-wake
// velocity (~2·v_i along -thrust axis). Puffs convect with their own velocity plus the wind, spread,
// and decay. Rotors sample the puff field: flying back down (or flipping) into your own wash
// raises the local downflow and turbulence each rotor sees -> asymmetric, unsteady thrust that the
// PID loop has to fight: prop wash. In forward flight the rear rotors fly through the front rotors'
// fresh wake (the classic front-rear interaction that costs rear-rotor thrust and pitches the nose
// up, cf. Yoon et al. 2017 / Misiorowski et al. 2019 CFD of quadrotors in forward flight).
import { V3 } from './math';

/** off: time from the last step() to the puff's emission (the next step() advances it by the rest of the interval only) */
interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number; age: number; alive: boolean; src: number; off: number }

const MAX = 512;
const LIFE = 1.2;     // s
const DECAY = 0.45;   // s velocity e-fold
const EMIT_DT = 0.012;
const EMIT_DS = 0.8;  // also emit after travelling this many puff radii (keeps the wake contiguous at speed)
const ROTORS = 8;

export class WakeField {
  puffs: Puff[] = [];
  private head = 0;
  private emitAcc: number[] = new Array<number>(ROTORS).fill(0);
  /** per rotor: time its emit() calls have covered since the last step() */
  private since: number[] = new Array<number>(ROTORS).fill(0);
  private last: V3[] = [];
  // ground-jet centre: running mean of where the downwash hits the ground
  private impX = 0; private impY = 0; private impInit = false;
  private acc = new Float64Array(5 * ROTORS); // sampleAll(): per rotor vx, vy, vz, turbulence, weight
  enabled = true;
  constructor() {
    for (let i = 0; i < MAX; i++) this.puffs.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0, age: 0, alive: false, src: -1, off: 0 });
    for (let k = 0; k < ROTORS; k++) this.last.push({ x: 0, y: 0, z: -1e9 });
  }
  reset() { for (const p of this.puffs) p.alive = false; for (const l of this.last) l.z = -1e9; this.impInit = false; this.since.fill(0); }

  /** Rotor k at world pos emits wake with velocity (world) when enough time or distance has elapsed. Call every physics step. */
  emit(k: number, pos: V3, wakeVel: V3, radius: number, dt: number): void {
    if (!this.enabled) return;
    const off = this.since[k];
    this.since[k] += dt;
    this.emitAcc[k] += dt;
    const l = this.last[k];
    const dx = pos.x - l.x, dy = pos.y - l.y, dz = pos.z - l.z, ds = EMIT_DS * radius;
    if (this.emitAcc[k] < EMIT_DT && dx * dx + dy * dy + dz * dz < ds * ds) return;
    this.emitAcc[k] = 0;
    l.x = pos.x; l.y = pos.y; l.z = pos.z;
    const p = this.puffs[this.head];
    this.head = (this.head + 1) % MAX;
    p.x = pos.x; p.y = pos.y; p.z = pos.z;
    p.vx = wakeVel.x; p.vy = wakeVel.y; p.vz = wakeVel.z;
    p.r = radius; p.age = 0; p.alive = true; p.src = k; p.off = off;
  }

  /**
   * Advance the puffs by dt, of any length: the caller picks the cadence (every physics step, or
   * once per ms with the time accumulated since). Exact for the model: the velocity decays as
   * exp(-t/DECAY), so a puff moves wind·t + v·DECAY·(1 - exp(-t/DECAY)) and its radius grows by the
   * same integral of its speed. A puff emitted during the interval moves only from its emission on.
   */
  step(dt: number, wind: V3, groundZ: number): void {
    this.since.fill(0);
    const fAll = Math.exp(-dt / DECAY), gAll = DECAY * (1 - fAll);
    const wx = wind.x, wy = wind.y, wz = wind.z, floor = groundZ + 0.05;
    for (const p of this.puffs) {
      if (!p.alive) continue;
      let t = dt, f = fAll, g = gAll;
      if (p.off > 0) { t = Math.max(0, dt - p.off); f = Math.exp(-t / DECAY); g = DECAY * (1 - f); p.off = 0; }
      p.age += t;
      if (p.age > LIFE) { p.alive = false; continue; }
      p.x += wx * t + p.vx * g; p.y += wy * t + p.vy * g; p.z += wz * t + p.vz * g;
      p.r += 0.225 * g * Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz) + 0.05 * t;
      p.vx *= f; p.vy *= f; p.vz *= f;
      // ground: the impinging jet turns into a radial wall jet and stops descending
      if (p.z < floor) {
        p.z = floor;
        if (p.vz < 0) {
          // (once per puff, when it lands: this running mean does not depend on the step size)
          if (!this.impInit) { this.impX = p.x; this.impY = p.y; this.impInit = true; }
          this.impX += 0.02 * (p.x - this.impX); this.impY += 0.02 * (p.y - this.impY);
          let ex = p.x - this.impX, ey = p.y - this.impY;
          let d = Math.sqrt(ex * ex + ey * ey);
          if (d < 1e-3) { const a = (this.head * 2.399963) % (2 * Math.PI); ex = Math.cos(a); ey = Math.sin(a); d = 1; } // golden-angle fallback
          const s = -0.5 * p.vz / d;
          p.vx += ex * s; p.vy += ey * s;
        }
        p.vz = 0;
      }
    }
  }

  /**
   * Sample induced air velocity and a turbulence measure at a world point. Rotor `self`'s own
   * puffs younger than `minAge` are ignored (a rotor never sees its own just-shed wake directly
   * beneath it); other rotors' fresh wake counts at once. Overlapping puffs are samples of the
   * same jet, so they are kernel-averaged (weight sum floored at 1), not superposed.
   */
  sample(pos: V3, o: V3, self = -1, minAge = 0.06): number {
    o.x = 0; o.y = 0; o.z = 0;
    let turb = 0, ks = 0;
    for (const p of this.puffs) {
      if (!p.alive || (p.src === self && p.age < minAge)) continue;
      const dx = pos.x - p.x, dy = pos.y - p.y, dz = pos.z - p.z;
      const r2 = p.r * p.r * 2.25;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const w = 1 - d2 / r2;
      const k = w * w;
      o.x += p.vx * k; o.y += p.vy * k; o.z += p.vz * k;
      turb += Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz) * k;
      ks += k;
    }
    if (ks > 1) { const n = 1 / ks; o.x *= n; o.y *= n; o.z *= n; turb *= n; }
    return turb;
  }

  /**
   * sample() for every rotor at once (rotor k at hubs[k], self = k) in one pass over the puffs; a
   * puff that can reach none of the hubs is dropped with one test. Same sums in the same order as
   * sample(), so the same results.
   */
  sampleAll(hubs: V3[], out: V3[], turb: number[], minAge = 0.06): void {
    const n = hubs.length, A = this.acc;
    A.fill(0, 0, 5 * n);
    let cx = 0, cy = 0, cz = 0, reach = 0;
    for (let k = 0; k < n; k++) { cx += hubs[k].x; cy += hubs[k].y; cz += hubs[k].z; }
    cx /= n; cy /= n; cz /= n;
    for (let k = 0; k < n; k++) { const h = hubs[k], dx = h.x - cx, dy = h.y - cy, dz = h.z - cz; reach = Math.max(reach, Math.sqrt(dx * dx + dy * dy + dz * dz)); }
    reach = reach * (1 + 1e-9) + 1e-9;
    for (const p of this.puffs) {
      if (!p.alive) continue;
      const lim = 1.5 * p.r + reach, ex = cx - p.x, ey = cy - p.y, ez = cz - p.z;
      if (ex * ex + ey * ey + ez * ez > lim * lim) continue;
      const r2 = p.r * p.r * 2.25;
      for (let k = 0; k < n; k++) {
        if (p.src === k && p.age < minAge) continue;
        const h = hubs[k], dx = h.x - p.x, dy = h.y - p.y, dz = h.z - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const w = 1 - d2 / r2, kk = w * w, o = 5 * k;
        A[o] += p.vx * kk; A[o + 1] += p.vy * kk; A[o + 2] += p.vz * kk;
        A[o + 3] += Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz) * kk;
        A[o + 4] += kk;
      }
    }
    for (let k = 0; k < n; k++) {
      const o = 5 * k, v = out[k], ks = A[o + 4];
      v.x = A[o]; v.y = A[o + 1]; v.z = A[o + 2];
      let t = A[o + 3];
      if (ks > 1) { const m = 1 / ks; v.x *= m; v.y *= m; v.z *= m; t *= m; }
      turb[k] = t;
    }
  }
}
