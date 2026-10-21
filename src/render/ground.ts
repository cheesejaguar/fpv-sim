// Ground: the terrain heightfield cut into tiles (so each face of the FPV cube capture only draws
// what it sees), a ground shader that hides the 3 m texture repeat (each tile of the detail texture
// gets its own rotation and offset, blended across a narrow seam, under a large-scale brightness /
// dryness variation), near-ground clutter (instanced grass tufts and pebbles around the spawn and
// the gates, where low flying makes the ground's texture read as height), and painted pitch lines.
import * as THREE from 'three';
import { MapDef, Prim, seededRandom } from '../maps/world';
import { patchMaterial, WorldUniforms } from './sway';

/** Terrain grid resolution (quads per side, as before), its tiling and the LOD blocks inside each tile. */
export const TERRAIN_N = 320, TERRAIN_TILES = 4, TERRAIN_BLOCK = 20;
/** Height error (m) a coarser block may show against the full grid: flat blocks use 2x / 4x bigger quads. */
export const TERRAIN_LOD_ERR = 0.05;
const SKIRT = 0.4;

/** Coarsest quad step (4, 2 or 1 grid cells) whose triangles stay within TERRAIN_LOD_ERR of every grid height in the block. */
export function blockStep(h: (i: number, j: number) => number, i0: number, j0: number, B: number): number {
  for (const L of [4, 2]) {
    if (B % L) continue;
    let ok = true;
    for (let j = j0; j <= j0 + B && ok; j++) for (let i = i0; i <= i0 + B; i++) {
      const a = i0 + Math.floor((i - i0) / L) * L, b = j0 + Math.floor((j - j0) / L) * L;
      const a1 = Math.min(a + L, i0 + B), b1 = Math.min(b + L, j0 + B), u = (i - a) / L, v = (j - b) / L;
      // the two triangles of the coarse quad, split as drawn below
      const ha = h(a, b), hb = h(a, b1), hc = h(a1, b), hd = h(a1, b1);
      const s = u + v <= 1 ? ha + (hc - ha) * u + (hb - ha) * v : hd + (hb - hd) * (1 - u) + (hc - hd) * (1 - v);
      if (Math.abs(s - h(i, j)) > TERRAIN_LOD_ERR) { ok = false; break; }
    }
    if (ok) return L;
  }
  return 1;
}

/**
 * The terrain grid (TERRAIN_N² quads over 2.2 × map.size, as before) as TERRAIN_TILES² tile
 * geometries (one draw each; each face of the FPV cube capture culls the tiles it can't see).
 * Inside a tile every TERRAIN_BLOCK² block of quads uses the coarsest of 1x / 2x / 4x quads that
 * stays within TERRAIN_LOD_ERR of the full grid — a stadium floor is flat, hills keep their detail —
 * and where neighbouring blocks differ, double-sided skirts hide the hairline cracks. Normals come
 * from the full heightfield (central differences) so every edge shades seamlessly; UVs are world
 * metres / 3 (one detail-texture repeat per 3 m).
 */
