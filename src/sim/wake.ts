// Lagrangian rotor-wake model. Each rotor periodically sheds a "puff" carrying the far-wake
// velocity (~2·v_i along -thrust axis). Puffs convect with their own velocity plus the wind, spread,
// and decay. Rotors sample the puff field: flying back down (or flipping) into your own wash
// raises the local downflow and turbulence each rotor sees -> asymmetric, unsteady thrust that the
// PID loop has to fight: prop wash. In forward flight the rear rotors fly through the front rotors'
// fresh wake (the classic front-rear interaction that costs rear-rotor thrust and pitches the nose
// up, cf. Yoon et al. 2017 / Misiorowski et al. 2019 CFD of quadrotors in forward flight).
import { V3 } from './math';

interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number; age: number; alive: boolean; src: number }

const MAX = 512;
const LIFE = 1.2;     // s
const DECAY = 0.45;   // s velocity e-fold
const EMIT_DT = 0.012;
const EMIT_DS = 0.8;  // also emit after travelling this many puff radii (keeps the wake contiguous at speed)

export class WakeField {
  puffs: Puff[] = [];
  private head = 0;
  private emitAcc: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  private last: V3[] = [];
  // ground-jet centre: running mean of where the downwash hits the ground
  private impX = 0; private impY = 0; private impInit = false;
  enabled = true;
  constructor() {
    for (let i = 0; i < MAX; i++) this.puffs.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0, age: 0, alive: false, src: -1 });
    for (let k = 0; k < this.emitAcc.length; k++) this.last.push({ x: 0, y: 0, z: -1e9 });
  }
  reset() { for (const p of this.puffs) p.alive = false; for (const l of this.last) l.z = -1e9; this.impInit = false; }

  /** Rotor k at world pos emits wake with velocity (world) when enough time or distance has elapsed. */
  emit(k: number, pos: V3, wakeVel: V3, radius: number, dt: number): void {
    if (!this.enabled) return;
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
    p.r = radius; p.age = 0; p.alive = true; p.src = k;
  }

  step(dt: number, wind: V3, groundZ: number): void {
    const f = Math.exp(-dt / DECAY);
    for (const p of this.puffs) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age > LIFE) { p.alive = false; continue; }
      p.x += (p.vx + wind.x) * dt; p.y += (p.vy + wind.y) * dt; p.z += (p.vz + wind.z) * dt;
      p.vx *= f; p.vy *= f; p.vz *= f;
      p.r += 0.9 * dt * Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz) * 0.25 + 0.05 * dt;
      // ground: the impinging jet turns into a radial wall jet and stops descending
      if (p.z < groundZ + 0.05) {
        p.z = groundZ + 0.05;
        if (p.vz < 0) {
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
}
