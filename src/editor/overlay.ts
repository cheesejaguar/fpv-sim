// What the editor draws over the map and what it picks: an invisible pick layer (instanced boxes,
// cylinders and spheres on the primitives, proxy boxes on gates, cylinders on trees) and visible
// gizmos for everything that has no look of its own in flight: spawns and the pilot, lights, indoor
// and wake zones, actors (masts, sensor heads with their field of view, targets), actor paths, gate
// numbers with fly-through arrows, and the racing line. Picked objects carry their map.json path.
// Hidden objects are left out, locked ones can't be picked; the viewport's Show menu turns labels,
// gizmos, the racing line and collision wireframes on and off. A hover outline follows the cursor.
import * as THREE from 'three';
import { GATE_T, HURDLE_BANNER, openingCentre } from '../maps/gates';
import type { ActorDoc, MapDocV1 } from '../maps/mapDoc';
import type { GateDef, MapDef, Prim } from '../maps/world';
import { primMatrix } from '../render/scene';
import type { Path } from './editorDoc';
import { boxEdges, circle, cylEdges, ribbon, sphereEdges } from './geom';
import type { ShowFlags } from './prefs';
import { courseGates, coursePath, racingLine } from './racing';

/** Layer of the pick proxies: never rendered, only ray cast. */
export const PICK_LAYER = 5;
const DEG = Math.PI / 180;
/** ENU -> three (x, z, -y). */
export const T3 = (x: number, y: number, z: number, o = new THREE.Vector3()) => o.set(x, z, -y);
const Y_UP = new THREE.Vector3(0, 1, 0);

export interface OverlayInput {
  doc: MapDocV1; def: MapDef;
  /** index in def.prims of doc.primitives[0] (buildMapDef puts gates and solid targets before them) */
  primOffset: number;
  /** selected paths, JSON-encoded */
  selected: Set<string>;
  /** the course shown (numbers, arrows, racing line): -1 = the main course */
  course: number;
  /** objects not drawn (and not picked) / not picked, JSON-encoded paths */
  hidden: Set<string>;
  locked: Set<string>;
  show: ShowFlags;
  /** glTF bounds (ENU, local, unscaled) by geometry index */
  meshBounds: Map<number, { lo: number[]; hi: number[] }>;
}

type Picked = { ref: Path; obj: THREE.Object3D; instance?: number };

const UNIT = { box: new THREE.BoxGeometry(1, 1, 1), cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12), sph: new THREE.SphereGeometry(0.5, 12, 8) };
const EDGES = { box: boxEdges(), cyl: cylEdges(), sph: sphereEdges() };
const pickMat = new THREE.MeshBasicMaterial({ visible: false });
const selMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, depthTest: false, transparent: true });
const hoverMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.55 });
const wireMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55 });
const labelCache = new Map<string, THREE.SpriteMaterial>();

function makeLabel(text: string, color = '#ffffff', bg = 'rgba(15,15,35,0.78)'): THREE.Sprite {
  const key = `${text}|${color}|${bg}`;
  let m = labelCache.get(key);
  if (!m) {
    const c = document.createElement('canvas'), g = c.getContext('2d')!, font = '600 44px "Chakra Petch", system-ui, sans-serif';
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 28;
    c.width = Math.max(64, w); c.height = 64;
    g.font = font; g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, c.width, 64, 14); g.fill();
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, c.width / 2, 34);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true, sizeAttenuation: false }); // the same size on screen at any distance
    labelCache.set(key, m);
  }
  const s = new THREE.Sprite(m);
  s.renderOrder = 20;
  const img = m.map!.image as HTMLCanvasElement;
  s.scale.set((img.width / img.height) * 0.032, 0.032, 1);
  return s;
}

export class Overlay {
  readonly group = new THREE.Group();
  readonly pick = new THREE.Group();
  private trash: { dispose(): void }[] = [];
  /** the gizmo object of each path (spawns, lights, actors …) and pick boxes by path */
  private gizmos = new Map<string, THREE.Object3D>();
  private proxies = new Map<string, { geo: keyof typeof UNIT; m: THREE.Matrix4 }>();
  /** racing line length of the course shown (m), 0 without gates */
  lineLength = 0;
  private hoverObj: THREE.Object3D | null = null;
  private hoverKey = '';
  private locked = new Set<string>();