export function terrainTiles(map: MapDef, N = TERRAIN_N): THREE.BufferGeometry[] {
  const S = map.size * 2.2, step = S / N, W = N + 1, B = TERRAIN_BLOCK, nb = N / B, bpt = nb / TERRAIN_TILES;
  const H = new Float32Array(W * W);
  // three x = ENU x, three z = -ENU y; grid row j runs along +z
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) H[j * W + i] = map.terrain(-S / 2 + i * step, S / 2 - j * step);
  const h = (i: number, j: number) => H[Math.min(N, Math.max(0, j)) * W + Math.min(N, Math.max(0, i))];
  const lod = new Int32Array(nb * nb);
  for (let bj = 0; bj < nb; bj++) for (let bi = 0; bi < nb; bi++) lod[bj * nb + bi] = blockStep(h, bi * B, bj * B, B);
  const lodAt = (bi: number, bj: number) => (bi < 0 || bj < 0 || bi >= nb || bj >= nb ? 0 : lod[bj * nb + bi]);
  const tiles: THREE.BufferGeometry[] = [];
  for (let tj = 0; tj < TERRAIN_TILES; tj++) for (let ti = 0; ti < TERRAIN_TILES; ti++) {
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    const vert = (i: number, j: number) => {
      const x = -S / 2 + i * step, z = -S / 2 + j * step;
      const gx = (h(i + 1, j) - h(i - 1, j)) / ((Math.min(N, i + 1) - Math.max(0, i - 1)) * step);
      const gz = (h(i, j + 1) - h(i, j - 1)) / ((Math.min(N, j + 1) - Math.max(0, j - 1)) * step);
      const l = Math.hypot(gx, 1, gz);
      pos.push(x, h(i, j), z); nrm.push(-gx / l, 1 / l, -gz / l); uv.push(x / 3, -z / 3);
    };
    for (let bj = tj * bpt; bj < (tj + 1) * bpt; bj++) for (let bi = ti * bpt; bi < (ti + 1) * bpt; bi++) {
      const L = lod[bj * nb + bi], m = B / L, R = m + 1, base = pos.length / 3;
      for (let b = 0; b <= m; b++) for (let a = 0; a <= m; a++) vert(bi * B + a * L, bj * B + b * L);
      for (let b = 0; b < m; b++) for (let a = 0; a < m; a++) {
        const p = base + b * R + a, r = p + R;
        idx.push(p, r, p + 1, r, r + 1, p + 1); // counter-clockwise seen from above
      }
      // skirts where the neighbouring block has another resolution
      const edges: [number, (k: number) => number][] = [
        [lodAt(bi, bj - 1), (k) => k], [lodAt(bi, bj + 1), (k) => m * R + k], [lodAt(bi - 1, bj), (k) => k * R], [lodAt(bi + 1, bj), (k) => k * R + m],
      ];
      for (const [other, at] of edges) {
        if (!other || other === L) continue;
        let prevTop = -1, prevBot = -1;
        for (let k = 0; k <= m; k++) {
          const top = base + at(k), bot = pos.length / 3;
          pos.push(pos[top * 3], pos[top * 3 + 1] - SKIRT, pos[top * 3 + 2]); nrm.push(nrm[top * 3], nrm[top * 3 + 1], nrm[top * 3 + 2]); uv.push(uv[top * 2], uv[top * 2 + 1]);
          if (k) idx.push(prevTop, prevBot, top, top, prevBot, bot, prevTop, top, prevBot, top, bot, prevBot); // both faces
          prevTop = top; prevBot = bot;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    tiles.push(g);
  }
  return tiles;
}

const GROUND_FS = /* glsl */ `
uniform sampler2D uMacro;
uniform float uRot;
uniform vec3 uDry;
float gHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// one detail-texture repeat with its tile's own rotation / offset (explicit gradients: no seams in the mips)
vec4 gTile(vec2 uv, vec2 cell, vec2 dx, vec2 dy) {
  float a = gHash(cell) * 6.2831853 * uRot, c = cos(a), s = sin(a);
  mat2 R = mat2(c, s, -s, c);
  vec2 o = vec2(gHash(cell + 17.31), gHash(cell + 41.13));
  return textureGrad(map, R * uv + o, R * dx, R * dy);
}`;
const GROUND_MAP = /* glsl */ `
#ifdef USE_MAP
  vec2 gUv = vMapUv, gCell = floor(gUv), gF = fract(gUv), gDx = dFdx(gUv), gDy = dFdy(gUv);
  vec2 gN = vec2(gF.x < 0.5 ? -1.0 : 1.0, gF.y < 0.5 ? -1.0 : 1.0);
  // neighbour weight: 0.5 on the tile border, 0 beyond 22 % of a tile from it (most pixels: one sample)
  vec2 gW = 0.5 * (1.0 - smoothstep(0.0, 0.22, 0.5 - abs(gF - 0.5)));
  vec4 gC = gTile(gUv, gCell, gDx, gDy) * (1.0 - gW.x) * (1.0 - gW.y);
  if (gW.x > 0.0) gC += gTile(gUv, gCell + vec2(gN.x, 0.0), gDx, gDy) * gW.x * (1.0 - gW.y);
  if (gW.y > 0.0) gC += gTile(gUv, gCell + vec2(0.0, gN.y), gDx, gDy) * (1.0 - gW.x) * gW.y;
  if (gW.x > 0.0 && gW.y > 0.0) gC += gTile(gUv, gCell + gN, gDx, gDy) * gW.x * gW.y;
  // large-scale variation at ~61 m and ~23 m: brightness, and patches of drier / greyer ground
  vec2 gM = texture2D(uMacro, gUv * 0.0492).rg * 0.6 + texture2D(uMacro, gUv * 0.1304 + 0.37).rg * 0.4;
  gC.rgb *= 0.74 + 0.55 * gM.r;
  gC.rgb = mix(gC.rgb, gC.rgb * uDry, clamp((gM.g - 0.47) * 2.6, 0.0, 1.0));
  diffuseColor *= gC;
#endif`;

/** Terrain material: anti-repeat detail sampling (rotate = built-in isotropic textures only) × macro variation. */
export function groundMaterial(map: THREE.Texture, macro: THREE.Texture, rotate: boolean, grass: boolean): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.95 });
  const uniforms = { uMacro: { value: macro }, uRot: { value: rotate ? 1 : 0 }, uDry: { value: grass ? new THREE.Vector3(1.28, 1.12, 0.62) : new THREE.Vector3(0.86, 0.86, 0.92) } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\n' + GROUND_FS).replace('#include <map_fragment>', GROUND_MAP);
  };
  m.customProgramCacheKey = () => 'ground';
  return m;
}

