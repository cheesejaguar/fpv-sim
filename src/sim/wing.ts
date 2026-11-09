// Lifting surfaces of a fixed-wing airframe: each wing half, tailplane half, V-tail half and fin is a
// surface at its own aerodynamic centre, with its own airflow (the vehicle's velocity through the
// air plus the rotation's w x r, so roll, pitch and yaw damping come out of the geometry), the wing's
// downwash on the tail, and a tractor prop's slipstream on the surfaces behind it. Body frame FLU.
//
// Per surface, in its own chord-normal plane (the spanwise flow is ignored apart from a crossflow
// drag):
//   alpha = atan2(-u.n, u.c), with u the surface's velocity through the air
//   attached: CL = CL0 + a (alpha + tau delta), a = 2 pi AR / (2 + sqrt(AR^2 + 4)) (Helmholtz's
//     lifting-line fit), CD = CD0 + CL^2 / (pi e AR) + 0.7 (tau delta)^2
//   separated: a flat plate, CL = 2 sin(alpha_e) cos(alpha_e), CD = CD0 + 2 sin^2(alpha_e) (alpha_e
//     includes the deflection), blended in by Beard & McLain's sigmoid around the stall angle
//     (Small Unmanned Aircraft, 2012, eq. 4.9), so a stalled wing keeps flying as a plate does
//   CM about the aerodynamic centre: CM0 - 0.7 tau delta (a trailing-edge flap pitches nose down: its
//     lift acts well behind the quarter chord; thin-aerofoil theory gives dCM/d(delta) = -0.5 sin(t)
//     (1 - cos(t)), cos(t) = 2 cf - 1, about -1.07 tau for a 20-35 % chord flap, and real flaps reach
//     ~2/3 of it (Abbott & von Doenhoff 1959, ch. 8)); a flying wing's elevons pitch it mostly this way
// The deflection delta comes from the surface's servo, which follows its command at a slew rate.
import type { V3 } from './math';

export interface SurfaceControl {
  /** servo output (ArduPilot SERVOn - 1) that drives it */
  channel: number;
  /** flap effectiveness: the change in zero-lift angle per radian of deflection (~0.5 for a 25 % chord surface) */
  tau: number;
  /** throw each way (deg) at PWM 1000 / 2000 */
  maxDeg: number;
  /** +1: PWM above 1500 deflects the trailing edge toward -normal (more lift); -1 the other way */
  sign: 1 | -1;
}

export interface SurfaceConfig {
  name: string;
  /** aerodynamic centre (quarter chord) relative to the CG, body FLU (m) */
  pos: V3;
  /** unit lift direction at zero angle of attack (body): a wing's up, tilted by its dihedral; a fin's +y */
  normal: V3;
  /** unit chord direction toward the leading edge (body; usually +x) */
  chord: V3;
  /** planform area of this surface (m^2) and its mean chord (m) */
  area: number;
  mac: number;
  /** effective aspect ratio of the lifting surface it belongs to (a wing half: the whole wing's) */
  aspect: number;
  /** lift at zero angle (camber + incidence), parasite drag, pitching moment */
  cl0: number;
  cd0: number;
  cm0: number;
  /** angle (deg) at which the attached flow gives way */
  stallDeg: number;
  /** Oswald span efficiency */
  oswald: number;
  control?: SurfaceControl;
  /** the wing surface whose downwash this one sits in, and d(epsilon)/d(CL_wing) (rad per unit CL) */
  downwash?: { from: number; perCl: number };
  /** the share of the surface that sits in a rotor's slipstream */
  slipstream?: { rotor: number; frac: number };
}

export interface SurfaceOut {
  /** force and its moment about the CG (body, N and N m) */
  fx: number; fy: number; fz: number;
  mx: number; my: number; mz: number;
  alpha: number;
  cl: number;
  /** dynamic pressure (Pa) */
  q: number;
}

export const emptySurfaceOut = (): SurfaceOut => ({ fx: 0, fy: 0, fz: 0, mx: 0, my: 0, mz: 0, alpha: 0, cl: 0, q: 0 });

/** Lift-curve slope (per rad) of a finite wing of aspect ratio AR (Helmholtz). */
export const liftSlope = (ar: number) => (2 * Math.PI * ar) / (2 + Math.sqrt(ar * ar + 4));

/** Beard & McLain's stall blend: 0 attached, 1 separated, around +/- a0 with sharpness M. */
export function stallBlend(alpha: number, a0: number, M = 40): number {
  const ep = Math.exp(-M * (alpha - a0)), em = Math.exp(M * (alpha + a0));
  if (!Number.isFinite(ep) || !Number.isFinite(em)) return 1;
  return (1 + ep + em) / ((1 + ep) * (1 + em));
}

