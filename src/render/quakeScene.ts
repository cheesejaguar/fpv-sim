// Three.js geometry for Quake levels (MapDef.quake): one merged mesh per texture, UVs from the
// Quake texture axes, and baked vertex lighting from the level's light entities (Quake's linear
// falloff + half-Lambert, with shadow rays against the brushes). Faces are subdivided on a ~2 m grid
// so the lighting has something to vary over. Doom levels (doomMap.ts) reuse this with their own
// texture manifest and a fixed light level per face (the sector's).
import * as THREE from 'three';
import { QuakeFace, QuakeLevel, TEXTURES } from '../maps/quakeMap';
import { BrushGrid, BrushPrim, MapDef } from '../maps/world';

const GRID = 2;            // lighting subdivision (m)
const LIGHT_UNIT = 200;    // Quake light level that renders the texture at its own brightness

type P3 = [number, number, number];

/** Doom sector light (0..255) as a vertex colour: roughly Doom's colormap brightness ramp. */
const doomLight = (l: number): P3 => { const v = Math.min(1.2, 1.25 * Math.pow(Math.max(0, l) / 255, 1.4)); return [v, v, v]; };

function splitPoly(poly: P3[], axis: number, v: number): [P3[], P3[]] {
  const a: P3[] = [], b: P3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = p[axis] - v, dq = q[axis] - v;
    if (dp <= 1e-7) a.push(p);
    if (dp >= -1e-7) b.push(p);
    if ((dp < -1e-7 && dq > 1e-7) || (dp > 1e-7 && dq < -1e-7)) {
      const t = dp / (dp - dq);
      const m: P3 = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
      m[axis] = v;
      a.push(m); b.push(m);
    }
  }
  return [a, b];
}

/** Cut a convex polygon on the GRID lines of the two axes spanning its plane. */
function subdivide(f: QuakeFace): P3[][] {
  const poly: P3[] = [];
  for (let i = 0; i < f.verts.length; i += 3) poly.push([f.verts[i], f.verts[i + 1], f.verts[i + 2]]);
  const n = f.n.map(Math.abs);
  const major = n[0] > n[1] && n[0] > n[2] ? 0 : n[1] > n[2] ? 1 : 2;
  let polys = [poly];
  for (let axis = 0; axis < 3; axis++) {
    if (axis === major) continue;
    let lo = Infinity, hi = -Infinity;
    for (const p of poly) { lo = Math.min(lo, p[axis]); hi = Math.max(hi, p[axis]); }
    for (let v = Math.floor(lo / GRID + 1) * GRID; v < hi - 1e-6; v += GRID) {
      const next: P3[][] = [];
      for (const pp of polys) for (const part of splitPoly(pp, axis, v)) if (part.length >= 3) next.push(part);
      polys = next;
    }
  }
  return polys;
}

export interface QuakeGeometry { tex: string; kind: QuakeFace['kind']; position: Float32Array; uv: Float32Array; color: Float32Array }

