// Trees: alpha-cut leaf / needle cards on a branch skeleton, instanced. The shapes are built to the
// collision model in world.ts (PrimitiveWorld): a solid trunk of radius 0.12 r up to half the
// height, a porous canopy sphere of radius r at 0.62 h and a solid core of 0.3 r in it. So the bark
// stands where the trunk collides, the limbs fork from the core, and every leaf card sits inside the
// canopy sphere — flying into the foliage is what slows the quad down, the trunk is what stops it.
//
// Templates are in canopy units (origin at the canopy centre, scaled by r per instance). Trunk
// vertices carry aTq (0 at the ground .. 1 at the canopy centre) and are stretched to each tree's
// height in the vertex shader (sway.ts), so one template fits every height / radius ratio. Beyond
// ~80 m a tree dissolves (screen-door) into a cheap stand-in of a few crossed cards + a 4-sided
// trunk, one draw per species for the whole forest; no camera-facing billboards (they would seam
// between the faces of the FPV cube capture).
import * as THREE from 'three';
import { MapDef, seededRandom } from '../maps/world';
import { patchMaterial, TREE_FADE, WorldUniforms } from './sway';
import { ATLAS_SIZE, atlasUV, AtlasCell } from './textures';

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Trunk radius profile (canopy units) at height fraction q (0 ground .. 1 canopy centre): never thinner than the 0.12 r collision cylinder where that exists (q <= 0.5 h / 0.62 h). */
export const TRUNK_PROFILE: [number, number][] = [[-0.03, 0.155], [0.04, 0.128], [0.81, 0.125], [1, 0.085]];
const TQ_NONE = -1;

class Geo {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; tq: number[] = []; leaf: number[] = []; idx: number[] = [];
  vert(p: V3, n: V3, u: number, v: number, tq = TQ_NONE, leaf = 0) {
    this.pos.push(...p); this.nrm.push(...n); this.uv.push(u, v); this.tq.push(tq); this.leaf.push(leaf);
    return this.pos.length / 3 - 1;
  }
  /**
   * Tapered prism a -> b (radii ra, rb), bark from the atlas: its long axis runs along the branch
   * (along = 0..1 over the cell), around the circumference across it. tqA / tqB: stretched trunk rings.
   */
  tube(a: V3, b: V3, ra: number, rb: number, sides: number, alongA = 0, alongB = 1, tqA = TQ_NONE, tqB = TQ_NONE) {
    const d = norm(sub(b, a)), ref: V3 = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = norm(cross(d, ref)), e2 = cross(d, e1), base = this.pos.length / 3, [u0, v0, du, dv] = atlasUV('bark');
    for (let ring = 0; ring < 2; ring++) for (let s = 0; s <= sides; s++) {
      const th = (s / sides) * Math.PI * 2, n: V3 = add(mul(e1, Math.cos(th)), mul(e2, Math.sin(th)));
      const c = ring ? b : a, r = ring ? rb : ra;
      this.vert(add(c, mul(n, r)), n, u0 + (ring ? alongB : alongA) * du, v0 + (0.04 + 0.92 * s / sides) * dv, ring ? tqB : tqA);
    }
    for (let s = 0; s < sides; s++) { const i = base + s, j = i + sides + 1; this.idx.push(i, j, i + 1, i + 1, j, j + 1); }
  }
  /** Leaf card: centre c, half-axes ex (u) / ey (v), lit with normal `shade` on both faces. */
  card(c: V3, ex: V3, ey: V3, shade: V3, cell: AtlasCell, leaf = 1) {
    const [u0, v0, du, dv] = atlasUV(cell), base = this.pos.length / 3;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      // corners lean towards the crown-radial normal a little more than the centre: rounder shading
      this.vert(add(c, add(mul(ex, sx), mul(ey, sy))), shade, u0 + (sx + 1) / 2 * du, v0 + (sy + 1) / 2 * dv, TQ_NONE, leaf);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aTq', new THREE.Float32BufferAttribute(this.tq, 1));
    g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(this.leaf, 1));
    g.setIndex(this.idx);
    return g;
  }
}

/** Trunk from the ground to the canopy centre (stretched rings), continued into the crown (y, radius pairs). */
function trunk(g: Geo, sides: number, crown: [number, number][]) {
  const P = TRUNK_PROFILE;
  // template y of the stretched rings only matters for bounds (the shader places them)
  const ty = (q: number) => (q - 1) * 3, along = (q: number) => 0.03 + q * 0.7;
  for (let i = 0; i + 1 < P.length; i++) g.tube([0, ty(P[i][0]), 0], [0, ty(P[i + 1][0]), 0], P[i][1], P[i + 1][1], sides, along(P[i][0]), along(P[i + 1][0]), P[i][0], P[i + 1][0]);
  let prev: [number, number] = [0, P[P.length - 1][1]];
  for (const [y, r] of crown) { g.tube([0, prev[0], 0], [0, y, 0], prev[1], r, sides, Math.min(1, along(1) + prev[0] * 0.3), Math.min(1, along(1) + y * 0.3)); prev = [y, r]; }
}

