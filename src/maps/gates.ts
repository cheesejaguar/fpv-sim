// Race gates: geometry (exact collision primitives) and pass detection, shared by every map, the
// physics worker (lap timing) and the renderer (gate tags drive the next-gate highlight).
//
// Every primitive of gate N is tagged `gate<N>` so the renderer can draw (and light up) each gate
// on its own. Frames are 12 cm padded tube like real competition gates.
import type { V3 } from '../sim/math';
import type { BoxPrim, GateDef, Prim } from './world';

/** Half thickness of a gate frame tube. */
export const GATE_T = 0.06;
/** Height of the banner panel above a hurdle's opening. */
export const HURDLE_BANNER = 0.7;

type Ground = (x: number, y: number) => number;

function frame(g: GateDef) {
  const c = Math.cos(g.yaw), s = Math.sin(g.yaw);
  // local frame: x = across the opening, y = direction of travel, z = up
  const at = (lx: number, ly: number, z: number): V3 => ({ x: g.c.x + c * lx - s * ly, y: g.c.y + s * lx + c * ly, z });
  const base: Omit<BoxPrim, 'c' | 'half'> = { kind: 'box', yaw: g.yaw, mat: 'gate', visual: 'gate', tag: `gate${g.id}` };
  return { at, base };
}

/** Upright gates: square / tower (opening above the ground on legs), arch, hurdle, ladder. */
function uprightGate(g: GateDef, prims: Prim[], gz: number) {
  const T = g.tube ?? GATE_T, w = g.width, h = g.height;
  const { at, base } = frame(g);
  const z0 = g.c.z, top = z0 + h;
  const post = (lx: number, zb: number, zt: number) => prims.push({ ...base, c: at(lx, 0, (zb + zt) / 2), half: { x: T, y: T, z: (zt - zb) / 2 } });
  const bar = (zc: number) => prims.push({ ...base, c: at(0, 0, zc), half: { x: w / 2 + 2 * T, y: T, z: T } });
  const foot = g.onTop ? z0 : gz;
  // lowest opening of the structure: ladders stack `stack` openings, the counted one on top
  const n = g.kind === 'ladder' ? Math.max(1, g.stack ?? 3) : 1;
  const bottom = z0 - (n - 1) * (h + 2 * T);
  if (g.kind === 'arch') {
    // posts up to the springing line, then a semicircular head of short tangent segments
    const r = w / 2 + T, spring = top - w / 2, N = 9, dth = Math.PI / N;
    post(-r, foot, spring); post(r, foot, spring);
    for (let i = 0; i < N; i++) {
      const th = (i + 0.5) * dth;
      prims.push({ ...base, c: at(r * Math.cos(th), 0, spring + r * Math.sin(th)), half: { x: (r + T) * Math.tan(dth / 2), y: T, z: T }, pitch: -(th + Math.PI / 2) });
    }
  } else if (g.kind === 'hurdle') {
    post(-(w / 2 + T), foot, top + HURDLE_BANNER); post(w / 2 + T, foot, top + HURDLE_BANNER);
    prims.push({ ...base, c: at(0, 0, top + HURDLE_BANNER / 2), half: { x: w / 2, y: 0.03, z: HURDLE_BANNER / 2 } });
    return; // nothing at the bottom: the opening is the air under the banner
  } else {
    post(-(w / 2 + T), foot, top + 2 * T); post(w / 2 + T, foot, top + 2 * T);
    bar(top + T);
    for (let k = 1; k < n; k++) bar(bottom + k * (h + 2 * T) - T); // dividers between ladder openings
  }
  if (g.onTop) return;
  if (bottom - gz > 0.12) bar(bottom - T);
  else prims.push({ ...base, visual: 'metal', mat: 'metal', c: at(0, 0, gz + 0.02), half: { x: w / 2 + 2 * T, y: g.tube === undefined ? 0.25 : 6 * T, z: 0.02 } }); // weighted base plate
}

function diveGate(g: GateDef, prims: Prim[], gz: number) {
  // horizontal square frame on four legs: fly down through it
  const T = g.tube ?? GATE_T, w = g.width, z = g.c.z;
  const { at, base } = frame(g);
  const e = w / 2 + T;
  prims.push({ ...base, c: at(0, -e, z), half: { x: e + T, y: T, z: T } });
  prims.push({ ...base, c: at(0, e, z), half: { x: e + T, y: T, z: T } });
  prims.push({ ...base, c: at(-e, 0, z), half: { x: T, y: w / 2, z: T } });
  prims.push({ ...base, c: at(e, 0, z), half: { x: T, y: w / 2, z: T } });
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) prims.push({ kind: 'cyl', c: at(sx * e, sy * e, gz), r: Math.min(0.04, T * 0.8), h: z - T - gz, mat: 'metal', tag: `gate${g.id}` });
}

