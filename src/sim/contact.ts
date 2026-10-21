// Compliant (penalty) contact between the quad's compound sphere collider and the world.
// Normal: linear spring with Hunt–Crossley / Flores damping c = χ·k·δ, χ = 8(1−e)/(5·e·v_in), so the
// coefficient of restitution does not depend on the effective mass at the contact point; e itself drops
// with impact speed (frame flex, battery shift, shattering props soak up more of a harder hit).
// Tangential: regularised Coulomb friction plus, on soft ground, a snag / ploughing term (prop tips and
// motor bells dig into turf: extra μ and drag ∝ depth·speed) and rolling resistance. Prop-disc spheres
// include blade tip velocity so that a prop strike yanks the airframe and brakes the rotor, and they
// feed the damage model.
import { V3 } from './math';

export interface SurfaceMaterial {
  name: string; restitution: number; friction: number; stiffness: number; propDamage: number;
  snag: number;    // extra friction for prop / motor spheres digging in (soft ground)
  plough: number;  // ploughing drag, N per (m depth · m/s sliding)
  rolling: number; // rolling-resistance lever arm, fraction of the sphere radius
}

export const MATERIALS: Record<string, SurfaceMaterial> = {
  grass: { name: 'grass', restitution: 0.15, friction: 0.7, stiffness: 6e4, propDamage: 0.4, snag: 0.6, plough: 4000, rolling: 0.3 },
  dirt: { name: 'dirt', restitution: 0.2, friction: 0.65, stiffness: 1e5, propDamage: 0.6, snag: 0.45, plough: 2500, rolling: 0.25 },
  concrete: { name: 'concrete', restitution: 0.4, friction: 0.6, stiffness: 3e5, propDamage: 1.2, snag: 0, plough: 0, rolling: 0.04 },
  metal: { name: 'metal', restitution: 0.45, friction: 0.4, stiffness: 3e5, propDamage: 1.4, snag: 0, plough: 0, rolling: 0.03 },
  wood: { name: 'wood', restitution: 0.35, friction: 0.55, stiffness: 2e5, propDamage: 0.9, snag: 0, plough: 0, rolling: 0.05 },
  // tree canopies are drag volumes (CollisionWorld.foliage); this is for thin solids (safety nets, flags)
  foliage: { name: 'foliage', restitution: 0.05, friction: 0.9, stiffness: 1.5e3, propDamage: 0.15, snag: 0.3, plough: 0, rolling: 0.3 },
  // padded PVC / aluminium gate frame: gives a little, then stops (or deflects) the quad
  gate: { name: 'gate', restitution: 0.3, friction: 0.5, stiffness: 2e5, propDamage: 0.5, snag: 0, plough: 0, rolling: 0.08 },
};

/** Effective restitution for an impact at approach speed v (m/s): e0 up to 4 m/s, then ∝ 1/√v. */
export const restitutionAt = (m: SurfaceMaterial, v: number) => m.restitution * Math.min(1, Math.sqrt(4 / Math.max(v, 1e-3)));

export interface ContactHit { depth: number; nx: number; ny: number; nz: number; material: SurfaceMaterial }

export interface CollisionWorld {
  /** Penetration query for a sphere (world position, radius). Return true if penetrating. */
  sphere(p: V3, radius: number, out: ContactHit): boolean;
  /** Depth (m) of p inside a porous drag volume (tree canopy, hedge); 0 outside. */
  foliage?(p: V3): number;
  /** Distance from p along unit dir to the first surface, or Infinity. */
  raycast(p: V3, dir: V3, maxDist: number): number;
  groundHeight(x: number, y: number): number;
}

/** Flat infinite ground plane at z = 0 (used for tests and as the base of every map). */
export class GroundPlane implements CollisionWorld {
  constructor(public material: SurfaceMaterial = MATERIALS.grass, public z0 = 0) {}
  sphere(p: V3, r: number, o: ContactHit): boolean {
    const d = r - (p.z - this.z0);
    if (d <= 0) return false;
    o.depth = d; o.nx = 0; o.ny = 0; o.nz = 1; o.material = this.material; return true;
  }
  raycast(p: V3, dir: V3, maxDist: number): number {
    if (dir.z >= -1e-6) return Infinity;
    const t = (this.z0 - p.z) / dir.z;
    return t >= 0 && t <= maxDist ? t : Infinity;
  }
  groundHeight(): number { return this.z0; }
}

/** 'arm' = arm tube between the stack and a motor (rotor = that motor). */
export type ColliderKind = 'frame' | 'prop' | 'camera' | 'battery' | 'motor' | 'arm';
/** rotor: owning rotor for prop / motor / arm spheres, -1 otherwise. */
export interface ColliderSphere { pos: V3; radius: number; kind: ColliderKind; rotor: number }