/** a with its component along unit n removed, normalised (any perpendicular when a ∥ n). */
function perp(a: V3, n: V3): V3 {
  const d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2], p = sub(a, mul(n, d));
  return len(p) > 0.1 ? norm(p) : norm(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
}

/** Random unit vector. */
function unit(rnd: () => number): V3 {
  const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
}

/**
 * Keep a card (centre c, half-extent h) inside the canopy sphere (radius 1): a card's corners reach
 * at most ~1.2 h further out than its centre for the orientations used, so shrink / pull it in.
 */
function fit(c: V3, h: number, R = 1.0): [V3, number] {
  const d = len(c), K = 1.2;
  if (d + h * K <= R) return [c, h];
  const h2 = Math.min(h, Math.max(0.06, (R - Math.min(d, R - 0.07)) / K));
  const d2 = Math.min(d, R - h2 * K);
  return [mul(c, d2 / (d || 1)), h2];
}

/** Card normal for shading: mostly crown-radial (a lit dome, not flat cards), from a centre slightly below the canopy centre. */
const shadeN = (c: V3, n: V3, k = 0.7): V3 => norm(add(mul(norm(sub(c, [0, -0.25, 0])), k), mul(n, 1 - k)));

/** Broadleaf: five or six limbs forking from the core, sub-branches, ~220 leaf-cluster cards in clumps (gaps between them). */
export function oakTemplate(seed: number): THREE.BufferGeometry {
  const rnd = seededRandom(seed), bark = new Geo(), leaves = bark;
  trunk(bark, 6, [[0.14, 0.06], [0.3, 0.035]]);
  const tips: { p: V3; d: V3 }[] = [];
  const n = 5 + Math.floor(rnd() * 2);
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.8, el = (25 + rnd() * 35) * Math.PI / 180, L = 0.5 + rnd() * 0.25;
    const d: V3 = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const s: V3 = [0, -0.38 + rnd() * 0.42, 0];
    const mid = add(add(s, mul(d, L * 0.5)), [0, 0.05, 0]);
    let end = add(s, mul(d, L)); if (len(end) > 0.82) end = mul(end, 0.82 / len(end));
    bark.tube(s, mid, 0.055, 0.035, 5, 0, 0.3); bark.tube(mid, end, 0.035, 0.016, 4, 0.3, 0.6);
    tips.push({ p: end, d });
    for (const from of [mid, end]) for (let k = 0; k < 2; k++) {
      const a2 = az + (k ? 1 : -1) * (0.5 + rnd() * 0.4), e2 = el + (rnd() - 0.3) * 0.6, L2 = 0.2 + rnd() * 0.14;
      const d2: V3 = [Math.cos(e2) * Math.cos(a2), Math.sin(e2), Math.cos(e2) * Math.sin(a2)];
      let tip = add(from, mul(d2, L2)); if (len(tip) > 0.9) tip = mul(tip, 0.9 / len(tip));
      bark.tube(from, tip, 0.02, 0.008, 3, 0.6, 0.8);
      tips.push({ p: tip, d: d2 });
    }
  }
  // clumps over the shell (most of them on top) so the crown closes between the limbs
  for (let i = 0; i < 12; i++) {
    const a = rnd() * Math.PI * 2, e = -0.2 + Math.sqrt(rnd()) * 1.6, rr = 0.62 + rnd() * 0.22;
    const p: V3 = [Math.cos(a) * Math.cos(e) * rr, Math.sin(e) * rr, Math.sin(a) * Math.cos(e) * rr];
    tips.push({ p, d: norm(p) });
  }
  for (const t of tips) {
    const cards = 5 + Math.floor(rnd() * 3);
    for (let k = 0; k < cards; k++) {
      const off = mul(unit(rnd), 0.05 + rnd() * 0.14);
      const [c, h] = fit(add(t.p, off), 0.17 + rnd() * 0.08);
      const nrm = norm(add(mul(norm(c), 0.7), unit(rnd)));
      // image "up" (the twig -> leaves) points away from the branch, roughly
      const ey0 = perp(t.d, nrm), ex = norm(cross(nrm, ey0)), ey = cross(ex, nrm);
      leaves.card(c, mul(ex, h), mul(ey, h), shadeN(c, nrm), 'oak');
    }
  }
  return bark.build();
}

