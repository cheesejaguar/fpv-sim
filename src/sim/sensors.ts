// Navigation sensors beyond the flight controller's IMU and barometer, for autonomy stacks and
// external autopilots (PX4 / ArduPilot need a compass; indoor and low-altitude navigation uses a
// downward rangefinder and an optical-flow camera):
//   - Magnetometer: the Earth's field at the GPS origin (a dipole-free local model: total field,
//     inclination, declination), rotated into the body frame, plus a per-unit hard-iron offset and
//     soft-iron scale, interference proportional to the battery current (the power leads run past
//     the compass), and noise.
//   - Rangefinder: a downward-looking time-of-flight / lidar beam along body −z, cast against the
//     map (ground and obstacles), with its range limits, a cone that loses the ground at steep tilt,
//     and noise.
//   - Optical flow: the angular flow the camera sees over the ground (PX4FLOW / PMW3901
//     convention): body-rate-compensated translational flow v / h, with surface-quality dropout
//     at low light-and-texture (constant here) and when the range is out of bounds.
// World ENU, body FLU, SI units (field in gauss = 100 µT, like MAVLink).
import { Rng, rotateInv, V3 } from './math';

export interface EarthField {
  /** total intensity (gauss) */
  total: number;
  /** inclination (deg, positive down) */
  inclinationDeg: number;
  /** declination (deg, east of true north) */
  declinationDeg: number;
}

/** Zurich (the GPS origin): ~48 µT, 63° dip, 3° E (WMM 2025). */
export const FIELD_ZURICH: EarthField = { total: 0.48, inclinationDeg: 63.3, declinationDeg: 3.2 };

/** The Earth's field vector in ENU (gauss). */
export function fieldEnu(f: EarthField): V3 {
  const inc = (f.inclinationDeg * Math.PI) / 180, dec = (f.declinationDeg * Math.PI) / 180;
  const h = f.total * Math.cos(inc);
  return { x: h * Math.sin(dec), y: h * Math.cos(dec), z: -f.total * Math.sin(inc) };
}

export class Magnetometer {
  readonly out: V3 = { x: 0, y: 0, z: 0 };
  /** per-unit hard-iron offset (gauss, body) and soft-iron scale */
  readonly hardIron: V3; readonly softIron: V3;
  /** interference per amp of battery current (gauss / A, body) */
  readonly currentCoupling: V3;
  /** extra offset (gauss, body): a fault, a nearby steel structure */
  readonly extra: V3 = { x: 0, y: 0, z: 0 };
  noiseGauss = 0.003;
  private rng: Rng;
  private readonly fEnu: V3;
  private readonly tmp: V3 = { x: 0, y: 0, z: 0 };
  constructor(field: EarthField = FIELD_ZURICH, seed = 0x3a6) {
    this.rng = new Rng(seed);
    const r = () => this.rng.next() * 2 - 1;
    this.hardIron = { x: 0.05 * r(), y: 0.05 * r(), z: 0.05 * r() };
    this.softIron = { x: 1 + 0.03 * r(), y: 1 + 0.03 * r(), z: 1 + 0.03 * r() };
    this.currentCoupling = { x: 0.0008 * r(), y: 0.0008 * r(), z: 0.0015 * r() };
    this.fEnu = fieldEnu(field);
  }
  /** q: body->world attitude; amps: battery current. */
  sample(q: { w: number; x: number; y: number; z: number }, amps: number): V3 {
    const b = rotateInv(this.tmp, q, this.fEnu);
    const o = this.out, h = this.hardIron, s = this.softIron, c = this.currentCoupling, e = this.extra, n = this.noiseGauss;
    o.x = b.x * s.x + h.x + c.x * amps + e.x + n * this.rng.gauss();
    o.y = b.y * s.y + h.y + c.y * amps + e.y + n * this.rng.gauss();
    o.z = b.z * s.z + h.z + c.z * amps + e.z + n * this.rng.gauss();
    return o;
  }
}

export interface RayWorld { raycast(origin: V3, dir: V3, maxDist: number): number }

export class Rangefinder {
  minM = 0.05; maxM = 12; noiseFrac = 0.01;
  /** beam half-angle (deg): past this tilt the return weakens; past 2x it is lost */
  halfAngleDeg = 15;
  private rng: Rng;
  private readonly dir: V3 = { x: 0, y: 0, z: 0 };
  constructor(seed = 0x7a6) { this.rng = new Rng(seed); }
  /** Distance along body −z (m), or NaN when there is no valid return. */
  sample(world: RayWorld, pos: V3, q: { w: number; x: number; y: number; z: number }): number {
    // body −z in world
    const { w, x, y, z } = q;
    const d = this.dir;
    d.x = -(2 * (x * z + w * y)); d.y = -(2 * (y * z - w * x)); d.z = -(1 - 2 * (x * x + y * y));
    const tilt = (Math.acos(Math.max(-1, Math.min(1, -d.z))) * 180) / Math.PI;
    if (tilt > 2 * this.halfAngleDeg + 30) return NaN;
    const r = world.raycast(pos, d, this.maxM + 0.5);
    if (!(r >= this.minM && r <= this.maxM)) return NaN;
    return r * (1 + this.noiseFrac * this.rng.gauss());
  }
}

export class OpticalFlow {
  /** quality 0..255 over textured ground in daylight */
  quality = 200;
  noiseRadS = 0.02;
  private rng: Rng;
  constructor(seed = 0xf10) { this.rng = new Rng(seed); }
  /**
   * Flow (rad/s about body x and y, PX4 sign convention: flow from motion, without the rotation
   * the gyro sees) at range h (m) along body −z, body velocity vb (m/s), body rates w (rad/s).
   * Returns null without a valid range.
   */
  sample(h: number, vb: V3, w: V3): { x: number; y: number; rawX: number; rawY: number; quality: number } | null {
    if (!(h > 0.08)) return null;
    // translational flow: the ground moves at −v relative to the camera; image flow about body x
    // comes from motion along body y and vice versa
    const tx = -vb.y / h, ty = vb.x / h;
    const nx = this.noiseRadS * this.rng.gauss(), ny = this.noiseRadS * this.rng.gauss();
    // the raw sensor also sees the body rotation; integrated flow minus integrated gyro = translation
    return { x: tx + nx, y: ty + ny, rawX: tx + w.x + nx, rawY: ty + w.y + ny, quality: this.quality };
  }
}