// ---------------------------------------------------------------------------------------------
// Clutter

/** Ground-standing primitives (their footprints are kept clear of tufts and pebbles). */
function footprints(map: MapDef) {
  const cell = 4, grid = new Map<number, [number, number, number, number][]>();
  const key = (ix: number, iy: number) => (ix + 4096) * 8192 + iy + 4096;
  const addBox = (x0: number, y0: number, x1: number, y1: number) => {
    for (let ix = Math.floor(x0 / cell); ix <= Math.floor(x1 / cell); ix++) for (let iy = Math.floor(y0 / cell); iy <= Math.floor(y1 / cell); iy++) {
      let l = grid.get(key(ix, iy)); if (!l) grid.set(key(ix, iy), (l = []));
      l.push([x0, y0, x1, y1]);
    }
  };
  const visit = (p: Prim) => {
    if (p.kind === 'brush') return;
    const g = map.terrain(p.c.x, p.c.y);
    if (p.kind === 'box') {
      const ext = Math.abs(Math.sin(p.pitch ?? 0)) * p.half.x + Math.abs(Math.cos(p.pitch ?? 0)) * p.half.z;
      if (p.c.z - ext > g + 0.35 || p.c.z + ext < g - 0.05) return;
      const c = Math.abs(Math.cos(p.yaw)), s = Math.abs(Math.sin(p.yaw)), ex = c * p.half.x + s * p.half.y + 0.12, ey = s * p.half.x + c * p.half.y + 0.12;
      addBox(p.c.x - ex, p.c.y - ey, p.c.x + ex, p.c.y + ey);
    } else if (p.kind === 'cyl') { if (p.c.z <= g + 0.35) addBox(p.c.x - p.r - 0.1, p.c.y - p.r - 0.1, p.c.x + p.r + 0.1, p.c.y + p.r + 0.1); }
    else if (p.c.z - p.r <= g + 0.35) addBox(p.c.x - p.r, p.c.y - p.r, p.c.x + p.r, p.c.y + p.r);
  };
  for (const p of map.prims) visit(p);
  for (const p of map.decor ?? []) visit(p);
  for (const t of map.trees) addBox(t.x - t.r * 0.2, t.y - t.r * 0.2, t.x + t.r * 0.2, t.y + t.r * 0.2);
  return (x: number, y: number) => {
    const l = grid.get(key(Math.floor(x / cell), Math.floor(y / cell)));
    return !!l && l.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  };
}

