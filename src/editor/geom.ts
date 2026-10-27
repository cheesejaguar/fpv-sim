// Small line and strip geometries for the editor's gizmos, built by hand: three's own helpers
// (EdgesGeometry, TubeGeometry, Box3Helper, Ring / Torus …) would land in the shared three.js chunk
// that every visit downloads, for a tool most visits never open.
import * as THREE from 'three';

const geo = (pos: number[]) => new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));

/** Line segments of an axis-aligned box from lo to hi. */
export function boxEdges(lo = [-0.5, -0.5, -0.5], hi = [0.5, 0.5, 0.5]): THREE.BufferGeometry {
  const c = (i: number) => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]], pos: number[] = [];
  for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) pos.push(...c(a), ...c(b));
  return geo(pos);
}

/** Points of a circle of radius r in the horizontal plane (three y = h), n segments, as pairs for LineSegments. */
function ring(pos: number[], r: number, h: number, n: number, plane: 'xz' | 'xy' | 'yz' = 'xz') {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    const p = (t: number) => (plane === 'xz' ? [r * Math.cos(t), h, r * Math.sin(t)] : plane === 'xy' ? [r * Math.cos(t), r * Math.sin(t), h] : [h, r * Math.cos(t), r * Math.sin(t)]);
    pos.push(...p(a), ...p(b));
  }
}

/** Unit cylinder (radius 0.5, height 1, centred): top and bottom rings and four sides. */
export function cylEdges(n = 24): THREE.BufferGeometry {
  const pos: number[] = [];
  ring(pos, 0.5, 0.5, n); ring(pos, 0.5, -0.5, n);
  for (const [x, z] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) pos.push(x, -0.5, z, x, 0.5, z);
  return geo(pos);
}

/** Unit sphere (radius 0.5): three great circles. */
export function sphereEdges(n = 32): THREE.BufferGeometry {
  const pos: number[] = [];
  ring(pos, 0.5, 0, n, 'xz'); ring(pos, 0.5, 0, n, 'xy'); ring(pos, 0.5, 0, n, 'yz');
  return geo(pos);
}

/** A horizontal circle of radius 1 (scale it), for LineSegments. */
export function circle(n = 48): THREE.BufferGeometry { const pos: number[] = []; ring(pos, 1, 0, n); return geo(pos); }

/** A flat strip `width` wide along points (three space), facing up: the racing line. */
export function ribbon(pts: THREE.Vector3[], width: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [], h = width / 2;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const p = pts[i];
    pos.push(p.x - dz * h, p.y, p.z + dx * h, p.x + dz * h, p.y, p.z - dx * h);
    if (i) { const k = 2 * i; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
  }
  const g = geo(pos); g.setIndex(idx);
  return g;
}

/** A w x h grid of vertices (positions set by the caller), two triangles per cell: the sculpt preview. */
export function gridMesh(w: number, h: number): THREE.BufferGeometry {
  const g = geo(new Array(w * h * 3).fill(0)), idx: number[] = [];
  for (let j = 0; j < h - 1; j++) for (let i = 0; i < w - 1; i++) { const a = j * w + i, b = a + 1, c = a + w, d = c + 1; idx.push(a, c, b, b, c, d); }
  g.setIndex(idx);
  return g;
}
