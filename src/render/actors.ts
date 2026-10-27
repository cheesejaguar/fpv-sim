// The map's actors drawn in flight (MapDef.actors, src/sim/actors.ts): RF emitters as masts with
// their antenna, ground stations, detector heads (optionally with their field of view as a
// translucent cone), and targets (box, sphere, cylinder, a small quad, a vehicle, a person). Actors
// on a path move: update(actorT) places them at the same positions the simulation uses (posAt,
// headingAt are pure functions of actor time). Targets carry the ground-truth class 'target'.
// Loaded on demand (scene.ts imports it for maps that have actors).
import * as THREE from 'three';
import type { ActorDef, MapDef } from '../maps/world';
import { headingAt, posAt } from '../sim/actors';
import type { V3 } from '../sim/math';
import { enuToThree } from './coords';

const MAST = 0x8a8f96, DARK = 0x2a2d33, EMIT = 0xff3b30, STATION = 0x3aa0ff, DETECT = 0xffc400;

export class ActorsView {
  readonly group = new THREE.Group();
  private readonly moving: { a: ActorDef; obj: THREE.Object3D }[] = [];
  private readonly cones: THREE.Object3D[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly tmp: V3 = { x: 0, y: 0, z: 0 };
  private readonly mats = new Map<string, THREE.Material>();

  constructor(private readonly map: MapDef) {
    this.group.name = 'actors';
    let targets = 0;
    for (const a of map.actors ?? []) {
      const obj = this.build(a);
      obj.name = `actor-${a.id}`;
      // ground truth: each target its own instance (1-based, map order)
      if (a.type === 'target') obj.userData.gt = { cls: 'target', id: ++targets };
      this.place(a, obj, 0);
      this.group.add(obj);
      if (a.path) this.moving.push({ a, obj });
    }
    this.setFovCones(false);
  }

  /** Move the actors on paths to where they are at actor time t (s). */
  update(t: number) {
    for (const m of this.moving) this.place(m.a, m.obj, t);
  }

  /** Show the detectors' fields of view (translucent cones out to their range, at most 120 m). */
  setFovCones(on: boolean) { for (const c of this.cones) c.visible = on; }

  dispose() {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
    for (const m of this.mats.values()) m.dispose();
  }

  private place(a: ActorDef, obj: THREE.Object3D, t: number) {
    const p = posAt(a, this.map.paths, t, this.tmp);
    enuToThree(p.x, p.y, p.z, obj.position);
    // moving things face along their travel
    if (a.path) obj.rotation.y = headingAt(a, this.map.paths, t);
  }

  private mat(color: number, emissive = 0, opts: { transparent?: boolean; opacity?: number } = {}): THREE.Material {
    const key = `${color}|${emissive}|${opts.opacity ?? 1}`;
    let m = this.mats.get(key);
    if (!m) {
      m = opts.transparent
        ? new THREE.MeshBasicMaterial({ color, transparent: true, opacity: opts.opacity ?? 0.15, depthWrite: false, side: THREE.DoubleSide })
        : new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.2, emissive, emissiveIntensity: emissive ? 1.2 : 0 });
      this.mats.set(key, m);
    }
    return m;
  }

  private mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
    this.disposables.push(g);
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.castShadow = true; o.receiveShadow = true;
    return o;
  }

  /** A mast from the ground up to the device (a device floating in the air gets none). */
  private mast(a: ActorDef, root: THREE.Object3D) {
    const h = a.pos.z - this.map.terrain(a.pos.x, a.pos.y);
    if (h < 0.3 || h > 80) return;
    const m = this.mesh(new THREE.CylinderGeometry(0.04, 0.06, h, 8), this.mat(MAST), 0, -h / 2, 0);
    root.add(m);
    // a small base plate / tripod foot
    root.add(this.mesh(new THREE.CylinderGeometry(0.35, 0.4, 0.06, 12), this.mat(DARK), 0, -h + 0.03, 0));
  }

  private build(a: ActorDef): THREE.Object3D {
    const root = new THREE.Group();
    switch (a.type) {
      case 'rf-emitter': {
        root.userData.gt = 'object';
        this.mast(a, root);
        root.add(this.mesh(new THREE.BoxGeometry(0.3, 0.22, 0.2), this.mat(DARK), 0, -0.15, 0));
        if (a.antenna) {
          // a directional panel facing its boresight
          const head = new THREE.Group();
          head.rotation.set(0, a.antenna.yaw, a.antenna.pitch, 'YZX');
          head.add(this.mesh(new THREE.BoxGeometry(0.05, 0.45, 0.35), this.mat(0xd9d9d9), 0.12, 0.05, 0));
          root.add(head);
        } else root.add(this.mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.6, 6), this.mat(DARK), 0, 0.25, 0));
        root.add(this.mesh(new THREE.SphereGeometry(0.05, 10, 8), this.mat(EMIT, EMIT), 0, 0.58, 0));
        break;
      }
      case 'ground-station': {
        root.userData.gt = 'object';
        this.mast(a, root);
        root.add(this.mesh(new THREE.BoxGeometry(0.45, 0.35, 0.35), this.mat(0xe8e8e8), 0, -0.2, 0));
        // patch antennas for the video receiver, a whip for the RC relay
        if (a.link !== 'rc') root.add(this.mesh(new THREE.BoxGeometry(0.06, 0.32, 0.32), this.mat(STATION), 0.25, 0.05, 0));
        if (a.link !== 'video') root.add(this.mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 6), this.mat(DARK), -0.15, 0.35, 0));
        root.add(this.mesh(new THREE.SphereGeometry(0.04, 10, 8), this.mat(STATION, STATION), 0, 0.02, 0.19));
        break;
      }
      case 'detector': {
        root.userData.gt = 'object';
        this.mast(a, root);
        const head = new THREE.Group();
        head.rotation.set(0, a.yaw, a.pitch, 'YZX');
        if (a.sensor === 'camera') {
          head.add(this.mesh(new THREE.BoxGeometry(0.42, 0.2, 0.2), this.mat(0xf2f2f2)));
          head.add(this.mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 14).rotateZ(Math.PI / 2), this.mat(0x111111), 0.23, 0, 0));
        } else if (a.sensor === 'radar') {
          head.add(this.mesh(new THREE.BoxGeometry(0.12, 0.6, 0.9), this.mat(0xbfc4ca), 0.05, 0, 0));
          head.add(this.mesh(new THREE.BoxGeometry(0.02, 0.5, 0.8), this.mat(DETECT), 0.12, 0, 0));
        } else {
          head.add(this.mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.3, 12), this.mat(0x9aa0a6)));
          for (const k of [-1, 1]) head.add(this.mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.5, 6), this.mat(DARK), 0, 0.35, k * 0.08));
        }
        root.add(head);
        root.add(this.mesh(new THREE.SphereGeometry(0.035, 10, 8), this.mat(DETECT, DETECT), 0, 0.2, 0));
        const cone = this.fovCone(a);
        cone.userData.gt = 'skip';
        this.cones.push(cone);
        head.add(cone);
        break;
      }
      case 'target': {
        root.userData.gt = 'target';
        const col = a.color ?? 0xe8433a, s = a.size;
        const m = this.mat(col);
        if (a.shape === 'sphere') root.add(this.mesh(new THREE.SphereGeometry(a.radius, 20, 14), m));
        else if (a.shape === 'cylinder') root.add(this.mesh(new THREE.CylinderGeometry(a.radius, a.radius, s.z, 20), m, 0, s.z / 2, 0));
        else if (a.shape === 'vehicle') this.vehicle(root, s, m);
        else if (a.shape === 'person') this.person(root, s, m);
        else if (a.shape === 'quad') this.quad(root, s, m);
        else root.add(this.mesh(new THREE.BoxGeometry(s.x, s.z, s.y), m, 0, s.z / 2, 0));
        break;
      }
    }
    return root;
  }

  /** A car-like body: a lower box, a cabin, four wheels (length along x / the heading). */
  private vehicle(root: THREE.Object3D, s: V3, body: THREE.Material) {
    const r = Math.min(0.42, s.z * 0.25);
    const lowH = s.z * 0.5, cabH = s.z - lowH - r * 0.6;
    root.add(this.mesh(new THREE.BoxGeometry(s.x, lowH, s.y), body, 0, r * 0.6 + lowH / 2, 0));
    root.add(this.mesh(new THREE.BoxGeometry(s.x * 0.55, Math.max(0.1, cabH), s.y * 0.9), this.mat(0x29323c), -s.x * 0.05, r * 0.6 + lowH + Math.max(0.1, cabH) / 2, 0));
    const wheel = new THREE.CylinderGeometry(r, r, 0.25, 16).rotateX(Math.PI / 2);
    this.disposables.push(wheel);
    for (const fx of [-1, 1]) for (const fz of [-1, 1]) {
      const w = new THREE.Mesh(wheel, this.mat(0x151515));
      w.position.set(fx * s.x * 0.33, r, fz * (s.y / 2 - 0.1));
      w.castShadow = true;
      root.add(w);
    }
  }

  /** A standing figure: legs and torso, arms, a head (size.z tall). */
  private person(root: THREE.Object3D, s: V3, body: THREE.Material) {
    const h = s.z, w = Math.max(0.2, s.x);
    root.add(this.mesh(new THREE.BoxGeometry(w * 0.5, h * 0.47, s.y * 0.8), this.mat(0x2d3a4f), 0, h * 0.235, 0));
    root.add(this.mesh(new THREE.BoxGeometry(w * 0.75, h * 0.33, s.y), body, 0, h * 0.47 + h * 0.165, 0));
    for (const k of [-1, 1]) root.add(this.mesh(new THREE.BoxGeometry(w * 0.16, h * 0.32, s.y * 0.5), body, 0, h * 0.62, k * w * 0.46));
    root.add(this.mesh(new THREE.SphereGeometry(h * 0.065, 14, 10), this.mat(0xd9a77f), 0, h * 0.885, 0));
  }

  /** A small quad: two crossed arms and four prop discs. */
  private quad(root: THREE.Object3D, s: V3, body: THREE.Material) {
    const d = Math.hypot(s.x, s.y), arm = new THREE.BoxGeometry(d, s.z * 0.3, d * 0.08);
    this.disposables.push(arm);
    for (const a of [Math.PI / 4, -Math.PI / 4]) { const m = new THREE.Mesh(arm, body); m.rotation.y = a; m.position.y = s.z * 0.5; root.add(m); }
    const disc = new THREE.CylinderGeometry(d * 0.22, d * 0.22, 0.004, 16);
    this.disposables.push(disc);
    for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const m = new THREE.Mesh(disc, this.mat(0x222222, 0, { transparent: true, opacity: 0.5 }));
      m.position.set((x * s.x) / 2, s.z * 0.8, (z * s.y) / 2);
      root.add(m);
    }
  }

  /** The detector's field of view: a pyramid along the head's +x out to its range (≤ 120 m); a sphere when it sees all round. */
  private fovCone(a: Extract<ActorDef, { type: 'detector' }>): THREE.Object3D {
    const L = Math.min(120, a.rangeM);
    const m = this.mat(DETECT, 0, { transparent: true, opacity: 0.08 });
    if (a.fovH >= Math.PI * 1.9) { const o = this.mesh(new THREE.SphereGeometry(L, 24, 16), m); o.castShadow = false; return o; }
    const hw = L * Math.tan(Math.min(1.45, a.fovH / 2)), hh = L * Math.tan(Math.min(1.45, a.fovV / 2));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, L, hh, hw, L, hh, -hw, L, -hh, -hw, L, -hh, hw], 3));
    g.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 1, 3, 2, 1, 4, 3]);
    const o = this.mesh(g, m);
    o.castShadow = false; o.receiveShadow = false;
    return o;
  }
}
