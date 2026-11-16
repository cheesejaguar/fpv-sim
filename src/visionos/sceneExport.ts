// Scene export for a native renderer (the visionOS app, visionos/): walks the Three.js scene the web
// renderer draws and packs its meshes, materials and textures into one binary blob the native side
// rebuilds with its own engine (RealityKit). Every map source (built-in, Quake, Doom, map packages,
// glTF) therefore reaches the native renderer through the loaders that already exist here.
//
// Layout of the blob (little-endian):
//   u32 magic 'FPVS' (0x53565046) · u32 version · u32 jsonBytes · JSON (UTF-8) · padding to 4 bytes ·
//   buffers (each 4-byte aligned; the JSON refers to them as [offset, byteLength], the offset counted
//   from the first buffer byte, i.e. from align4(12 + jsonBytes))
//
// What does not cross: shader-only looks (the sky dome, the ground's anti-repeat shading, wind sway,
// leaf-card trees and grass clutter, fog, bloom). Trees are rebuilt as low-poly solids from the map,
// the sky as an equirectangular gradient the native side also lights the scene with.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AppCtx } from '../app/context';
import { pilotPos } from '../maps/world';
import { cameraMountZ } from '../render/droneMesh';
import { courseCentre } from '../render/sky';
import { pitchTexture } from '../render/textures';

export const SCENE_MAGIC = 0x53565046, SCENE_VERSION = 1;

export type Part = 'world' | 'drone';
type Ref = [offset: number, byteLength: number];

export interface GeoJson { pos: Ref; nrm: Ref; uv: Ref | null; idx: Ref; verts: number; tris: number }
export interface MatJson {
  /** not lit (MeshBasicMaterial, glows, screens) */
  unlit: boolean;
  /** sRGB 0..1 */
  color: [number, number, number];
  opacity: number; transparent: boolean; alphaTest: number; doubleSided: boolean; additive: boolean;
  roughness: number; metalness: number;
  /** sRGB 0..1, already scaled by the emissive intensity */
  emissive: [number, number, number];
  /** index into textures, or -1 */
  map: number;
}
export interface TexJson { data: Ref; mime: string; width: number; height: number; repeat: boolean }
export interface MeshJson {
  id: number; name: string; geo: number; mat: number;
  /** column-major 4x4, relative to the part's root (world: the scene; drone: the quad's body) */
  m: number[];
  visible: boolean;
  /** drawn only for spectators: the camera body around the lens */
  fpvHidden: boolean;
  shadow: boolean;
}
export interface SceneJson {
  part: Part; seq: number;
  geos: GeoJson[]; mats: MatJson[]; texs: TexJson[]; meshes: MeshJson[];
  world?: {
    mapId: string; mapName: string;
    /** equirectangular sky (index into texs) */
    sky: number;
    sunDir: [number, number, number]; sunColor: [number, number, number]; sunIntensity: number;
    ambient: [number, number, number]; night: boolean;
    /** where the pilot stands (feet) and the way they face (towards the spawn), three space */
    pilot: [number, number, number]; pilotFace: [number, number, number];
    /** the course: centre and radius (m), for the tabletop view */
    focus: [number, number, number]; radius: number;
  };
  drone?: {
    /** lens position in the body (three-mapped body axes, relative to the CG) and the camera mount rotation */
    lens: [number, number, number]; mount: [number, number, number, number];
    wheelbase: number;
  };
}

/** A mesh the native side keeps in step with its Three.js original (transforms, visibility, tint). */
export interface Tracked { id: number; obj: THREE.Mesh; mat: THREE.Material; m: Float32Array; visible: boolean; sig: string }
export interface Exported { blob: Blob; json: SceneJson; tracked: Tracked[] }

const TEX_MAX = 1024, TEX_MAX_BIG = 2048;
/** Instanced meshes are baked into plain triangles up to this many vertices (per colour bucket). */
const BAKE_MAX_VERTS = 1_500_000;
const TERRAIN_MAX_VERTS = 700_000, TREES_MAX = 6000;

