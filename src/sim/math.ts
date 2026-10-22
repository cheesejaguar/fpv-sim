// Minimal allocation-light vector / quaternion math for the 8 kHz physics loop.
// World frame: ENU (x east, y north, z up). Body frame: FLU (x forward, y left, z up).

export type V3 = { x: number; y: number; z: number };
export type Quat = { w: number; x: number; y: number; z: number };

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const quat = (w = 1, x = 0, y = 0, z = 0): Quat => ({ w, x, y, z });

export function set(o: V3, x: number, y: number, z: number): V3 { o.x = x; o.y = y; o.z = z; return o; }
export function copy(o: V3, a: V3): V3 { o.x = a.x; o.y = a.y; o.z = a.z; return o; }
export function add(o: V3, a: V3, b: V3): V3 { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; }
export function sub(o: V3, a: V3, b: V3): V3 { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; }
export function scale(o: V3, a: V3, s: number): V3 { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; }
export function addScaled(o: V3, a: V3, b: V3, s: number): V3 { o.x = a.x + b.x * s; o.y = a.y + b.y * s; o.z = a.z + b.z * s; return o; }
export function dot(a: V3, b: V3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function cross(o: V3, a: V3, b: V3): V3 {
  const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
  o.x = x; o.y = y; o.z = z; return o;
}
export function len(a: V3): number { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
export function normalize(o: V3, a: V3): V3 { const l = len(a); return l > 1e-12 ? scale(o, a, 1 / l) : set(o, 0, 0, 0); }

/** Rotate v by q (body -> world when q is body-to-world). */
export function rotate(o: V3, q: Quat, v: V3): V3 {
  const { w, x, y, z } = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
  const rx = v.x + w * tx + (y * tz - z * ty);
  const ry = v.y + w * ty + (z * tx - x * tz);
  const rz = v.z + w * tz + (x * ty - y * tx);
  o.x = rx; o.y = ry; o.z = rz; return o;
}
/** Rotate v by conjugate(q) (world -> body). */
export function rotateInv(o: V3, q: Quat, v: V3): V3 {
  const w = q.w, x = -q.x, y = -q.y, z = -q.z;
  const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
  const rx = v.x + w * tx + (y * tz - z * ty);
  const ry = v.y + w * ty + (z * tx - x * tz);
  const rz = v.z + w * tz + (x * ty - y * tx);
  o.x = rx; o.y = ry; o.z = rz; return o;
}
export function qmul(o: Quat, a: Quat, b: Quat): Quat {
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  o.w = w; o.x = x; o.y = y; o.z = z; return o;
}
export function qnormalize(q: Quat): Quat {
  const l = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z) || 1;
  q.w /= l; q.x /= l; q.y /= l; q.z /= l; return q;
}
/** Integrate body-frame angular velocity w over dt (exact exponential map). */
export function qintegrate(q: Quat, w: V3, dt: number): Quat {
  const wx = w.x * dt, wy = w.y * dt, wz = w.z * dt;
  const th = Math.sqrt(wx * wx + wy * wy + wz * wz);
  let s: number, c: number;
  if (th < 1e-9) { s = 0.5; c = 1; } else { s = Math.sin(th / 2) / th; c = Math.cos(th / 2); }
  // q = q * (c, w·s): qmul without a temporary quaternion
  const bx = wx * s, by = wy * s, bz = wz * s;
  const rw = q.w * c - q.x * bx - q.y * by - q.z * bz;
  const rx = q.w * bx + q.x * c + q.y * bz - q.z * by;
  const ry = q.w * by - q.x * bz + q.y * c + q.z * bx;
  const rz = q.w * bz + q.x * by - q.y * bx + q.z * c;
  q.w = rw; q.x = rx; q.y = ry; q.z = rz;
  return qnormalize(q);
}
export function qFromAxisAngle(ax: number, ay: number, az: number, ang: number): Quat {
  const s = Math.sin(ang / 2), l = Math.hypot(ax, ay, az) || 1;
  return { w: Math.cos(ang / 2), x: (ax / l) * s, y: (ay / l) * s, z: (az / l) * s };
}
/** Yaw (about world z) then pitch (about body y) then roll (body x). Angles in rad. */
export function qFromEuler(roll: number, pitch: number, yaw: number): Quat {
  const qz = qFromAxisAngle(0, 0, 1, yaw), qy = qFromAxisAngle(0, 1, 0, pitch), qx = qFromAxisAngle(1, 0, 0, roll);
  const o = quat(); qmul(o, qz, qy); qmul(o, o, qx); return o;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Seeded PRNG (mulberry32) + Gaussian, so runs are reproducible. */
export class Rng {
  private s: number;
  // the second normal of the last pair (a plain number field: storing a double into a `number | null`
  // field boxes it on every store)
  private spare = 0; private hasSpare = false;
  constructor(seed = 0x9e3779b9) { this.s = seed >>> 0; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss(): number {
    if (this.hasSpare) { this.hasSpare = false; return this.spare; }
    let u = 0, v = 0, r = 0;
    do { u = this.next() * 2 - 1; v = this.next() * 2 - 1; r = u * u + v * v; } while (r >= 1 || r === 0);
    const m = Math.sqrt((-2 * Math.log(r)) / r);
    this.spare = v * m; this.hasSpare = true; return u * m;
  }
}

/** Fritsch–Carlson monotone cubic interpolant over sorted xs. */
export function monotoneCubic(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const d: number[] = [], m: number[] = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] > x) hi = mid; else lo = mid; }
    const h = xs[hi] - xs[lo], t = (x - xs[lo]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi];
  };
}
