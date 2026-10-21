// Stadium crowd: the map's `crowd` decor boxes (one per seated spectator) drawn as simple instanced
// figures — thighs, torso, head, and for about one in eight both arms in the air — facing the pitch.
// Shirt colour per spectator from the map; skin, trousers, raised arms and a few bobbing up and down
// are picked per instance in the shader (sway.ts). One geometry (~50 triangles, the arms collapse
// to a point unless raised), cut into ~40 m chunks so each cube face draws only the stands it sees.
import * as THREE from 'three';
import type { BoxPrim } from '../maps/world';
import { patchMaterial, WorldUniforms } from './sway';

/** Box from a to b (three local: +x forward, y up), part flags (skin, trousers, arm) per vertex. */
function box(pos: number[], part: number[], idx: number[], a: [number, number, number], b: [number, number, number], flags: [number, number, number], taper = 1) {
  const base = pos.length / 3;
  const [x0, y0, z0] = a, [x1, y1, z1] = b, zc = (z0 + z1) / 2, hz = (z1 - z0) / 2;
  // 8 corners; the top is `taper` x as wide (shoulders)
  for (const y of [y0, y1]) for (const x of [x0, x1]) for (const s of [-1, 1]) {
    pos.push(x, y, zc + s * hz * (y === y1 ? taper : 1)); part.push(...flags);
  }
  const f = (i: number, j: number, k: number, l: number) => idx.push(base + i, base + j, base + k, base + i, base + k, base + l);
  f(4, 5, 7, 6); // top
  f(2, 6, 7, 3); f(0, 4, 6, 2); f(1, 3, 7, 5); f(0, 1, 5, 4); // front (+x), sides (-z, +z), back; no bottom
}

/** A seated spectator facing +x, sitting on y = 0, with raised arms (hidden per instance in the shader). */
export function figureGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], part: number[] = [], idx: number[] = [];
  box(pos, part, idx, [-0.02, 0.02, -0.15], [0.46, 0.16, 0.15], [0, 1, 0]);      // thighs
  box(pos, part, idx, [-0.13, 0.05, -0.16], [0.09, 0.62, 0.16], [0, 0, 0], 1.2); // torso (shoulders wider)
  // head: octahedron
  const hb = pos.length / 3, hy = 0.75, r = 0.11;
  for (const v of [[r, 0, 0], [-r, 0, 0], [0, r * 1.15, 0], [0, -r, 0], [0, 0, r * 0.9], [0, 0, -r * 0.9]]) { pos.push(v[0] - 0.01, v[1] + hy, v[2]); part.push(1, 0, 0); }
  for (const [a, b, c] of [[0, 2, 4], [4, 2, 1], [1, 2, 5], [5, 2, 0], [0, 4, 3], [4, 1, 3], [1, 5, 3], [5, 0, 3]]) idx.push(hb + a, hb + b, hb + c);
  for (const s of [-1, 1]) box(pos, part, idx, [-0.06, 0.55, s * 0.2 - 0.045], [0.02, 1.12, s * 0.2 + 0.045], [0, 0, 1]); // arms up
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 3));
  g.setIndex(idx);
  const flat = g.toNonIndexed(); g.dispose(); // faceted: normals per face
  flat.computeVertexNormals();
  return flat;
}

export interface Crowd { meshes: THREE.InstancedMesh[]; dispose(): void }
const CROWD_CHUNK = 40;

/** Figures for the given decor boxes, facing `centre` (ENU) across their row. */
export function buildCrowd(people: BoxPrim[], centre: { x: number; y: number }, u: WorldUniforms): Crowd | null {
  if (!people.length) return null;
  const disp: { dispose(): void }[] = [];
  const T = <X extends { dispose(): void }>(x: X) => (disp.push(x), x);
  const mat = T(patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), u, 'crowd'));
  const geo = T(figureGeometry());
  const chunks = new Map<string, BoxPrim[]>();
  for (const p of people) {
    const key = `${Math.floor(p.c.x / CROWD_CHUNK)},${Math.floor(p.c.y / CROWD_CHUNK)}`;
    let c = chunks.get(key); if (!c) chunks.set(key, (c = []));
    c.push(p);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), s = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const meshes = [...chunks.values()].map((list) => {
    const im = T(new THREE.InstancedMesh(geo, mat, list.length));
    list.forEach((p, i) => {
      // face the pitch along the box's local y axis (across the row)
      const ly = { x: -Math.sin(p.yaw), y: Math.cos(p.yaw) }, toC = (centre.x - p.c.x) * ly.x + (centre.y - p.c.y) * ly.y;
      const fx = ly.x * Math.sign(toC || 1), fy = ly.y * Math.sign(toC || 1);
      const sc = 0.92 + (Math.abs(Math.sin(p.c.x * 91.7 + p.c.y * 37.3)) % 0.16);
      m4.compose(pos.set(p.c.x, p.c.z - p.half.z, -p.c.y), q.setFromAxisAngle(Y, Math.atan2(fy, fx)), s.setScalar(sc));
      im.setMatrixAt(i, m4); im.setColorAt(i, col.setHex(p.color ?? 0x888888));
    });
    im.receiveShadow = true;
    im.computeBoundingSphere();
    return im;
  });
  return { meshes, dispose() { for (const d of disp) d.dispose(); } };
}