const _c = new THREE.Color(), _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _n = new THREE.Matrix3(), _v = new THREE.Vector3();
const srgb = (c: THREE.Color, k = 1): [number, number, number] => {
  _c.copy(c).multiplyScalar(k).convertLinearToSRGB();
  const q = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000;
  return [q(_c.r), q(_c.g), q(_c.b)];
};
const hexSrgb = (hex: number, k = 1) => srgb(new THREE.Color(hex), k);

/** Raw triangle data of one mesh, in the frame it will be drawn in. */
interface Tri { pos: Float32Array; nrm: Float32Array; uv: Float32Array | null; idx: Uint32Array }

type AnyAttr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

/** Read a geometry (or one of its groups) as plain arrays; uvT = [sx, sy, ox, oy] texture transform. */
function readGeometry(geo: THREE.BufferGeometry, o: { flip: boolean; flipV: boolean; uvT: number[] | null; start?: number; count?: number; wantUv: boolean }): Tri | null {
  const p = geo.getAttribute('position') as AnyAttr | undefined;
  if (!p || p.count < 3) return null;
  const n = p.count, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i * 3] = p.getX(i); pos[i * 3 + 1] = p.getY(i); pos[i * 3 + 2] = p.getZ(i); }
  let idx: Uint32Array;
  const gi = geo.getIndex();
  const total = gi ? gi.count : n, start = Math.max(0, o.start ?? 0), count = Math.min(total - start, o.count ?? Infinity);
  const tris = Math.floor(count / 3);
  if (tris <= 0) return null;
  idx = new Uint32Array(tris * 3);
  for (let i = 0; i < tris * 3; i++) idx[i] = gi ? gi.getX(start + i) : start + i;
  if (o.flip) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const nrm = new Float32Array(n * 3), na = geo.getAttribute('normal') as AnyAttr | undefined;
  if (na && na.count === n) {
    const s = o.flip ? -1 : 1;
    for (let i = 0; i < n; i++) { nrm[i * 3] = s * na.getX(i); nrm[i * 3 + 1] = s * na.getY(i); nrm[i * 3 + 2] = s * na.getZ(i); }
  } else faceNormals(pos, idx, nrm);
  let uv: Float32Array | null = null;
  const ua = geo.getAttribute('uv') as AnyAttr | undefined;
  if (o.wantUv && ua && ua.count === n) {
    uv = new Float32Array(n * 2);
    const [sx, sy, ox, oy] = o.uvT ?? [1, 1, 0, 0];
    for (let i = 0; i < n; i++) {
      const u = ua.getX(i) * sx + ox, v = ua.getY(i) * sy + oy;
      uv[i * 2] = u; uv[i * 2 + 1] = o.flipV ? 1 - v : v;
    }
  }
  return { pos, nrm, uv, idx };
}

/** Area-weighted vertex normals for geometry that has none. */
function faceNormals(pos: Float32Array, idx: Uint32Array, out: Float32Array) {
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { out[k] += nx; out[k + 1] += ny; out[k + 2] += nz; }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
  }
}

/** Copies of `t` placed by each matrix, as one mesh. */
function bake(t: Tri, mats: THREE.Matrix4[]): Tri {
  const nv = t.pos.length / 3, k = mats.length;
  const pos = new Float32Array(nv * 3 * k), nrm = new Float32Array(nv * 3 * k), uv = t.uv ? new Float32Array(nv * 2 * k) : null, idx = new Uint32Array(t.idx.length * k);
  mats.forEach((m, j) => {
    _n.getNormalMatrix(m);
    const flip = m.determinant() < 0;
    for (let i = 0; i < nv; i++) {
      _v.set(t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]).applyMatrix4(m);
      pos.set([_v.x, _v.y, _v.z], (j * nv + i) * 3);
      _v.set(t.nrm[i * 3], t.nrm[i * 3 + 1], t.nrm[i * 3 + 2]).applyMatrix3(_n).normalize();
      nrm.set([_v.x, _v.y, _v.z], (j * nv + i) * 3);
    }
    if (uv) uv.set(t.uv!, j * nv * 2);
    const o = j * t.idx.length;
    for (let i = 0; i < t.idx.length; i += 3) {
      idx[o + i] = t.idx[i] + j * nv;
      idx[o + i + 1] = t.idx[i + (flip ? 2 : 1)] + j * nv;
      idx[o + i + 2] = t.idx[i + (flip ? 1 : 2)] + j * nv;
    }
  });
  return { pos, nrm, uv, idx };
}