export interface ClutterSpot { x: number; y: number; r: number }

/**
 * Scatter points (ENU) on a jittered 0.5 m grid inside the given circles: density falls off towards
 * each circle's rim, nothing lands on a primitive's footprint. Deterministic per map.
 */
export function clutterPoints(map: MapDef, spots: ClutterSpot[], density: number, seed = 977): { x: number; y: number; k: number }[] {
  const blocked = footprints(map), rnd = seededRandom(seed), out: { x: number; y: number; k: number }[] = [];
  const G = 0.5, seen = new Set<number>();
  for (const s of spots) for (let gx = Math.floor((s.x - s.r) / G); gx <= Math.ceil((s.x + s.r) / G); gx++) for (let gy = Math.floor((s.y - s.r) / G); gy <= Math.ceil((s.y + s.r) / G); gy++) {
    const id = (gx + 100000) * 200003 + gy;
    if (seen.has(id)) continue;
    // strength of the densest spot covering this cell
    let w = 0;
    for (const t of spots) { const d = Math.hypot(gx * G - t.x, gy * G - t.y) / t.r; if (d < 1) w = Math.max(w, 1 - d * d); }
    if (w <= 0) continue;
    seen.add(id);
    // fixed number of draws per cell keeps the pattern independent of the spot order
    const a = rnd(), b = rnd(), c = rnd(), k = rnd();
    if (a > density * G * G * w) continue;
    const x = (gx + b) * G, y = (gy + c) * G;
    if (Math.abs(x) > map.size * 1.1 || Math.abs(y) > map.size * 1.1 || blocked(x, y)) continue;
    out.push({ x, y, k });
  }
  return out;
}

/** Three crossed vertical cards, base at y = 0, height 1 (scaled per instance). Normals up: lit like the ground under them. */
function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI + 0.3, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5, b = pos.length / 3;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let k = 0; k < 4; k++) nrm.push(0, 1, 0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function pebbleGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0), p = g.getAttribute('position'), rnd = seededRandom(5);
  // knobbly, flattened, sitting a little into the ground
  const jitter = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!jitter.has(k)) jitter.set(k, 0.75 + rnd() * 0.5);
    const j = jitter.get(k)!;
    p.setXYZ(i, p.getX(i) * j, p.getY(i) * j * 0.55 + 0.25, p.getZ(i) * j);
  }
  g.computeVertexNormals();
  return g;
}

export interface Clutter {
  meshes: THREE.InstancedMesh[];
  /** Hide the chunks beyond tuft range of the camera (they'd draw nothing but still cost a draw). */
  update(cam: THREE.Vector3): void;
  dispose(): void;
}
const CLUTTER_CHUNK = 16, CLUTTER_RANGE = 30;

/**
 * Tufts and pebbles within ~20 m of the spawn and ~8 m of each gate, in 16 m chunks that are only
 * drawn near the camera. A stadium pitch is mown: its tufts are a few centimetres tall (still the
 * texture that shows height when skimming the ground).
 */
