// Build mode: the map builder over the paused simulator. It owns the screen while open: its own
// scene (the map rebuilt from the draft with buildMapDef + buildScene after every edit), its own
// camera, an overlay of gizmos and pick proxies, three's TransformControls for move / turn / scale,
// brushes (sculpt, trees) and the panels (ui.ts). Fly registers the draft as a local map and hands
// the screen back to the flight; "Back to editor" reopens it where the quad is.
import './editor.css';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GATE_T } from '../maps/gates';
import { loadLocalMap } from '../maps/localMaps';
import { BUDGETS, buildMapDef, decodePngChannel, imageSize, MapFormatError, validateMapDoc, type ActorDoc, type GateDoc, type MapAssets, type PrimDoc, type TreeDoc, type Vec3 } from '../maps/mapFormat';
import type { MapDef, Prim } from '../maps/world';
import { buildScene, primMatrix, type SceneBundle } from '../render/scene';
import { isStandard } from '../input/gamepad';
import { topModal } from '../ui/dom';
import { encodePng } from '../app/datasetFiles';
import { EditorCamera } from './camera';
import { circle, gridMesh } from './geom';
import { autosave } from './drafts';
import { EditorDoc, gridFromHf, gridHf, refKind, type Op, type Path } from './editorDoc';
import type { EditorHost, EditorView } from './host';
import { Overlay, PICK_LAYER, T3 } from './overlay';
import { budgetMeters, checkPackage, download, exportDoc, glbBounds, glbInfo, meshAssets, packageFiles, zipPackage, type CheckResult, type Meter } from './package';
import { placePrefab, prefabById, prefabDefaults } from './prefabs';
import { coursePath, raceProblems, type Problem } from './racing';
import { cutRect, hfFrame, sculpt, toHeightfield, unionRect, type Brush, type HfGround, type Rect } from './terrain';
import { anchorOf, copyOps, expandGroups, freeId, groundOps, groupMembers, transformOps, yawOf, type CopyState, type Xform } from './transform';
import { renderInspector, renderPalette, renderProblems, renderToolbar } from './ui';

const DEG = Math.PI / 180;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const key = (p: Path) => JSON.stringify(p);
const ENU = (v: THREE.Vector3): Vec3 => [v.x, -v.z, v.y];

export type Place =
  | { kind: 'gate'; gate: GateDoc['kind'] }
  | { kind: 'prim'; type: PrimDoc['type'] }
  | { kind: 'prefab'; id: string }
  | { kind: 'spawnPad' } | { kind: 'spawn' } | { kind: 'light' } | { kind: 'indoor' } | { kind: 'wake' } | { kind: 'tree' }
  | { kind: 'actor'; actor: ActorDoc };
export type Tool = { t: 'select' } | { t: 'place'; p: Place } | { t: 'trees' } | { t: 'sculpt' } | { t: 'path'; index: number | null };
export type Mode = 'select' | 'move' | 'rotate' | 'scale';

/** Palette settings (kept while the editor is open). */
export interface PaletteState {
  tab: 'race' | 'freestyle' | 'environment' | 'simulation';
  gate: { width?: number; height?: number; stack?: number };
  prim: { size: Vec3; radius: number; height: number; material: PrimDoc['material']; visual: Extract<PrimDoc, { type: 'box' }>['visual']; color?: string; texture?: string };
  prefab: Record<string, Record<string, number>>;
  trees: { density: number; radius: number; type: 'pine' | 'oak' | 'mixed'; hMin: number; hMax: number; erase: boolean };
  brush: Brush;
  line: boolean;
  hfRes: number;
  scenario: string | null;
}

export interface Session {
  draftId: string;
  ed: EditorDoc;
  baseDef: MapAssets['baseDef'];
  cam?: ReturnType<EditorCamera['save']>;
  /** ENU point to look at when the editor opens (where the quad is after a flight) */
  lookAt?: Vec3;
  course: number;
  fly: { course: string; spawn: string; race: boolean };
  pal?: PaletteState;
  warnings?: string[];
}

interface Stroke { kind: 'sculpt' | 'trees'; before?: Uint16Array; rect: Rect | null; added: TreeDoc[]; erased: Set<number>; acc: number }

export class Editor implements EditorView {
  readonly root = document.createElement('div');
  readonly cam = new EditorCamera();
  readonly ed: EditorDoc;
  readonly overlay = new Overlay();
  private extras = new THREE.Group();
  private pivot = new THREE.Object3D();
  private tc: TransformControls;
  private bundle: SceneBundle | null = null;
  def: MapDef | null = null;
  private primOffset = 0;
  private hf: MapAssets['hf'];
  private hfGrid: unknown = null;
  private meshes: MapAssets['meshes'] = [];
  private meshKey = '';
  meshStats = { triangles: 0, collision: 0, errors: [] as string[] };
  private meshBounds = new Map<number, { lo: number[]; hi: number[] }>();
  private urls = new Map<Blob, string>();
  problems: Problem[] = [];
  check: CheckResult | null = null;
  sel: Path[] = [];
  tool: Tool = { t: 'select' };
  mode: Mode = 'move';
  snap = { grid: 0.5, angle: 15 };
  pal: PaletteState;
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  private saver: ReturnType<typeof autosave>;
  saved = 'Saved';
  private last = performance.now();
  private lastShadow = 0;
  private drag: { id: number; x: number; y: number; button: number; moved: boolean; how: 'orbit' | 'look' | 'pan' | 'paint' | 'click' } | null = null;
  private pointer: { x: number; y: number } | null = null;
  private stroke: Stroke | null = null;
  private dragState: { refs: Path[]; start: { p: THREE.Vector3; q: THREE.Quaternion; yaw: number }; owned: THREE.Object3D[]; moved: { obj: THREE.Object3D; parent: THREE.Object3D | null }[] } | null = null;
  private cursor: THREE.LineSegments;
  private sculptMesh: THREE.Mesh | null = null;
  private treePreview = new THREE.Group();
  private off: (() => void)[] = [];
  private boxes = { toolbar: document.createElement('header'), palette: document.createElement('aside'), inspector: document.createElement('aside'), problems: document.createElement('footer'), toast: document.createElement('div') };
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  readonly canvas: HTMLCanvasElement;