type Drawable = CanvasImageSource & { width: number; height: number };
/** The pixels of a texture as something a 2D canvas can draw, or null while it has none yet. */
function drawable(tex: THREE.Texture): Drawable | null {
  const img = tex.image as unknown;
  if (!img) return null;
  if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) return img.complete && img.naturalWidth > 0 ? img : null;
  if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) return img;
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) return img;
  if (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas) return img;
  const d = img as { data?: ArrayLike<number>; width?: number; height?: number };
  if (d.data && d.width && d.height && d.data.length === d.width * d.height * 4) {
    const c = document.createElement('canvas'); c.width = d.width; c.height = d.height;
    const id = new ImageData(new Uint8ClampedArray(d.data), d.width, d.height);
    c.getContext('2d')!.putImageData(id, 0, 0);
    return c;
  }
  return null;
}
/** true while a texture's image is still loading (the scene is exported again once it is in) */
export function texturePending(tex: THREE.Texture): boolean {
  const img = tex.image as unknown;
  return !img || (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement && !(img.complete && img.naturalWidth > 0));
}

const toBlob = (c: HTMLCanvasElement, mime: string, q?: number) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('texture encode failed'))), mime, q));

/** Equirectangular sky for the native sky dome and its image-based light: ground, haze, zenith, sun glow. */
function skyCanvas(ctx: AppCtx): HTMLCanvasElement {
  const env = ctx.scene.env, W = 1024, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const css = (hex: number, k = 1) => { const [r, gg, b] = hexSrgb(hex, k); return `rgb(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)})`; };
  const night = env.sky === 'night';
  const grad = g.createLinearGradient(0, 0, 0, H);
  // top row = straight up; the horizon is the middle row
  const zenith = night ? css(0x05070f) : env.sky === 'overcast' ? css(0x9aa4ad) : env.sky === 'dusk' ? css(0x44527e) : css(0x2f6fd0);
  grad.addColorStop(0, zenith);
  grad.addColorStop(0.36, night ? css(0x0b1020) : css(env.hemiSky, 0.92));
  grad.addColorStop(0.495, css(env.fogColor));
  grad.addColorStop(0.505, css(env.fogColor, 0.8));
  grad.addColorStop(0.56, css(env.hemiGround, 0.9));
  grad.addColorStop(1, css(env.hemiGround, 0.55));
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  // the sun (moon): direction -> longitude / latitude. u = 0.5 looks down -Z (three), u grows towards +X.
  const d = ctx.scene.sunDir, lon = Math.atan2(d.x, -d.z), lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
  const sx = (0.5 + lon / (2 * Math.PI)) * W, sy = (0.5 - lat / Math.PI) * H;
  for (const dx of [-W, 0, W]) {
    const r = night ? 26 : 90, rg = g.createRadialGradient(sx + dx, sy, 0, sx + dx, sy, r);
    const col = hexSrgb(env.sunColor).map((x) => Math.round(x * 255)).join(',');
    rg.addColorStop(0, `rgba(${col},1)`); rg.addColorStop(night ? 0.5 : 0.08, `rgba(${col},${night ? 0.9 : 0.95})`); rg.addColorStop(night ? 0.6 : 0.3, `rgba(${col},${night ? 0.1 : 0.28})`); rg.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = rg; g.fillRect(sx + dx - r, sy - r, 2 * r, 2 * r);
  }
  return c;
}

