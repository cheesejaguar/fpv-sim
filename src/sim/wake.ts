// Lagrangian rotor-wake model. Each rotor periodically sheds a "puff" carrying the far-wake
// velocity (~2·v_i along -thrust axis). Puffs convect with their own velocity plus the wind, spread,
// and decay. Rotors sample the puff field: flying back down (or flipping) into your own wash
// raises the local downflow and turbulence each rotor sees -> asymmetric, unsteady thrust that the
// PID loop has to fight: prop wash.
import { V3 } from './math';

interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number; age: number; alive: boolean }

const MAX = 256;
const LIFE = 1.2;     // s
const DECAY = 0.45;   // s velocity e-fold
const EMIT_DT = 0.012;

export class WakeField {
  puffs: Puff[] = [];
  private head = 0;
  private emitAcc: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  enabled = true;
  constructor() {
    for (let i = 0; i < MAX; i++) this.puffs.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0, age: 0, alive: false });
  }
  reset() { for (const p of this.puffs) p.alive = false; }

  /** Rotor k at world pos emits wake with velocity (world) when enough time has elapsed. */
  emit(k: number, pos: V3, wakeVel: V3, radius: number, dt: number): void {
    if (!this.enabled) return;
    this.emitAcc[k] += dt;
    if (this.emitAcc[k] < EMIT_DT) return;
    this.emitAcc[k] = 0;
    const p = this.puffs[this.head];
    this.head = (this.head + 1) % MAX;
    p.x = pos.x; p.y = pos.y; p.z = pos.z;
    p.vx = wakeVel.x; p.vy = wakeVel.y; p.vz = wakeVel.z;
    p.r = radius; p.age = 0; p.alive = true;
  }

  step(dt: number, wind: V3, groundZ: number): void {
    const f = Math.exp(-dt / DECAY);
    for (const p of this.puffs) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age > LIFE) { p.alive = false; continue; }
      p.x += (p.vx + wind.x) * dt; p.y += (p.vy + wind.y) * dt; p.z += (p.vz + wind.z) * dt;
      p.vx *= f; p.vy *= f; p.vz *= f;
      p.r += 0.9 * dt * Math.hypot(p.vx, p.vy, p.vz) * 0.25 + 0.05 * dt;
      // ground: wake spreads radially and stops descending
      if (p.z < groundZ + 0.05) { p.z = groundZ + 0.05; p.vx += p.vz * 0.3; p.vz = 0; }
    }
  }

  /**
   * Sample induced air velocity and a turbulence measure at a world point. Puffs younger than
   * `minAge` are ignored (a rotor never sees its own just-shed wake directly beneath it).
   */
  sample(pos: V3, o: V3, minAge = 0.06): number {
    o.x = 0; o.y = 0; o.z = 0;
    let turb = 0;
    for (const p of this.puffs) {
      if (!p.alive || p.age < minAge) continue;
      const dx = pos.x - p.x, dy = pos.y - p.y, dz = pos.z - p.z;
      const r2 = p.r * p.r * 2.25;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const w = 1 - d2 / r2;
      const k = w * w;
      o.x += p.vx * k; o.y += p.vy * k; o.z += p.vz * k;
      turb += Math.hypot(p.vx, p.vy, p.vz) * k;
    }
    return turb;
  }
}