  constructor(readonly host: EditorHost, readonly s: Session) {
    this.ed = s.ed;
    this.canvas = host.ctx.renderer.domElement;
    this.pal = s.pal ??= {
      tab: 'race', gate: {}, prim: { size: [2, 2, 1], radius: 0.5, height: 2, material: 'concrete', visual: 'concrete' }, prefab: {},
      trees: { density: 3, radius: 8, type: 'mixed', hMin: 6, hMax: 14, erase: false },
      brush: { op: 'raise', radius: 8, strength: 3, falloff: 'smooth' }, line: true, hfRes: 257, scenario: null,
    };
    // ---- DOM ----
    this.root.className = 'ed';
    this.root.setAttribute('role', 'application');
    this.root.setAttribute('aria-label', 'Map builder');
    const b = this.boxes;
    b.toolbar.className = 'ed-bar'; b.palette.className = 'ed-left'; b.inspector.className = 'ed-right'; b.problems.className = 'ed-foot'; b.toast.className = 'ed-toast';
    b.palette.setAttribute('aria-label', 'Palette'); b.inspector.setAttribute('aria-label', 'Inspector'); b.problems.setAttribute('aria-label', 'Problems and budgets');
    b.toast.setAttribute('role', 'status');
    this.root.append(b.toolbar, b.palette, b.inspector, b.problems, b.toast);
    document.body.append(this.root);
    document.body.classList.add('fpv-editing');

    // ---- scene extras: overlay, gizmo, brush cursor ----
    this.tc = new TransformControls(this.cam.cam, this.canvas);
    this.tc.setSize(0.9);
    const helper = this.tc.getHelper();
    this.extras.add(this.overlay.group, this.overlay.pick, this.pivot, helper, this.treePreview);
    this.cursor = new THREE.LineSegments(circle(64), new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.9, depthTest: false }));
    this.cursor.renderOrder = 30; this.cursor.visible = false;
    this.extras.add(this.cursor);
    this.tc.addEventListener('mouseDown', () => this.beginDrag());
    this.tc.addEventListener('mouseUp', () => this.endDrag());

    // ---- camera: where the editor was, at the quad after a flight, or over the spawn ----
    if (s.cam) this.cam.restore(s.cam);
    const sp = this.ed.doc.spawn?.pos ?? [0, 0, 0];
    if (s.lookAt) { T3(s.lookAt[0], s.lookAt[1], s.lookAt[2], this.cam.target); this.cam.dist = Math.min(this.cam.dist, 12); this.cam.update(); s.lookAt = undefined; }
    else if (!s.cam) { T3(sp[0], sp[1], sp[2], this.cam.target); this.cam.dist = Math.min(80, Math.max(20, this.ed.doc.size * 0.45)); this.cam.update(); }

    // ---- input ----
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, ev: K | string, f: (e: any) => void, o?: AddEventListenerOptions) => { t.addEventListener(ev, f, o); this.off.push(() => t.removeEventListener(ev, f, o)); };
    on(this.canvas, 'pointerdown', (e: PointerEvent) => this.onDown(e));
    on(this.canvas, 'pointermove', (e: PointerEvent) => this.onMove(e));
    on(this.canvas, 'pointerup', (e: PointerEvent) => this.onUp(e));
    on(this.canvas, 'pointercancel', () => { this.drag = null; this.endStroke(); });
    on(this.canvas, 'pointerleave', () => { this.pointer = null; this.cursor.visible = false; });
    on(this.canvas, 'wheel', (e: WheelEvent) => { e.preventDefault(); this.cam.wheel(e.deltaY); }, { passive: false });
    on(this.canvas, 'contextmenu', (e: Event) => e.preventDefault());
    on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    on(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    on(window, 'blur', () => this.cam.clearKeys());
    // a drop of a texture, glb or heightfield onto the view imports it
    on(this.canvas, 'dragover', (e: DragEvent) => e.preventDefault());
    on(this.canvas, 'drop', (e: DragEvent) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) void this.importFile(f); });

    // ---- document ----
    this.saver = autosave(s.draftId, this.ed, (ok) => { this.saved = ok ? 'Saved' : 'Not saved (browser storage unavailable)'; this.renderBox('toolbar'); });
    this.off.push(this.ed.onChange((c) => {
      this.saved = 'Saving…';
      if (c.grid) this.hfGrid = null;
      this.scheduleRebuild();
    }));
    this.rebuild();
    if (s.warnings?.length) { this.toast(`Opened with ${s.warnings.length} problem${s.warnings.length === 1 ? '' : 's'} (see the list below)`); }
    host.ctx.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    host.enter(this);
  }

  // -------------------------------------------------------------------------------------------
  // Build the map from the draft

  /** Package path -> URL the renderer can load (the draft's own files). */
  url = (p: string): string => {
    const b = this.ed.assets.get(p);
    if (!b) return '';
    let u = this.urls.get(b);
    if (!u) { u = URL.createObjectURL(b); this.urls.set(b, u); }
    return u;
  };

  private scheduleRebuild(ms = 150) { clearTimeout(this.rebuildTimer); this.rebuildTimer = setTimeout(() => this.rebuild(), ms); }

  /** glTF entries changed: decode them again (async), then rebuild. */
  private async prepareMeshes() {
    const doc = this.ed.doc, geo = (doc.geometry ?? []).filter((g) => g.type === 'gltf');
    const k = JSON.stringify(geo) + geo.map((g) => this.ed.assets.get(g.src)?.size ?? -1).join(',');
    if (k === this.meshKey) return;
    this.meshKey = k;
    const r = await meshAssets(doc, this.ed.assets, this.url);
    if (this.disposed || this.meshKey !== k) return;
    this.meshes = r.meshes; this.meshStats = { triangles: r.triangles, collision: r.collision, errors: r.errors };
    this.meshBounds.clear();
    for (const [i, g] of (doc.geometry ?? []).entries()) {
      const b = g.type === 'gltf' ? this.ed.assets.get(g.src) : undefined, t = b ? await glbInfo(b) : null;
      if (t && !(t instanceof Error)) this.meshBounds.set(i, glbBounds(t));
    }
    this.rebuild();
  }

  /** The heightfield as the loader decodes it (rebuilt when the grid changes). */
  private hfNow(): MapAssets['hf'] {
    if (this.hfGrid !== this.ed.grid) { this.hfGrid = this.ed.grid; this.hf = this.ed.grid ? gridHf(this.ed.grid) : undefined; }
    return this.hf;
  }

  /** Validate, build the MapDef, rebuild the scene (exclude: primitives drawn by the drag instead) and the overlay. */
  rebuild(exclude?: Set<Prim>) {
    clearTimeout(this.rebuildTimer);
    if (this.disposed) return;
    void this.prepareMeshes();
    const doc = this.ed.doc, problems: Problem[] = [];
    try { for (const w of validateMapDoc(doc).warnings) problems.push({ level: 'warning', text: w, ref: refOfMessage(w) }); }
    catch (e) {
      if (!(e instanceof MapFormatError)) throw e;
      for (const t of e.errors) problems.push({ level: 'error', text: t, ref: refOfMessage(t) });
      for (const t of e.warnings) problems.push({ level: 'warning', text: t, ref: refOfMessage(t) });
    }
    let def: MapDef | null = null;
    try { def = buildMapDef(doc, { hf: this.hfNow(), baseDef: this.s.baseDef, meshes: this.meshes }, this.url); }
    catch (e) { problems.push({ level: 'error', text: `The map does not build: ${(e as Error).message ?? e}` }); }
    for (const t of this.meshStats.errors) problems.push({ level: 'error', text: t });
    if (this.meshStats.triangles > BUDGETS.meshTriangles) problems.push({ level: 'error', text: `glTF meshes have ${this.meshStats.triangles} triangles; the budget is ${BUDGETS.meshTriangles}` });
    if (this.meshStats.collision > BUDGETS.collisionTriangles) problems.push({ level: 'error', text: `glTF meshes with collision "mesh" have ${this.meshStats.collision} triangles; the budget is ${BUDGETS.collisionTriangles} (use collision "box" or "none")` });
    if (def) {
      try { problems.push(...raceProblems(doc, def)); } catch { /* a half-made course: the validator says why */ }
      const prims = def.prims.filter((p) => p.kind !== 'brush').length;
      if (prims > BUDGETS.primitives) problems.push({ level: 'error', text: `The map has ${prims} primitives including generated gate parts; the budget is ${BUDGETS.primitives}` });
      this.def = def;
      const meshPrims = this.meshes.reduce((a, m) => a + m.brushes.length + (m.box ? 1 : 0), 0);
      this.primOffset = def.prims.length - meshPrims - (doc.primitives?.length ?? 0);
      try {
        const b = buildScene(def, { timeOfDay: 'map', exclude: exclude ? (p) => exclude.has(p) : undefined });
        if (this.bundle) { this.bundle.scene.remove(this.extras); this.bundle.dispose(); }
        this.bundle = b; b.scene.add(this.extras);
        b.setGateHighlight(0, false, 0);
        this.lastShadow = 0;
        this.applySculptView();
      } catch (e) { problems.push({ level: 'error', text: `The scene does not build: ${(e as Error).message ?? e}` }); }
    }
    this.problems = problems;
    this.sel = this.sel.filter((p) => this.ed.get(p) !== undefined);
    this.refreshOverlay();
    this.renderAll();
  }

  refreshOverlay() {
    if (!this.def) return;
    try {
      this.overlay.build({ doc: this.ed.doc, def: this.def, primOffset: this.primOffset, selected: new Set(this.sel.map(key)), course: this.s.course, racingLine: this.pal.line, meshBounds: this.meshBounds });
    } catch (e) { console.warn('editor overlay', e); }
    this.attachGizmo();
  }

  // -------------------------------------------------------------------------------------------
  // UI

  private renderers = { toolbar: renderToolbar, palette: renderPalette, inspector: renderInspector, problems: renderProblems };
  /** Re-render a panel, unless the pilot is typing in it (its own edit caused the change). */
  renderBox(which: keyof Editor['renderers'], force = false) {
    const box = this.boxes[which];
    if (!force && box.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement!.tagName)) return;
    const scroll = box.scrollTop;
    box.replaceChildren(this.renderers[which](this));
    box.scrollTop = scroll;
  }
  renderAll() { for (const k of Object.keys(this.renderers) as (keyof Editor['renderers'])[]) this.renderBox(k); }

  toast(msg: string, ms = 3500) {
    const t = this.boxes.toast;
    t.textContent = msg; t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }

  meters(): Meter[] {
    return budgetMeters(this.ed.doc, this.def, { triangles: this.meshStats.triangles, collision: this.meshStats.collision, bytes: [...this.ed.assets.values()].reduce((a, b) => a + b.size, 0) + (this.ed.grid ? this.ed.grid.data.length * 2 : 0) });
  }

  get racingLineLength() { return this.overlay.lineLength; }

  // -------------------------------------------------------------------------------------------
  // Selection, tools, gizmo

  select(refs: Path[], add = false) {
    const next = add ? [...this.sel] : [];
    for (const r of refs) { const i = next.findIndex((p) => key(p) === key(r)); if (add && i >= 0) next.splice(i, 1); else if (i < 0) next.push(r); }
    this.sel = next;
    if (this.sel.length === 1 && this.sel[0][0] === 'paths') this.pal.scenario = null;
    this.refreshOverlay();
    this.renderBox('inspector', true); this.renderBox('toolbar'); this.renderBox('palette');
  }

  setTool(t: Tool) {
    if (this.tool.t === 'path' && t.t !== 'path') this.finishPath();
    this.tool = t;
    this.cursor.visible = false;
    this.applySculptView();
    this.attachGizmo();
    this.renderBox('palette'); this.renderBox('toolbar');
    const hint = t.t === 'place' ? 'Click to place · Esc to stop' : t.t === 'trees' ? 'Paint trees: drag on the ground · right-drag turns the view' : t.t === 'sculpt' ? 'Sculpt: drag on the terrain · right-drag turns the view' : t.t === 'path' ? 'Click to add path points · Enter or Esc to finish' : '';
    if (hint) this.toast(hint);
  }

  setMode(m: Mode) { this.mode = m; this.attachGizmo(); this.renderBox('toolbar'); }

  setCourse(c: number) { this.s.course = c; this.refreshOverlay(); this.renderBox('palette'); }

  private attachGizmo() {
    if (this.dragState) return;
    const refs = this.sel.filter((r) => { const k = refKind(r), o = this.ed.get(r) as Record<string, unknown> | undefined; return k && o && this.def && anchorOf(k, o, this.def.terrain, this.ed.doc) && !(k === 'actor' && !o.pos); });
    if (this.tool.t !== 'select' || this.mode === 'select' || !refs.length || !this.def) { this.tc.detach(); return; }
    const c = new THREE.Vector3();
    for (const r of refs) { const a = anchorOf(refKind(r)!, this.ed.get(r) as Record<string, unknown>, this.def.terrain, this.ed.doc)!; c.add(T3(a[0], a[1], a[2])); }
    c.divideScalar(refs.length);
    this.pivot.position.copy(c); this.pivot.scale.set(1, 1, 1);
    const single = refs.length === 1 || this.sel.every((r) => r[0] === 'primitives' && (this.ed.get(r) as Record<string, unknown>)['x-group'] && (this.ed.get(r) as Record<string, unknown>)['x-group'] === (this.ed.get(this.sel[0]) as Record<string, unknown>)['x-group']);
    const yaw = refs.length === 1 ? yawOf(refKind(refs[0])!, this.ed.get(refs[0]) as Record<string, unknown>) : 0;
    this.pivot.rotation.set(0, single ? yaw * DEG : 0, 0);
    this.pivot.updateMatrixWorld();
    this.tc.setMode(this.mode === 'move' ? 'translate' : this.mode === 'rotate' ? 'rotate' : 'scale');
    this.tc.setSpace(this.mode === 'scale' ? 'local' : 'world');
    this.tc.showX = this.tc.showZ = this.mode !== 'rotate';
    this.tc.showY = true;
    this.tc.setTranslationSnap(this.snap.grid || null);
    this.tc.setRotationSnap(this.snap.angle ? this.snap.angle * DEG : null);
    this.tc.setScaleSnap(this.snap.grid ? 0.1 : null);
    if (this.tc.object !== this.pivot) this.tc.attach(this.pivot);
  }

  /** Gizmo grabbed: the selected primitives leave the merged meshes and are drawn on the pivot instead. */
  private beginDrag() {
    if (!this.def || !this.sel.length) return;
    const refs = this.sel.filter((r) => { const o = this.ed.get(r) as Record<string, unknown> | undefined; return !!o && !(refKind(r) === 'actor' && !o.pos); });
    const ex = new Set<Prim>(), def = this.def, gateTag = new Set<string>(), targetTag = new Set<string>();
    const nMain = def.gates.length, courseStart = (c: number) => nMain + (def.courses ?? []).slice(0, c).reduce((a, x) => a + x.gates.length, 0);
    for (const r of refs) {
      if (r[0] === 'primitives') { const p = def.prims[this.primOffset + (r[1] as number)]; if (p) ex.add(p); }
      else if (r[0] === 'gates') gateTag.add(`gate${def.gates[r[1] as number]?.id}`);
      else if (r[0] === 'courses') gateTag.add(`gate${courseStart(r[1] as number) + (r[3] as number)}`);
      else if (r[0] === 'actors') { const a = this.ed.get(r) as ActorDoc; if (a.type === 'target' && a.solid) targetTag.add(`target-${a.id}`); }
    }
    for (const p of def.prims) if (p.tag && (gateTag.has(p.tag) || targetTag.has(p.tag))) ex.add(p);
    const owned: THREE.Object3D[] = [], moved: { obj: THREE.Object3D; parent: THREE.Object3D | null }[] = [];
    if (ex.size) {
      this.rebuild(ex);
      const mat = new Map<number, THREE.Material>();
      const matOf = (p: Exclude<Prim, { kind: 'brush' }>) => { const c = p.mat === 'gate' ? 0xff6a00 : (p as { color?: number }).color ?? (p.mat === 'wood' ? 0x9c7a4f : p.mat === 'metal' ? 0x8a8f94 : 0xa3a3a3); let m = mat.get(c); if (!m) { m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }); mat.set(c, m); } return m; };
      for (const p of ex) {
        if (p.kind === 'brush') continue;
        const geo = p.kind === 'box' ? new THREE.BoxGeometry(p.half.x * 2, p.half.z * 2, p.half.y * 2) : p.kind === 'cyl' ? new THREE.CylinderGeometry(p.r, p.r, p.h, 16) : new THREE.SphereGeometry(p.r, 16, 12);
        const m = new THREE.Mesh(geo, matOf(p));
        m.applyMatrix4(primMatrix(p, new THREE.Matrix4()));
        this.pivot.attach(m); owned.push(m);
      }
    }
    for (const d of this.overlay.dragObjects(refs)) { moved.push({ obj: d.obj, parent: d.obj.parent }); this.pivot.attach(d.obj); if (d.owned) owned.push(d.obj); }
    this.dragState = { refs, start: { p: this.pivot.position.clone(), q: this.pivot.quaternion.clone(), yaw: this.pivot.rotation.y }, owned, moved };
  }

  private endDrag() {
    const d = this.dragState;
    if (!d || !this.def) return;
    this.dragState = null;
    const dp = this.pivot.position.clone().sub(d.start.p);
    const dq = this.pivot.quaternion.clone().multiply(d.start.q.clone().invert());
    const dyaw = new THREE.Euler().setFromQuaternion(dq, 'YXZ').y / DEG;
    const s = this.pivot.scale;
    for (const o of d.owned) { o.removeFromParent(); (o as THREE.Mesh).geometry?.dispose(); }
    for (const m of d.moved) m.obj.removeFromParent();
    const t: Xform = { pivot: ENU(d.start.p), d: [dp.x, -dp.z, dp.y], yawDeg: Math.round(dyaw * 100) / 100, s: [s.x, s.z, s.y], frameYawDeg: d.start.yaw / DEG };
    const changed = dp.lengthSq() > 1e-8 || Math.abs(t.yawDeg) > 1e-3 || Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) > 1e-4;
    if (changed) this.ed.apply(this.mode === 'rotate' ? 'Turn' : this.mode === 'scale' ? 'Scale' : 'Move', transformOps(this.ed, d.refs, t, this.def.terrain));
    this.rebuild(); // at once: the dragged parts go back into the merged meshes now
  }

  // -------------------------------------------------------------------------------------------
  // Pointer and keys

  private ray(cx: number, cy: number): THREE.Raycaster {
    const r = this.canvas.getBoundingClientRect(), rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), this.cam.cam);
    rc.camera = this.cam.cam;
    return rc;
  }

  /** Where a ray meets the terrain (ENU), marching then bisecting the height function. */
  terrainHit(rc: THREE.Raycaster): { p: Vec3; dist: number } | null {
    const f = this.def?.terrain;
    if (!f) return null;
    const o = ENU(rc.ray.origin), d = ENU(rc.ray.direction);
    const below = (t: number) => o[2] + d[2] * t < f(o[0] + d[0] * t, o[1] + d[1] * t);
    if (below(0)) return null;
    let a = 0;
    for (let t = 0.5; t < 6000; t += Math.max(0.5, t * 0.015)) {
      if (below(t)) {
        let lo = a, hi = t;
        for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (below(m)) hi = m; else lo = m; }
        const x = o[0] + d[0] * hi, y = o[1] + d[1] * hi;
        return { p: [x, y, f(x, y)], dist: hi };
      }
      a = t;
    }
    return null;
  }

  private onDown(e: PointerEvent) {
    if (this.tc.dragging || this.tc.axis !== null) return;
    (document.activeElement as HTMLElement | null)?.blur?.(); // keys go to the view again
    for (const d of this.root.querySelectorAll('details.ed-pop[open]')) d.removeAttribute('open');
    const t = this.tool.t, b = e.button;
    let how: NonNullable<Editor['drag']>['how'];
    if (b === 2) how = this.cam.mode === 'fly' || t === 'sculpt' || t === 'trees' ? 'look' : 'orbit';
    else if (b === 1 || (b === 0 && e.altKey)) how = 'pan';
    else if (b === 0 && (t === 'sculpt' || t === 'trees')) how = 'paint';
    else how = 'click';
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, button: b, moved: false, how };
    this.canvas.setPointerCapture(e.pointerId);
    if (how === 'paint') this.beginStroke();
  }

  private onMove(e: PointerEvent) {
    this.pointer = { x: e.clientX, y: e.clientY };
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true; d.x = e.clientX; d.y = e.clientY;
    let how = d.how;
    if (how === 'click') how = e.shiftKey ? 'pan' : this.cam.mode === 'fly' ? 'look' : 'orbit'; // a drag on the view moves the camera
    if (how === 'orbit' || how === 'look') this.cam.turn(dx * 0.005, dy * 0.005, how === 'orbit');
    else if (how === 'pan') this.cam.pan(dx, dy, this.canvas.clientHeight);
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (d.how === 'paint') { this.endStroke(); return; }
    if (d.moved || d.button !== 0) return;
    const rc = this.ray(e.clientX, e.clientY);
    if (this.tool.t === 'select') {
      const h = this.overlay.raycast(rc);
      if (!h) { if (!e.shiftKey) this.select([]); return; }
      this.select(e.altKey || h.ref.length !== 2 ? [h.ref] : expandGroups(this.ed.doc, [h.ref]), e.shiftKey || e.ctrlKey || e.metaKey);
    } else if (this.tool.t === 'place') this.place(rc, this.tool.p);
    else if (this.tool.t === 'path') this.addPathPoint(rc);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (/^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName) || tgt.isContentEditable)) return;
    if (topModal()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (/^(Key[WASDQE]|Shift(Left|Right))$/.test(e.code) && !mod) { this.cam.key(e.code, down); if (/^Key/.test(e.code)) e.preventDefault(); }
    if (!down) return;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
    else if (mod && e.code === 'KeyY') { e.preventDefault(); this.redo(); }
    else if (mod && e.code === 'KeyD') { e.preventDefault(); this.duplicate(); }
    else if (mod) return;
    else if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); this.del(); }
    else if (e.code === 'Escape') { e.preventDefault(); if (this.tool.t !== 'select') this.setTool({ t: 'select' }); else if (this.sel.length) this.select([]); }
    else if (e.code === 'Enter' && this.tool.t === 'path') { e.preventDefault(); this.setTool({ t: 'select' }); }
    else if (e.code === 'KeyF') this.frameSelection();
    else if (e.code === 'KeyG') { this.snap.grid = this.snap.grid ? 0 : 0.5; this.attachGizmo(); this.renderBox('toolbar'); this.toast(this.snap.grid ? 'Grid snap 0.5 m' : 'Grid snap off'); }
    else if (e.code === 'KeyT') { this.cam.mode = this.cam.mode === 'orbit' ? 'fly' : 'orbit'; this.renderBox('toolbar'); this.toast(this.cam.mode === 'fly' ? 'Fly camera: WASD, Q / E, drag to look' : 'Orbit camera: drag to turn round the view centre'); }
    else if (/^Digit[1-4]$/.test(e.code)) { const m = (['select', 'move', 'rotate', 'scale'] as Mode[])[+e.code.slice(5) - 1]; if (this.tool.t !== 'select') this.setTool({ t: 'select' }); this.setMode(m); }
  }

  // -------------------------------------------------------------------------------------------
  // Per frame (the app's frame loop calls this instead of drawing the flight)

  frame(now: number) {
    if (this.disposed) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const pad = this.host.ctx.input.pads().find((p) => isStandard(p)) ?? null;
    this.cam.tick(dt, document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) ? null : pad);
    // brush cursor and strokes
    const brush = this.tool.t === 'sculpt' ? this.pal.brush.radius : this.tool.t === 'trees' ? this.pal.trees.radius : 0;
    let hit: { p: Vec3 } | null = null;
    if (brush && this.pointer) hit = this.terrainHit(this.ray(this.pointer.x, this.pointer.y));
    this.cursor.visible = !!hit;
    if (hit) { T3(hit.p[0], hit.p[1], hit.p[2] + 0.15, this.cursor.position); this.cursor.scale.setScalar(brush); }
    if (this.stroke && hit) this.strokeStep(hit.p, dt);
    const b = this.bundle;
    if (!b) return;
    const w = this.ed.doc.environment?.wind;
    b.setWind(w?.speed ?? 2, w?.directionDeg ?? 240, now / 1000);
    const tg = this.cam.target;
    b.sun.position.copy(b.sunDir).multiplyScalar(120).add(tg); b.sun.target.position.copy(tg);
    const r = this.host.ctx.renderer;
    if (now - this.lastShadow > 150) { r.shadowMap.needsUpdate = true; this.lastShadow = now; }
    r.setRenderTarget(null);
    r.render(b.scene, this.cam.cam);
  }

  onMenu() { void this.exit(); }

  // -------------------------------------------------------------------------------------------
  // Brushes

  private beginStroke() {
    if (this.tool.t === 'sculpt') {
      const g = this.ed.doc.ground;
      if (g?.type !== 'heightfield' || !this.ed.grid) { this.toast('Sculpting needs a heightfield ground: Freestyle → Terrain → Convert to heightfield'); return; }
      let target: number | undefined;
      if (this.pal.brush.op === 'flatten' && this.pointer) { const h = this.terrainHit(this.ray(this.pointer.x, this.pointer.y)); target = h?.p[2]; }
      this.pal.brush.target = target;
      this.stroke = { kind: 'sculpt', before: this.ed.grid.data.slice(), rect: null, added: [], erased: new Set(), acc: 1 };
    } else this.stroke = { kind: 'trees', rect: null, added: [], erased: new Set(), acc: 1 };
  }

  private strokeStep(p: Vec3, dt: number) {
    const s = this.stroke!;
    if (s.kind === 'sculpt') {
      const g = this.ed.doc.ground as HfGround, grid = this.ed.grid!;
      const r = sculpt(grid, g, this.pal.brush, p[0], p[1], dt);
      if (!r) return;
      s.rect = unionRect(s.rect, r);
      // the live terrain (ray casts, the preview mesh) follows the grid
      const hf = this.hfNow()!;
      for (let j = r.y0; j <= r.y1; j++) for (let i = r.x0; i <= r.x1; i++) hf.data[j * grid.w + i] = grid.data[j * grid.w + i] / 65535;
      this.updateSculptMesh(r);
      return;
    }
    s.acc += dt;
    if (s.acc < 0.12) return;
    s.acc = 0;
    const T = this.pal.trees, trees = this.ed.doc.trees ?? [], R = T.radius;
    const inside = (q: number[]) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= R;
    if (T.erase) { trees.forEach((t, i) => { if (inside(t.pos)) s.erased.add(i); }); s.added = s.added.filter((t) => !inside(t.pos)); }
    else {
      const all = [...trees.filter((_, i) => !s.erased.has(i)).map((t) => t.pos), ...s.added.map((t) => t.pos)];
      const want = Math.round((T.density / 100) * Math.PI * R * R), have = all.filter(inside).length;
      const room = BUDGETS.trees - (trees.length - s.erased.size) - s.added.length;
      for (let k = 0, tries = 0; k < Math.min(want - have, room) && tries < 40; tries++) {
        const a = Math.random() * 2 * Math.PI, d = Math.sqrt(Math.random()) * R, x = r3(p[0] + Math.cos(a) * d), y = r3(p[1] + Math.sin(a) * d);
        if (all.some((q) => Math.hypot(q[0] - x, q[1] - y) < 2)) continue;
        const h = r3(T.hMin + Math.random() * (T.hMax - T.hMin)), type = T.type === 'mixed' ? (Math.random() < 0.5 ? 'pine' : 'oak') : T.type;
        const t: TreeDoc = { pos: [x, y], height: h, radius: r3(Math.min(20, h * (type === 'oak' ? 0.38 : 0.28))), type };
        s.added.push(t); all.push(t.pos); k++;
      }
    }
    this.drawTreePreview();
  }

  private drawTreePreview() {
    for (const c of this.treePreview.children) (c as THREE.Mesh).geometry.dispose();
    this.treePreview.clear();
    const s = this.stroke, f = this.def?.terrain;
    if (!s || !f) return;
    const cone = new THREE.ConeGeometry(1, 1, 8), mk = (color: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 });
    const add = (t: TreeDoc, color: number) => { const m = new THREE.Mesh(cone, mk(color)); m.scale.set(t.radius, t.height, t.radius); T3(t.pos[0], t.pos[1], f(t.pos[0], t.pos[1]) + t.height / 2, m.position); this.treePreview.add(m); };
    for (const t of s.added) add(t, 0x2f8f3a);
    for (const i of s.erased) { const t = this.ed.doc.trees?.[i]; if (t) add(t, 0xef4444); }
  }

  private endStroke() {
    const s = this.stroke;
    if (!s) return;
    this.stroke = null;
    if (s.kind === 'sculpt' && s.rect && s.before && this.ed.grid) {
      const g = this.ed.grid;
      this.ed.record('Sculpt', [{ k: 'rect', x0: s.rect.x0, y0: s.rect.y0, w: s.rect.x1 - s.rect.x0 + 1, h: s.rect.y1 - s.rect.y0 + 1, before: cutRect(s.before, g.w, s.rect), after: cutRect(g.data, g.w, s.rect) }]);
      this.hfGrid = this.ed.grid; // the mirror is already up to date
      this.rebuild();
    } else if (s.kind === 'trees' && (s.added.length || s.erased.size)) {
      const next = [...(this.ed.doc.trees ?? []).filter((_, i) => !s.erased.has(i)), ...s.added];
      this.ed.apply(s.erased.size ? 'Erase trees' : 'Paint trees', [{ k: 'set', path: ['trees'], v: next.length ? next : undefined }]);
    }
    this.drawTreePreview();
  }

  /** While the sculpt tool is on: the terrain tiles hide and an editable grid mesh shows the heights. */
  private applySculptView() {
    const on = this.tool.t === 'sculpt' && this.ed.doc.ground?.type === 'heightfield' && !!this.ed.grid;
    // (by layer: the clutter's LOD switches its meshes' visibility itself every frame)
    if (this.bundle) for (const o of this.bundle.scene.children) if (o.name === 'terrain' || o.name === 'clutter') o.layers.set(on ? 31 : 0);
    if (!on) { if (this.sculptMesh) { this.sculptMesh.removeFromParent(); this.sculptMesh.geometry.dispose(); this.sculptMesh = null; } return; }
    const grid = this.ed.grid!, g = this.ed.doc.ground as HfGround;
    const st = Math.max(1, Math.ceil((grid.w - 1) / 256)), nx = Math.floor((grid.w - 1) / st) + 1, ny = Math.floor((grid.h - 1) / st) + 1;
    const key = `${grid.w}x${grid.h}|${JSON.stringify(g)}`;
    if (this.sculptMesh?.userData.key === key) { this.updateSculptMesh({ x0: 0, y0: 0, x1: grid.w - 1, y1: grid.h - 1 }); return; }
    if (this.sculptMesh) { this.sculptMesh.removeFromParent(); this.sculptMesh.geometry.dispose(); }
    const m = new THREE.Mesh(gridMesh(nx, ny), new THREE.MeshStandardMaterial({ color: 0x7d8f5a, roughness: 1 }));
    m.userData = { key, st, nx, ny };
    m.receiveShadow = true;
    this.sculptMesh = m; this.extras.add(m);
    this.updateSculptMesh({ x0: 0, y0: 0, x1: grid.w - 1, y1: grid.h - 1 });
  }

  private updateSculptMesh(r: Rect) {
    const m = this.sculptMesh, grid = this.ed.grid, g = this.ed.doc.ground;
    if (!m || !grid || g?.type !== 'heightfield') return;
    const { st, nx, ny } = m.userData as { st: number; nx: number; ny: number }, F = hfFrame(g, grid), pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
    const dz = g.zMax - g.zMin;
    // only the display vertices inside the touched pixels
    for (let jj = Math.max(0, Math.floor(r.y0 / st)); jj <= Math.min(ny - 1, Math.ceil(r.y1 / st)); jj++) for (let ii = Math.max(0, Math.floor(r.x0 / st)); ii <= Math.min(nx - 1, Math.ceil(r.x1 / st)); ii++) {
      const i = Math.min(grid.w - 1, ii * st), j = Math.min(grid.h - 1, jj * st), [x, y] = F.toWorld(i, j);
      pos.setXYZ(jj * nx + ii, x, g.zMin + (dz * grid.data[j * grid.w + i]) / 65535, -y);
    }
    pos.needsUpdate = true;
    m.geometry.computeVertexNormals();
    m.geometry.computeBoundingSphere();
  }

  // -------------------------------------------------------------------------------------------
  // Placing things

  private heading(): number { const f = new THREE.Vector3(-Math.sin(this.cam.yaw), 0, -Math.cos(this.cam.yaw)); return Math.atan2(-f.z, f.x) / DEG; }
  private snapAngle(d: number) { const a = this.snap.angle; return Math.round((a ? Math.round(d / a) * a : d) * 100) / 100; }
  private snapXY(v: number) { const g = this.snap.grid; return r3(g ? Math.round(v / g) * g : v); }

  /** The point a placement goes to: the ground, or the top of the primitive / gate under the cursor. */
  private placeHit(rc: THREE.Raycaster): { p: Vec3; on: Path | null; surface: boolean } | null {
    const t = this.terrainHit(rc), h = this.overlay.raycast(rc);
    if (h && (!t || h.distance < t.dist - 0.01) && (h.ref[0] === 'primitives' || h.ref[0] === 'gates' || h.ref[0] === 'courses')) {
      const p = ENU(h.point);
      return { p: [this.snapXY(p[0]), this.snapXY(p[1]), r3(p[2])], on: h.ref, surface: true };
    }
    if (!t) return null;
    const x = this.snapXY(t.p[0]), y = this.snapXY(t.p[1]);
    return { p: [x, y, r3(this.def!.terrain(x, y))], on: null, surface: false };
  }

  place(rc: THREE.Raycaster, p: Place) {
    const at = this.placeHit(rc);
    if (!at || !this.def) { this.toast('Click on the ground or on an object'); return; }
    const [x, y, z] = at.p, hd = this.snapAngle(this.heading()), doc = this.ed.doc;
    const ins = (path: Path, v: unknown): { op: Op; ref: Path } => { const n = (this.ed.get(path) as unknown[] | undefined)?.length ?? 0; return { op: { k: 'ins', path, i: n, v }, ref: [...path, n] }; };
    let made: { op: Op; ref: Path }[] = [], label = 'Add';
    switch (p.kind) {
      case 'gate': {
        if (this.s.course >= 0 && !doc.courses?.[this.s.course]) this.setCourse(-1);
        const G = this.pal.gate, base = coursePath(this.s.course);
        const g: GateDoc = { kind: p.gate, pos: [x, y], ...(Math.abs(this.snapAngle(this.cam.yaw / DEG)) > 1e-6 && { yawDeg: this.snapAngle(this.cam.yaw / DEG) }) };
        if (G.width) g.width = G.width;
        if (G.height) g.height = G.height;
        if (p.gate === 'ladder' && G.stack) g.stack = G.stack;
        const below = at.on && (at.on[0] === 'gates' || at.on[0] === 'courses') ? (at.on[0] === 'gates' ? this.def.gates[at.on[1] as number] : this.def.courses?.[at.on[1] as number]?.gates[at.on[3] as number]) : null;
        if (below) { g.pos = [r3(below.c.x), r3(below.c.y), r3(below.c.z + below.height + 2 * GATE_T)]; g.onTop = true; g.yawDeg = Math.round((below.yaw / DEG) * 100) / 100; }
        else if (p.gate === 'dive') g.pos = [x, y, r3(z + 2)];
        else if (at.surface) { g.pos = [x, y, z]; g.onTop = true; }
        made = [ins(base, g)]; label = 'Add gate';
        break;
      }
      case 'prim': {
        const P = this.pal.prim, common = { material: P.material, ...(P.color && { color: P.color }) };
        const v: PrimDoc = p.type === 'box' ? { type: 'box', pos: [x, y, r3(z + P.size[2] / 2)], size: [...P.size] as Vec3, ...common, visual: P.visual, ...(P.texture && { texture: P.texture }) }
          : p.type === 'cylinder' ? { type: 'cylinder', pos: [x, y, z], radius: P.radius, height: P.height, ...common } : { type: 'sphere', pos: [x, y, r3(z + P.radius)], radius: P.radius, ...common };
        made = [ins(['primitives'], v)]; label = `Add ${p.type}`;
        break;
      }
      case 'prefab': {
        const pf = prefabById(p.id)!, params = { ...prefabDefaults(pf), ...(this.pal.prefab[p.id] ?? {}) }, g = this.ed.uid('g');
        const out = placePrefab(pf, params, [x, y, z], hd, g);
        if (out.lights.length && (doc.lights?.length ?? 0) + out.lights.length > BUDGETS.lights) { this.toast(`A map can have at most ${BUDGETS.lights} lights`); return; }
        const n = doc.primitives?.length ?? 0, nl = doc.lights?.length ?? 0;
        const ops: Op[] = [...out.prims.map((v, i): Op => ({ k: 'ins', path: ['primitives'], i: n + i, v })), ...out.lights.map((v, i): Op => ({ k: 'ins', path: ['lights'], i: nl + i, v })), { k: 'set', path: ['x-builder', 'groups', g], v: { prefab: p.id, params, pos: [x, y, z], yawDeg: hd } }];
        this.ed.apply(`Add ${pf.name.toLowerCase()}`, ops);
        this.select([...out.prims.map((_, i): Path => ['primitives', n + i]), ...out.lights.map((_, i): Path => ['lights', nl + i])]);
        return;
      }
      case 'spawnPad': case 'spawn': {
        const ids = (doc.spawns ?? []).map((s) => s.id), id = freeId(ids, 'spawn'), g = p.kind === 'spawnPad' ? this.ed.uid('g') : undefined;
        const spawn = { id, name: `Spawn ${id.split('-').pop()}`, pos: [x, y, r3(z + (p.kind === 'spawnPad' ? 0.04 : 0))], yawDeg: hd, ...(g && { 'x-group': g }) };
        made = [ins(['spawns'], spawn)];
        if (g) made.push(ins(['primitives'], { type: 'box', pos: [x, y, r3(z + 0.02)], size: [1.2, 1.2, 0.04], visual: 'pad', material: 'concrete', 'x-group': g }));
        label = 'Add spawn';
        break;
      }
      case 'light':
        if ((doc.lights?.length ?? 0) >= BUDGETS.lights) { this.toast(`A map can have at most ${BUDGETS.lights} lights`); return; }
        made = [ins(['lights'], { pos: [x, y, r3(z + 3)], color: '#fff1dc', intensity: 150, range: 30 })]; label = 'Add light';
        break;
      case 'indoor': made = [ins(['indoor'], { min: [r3(x - 5), r3(y - 5), z], max: [r3(x + 5), r3(y + 5), r3(z + 4)], windScale: 0.1 })]; label = 'Add indoor zone'; break;
      case 'wake': made = [ins(['wakeZones'], { pos: [x, y], radius: 4, height: 8, intensity: 1 })]; label = 'Add wake zone'; break;
      case 'tree': { const T = this.pal.trees, h = r3((T.hMin + T.hMax) / 2), type = T.type === 'mixed' ? 'pine' : T.type; made = [ins(['trees'], { pos: [x, y], height: h, radius: r3(h * 0.3), type })]; label = 'Add tree'; break; }
      case 'actor': {
        const a = structuredClone(p.actor) as ActorDoc & { pos?: Vec3 };
        a.id = freeId((doc.actors ?? []).map((q) => q.id), a.id);
        const lift = a.type === 'target' ? 0 : a.type === 'ground-station' ? 6 : 3;
        a.pos = [x, y, r3(z + lift)];
        if (a.type === 'detector' && a.yawDeg === undefined) a.yawDeg = hd;
        made = [ins(['actors'], a)]; label = `Add ${a.name ?? a.type}`;
        break;
      }
    }
    if (!made.length) return;
    this.ed.apply(label, made.map((m) => m.op));
    this.select(made.map((m) => m.ref));
  }

  private addPathPoint(rc: THREE.Raycaster) {
    const at = this.placeHit(rc);
    if (!at || this.tool.t !== 'path') return;
    const pt: Vec3 = [at.p[0], at.p[1], r3(at.p[2] + 1)];
    if (this.tool.index === null || !this.ed.doc.paths?.[this.tool.index]) {
      if ((this.ed.doc.paths?.length ?? 0) >= BUDGETS.paths) { this.toast(`A map can have at most ${BUDGETS.paths} paths`); return; }
      const id = freeId((this.ed.doc.paths ?? []).map((p) => p.id), 'path'), i = this.ed.doc.paths?.length ?? 0;
      this.ed.apply('Add path', [{ k: 'ins', path: ['paths'], i, v: { id, points: [pt], speedMs: 3, mode: 'loop' } }]);
      this.tool = { t: 'path', index: i };
      this.select([['paths', i, 'points', 0]]);
    } else {
      const i = this.tool.index, n = this.ed.doc.paths![i].points.length;
      if (n >= BUDGETS.pathPoints) { this.toast(`A path can have at most ${BUDGETS.pathPoints} points`); return; }
      this.ed.apply('Add path point', [{ k: 'ins', path: ['paths', i, 'points'], i: n, v: pt }], undefined);
      this.select([['paths', i, 'points', n]]);
    }
  }

  private finishPath() {
    if (this.tool.t !== 'path' || this.tool.index === null) return;
    const p = this.ed.doc.paths?.[this.tool.index];
    if (p && p.points.length < 2) this.toast('A path needs at least two points: click once more, or delete it');
  }

  // -------------------------------------------------------------------------------------------
  // Edit commands (toolbar, keys, inspector)

  undo() { const l = this.ed.undo(); this.toast(l ? `Undid ${l.toLowerCase()}` : 'Nothing to undo', 1500); }
  redo() { const l = this.ed.redo(); this.toast(l ? `Redid ${l.toLowerCase()}` : 'Nothing to redo', 1500); }

  del() {
    if (!this.sel.length) return;
    const arr = this.sel.filter((r) => typeof r[r.length - 1] === 'number'), ops: Op[] = this.ed.removeOps(arr);
    if (this.sel.some((r) => key(r) === key(['pilot']))) ops.push({ k: 'set', path: ['pilot'], v: undefined });
    // prefab groups whose every part goes: their record goes too
    for (const g of Object.keys(this.ed.meta.groups ?? {})) { const m = groupMembers(this.ed.doc, g); if (m.length && m.every((p) => arr.some((r) => key(r) === key(p)))) ops.push({ k: 'set', path: ['x-builder', 'groups', g], v: undefined }); }
    if (!ops.length) { this.toast('The main spawn can be moved but not deleted'); return; }
    this.sel = [];
    this.ed.apply(`Delete ${arr.length === 1 ? 'object' : `${arr.length} objects`}`, ops);
  }

  private pivotOf(refs: Path[]): Vec3 {
    const f = this.def!.terrain, c: Vec3 = [0, 0, 0];
    let n = 0;
    for (const r of refs) { const a = anchorOf(refKind(r)!, this.ed.get(r) as Record<string, unknown>, f, this.ed.doc); if (a) { c[0] += a[0]; c[1] += a[1]; c[2] += a[2]; n++; } }
    return n ? [c[0] / n, c[1] / n, c[2] / n] : c;
  }

  /** count copies, each moved by d (ENU) and turned by yawDeg about the selection's centre more than the last. */
  copies(count: number, d: Vec3, yawDeg: number, label = count === 1 ? 'Duplicate' : `Array of ${count}`) {
    if (!this.sel.length || !this.def) return;
    const refs = this.sel.filter((r) => refKind(r) && refKind(r) !== 'mainSpawn' && refKind(r) !== 'pilot');
    const pivot = this.pivotOf(refs), st: CopyState = { counts: new Map(), newIds: new Map() }, ops: Op[] = [], added: Path[] = [];
    for (let k = 1; k <= count; k++) {
      const r = copyOps(this.ed, refs, { pivot, d: [d[0] * k, d[1] * k, d[2] * k], yawDeg: yawDeg * k, s: [1, 1, 1], frameYawDeg: 0 }, this.def.terrain, st);
      ops.push(...r.ops); added.push(...r.added);
    }
    if (!ops.length) return;
    this.ed.apply(label, ops);
    this.select(added);
  }
  duplicate() { const g = this.snap.grid || 1; this.copies(1, [Math.max(1, g * 2), 0, 0], 0); }

  toGround() { if (this.def && this.sel.length) this.ed.apply('Align to ground', groundOps(this.ed, this.sel, this.def.terrain)); }

  frameSelection() {
    if (!this.def) return;
    if (!this.sel.length) { const s = this.ed.doc.spawn?.pos ?? [0, 0, 0]; this.cam.frame(T3(s[0], s[1], s[2]), 15); return; }
    const p = this.pivotOf(this.sel), c = T3(p[0], p[1], p[2]);
    let r = 2;
    for (const ref of this.sel) { const a = anchorOf(refKind(ref)!, this.ed.get(ref) as Record<string, unknown>, this.def.terrain, this.ed.doc); if (a) r = Math.max(r, T3(a[0], a[1], a[2]).distanceTo(c) + 2); }
    this.cam.frame(c, r);
  }

  /** Set props on every selected object at once (the inspector's fields). */
  setProps(paths: Path[], v: unknown, label: string, merge?: string) { this.ed.apply(label, paths.map((p) => ({ k: 'set', path: p, v: structuredClone(v) })), merge); }

  terrainAt(x: number, y: number) { return this.def?.terrain(x, y) ?? 0; }

  // -------------------------------------------------------------------------------------------
  // Terrain and imports

  convertToHeightfield(res = this.pal.hfRes) {
    const doc = this.ed.doc, { ground, grid } = toHeightfield(doc.ground, this.hfNow(), doc.size, res);
    this.ed.apply('Convert to heightfield', [{ k: 'set', path: ['ground'], v: ground }, { k: 'grid', v: grid }]);
    this.toast(`Ground is now a ${res} x ${res} heightfield (${ground.zMin} … ${ground.zMax} m)`);
  }

  /** Images (textures), .glb meshes and heightfield PNGs (by name: "height…"). */
  async importFile(f: File): Promise<string | null> {
    if (/\.glb$/i.test(f.name)) return this.importGlb(f);
    if (/\.(png|jpe?g|webp)$/i.test(f.name)) return /height/i.test(f.name) ? this.importHeightfield(f) : this.importTexture(f);
    this.toast(`${f.name}: drop a texture (.png / .jpg / .webp), a mesh (.glb) or a heightfield PNG`);
    return null;
  }

  private assetPath(dir: string, name: string) {
    const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '').slice(-60) || 'file';
    let p = `${dir}/${base}`, i = 1;
    while (this.ed.assets.has(p)) p = `${dir}/${base.replace(/(\.[a-z0-9]+)$/, `-${++i}$1`)}`;
    return p;
  }

  async importTexture(f: File, target?: Path): Promise<string | null> {
    const b = new Uint8Array(await f.arrayBuffer()), sz = imageSize(b);
    if (!sz) { this.toast(`${f.name} is not a PNG, JPEG or WebP image`); return null; }
    if (sz.w > BUDGETS.texturePx || sz.h > BUDGETS.texturePx) { this.toast(`${f.name} is ${sz.w}x${sz.h} px; textures may be at most ${BUDGETS.texturePx} px a side`); return null; }
    if (b.length > BUDGETS.textureBytes) { this.toast(`${f.name} is ${(b.length / 1024).toFixed(0)} KiB; textures may be at most ${BUDGETS.textureBytes / 1024} KiB`); return null; }
    const p = this.assetPath('textures', f.name), ops: Op[] = [{ k: 'asset', path: p, v: new Blob([b], { type: f.type || 'image/png' }) }];
    if (target) ops.push({ k: 'set', path: target, v: p });
    this.ed.apply(`Import ${f.name}`, ops);
    this.toast(`Imported ${p}. Credit its author under Map → Asset credits.`);
    return p;
  }

  async importGlb(f: File, collision: 'mesh' | 'box' | 'none' = 'box'): Promise<string | null> {
    if (f.size > BUDGETS.fileBytes) { this.toast(`${f.name} is larger than ${BUDGETS.fileBytes / 1048576} MiB`); return null; }
    if ((this.ed.doc.geometry?.length ?? 0) >= BUDGETS.geometry) { this.toast(`A map can have at most ${BUDGETS.geometry} geometry entries`); return null; }
    const blob = new Blob([await f.arrayBuffer()], { type: 'model/gltf-binary' }), t = await glbInfo(blob);
    if (t instanceof Error) { this.toast(`${f.name}: ${t.message}`); return null; }
    if (this.meshStats.triangles + t.triangles > BUDGETS.meshTriangles) { this.toast(`${f.name} has ${t.triangles} triangles: over the ${BUDGETS.meshTriangles}-triangle budget with the meshes already in the map`); return null; }
    if (collision === 'mesh' && this.meshStats.collision + t.triangles > BUDGETS.collisionTriangles) { collision = 'box'; this.toast(`${t.triangles} triangles is too many for mesh collision (budget ${BUDGETS.collisionTriangles}): using a box`); }
    const p = this.assetPath('meshes', f.name), tg = ENU(this.cam.target), z = r3(this.terrainAt(tg[0], tg[1])), i = this.ed.doc.geometry?.length ?? 0;
    this.ed.apply(`Import ${f.name}`, [{ k: 'asset', path: p, v: blob }, { k: 'ins', path: ['geometry'], i, v: { type: 'gltf', src: p, pos: [r3(tg[0]), r3(tg[1]), z], collision } }]);
    this.select([['geometry', i]]);
    return p;
  }

  async importHeightfield(f: File): Promise<string | null> {
    const b = new Uint8Array(await f.arrayBuffer()), sz = imageSize(b);
    if (sz?.type !== 'png') { this.toast('Heightfields are greyscale PNGs (8 or 16 bit)'); return null; }
    if (sz.w > BUDGETS.heightfieldPx || sz.h > BUDGETS.heightfieldPx || sz.w < 2 || sz.h < 2) { this.toast(`${sz.w}x${sz.h} px: heightfields must be 2 … ${BUDGETS.heightfieldPx} px a side`); return null; }
    let hf;
    try { hf = await decodePngChannel(b); } catch (e) { this.toast(`${f.name}: ${(e as Error).message}`); return null; }
    const g0 = this.ed.doc.ground, size = this.ed.doc.size;
    const ground: HfGround = g0?.type === 'heightfield' ? { ...g0 } : { type: 'heightfield', image: 'heightfield.png', extent: [2 * size, 2 * size], zMin: 0, zMax: 30, ...(g0?.material && { material: g0.material }) };
    this.ed.apply('Import heightfield', [{ k: 'set', path: ['ground'], v: ground }, { k: 'grid', v: gridFromHf(hf) }]);
    this.toast(`Heightfield ${hf.w} x ${hf.h} px over ${ground.extent[0]} x ${ground.extent[1]} m, ${ground.zMin} … ${ground.zMax} m: adjust under Terrain`);
    return ground.image;
  }

  async exportHeightfield() {
    const g = this.ed.grid;
    if (!g) return;
    download((await encodePng(g.w, g.h, g.data, 'gray16')) as BlobPart, 'heightfield.png', 'image/png');
  }

  /** A 640 x 360 picture of the current view as the map's preview (meta.preview). */
  capturePreview() {
    const b = this.bundle;
    if (!b) return;
    const r = this.host.ctx.renderer;
    r.render(b.scene, this.cam.cam); // the drawing buffer is only readable right after a render
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const g = c.getContext('2d')!, src = this.canvas, a = 16 / 9, sw = Math.min(src.width, src.height * a), sh = sw / a;
    g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, 640, 360);
    c.toBlob((blob) => {
      if (!blob) return;
      if (blob.size > BUDGETS.previewBytes) { this.toast('The preview came out too large'); return; }
      const p = blob.type === 'image/webp' ? 'preview.webp' : 'preview.jpg';
      const ops: Op[] = [{ k: 'asset', path: p, v: blob }, { k: 'set', path: ['meta', 'preview'], v: p }];
      const old = this.ed.doc.meta.preview;
      if (old && old !== p && this.ed.assets.has(old)) ops.push({ k: 'asset', path: old, v: null });
      this.ed.apply('Capture preview', ops);
      this.toast(`Preview captured (${(blob.size / 1024).toFixed(0)} KiB)`);
    }, 'image/webp', 0.82);
  }

  // -------------------------------------------------------------------------------------------
  // Fly, export, publish, exit

  /** Validate the whole package as the repository's validator does: the result shows in the problems list. */
  async validate(): Promise<CheckResult> {
    const files = await packageFiles(this.ed, { docs: true });
    this.check = await checkPackage(files);
    this.renderBox('problems', true);
    this.toast(this.check.errors.length ? `${this.check.errors.length} problem${this.check.errors.length === 1 ? '' : 's'} to fix before export` : `The package is valid${this.check.warnings.length ? ` (${this.check.warnings.length} warning${this.check.warnings.length === 1 ? '' : 's'})` : ''}`);
    return this.check;
  }

  /** Register the draft as local-<id> and fly it with the real physics and Betaflight. */
  async fly() {
    await this.saver.flush();
    let reg;
    try { reg = await loadLocalMap(await packageFiles(this.ed)); }
    catch (e) {
      if (e instanceof MapFormatError) { this.check = { errors: e.errors, warnings: e.warnings }; this.renderBox('problems', true); this.toast(`Can't fly yet: ${e.errors.length} problem${e.errors.length === 1 ? '' : 's'} (see the list below)`); return; }
      throw e;
    }
    const f = this.s.fly, doc = this.ed.doc;
    const courseId = doc.courses?.some((c) => c.id === f.course) ? f.course : '', spawnId = doc.spawns?.some((s) => s.id === f.spawn) ? f.spawn : '';
    this.s.cam = this.cam.save();
    this.dispose();
    this.host.fly({ mapId: reg.id, courseId, spawnId, race: f.race && (courseId ? true : (doc.gates?.length ?? 0) > 0) });
  }

  /** Run a scenario (the form's JSON) on this draft in the live sim. */
  async runScenario(sc: Record<string, unknown>) {
    await this.saver.flush();
    let reg;
    try { reg = await loadLocalMap(await packageFiles(this.ed)); }
    catch (e) { if (e instanceof MapFormatError) { this.check = { errors: e.errors, warnings: e.warnings }; this.renderBox('problems', true); this.toast('Fix the map\'s problems first'); return; } throw e; }
    const doc = { ...sc, map: { ...(sc.map as object | undefined), id: reg.id } };
    // checked here, while the editor still has the screen to say what is wrong
    const [{ parseScenario }, { hasMap }] = await Promise.all([import('../scenario/scenario'), import('../maps/maps')]);
    const { errors } = parseScenario(doc, hasMap);
    if (errors.length) { this.toast(`This scenario can't run: ${errors.slice(0, 2).join(' · ')}${errors.length > 2 ? ` (+${errors.length - 2})` : ''}`, 8000); return; }
    this.s.cam = this.cam.save();
    this.dispose();
    await this.host.runScenario(doc);
  }

  async exportZip() {
    const files = await packageFiles(this.ed, { docs: true }), r = await checkPackage(files);
    this.check = r; this.renderBox('problems', true);
    if (r.errors.length) { this.toast(`Export stopped: ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'} (see the list below)`, 5000); return; }
    const id = exportDoc(this.ed).meta.id;
    download((await zipPackage(files)) as BlobPart, `${id}.zip`, 'application/zip');
    this.toast(`Exported ${id}.zip: a package for public/maps/community/${id}/ (see docs/MAP_FORMAT.md). LICENSE.txt may need the full licence text.`, 7000);
  }

  get canPublish() { return !!this.host.onPublish; }
  async publish() {
    if (!this.host.onPublish) return;
    const files = await packageFiles(this.ed, { docs: true }), r = await checkPackage(files);
    this.check = r; this.renderBox('problems', true);
    if (r.errors.length) { this.toast(`Fix ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'} before publishing`, 5000); return; }
    await this.saver.flush();
    await this.host.onPublish(files, exportDoc(this.ed).meta);
  }

  async exit() {
    await this.saver.flush();
    this.s.cam = this.cam.save();
    this.dispose();
    this.host.leave();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.rebuildTimer);
    this.saver.stop();
    for (const f of this.off) f();
    this.tc.detach(); this.tc.dispose();
    this.overlay.dispose();
    this.extras.removeFromParent();
    if (this.sculptMesh) this.sculptMesh.geometry.dispose();
    this.bundle?.dispose(); this.bundle = null;
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.root.remove();
    document.body.classList.remove('fpv-editing');
  }
}

/** The map.json object a validator message is about ("map.json.primitives[3].size[0]: …" -> ["primitives", 3]). */
export function refOfMessage(t: string): Path | undefined {
  const m = /^map\.json\.(courses)\[(\d+)\]\.gates\[(\d+)\]/.exec(t) ?? /^map\.json\.(paths)\[(\d+)\]\.points\[(\d+)\]/.exec(t);
  if (m) return [m[1], +m[2], m[1] === 'courses' ? 'gates' : 'points', +m[3]];
  const n = /^map\.json\.(primitives|gates|trees|spawns|lights|indoor|wakeZones|actors|geometry)\[(\d+)\]/.exec(t);
  if (n) return [n[1], +n[2]];
  if (/^map\.json\.spawn\b/.test(t)) return ['spawn'];
  return undefined;
}

export { PICK_LAYER };