/** Low-poly solid trees from the map's tree list: one trunk mesh, one crown mesh per species. */
function treeGeometry(ctx: AppCtx): { bark: THREE.BufferGeometry | null; oak: THREE.BufferGeometry | null; pine: THREE.BufferGeometry | null } {
  const map = ctx.map, c = courseCentre(map);
  let list = map.trees;
  if (list.length > TREES_MAX) list = [...list].sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y)).slice(0, TREES_MAX);
  const bark: THREE.BufferGeometry[] = [], oak: THREE.BufferGeometry[] = [], pine: THREE.BufferGeometry[] = [];
  for (const t of list) {
    const gz = map.terrain(t.x, t.y), hs = Math.abs(Math.sin(t.x * 12.9898 + t.y * 78.233) * 43758.5453) % 1;
    const at = (g: THREE.BufferGeometry, y: number) => g.rotateY(hs * 6.283).translate(t.x, gz + y, -t.y);
    if (t.type === 'pine') {
      const th = t.h * 0.22;
      bark.push(at(new THREE.CylinderGeometry(t.r * 0.07, t.r * 0.1, th, 5, 1, true), th / 2));
      pine.push(at(new THREE.ConeGeometry(t.r, t.h * 0.5, 7, 1, false), th + t.h * 0.25));
      pine.push(at(new THREE.ConeGeometry(t.r * 0.68, t.h * 0.46, 7, 1, false), t.h * 0.77));
    } else {
      const th = t.h * 0.42;
      bark.push(at(new THREE.CylinderGeometry(t.r * 0.08, t.r * 0.12, th, 5, 1, true), th / 2));
      const crown = new THREE.IcosahedronGeometry(1, 1);
      crown.scale(t.r, (t.h - th) * 0.62, t.r);
      oak.push(at(crown, th + (t.h - th) * 0.5));
    }
  }
  const merge = (l: THREE.BufferGeometry[]) => { if (!l.length) return null; const m = mergeGeometries(l, false); for (const g of l) g.dispose(); return m; };
  return { bark: merge(bark), oak: merge(oak), pine: merge(pine) };
}

const hasAncestor = (o: THREE.Object3D, pred: (o: THREE.Object3D) => boolean, stop: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p && p !== stop; p = p.parent) if (pred(p)) return true; return false; };
export const shownInTree = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };

/** What a material looks like, as far as the native renderer follows it live (see NativeHost's diff). */
export function materialSig(m: THREE.Material): string {
  const s = m as THREE.MeshStandardMaterial;
  const col = s.color ? srgb(s.color).join(',') : '';
  const em = s.emissive ? srgb(s.emissive, s.emissiveIntensity ?? 1).join(',') : '';
  return `${col}|${Math.round(m.opacity * 50)}|${em}`;
}

export function materialJson(m: THREE.Material, map: number, tint?: THREE.Color): MatJson {
  const s = m as THREE.MeshStandardMaterial;
  const unlit = !(s.isMeshStandardMaterial || (m as THREE.MeshLambertMaterial).isMeshLambertMaterial || (m as THREE.MeshPhongMaterial).isMeshPhongMaterial);
  const base = s.color ? _c.copy(s.color) : _c.set(0xffffff);
  const color = srgb(tint ? base.clone().multiply(tint) : base);
  const emissive: [number, number, number] = s.emissive ? srgb(s.emissive, s.emissiveIntensity ?? 1) : [0, 0, 0];
  return {
    unlit, color, opacity: m.opacity, transparent: m.transparent, alphaTest: m.alphaTest, doubleSided: m.side === THREE.DoubleSide,
    additive: m.blending === THREE.AdditiveBlending, roughness: s.roughness ?? 0.9, metalness: s.metalness ?? 0, emissive, map,
  };
}

/** Meshes of the part, in a stable traversal order (also used for the scene's change signature). */
export function partMeshes(ctx: AppCtx, part: Part): THREE.Mesh[] {
  const out: THREE.Mesh[] = [], drone = ctx.drone.root, root = part === 'drone' ? drone : ctx.scene.scene;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (part === 'world' && hasAncestor(o, (p) => p === drone, root)) return;
    if (part === 'world' && hasAncestor(o, (p) => p.name === 'trees' || p.name === 'clutter', root)) return;
    out.push(m);
  });
  return out;
}

