// Parametric prefabs: ramps, rails, bando shells, a skate bowl, a light tower … Each expands to
// plain primitives (and lights) in its own frame (+x forward, origin on the ground, z up), is then
// placed and turned, and its parts carry "x-group" so the editor selects, moves and re-parameterises
// them together (map.json "x-builder".groups keeps the prefab and its parameters).
import { hoop } from '../maps/kit';
import type { LightDoc, PrimDoc, Vec3 } from '../maps/mapDoc';
import type { Prim } from '../maps/world';

export type GroupedPrim = PrimDoc & { 'x-group'?: string };
export type GroupedLight = LightDoc & { 'x-group'?: string };
export interface PrefabParam { key: string; label: string; min: number; max: number; step: number; def: number; unit?: string }
export interface Prefab {
  id: string; name: string; blurb: string;
  tab: 'race' | 'freestyle';
  params: PrefabParam[];
  build(p: Record<string, number>): { prims: PrimDoc[]; lights?: LightDoc[] };
}

const deg = Math.PI / 180;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;
/** Pitch in -90..90: a box turned 180° about its own y axis is the same box. */
const normPitch = (p: number) => { let x = ((p % 180) + 180) % 180; if (x > 90) x -= 180; return x; };

type Rest = Partial<Pick<Extract<PrimDoc, { type: 'box' }>, 'material' | 'visual' | 'color' | 'tag' | 'text'>>;
const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rest: Rest = {}, yawDeg = 0): PrimDoc =>
  ({ type: 'box', pos: [r3(x), r3(y), r3(z)], size: [r3(sx), r3(sy), r3(sz)], ...(yawDeg && { yawDeg: r2(yawDeg) }), material: 'concrete', visual: 'concrete', ...rest });
const cyl = (x: number, y: number, z: number, r: number, h: number, rest: Partial<Pick<Extract<PrimDoc, { type: 'cylinder' }>, 'material' | 'color' | 'tag'>> = {}): PrimDoc =>
  ({ type: 'cylinder', pos: [r3(x), r3(y), r3(z)], radius: r3(r), height: r3(h), material: 'metal', ...rest });
/** A box from a to b (sloped beam, rail, ramp deck), cross-section 2hy (sideways) x 2hz (up): kit.beam in map.json terms. */
export function beamDoc(a: Vec3, b: Vec3, hy: number, hz: number, rest: Rest = {}): PrimDoc {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dx, dy, dz), Lh = Math.hypot(dx, dy);
  const pitch = normPitch(-Math.atan2(dz, Lh) / deg);
  return { type: 'box', pos: [r3((a[0] + b[0]) / 2), r3((a[1] + b[1]) / 2), r3((a[2] + b[2]) / 2)], size: [r3(L), r3(2 * hy), r3(2 * hz)], yawDeg: r2(Math.atan2(dy, dx) / deg), ...(Math.abs(pitch) > 1e-6 && { pitchDeg: r2(pitch) }), material: 'metal', visual: 'metal', ...rest };
}
/** A world primitive (kit helpers) as a map.json primitive. */
function fromPrim(p: Prim): PrimDoc {
  if (p.kind === 'box') {
    const pitch = normPitch((p.pitch ?? 0) / deg);
    return { type: 'box', pos: [r3(p.c.x), r3(p.c.y), r3(p.c.z)], size: [r3(p.half.x * 2), r3(p.half.y * 2), r3(p.half.z * 2)], yawDeg: r2(p.yaw / deg), ...(Math.abs(pitch) > 1e-6 && { pitchDeg: r2(pitch) }), material: p.mat, ...(p.visual && { visual: p.visual }) };
  }
  if (p.kind === 'cyl') return { type: 'cylinder', pos: [r3(p.c.x), r3(p.c.y), r3(p.c.z)], radius: r3(p.r), height: r3(p.h), material: p.mat };
  if (p.kind === 'sphere') return { type: 'sphere', pos: [r3(p.c.x), r3(p.c.y), r3(p.c.z)], radius: r3(p.r), material: p.mat };
  throw new Error('brushes are not map.json primitives');
}