/** Conifer: leader to the top, nine drooping whorls of needle-spray cards inside the canopy sphere (a cone fitted to it). */
export function pineTemplate(seed: number): THREE.BufferGeometry {
  const rnd = seededRandom(seed), bark = new Geo(), leaves = bark;
  trunk(bark, 6, [[0.5, 0.05], [0.97, 0.012]]);
  const W = 9;
  for (let k = 0; k < W; k++) {
    const y = -0.78 + (k / (W - 1)) * 1.6;
    const m = 5 + (rnd() < 0.5 ? 1 : 0), a0 = rnd() * Math.PI * 2;
    for (let i = 0; i < m; i++) {
      const az = a0 + (i / m) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
      const L = Math.min(0.95 * Math.sqrt(1 - y * y), (0.92 * (0.97 - y)) / 1.75) * (0.85 + 0.3 * rnd());
      const dir: V3 = [Math.cos(az), 0, Math.sin(az)];
      const s: V3 = [0, y, 0], mid = add(add(s, mul(dir, L * 0.5)), [0, 0.02, 0]), end = add(add(s, mul(dir, L)), [0, -0.12 * L, 0]);
      bark.tube(s, end, 0.022, 0.006, 3, 0.2, 0.5); // mostly hidden in the needles: one thin segment
      const side = norm(cross([0, 1, 0], dir));
      for (const f of [0.45, 0.8]) {
        const tilt = (rnd() - 0.5) * 0.9, up: V3 = norm(add([0, 1, 0], mul(side, tilt)));
        const ex = norm(sub(end, s)), ey = norm(cross(up, ex));
        const [c, h] = fit(add(s, mul(sub(end, s), f)), 0.13 + 0.06 * rnd() + 0.05 * L);
        leaves.card(c, mul(ex, h * 1.15), mul(ey, h * 0.9), shadeN(c, up, 0.55), 'needles');
      }
      // one more card standing on edge for volume seen from the side
      const [c, h] = fit(add(s, mul(sub(end, s), 0.62)), 0.12 + 0.05 * L);
      leaves.card(c, mul(norm(sub(end, s)), h * 1.1), [0, h * 0.8, 0], shadeN(c, side, 0.6), 'needles');
    }
  }
  for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI; leaves.card([0, 0.86, 0], [Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1], [0, 0.12, 0], norm([Math.cos(a + 1.57), 0.5, Math.sin(a + 1.57)]), 'needles'); }
  return bark.build();
}

/** Far stand-in: a 4-sided trunk (bark strip of the atlas) and three crossed crown cards (+ a roof card for the oak). */
export function farTemplate(kind: 'oak' | 'pine'): THREE.BufferGeometry {
  const g = new Geo();
  trunk(g, 4, kind === 'pine' ? [[0.4, 0.05]] : [[0.1, 0.07]]);
  const cell: AtlasCell = kind === 'oak' ? 'farOak' : 'farPine';
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI, ex: V3 = [Math.cos(a), 0, Math.sin(a)];
    if (kind === 'oak') g.card([0, 0, 0], mul(ex, 1), [0, 0.95, 0], [0, 0.35, 0], cell, 0.4);
    else g.card([0, 0.08, 0], mul(ex, 0.85), [0, 0.92, 0], [0, 0.2, 0], cell, 0.3);
  }
  if (kind === 'oak') g.card([0, 0.25, 0], [0.85, 0, 0], [0, 0, 0.85], [0, 1, 0], cell, 0.4);
  const geo = g.build();
  // crossed cards: shade by the corner's direction from the centre (a round crown); the roof card keeps its up normal
  const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal'), leaf = geo.getAttribute('aLeaf');
  for (let i = 0; i < pos.count; i++) {
    if (leaf.getX(i) === 0 || nrm.getY(i) > 0.999) continue;
    nrm.setXYZ(i, ...norm([pos.getX(i), pos.getY(i) + 0.3, pos.getZ(i)]));
  }
  return geo;
}

// ---------------------------------------------------------------------------------------------

interface TreeInst { x: number; y: number; z: number; h: number; r: number; yaw: number; species: 0 | 1; variant: number }
interface Group { im: THREE.InstancedMesh; trees: TreeInst[]; iTree: THREE.InstancedBufferAttribute }

export interface TreeSet {
  meshes: THREE.InstancedMesh[];
  /** Re-bin trees into near / far sets around the camera (cheap; only after it moved a few metres). */
  update(cam: THREE.Vector3): void;
  dispose(): void;
}

const VARIANTS = 2;