/**
 * Coefficients at angle of attack alpha (rad, any value) with control deflection delta (rad):
 * attached flow blended into a flat plate past the stall.
 */
export function coefficients(sc: SurfaceConfig, alpha: number, delta: number): { cl: number; cd: number; cm: number } {
  const tau = sc.control?.tau ?? 0, d = tau * delta;
  const a = liftSlope(sc.aspect), s = stallBlend(alpha, (sc.stallDeg * Math.PI) / 180);
  // the attached polar only means something for flow from the leading edge (|alpha| < 90 deg)
  const aw = Math.atan2(Math.sin(alpha), Math.abs(Math.cos(alpha)));
  const clAtt = sc.cl0 + a * (aw + d);
  const cdAtt = sc.cd0 + (clAtt * clAtt) / (Math.PI * sc.oswald * sc.aspect) + 0.7 * d * d;
  const ae = alpha + d;
  const clPlate = 2 * Math.sin(ae) * Math.cos(ae), cdPlate = sc.cd0 + 2 * Math.sin(ae) * Math.sin(ae);
  // stalled: a flat plate's normal force (≈ 2 sin α) acts from a centre of pressure moving from the
  // quarter chord back to mid-chord at 90° (x_cp ≈ 0.25 + 0.25 |sin α|), i.e. cm(c/4) = -0.5 sin α |sin α|
  // (it was a quarter of that at 90°: stall recovery was far too weak)
  const sa = Math.sin(ae);
  return { cl: (1 - s) * clAtt + s * clPlate, cd: (1 - s) * cdAtt + s * cdPlate, cm: (1 - s) * (sc.cm0 - 0.7 * d) - s * 0.5 * sa * Math.abs(sa) };
}

/**
 * Force and moment (about the CG) of one surface. u: the surface's velocity through the air (body,
 * m/s), already including w x r, wind, downwash and slipstream; delta: control deflection (rad).
 */
export function evaluateSurface(sc: SurfaceConfig, u: V3, rho: number, delta: number, out: SurfaceOut): SurfaceOut {
  const n = sc.normal, c = sc.chord;
  const uc = u.x * c.x + u.y * c.y + u.z * c.z, un = u.x * n.x + u.y * n.y + u.z * n.z;
  const V2 = uc * uc + un * un;
  out.fx = out.fy = out.fz = out.mx = out.my = out.mz = 0;
  out.alpha = 0; out.cl = 0; out.q = 0;
  // span direction (normal x chord); the spanwise flow only drags (a flat side seen edge-on)
  const sx = n.y * c.z - n.z * c.y, sy = n.z * c.x - n.x * c.z, sz = n.x * c.y - n.y * c.x;
  const us = u.x * sx + u.y * sy + u.z * sz;
  if (V2 < 1e-6 && Math.abs(us) < 1e-3) return out;
  const alpha = Math.atan2(-un, uc), q = 0.5 * rho * V2;
  const k = coefficients(sc, alpha, delta), V = Math.sqrt(V2);
  // drag along -u (in the chord-normal plane), lift perpendicular to it toward +normal at positive alpha
  let fx = 0, fy = 0, fz = 0;
  if (V > 1e-6) {
    const ex = (uc * c.x + un * n.x) / V, ey = (uc * c.y + un * n.y) / V, ez = (uc * c.z + un * n.z) / V; // unit airflow-relative velocity
    // lift direction: the in-plane unit vector perpendicular to the velocity, on the +normal side when moving forward
    const lx = (uc * n.x - un * c.x) / V, ly = (uc * n.y - un * c.y) / V, lz = (uc * n.z - un * c.z) / V;
    const L = q * sc.area * k.cl, D = q * sc.area * k.cd;
    fx = L * lx - D * ex; fy = L * ly - D * ey; fz = L * lz - D * ez;
  }
  // spanwise flow meets the surface edge-on: a small drag
  const cross = -0.5 * rho * Math.abs(us) * us * sc.area * 0.02;
  fx += cross * sx; fy += cross * sy; fz += cross * sz;
  // pitching moment about the aerodynamic centre: a positive CM raises the leading edge, a rotation
  // about -span (span = normal x chord: +y, the left, for a wing; nose up in FLU is about -y)
  const M = q * sc.area * sc.mac * k.cm;
  const p = sc.pos;
  out.fx = fx; out.fy = fy; out.fz = fz;
  out.mx = p.y * fz - p.z * fy - M * sx;
  out.my = p.z * fx - p.x * fz - M * sy;
  out.mz = p.x * fy - p.y * fx - M * sz;
  out.alpha = alpha; out.cl = k.cl; out.q = q;
  return out;
}