/** CPU side of the level mesh (no WebGL needed): per texture, three-space positions, UVs and baked light colours. */
export function buildQuakeGeometry(level: QuakeLevel, brushes: BrushPrim[]): QuakeGeometry[] {
  const grid = new BrushGrid();
  for (const b of brushes) grid.insert(b);
  const lights = level.lights.map((l) => ({ ...l, p: { x: l.pos[0], y: l.pos[1], z: l.pos[2] } }));
  const ambient = level.ambient;
  const cache = new Map<string, P3>();
  const a = { x: 0, y: 0, z: 0 };
  const lightAt = (p: P3, f: QuakeFace, near: typeof lights): P3 => {
    const key = `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)},${f.n[0].toFixed(2)},${f.n[1].toFixed(2)},${f.n[2].toFixed(2)}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const c: P3 = [ambient, ambient, ambient];
    a.x = p[0] + f.n[0] * 0.03; a.y = p[1] + f.n[1] * 0.03; a.z = p[2] + f.n[2] * 0.03;
    for (const l of near) {
      const dx = l.p.x - p[0], dy = l.p.y - p[1], dz = l.p.z - p[2];
      const d = Math.hypot(dx, dy, dz);
      if (d >= l.range) continue;
      const ndl = (dx * f.n[0] + dy * f.n[1] + dz * f.n[2]) / (d || 1);
      if (ndl <= 0) continue;
      const add = l.value * (1 - d / l.range) * (0.5 + 0.5 * ndl);
      if (add < 2 || grid.blocked(a, l.p)) continue;
      c[0] += add * l.color[0]; c[1] += add * l.color[1]; c[2] += add * l.color[2];
    }
    for (let k = 0; k < 3; k++) c[k] = Math.min(2.2, c[k] / LIGHT_UNIT);
    cache.set(key, c);
    return c;
  };

  const textures = level.textures ?? TEXTURES;
  const groups = new Map<string, { tex: string; kind: QuakeFace['kind']; pos: number[]; uv: number[]; col: number[] }>();
  for (const f of level.faces) {
    const tx = textures[f.tex];
    if (!tx) continue;
    let g = groups.get(f.kind + '|' + f.tex);
    if (!g) groups.set(f.kind + '|' + f.tex, (g = { tex: f.tex, kind: f.kind, pos: [], uv: [], col: [] }));
    // lights that can reach this face at all
    let lo0 = Infinity, lo1 = Infinity, lo2 = Infinity, hi0 = -Infinity, hi1 = -Infinity, hi2 = -Infinity;
    for (let i = 0; i < f.verts.length; i += 3) {
      lo0 = Math.min(lo0, f.verts[i]); hi0 = Math.max(hi0, f.verts[i]);
      lo1 = Math.min(lo1, f.verts[i + 1]); hi1 = Math.max(hi1, f.verts[i + 1]);
      lo2 = Math.min(lo2, f.verts[i + 2]); hi2 = Math.max(hi2, f.verts[i + 2]);
    }
    const fixed = f.light !== undefined ? doomLight(f.light) : null;
    const near = f.kind === 'solid' && !fixed ? lights.filter((l) => {
      const ex = Math.max(lo0 - l.p.x, 0, l.p.x - hi0), ey = Math.max(lo1 - l.p.y, 0, l.p.y - hi1), ez = Math.max(lo2 - l.p.z, 0, l.p.z - hi2);
      return ex * ex + ey * ey + ez * ez < l.range * l.range && f.n[0] * (l.p.x - f.verts[0]) + f.n[1] * (l.p.y - f.verts[1]) + f.n[2] * (l.p.z - f.verts[2]) > 0;
    }) : [];
    for (const poly of subdivide(f)) {
      const cols = poly.map((p) => (fixed ? fixed : f.kind === 'solid' ? lightAt(p, f, near) : f.kind === 'light' ? ([1.25, 1.25, 1.25] as P3) : ([0.9, 0.9, 0.9] as P3)));
      for (let i = 1; i + 1 < poly.length; i++) for (const k of [0, i, i + 1]) {
        const p = poly[k];
        g.pos.push(p[0], p[2], -p[1]);
        g.uv.push((p[0] * f.s[0] + p[1] * f.s[1] + p[2] * f.s[2] + f.s[3]) / tx.w, (p[0] * f.t[0] + p[1] * f.t[1] + p[2] * f.t[2] + f.t[3]) / tx.h);
        g.col.push(...cols[k]);
      }
    }
  }
  return [...groups.values()].map((g) => ({ tex: g.tex, kind: g.kind, position: new Float32Array(g.pos), uv: new Float32Array(g.uv), color: new Float32Array(g.col) }));
}

/** Add the level meshes to the scene; returns disposables. */
export function addQuakeLevel(scene: THREE.Scene, map: MapDef): { dispose(): void }[] {
  const level = map.quake!;
  const base = ((import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/') + level.textureBase;
  const out: { dispose(): void }[] = [];
  const loader = new THREE.TextureLoader();
  const brushes = map.prims.filter((p): p is BrushPrim => p.kind === 'brush');
  const textures = level.textures ?? TEXTURES;
  for (const g of buildQuakeGeometry(level, brushes)) {
    const file = textures[g.tex].file;
    const tex = loader.load(level.textureUrl ? level.textureUrl(file) : base + file);
    tex.flipY = false; // Quake t runs down the image
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.anisotropy = 8;
    const liquid = g.kind === 'liquid';
    const mat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: liquid, opacity: liquid ? 0.7 : 1, side: liquid ? THREE.DoubleSide : THREE.FrontSide, depthWrite: !liquid, alphaTest: g.kind === 'masked' ? 0.5 : 0 });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(g.color, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !liquid; // keeps the sun off the drone indoors
    scene.add(mesh);
    out.push(tex, mat, geo);
  }
  return out;
}
