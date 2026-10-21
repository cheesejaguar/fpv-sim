// Saved settings. Every fpv-* value that main.ts and the menu keep in localStorage goes through
// here: stored as { v, data } (versioned) and validated field by field on load, so a stale,
// hand-edited or corrupt value can never stop the app from booting. Values saved before
// versioning (the bare object) are accepted and re-saved in the current format.
import { DEFAULT_SPEC, DroneSpec, PRESETS } from '../builder/derive';
import { BATTERIES, ESCS, FCS, FRAMES, MOTORS, PROPS, VIDEO } from '../data/catalog';
import { hasMap } from '../maps/maps';
import { DEFAULT_VIEW, ViewSettings } from '../ui/settingsPanel';
import { DEFAULT_SETTINGS, SimSettings } from '../worker/shared';

export const KEYS = {
  spec: 'fpv-spec',
  sim: 'fpv-sim-settings',
  view: 'fpv-view',
  /** the pilot's own (non-preset) build, kept while a preset is flown */
  specMine: 'fpv-spec-mine',
  newGame: 'fpv-newgame',
  /** personal best lap per track + drone class */
  pbs: 'fpv-pbs',
  /** the last initials entered for the leaderboard */
  initials: 'fpv-initials',
  /** random token that keeps one leaderboard entry per board for this browser */
  lbClient: 'fpv-lb-client',
  /** ids of this browser's leaderboard entries (its rows are marked) */
  lbMine: 'fpv-lb-mine',
} as const;

/** Format of the { v, data } envelope. Bump it (and migrate in readStored) when a stored shape changes. */
export const STORE_VERSION = 1;

/** The bit of the Storage API used here; tests pass a Map-backed stand-in. */
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
/** localStorage, or null where it is missing or throws (sandboxed iframes, disabled storage). */
function local(): KV | null { try { return globalThis.localStorage ?? null; } catch { return null; } }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A stored value: the envelope's data (v = its version), or a pre-versioning bare value (v = 0). */
export function readStored(key: string, kv: KV | null = local()): { v: number; data: unknown } | undefined {
  let text: string | null = null;
  try { text = kv?.getItem(key) ?? null; } catch { return undefined; }
  if (text == null) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  if (isObj(raw) && typeof raw.v === 'number' && own(raw, 'data')) return { v: raw.v, data: raw.data };
  return { v: 0, data: raw };
}

export function save(key: string, data: unknown, kv: KV | null = local()): void {
  try { kv?.setItem(key, JSON.stringify({ v: STORE_VERSION, data })); } catch { /* full or blocked: settings just don't persist */ }
}

/** Read and validate; a value from an older format is re-saved validated, in the current one. */
export function load<T>(key: string, validate: (raw: unknown) => T, kv: KV | null = local()): T {
  const r = readStored(key, kv);
  const value = validate(r?.data);
  if (r && r.v < STORE_VERSION) save(key, value, kv);
  return value;
}

// ---------------------------------------------------------------------------------------------
// Field rules

type Rule = (raw: unknown, def: any) => unknown;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
/** Finite number, clamped into [min, max] (rounded for integer settings). */
const num = (min: number, max: number, int = false): Rule => (x, d) => (finite(x) ? clamp(int ? Math.round(x) : x, min, max) : d);
const bool: Rule = (x, d) => (typeof x === 'boolean' ? x : d);
const oneOf = (...vals: readonly unknown[]): Rule => (x, d) => (vals.includes(x) ? x : d);
const text = (max: number): Rule => (x, d) => (typeof x === 'string' && x.length <= max ? x : d);
const degrees: Rule = (x, d) => (finite(x) ? ((x % 360) + 360) % 360 : d);

/**
 * `raw` merged over `defaults`, field by field: fields with a rule are validated by it; any other
 * field of `defaults` (one added after this file was written) keeps a raw value of the same type;
 * fields `defaults` doesn't have are dropped. Never shares objects with `defaults`.
 */
function merge<T extends object>(defaults: T, raw: unknown, rules: { [K in keyof T]?: Rule }): T {
  const src = isObj(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(defaults)) {
    const d = (defaults as Record<string, unknown>)[k], x = own(src, k) ? src[k] : undefined;
    const rule = (rules as Record<string, Rule | undefined>)[k];
    if (rule) out[k] = rule(x, d);
    else if (isObj(d)) out[k] = merge(d, x, {});
    else if (typeof x === typeof d && !Array.isArray(d) && (typeof x !== 'number' || finite(x))) out[k] = x;
    else out[k] = structuredClone(d);
  }
  return out as T;
}

