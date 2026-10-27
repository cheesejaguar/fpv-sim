// Build mode: the map builder over the paused simulator, laid out and driven like the Unity and
// Unreal editors. It owns the screen while open: its own scene (the map rebuilt from the draft with
// buildMapDef + buildScene after every edit), its own camera (EditorCamera: right-drag looks and
// WASD flies, Alt-drag orbits, middle-drag pans, top / side views, orthographic), an overlay of gizmos
// and pick proxies with hover and selection outlines, a reference grid, three's TransformControls
// for move / rotate / scale, box selection, brushes (sculpt, trees), and the docked panels (layout.ts):
// Place (ui.ts), Outliner (outliner.ts), Details (ui.ts), Problems / History, the viewport toolbar
// and status bar (viewport.ts). Fly registers the draft as a local map and hands the screen back to
// the flight; "Back to editor" reopens it where the quad is.
import './editor.css';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GATE_T } from '../maps/gates';
import { loadLocalMap } from '../maps/localMaps';
import { BUDGETS, buildMapDef, decodePngChannel, imageSize, MapFormatError, validateMapDoc, type ActorDoc, type GateDoc, type MapAssets, type PrimDoc, type TreeDoc, type Vec3 } from '../maps/mapFormat';
import type { MapDef, Prim } from '../maps/world';
import { buildScene, primMatrix, type SceneBundle } from '../render/scene';
import { isStandard } from '../input/gamepad';
import { el, topModal } from '../ui/dom';
import { encodePng } from '../app/datasetFiles';
import { EditorCamera } from './camera';
import { copyClip, pasteOps, type Clip } from './clipboard';
import { circle, gridMesh } from './geom';
import { autosave } from './drafts';
import { allRefs, EditorDoc, followShifts, gridFromHf, gridHf, refKind, type Op, type Path } from './editorDoc';
import { RefGrid } from './grid';
import type { EditorHost, EditorView } from './host';
import { Docks, type DockName } from './layout';
import { ancestorsOf, outlineTree, outlinerHead, renderOutliner, type OutlineNode } from './outliner';
import { Overlay, PICK_LAYER, T3 } from './overlay';
import { budgetMeters, checkPackage, download, exportDoc, glbBounds, glbInfo, meshAssets, packageFiles, zipPackage, type CheckResult, type Meter } from './package';
import { placePrefab, prefabById, prefabDefaults } from './prefabs';
import { loadPrefs, savePrefs, stepSpeed, type EditorPrefs } from './prefs';
import { coursePath, raceProblems, type Problem } from './racing';
import { cutRect, hfFrame, sculpt, toHeightfield, unionRect, type Brush, type HfGround, type Rect } from './terrain';
import { Thumbs } from './thumbs';
import { anchorOf, copyOps, expandGroups, freeId, GROUPABLE, groundOps, groupMembers, transformOps, yawOf, type CopyState, type Xform } from './transform';
import { renderBottom, renderDetails, renderPalette, renderToolbar } from './ui';
import { AxisGizmo, closeMenu, inRect, renderStatus, renderViewbar, showHelp, showMenu, updateStatusLive, type MenuItem } from './viewport';

const DEG = Math.PI / 180;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const key = (p: Path) => JSON.stringify(p);
const ENU = (v: THREE.Vector3): Vec3 => [v.x, -v.z, v.y];
const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;
/** the drag-and-drop type of a Place panel tile */
export const PLACE_MIME = 'application/x-fpvsim-place';

export type Place =
  | { kind: 'gate'; gate: GateDoc['kind'] }
  | { kind: 'prim'; type: PrimDoc['type'] }
  | { kind: 'prefab'; id: string }
  | { kind: 'spawnPad' } | { kind: 'spawn' } | { kind: 'light' } | { kind: 'indoor' } | { kind: 'wake' } | { kind: 'tree' }
  | { kind: 'actor'; actor: ActorDoc };
export type Tool = { t: 'select' } | { t: 'place'; p: Place } | { t: 'trees' } | { t: 'sculpt' } | { t: 'path'; index: number | null };
export type Mode = 'select' | 'move' | 'rotate' | 'scale';

/** Place panel settings (kept while the editor is open). */
export interface PaletteState {
  tab: 'race' | 'freestyle' | 'environment' | 'simulation';
  /** the Place panel's search (across every tab) */
  query?: string;
  gate: { width?: number; height?: number; stack?: number };
  prim: { size: Vec3; radius: number; height: number; material: PrimDoc['material']; visual: Extract<PrimDoc, { type: 'box' }>['visual']; color?: string; texture?: string };
  prefab: Record<string, Record<string, number>>;
  trees: { density: number; radius: number; type: 'pine' | 'oak' | 'mixed'; hMin: number; hMax: number; erase: boolean };
  brush: Brush;
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
  /** hidden and locked objects (JSON-encoded paths: they follow inserts and deletes), open outliner folders */
  hidden?: Set<string>;
  locked?: Set<string>;
  open?: Set<string>;
}

interface Stroke { kind: 'sculpt' | 'trees'; before?: Uint16Array; rect: Rect | null; added: TreeDoc[]; erased: Set<number>; acc: number }
type DragHow = 'orbit' | 'look' | 'pan' | 'paint' | 'click' | 'marquee';

/** The clipboard: shared by every draft opened in this page. */
let clipboard: Clip | null = null;

export class Editor implements EditorView {
  readonly cam = new EditorCamera();
  readonly ed: EditorDoc;
  readonly overlay = new Overlay();
  readonly prefs: EditorPrefs = loadPrefs();
  readonly docks: Docks;
  readonly root: HTMLElement;
  readonly hidden: Set<string>;
  readonly locked: Set<string>;
  readonly thumbs: Thumbs;
  private extras = new THREE.Group();
  private pivot = new THREE.Object3D();
  private tc: TransformControls;
  private grid = new RefGrid();
  private axes: AxisGizmo;
  private bundle: SceneBundle | null = null;
  private sceneFog: THREE.Scene['fog'] = null;
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
  pal: PaletteState;
  outlinerQuery = '';
  /** a details field is being scrubbed: the panel must not be redrawn under the pointer */
  scrubbing = false;
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  private saver: ReturnType<typeof autosave>;
  saved = 'Saved';
  private last = performance.now();
  private lastShadow = 0;
  private drag: { id: number; x: number; y: number; x0: number; y0: number; button: number; moved: boolean; how: DragHow; shift: boolean; ctrl: boolean } | null = null;
  private pointer: { x: number; y: number } | null = null;
  private pointerMoved = false;
  /** the ground under the cursor (ENU), for the status bar and paste */
  cursor: Vec3 | null = null;
  private lastCursor = 0;
  private fps = 0;
  private lastStatus = 0;
  private stroke: Stroke | null = null;
  private dragState: { refs: Path[]; start: { p: THREE.Vector3; q: THREE.Quaternion; yaw: number }; owned: THREE.Object3D[]; moved: { obj: THREE.Object3D; parent: THREE.Object3D | null }[] } | null = null;
  private brushRing: THREE.LineSegments;
  private sculptMesh: THREE.Mesh | null = null;
  private treePreview = new THREE.Group();
  private off: (() => void)[] = [];
  private boxes: Record<'toolbar' | 'palette' | 'outliner' | 'details' | 'bottom' | 'status' | 'viewbar', HTMLElement>;
  private marquee = el('div', { class: 'ed-marquee', hidden: true });
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  readonly canvas: HTMLCanvasElement;

