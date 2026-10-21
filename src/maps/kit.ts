// Small geometry helpers shared by the training maps (whoop gym, park, practice field, mountains,
// night course): boxes / cylinders, long runs cut into short pieces (collision cells stay small),
// hoops made of straight tube segments, and course tables -> GateDefs.
import type { V3 } from '../sim/math';
import type { BoxPrim, CylPrim, GateDef, Prim } from './world';

export const deg = Math.PI / 180;

/** GateDef yaw for a travel heading in degrees CCW from east (the convention of the course tables). */
export const headingYaw = (headingDeg: number) => (headingDeg - 90) * deg;

export type BoxRest = Partial<Omit<BoxPrim, 'kind' | 'c' | 'half' | 'yaw'>>;
export type CylRest = Partial<Omit<CylPrim, 'kind' | 'c' | 'r' | 'h'>>;

/** Box by centre and half extents (default: concrete). */
export function box(list: Prim[], x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0, rest: BoxRest = {}) {
  list.push({ kind: 'box', c: { x, y, z }, half: { x: hx, y: hy, z: hz }, yaw, mat: 'concrete', visual: 'concrete', ...rest } as BoxPrim);
}

/** Box between two corners (axis aligned). */
export function slab(list: Prim[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, rest: BoxRest = {}) {
  box(list, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2, 0, rest);
}

/**
 * Axis-aligned slab cut into tiles of at most `piece` m a side (and `pieceZ` m tall), so no collision
 * cell lists a box whose bounding sphere reaches far beyond the box.
 */
export function tiles(list: Prim[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, rest: BoxRest = {}, piece = 4, pieceZ = Infinity) {
  const nx = Math.max(1, Math.ceil(Math.abs(x1 - x0) / piece)), ny = Math.max(1, Math.ceil(Math.abs(y1 - y0) / piece)), nz = Math.max(1, Math.ceil(Math.abs(z1 - z0) / pieceZ));
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    slab(list, x0 + ((x1 - x0) * i) / nx, y0 + ((y1 - y0) * j) / ny, z0 + ((z1 - z0) * k) / nz, x0 + ((x1 - x0) * (i + 1)) / nx, y0 + ((y1 - y0) * (j + 1)) / ny, z0 + ((z1 - z0) * (k + 1)) / nz, rest);
  }
}

/** Vertical cylinder standing on (x, y, z) (default: metal). */
export function cyl(list: Prim[], x: number, y: number, z: number, r: number, h: number, rest: CylRest = {}) {
  list.push({ kind: 'cyl', c: { x, y, z }, r, h, mat: 'metal', ...rest } as CylPrim);
}

/**
 * Vertical hoop of n straight tube segments (like the arch heads in gates.ts): centre c, plane across
 * the travel direction of `yaw` (GateDef convention), inner radius r, tube half thickness t.
 */
export function hoop(list: Prim[], c: V3, yaw: number, r: number, t: number, rest: BoxRest = {}, n = 16) {
  const co = Math.cos(yaw), si = Math.sin(yaw), R = r + t, dth = (2 * Math.PI) / n;
  for (let i = 0; i < n; i++) {
    const th = (i + 0.5) * dth, lx = R * Math.cos(th);
    list.push({
      kind: 'box', c: { x: c.x + co * lx, y: c.y + si * lx, z: c.z + R * Math.sin(th) }, half: { x: (R + t) * Math.tan(dth / 2), y: t, z: t },
      yaw, pitch: -(th + Math.PI / 2), mat: 'gate', visual: 'gate', ...rest,
    } as BoxPrim);
  }
}

/** Horizontal ring (a basketball rim): centre c, inner radius r, tube half thickness t. */
export function rim(list: Prim[], c: V3, r: number, t: number, rest: BoxRest = {}, n = 12) {
  const R = r + t, dth = (2 * Math.PI) / n;
  for (let i = 0; i < n; i++) {
    const th = (i + 0.5) * dth;
    list.push({ kind: 'box', c: { x: c.x + R * Math.cos(th), y: c.y + R * Math.sin(th), z: c.z }, half: { x: (R + t) * Math.tan(dth / 2), y: t, z: t }, yaw: th + Math.PI / 2, mat: 'metal', visual: 'plain', ...rest } as BoxPrim);
  }
}

/** Box from a to b (a sloped beam, rail or stringer), cross-section half sizes hy (sideways) x hz (up). */
export function beam(list: Prim[], a: V3, b: V3, hy: number, hz: number, rest: BoxRest = {}) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz), Lh = Math.hypot(dx, dy);
  // collision frame: yaw about z, then pitch about local y; local +x = (cos p, 0, -sin p) in the yawed frame
  list.push({ kind: 'box', c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }, half: { x: L / 2, y: hy, z: hz }, yaw: Math.atan2(dy, dx), pitch: -Math.atan2(dz, Lh), mat: 'metal', visual: 'metal', ...rest } as BoxPrim);
}

/** A course row: x, y, travel heading (deg CCW from east), kind, opening base height, size, extras. */
export type CourseLeg = [number, number, number, GateDef['kind'], number, number, number, Partial<GateDef>?];

/** Course table -> GateDefs with ids from `firstId`. */
export function courseGates(legs: CourseLeg[], firstId = 0): GateDef[] {
  return legs.map(([x, y, hd, kind, z, width, height, extra], i) => ({ id: firstId + i, c: { x, y, z }, yaw: headingYaw(hd), kind, width, height, ...extra }));
}

/** Closed Catmull-Rom spline through P (starting just before P[0]), sampled every ~`step` m, `laps` times round. */
export function closedSpline(P: [number, number, number][], laps = 1, step = 0.02): V3[] {
  const n = P.length, out: V3[] = [];
  for (let j = 0; j < laps * n; j++) {
    const i = (j + n - 1) % n;
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n], p3 = P[(i + 2) % n];
    const steps = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) / step));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const f = (a: number) => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3);
      out.push({ x: f(0), y: f(1), z: f(2) });
    }
  }
  return out;
}

/**
 * Bake a height function into a square grid (half extent `half`, spacing `step`, Float32) and return
 * the bilinear lookup: every terrain query becomes a table read instead of a noise evaluation.
 * Outside the grid the edge heights extend outwards. Deterministic, so worker and renderer agree.
 */
export function bakeHeightfield(fn: (x: number, y: number) => number, half: number, step: number): (x: number, y: number) => number {
  const N = Math.round((2 * half) / step) + 1, X0 = -half, g = new Float32Array(N * N), max = N - 1 - 1e-9;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) g[j * N + i] = fn(X0 + i * step, X0 + j * step);
  return (x: number, y: number) => {
    let u = (x - X0) / step, v = (y - X0) / step;
    u = u < 0 ? 0 : u > max ? max : u; v = v < 0 ? 0 : v > max ? max : v;
    const i = u | 0, j = v | 0, fu = u - i, fv = v - j, k = j * N + i;
    const a = g[k], b = g[k + 1], c = g[k + N], e = g[k + N + 1];
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + e) * fu * fv;
  };
}