/**
 * Feather-flag banner (m, and fractions of the flag height): centred `back` behind the pole, `halfLen`
 * long each way along the direction of travel, `thick` thin, centred at zc·height, hz·height tall
 * each way. Collision is this thin box; the renderer draws it as waving cloth (isFlagBanner).
 */
export const FLAG = { back: 0.34, halfLen: 0.3, thick: 0.015, zc: 0.6, hz: 0.33 } as const;

function flag(g: GateDef, prims: Prim[], gz: number) {
  // feather flag: pole plus a tall banner trailing behind it along the direction of travel
  const { at, base } = frame(g);
  prims.push({ kind: 'cyl', c: { x: g.c.x, y: g.c.y, z: gz }, r: 0.035, h: g.height, mat: 'gate', tag: `gate${g.id}` });
  prims.push({ ...base, mat: 'foliage', c: at(0, -FLAG.back, gz + g.height * FLAG.zc), half: { x: FLAG.thick, y: FLAG.halfLen, z: g.height * FLAG.hz } });
}

/** A flag gate's banner box (the only foliage-material gate part). */
export const isFlagBanner = (p: Prim): p is BoxPrim => p.kind === 'box' && p.mat === 'foliage' && gateIdOf(p.tag) >= 0;

/** Append the collision / render primitives of every gate. ground = floor height (default 0). */
export function buildGatePrims(gates: GateDef[], prims: Prim[], ground: Ground = () => 0) {
  for (const g of gates) {
    const gz = ground(g.c.x, g.c.y);
    if (g.kind === 'dive') diveGate(g, prims, gz);
    else if (g.kind === 'flag') flag(g, prims, gz);
    else uprightGate(g, prims, gz);
  }
}

/** Gate index a primitive belongs to (from its `gate<N>` tag), or -1. */
export function gateIdOf(tag: string | undefined): number {
  const m = /^gate(\d+)$/.exec(tag ?? '');
  return m ? +m[1] : -1;
}

// ---------------------------------------------------------------------------------------------
// Pass detection

/** Is the point (lat across the opening, z) inside the clear opening of an upright gate? */
export function inOpening(g: GateDef, lat: number, z: number): boolean {
  const w = g.width, h = g.height, dz = z - g.c.z;
  if (Math.abs(lat) >= w / 2 || dz <= 0 || dz >= h) return false;
  if (g.kind !== 'arch') return true;
  const spring = h - w / 2; // round head: inside the semicircle above the springing line
  return dz <= spring || Math.hypot(lat, dz - spring) < w / 2;
}

/** Centre of the counted opening (dive: frame centre; flag: beside the pole at 1.5 m). */
export function openingCentre(g: GateDef): V3 {
  if (g.kind === 'dive') return { ...g.c };
  if (g.kind === 'flag') return { x: g.c.x, y: g.c.y, z: g.c.z + 1.5 };
  const h = g.kind === 'arch' ? Math.min(g.height, g.height - g.width / 2 + 0.5) : g.height;
  return { x: g.c.x, y: g.c.y, z: g.c.z + h / 2 };
}

/**
 * Did the segment a -> b (consecutive positions) pass the gate the right way?
 * Upright gates: cross the opening plane forwards inside the opening. Dive: cross the frame plane
 * downwards inside the frame. Flag: go round it, i.e. cross the line through the pole
 * (perpendicular to travel) forwards, within 6 m of it.
 */
export function gatePassed(g: GateDef, a: V3, b: V3): boolean {
  if (g.kind === 'dive') {
    if (!(a.z > g.c.z && b.z <= g.c.z)) return false;
    const u = (a.z - g.c.z) / (a.z - b.z);
    const x = a.x + (b.x - a.x) * u - g.c.x, y = a.y + (b.y - a.y) * u - g.c.y;
    const c = Math.cos(g.yaw), s = Math.sin(g.yaw);
    return Math.abs(c * x + s * y) < g.width / 2 && Math.abs(-s * x + c * y) < g.width / 2;
  }
  const nx = -Math.sin(g.yaw), ny = Math.cos(g.yaw);
  const d0 = (a.x - g.c.x) * nx + (a.y - g.c.y) * ny, d1 = (b.x - g.c.x) * nx + (b.y - g.c.y) * ny;
  if (!(d0 < 0 && d1 >= 0)) return false;
  if (g.kind === 'flag') return Math.hypot(b.x - g.c.x, b.y - g.c.y) < 6;
  const u = d0 / (d0 - d1);
  const ix = a.x + (b.x - a.x) * u, iy = a.y + (b.y - a.y) * u, iz = a.z + (b.z - a.z) * u;
  const lat = (ix - g.c.x) * Math.cos(g.yaw) + (iy - g.c.y) * Math.sin(g.yaw);
  return inOpening(g, lat, iz);
}
