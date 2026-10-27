// The map builder's own preferences, kept in this browser (not in the map): panel sizes and which
// panels are open, what the viewport shows, the camera's right-drag and speed, snapping. Storage can
// be missing or full (private windows): then the defaults simply apply each time.

export interface ShowFlags {
  /** the reference grid on the ground */
  grid: boolean;
  /** names over spawns, paths, actors and gate numbers */
  labels: boolean;
  /** spawns, lights, zones, actors, paths: everything with no look of its own in flight */
  gizmos: boolean;
  /** the racing line of the course shown */
  racingLine: boolean;
  /** the collision / pick shapes of primitives, gates, trees and meshes as wireframes */
  collision: boolean;
}

export interface EditorPrefs {
  /** dock sizes (px) */
  left: number; right: number; bottom: number;
  /** share of the right dock the outliner takes (the details panel has the rest) */
  outlinerShare: number;
  /** collapsed docks */
  leftOpen: boolean; rightOpen: boolean; bottomOpen: boolean;
  /** the bottom dock's tab */
  bottomTab: 'problems' | 'history';
  show: ShowFlags;
  /** right-drag in the viewport: look around and fly with WASD (Unity / Unreal), or orbit round the view centre */
  rightDrag: 'fly' | 'orbit';
  /** fly speed multiplier (the wheel changes it while the right button is held) */
  speed: number;
  /** transform gizmo space */
  space: 'world' | 'local';
  /** snapping (grid in m, angle in degrees; 0 = off) and whether it is on */
  snapOn: boolean; grid: number; angle: number;
  /** collapsed sections of the details panel, by title */
  closed: string[];
}

export const DEFAULT_PREFS: EditorPrefs = {
  left: 268, right: 316, bottom: 168, outlinerShare: 0.4,
  leftOpen: true, rightOpen: true, bottomOpen: false, bottomTab: 'problems',
  show: { grid: true, labels: true, gizmos: true, racingLine: true, collision: false },
  rightDrag: 'fly', speed: 1, space: 'world', snapOn: true, grid: 0.5, angle: 15, closed: [],
};

/** Dock size limits (px). */
export const DOCK = { left: [180, 520], right: [240, 560], bottom: [90, 480] } as const;

const KEY = 'fpvsim.editor.prefs.v1';

/** The stored preferences over the defaults; anything unreadable or out of range falls back. */
export function loadPrefs(store: Pick<Storage, 'getItem'> | null = safeStorage()): EditorPrefs {
  let raw: unknown = null;
  try { raw = JSON.parse(store?.getItem(KEY) ?? 'null'); } catch { raw = null; }
  return sanitize(raw);
}

export function savePrefs(p: EditorPrefs, store: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try { store?.setItem(KEY, JSON.stringify(p)); } catch { /* full or blocked: not kept */ }
}

export function sanitize(raw: unknown): EditorPrefs {
  const d = DEFAULT_PREFS, o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (k: string, lo: number, hi: number, def: number) => { const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  const one = <T extends string>(v: unknown, opts: readonly T[], def: T): T => (opts.includes(v as T) ? (v as T) : def);
  const s = (o.show && typeof o.show === 'object' ? o.show : {}) as Record<string, unknown>;
  return {
    left: num('left', DOCK.left[0], DOCK.left[1], d.left), right: num('right', DOCK.right[0], DOCK.right[1], d.right), bottom: num('bottom', DOCK.bottom[0], DOCK.bottom[1], d.bottom),
    outlinerShare: num('outlinerShare', 0.15, 0.85, d.outlinerShare),
    leftOpen: bool(o.leftOpen, d.leftOpen), rightOpen: bool(o.rightOpen, d.rightOpen), bottomOpen: bool(o.bottomOpen, d.bottomOpen),
    bottomTab: one(o.bottomTab, ['problems', 'history'] as const, d.bottomTab),
    show: { grid: bool(s.grid, d.show.grid), labels: bool(s.labels, d.show.labels), gizmos: bool(s.gizmos, d.show.gizmos), racingLine: bool(s.racingLine, d.show.racingLine), collision: bool(s.collision, d.show.collision) },
    rightDrag: one(o.rightDrag, ['fly', 'orbit'] as const, d.rightDrag),
    speed: num('speed', SPEEDS[0], SPEEDS[SPEEDS.length - 1], d.speed),
    space: one(o.space, ['world', 'local'] as const, d.space),
    snapOn: bool(o.snapOn, d.snapOn), grid: num('grid', 0, 100, d.grid), angle: num('angle', 0, 90, d.angle),
    closed: Array.isArray(o.closed) ? o.closed.filter((x): x is string => typeof x === 'string').slice(0, 64) : [],
  };
}

/** Fly speed steps (the wheel moves between them while flying). */
export const SPEEDS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16] as const;

/** The next speed step up (dir 1) or down (-1). */
export function stepSpeed(v: number, dir: 1 | -1): number {
  let i = SPEEDS.findIndex((s) => s >= v - 1e-9);
  if (i < 0) i = SPEEDS.length - 1;
  if (SPEEDS[i] > v + 1e-9 && dir > 0) return SPEEDS[i];
  return SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + dir))];
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