/**
 * Instanced trees of a map: per species and variant one near mesh (bark + leaves, one material),
 * per species one far mesh. `atlas`: foliageAtlas() (owned by the caller).
 */
export function buildTrees(map: MapDef, u: WorldUniforms, atlas: THREE.Texture): TreeSet | null {
  if (!map.trees.length) return null;
  const disp: { dispose(): void }[] = [];
  const T = <X extends { dispose(): void }>(x: X) => (disp.push(x), x);
  const trees: TreeInst[] = map.trees.map((t) => {
    const hs = Math.abs(Math.sin(t.x * 12.9898 + t.y * 78.233) * 43758.5453) % 1;
    return { x: t.x, y: map.terrain(t.x, t.y), z: -t.y, h: t.h, r: t.r, yaw: hs * Math.PI * 2, species: t.type === 'pine' ? 1 : 0, variant: Math.floor(hs * 97) % VARIANTS };
  });
  // two-sided alpha-cut cards lit with their own crown-radial normals; bark is the atlas's opaque cell
  const card = { map: atlas, alphaTest: 0.5, side: THREE.DoubleSide } as const;
  const near = T(patchMaterial(new THREE.MeshStandardMaterial({ ...card, roughness: 0.85 }), u, 'tree', { fade: 'near', alphaMips: ATLAS_SIZE, noNormalFlip: true }));
  const far = T(patchMaterial(new THREE.MeshStandardMaterial({ ...card, roughness: 0.9 }), u, 'tree', { fade: 'far', alphaMips: ATLAS_SIZE, noNormalFlip: true }));
  const depth = T(patchMaterial(new THREE.MeshDepthMaterial(card), u, 'tree', { depth: true, alphaMips: ATLAS_SIZE }));
  const nearG: Group[] = [], farG: Group[] = [];
  const makeGroup = (geo: THREE.BufferGeometry, mat: THREE.Material, shadows: boolean, members: TreeInst[], into: Group[]) => {
    T(geo);
    const iTree = new THREE.InstancedBufferAttribute(new Float32Array(members.length * 4), 4);
    iTree.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iTree', iTree);
    const im = T(new THREE.InstancedMesh(geo, mat, members.length));
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0; im.visible = false;
    if (shadows) { im.customDepthMaterial = depth; im.castShadow = true; im.receiveShadow = true; }
    into.push({ im, trees: members, iTree });
  };
  for (const species of [0, 1] as const) {
    const all = trees.filter((t) => t.species === species);
    if (!all.length) continue;
    for (let v = 0; v < VARIANTS; v++) {
      const members = all.filter((t) => t.variant === v);
      if (members.length) makeGroup(species ? pineTemplate(101 + v * 17) : oakTemplate(7 + v * 31), near, true, members, nearG);
    }
    makeGroup(farTemplate(species ? 'pine' : 'oak'), far, false, all, farG);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  const box = new THREE.Box3(), last = new THREE.Vector3(Infinity, 0, 0);
  const fill = (g: Group, keep: (t: TreeInst) => boolean) => {
    let n = 0;
    box.makeEmpty();
    for (const t of g.trees) {
      if (!keep(t)) continue;
      g.im.setMatrixAt(n, m4.compose(p.set(t.x, t.y + 0.62 * t.h, t.z), q.setFromAxisAngle(Y, t.yaw), s.setScalar(t.r)));
      g.iTree.setXYZW(n, t.x, t.y, t.z, t.h);
      box.expandByPoint(p.set(t.x - t.r, t.y - 0.5, t.z - t.r)).expandByPoint(p.set(t.x + t.r, t.y + 0.62 * t.h + t.r, t.z + t.r));
      n++;
    }
    g.im.count = n; g.im.visible = n > 0;
    g.im.instanceMatrix.needsUpdate = true; g.iTree.needsUpdate = true;
    g.im.boundingSphere = n ? box.getBoundingSphere(g.im.boundingSphere ?? new THREE.Sphere()) : null;
  };
  const dist = (t: TreeInst, c: THREE.Vector3) => Math.hypot(t.x - c.x, t.y + 0.5 * t.h - c.y, t.z - c.z);
  // bins reach 6 m past the dissolve band: they stay valid until the camera has moved 4 m
  const update = (cam: THREE.Vector3) => {
    if (last.distanceToSquared(cam) < 16) return;
    last.copy(cam);
    for (const g of nearG) fill(g, (t) => dist(t, cam) < TREE_FADE[1] + 6);
    for (const g of farG) fill(g, (t) => dist(t, cam) > TREE_FADE[0] - 6);
  };
  return { meshes: [...nearG, ...farG].map((g) => g.im), update, dispose() { for (const d of disp) d.dispose(); } };
}