const P = (key: string, label: string, min: number, max: number, step: number, def: number, unit = 'm'): PrefabParam => ({ key, label, min, max, step, def, unit });
const wood: Rest = { material: 'wood', visual: 'wood' }, metal: Rest = { material: 'metal', visual: 'metal' };

/** A deck from the ground at x = 0 up to height H at x = L, its top surface on that line. */
function deck(L: number, W: number, H: number, t: number, rest: Rest): PrimDoc {
  const a = Math.atan2(H, L), s = Math.sin(a), c = Math.cos(a);
  const off: Vec3 = [s * t / 2, 0, -c * t / 2];
  return beamDoc([off[0], 0, off[2]], [L + off[0], 0, H + off[2]], W / 2, t / 2, rest);
}

export const PREFABS: Prefab[] = [
  { id: 'ramp', name: 'Ramp', blurb: 'Launch ramp: a sloped deck on a back support', tab: 'freestyle',
    params: [P('length', 'Length', 1, 20, 0.1, 4), P('width', 'Width', 0.5, 10, 0.1, 2), P('height', 'Height', 0.2, 8, 0.1, 1.2)],
    build: ({ length: L, width: W, height: H }) => ({ prims: [deck(L, W, H, 0.12, wood), box(L - 0.1, 0, H / 2, 0.2, W, H, wood)] }) },
  { id: 'kicker', name: 'Kicker', blurb: 'Short, steep wedge for pops and gaps', tab: 'freestyle',
    params: [P('length', 'Length', 0.5, 6, 0.1, 1.6), P('width', 'Width', 0.5, 6, 0.1, 1.2), P('height', 'Height', 0.2, 3, 0.05, 0.6)],
    build: ({ length: L, width: W, height: H }) => ({ prims: [deck(L, W, H, 0.1, wood), box(L * 0.75, 0, H / 4, L / 2, W, H / 2, wood), box(L - 0.05, 0, H / 2, 0.1, W, H, wood)] }) },
  { id: 'rail', name: 'Rail', blurb: 'Grind rail on two posts', tab: 'freestyle',
    params: [P('length', 'Length', 1, 30, 0.1, 6), P('height', 'Height', 0.2, 5, 0.05, 0.5)],
    build: ({ length: L, height: h }) => ({ prims: [beamDoc([0, 0, h], [L, 0, h], 0.04, 0.04, metal), cyl(0.3, 0, 0, 0.035, h - 0.04), cyl(L - 0.3, 0, 0, 0.035, h - 0.04)] }) },
  { id: 'stringer', name: 'Stringer', blurb: 'Sloped handrail, as down a flight of stairs', tab: 'freestyle',
    params: [P('length', 'Run', 1, 20, 0.1, 5), P('rise', 'Rise', 0, 8, 0.05, 1.5), P('height', 'Height', 0.3, 3, 0.05, 0.9)],
    build: ({ length: L, rise, height: h }) => ({ prims: [beamDoc([0, 0, h], [L, 0, h + rise], 0.035, 0.035, metal), cyl(0.2, 0, 0, 0.03, h), cyl(L - 0.2, 0, 0, 0.03, h + rise * (L - 0.2) / L)] }) },
  { id: 'ledge', name: 'Ledge', blurb: 'Concrete ledge or bench', tab: 'freestyle',
    params: [P('length', 'Length', 0.5, 30, 0.1, 6), P('width', 'Width', 0.2, 4, 0.05, 0.6), P('height', 'Height', 0.1, 3, 0.05, 0.5)],
    build: ({ length: L, width: W, height: H }) => ({ prims: [box(L / 2, 0, H / 2, L, W, H)] }) },
  { id: 'stairs', name: 'Stairs', blurb: 'A flight of solid steps', tab: 'freestyle',
    params: [P('steps', 'Steps', 2, 40, 1, 8, ''), P('width', 'Width', 0.5, 10, 0.1, 3), P('rise', 'Rise per step', 0.1, 0.4, 0.01, 0.18), P('run', 'Run per step', 0.2, 0.6, 0.01, 0.3)],
    build: ({ steps, width: W, rise, run }) => ({ prims: Array.from({ length: Math.round(steps) }, (_, i) => box((i + 0.5) * run, 0, ((i + 1) * rise) / 2, run, W, (i + 1) * rise)) }) },
  { id: 'container', name: 'Shipping container', blurb: '20 ft container (6.1 x 2.4 x 2.6 m)', tab: 'freestyle',
    params: [P('length', 'Length', 2, 13, 0.01, 6.06), P('stack', 'Stacked', 1, 4, 1, 1, '')],
    build: ({ length: L, stack }) => ({ prims: Array.from({ length: Math.round(stack) }, (_, i) => box(L / 2, 0, 1.295 + i * 2.59, L, 2.44, 2.59, { material: 'metal', visual: 'plain', color: ['#b5462a', '#2a6fb5', '#3d8b4a', '#c99a2e'][i % 4] }, i % 2 ? 4 : 0)) }) },
  { id: 'pallets', name: 'Pallet stack', blurb: 'Euro pallets, slightly out of line', tab: 'freestyle',
    params: [P('count', 'Pallets', 1, 30, 1, 6, '')],
    build: ({ count }) => ({ prims: Array.from({ length: Math.round(count) }, (_, i) => box(0.6 + Math.sin(i * 2.3) * 0.04, Math.cos(i * 1.7) * 0.04, 0.072 + i * 0.144, 1.2, 0.8, 0.144, wood, Math.sin(i * 3.1) * 4)) }) },
  { id: 'water-tower', name: 'Water tower', blurb: 'Tank on four legs: a classic dive', tab: 'freestyle',
    params: [P('height', 'Leg height', 3, 40, 0.5, 12), P('radius', 'Tank radius', 1, 8, 0.1, 3)],
    build: ({ height: h, radius: r }) => {
      const k = r * 0.7, prims: PrimDoc[] = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => cyl(sx * k, sy * k, 0, 0.15, h));
      prims.push(cyl(0, 0, h, r, Math.max(2, r * 1.3), { tag: 'tank' }), box(0, 0, h - 0.1, 2 * k + 0.4, 2 * k + 0.4, 0.2, metal));
      return { prims };
    } },
  { id: 'bando-wall', name: 'Bando wall', blurb: 'Concrete wall with window openings, one row per floor', tab: 'freestyle',
    params: [P('length', 'Length', 2, 40, 0.1, 10), P('height', 'Height', 2, 30, 0.1, 6), P('floors', 'Floors', 1, 8, 1, 2, ''), P('windows', 'Windows per floor', 0, 10, 1, 3, ''), P('winW', 'Window width', 0.5, 5, 0.1, 1.6), P('winH', 'Window height', 0.5, 4, 0.1, 1.4), P('sill', 'Sill height', 0, 3, 0.05, 1), P('thick', 'Thickness', 0.1, 1, 0.05, 0.3)],
    build: ({ length: L, height: H, floors, windows, winW, winH, sill, thick: t }) => {
      const prims: PrimDoc[] = [], n = Math.round(windows), fl = Math.round(floors), fh = H / fl;
      const ww = Math.min(winW, (L / Math.max(1, n)) * 0.8), wh = Math.min(winH, fh - sill - 0.2), s = Math.min(sill, fh - 0.4);
      for (let f = 0; f < fl; f++) {
        const z0 = f * fh;
        if (n === 0 || wh <= 0.1) { prims.push(box(L / 2, 0, z0 + fh / 2, L, t, fh)); continue; }
        const pitch = L / n;
        let x = 0;
        for (let i = 0; i < n; i++) {
          const c = (i + 0.5) * pitch, a = c - ww / 2, b = c + ww / 2;
          if (a - x > 0.01) prims.push(box((x + a) / 2, 0, z0 + fh / 2, a - x, t, fh)); // pier
          if (s > 0.01) prims.push(box(c, 0, z0 + s / 2, ww, t, s)); // under the window
          const top = fh - s - wh;
          if (top > 0.01) prims.push(box(c, 0, z0 + s + wh + top / 2, ww, t, top)); // lintel
          x = b;
        }
        if (L - x > 0.01) prims.push(box((x + L) / 2, 0, z0 + fh / 2, L - x, t, fh));
      }
      return { prims };
    } },
  { id: 'bando-floor', name: 'Floor with holes', blurb: 'A slab on columns with holes to dive through', tab: 'freestyle',
    params: [P('length', 'Length', 2, 40, 0.5, 12), P('width', 'Width', 2, 40, 0.5, 8), P('z', 'Height', 0.5, 30, 0.1, 3), P('cell', 'Hole size', 1, 6, 0.5, 2), P('holes', 'Holes', 0, 20, 1, 2, '')],
    build: ({ length: L, width: W, z, cell, holes }) => {
      const nx = Math.max(1, Math.round(L / cell)), ny = Math.max(1, Math.round(W / cell)), cx = L / nx, cy = W / ny, prims: PrimDoc[] = [];
      // holes spread over the slab (a fixed pattern: the same parameters give the same floor)
      const hole = new Set<number>(), total = nx * ny, k = Math.min(Math.round(holes), total - 1);
      for (let i = 0; i < k; i++) { let c = Math.floor(((i * 0.618034 + 0.31) % 1) * total); while (hole.has(c)) c = (c + 1) % total; hole.add(c); }
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (!hole.has(j * nx + i)) prims.push(box((i + 0.5) * cx, (j + 0.5) * cy - W / 2, z - 0.125, cx, cy, 0.25));
      for (const [x, y] of [[0.3, -W / 2 + 0.3], [L - 0.3, -W / 2 + 0.3], [0.3, W / 2 - 0.3], [L - 0.3, W / 2 - 0.3]]) prims.push(box(x, y, (z - 0.25) / 2, 0.4, 0.4, z - 0.25));
      return { prims };
    } },
  { id: 'columns', name: 'Columns', blurb: 'A grid of concrete columns', tab: 'freestyle',
    params: [P('nx', 'Columns (forward)', 1, 12, 1, 3, ''), P('ny', 'Columns (across)', 1, 12, 1, 2, ''), P('spacing', 'Spacing', 1, 20, 0.5, 5), P('height', 'Height', 1, 30, 0.1, 6), P('size', 'Size', 0.2, 3, 0.05, 0.5)],
    build: ({ nx, ny, spacing: s, height: h, size }) => {
      const prims: PrimDoc[] = [], a = Math.round(nx), b = Math.round(ny);
      for (let i = 0; i < a; i++) for (let j = 0; j < b; j++) prims.push(box(i * s, (j - (b - 1) / 2) * s, h / 2, size, size, h));
      return { prims };
    } },
  { id: 'bowl', name: 'Skate bowl ring', blurb: 'A banked ring of sloped panels', tab: 'freestyle',
    params: [P('radius', 'Inner radius', 2, 40, 0.5, 6), P('segments', 'Segments', 6, 48, 1, 16, ''), P('bank', 'Bank angle', 10, 80, 1, 35, '°'), P('height', 'Wall height', 0.5, 8, 0.1, 2)],
    build: ({ radius: R, segments, bank, height: h }) => {
      const n = Math.round(segments), run = h / Math.tan(bank * deg), half = Math.PI * (R + run / 2) / n * 1.04, prims: PrimDoc[] = [];
      for (let i = 0; i < n; i++) {
        const th = (i / n) * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th);
        prims.push(beamDoc([R * c, R * s, 0.08], [(R + run) * c, (R + run) * s, h], half, 0.08, { material: 'concrete', visual: 'concrete' }));
      }
      return { prims };
    } },
  { id: 'hoop', name: 'Power-loop hoop', blurb: 'A round hoop on a post: loop it, dive it', tab: 'race',
    params: [P('radius', 'Radius', 0.5, 6, 0.1, 1.5), P('height', 'Centre height', 1, 20, 0.1, 4)],
    build: ({ radius: r, height: h }) => {
      const list: Prim[] = [];
      hoop(list, { x: 0, y: 0, z: h }, -Math.PI / 2, r, 0.06); // plane across +x (gate yaw -90°: travel east)
      const prims = list.map(fromPrim);
      prims.push(cyl(0, 0, 0, 0.05, Math.max(0.1, h - r - 0.12), { material: 'gate' }));
      return { prims };
    } },
  { id: 'fence', name: 'Fence run', blurb: 'Posts and mesh panels', tab: 'freestyle',
    params: [P('length', 'Length', 1, 60, 0.5, 12), P('height', 'Height', 0.5, 5, 0.1, 2), P('segments', 'Panels', 1, 30, 1, 4, '')],
    build: ({ length: L, height: h, segments }) => {
      const n = Math.round(segments), prims: PrimDoc[] = [];
      for (let i = 0; i <= n; i++) prims.push(cyl((i / n) * L, 0, 0, 0.04, h));
      for (let i = 0; i < n; i++) prims.push(box(((i + 0.5) / n) * L, 0, h / 2, L / n - 0.08, 0.02, h, { material: 'metal', visual: 'net' }));
      return { prims };
    } },
  { id: 'light-tower', name: 'Light tower', blurb: 'Floodlight mast with a map light at the top (counts against the 8 lights)', tab: 'race',
    params: [P('height', 'Height', 3, 40, 0.5, 10), P('intensity', 'Intensity', 10, 5000, 10, 600, ''), P('range', 'Range', 5, 300, 1, 60)],
    build: ({ height: h, intensity, range }) => ({
      prims: [box(0, 0, h / 2, 0.3, 0.3, h, metal), box(0.3, 0, h - 0.3, 0.3, 1.4, 0.7, { material: 'metal', visual: 'led', tag: 'flood' })],
      lights: [{ pos: [0.6, 0, r3(h - 0.3)], color: '#fff3d6', intensity, range }],
    }) },
];

