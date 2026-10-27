// Heightfield editing on the 16-bit grid: sculpt brushes (raise, lower, smooth, flatten, noise),
// converting any ground to a heightfield, changing its height range or resolution. Pixel (0, 0) is
// the north-west corner, as makeTerrain reads it; height = zMin + (zMax - zMin) * v / 65535.
import type { GroundDoc } from '../maps/mapDoc';
import { makeTerrain } from '../maps/mapFormat';
import { fbm } from '../maps/world';
import type { Grid } from './editorDoc';

export type HfGround = Extract<GroundDoc, { type: 'heightfield' }>;
export type BrushOp = 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise';
export type Falloff = 'smooth' | 'linear' | 'constant';
export interface Brush { op: BrushOp; radius: number; strength: number; falloff: Falloff; target?: number }
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Grid geometry of a heightfield ground: pixel <-> ENU. */
export function hfFrame(g: HfGround, grid: Grid) {
  const [ex, ey] = g.extent, [cx, cy] = g.center ?? [0, 0], x0 = cx - ex / 2, y1 = cy + ey / 2;
  return {
    x0, y1, ex, ey,
    toPx: (x: number, y: number) => [((x - x0) / ex) * (grid.w - 1), ((y1 - y) / ey) * (grid.h - 1)] as const,
    toWorld: (i: number, j: number) => [x0 + (i / (grid.w - 1)) * ex, y1 - (j / (grid.h - 1)) * ey] as const,
  };
}

const fall = (f: Falloff, d: number) => (d >= 1 ? 0 : f === 'constant' ? 1 : f === 'linear' ? 1 - d : 0.5 * (1 + Math.cos(Math.PI * d)));

/**
 * One brush step at (x, y) over dt seconds, in place. Strength: m/s for raise / lower / noise, a rate
 * (1/s) for smooth / flatten. Returns the pixels it touched, or null when the brush is off the grid.
 */
export function sculpt(grid: Grid, g: HfGround, b: Brush, x: number, y: number, dt: number): Rect | null {
  const F = hfFrame(g, grid), [u, v] = F.toPx(x, y);
  const ru = (b.radius / F.ex) * (grid.w - 1), rv = (b.radius / F.ey) * (grid.h - 1);
  const x0 = Math.max(0, Math.floor(u - ru)), x1 = Math.min(grid.w - 1, Math.ceil(u + ru));
  const y0 = Math.max(0, Math.floor(v - rv)), y1 = Math.min(grid.h - 1, Math.ceil(v + rv));
  if (x0 > x1 || y0 > y1) return null;
  const z0 = g.zMin, dz = g.zMax - g.zMin || 1, d = grid.data, W = grid.w;
  const zOf = (k: number) => z0 + (dz * d[k]) / 65535;
  const put = (k: number, z: number) => { d[k] = Math.max(0, Math.min(65535, Math.round(((z - z0) / dz) * 65535))); };
  // smoothing reads the neighbours as they were before this step
  const src = b.op === 'smooth' ? d.slice() : d;
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    const r = Math.hypot((i - u) / Math.max(ru, 1e-9), (j - v) / Math.max(rv, 1e-9)), f = fall(b.falloff, r);
    if (f <= 0) continue;
    const k = j * W + i, z = zOf(k);
    if (b.op === 'raise') put(k, z + b.strength * dt * f);
    else if (b.op === 'lower') put(k, z - b.strength * dt * f);
    else if (b.op === 'noise') { const [wx, wy] = F.toWorld(i, j); put(k, z + fbm(wx / 6, wy / 6, 3, 11) * b.strength * dt * f); }
    else {
      const a = Math.min(1, b.strength * dt * f);
      let t = b.target ?? z;
      if (b.op === 'smooth') {
        let s = 0, n = 0;
        for (let q = -1; q <= 1; q++) for (let p = -1; p <= 1; p++) {
          const ii = i + p, jj = j + q;
          if (ii >= 0 && jj >= 0 && ii < W && jj < grid.h) { s += src[jj * W + ii]; n++; }
        }
        t = z0 + (dz * s) / n / 65535;
      }
      put(k, z + (t - z) * a);
    }
  }
  return { x0, y0, x1, y1 };
}

export const unionRect = (a: Rect | null, b: Rect | null): Rect | null =>
  !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };

/** The values of a rectangle of the grid (row by row). */
export function cutRect(data: Uint16Array, W: number, r: Rect): Uint16Array {
  const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1, out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) out.set(data.subarray((r.y0 + y) * W + r.x0, (r.y0 + y) * W + r.x0 + w), y * w);
  return out;
}

/**
 * Sample any ground (flat, noise, heightfield) into a new heightfield of res x res pixels over the
 * square extent 2 * half, with headroom above and below so sculpting can raise and dig.
 */
export function toHeightfield(ground: GroundDoc | undefined, hf: { w: number; h: number; data: Float32Array } | undefined, half: number, res: number, image = 'heightfield.png'): { ground: HfGround; grid: Grid } {
  const f = makeTerrain(ground, hf), ex = 2 * half, z = new Float64Array(res * res);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const v = f(-half + (i / (res - 1)) * ex, half - (j / (res - 1)) * ex);
    z[j * res + i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  const span = Math.max(4, hi - lo), zMin = Math.floor(lo - Math.max(5, span * 0.25)), zMax = Math.ceil(hi + Math.max(10, span * 0.5));
  const data = new Uint16Array(res * res);
  for (let k = 0; k < data.length; k++) data[k] = Math.round(((z[k] - zMin) / (zMax - zMin)) * 65535);
  const common = { ...(ground?.material && { material: ground.material }), ...(ground?.visible !== undefined && { visible: ground.visible }), ...(ground?.texture && { texture: ground.texture }) };
  return { ground: { type: 'heightfield', image, extent: [ex, ex], zMin, zMax, ...common }, grid: { w: res, h: res, data } };
}

/** The same heights in a new zMin..zMax range (heights outside it are clipped). */
export function requantize(grid: Grid, from: [number, number], to: [number, number]): Grid {
  const out = new Uint16Array(grid.data.length), [a, b] = from, [c, d] = to;
  for (let k = 0; k < out.length; k++) { const z = a + ((b - a) * grid.data[k]) / 65535; out[k] = Math.max(0, Math.min(65535, Math.round(((z - c) / (d - c || 1)) * 65535))); }
  return { w: grid.w, h: grid.h, data: out };
}

/** Bilinear resample to w x h (a new resolution over the same extent). */
export function resample(grid: Grid, w: number, h: number): Grid {
  const out = new Uint16Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const u = (i / (w - 1)) * (grid.w - 1), v = (j / (h - 1)) * (grid.h - 1);
    const i0 = Math.min(grid.w - 2, Math.floor(u)), j0 = Math.min(grid.h - 2, Math.floor(v)), fu = u - i0, fv = v - j0, W = grid.w, D = grid.data;
    const a = D[j0 * W + i0], b = D[j0 * W + i0 + 1], c = D[(j0 + 1) * W + i0], e = D[(j0 + 1) * W + i0 + 1];
    out[j * w + i] = Math.round(a + (b - a) * fu + (c - a) * fv + (a - b - c + e) * fu * fv);
  }
  return { w, h, data: out };
}