// ---------------------------------------------------------------------------------------------
// Drone build (fpv-spec, fpv-spec-mine)

const COMPONENTS: Record<'frame' | 'motor' | 'prop' | 'battery' | 'esc' | 'fc' | 'video', readonly { id: string }[]> = {
  frame: FRAMES, motor: MOTORS, prop: PROPS, battery: BATTERIES, esc: ESCS, fc: FCS, video: VIDEO,
};
const known = (list: readonly { id: string }[]): Rule => (x, d) => (typeof x === 'string' && list.some((c) => c.id === x) ? x : d);

/** Builder overrides: physically sane bounds (wider than the sliders, which may change). */
const OVERRIDES: Record<string, Rule> = {
  massScale: num(0.1, 10), inertiaScale: num(0.1, 10),
  kv: num(100, 100000), rmMohm: num(1, 5000), i0A: num(0, 50),
  propPitchIn: num(0.5, 15), propThrustScale: num(0.1, 5), propTorqueScale: num(0.1, 5),
  cdAScale: num(0.1, 10), irPerCellMohm: num(0.1, 500), capacityMah: num(50, 50000), cells: num(1, 16, true),
  escCurrentLimitA: num(1, 500), auxPowerW: num(0, 200),
  frameFreqHz: num(10, 5000), vibrationScale: num(0, 50), propImbalance: num(0, 1e-3),
};
const overrides: Rule = (x) => {
  const out: Record<string, number> = {};
  if (!isObj(x)) return out;
  for (const [k, v] of Object.entries(x)) {
    if (own(OVERRIDES, k)) { const r = OVERRIDES[k](v, undefined); if (r !== undefined) out[k] = r as number; }
    else if (/^[a-z][A-Za-z0-9]{0,40}$/.test(k) && finite(v)) out[k] = v; // an override added since (never __proto__)
  }
  return out;
};

/**
 * A saved drone build, or null when it can't be flown: not an object, or a component id this
 * version doesn't have (removed or renamed parts). Other fields are validated one by one.
 */
export function parseSpec(raw: unknown): DroneSpec | null {
  if (!isObj(raw)) return null;
  for (const [k, list] of Object.entries(COMPONENTS)) if (known(list)(raw[k], null) === null) return null;
  return merge(DEFAULT_SPEC, raw, {
    name: text(120),
    batteryMount: oneOf('top', 'bottom'),
    cameraUptiltDeg: num(-30, 90),
    propDirection: oneOf('props-out', 'props-in'),
    extraMassG: num(0, 2000),
    extraMassZmm: num(-200, 200),
    batterySoc: num(0.05, 1),
    batteryAge: num(1, 5),
    motorTiltDeg: num(-30, 30),
    overrides,
  });
}

/** The saved build, or `fallback` (the 65 mm whoop on first run) when it can't be used. */
export function validSpec(raw: unknown, fallback: DroneSpec): DroneSpec {
  return parseSpec(raw) ?? structuredClone(fallback);
}

// ---------------------------------------------------------------------------------------------
// Simulation settings (fpv-sim-settings)

export function validSim(raw: unknown): SimSettings {
  return merge(DEFAULT_SETTINGS, raw, {
    mapId: (x, d) => (hasMap(x) ? x : d), // maps loaded from disk are gone after a reload
    courseId: text(24),                   // an id the map doesn't have flies its default course
    physicsHz: oneOf(2000, 4000, 8000),  // the worker steps whole multiples of 1 kHz
    timeScale: num(0.05, 1),
    damage: bool,
    wind: (x, d) => merge(d, x, { speed: num(0, 40), direction: degrees, turbulence: num(0, 5), gusts: num(0, 60) }),
    propwash: num(0, 5),
    rcLinkHz: num(25, 1000),
    rcTxPowerMw: num(1, 2000),
    ambientC: num(-40, 60),
    paused: () => false,
  });
}

// ---------------------------------------------------------------------------------------------
// View settings (fpv-view)

