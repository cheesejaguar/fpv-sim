// The map builder's document: an fpvsim-map v1 map.json, the package's asset files and, for a
// heightfield ground, its 16-bit height grid. Every change is a command (a list of small ops that
// remember what they replaced), so undo / redo cost the size of the edit, not of the map. No DOM,
// no three.js: the tests run it in node.
import type { MapDocV1 } from '../maps/mapDoc';

export type Key = string | number;
export type Path = Key[];
/** Heightfield grid: w x h values, rows north to south; height = zMin + (zMax - zMin) * v / 65535. */
export interface Grid { w: number; h: number; data: Uint16Array }

export type Op =
  /** set (v undefined: delete) the value at path; parents are created as objects */
  | { k: 'set'; path: Path; v: unknown; old?: unknown }
  /** insert v into the array at path, at index i (default: the end) */
  | { k: 'ins'; path: Path; i?: number; v: unknown }
  /** remove the array element at path[i] */
  | { k: 'del'; path: Path; i: number; old?: unknown }
  /** add, replace (v) or remove (v null) a package file */
  | { k: 'asset'; path: string; v: Blob | null; old?: Blob | null }
  /** replace the whole height grid (convert, import, resample) */
  | { k: 'grid'; v: Grid | null; old?: Grid | null }
  /** a sculpt stroke: the grid values of one rectangle before and after */
  | { k: 'rect'; x0: number; y0: number; w: number; h: number; before: Uint16Array; after: Uint16Array };

export interface Command { label: string; ops: Op[]; merge?: string; at: number }
export interface Change { doc: boolean; assets: boolean; grid: boolean; label: string }

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
const MAX_UNDO = 200;

/** Builder metadata kept in the document (map.json "x-builder"): prefab groups, asset credits, grid. */
export interface BuilderMeta {
  groups?: Record<string, { prefab: string; params: Record<string, number>; pos: [number, number, number]; yawDeg: number }>;
  credits?: { file: string; author: string; source: string; license: string }[];
  grid?: { step: number; angle: number };
  nextUid?: number;
}

export class EditorDoc {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<(c: Change) => void>();
  /** increases with every change (autosave, rebuild checks) */
  rev = 0;

  constructor(public doc: MapDocV1, public assets = new Map<string, Blob>(), public grid: Grid | null = null) {}

  onChange(f: (c: Change) => void) { this.listeners.add(f); return () => this.listeners.delete(f); }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label ?? ''; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label ?? ''; }

  /** The value at a path ([] = the document). */
  get(path: Path): unknown {
    let o: unknown = this.doc;
    for (const k of path) { if (o == null || typeof o !== 'object') return undefined; o = (o as Record<Key, unknown>)[k]; }
    return o;
  }

  /** Builder metadata (created on first write). */
  get meta(): BuilderMeta { return ((this.doc as unknown as Record<string, unknown>)['x-builder'] ?? {}) as BuilderMeta; }

  /** A fresh id unique within this document (prefab groups, generated names). */
  uid(prefix = 'g'): string {
    const m = this.meta, n = m.nextUid ?? 1;
    // not a command: an id handed out and then undone is simply never reused
    (this.doc as unknown as Record<string, unknown>)['x-builder'] = { ...m, nextUid: n + 1 };
    return `${prefix}${n}`;
  }

  /**
   * Run ops as one undoable command. merge: a key; a command with the same key right after this one
   * (a slider drag, typing in a field) folds into it, so one gesture is one undo step.
   */
  apply(label: string, ops: Op[], merge?: string): void {
    if (!ops.length) return;
    for (const op of ops) this.exec(op, false);
    const last = this.undoStack[this.undoStack.length - 1];
    const now = Date.now();
    if (merge && last?.merge === merge && !this.redoStack.length && now - last.at < 2500 && ops.every((o) => o.k === 'set')) {
      // keep the first old value of each path; later values replace
      for (const op of ops as Extract<Op, { k: 'set' }>[]) {
        const prev = last.ops.find((o) => o.k === 'set' && samePath(o.path, op.path)) as Extract<Op, { k: 'set' }> | undefined;
        if (prev) prev.v = op.v; else last.ops.push(op);
      }
      last.at = now;
    } else this.push({ label, ops, merge, at: now });
    this.redoStack = [];
    this.emit(ops, label);
  }

  /** Record ops that were already carried out (a sculpt stroke drawn live): their old values must be filled in. */
  record(label: string, ops: Op[]) {
    if (!ops.length) return;
    this.push({ label, ops, at: Date.now() });
    this.redoStack = [];
    this.emit(ops, label);
  }

  undo(): string | null {
    const c = this.undoStack.pop();
    if (!c) return null;
    for (let i = c.ops.length - 1; i >= 0; i--) this.exec(c.ops[i], true);
    this.redoStack.push(c);
    this.emit(c.ops, `Undo ${c.label}`);
    return c.label;
  }

  redo(): string | null {
    const c = this.redoStack.pop();
    if (!c) return null;
    for (const op of c.ops) this.exec(op, false);
    this.undoStack.push(c);
    this.emit(c.ops, `Redo ${c.label}`);
    return c.label;
  }

  // ---- convenience commands ----
  set(path: Path, v: unknown, label = 'Edit', merge?: string) { this.apply(label, [{ k: 'set', path, v: clone(v) }], merge); }
  /** Append (or insert at i) into the array at path, creating it. Returns the new element's index. */
  insert(path: Path, v: unknown, label = 'Add', i?: number): number {
    const arr = this.get(path);
    const at = i ?? (Array.isArray(arr) ? arr.length : 0);
    this.apply(label, [{ k: 'ins', path, i: at, v: clone(v) }]);
    return at;
  }
  /** Remove array elements (paths ending in an index); indices are taken highest first so they stay valid. */
  removeOps(paths: Path[]): Op[] {
    return [...paths].sort((a, b) => cmpPath(b, a)).map((p) => ({ k: 'del', path: p.slice(0, -1), i: p[p.length - 1] as number }));
  }

  private push(c: Command) {
    this.undoStack.push(c);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  private emit(ops: Op[], label: string) {
    this.rev++;
    const c: Change = { doc: ops.some((o) => o.k === 'set' || o.k === 'ins' || o.k === 'del'), assets: ops.some((o) => o.k === 'asset'), grid: ops.some((o) => o.k === 'grid' || o.k === 'rect'), label };
    for (const f of this.listeners) f(c);
  }

  private parent(path: Path, create: boolean): Record<Key, unknown> | null {
    let o = this.doc as unknown as Record<Key, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (o[k] == null || typeof o[k] !== 'object') { if (!create) return null; o[k] = typeof path[i + 1] === 'number' ? [] : {}; }
      o = o[k] as Record<Key, unknown>;
    }
    return o;
  }

  private exec(op: Op, undo: boolean) {
    switch (op.k) {
      case 'set': {
        const p = this.parent(op.path, true)!, k = op.path[op.path.length - 1];
        if (!undo) op.old = clone(p[k]);
        const v = undo ? op.old : op.v;
        if (v === undefined) { if (Array.isArray(p) && typeof k === 'number') p[k] = undefined; else delete p[k]; } else p[k] = clone(v);
        break;
      }
      case 'ins': {
        const p = this.parent(op.path, true)!, k = op.path[op.path.length - 1];
        const arr = (p[k] ??= []) as unknown[];
        const i = op.i ?? arr.length;
        if (undo) arr.splice(i, 1); else { op.i = i; arr.splice(i, 0, clone(op.v)); }
        if (undo && !arr.length && op.path.length === 1) delete p[k]; // a top-level list the insert created goes again
        break;
      }
      case 'del': {
        const p = this.parent(op.path, true)!, k = op.path[op.path.length - 1];
        const arr = (p[k] ??= []) as unknown[];
        if (undo) arr.splice(op.i, 0, clone(op.old)); else { op.old = clone(arr[op.i]); arr.splice(op.i, 1); if (!arr.length && op.path.length === 1) delete p[k]; }
        break;
      }
      case 'asset': {
        if (!undo) op.old = this.assets.get(op.path) ?? null;
        const v = undo ? op.old : op.v;
        if (v) this.assets.set(op.path, v); else this.assets.delete(op.path);
        break;
      }
      case 'grid': {
        if (!undo) op.old = this.grid;
        this.grid = (undo ? op.old : op.v) ?? null;
        break;
      }
      case 'rect': {
        const g = this.grid;
        if (!g) break;
        const src = undo ? op.before : op.after;
        for (let y = 0; y < op.h; y++) g.data.set(src.subarray(y * op.w, (y + 1) * op.w), (op.y0 + y) * g.w + op.x0);
        break;
      }
    }
  }
}

