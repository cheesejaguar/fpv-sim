// Visible wind: flag-gate banners as waving cloth (vertex shader, sway.ts) and a windsock beside
// the pilot box that swings downwind and lifts with wind speed (a standard sock is fully out at
// 15 kt; each of its five stripes is ~3 kt).
import * as THREE from 'three';
import { FLAG } from '../maps/gates';
import { BoxPrim, MapDef, pilotPos, Prim } from '../maps/world';
import { courseCentre } from './sky';
import { patchMaterial, WorldUniforms } from './sway';

/** Cloth for a flag banner box: a 10 x 14 grid in the banner's plane, placed like the box (primMatrix). */
export function flagCloth(pr: BoxPrim, mat: THREE.Material, depth: THREE.Material): THREE.Mesh {
  const L = pr.half.y * 2, H = pr.half.z * 2, nu = 10, nv = 14;
  const pos: number[] = [], uv: number[] = [], fl: number[] = [], nrm: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = i / nu, v = j / nv;
    // three local: x = banner normal (ENU local x), y up, z = ENU local -y (from the pole side to the free edge)
    pos.push(0, -H / 2 + v * H, -L / 2 + u * L); nrm.push(1, 0, 0); uv.push(u, v); fl.push(u, v);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + nu + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFlag', new THREE.Float32BufferAttribute(fl, 2));
  g.setIndex(idx);
  g.computeBoundingSphere(); g.boundingSphere!.radius += 0.2; // room for the wave
  const m = new THREE.Mesh(g, mat);
  m.position.set(pr.c.x, pr.c.z, -pr.c.y); m.rotation.y = pr.yaw;
  m.castShadow = true; m.receiveShadow = true; m.customDepthMaterial = depth;
  return m;
}

/** Cloth materials (one per gate colour): patched for the wave; the depth copy keeps the shadow waving. */
export function clothMaterials(u: WorldUniforms, map: THREE.Texture, color: number) {
  const len = { uFlagLen: { value: FLAG.halfLen * 2 } };
  return {
    mat: patchMaterial(new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.7, emissive: color, emissiveIntensity: 0.12 }), u, 'flag', {}, len),
    depth: patchMaterial(new THREE.MeshDepthMaterial({ side: THREE.DoubleSide }), u, 'flag', { depth: true }, len),
  };
}

// ---------------------------------------------------------------------------------------------

const SOCK_POLE = 4.2, SOCK_LEN = 1.3;

/**
 * Where to plant the windsock: beside the pilot (not in front of them, towards the course), on
 * clear ground (no primitive within 0.7 m below 5 m, no tree), nearest first. ENU; null indoors.
 */
export function windsockSpot(map: MapDef): { x: number; y: number; z: number } | null {
  if (map.quake || map.ground === false || (map.windScale ?? 1) < 0.5) return null;
  const pilot = pilotPos(map, { x: 0, y: 0, z: 0 }), c = courseCentre(map);
  const fwd = Math.atan2(c.y - pilot.y, c.x - pilot.x);
  const clear = (x: number, y: number) => {
    const g = map.terrain(x, y);
    if (Math.abs(x) > map.size || Math.abs(y) > map.size) return false;
    for (const t of map.trees) if (Math.hypot(t.x - x, t.y - y) < t.r * 1.2) return false;
    for (const p of [...map.prims, ...(map.decor ?? [])] as Prim[]) {
      if (p.kind === 'brush') continue;
      let x0: number, x1: number, y0: number, y1: number, z0: number, z1: number;
      if (p.kind === 'box') {
        const cs = Math.abs(Math.cos(p.yaw)), sn = Math.abs(Math.sin(p.yaw)), ex = cs * p.half.x + sn * p.half.y, ey = sn * p.half.x + cs * p.half.y, ez = Math.hypot(p.half.x, p.half.z);
        x0 = p.c.x - ex; x1 = p.c.x + ex; y0 = p.c.y - ey; y1 = p.c.y + ey; z0 = p.c.z - ez; z1 = p.c.z + ez;
      } else if (p.kind === 'cyl') { x0 = p.c.x - p.r; x1 = p.c.x + p.r; y0 = p.c.y - p.r; y1 = p.c.y + p.r; z0 = p.c.z; z1 = p.c.z + p.h; }
      else { x0 = p.c.x - p.r; x1 = p.c.x + p.r; y0 = p.c.y - p.r; y1 = p.c.y + p.r; z0 = p.c.z - p.r; z1 = p.c.z + p.r; }
      if (z1 < g || z0 > g + SOCK_POLE + 1) continue;
      if (x >= x0 - 0.7 && x <= x1 + 0.7 && y >= y0 - 0.7 && y <= y1 + 0.7) return false;
    }
    return true;
  };
  // sideways first (left / right of the line to the course), then behind; never nearer the course
  // than the pilot (that's where the quads fly: the sock is scenery, it doesn't collide)
  const angles = [90, -90, 120, -120, 150, -150, 180].map((d) => fwd + (d * Math.PI) / 180), dc = Math.hypot(c.x - pilot.x, c.y - pilot.y);
  for (const d of [3, 5, 8, 11, 14, 18, 24]) for (const a of angles) {
    const x = pilot.x + Math.cos(a) * d, y = pilot.y + Math.sin(a) * d;
    if (Math.hypot(c.x - x, c.y - y) >= dc && clear(x, y)) return { x, y, z: map.terrain(x, y) };
  }
  return null;
}