export const prefabById = (id: string) => PREFABS.find((p) => p.id === id);
export const prefabDefaults = (p: Prefab) => Object.fromEntries(p.params.map((x) => [x.key, x.def]));

/** Expand a prefab at `at` (ENU, ground point), turned yawDeg CCW from east, every part tagged with the group id. */
export function placePrefab(pf: Prefab, params: Record<string, number>, at: Vec3, yawDeg: number, group: string): { prims: GroupedPrim[]; lights: GroupedLight[] } {
  const out = pf.build({ ...prefabDefaults(pf), ...params });
  const c = Math.cos(yawDeg * deg), s = Math.sin(yawDeg * deg);
  const mv = (p: Vec3): Vec3 => [r3(at[0] + c * p[0] - s * p[1]), r3(at[1] + s * p[0] + c * p[1]), r3(at[2] + p[2])];
  const prims = out.prims.map((p): GroupedPrim => {
    const q = { ...p, pos: mv(p.pos), 'x-group': group } as GroupedPrim;
    if (q.type === 'box') { const y = ((q.yawDeg ?? 0) + yawDeg) % 360; if (Math.abs(y) > 1e-6) q.yawDeg = r2(y); else delete q.yawDeg; }
    return q;
  });
  return { prims, lights: (out.lights ?? []).map((l) => ({ ...l, pos: mv(l.pos), 'x-group': group })) };
}