export const samePath = (a: Path, b: Path) => a.length === b.length && a.every((k, i) => k === b[i]);
/** Order paths so array elements come in index order (for removal: highest index first). */
export function cmpPath(a: Path, b: Path): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    return typeof a[i] === 'number' && typeof b[i] === 'number' ? (a[i] as number) - (b[i] as number) : String(a[i]) < String(b[i]) ? -1 : 1;
  }
  return a.length - b.length;
}

/** The height grid as buildMapDef / makeTerrain want it: v / 65535 as Float32, exactly what decodePngChannel returns for the 16-bit PNG. */
export function gridHf(g: Grid): { w: number; h: number; data: Float32Array } {
  const data = new Float32Array(g.w * g.h);
  for (let i = 0; i < data.length; i++) data[i] = g.data[i] / 65535;
  return { w: g.w, h: g.h, data };
}

/** Height grid from a decoded PNG channel (0..1): 16-bit values exactly, 8-bit ones as v * 257 (the same heights). */
export function gridFromHf(hf: { w: number; h: number; data: Float32Array }): Grid {
  const data = new Uint16Array(hf.w * hf.h);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, hf.data[i])) * 65535);
  return { w: hf.w, h: hf.h, data };
}

// ---------------------------------------------------------------------------------------------
// What a selection path points at

export type RefKind = 'prim' | 'gate' | 'tree' | 'spawn' | 'mainSpawn' | 'pilot' | 'light' | 'indoor' | 'wake' | 'actor' | 'pathPoint' | 'mesh';

/** The kind of object a path selects, or null (["primitives", 3], ["courses", 1, "gates", 2], ["paths", 0, "points", 4] …). */
export function refKind(p: Path): RefKind | null {
  const [a] = p;
  if (a === 'spawn' && p.length === 1) return 'mainSpawn';
  if (a === 'pilot' && p.length === 1) return 'pilot';
  if (p.length === 2) return ({ primitives: 'prim', gates: 'gate', trees: 'tree', spawns: 'spawn', lights: 'light', indoor: 'indoor', wakeZones: 'wake', actors: 'actor', geometry: 'mesh' } as Record<string, RefKind>)[a as string] ?? null;
  if (p.length === 4 && a === 'courses' && p[2] === 'gates') return 'gate';
  if (p.length === 4 && a === 'paths' && p[2] === 'points') return 'pathPoint';
  return null;
}

export const KIND_NAMES: Record<RefKind, string> = { prim: 'Primitive', gate: 'Gate', tree: 'Tree', spawn: 'Spawn', mainSpawn: 'Main spawn', pilot: 'Pilot position', light: 'Light', indoor: 'Indoor zone', wake: 'Wake zone', actor: 'Actor', pathPoint: 'Path point', mesh: 'glTF mesh' };