export interface Windsock { object: THREE.Group; update(flowX: number, flowZ: number, speedMs: number, t: number): void; dispose(): void }

/** Windsock at an ENU spot: pole and a striped orange / white sock (5 bands) on a swivel (two draws). */
export function buildWindsock(spot: { x: number; y: number; z: number }): Windsock {
  const disp: { dispose(): void }[] = [];
  const T = <X extends { dispose(): void }>(x: X) => (disp.push(x), x);
  const root = new THREE.Group();
  root.position.set(spot.x, spot.z, -spot.y);
  const metal = T(new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.45, metalness: 0.6 }));
  const pole = new THREE.Mesh(T(new THREE.CylinderGeometry(0.03, 0.045, SOCK_POLE, 8)), metal);
  pole.position.y = SOCK_POLE / 2; pole.castShadow = true;
  // stripes: a 1 x 5 texture along the sock (v runs mouth -> tail after the rotation below)
  const px = new Uint8Array([255, 90, 31, 255, 245, 245, 240, 255, 255, 90, 31, 255, 245, 245, 240, 255, 255, 90, 31, 255]);
  const stripes = T(new THREE.DataTexture(px, 1, 5));
  stripes.magFilter = THREE.NearestFilter; stripes.colorSpace = THREE.SRGBColorSpace; stripes.needsUpdate = true;
  const sockGeo = T(new THREE.CylinderGeometry(0.2, 0.085, SOCK_LEN, 16, 5, true));
  sockGeo.rotateZ(Math.PI / 2); sockGeo.translate(SOCK_LEN / 2, 0, 0); // axis along +x: mouth at the pivot, tail downwind
  const sock = new THREE.Mesh(sockGeo, T(new THREE.MeshStandardMaterial({ map: stripes, side: THREE.DoubleSide, roughness: 0.8 })));
  sock.castShadow = true;
  const pivot = new THREE.Group();
  pivot.position.y = SOCK_POLE - 0.1; pivot.rotation.order = 'YZX';
  pivot.add(sock);
  root.add(pole, pivot);
  let yaw = 0, droop = 1.3, lastT = -1;
  return {
    object: root,
    update(fx, fz, speed, t) {
      // swing towards the flow (smoothed like a real swivel), lift with speed, flutter in gusts
      const target = Math.atan2(-fz, fx), dt = lastT < 0 ? 1e3 : Math.min(0.2, Math.max(0, t - lastT));
      lastT = t;
      const kYaw = 1 - Math.exp(-dt / 0.4), kLift = 1 - Math.exp(-dt / 0.3);
      yaw += Math.atan2(Math.sin(target - yaw), Math.cos(target - yaw)) * kYaw;
      const out = Math.min(1, speed / 7.7), want = THREE.MathUtils.degToRad(80) * Math.pow(1 - out, 1.4);
      droop += (want - droop) * kLift;
      const fl = Math.min(1, speed / 4) * (1 - 0.6 * out);
      pivot.rotation.y = yaw + Math.sin(t * 1.9) * 0.06 * fl + Math.sin(t * 5.3) * 0.02 * out;
      pivot.rotation.z = -droop + Math.sin(t * 3.7) * 0.04 * fl;
    },
    dispose() { for (const d of disp) d.dispose(); },
  };
}