export async function exportPart(ctx: AppCtx, part: Part, seq: number): Promise<Exported> {
  const scene = ctx.scene.scene, droneRoot = ctx.drone.root;
  scene.updateMatrixWorld(true);
  if (part === 'drone') _inv.copy(droneRoot.matrixWorld).invert();

  const bufs: (ArrayBufferView | Blob)[] = [], refs: Ref[] = [];
  const addBuf = (b: ArrayBufferView | Blob): Ref => { const r: Ref = [0, b instanceof Blob ? b.size : b.byteLength]; bufs.push(b); refs.push(r); return r; };
  const geos: GeoJson[] = [], mats: MatJson[] = [], texs: TexJson[] = [], meshes: MeshJson[] = [], tracked: Tracked[] = [];
  const addGeo = (t: Tri): number => {
    geos.push({ pos: addBuf(t.pos), nrm: addBuf(t.nrm), uv: t.uv ? addBuf(t.uv) : null, idx: addBuf(t.idx), verts: t.pos.length / 3, tris: t.idx.length / 3 });
    return geos.length - 1;
  };
  const geoCache = new Map<string, number>(), texCache = new Map<string, number>(), matCache = new Map<string, number>();
  const texJobs: Promise<void>[] = [];
  const addCanvasTex = (src: Drawable, alpha: boolean, repeat: boolean, max = TEX_MAX): number => {
    const k = Math.min(1, max / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(src, 0, 0, w, h);
    const mime = alpha ? 'image/png' : 'image/jpeg';
    const t: TexJson = { data: [0, 0], mime, width: w, height: h, repeat };
    texs.push(t);
    texJobs.push(toBlob(c, mime, 0.88).then((b) => { t.data = addBuf(b); }));
    return texs.length - 1;
  };
  const addTex = (tex: THREE.Texture | null | undefined, alpha: boolean): number => {
    if (!tex) return -1;
    const key = `${tex.uuid}|${alpha ? 1 : 0}`, had = texCache.get(key);
    if (had !== undefined) return had;
    const src = drawable(tex);
    if (!src) return -1;
    const i = addCanvasTex(src, alpha, tex.wrapS === THREE.RepeatWrapping || tex.wrapT === THREE.RepeatWrapping, Math.max(src.width, src.height) > 2048 ? TEX_MAX_BIG : TEX_MAX);
    texCache.set(key, i);
    return i;
  };
  let nextId = 0;
  const pushMesh = (name: string, geo: number, mat: number, m: THREE.Matrix4 | null, visible: boolean, fpvHidden: boolean, shadow: boolean) => {
    meshes.push({ id: nextId, name, geo, mat, m: m ? Array.from(m.elements) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], visible, fpvHidden, shadow });
    return nextId++;
  };
  const fpvHidden = new Set<THREE.Object3D>();
  if (part === 'drone') for (const h of ctx.drone.fpvHidden) h.traverse((o) => fpvHidden.add(o));

  const all = partMeshes(ctx, part), terrainTiles = all.filter((m) => m.name === 'terrain').length || 1;
  for (const mesh of all) {
    const im = mesh as THREE.InstancedMesh, instanced = !!im.isInstancedMesh;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = Array.isArray(mesh.material) && mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
    // terrain tiles swap their geometry between LOD levels while the web renderer draws: export the finest
    const levels = mesh.userData.levels as THREE.BufferGeometry[] | undefined;
    let geom = levels?.[0] ?? mesh.geometry;
    if (levels) for (const lv of levels) { geom = lv; if ((lv.getAttribute('position')?.count ?? 0) * terrainTiles <= TERRAIN_MAX_VERTS) break; }
    // instanced meshes placed by their own shader attributes can't be rebuilt from matrices
    if (instanced && Object.entries(geom.attributes).some(([k, a]) => (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute && k !== 'instanceMatrix' && k !== 'instanceColor')) continue;
    for (const g of groups) {
      const mat = list[g.materialIndex ?? 0] ?? list[0];
      if (!mat || !mat.visible) continue;
      const sm = mat as THREE.ShaderMaterial;
      if (sm.isShaderMaterial || (mat as THREE.MeshDepthMaterial).isMeshDepthMaterial) continue; // sky dome, special passes
      const std = mat as THREE.MeshStandardMaterial;
      const tex = std.map ?? null;
      const alpha = mat.transparent || mat.alphaTest > 0;
      const map = addTex(tex, alpha);
      const uvT = tex && map >= 0 && (tex.repeat.x !== 1 || tex.repeat.y !== 1 || tex.offset.x !== 0 || tex.offset.y !== 0) ? [tex.repeat.x, tex.repeat.y, tex.offset.x, tex.offset.y] : null;
      const flip = mat.side === THREE.BackSide, flipV = !!tex && !tex.flipY;
      const gkey = `${geom.uuid}|${g.start}|${g.count}|${flip ? 1 : 0}|${flipV ? 1 : 0}|${uvT?.join(',') ?? ''}|${map >= 0 ? 1 : 0}`;
      const tri = () => readGeometry(geom, { flip, flipV, uvT, start: g.start, count: g.count, wantUv: map >= 0 });
      const rel = part === 'drone' ? _m.multiplyMatrices(_inv, mesh.matrixWorld).clone() : mesh.matrixWorld.clone();
      const shown = shownInTree(mesh), hidden = fpvHidden.has(mesh), shadow = mesh.castShadow;

      if (instanced) {
        if (im.count <= 0) continue;
        const t = tri();
        if (!t) continue;
        // per-instance colours: one baked mesh per (quantised) colour, since the native PBR material has no vertex colours
        const buckets = new Map<number, { col: THREE.Color; mats: THREE.Matrix4[] }>();
        for (let i = 0; i < im.count; i++) {
          const mi = new THREE.Matrix4(); im.getMatrixAt(i, mi); mi.premultiply(rel);
          let key = 0xffffff; const col = new THREE.Color(1, 1, 1);
          if (im.instanceColor) { im.getColorAt(i, col); key = Math.round(col.r * 4) * 25 + Math.round(col.g * 4) * 5 + Math.round(col.b * 4); }
          let b = buckets.get(key); if (!b) buckets.set(key, (b = { col, mats: [] }));
          b.mats.push(mi);
        }
        for (const b of buckets.values()) {
          const room = Math.floor(BAKE_MAX_VERTS / (t.pos.length / 3));
          if (b.mats.length > room) b.mats.length = room;
          mats.push(materialJson(mat, map, im.instanceColor ? b.col : undefined));
          pushMesh(mesh.name || 'instances', addGeo(bake(t, b.mats)), mats.length - 1, null, shown, hidden, false);
        }
        continue;
      }
      let gi = geoCache.get(gkey);
      if (gi === undefined) {
        const t = tri();
        if (!t) continue;
        gi = addGeo(t); geoCache.set(gkey, gi);
      }
      const mkey = `${mat.uuid}|${map}`;
      let mi = matCache.get(mkey);
      if (mi === undefined) { mats.push(materialJson(mat, map)); mi = mats.length - 1; matCache.set(mkey, mi); }
      const id = pushMesh(mesh.name, gi, mi, rel, shown, hidden, shadow);
      tracked.push({ id, obj: mesh, mat, m: Float32Array.from(rel.elements), visible: shown, sig: materialSig(mat) });
    }
  }

  const json: SceneJson = { part, seq, geos, mats, texs, meshes };
  if (part === 'world') {
    const map = ctx.map, env = ctx.scene.env;
    // trees: low-poly stand-ins for the instanced leaf cards
    const tg = treeGeometry(ctx);
    const solid = (g: THREE.BufferGeometry | null, hex: number, name: string) => {
      if (!g) return;
      const t = readGeometry(g, { flip: false, flipV: false, uvT: null, wantUv: false });
      g.dispose();
      if (!t) return;
      mats.push({ unlit: false, color: hexSrgb(hex), opacity: 1, transparent: false, alphaTest: 0, doubleSided: name === 'tree-bark', additive: false, roughness: 0.95, metalness: 0, emissive: [0, 0, 0], map: -1 });
      pushMesh(name, addGeo(t), mats.length - 1, null, true, false, true);
    };
    solid(tg.bark, 0x4a3a2a, 'tree-bark'); solid(tg.oak, 0x3f6a2c, 'tree-oak'); solid(tg.pine, 0x27482b, 'tree-pine');
    // the stadium's painted pitch is part of the ground shader on the web: here a decal just above the grass
    if (map.ground !== false && (map.id === 'field' || (map as unknown as { pitch?: boolean }).pitch)) {
      const w = 120, h = 73, y = map.terrain(0, 0) + 0.04, pt = pitchTexture(w, h);
      const pos = new Float32Array([-w / 2, y, h / 2, w / 2, y, h / 2, w / 2, y, -h / 2, -w / 2, y, -h / 2]);
      const tri: Tri = { pos, nrm: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), idx: new Uint32Array([0, 1, 2, 0, 2, 3]) };
      mats.push({ unlit: false, color: [1, 1, 1], opacity: 1, transparent: true, alphaTest: 0, doubleSided: false, additive: false, roughness: 0.95, metalness: 0, emissive: [0, 0, 0], map: addCanvasTex(pt.image as HTMLCanvasElement, true, false, TEX_MAX_BIG) });
      pushMesh('pitch', addGeo(tri), mats.length - 1, null, true, false, false);
      pt.dispose();
    }
    const pilot = pilotPos(map, { x: 0, y: 0, z: 0 }), c = courseCentre(map);
    let radius = 12;
    for (const g of map.gates) radius = Math.max(radius, Math.hypot(g.c.x - c.x, g.c.y - c.y) + 6);
    radius = Math.max(radius, Math.hypot(map.spawn.pos.x - c.x, map.spawn.pos.y - c.y) + 4);
    const d = ctx.scene.sunDir;
    json.world = {
      mapId: map.id, mapName: map.name,
      sky: addCanvasTex(skyCanvas(ctx), false, false),
      sunDir: [d.x, d.y, d.z], sunColor: hexSrgb(env.sunColor), sunIntensity: env.sunIntensity,
      ambient: hexSrgb(env.hemiSky), night: env.sky === 'night',
      pilot: [pilot.x, pilot.z - 1.6, -pilot.y], pilotFace: [map.spawn.pos.x - pilot.x, 0, -(map.spawn.pos.y - pilot.y)],
      focus: [c.x, c.z, -c.y], radius: Math.min(radius, map.size),
    };
  } else {
    const b = ctx.build.info, f = b.components.frame;
    const lens = ctx.drone.lens ?? new THREE.Vector3(f.plateLengthMm / 2000 + 0.006 - b.cgMm.x / 1000, cameraMountZ(f, b.components.motor) - b.cgMm.z / 1000, 0);
    json.drone = { lens: [lens.x, lens.y, lens.z], mount: [ctx.mountQ.x, ctx.mountQ.y, ctx.mountQ.z, ctx.mountQ.w], wheelbase: f.wheelbaseMm / 1000 };
  }

  await Promise.all(texJobs);
  // buffers follow the header, 4-byte aligned; their offsets count from the first buffer byte
  let off = 0;
  for (const r of refs) { r[0] = off; off += r[1]; off += (4 - (off % 4)) % 4; }
  const body = new TextEncoder().encode(JSON.stringify(json));
  const base = 12 + body.length + ((4 - ((12 + body.length) % 4)) % 4);
  const parts: BlobPart[] = [];
  const head = new DataView(new ArrayBuffer(12));
  head.setUint32(0, SCENE_MAGIC, true); head.setUint32(4, SCENE_VERSION, true); head.setUint32(8, body.length, true);
  parts.push(head.buffer, body as unknown as BlobPart);
  let at = 12 + body.length;
  const pad = (to: number) => { if (to > at) { parts.push(new Uint8Array(to - at)); at = to; } };
  bufs.forEach((b, i) => { pad(base + refs[i][0]); parts.push(b as BlobPart); at += refs[i][1]; });
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), json, tracked };
}