  constructor(readonly host: EditorHost, readonly s: Session) {
    this.ed = s.ed;
    this.canvas = host.ctx.renderer.domElement;
    this.hidden = s.hidden ??= new Set();
    this.locked = s.locked ??= new Set();
    s.open ??= new Set(['cat:courses', 'course:main', 'cat:start', 'cat:groups', 'cat:primitives', 'cat:lights', 'cat:indoor', 'cat:wakeZones', 'cat:actors', 'cat:geometry', 'cat:paths']);
    this.pal = s.pal ??= {
      tab: 'race', gate: {}, prim: { size: [2, 2, 1], radius: 0.5, height: 2, material: 'concrete', visual: 'concrete' }, prefab: {},
      trees: { density: 3, radius: 8, type: 'mixed', hMin: 6, hMax: 14, erase: false },
      brush: { op: 'raise', radius: 8, strength: 3, falloff: 'smooth' }, hfRes: 257, scenario: null,
    };
    this.cam.rightDrag = this.prefs.rightDrag; this.cam.speed = this.prefs.speed;
    this.thumbs = new Thumbs(host.ctx.renderer, () => this.renderBox('palette'));

    // ---- DOM: the docks, the viewport's overlays ----
    this.docks = new Docks(this.prefs, (r) => this.cam.setViewport(r.left, r.top, r.width, r.height), () => savePrefs(this.prefs));
    this.root = this.docks.root;
    const D = this.docks, body = (cls: string) => el('div', { class: cls });
    const palette = body('ed-dock-body'), bottom = body('ed-dock-body'), viewbar = body('ed-viewbar-host'), outList = body('ed-out-list');
    D.left.prepend(palette); D.bottom.prepend(bottom);
    this.axes = new AxisGizmo(this);
    D.view.append(viewbar, this.axes.canvas, this.marquee);
    D.outliner.append(outlinerHead(this), outList);
    this.boxes = { toolbar: D.bar, palette, outliner: outList, details: D.details, bottom, status: D.status, viewbar };
    document.body.append(this.root);
    document.body.classList.add('fpv-editing');
    this.docks.apply(); // laid out now: the camera centres on the viewport from the first frame

    // ---- scene extras: overlay, gizmo, grid, brush ring ----
    this.tc = new TransformControls(this.cam.cam, this.canvas);
    this.tc.setSize(0.9);
    const helper = this.tc.getHelper();
    this.extras.add(this.overlay.group, this.overlay.pick, this.pivot, helper, this.treePreview, this.grid.mesh);
    this.brushRing = new THREE.LineSegments(circle(64), new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.9, depthTest: false }));
    this.brushRing.renderOrder = 30; this.brushRing.visible = false;
    this.extras.add(this.brushRing);
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
    on(this.canvas, 'pointercancel', () => this.cancelDrag());
    on(this.canvas, 'pointerleave', () => { if (!this.drag) { this.pointer = null; this.cursor = null; this.brushRing.visible = false; this.overlay.setHover(null); } });
    on(this.canvas, 'dblclick', (e: MouseEvent) => this.onDouble(e));
    on(this.canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(this.canvas, 'contextmenu', (e: Event) => e.preventDefault());
    on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    on(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    on(window, 'blur', () => { this.cam.clearKeys(); this.cam.flying = false; });
    // drops on the view: a Place panel tile places it there; a texture, glb or heightfield file imports it
    on(this.canvas, 'dragover', (e: DragEvent) => { e.preventDefault(); this.pointer = { x: e.clientX, y: e.clientY }; this.pointerMoved = true; if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    on(this.canvas, 'drop', (e: DragEvent) => {
      e.preventDefault();
      const p = e.dataTransfer?.getData(PLACE_MIME);
      if (p) { try { this.place(this.ray(e.clientX, e.clientY), JSON.parse(p) as Place); } catch { /* not ours */ } return; }
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.importFile(f);
    });

    // ---- document ----
    this.saver = autosave(s.draftId, this.ed, (ok) => { this.saved = ok ? 'Saved' : 'Not saved (browser storage unavailable)'; this.renderBox('toolbar'); this.renderBox('status'); });
    this.off.push(this.ed.onChange((c) => {
      this.saved = 'Saving…';
      if (c.grid) this.hfGrid = null;
      // the selection, hidden and locked objects follow inserts and deletes
      if (c.shifts.length) {
        this.sel = followShifts(this.sel, c.shifts);
        for (const set of [this.hidden, this.locked]) { const next = followShifts([...set].map((k) => JSON.parse(k) as Path), c.shifts); set.clear(); for (const p of next) set.add(key(p)); }
      }
      if (this.prefs.bottomOpen && this.prefs.bottomTab === 'history') this.renderBox('bottom');
      this.scheduleRebuild();
    }));
    this.rebuild();
    if (s.warnings?.length) { this.toast(`Opened with ${s.warnings.length} problem${s.warnings.length === 1 ? '' : 's'}: see Problems`); this.openBottom('problems'); }
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

  /** Rebuild soon: at most every `ms` while edits keep coming (a scrub, a slider), so the view keeps up. */
  private scheduleRebuild(ms = 120) {
    if (this.rebuildTimer !== undefined) return;
    this.rebuildTimer = setTimeout(() => { this.rebuildTimer = undefined; this.rebuild(); }, ms);
  }

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

  /** The primitives that draw these objects: primitives, gate parts, solid targets. */
  private primsOf(refs: Path[]): Set<Prim> {
    const def = this.def!, ex = new Set<Prim>(), gateTag = new Set<string>(), targetTag = new Set<string>();
    const nMain = def.gates.length, courseStart = (c: number) => nMain + (def.courses ?? []).slice(0, c).reduce((a, x) => a + x.gates.length, 0);
    for (const r of refs) {
      if (r[0] === 'primitives' && r.length === 2) { const p = def.prims[this.primOffset + (r[1] as number)]; if (p) ex.add(p); }
      else if (r[0] === 'gates' && r.length === 2) gateTag.add(`gate${def.gates[r[1] as number]?.id}`);
      else if (r[0] === 'courses' && r.length === 4) gateTag.add(`gate${courseStart(r[1] as number) + (r[3] as number)}`);
      else if (r[0] === 'actors' && r.length === 2) { const a = this.ed.get(r) as ActorDoc | undefined; if (a?.type === 'target' && a.solid) targetTag.add(`target-${a.id}`); }
    }
    if (gateTag.size || targetTag.size) for (const p of def.prims) if (p.tag && (gateTag.has(p.tag) || targetTag.has(p.tag))) ex.add(p);
    return ex;
  }

  /** The MapDef the scene draws: hidden objects left out (exclude collects their primitives). */
  private viewDef(def: MapDef, exclude: Set<Prim>): MapDef {
    if (!this.hidden.size) return def;
    const doc = this.ed.doc, H = (p: Path) => this.hidden.has(key(p));
    for (const p of this.primsOf([...this.hidden].map((k) => JSON.parse(k) as Path))) exclude.add(p);
    const hiddenActors = new Set((doc.actors ?? []).filter((_, i) => H(['actors', i])).map((a) => a.id));
    const gltf: number[] = [];
    (doc.geometry ?? []).forEach((g, i) => { if (g.type === 'gltf') gltf.push(i); });
    this.meshes.forEach((m, k) => { if (H(['geometry', gltf[k]])) for (const b of m.brushes) exclude.add(b); });
    return {
      ...def,
      trees: def.trees.filter((_, i) => !H(['trees', i])),
      ...(def.lights && { lights: def.lights.filter((_, i) => !H(['lights', i])) }),
      ...(def.actors && { actors: def.actors.filter((a) => !hiddenActors.has(a.id)) }),
      ...(def.meshes && { meshes: def.meshes.filter((_, k) => !H(['geometry', gltf[k]])) }),
    };
  }

  /** Validate, build the MapDef, rebuild the scene (drag: primitives drawn by the gizmo drag instead) and the overlay. */
  rebuild(drag?: Set<Prim>) {
    clearTimeout(this.rebuildTimer); this.rebuildTimer = undefined;
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
        const ex = new Set<Prim>(drag ?? []), view = this.viewDef(def, ex);
        const b = buildScene(view, { timeOfDay: 'map', exclude: ex.size ? (p) => ex.has(p) : undefined });
        if (this.bundle) { this.bundle.scene.remove(this.extras); this.bundle.dispose(); }
        this.bundle = b; b.scene.add(this.extras);
        this.sceneFog = b.scene.fog;
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
      this.overlay.build({ doc: this.ed.doc, def: this.def, primOffset: this.primOffset, selected: new Set(this.sel.map(key)), course: this.s.course, hidden: this.hidden, locked: this.locked, show: this.prefs.show, meshBounds: this.meshBounds });
    } catch (e) { console.warn('editor overlay', e); }
    this.grid.mesh.visible = this.prefs.show.grid;
    this.attachGizmo();
  }

  // -------------------------------------------------------------------------------------------
  // Panels

  private renderers = { toolbar: renderToolbar, palette: renderPalette, outliner: renderOutliner, details: renderDetails, bottom: renderBottom, status: renderStatus, viewbar: renderViewbar };
  /** Re-render a panel, unless the pilot is typing in it (its own edit caused the change) or scrubbing a value. */
  renderBox(which: keyof Editor['renderers'], force = false) {
    const box = this.boxes[which];
    if (!force && box.contains(document.activeElement) && TYPING.test(document.activeElement!.tagName)) return;
    if (which === 'details' && this.scrubbing) return;
    const scroll = box.scrollTop;
    box.replaceChildren(this.renderers[which](this));
    box.scrollTop = scroll;
    // folded sections stay folded (by title, across selections and sessions)
    for (const d of box.querySelectorAll<HTMLDetailsElement>('details.ed-sec[data-sec]')) {
      const t = d.dataset.sec!;
      if (this.prefs.closed.includes(t)) d.open = false;
      d.addEventListener('toggle', () => { const c = new Set(this.prefs.closed); if (d.open) c.delete(t); else c.add(t); this.prefs.closed = [...c]; savePrefs(this.prefs); });
    }
  }
  renderAll() { for (const k of Object.keys(this.renderers) as (keyof Editor['renderers'])[]) this.renderBox(k); }

  toast(msg: string, ms = 3500) {
    const t = this.docks.toast;
    t.textContent = msg; t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }

  meters(): Meter[] {
    return budgetMeters(this.ed.doc, this.def, { triangles: this.meshStats.triangles, collision: this.meshStats.collision, bytes: [...this.ed.assets.values()].reduce((a, b) => a + b.size, 0) + (this.ed.grid ? this.ed.grid.data.length * 2 : 0) });
  }

  get racingLineLength() { return this.overlay.lineLength; }

  /** The builder's preferences changed (a menu, a toggle): keep them, apply them, redraw what shows them. */
  prefsChanged(overlay = false) {
    savePrefs(this.prefs);
    this.cam.rightDrag = this.prefs.rightDrag; this.cam.speed = this.prefs.speed;
    if (overlay) { this.refreshOverlay(); this.renderBox('palette'); } else this.attachGizmo();
    this.renderBox('viewbar'); this.renderBox('status');
  }

  toggleDock(d: DockName) { this.docks.toggle(d); this.renderBox('toolbar'); }
  openBottom(tab: EditorPrefs['bottomTab']) { this.prefs.bottomTab = tab; this.docks.toggle('bottom', true); this.renderBox('bottom', true); this.renderBox('toolbar'); }

  /** Grid / angle snapping in use (0 = off). */
  get snap() { const P = this.prefs; return { grid: P.snapOn ? P.grid : 0, angle: P.snapOn ? P.angle : 0 }; }
  toggleSnap() { this.prefs.snapOn = !this.prefs.snapOn; this.prefsChanged(); this.toast(this.prefs.snapOn ? `Snapping on: ${this.prefs.grid} m, ${this.prefs.angle}°` : 'Snapping off'); }
  setSpace(s: EditorPrefs['space']) { this.prefs.space = s; this.prefsChanged(); }
  setOrtho(on: boolean) { this.cam.orthographic = on; this.cam.update(); this.renderBox('viewbar'); }

  // -------------------------------------------------------------------------------------------
  // Selection, visibility, tools, gizmo

  /** Select: 'set' replaces, 'toggle' flips each (Shift / Ctrl click), 'add' and 'remove' change the set (box select). */
  select(refs: Path[], how: boolean | 'set' | 'toggle' | 'add' | 'remove' = 'set') {
    const mode = how === true ? 'toggle' : how === false ? 'set' : how;
    const next = mode === 'set' ? [] : [...this.sel];
    for (const r of refs) {
      const i = next.findIndex((p) => key(p) === key(r));
      if (mode === 'remove' || (mode === 'toggle' && i >= 0)) { if (i >= 0) next.splice(i, 1); }
      else if (i < 0) next.push(r);
    }
    this.sel = next.filter((r) => !this.hidden.has(key(r)));
    if (this.sel.length === 1 && this.sel[0][0] === 'paths') this.pal.scenario = null;
    // the outliner opens the folders the selection is in
    if (this.sel.length) for (const k of ancestorsOf(outlineTree(this.ed.doc, this.ed.meta), new Set(this.sel.map(key)))) this.s.open!.add(k);
    this.refreshOverlay();
    this.renderBox('details', true); this.renderBox('outliner'); this.renderBox('palette'); this.renderBox('status');
    this.boxes.outliner.querySelector('.ed-row-o.on')?.scrollIntoView({ block: 'nearest' });
  }

  selectAll() { this.select(allRefs(this.ed.doc).filter((r) => !this.hidden.has(key(r)) && !this.locked.has(key(r)))); }
  /** Every object of the same kinds as the selection. */
  selectSameKind() { const kinds = new Set(this.sel.map((r) => (r.length === 2 ? r[0] : r.length === 4 ? `${r[0]}.${r[2]}` : r[0]))); this.select(allRefs(this.ed.doc).filter((r) => kinds.has(r.length === 2 ? r[0] : r.length === 4 ? `${r[0]}.${r[2]}` : r[0]) && !this.locked.has(key(r)) && !this.hidden.has(key(r)))); }

  setHidden(refs: Path[], on: boolean) {
    for (const r of refs) { if (on) this.hidden.add(key(r)); else this.hidden.delete(key(r)); }
    if (on) this.sel = this.sel.filter((r) => !this.hidden.has(key(r)));
    this.rebuild();
  }
  hideSelection() { if (!this.sel.length) return; const n = this.sel.length; this.setHidden(this.sel, true); this.toast(`Hid ${n} object${n === 1 ? '' : 's'} · Alt+H shows everything`); }
  isolate() {
    if (!this.sel.length) return;
    const keep = new Set(this.sel.map(key));
    this.setHidden(allRefs(this.ed.doc).filter((r) => !keep.has(key(r))), true);
    this.toast('Isolated the selection · Alt+H shows everything');
  }
  showAll() { if (!this.hidden.size) return; this.hidden.clear(); this.rebuild(); this.toast('Everything is shown'); }

  setLocked(refs: Path[], on: boolean) {
    for (const r of refs) { if (on) this.locked.add(key(r)); else this.locked.delete(key(r)); }
    this.refreshOverlay();
    this.renderBox('outliner'); this.renderBox('details', true); this.renderBox('status'); this.renderBox('viewbar');
  }
  allLocked(): Path[] { return [...this.locked].map((k) => JSON.parse(k) as Path); }

  setTool(t: Tool) {
    if (this.tool.t === 'path' && t.t !== 'path') this.finishPath();
    this.tool = t;
    this.brushRing.visible = false;
    this.overlay.setHover(null);
    this.applySculptView();
    this.attachGizmo();
    this.renderBox('palette'); this.renderBox('viewbar'); this.renderBox('status');
    const hint = t.t === 'place' ? 'Click to place (or drag a tile onto the view) · Esc stops' : t.t === 'trees' ? 'Paint trees: drag on the ground' : t.t === 'sculpt' ? 'Sculpt: drag on the terrain' : t.t === 'path' ? 'Click to add path points · Enter or Esc finishes' : '';
    if (hint) this.toast(hint);
  }

  setMode(m: Mode) { this.mode = m; this.attachGizmo(); this.renderBox('viewbar'); }

  setCourse(c: number) { this.s.course = c; this.refreshOverlay(); this.renderBox('palette'); }

  private attachGizmo() {
    if (this.dragState) return;
    this.tc.camera = this.cam.cam;
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
    this.tc.setSpace(this.mode === 'scale' ? 'local' : this.prefs.space);
    this.tc.showX = this.tc.showZ = this.mode !== 'rotate';
    this.tc.showY = true;
    const s = this.snap;
    this.tc.setTranslationSnap(s.grid || null);
    this.tc.setRotationSnap(s.angle ? s.angle * DEG : null);
    this.tc.setScaleSnap(s.grid ? 0.1 : null);
    if (this.tc.object !== this.pivot) this.tc.attach(this.pivot);
  }

  /** Gizmo grabbed: the selected primitives leave the merged meshes and are drawn on the pivot instead. */
  private beginDrag() {
    if (!this.def || !this.sel.length) return;
    const refs = this.sel.filter((r) => { const o = this.ed.get(r) as Record<string, unknown> | undefined; return !!o && !(refKind(r) === 'actor' && !o.pos); });
    const ex = this.primsOf(refs);
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
    if (changed) this.ed.apply(this.mode === 'rotate' ? 'Rotate' : this.mode === 'scale' ? 'Scale' : 'Move', transformOps(this.ed, d.refs, t, this.def.terrain));
    this.rebuild(); // at once: the dragged parts go back into the merged meshes now
  }

  // -------------------------------------------------------------------------------------------
  // Pointer and keys

  ray(cx: number, cy: number): THREE.Raycaster {
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
    for (let t = 0.5; t < 8000; t += Math.max(0.5, t * 0.015)) {
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
    closeMenu();
    const t = this.tool.t, b = e.button;
    let how: DragHow;
    if (b === 2) how = this.prefs.rightDrag === 'fly' || t === 'sculpt' || t === 'trees' ? 'look' : 'orbit';
    else if (b === 1) how = 'pan';
    else if (b === 0 && e.altKey) how = 'orbit';
    else if (b === 0 && (t === 'sculpt' || t === 'trees')) how = 'paint';
    else how = 'click';
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, button: b, moved: false, how, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    if (how === 'look') { this.cam.flying = true; this.renderBox('status'); }
    this.canvas.setPointerCapture(e.pointerId);
    if (how === 'paint') this.beginStroke();
  }

  private onMove(e: PointerEvent) {
    this.pointer = { x: e.clientX, y: e.clientY };
    this.pointerMoved = true;
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
    if (!d.moved) {
      d.moved = true;
      // a left drag: a selection box with the select tool (not on touch screens: there it turns the view)
      if (d.how === 'click') d.how = this.tool.t === 'select' && e.pointerType !== 'touch' ? 'marquee' : e.shiftKey ? 'pan' : 'orbit';
      if (d.how === 'look' || d.how === 'orbit' || d.how === 'pan') this.canvas.style.cursor = d.how === 'pan' ? 'move' : 'grabbing';
    }
    d.x = e.clientX; d.y = e.clientY;
    if (d.how === 'orbit' || d.how === 'look') this.cam.turn(dx * 0.005, dy * 0.005, d.how === 'orbit');
    else if (d.how === 'pan') this.cam.pan(dx, dy);
    else if (d.how === 'marquee') this.drawMarquee(d.x0, d.y0, e.clientX, e.clientY);
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    this.canvas.style.cursor = '';
    if (d.how === 'look') { this.cam.flying = false; this.renderBox('status'); }
    if (d.how === 'paint') { this.endStroke(); return; }
    if (d.how === 'marquee') { this.finishMarquee(d, e); return; }
    // a right click without a drag: the context menu, on what is under the cursor
    if (d.button === 2 && !d.moved) {
      const rc = this.ray(e.clientX, e.clientY), h = this.tool.t === 'select' ? this.overlay.raycast(rc) : null;
      if (h && !this.sel.some((r) => key(r) === key(h.ref))) this.select(e.altKey || h.ref.length !== 2 ? [h.ref] : expandGroups(this.ed.doc, [h.ref]));
      const at = this.placeHit(rc)?.p ?? null;
      this.contextMenu(e.clientX, e.clientY, at);
      return;
    }
    if (d.moved || d.button !== 0) return;
    const rc = this.ray(e.clientX, e.clientY);
    if (this.tool.t === 'select') {
      const h = this.overlay.raycast(rc);
      if (!h) { if (!e.shiftKey && !e.ctrlKey && !e.metaKey) this.select([]); return; }
      this.select(e.altKey || h.ref.length !== 2 ? [h.ref] : expandGroups(this.ed.doc, [h.ref]), e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'set');
    } else if (this.tool.t === 'place') this.place(rc, this.tool.p);
    else if (this.tool.t === 'path') this.addPathPoint(rc);
  }

  private cancelDrag() {
    if (this.drag?.how === 'look') this.cam.flying = false;
    this.drag = null; this.endStroke(); this.marquee.hidden = true; this.canvas.style.cursor = '';
  }

  private onDouble(e: MouseEvent) {
    if (this.tool.t !== 'select') return;
    const h = this.overlay.raycast(this.ray(e.clientX, e.clientY));
    if (h) { this.select(e.altKey || h.ref.length !== 2 ? [h.ref] : expandGroups(this.ed.doc, [h.ref])); this.frameSelection(); }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (this.cam.flying) {
      // while flying, the wheel sets the speed (as in Unity / Unreal)
      const s = stepSpeed(this.prefs.speed, e.deltaY < 0 ? 1 : -1);
      if (s !== this.prefs.speed) { this.prefs.speed = s; this.prefsChanged(); this.toast(`Fly speed × ${s}`, 1200); }
      return;
    }
    const at = this.terrainHit(this.ray(e.clientX, e.clientY));
    this.cam.wheel(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY, at ? T3(at.p[0], at.p[1], at.p[2]) : null);
  }

  private drawMarquee(x0: number, y0: number, x1: number, y1: number) {
    const v = this.docks.view.getBoundingClientRect(), m = this.marquee;
    m.hidden = false;
    Object.assign(m.style, { left: `${Math.min(x0, x1) - v.left}px`, top: `${Math.min(y0, y1) - v.top}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
  }

  private finishMarquee(d: NonNullable<Editor['drag']>, e: PointerEvent) {
    this.marquee.hidden = true;
    if (!this.def) return;
    const f = this.def.terrain, cands: { ref: Path; p: Vec3 }[] = [];
    for (const r of allRefs(this.ed.doc)) {
      const k = key(r);
      if (this.hidden.has(k) || this.locked.has(k)) continue;
      const a = anchorOf(refKind(r)!, this.ed.get(r) as Record<string, unknown>, f, this.ed.doc);
      if (a) cands.push({ ref: r, p: a });
    }
    const hits = inRect(cands, this.cam.cam, { x0: d.x0, y0: d.y0, x1: e.clientX, y1: e.clientY }, this.canvas.getBoundingClientRect());
    const refs = expandGroups(this.ed.doc, hits.filter((r) => r.length === 2)).concat(hits.filter((r) => r.length !== 2));
    this.select(refs, d.ctrl ? 'remove' : d.shift ? 'add' : 'set');
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (TYPING.test(tgt.tagName) || tgt.isContentEditable)) return;
    // camera keys are always tracked (a key let go after the button still stops); they fly only while the right button is held
    if (/^(Key[WASDQE]|Shift(Left|Right))$/.test(e.code)) { this.cam.key(e.code, down); if (this.cam.flying && !e.ctrlKey && !e.metaKey) { e.preventDefault(); return; } }
    if (!down || topModal() || this.root.querySelector('.ed-help')) return;
    const mod = e.ctrlKey || e.metaKey, done = () => e.preventDefault();
    if (e.key === '?' && !mod) { done(); showHelp(this.root); return; }
    if (mod) {
      switch (e.code) {
        case 'KeyZ': done(); if (e.shiftKey) this.redo(); else this.undo(); return;
        case 'KeyY': done(); this.redo(); return;
        case 'KeyD': done(); this.duplicate(); return;
        case 'KeyC': done(); this.copy(); return;
        case 'KeyX': done(); this.cut(); return;
        case 'KeyV': done(); this.paste(this.cursor); return;
        case 'KeyA': done(); this.selectAll(); return;
        case 'KeyG': done(); if (e.shiftKey) this.ungroup(); else this.group(); return;
        case 'KeyS': done(); void this.saver.flush().then(() => this.toast('Saved', 1200)); return;
      }
      return;
    }
    if (e.altKey) {
      if (e.code === 'KeyH') { done(); this.showAll(); }
      else if (e.code === 'KeyP') { done(); void this.fly(); }
      return;
    }
    // arrows: nudge the selection; with nothing selected they move the view (as in Unity and Unreal)
    const nudge = (dx: number, dy: number, dz: number) => { done(); if (this.sel.length) this.nudge(dx, dy, dz, e.shiftKey ? 10 : 1); else this.moveView(dx, dy, dz, e.shiftKey ? 4 : 1); };
    switch (e.code) {
      case 'Delete': case 'Backspace': done(); this.del(); break;
      case 'Escape': done(); if (this.tool.t !== 'select') this.setTool({ t: 'select' }); else if (this.sel.length) this.select([]); break;
      case 'Enter': if (this.tool.t === 'path') { done(); this.setTool({ t: 'select' }); } break;
      case 'KeyQ': this.toolMode('select'); break;
      case 'KeyW': this.toolMode('move'); break;
      case 'KeyE': this.toolMode('rotate'); break;
      case 'KeyR': this.toolMode('scale'); break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': this.toolMode((['select', 'move', 'rotate', 'scale'] as Mode[])[+e.code.slice(5) - 1]); break;
      case 'KeyF': this.frameSelection(); break;
      case 'Home': done(); this.frameAll(); break;
      case 'KeyG': this.toggleSnap(); break;
      case 'KeyX': this.setSpace(this.prefs.space === 'world' ? 'local' : 'world'); this.toast(`${this.prefs.space === 'world' ? 'World' : 'Local'} axes`, 1200); break;
      case 'KeyH': if (e.shiftKey) this.isolate(); else this.hideSelection(); break;
      case 'End': done(); this.toGround(); break;
      case 'F2': done(); this.renameSelection(); break;
      case 'F1': done(); showHelp(this.root); break;
      case 'ArrowUp': nudge(0, 1, 0); break;
      case 'ArrowDown': nudge(0, -1, 0); break;
      case 'ArrowLeft': nudge(-1, 0, 0); break;
      case 'ArrowRight': nudge(1, 0, 0); break;
      case 'PageUp': nudge(0, 0, 1); break;
      case 'PageDown': nudge(0, 0, -1); break;
      case 'BracketLeft': done(); this.turnSelection(1); break;
      case 'BracketRight': done(); this.turnSelection(-1); break;
      case 'Numpad7': done(); this.cam.view('top'); break;
      case 'Numpad1': done(); this.cam.view('north'); break;
      case 'Numpad3': done(); this.cam.view('east'); break;
      case 'Numpad5': done(); this.setOrtho(!this.cam.orthographic); break;
    }
  }

  private toolMode(m: Mode) { if (this.tool.t !== 'select') this.setTool({ t: 'select' }); this.setMode(m); }

  // -------------------------------------------------------------------------------------------
  // Per frame (the app's frame loop calls this instead of drawing the flight)

  frame(now: number) {
    if (this.disposed) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (dt > 0) this.fps = this.fps ? this.fps * 0.95 + (1 / dt) * 0.05 : 1 / dt;
    const pad = this.host.ctx.input.pads().find((p) => isStandard(p)) ?? null;
    // (the view moved: what is under the cursor changed)
    if (this.cam.tick(dt, document.activeElement && TYPING.test(document.activeElement.tagName) ? null : pad)) this.pointerMoved = true;
    if (this.tc.camera !== this.cam.cam) this.attachGizmo();
    // the cursor: the ground under it, the hover outline, the brush ring
    const brush = this.tool.t === 'sculpt' ? this.pal.brush.radius : this.tool.t === 'trees' ? this.pal.trees.radius : 0;
    let hit: { p: Vec3 } | null = null;
    if (this.pointer && (this.pointerMoved || brush || this.stroke) && now - this.lastCursor > 40) {
      this.lastCursor = now; this.pointerMoved = false;
      const rc = this.ray(this.pointer.x, this.pointer.y);
      hit = this.terrainHit(rc);
      this.cursor = hit ? [hit.p[0], hit.p[1], hit.p[2]] : null;
      if (this.tool.t === 'select' && !this.drag && !this.tc.dragging && this.tc.axis === null) {
        const h = this.overlay.raycast(rc);
        this.overlay.setHover(h?.ref ?? null, !!h && this.sel.some((r) => key(r) === key(h.ref)));
        this.canvas.style.cursor = h ? 'pointer' : '';
      }
    } else if (brush && this.cursor) hit = { p: this.cursor };
    this.brushRing.visible = !!brush && !!hit;
    if (brush && hit) { T3(hit.p[0], hit.p[1], hit.p[2] + 0.15, this.brushRing.position); this.brushRing.scale.setScalar(brush); }
    if (this.stroke && hit) this.strokeStep(hit.p, dt);
    if (now - this.lastStatus > 200) { this.lastStatus = now; updateStatusLive(this.boxes.status, this.cursor, this.fps); }
    const b = this.bundle;
    if (!b) return;
    const tg = this.cam.target, f = this.def?.terrain;
    this.grid.update(tg, f ? f(tg.x, -tg.z) : 0, this.snap.grid, this.cam.dist);
    this.axes.draw(this.cam.cam.quaternion, this.cam.orthographic);
    // a plan view has no depth to fade: the fog is left out while the view is orthographic
    const fog = this.cam.orthographic ? null : this.sceneFog;
    if (b.scene.fog !== fog) b.scene.fog = fog;
    const w = this.ed.doc.environment?.wind;
    b.setWind(w?.speed ?? 2, w?.directionDeg ?? 240, now / 1000);
    b.sun.position.copy(b.sunDir).multiplyScalar(120).add(tg); b.sun.target.position.copy(tg);
    const r = this.host.ctx.renderer;
    if (now - this.lastShadow > 150) { r.shadowMap.needsUpdate = true; this.lastShadow = now; }
    this.thumbs.pump();
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
    const k = `${grid.w}x${grid.h}|${JSON.stringify(g)}`;
    if (this.sculptMesh?.userData.key === k) { this.updateSculptMesh({ x0: 0, y0: 0, x1: grid.w - 1, y1: grid.h - 1 }); return; }
    if (this.sculptMesh) { this.sculptMesh.removeFromParent(); this.sculptMesh.geometry.dispose(); }
    const m = new THREE.Mesh(gridMesh(nx, ny), new THREE.MeshStandardMaterial({ color: 0x7d8f5a, roughness: 1 }));
    m.userData = { key: k, st, nx, ny };
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
  // Edit commands (toolbars, keys, the context menu, the panels)

  undo() { const l = this.ed.undo(); this.toast(l ? `Undid ${l.toLowerCase()}` : 'Nothing to undo', 1500); }
  redo() { const l = this.ed.redo(); this.toast(l ? `Redid ${l.toLowerCase()}` : 'Nothing to redo', 1500); }
  /** Undo or redo to a point in the history panel. */
  jumpTo(n: number) { this.ed.jumpTo(n); }

  del(label?: string) {
    if (!this.sel.length) return;
    const arr = this.sel.filter((r) => typeof r[r.length - 1] === 'number'), ops: Op[] = this.ed.removeOps(arr);
    if (this.sel.some((r) => key(r) === key(['pilot']))) ops.push({ k: 'set', path: ['pilot'], v: undefined });
    // groups whose every member goes: their record and name go too
    const gone = (g: string) => { const m = groupMembers(this.ed.doc, g); return m.length > 0 && m.every((p) => arr.some((r) => key(r) === key(p))); };
    for (const g of Object.keys(this.ed.meta.groups ?? {})) if (gone(g)) ops.push({ k: 'set', path: ['x-builder', 'groups', g], v: undefined });
    for (const g of Object.keys(this.ed.meta.names ?? {})) if (gone(g)) ops.push({ k: 'set', path: ['x-builder', 'names', g], v: undefined });
    if (!ops.length) { this.toast('The main spawn can be moved but not deleted'); return; }
    this.sel = [];
    this.ed.apply(label ?? `Delete ${arr.length === 1 ? 'object' : `${arr.length} objects`}`, ops);
  }

  copy(): boolean {
    if (!this.def || !this.sel.length) return false;
    const c = copyClip(this.ed, this.sel, this.def.terrain);
    if (!c) { this.toast('The main spawn and the pilot can\'t be copied'); return false; }
    clipboard = c;
    this.toast(`Copied ${c.items.length} object${c.items.length === 1 ? '' : 's'}`, 1500);
    this.renderBox('status');
    return true;
  }
  cut() { if (this.copy()) this.del(`Cut ${clipboard!.items.length === 1 ? 'object' : `${clipboard!.items.length} objects`}`); }
  get canPaste() { return !!clipboard; }
  /** Paste at a point on the ground (ENU), or where the objects were copied from. */
  paste(at: Vec3 | null = null) {
    if (!clipboard || !this.def) { this.toast('Nothing to paste: copy something first (Ctrl+C)'); return; }
    const p = at ? [this.snapXY(at[0]), this.snapXY(at[1]), at[2]] as Vec3 : null;
    const { ops, added } = pasteOps(this.ed, clipboard, p, this.def.terrain);
    if (!ops.length) { this.toast('Nothing to paste here'); return; }
    this.ed.apply(`Paste ${added.length === 1 ? 'object' : `${added.length} objects`}`, ops);
    this.select(added);
  }

  /** Group the selected objects (Ctrl+G): they select and move together and get a name in the outliner. */
  group() {
    const refs = this.sel.filter((r) => r.length === 2 && (GROUPABLE as readonly string[]).includes(r[0] as string));
    if (refs.length < 2) { this.toast('Select two or more objects to group (course gates stay in their lap)'); return; }
    if (refs.some((r) => { const g = (this.ed.get(r) as Record<string, unknown>)['x-group']; return typeof g === 'string' && this.ed.meta.groups?.[g]; })) {
      this.toast('A prefab is in the selection: it keeps its own group (ungroup it first: Ctrl+Shift+G)'); return;
    }
    const g = this.ed.uid('g'), n = Object.keys(this.ed.meta.names ?? {}).length + 1;
    this.ed.apply('Group', [...refs.map((r): Op => ({ k: 'set', path: [...r, 'x-group'], v: g })), { k: 'set', path: ['x-builder', 'names', g], v: `Group ${n}` }]);
    this.select(refs);
    this.toast(`Grouped ${refs.length} objects · F2 renames the group`);
  }

  /** Ungroup every group in the selection (prefabs become plain parts). */
  ungroup() {
    const gs = new Set(this.sel.map((r) => (this.ed.get(r) as Record<string, unknown> | undefined)?.['x-group']).filter((g): g is string => typeof g === 'string'));
    if (!gs.size) { this.toast('Nothing in the selection is grouped'); return; }
    const ops: Op[] = [];
    for (const g of gs) {
      for (const p of groupMembers(this.ed.doc, g)) ops.push({ k: 'set', path: [...p, 'x-group'], v: undefined });
      if (this.ed.meta.groups?.[g]) ops.push({ k: 'set', path: ['x-builder', 'groups', g], v: undefined });
      if (this.ed.meta.names?.[g]) ops.push({ k: 'set', path: ['x-builder', 'names', g], v: undefined });
    }
    this.ed.apply(gs.size === 1 ? 'Ungroup' : `Ungroup ${gs.size} groups`, ops);
    this.renderBox('details', true);
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

  /**
   * Arrow keys: move the selection one grid step (×10 with Shift) along the map axis nearest to
   * "away from the camera" (up), its right (right), or up / down; repeats fold into one undo step.
   */
  nudge(fx: number, fy: number, up: number, mult = 1) {
    if (!this.def || !this.sel.length) return;
    const step = (this.snap.grid || 0.1) * mult;
    // the camera's heading, snapped to the nearest map axis (ENU)
    let ax = -Math.sin(this.cam.yaw), ay = Math.cos(this.cam.yaw);
    if (Math.abs(ax) > Math.abs(ay)) { ax = Math.sign(ax); ay = 0; } else { ay = Math.sign(ay); ax = 0; }
    const d: Vec3 = [r3((fy * ax + fx * ay) * step), r3((fy * ay - fx * ax) * step), r3(up * step)];
    this.ed.apply('Nudge', transformOps(this.ed, this.sel, { pivot: [0, 0, 0], d, yawDeg: 0, s: [1, 1, 1], frameYawDeg: 0 }, this.def.terrain), 'nudge');
  }

  /** Arrow keys with nothing selected: slide the view along the ground (forward is where the camera looks). */
  moveView(fx: number, fy: number, up: number, mult = 1) {
    const step = Math.max(1, this.cam.dist * 0.12) * mult, f = new THREE.Vector3(-Math.sin(this.cam.yaw), 0, -Math.cos(this.cam.yaw)), r = new THREE.Vector3(Math.cos(this.cam.yaw), 0, -Math.sin(this.cam.yaw));
    this.cam.move(f.multiplyScalar(fy * step).addScaledVector(r, fx * step).add(new THREE.Vector3(0, up * step, 0)));
  }

  /** [ and ]: turn the selection by the angle step about its centre (each object about itself when alone). */
  turnSelection(dir: 1 | -1) {
    if (!this.def || !this.sel.length) return;
    const a = (this.snap.angle || 15) * dir;
    this.ed.apply('Rotate', transformOps(this.ed, this.sel, { pivot: this.pivotOf(this.sel), d: [0, 0, 0], yawDeg: a, s: [1, 1, 1], frameYawDeg: 0 }, this.def.terrain), 'turn-key');
  }

  toGround() { if (this.def && this.sel.length) this.ed.apply('Drop to the ground', groundOps(this.ed, this.sel, this.def.terrain)); }

  frameSelection() {
    if (!this.def) return;
    if (!this.sel.length) { const s = this.ed.doc.spawn?.pos ?? [0, 0, 0]; this.cam.frame(T3(s[0], s[1], s[2]), 15); return; }
    // the objects' own extent (pick shapes, gizmos), or their anchors
    const box = this.overlay.boundsOf(new Set(this.sel.map(key)));
    for (const ref of this.sel) { const a = anchorOf(refKind(ref)!, this.ed.get(ref) as Record<string, unknown>, this.def.terrain, this.ed.doc); if (a) (box ?? new THREE.Box3()).expandByPoint(T3(a[0], a[1], a[2])); }
    if (box) { const s = box.getBoundingSphere(new THREE.Sphere()); this.cam.frame(s.center, Math.max(1.5, s.radius)); return; }
    const p = this.pivotOf(this.sel), c = T3(p[0], p[1], p[2]);
    let r = 2;
    for (const ref of this.sel) { const a = anchorOf(refKind(ref)!, this.ed.get(ref) as Record<string, unknown>, this.def.terrain, this.ed.doc); if (a) r = Math.max(r, T3(a[0], a[1], a[2]).distanceTo(c) + 2); }
    this.cam.frame(c, r);
  }

  /** Home: the whole playable area in view. */
  frameAll() {
    if (!this.def) return;
    const refs = allRefs(this.ed.doc).filter((r) => !this.hidden.has(key(r)));
    const f = this.def.terrain, box = new THREE.Box3();
    for (const r of refs) { const a = anchorOf(refKind(r)!, this.ed.get(r) as Record<string, unknown>, f, this.ed.doc); if (a) box.expandByPoint(T3(a[0], a[1], a[2])); }
    if (box.isEmpty()) { const h = this.ed.doc.size; box.setFromCenterAndSize(new THREE.Vector3(0, f(0, 0), 0), new THREE.Vector3(h, 1, h)); }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.cam.frame(sphere.center, Math.max(10, sphere.radius));
  }

  /** Set props on every selected object at once (the details panel's fields). */
  setProps(paths: Path[], v: unknown, label: string, merge?: string) { this.ed.apply(label, paths.map((p) => ({ k: 'set', path: p, v: structuredClone(v) })), merge); }

  terrainAt(x: number, y: number) { return this.def?.terrain(x, y) ?? 0; }

  /** The right-click menu: edit commands for the selection, and quick placement at the clicked point. */
  contextMenu(x: number, y: number, at: Vec3 | null) {
    const has = this.sel.length > 0, rc = this.ray(x, y);
    const grouped = this.sel.some((r) => typeof (this.ed.get(r) as Record<string, unknown> | undefined)?.['x-group'] === 'string');
    const items: MenuItem[] = [
      { label: 'Cut', keys: 'Ctrl+X', icon: 'scissors', run: () => this.cut(), disabled: !has },
      { label: 'Copy', keys: 'Ctrl+C', icon: 'copy', run: () => this.copy(), disabled: !has },
      { label: at ? 'Paste here' : 'Paste', keys: 'Ctrl+V', icon: 'paste', run: () => this.paste(at), disabled: !clipboard },
      { label: 'Duplicate', keys: 'Ctrl+D', icon: 'copy', run: () => this.duplicate(), disabled: !has },
      { label: 'Delete', keys: 'Del', icon: 'trash', run: () => this.del(), disabled: !has },
      { sep: true },
      { label: has ? 'Frame selection' : 'Frame the spawn', keys: 'F', icon: 'focus', run: () => this.frameSelection() },
      { label: 'Drop to the ground', keys: 'End', icon: 'toGround', run: () => this.toGround(), disabled: !has },
      { label: 'Select all of this kind', icon: 'pointer', run: () => this.selectSameKind(), disabled: !has },
      { sep: true },
      { label: 'Hide', keys: 'H', icon: 'eyeOff', run: () => this.hideSelection(), disabled: !has },
      { label: 'Isolate', keys: 'Shift+H', icon: 'focus', run: () => this.isolate(), disabled: !has },
      { label: 'Show everything', keys: 'Alt+H', icon: 'eye', run: () => this.showAll(), disabled: !this.hidden.size },
      { label: 'Lock', icon: 'lock', run: () => this.setLocked(this.sel, true), disabled: !has },
      { sep: true },
      { label: 'Group', keys: 'Ctrl+G', icon: 'group', run: () => this.group(), disabled: this.sel.length < 2 },
      { label: 'Ungroup', keys: 'Ctrl+Shift+G', icon: 'ungroup', run: () => this.ungroup(), disabled: !grouped },
      { label: 'Rename', keys: 'F2', run: () => this.renameSelection(), disabled: !has },
    ];
    if (at) items.push({ sep: true }, { head: 'Add here' },
      { label: 'Square gate', icon: 'focus', run: () => this.place(rc, { kind: 'gate', gate: 'square' }) },
      { label: 'Box', icon: 'box', run: () => this.place(rc, { kind: 'prim', type: 'box' }) },
      { label: 'Spawn pad', icon: 'flag', run: () => this.place(rc, { kind: 'spawnPad' }) },
      { label: 'Light', icon: 'lightbulb', run: () => this.place(rc, { kind: 'light' }) },
      { label: 'Tree', icon: 'treePine', run: () => this.place(rc, { kind: 'tree' }) });
    showMenu(this.root, x, y, items, 'Object menu');
  }

  // -------------------------------------------------------------------------------------------
  // The outliner's rename

  focusOutliner(k: string) { (this.boxes.outliner.querySelector(`li[data-key="${CSS.escape(k)}"]`) as HTMLElement | null)?.focus(); }

  /** F2 in the view: rename the selected object, or the group that is selected whole. */
  renameSelection() {
    if (!this.sel.length) return;
    const tree = outlineTree(this.ed.doc, this.ed.meta), want = new Set(this.sel.map(key));
    let found: OutlineNode | null = null;
    const walk = (ns: OutlineNode[]) => { for (const n of ns) { if (found) return; if (n.rename && (n.ref ? want.size === 1 && want.has(key(n.ref)) : n.refs.length === want.size && n.refs.every((r) => want.has(key(r))))) found = n; if (n.children) walk(n.children); } };
    walk(tree);
    if (!found) { this.toast('Only spawns, actors, groups, courses and paths have names'); return; }
    this.rename(found);
  }

  /** Rename an outliner row in place: Enter keeps, Esc cancels. */
  rename(n: OutlineNode) {
    if (!n.rename) return;
    if (!this.prefs.rightOpen) this.docks.toggle('right', true);
    for (const k of ancestorsOf(outlineTree(this.ed.doc, this.ed.meta), new Set(n.refs.map(key)))) this.s.open!.add(k);
    this.renderBox('outliner', true);
    const li = this.boxes.outliner.querySelector(`li[data-key="${CSS.escape(n.key)}"]`), lbl = li?.querySelector('.ed-o-label');
    if (!li || !lbl) return;
    const isId = n.rename[0] === 'paths';
    const input = el('input', { type: 'text', class: 'ed-rename', value: n.label, maxlength: isId ? 32 : 64, spellcheck: false, 'aria-label': `Name of ${n.label}` }) as HTMLInputElement;
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (keep && v !== n.label) this.commitRename(n, v);
      this.renderBox('outliner', true); this.focusOutliner(n.key);
    };
    input.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (ev) => ev.stopPropagation());
    lbl.replaceWith(input);
    input.focus(); input.select();
  }

  private commitRename(n: OutlineNode, v: string) {
    const path = n.rename!;
    if (path[0] === 'paths') {
      // a path's id: actors that move along it follow the new id
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(v)) { this.toast('A path id is 1-32 characters of a-z, 0-9, "_" and "-"'); return; }
      if (this.ed.doc.paths?.some((p, i) => p.id === v && i !== path[1])) { this.toast(`There already is a path "${v}"`); return; }
      const old = this.ed.doc.paths![path[1] as number].id;
      const ops: Op[] = [{ k: 'set', path, v }];
      (this.ed.doc.actors ?? []).forEach((a, i) => { if (a.path === old) ops.push({ k: 'set', path: ['actors', i, 'path'], v }); });
      this.ed.apply('Rename path', ops);
      return;
    }
    if (path[0] === 'courses' && !v) { this.toast('A course needs a name'); return; }
    this.ed.apply('Rename', [{ k: 'set', path, v: v || undefined }]);
  }

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
    const r = this.host.ctx.renderer, show = [this.overlay.group.visible, this.grid.mesh.visible, this.tc.getHelper().visible];
    // the picture without the editor's gizmos, of the visible viewport
    this.overlay.group.visible = false; this.grid.mesh.visible = false; this.tc.getHelper().visible = false;
    r.render(b.scene, this.cam.cam); // the drawing buffer is only readable right after a render
    [this.overlay.group.visible, this.grid.mesh.visible, this.tc.getHelper().visible] = show;
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const v = this.docks.view.getBoundingClientRect(), src = this.canvas, k = src.width / src.clientWidth;
    const vw = v.width * k, vh = v.height * k, a = 16 / 9, sw = Math.min(vw, vh * a), sh = sw / a;
    const g = c.getContext('2d')!;
    g.drawImage(src, v.left * k + (vw - sw) / 2, v.top * k + (vh - sh) / 2, sw, sh, 0, 0, 640, 360);
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

  /** Validate the whole package as the repository's validator does: the result shows in Problems. */
  async validate(): Promise<CheckResult> {
    const files = await packageFiles(this.ed, { docs: true });
    this.check = await checkPackage(files);
    this.openBottom('problems');
    this.toast(this.check.errors.length ? `${this.check.errors.length} problem${this.check.errors.length === 1 ? '' : 's'} to fix before export` : `The package is valid${this.check.warnings.length ? ` (${this.check.warnings.length} warning${this.check.warnings.length === 1 ? '' : 's'})` : ''}`);
    return this.check;
  }

  /** Register the draft as local-<id> and fly it with the real physics and Betaflight. */
  async fly() {
    await this.saver.flush();
    let reg;
    try { reg = await loadLocalMap(await packageFiles(this.ed)); }
    catch (e) {
      if (e instanceof MapFormatError) { this.check = { errors: e.errors, warnings: e.warnings }; this.openBottom('problems'); this.toast(`Can't fly yet: ${e.errors.length} problem${e.errors.length === 1 ? '' : 's'}`); return; }
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
    catch (e) { if (e instanceof MapFormatError) { this.check = { errors: e.errors, warnings: e.warnings }; this.openBottom('problems'); this.toast('Fix the map\'s problems first'); return; } throw e; }
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
    this.check = r;
    if (r.errors.length) { this.openBottom('problems'); this.toast(`Export stopped: ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}`, 5000); return; }
    this.renderBox('bottom', true);
    const id = exportDoc(this.ed).meta.id;
    download((await zipPackage(files)) as BlobPart, `${id}.zip`, 'application/zip');
    this.toast(`Exported ${id}.zip: a package for public/maps/community/${id}/ (see docs/MAP_FORMAT.md). LICENSE.txt may need the full licence text.`, 7000);
  }

  get canPublish() { return !!this.host.onPublish; }
  async publish() {
    if (!this.host.onPublish) return;
    const files = await packageFiles(this.ed, { docs: true }), r = await checkPackage(files);
    this.check = r;
    if (r.errors.length) { this.openBottom('problems'); this.toast(`Fix ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'} before publishing`, 5000); return; }
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
    closeMenu();
    this.saver.stop();
    for (const f of this.off) f();
    this.tc.detach(); this.tc.dispose();
    this.overlay.dispose();
    this.grid.dispose();
    this.extras.removeFromParent();
    if (this.sculptMesh) this.sculptMesh.geometry.dispose();
    this.bundle?.dispose(); this.bundle = null;
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.docks.dispose();
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
