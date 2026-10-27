// Thumbnails for the Place panel, as in Unity's Project window and Unreal's Content Browser: each
// gate, primitive and prefab rendered in 3D (its real parts, from buildMapDef) on a transparent
// tile. Made with the app's own renderer into a render target, a couple per frame so opening the
// editor never stalls, and kept for the page's lifetime.
import * as THREE from 'three';
import { buildMapDef, type MapDocV1 } from '../maps/mapFormat';
import type { Prim } from '../maps/world';
import { primMatrix } from '../render/scene';
import { TEMPLATES } from './templates';

/** What a thumbnail shows: map.json gates and primitives around the origin. */
export interface ThumbSpec { gates?: MapDocV1['gates']; primitives?: MapDocV1['primitives'] }

const W = 176, H = 132;
const cache = new Map<string, string>();
const VISUAL: Record<string, number> = {
  gate: 0xff6a00, pad: 0x64748b, metal: 0x8a8f94, wood: 0x9c7a4f, brick: 0xa0523d, glass: 0x7dd3fc, plain: 0xd4d4d4,
  concrete: 0xb0aca4, led: 0x22d3ee, banner: 0xe11d48, screen: 0x1f2937, net: 0x9ca3af,
};

function colorOf(p: Exclude<Prim, { kind: 'brush' }>): number {
  if (p.color !== undefined) return p.color;
  const v = p.kind === 'box' ? p.visual : undefined;
  return VISUAL[v ?? p.mat] ?? VISUAL[p.mat] ?? 0xb0aca4;
}

export class Thumbs {
  private queue: { key: string; spec: () => ThumbSpec }[] = [];
  private queued = new Set<string>();
  private made = 0;

  constructor(private renderer: THREE.WebGLRenderer, private onReady: () => void) {}

  /** The thumbnail's image URL, or null while it is still to be made (it is queued). */
  get(key: string, spec: () => ThumbSpec): string | null {
    const u = cache.get(key);
    if (u) return u;
    if (!this.queued.has(key)) { this.queued.add(key); this.queue.push({ key, spec }); }
    return null;
  }

  /** Per frame: make up to two queued thumbnails; the panel redraws when a batch is done. */
  pump() {
    if (!this.queue.length) return;
    for (let i = 0; i < 2 && this.queue.length; i++) {
      const { key, spec } = this.queue.shift()!;
      this.queued.delete(key);
      try { cache.set(key, this.render(spec())); } catch (e) { console.warn('editor thumbnail', key, e); cache.set(key, ''); }
      this.made++;
    }
    if (!this.queue.length || this.made % 8 === 0) this.onReady();
  }

  private render(spec: ThumbSpec): string {
    const doc: MapDocV1 = { ...TEMPLATES[0].make(), gates: spec.gates, primitives: spec.primitives };
    const def = buildMapDef(doc, { hf: undefined, baseDef: null, meshes: [] }, () => '');
    const scene = new THREE.Scene(), mats = new Map<number, THREE.Material>(), geos: THREE.BufferGeometry[] = [];
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a48, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(4, 7, 5); scene.add(sun);
    const box = new THREE.Box3();
    for (const p of [...def.prims, ...(def.decor ?? [])]) {
      if (p.kind === 'brush') continue;
      const geo = p.kind === 'box' ? new THREE.BoxGeometry(p.half.x * 2, p.half.z * 2, p.half.y * 2) : p.kind === 'cyl' ? new THREE.CylinderGeometry(p.r, p.r, p.h, 20) : new THREE.SphereGeometry(p.r, 24, 16);
      geos.push(geo);
      const c = colorOf(p);
      let m = mats.get(c);
      if (!m) { m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, metalness: 0.05 }); mats.set(c, m); }
      const mesh = new THREE.Mesh(geo, m);
      mesh.applyMatrix4(primMatrix(p, new THREE.Matrix4()));
      scene.add(mesh);
      box.expandByObject(mesh);
    }
    const cam = new THREE.PerspectiveCamera(28, W / H, 0.05, 2000);
    const s = box.isEmpty() ? new THREE.Sphere(new THREE.Vector3(), 1) : box.getBoundingSphere(new THREE.Sphere());
    const dir = new THREE.Vector3(1, 0.72, 1.3).normalize(), d = (s.radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.02;
    cam.position.copy(s.center).addScaledVector(dir, d); cam.lookAt(s.center);
    const r = this.renderer, rt = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    // (no light here casts shadows; a pending shadow-map update stays for the map's own render)
    const prevRt = r.getRenderTarget(), prevColor = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha(), prevShadow = r.shadowMap.needsUpdate;
    const px = new Uint8Array(W * H * 4);
    try {
      r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear();
      r.render(scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, W, H, px);
    } finally {
      r.setRenderTarget(prevRt); r.setClearColor(prevColor, prevAlpha); r.shadowMap.needsUpdate = prevShadow;
      rt.dispose(); for (const g of geos) g.dispose(); for (const m of mats.values()) m.dispose();
    }
    // rows come bottom-up
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d')!, img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    g.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }
}