export function buildClutter(map: MapDef, u: WorldUniforms, tuftTex: THREE.Texture): Clutter | null {
  if (map.ground === false || map.quake) return null;
  const disp: { dispose(): void }[] = [];
  const T = <X extends { dispose(): void }>(x: X) => (disp.push(x), x);
  const spots: ClutterSpot[] = [{ x: map.spawn.pos.x, y: map.spawn.pos.y, r: 20 }, ...map.gates.map((g) => ({ x: g.c.x, y: g.c.y, r: 8 }))];
  const grass = map.groundMat === 'grass', mown = map.id === 'field';
  const meshes: THREE.InstancedMesh[] = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const chunked = (pts: { x: number; y: number; k: number }[], geo: THREE.BufferGeometry, mat: THREE.Material, place: (t: { x: number; y: number; k: number }, im: THREE.InstancedMesh, i: number) => void) => {
    const cells = new Map<number, typeof pts>();
    for (const t of pts) { const key = Math.floor(t.x / CLUTTER_CHUNK) * 65536 + Math.floor(t.y / CLUTTER_CHUNK); let l = cells.get(key); if (!l) cells.set(key, (l = [])); l.push(t); }
    for (const list of cells.values()) {
      const im = T(new THREE.InstancedMesh(geo, mat, list.length));
      list.forEach((t, i) => place(t, im, i));
      im.receiveShadow = true;
      im.computeBoundingSphere();
      meshes.push(im);
    }
  };
  const tufts = clutterPoints(map, spots, grass ? (mown ? 1.1 : 2.2) : 0.5);
  if (tufts.length) {
    const mat = T(patchMaterial(new THREE.MeshStandardMaterial({ map: tuftTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, color: grass ? (mown ? 0xe2ecc8 : 0xc4d0a8) : 0xc8b890 }), u, 'grass', { alphaMips: 128, noNormalFlip: true }));
    chunked(tufts, T(tuftGeometry()), mat, (t, im, i) => {
      const h = mown ? 0.045 + t.k * 0.04 : 0.12 + t.k * 0.2, w = h * (mown ? 2.2 : 1.3);
      im.setMatrixAt(i, m4.compose(p.set(t.x, map.terrain(t.x, t.y) - 0.01, -t.y), q.setFromAxisAngle(Y, t.k * 40), s.set(w, h, w)));
    });
  }
  const pebbles = clutterPoints(map, spots.map((x) => ({ ...x, r: x.r * 0.9 })), grass ? (mown ? 0 : 0.25) : 1.6, 4111);
  if (pebbles.length) {
    const mat = T(patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.92, flatShading: true }), u, 'pebble'));
    const rnd = seededRandom(78);
    chunked(pebbles, T(pebbleGeometry()), mat, (t, im, i) => {
      const r = 0.025 + Math.pow(t.k, 3) * 0.12;
      q.setFromEuler(new THREE.Euler(rnd() * 0.4, rnd() * 6.3, rnd() * 0.4));
      im.setMatrixAt(i, m4.compose(p.set(t.x, map.terrain(t.x, t.y) - r * 0.2, -t.y), q, s.set(r * (0.8 + rnd() * 0.5), r, r * (0.8 + rnd() * 0.5))));
      const g = 0.2 + rnd() * 0.22; // weathered stone: a little lighter than the soil, not white
      im.setColorAt(i, col.setRGB(g * (1.05 + rnd() * 0.1), g, g * (0.88 + rnd() * 0.1)));
    });
  }
  if (!meshes.length) return null;
  const update = (cam: THREE.Vector3) => {
    for (const im of meshes) im.visible = im.boundingSphere!.distanceToPoint(cam) < CLUTTER_RANGE;
  };
  return { meshes, update, dispose() { for (const d of disp) d.dispose(); } };
}

// ---------------------------------------------------------------------------------------------

/** Painted pitch (lines + mowing stripes) on the terrain: a decal draped over the heightfield. */
export function pitchDecal(map: MapDef, tex: THREE.Texture, w: number, h: number): THREE.Mesh {
  const g = new THREE.PlaneGeometry(w, h, Math.round(w / 2), Math.round(h / 2));
  g.rotateX(-Math.PI / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setY(i, map.terrain(p.getX(i), -p.getZ(i)) + 0.004);
  g.computeVertexNormals();
  const m = new THREE.MeshStandardMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.renderOrder = -1; // before other transparent things (nets, glows)
  return mesh;
}