/** OSD fonts shipped in public/fonts (scripts/fetch-fonts.mjs). */
export const OSD_FONTS = ['betaflight', 'default', 'bold', 'clarity', 'digital', 'impact', 'large', 'vision'] as const;

export function validView(raw: unknown): ViewSettings {
  return merge(DEFAULT_VIEW, raw, {
    osdFont: oneOf(...OSD_FONTS), // also keeps the font URL to /fonts/<known name>.mcm
    renderScale: num(0.25, 2),
    cubeSize: num(256, 2048, true),
    displayCompMs: num(0, 100),
    displayCompAuto: bool,
    latencyOverrideMs: num(0, 500),
    audio: bool,
    volume: num(0, 1),
    telemetry: bool,
    osd: bool,
    view: oneOf('fpv', 'chase', 'los'),
    linkEffects: bool,
    highlightGate: bool,
    timeOfDay: oneOf('map', 'morning', 'noon', 'golden', 'dusk', 'night'),
    goggleOverlay: bool,
  });
}

// ---------------------------------------------------------------------------------------------
// New game choices (fpv-newgame)

export interface NewGamePrefs<M extends string = string> { mode: M; preset: number }

/** mode: one of the menu's modes (else the first); preset: -2 own build, -1 current build, or a preset index. */
export function validNewGame<M extends string>(raw: unknown, modes: readonly M[], presets = PRESETS.length): NewGamePrefs<M> {
  const r = isObj(raw) ? raw : {};
  const mode = modes.includes(r.mode as M) ? (r.mode as M) : modes[0];
  const preset = Number.isInteger(r.preset) && (r.preset as number) >= -2 && (r.preset as number) < presets ? (r.preset as number) : -1;
  return { mode, preset };
}

// ---------------------------------------------------------------------------------------------
// Personal bests + leaderboard (fpv-pbs, fpv-initials, fpv-lb-client, fpv-lb-mine)

/** A personal best lap. submitted: the leaderboard entry it was posted as (its rank is looked up by id). */
export interface PbRecord { lapMs: number; splitsMs: number[]; at: number; summary: string; submitted?: { id: number; at: number } }
/** Keyed by `${track}|${class}` (track: the map id, or `map:course`). */
export type PbTable = Record<string, PbRecord>;

export const PB_KEY_RE = /^[a-z0-9_-]{1,48}(?::[a-z0-9_-]{1,24})?\|[a-z0-9_-]{1,24}$/;
const MAX_PBS = 300;
const lapMs = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0 && (x as number) <= 3_600_000;

function validPb(x: unknown): PbRecord | null {
  if (!isObj(x) || !lapMs(x.lapMs) || !finite(x.at)) return null;
  const splits = Array.isArray(x.splitsMs) && x.splitsMs.length <= 64 && x.splitsMs.every(lapMs) ? (x.splitsMs as number[]).slice() : [];
  const sub = x.submitted;
  const submitted = isObj(sub) && Number.isInteger(sub.id) && (sub.id as number) > 0 && finite(sub.at) ? { id: sub.id as number, at: sub.at } : undefined;
  return { lapMs: x.lapMs, splitsMs: splits, at: x.at, summary: typeof x.summary === 'string' ? x.summary.slice(0, 60) : '', ...(submitted ? { submitted } : {}) };
}

/** Entries with a malformed key or record are dropped (no prototype: keys come from map ids). */
export function validPbs(raw: unknown): PbTable {
  const out: PbTable = Object.create(null);
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, MAX_PBS)) {
    const pb = PB_KEY_RE.test(k) ? validPb(v) : null;
    if (pb) out[k] = pb;
  }
  return out;
}

/** Three letters A-Z, or '' (none entered yet). */
export const validInitials = (raw: unknown): string => (typeof raw === 'string' && /^[A-Z]{3}$/.test(raw) ? raw : '');

/** 32 hex digits, or '' (none yet). */
export const validClientId = (raw: unknown): string => (typeof raw === 'string' && /^[0-9a-f]{32}$/.test(raw) ? raw : '');

/** Leaderboard entry ids (positive integers), the newest 200. */
export const validEntryIds = (raw: unknown): number[] =>
  (Array.isArray(raw) ? raw.filter((x): x is number => Number.isInteger(x) && x > 0 && x < 1e12) : []).slice(-200);