  constructor() { this.group.name = 'editor-overlay'; this.pick.name = 'editor-pick'; }

  private own<T extends { dispose(): void }>(x: T): T { this.trash.push(x); return x; }
  private mat(color: number, opacity = 1, extra: THREE.MeshBasicMaterialParameters = {}) {
    return this.own(new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: opacity < 1 ? THREE.DoubleSide : THREE.FrontSide, ...extra }));
  }
  private pickable(o: THREE.Object3D, ref: Path) {
    const k = JSON.stringify(ref), pick = !this.locked.has(k);
    o.traverse((c) => { if (pick) c.layers.enable(PICK_LAYER); c.userData.ref = ref; });
    this.gizmos.set(k, o);
    this.group.add(o);
    return o;
  }

  clear() {
    for (const t of this.trash) t.dispose();
    this.trash = [];
    this.gizmos.clear(); this.proxies.clear();
    this.group.clear(); this.pick.clear();
    this.hoverObj = null; this.hoverKey = '';
  }

  /** Rebuild everything from the document and its MapDef. */
  build(o: OverlayInput) {
    const hover = this.hoverKey;
    this.clear();
    const { doc, def, hidden, show } = o, terrain = def.terrain, H = (p: Path) => hidden.has(JSON.stringify(p));
    this.locked = o.locked;
    const label = (text: string, color?: string, bg?: string) => { const l = makeLabel(text, color, bg); l.visible = show.labels; return l; };
    // ---- pick layer: primitives, gates, trees, meshes ----
    const inst: Record<keyof typeof UNIT, { m: THREE.Matrix4; ref: Path }[]> = { box: [], cyl: [], sph: [] };
    const m4 = new THREE.Matrix4(), s3 = new THREE.Vector3();
    const addProxy = (geo: keyof typeof UNIT, m: THREE.Matrix4, ref: Path) => {
      const k = JSON.stringify(ref);
      if (hidden.has(k)) return;
      this.proxies.set(k, { geo, m });
      if (!o.locked.has(k)) inst[geo].push({ m, ref });
      if (show.collision) { const e = new THREE.LineSegments(EDGES[geo], wireMat); e.matrixAutoUpdate = false; e.matrix.copy(m); this.group.add(e); }
    };
    (doc.primitives ?? []).forEach((_, i) => {
      const pr = def.prims[o.primOffset + i] as Prim | undefined;
      if (!pr || pr.kind === 'brush') return;
      const m = primMatrix(pr, new THREE.Matrix4());
      if (pr.kind === 'box') m.scale(s3.set(pr.half.x * 2, pr.half.z * 2, pr.half.y * 2)); else if (pr.kind === 'cyl') m.scale(s3.set(pr.r * 2, pr.h, pr.r * 2)); else m.scale(s3.setScalar(pr.r * 2));
      addProxy(pr.kind === 'box' ? 'box' : pr.kind === 'cyl' ? 'cyl' : 'sph', m, ['primitives', i]);
    });
    const gateBox = (g: GateDef, ref: Path) => {
      const gz = terrain(g.c.x, g.c.y), w = g.width, h = g.height;
      let cz: number, sx: number, sy: number, sz: number;
      if (g.kind === 'dive') { sz = Math.max(0.3, g.c.z - gz + 0.2); cz = gz + sz / 2; sx = sy = w + 0.3; }
      else if (g.kind === 'flag') { sz = h; cz = gz + h / 2; sx = sy = 0.9; }
      else {
        const bottom = g.onTop ? g.c.z : gz, top = g.c.z + h + 2 * GATE_T + (g.kind === 'hurdle' ? HURDLE_BANNER : 0);
        sz = top - bottom; cz = bottom + sz / 2; sx = w + 0.3; sy = 0.4;
      }
      const m = new THREE.Matrix4().compose(T3(g.c.x, g.c.y, cz), new THREE.Quaternion().setFromAxisAngle(Y_UP, g.yaw), s3.set(sx, sz, sy));
      addProxy('box', m, ref);
    };
    def.gates.forEach((g, i) => gateBox(g, ['gates', i]));
    (def.courses ?? []).forEach((c, ci) => c.gates.forEach((g, i) => gateBox(g, ['courses', ci, 'gates', i])));
    (doc.trees ?? []).forEach((t, i) => {
      const z = terrain(t.pos[0], t.pos[1]);
      addProxy('cyl', new THREE.Matrix4().compose(T3(t.pos[0], t.pos[1], z + t.height / 2), new THREE.Quaternion(), s3.set(t.radius * 1.2, t.height, t.radius * 1.2)), ['trees', i]);
    });
    (doc.geometry ?? []).forEach((g, i) => {
      if (g.type !== 'gltf') return;
      const b = o.meshBounds.get(i) ?? { lo: [-1, -1, 0], hi: [1, 1, 2] }, s = g.scale ?? 1, [px, py, pz] = g.pos ?? [0, 0, 0], yaw = (g.yawDeg ?? 0) * DEG;
      const cx = ((b.lo[0] + b.hi[0]) / 2) * s, cy = ((b.lo[1] + b.hi[1]) / 2) * s, cz = ((b.lo[2] + b.hi[2]) / 2) * s;
      const c = T3(px + Math.cos(yaw) * cx - Math.sin(yaw) * cy, py + Math.sin(yaw) * cx + Math.cos(yaw) * cy, pz + cz);
      addProxy('box', new THREE.Matrix4().compose(c, new THREE.Quaternion().setFromAxisAngle(Y_UP, yaw), s3.set((b.hi[0] - b.lo[0]) * s + 0.1, (b.hi[2] - b.lo[2]) * s + 0.1, (b.hi[1] - b.lo[1]) * s + 0.1)), ['geometry', i]);
    });
    for (const k of Object.keys(inst) as (keyof typeof UNIT)[]) {
      const l = inst[k];
      if (!l.length) continue;
      const im = this.own(new THREE.InstancedMesh(UNIT[k], pickMat, l.length));
      l.forEach((x, i) => im.setMatrixAt(i, x.m));
      im.userData.refs = l.map((x) => x.ref);
      im.layers.set(PICK_LAYER);
      im.computeBoundingSphere();
      this.pick.add(im);
    }

    // ---- spawns, pilot ----
    const arrow = (color: number, yawDeg: number, scale = 1) => {
      const g = new THREE.Group(), y = yawDeg * DEG;
      const disk = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.6 * scale, 0.6 * scale, 0.02, 24)), this.mat(color, 0.35));
      disk.position.y = 0.03;
      const cone = new THREE.Mesh(this.own(new THREE.ConeGeometry(0.22 * scale, 0.9 * scale, 12)), this.mat(color));
      cone.quaternion.setFromUnitVectors(Y_UP, new THREE.Vector3(Math.cos(y), 0, -Math.sin(y)));
      cone.position.set(Math.cos(y) * 0.5 * scale, 0.25, -Math.sin(y) * 0.5 * scale);
      g.add(disk, cone);
      return g;
    };
    const person = (color: number) => { const m = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.22, 0.22, 1.7, 10)), this.mat(color, 0.85)); m.position.y = -0.85; return m; };
    // ---- gizmos (the Show menu's "Gizmos"): spawns, pilot, lights, zones, paths, actors ----
    const G = show.gizmos;
    if (G && doc.spawn && !H(['spawn'])) {
      const g = arrow(0xf472b6, doc.spawn.yawDeg ?? 0, 1.3);
      T3(doc.spawn.pos[0], doc.spawn.pos[1], doc.spawn.groundZ ?? Math.max(doc.spawn.pos[2], terrain(doc.spawn.pos[0], doc.spawn.pos[1])), g.position);
      const l = label('Spawn', '#f9a8d4'); l.position.y = 1.6; g.add(l);
      this.pickable(g, ['spawn']);
    }
    if (G && doc.pilot && !H(['pilot'])) { const p = person(0xfacc15); const g = new THREE.Group().add(p); T3(doc.pilot[0], doc.pilot[1], doc.pilot[2], g.position); this.pickable(g, ['pilot']); }
    (doc.spawns ?? []).forEach((s, i) => {
      if (!G || H(['spawns', i])) return;
      const g = arrow(0x22d3ee, s.yawDeg ?? 0);
      T3(s.pos[0], s.pos[1], s.groundZ ?? Math.max(s.pos[2], terrain(s.pos[0], s.pos[1])), g.position);
      const l = label(s.name ?? s.id, '#a5f3fc'); l.position.y = 1.3; g.add(l);
      if (s.pilot) { const p = person(0x22d3ee); p.position.add(T3(s.pilot[0] - s.pos[0], s.pilot[1] - s.pos[1], s.pilot[2] - s.pos[2])); g.add(p); }
      this.pickable(g, ['spawns', i]);
    });

    // ---- lights, zones ----
    (doc.lights ?? []).forEach((l, i) => {
      if (!G || H(['lights', i])) return;
      const col = l.color ? parseInt(l.color.slice(1), 16) : 0xffffff;
      const g = new THREE.Group().add(new THREE.Mesh(this.own(new THREE.SphereGeometry(0.25, 12, 8)), this.mat(col)));
      if (o.selected.has(JSON.stringify(['lights', i]))) g.add(new THREE.Mesh(this.own(new THREE.SphereGeometry(Math.min(l.range, 300), 24, 12)), this.mat(col, 0.05, { wireframe: true })));
      T3(l.pos[0], l.pos[1], l.pos[2], g.position);
      this.pickable(g, ['lights', i]);
    });
    (doc.indoor ?? []).forEach((v, i) => {
      if (!G || H(['indoor', i])) return;
      const sx = v.max[0] - v.min[0], sy = v.max[1] - v.min[1], sz = v.max[2] - v.min[2];
      const m = new THREE.Mesh(this.own(new THREE.BoxGeometry(sx, sz, sy)), this.mat(0x60a5fa, 0.1));
      m.add(new THREE.LineSegments(this.own(boxEdges([-sx / 2, -sz / 2, -sy / 2], [sx / 2, sz / 2, sy / 2])), this.own(new THREE.LineBasicMaterial({ color: 0x60a5fa }))));
      T3((v.min[0] + v.max[0]) / 2, (v.min[1] + v.max[1]) / 2, (v.min[2] + v.max[2]) / 2, m.position);
      this.pickable(m, ['indoor', i]);
    });
    (doc.wakeZones ?? []).forEach((w, i) => {
      if (!G || H(['wakeZones', i])) return;
      const m = new THREE.Mesh(this.own(new THREE.CylinderGeometry(w.radius, w.radius, w.height, 32, 1, true)), this.mat(0xfb923c, 0.14));
      T3(w.pos[0], w.pos[1], terrain(w.pos[0], w.pos[1]) + w.height / 2, m.position);
      this.pickable(m, ['wakeZones', i]);
    });

    // ---- paths and actors ----
    const pathById = new Map((doc.paths ?? []).map((p) => [p.id, p]));
    (doc.paths ?? []).forEach((p, pi) => {
      if (!G || p.points.every((_, i) => H(['paths', pi, 'points', i]))) return;
      const pts = p.points.map((q) => T3(q[0], q[1], q[2]));
      if (p.mode === undefined || p.mode === 'loop') pts.push(pts[0].clone());
      if (pts.length > 1) this.group.add(new THREE.Line(this.own(new THREE.BufferGeometry().setFromPoints(pts)), this.own(new THREE.LineBasicMaterial({ color: 0xa78bfa }))));
      p.points.forEach((q, i) => {
        if (H(['paths', pi, 'points', i])) return;
        const m = new THREE.Mesh(this.own(new THREE.SphereGeometry(i === 0 ? 0.45 : 0.32, 12, 8)), this.mat(i === 0 ? 0xc4b5fd : 0xa78bfa));
        T3(q[0], q[1], q[2], m.position);
        if (i === 0) { const l = label(p.id, '#ddd6fe'); l.position.y = 1.1; m.add(l); }
        this.pickable(m, ['paths', pi, 'points', i]);
      });
    });
    (doc.actors ?? []).forEach((a, i) => {
      if (!G || H(['actors', i])) return;
      const at = a.pos ?? pathById.get(a.path ?? '')?.points[0];
      if (!at) return;
      const g = this.actorGizmo(a, at[2] - terrain(at[0], at[1]));
      T3(at[0], at[1], at[2], g.position);
      const l = label(a.name ?? a.id, '#fde68a'); l.position.y = (a.type === 'target' ? 2.4 : 1.2); g.add(l);
      this.pickable(g, ['actors', i]);
    });

    // ---- the course shown: numbers, arrows, racing line ----
    const gates = courseGates(def, o.course), base = coursePath(o.course);
    gates.forEach((g, i) => {
      if (H([...base, i])) return;
      const c = openingCentre(g), dive = g.kind === 'dive';
      if (show.labels) {
        const l = label(String(i + 1), '#ffffff', 'rgba(124,58,237,0.9)');
        T3(c.x, c.y, (dive ? g.c.z : c.z + g.height / 2) + 1.1, l.position);
        l.scale.multiplyScalar(1.3);
        l.userData.ref = [...base, i];
        if (!o.locked.has(JSON.stringify([...base, i]))) l.layers.enable(PICK_LAYER);
        this.group.add(l);
      }
      const dir = dive ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(-Math.sin(g.yaw), 0, -Math.cos(g.yaw));
      const cone = new THREE.Mesh(this.own(new THREE.ConeGeometry(0.18, 0.55, 12)), this.mat(0x5dff3a, 0.9));
      cone.quaternion.setFromUnitVectors(Y_UP, dir);
      T3(c.x, c.y, c.z, cone.position).addScaledVector(dir, dive ? -0.4 : 0.45);
      this.group.add(cone);
    });
    this.lineLength = 0;
    if (show.racingLine && gates.length) {
      const sp = o.course >= 0 && def.courses?.[o.course]?.spawn ? def.courses[o.course].spawn!.pos : def.spawn.pos;
      const line = racingLine({ ...sp, z: Math.max(sp.z, terrain(sp.x, sp.y)) }, gates, 0.5);
      this.lineLength = line.length;
      const step = Math.max(1, Math.floor(line.points.length / 600)), pts = line.points.filter((_, i) => i % step === 0).map((p) => T3(p.x, p.y, p.z));
      if (pts.length > 1) {
        this.group.add(new THREE.Mesh(this.own(ribbon(pts, 0.18)), this.mat(0x5dff3a, 0.75)));
      }
    }

    // ---- selection outlines ----
    for (const k of o.selected) {
      const px = this.proxies.get(k);
      if (px) { const e = new THREE.LineSegments(EDGES[px.geo], selMat); e.matrixAutoUpdate = false; e.matrix.copy(px.m); e.renderOrder = 15; this.group.add(e); continue; }
      const gz = this.gizmos.get(k);
      if (gz) {
        gz.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(gz, true).expandByScalar(0.1), h = new THREE.LineSegments(this.own(boxEdges(b.min.toArray(), b.max.toArray())), selMat);
        h.renderOrder = 15; this.group.add(h);
      }
    }
    if (hover) this.setHover(JSON.parse(hover) as Path, o.selected.has(hover));
  }

  /** Outline the object under the cursor (null: none); selected objects keep only their selection outline. */
  setHover(ref: Path | null, selected = false) {
    const k = ref ? JSON.stringify(ref) : '';
    if (k === this.hoverKey && (this.hoverObj !== null) === (!!k && !selected)) return;
    if (this.hoverObj) { this.hoverObj.removeFromParent(); if (this.hoverObj.userData.own) (this.hoverObj as THREE.LineSegments).geometry.dispose(); this.hoverObj = null; }
    this.hoverKey = k;
    if (!k || selected) return;
    const px = this.proxies.get(k);
    let h: THREE.LineSegments | null = null;
    if (px) { h = new THREE.LineSegments(EDGES[px.geo], hoverMat); h.matrixAutoUpdate = false; h.matrix.copy(px.m); }
    else {
      const gz = this.gizmos.get(k);
      if (!gz) return;
      gz.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(gz, true).expandByScalar(0.08);
      h = new THREE.LineSegments(boxEdges(b.min.toArray(), b.max.toArray()), hoverMat);
      h.userData.own = true;
    }
    h.renderOrder = 14;
    this.group.add(h);
    this.hoverObj = h;
  }

  private actorGizmo(a: ActorDoc, aboveGround: number): THREE.Group {
    const g = new THREE.Group(), mast = (color: number) => {
      const h = Math.max(0.2, aboveGround);
      const m = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.05, 0.07, h, 8)), this.mat(0x9ca3af));
      m.position.y = -h / 2; g.add(m);
      return color;
    };
    const dirOf = (yawDeg: number, pitchDeg: number) => { const y = yawDeg * DEG, p = pitchDeg * DEG; return T3(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)).normalize(); };
    if (a.type === 'rf-emitter') {
      mast(0xef4444);
      g.add(new THREE.Mesh(this.own(new THREE.SphereGeometry(0.3, 12, 8)), this.mat(0xef4444)));
      if (a.antenna && a.antenna.beamDeg < 180) {
        const L = 40, geo = this.own(new THREE.ConeGeometry(L * Math.tan((a.antenna.beamDeg * DEG) / 2), L, 24, 1, true));
        geo.translate(0, -L / 2, 0);
        const c = new THREE.Mesh(geo, this.mat(0xef4444, 0.07));
        c.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirOf(a.antenna.yawDeg, a.antenna.pitchDeg ?? 0));
        g.add(c);
      } else { const c = new THREE.LineSegments(this.own(circle(24)), this.own(new THREE.LineBasicMaterial({ color: 0xef4444 }))); c.scale.setScalar(0.6); g.add(c); }
    } else if (a.type === 'ground-station') {
      mast(0x22c55e);
      const d = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.4, 0.15, 0.25, 16)), this.mat(0x22c55e)); g.add(d);
    } else if (a.type === 'detector') {
      mast(0xeab308);
      const head = new THREE.Mesh(this.own(new THREE.BoxGeometry(0.5, 0.35, 0.35)), this.mat(0xeab308));
      const fov = a.fovDeg ?? (a.sensor === 'camera' ? [60, 40] : a.sensor === 'radar' ? [90, 30] : [360, 180]);
      const fwd = dirOf(a.yawDeg ?? 0, a.pitchDeg ?? 0);
      head.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), fwd);
      g.add(head);
      const R = Math.min(a.rangeM, 3000), col = a.sensor === 'radar' ? 0x38bdf8 : a.sensor === 'rf' ? 0xf472b6 : 0xeab308;
      if (fov[0] >= 180) g.add(new THREE.Mesh(this.own(new THREE.SphereGeometry(R, 32, 16)), this.mat(col, 0.06, { wireframe: true })));
      else {
        // frustum: the four corner rays out to the range, and the far cap
        const y = (a.yawDeg ?? 0) * DEG, p = (a.pitchDeg ?? 0) * DEG, h = (fov[0] * DEG) / 2, v = (Math.min(fov[1], 179) * DEG) / 2;
        const ray = (dy: number, dp: number) => { const yy = y + dy, pp = p + dp; return T3(Math.cos(pp) * Math.cos(yy) * R, Math.cos(pp) * Math.sin(yy) * R, Math.sin(pp) * R); };
        const c = [ray(-h, -v), ray(h, -v), ray(h, v), ray(-h, v)], o = new THREE.Vector3();
        const pos: number[] = [];
        const tri = (a: THREE.Vector3, b: THREE.Vector3, d: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z);
        for (let i = 0; i < 4; i++) tri(o, c[i], c[(i + 1) % 4]);
        tri(c[0], c[1], c[2]); tri(c[0], c[2], c[3]);
        const geo = this.own(new THREE.BufferGeometry()); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.add(new THREE.Mesh(geo, this.mat(col, 0.06)));
        const lines: number[] = [];
        for (let i = 0; i < 4; i++) { const a = c[i], b = c[(i + 1) % 4]; lines.push(0, 0, 0, a.x, a.y, a.z, a.x, a.y, a.z, b.x, b.y, b.z); }
        const lg = this.own(new THREE.BufferGeometry()); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
        g.add(new THREE.LineSegments(lg, this.own(new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.5 }))));
      }
    } else {
      const col = a.color ? parseInt(a.color.slice(1), 16) : 0xe8433a, shape = a.shape ?? 'box', r = a.radiusM ?? 1;
      const size = a.size ?? (shape === 'person' ? [0.5, 0.3, 1.8] : shape === 'vehicle' ? [4.5, 1.9, 1.5] : shape === 'quad' ? [0.3, 0.3, 0.1] : [2 * r, 2 * r, 2 * r]);
      const geo = shape === 'sphere' ? new THREE.SphereGeometry(r, 16, 12) : shape === 'cylinder' ? new THREE.CylinderGeometry(r, r, size[2], 16) : shape === 'person' ? new THREE.CylinderGeometry(size[0] / 2, size[0] / 2, size[2], 10) : new THREE.BoxGeometry(size[0], size[2], size[1]);
      const m = new THREE.Mesh(this.own(geo), this.mat(col, a.solid ? 1 : 0.75));
      m.position.y = shape === 'sphere' ? 0 : size[2] / 2;
      g.add(m);
    }
    return g;
  }

  /** The world box round these objects (JSON-encoded paths), from their pick shapes and gizmos; null if none is drawn. */
  boundsOf(keys: Set<string>): THREE.Box3 | null {
    const box = new THREE.Box3(), b = new THREE.Box3();
    for (const k of keys) {
      const px = this.proxies.get(k);
      if (px) { if (!UNIT[px.geo].boundingBox) UNIT[px.geo].computeBoundingBox(); box.union(b.copy(UNIT[px.geo].boundingBox!).applyMatrix4(px.m)); continue; }
      const gz = this.gizmos.get(k);
      if (gz) { gz.updateMatrixWorld(true); box.union(b.setFromObject(gz, true)); }
    }
    return box.isEmpty() ? null : box;
  }

  /** Visible stand-ins for the selected objects while the gizmo drags them (pick proxies drawn, gizmos themselves). */
  dragObjects(refs: Path[]): { obj: THREE.Object3D; owned: boolean }[] {
    const out: { obj: THREE.Object3D; owned: boolean }[] = [];
    for (const r of refs) {
      const k = JSON.stringify(r), gz = this.gizmos.get(k);
      if (gz) { out.push({ obj: gz, owned: false }); continue; }
      const px = this.proxies.get(k);
      if (!px || r[0] === 'primitives' || r[0] === 'gates' || r[0] === 'courses') continue; // drawn as real meshes by the editor
      const m = new THREE.Mesh(UNIT[px.geo], new THREE.MeshBasicMaterial({ color: 0x3f8f3a, transparent: true, opacity: 0.6 }));
      m.applyMatrix4(px.m);
      out.push({ obj: m, owned: true });
    }
    return out;
  }

  /** Ray cast the pick layer and the gizmos: nearest hit with its map.json path. */
  raycast(rc: THREE.Raycaster): (Picked & { point: THREE.Vector3; distance: number; normal?: THREE.Vector3 }) | null {
    rc.layers.set(PICK_LAYER);
    const hits = rc.intersectObjects([this.pick, this.group], true);
    for (const h of hits) {
      const refs = h.object.userData.refs as Path[] | undefined;
      const ref = refs && h.instanceId !== undefined ? refs[h.instanceId] : (h.object.userData.ref as Path | undefined);
      if (ref) return { ref, obj: h.object, instance: h.instanceId, point: h.point, distance: h.distance, normal: h.face?.normal?.clone().transformDirection(h.object.matrixWorld) };
    }
    return null;
  }

  dispose() { this.clear(); }
}
