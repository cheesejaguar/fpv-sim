// fpvsim-map v1 documents: types, structural validation, budgets, licence rules and the PNG reader.
// Dependency-free (no map builders, no physics), so the map editor and the publishing server can use
// it without pulling in every built-in map. mapFormat.ts re-exports everything here and adds the
// package loader (assets, glTF, Quake / Doom sources, MapDef building).
import { MapFormatError } from './mapError';
import { inflate } from './zip';
import type { BoxPrim, GateDef, MapDef, Material } from './world';

export { MapFormatError };
export const FORMAT = 'fpvsim-map';
export const FORMAT_VERSION = 1;

/** Size / complexity budgets: keep the web build fast. Enforced by the loader and the validator CLI. */
export const BUDGETS = {
  mapJsonBytes: 1 << 20,          // map.json
  packageBytes: 16 << 20,         // all files of a package
  fileBytes: 8 << 20,             // any single file
  halfExtentM: 2000,              // size
  primitives: 5000,               // primitives + generated gate parts
  gates: 64,
  trees: 3000,
  wakeZones: 32,
  indoor: 32,                     // indoor wind volumes
  lights: 8,                      // point lights (fixtures, floodlights) = MAX_MAP_LIGHTS (world.ts)
  geometry: 16,                   // geometry entries
  brushes: 20000,                 // convex brushes from Quake / Doom sources + mesh collision slabs
  meshTriangles: 150000,          // drawn glTF triangles, all meshes
  collisionTriangles: 20000,      // glTF triangles with collision 'mesh', all meshes
  texturePx: 1024,                // max texture width / height
  textureBytes: 1 << 20,
  heightfieldPx: 1025,            // max heightfield width / height
  previewBytes: 512 << 10,
  spawns: 32,                     // named spawn variants
  courses: 16,                    // alternative gate courses
  paths: 32,                      // actor paths
  pathPoints: 256,                // points per path
  actors: 64,                     // RF components, detectors, targets
  scenarios: 16,                  // bundled scenario files
};

/** Actor types: RF components (emitters / jammers, ground stations), detection components, targets. */
export const ACTOR_TYPES = ['rf-emitter', 'ground-station', 'detector', 'target'] as const;
export const SENSOR_TYPES = ['camera', 'radar', 'rf'] as const;
export const TARGET_SHAPES = ['box', 'sphere', 'cylinder', 'quad', 'vehicle', 'person'] as const;
export const PATH_MODES = ['loop', 'pingpong', 'once'] as const;

export const MATERIAL_NAMES = ['grass', 'dirt', 'concrete', 'metal', 'wood', 'foliage', 'gate'] as const;
export const VISUALS = ['concrete', 'brick', 'metal', 'wood', 'gate', 'pad', 'glass', 'plain', 'led', 'banner', 'screen', 'net'] as const;
export const GATE_KINDS = ['square', 'arch', 'dive', 'flag', 'hurdle', 'ladder'] as const;
/** Default clear opening (width, height) of each gate kind (m). */
export const GATE_SIZE: Record<GateDef['kind'], [number, number]> = { square: [1.524, 1.524], arch: [3.0, 2.6], dive: [1.524, 1.524], flag: [1.524, 3.2], hurdle: [3.6, 1.8], ladder: [1.524, 1.524] };

/** SPDX licence ids accepted for maps in the repository (distributable with a GPL-3.0-or-later program). */
export const ALLOWED_LICENSES = [
  'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'Unlicense', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Zlib',
  'Apache-2.0', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'LGPL-2.1-or-later', 'LGPL-3.0-or-later',
];
/** Licences whose terms require shipping the licence text with the files. */
export const NEEDS_TEXT = /^(MIT|BSD-|ISC|Zlib|Apache-|GPL-|LGPL-)/;
export const ASSET_EXT = /\.(json|png|jpe?g|webp|glb|map|md|txt)$/i;
export const DOC_FILE = /^(ATTRIBUTION\.md|README\.md|LICENSE(\.txt|\.md)?|COPYING(\.txt)?|CREDITS(\.txt|\.md)?)$/i;
export const FORBIDDEN_EXT = /\.(wad|pak|pk3|bsp|mdl|vpk|exe|dll|js|mjs|html?|svg)$/i;

// ---------------------------------------------------------------------------------------------
// Document types (map.json)

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export interface NoiseLayer { noise?: 'fbm'; scale: number; octaves?: number; seed?: number; amplitude: number; mask?: { shape: 'square' | 'circle'; center?: Vec2; from: number; to: number; invert?: boolean } }
interface GroundCommon { material?: 'grass' | 'dirt' | 'concrete'; visible?: boolean; texture?: string }
export type GroundDoc =
  | GroundCommon & { type: 'flat'; z?: number }
  | GroundCommon & { type: 'heightfield'; image: string; extent: Vec2; center?: Vec2; zMin: number; zMax: number }
  | GroundCommon & { type: 'noise'; base?: number; layers: NoiseLayer[] };
interface PrimCommon { material?: Material; color?: string; tag?: string }
export type PrimDoc =
  | PrimCommon & { type: 'box'; pos: Vec3; size: Vec3; yawDeg?: number; pitchDeg?: number; visual?: BoxPrim['visual']; texture?: string; text?: string }
  | PrimCommon & { type: 'cylinder'; pos: Vec3; radius: number; height: number }
  | PrimCommon & { type: 'sphere'; pos: Vec3; radius: number };
export interface GateDoc { kind: GateDef['kind']; pos: Vec2 | Vec3; yawDeg?: number; width?: number; height?: number; stack?: number; onTop?: boolean }
export interface TreeDoc { pos: Vec2; height: number; radius: number; type: 'pine' | 'oak' }
export interface WakeDoc { pos: Vec2; radius: number; height: number; intensity: number }
/** Point light (interior fixture, floodlight): illuminance ~ intensity / d² (the sun is ~4.5), cut off at range. */
export interface LightDoc { pos: Vec3; color?: string; intensity: number; range: number }
/** Enclosed space (axis-aligned box, min / max corners): wind inside is scaled by windScale. */
export interface IndoorDoc { min: Vec3; max: Vec3; windScale?: number }
export type GeometryDoc =
  | { type: 'quake'; src: string; scale?: number; ambient?: number; spawnClass?: string; textures?: string }
  | { type: 'doom'; src: string; scale?: number; textures: string }
  | { type: 'gltf'; src: string; pos?: Vec3; yawDeg?: number; scale?: number; collision?: 'mesh' | 'box' | 'none'; material?: Material };

/** A named start: where the quad sits, and optionally where the pilot / video receiver stands. */
export interface SpawnDoc { id: string; name?: string; pos: Vec3; yawDeg?: number; groundZ?: number; pilot?: Vec3 }
/** An alternative gate course on the same map, timed on its own; spawn names a spawns[] entry. */
export interface CourseDoc { id: string; name: string; gates: GateDoc[]; spawn?: string }
/** A polyline that actors move along at speedMs (sim time): loop, back and forth, or once and stop. */
export interface PathDoc { id: string; points: Vec3[]; speedMs: number; mode?: (typeof PATH_MODES)[number]; delayS?: number }
interface ActorCommon { id: string; name?: string; pos?: Vec3; path?: string }
export type ActorDoc =
  /** A transmitter on a band: a jammer or another link's traffic (noise rise for links in band). */
  | ActorCommon & { type: 'rf-emitter'; freqMHz: number; eirpDbm: number; bwMHz?: number; duty?: number; antenna?: { yawDeg: number; pitchDeg?: number; beamDeg: number } }
  /** An extra RC transmitter / video receiver site (relay, diversity): the best site carries the link. */
  | ActorCommon & { type: 'ground-station'; link?: 'rc' | 'video' | 'both'; txPowerMw?: number; gainDbi?: number }
  /** A sensor that detects the quad: camera (optical), radar, or RF (detects the video transmitter). */
  | ActorCommon & { type: 'detector'; sensor: (typeof SENSOR_TYPES)[number]; yawDeg?: number; pitchDeg?: number; fovDeg?: Vec2; rangeM: number; r50M?: number; sensitivityDbm?: number; rateHz?: number; confirm?: Vec2 }
  /** Something to reach, inspect, track or follow (static, or moving along a path). */
  | ActorCommon & { type: 'target'; shape?: (typeof TARGET_SHAPES)[number]; size?: Vec3; radiusM?: number; solid?: boolean; color?: string };

export interface MapMeta { id: string; name: string; author: string; license: string; version: string; description?: string; preview?: string; tags?: string[]; homepage?: string }
export interface MapDocV1 {
  $schema?: string;
  format: typeof FORMAT; formatVersion: 1;
  meta: MapMeta;
  units?: 'm'; frame?: 'ENU';
  size: number;
  elevationM?: number;
  spawn?: { pos: Vec3; yawDeg?: number; groundZ?: number };
  pilot?: Vec3;
  environment?: { sky?: MapDef['sky']; sun?: { azimuthDeg: number; elevationDeg: number }; fog?: { color: string; density: number }; windScale?: number; wind?: { speed: number; directionDeg: number; turbulence?: number; gusts?: number } };
  ground?: GroundDoc;
  primitives?: PrimDoc[];
  gates?: GateDoc[];
  trees?: TreeDoc[];
  wakeZones?: WakeDoc[];
  indoor?: IndoorDoc[];
  lights?: LightDoc[];
  geometry?: GeometryDoc[];
  spawns?: SpawnDoc[];
  courses?: CourseDoc[];
  paths?: PathDoc[];
  actors?: ActorDoc[];
  /** Bundled fpvsim-scenario files (package paths). */
  scenarios?: string[];
}


// ---------------------------------------------------------------------------------------------
// Structural validation

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const show = (v: unknown) => { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 40 ? s.slice(0, 37) + '...' : s; };

export class Checker {
  errors: string[] = [];
  warnings: string[] = [];
  err(path: string, msg: string) { this.errors.push(`${path}: ${msg}`); }
  warn(path: string, msg: string) { this.warnings.push(`${path}: ${msg}`); }

  /** An object with only the given keys (plus "$schema", "$comment" and "x-*" extension keys). */
  obj(v: unknown, path: string, keys: string[], required: string[] = []): v is Obj {
    if (!isObj(v)) { this.err(path, `must be an object (got ${show(v)})`); return false; }
    for (const k of Object.keys(v)) if (!keys.includes(k) && !k.startsWith('x-') && k !== '$comment' && k !== '$schema') {
      const near = keys.find((x) => x.toLowerCase() === k.toLowerCase());
      this.err(`${path}.${k}`, `unknown property${near ? ` (did you mean "${near}"?)` : ''}; allowed: ${keys.join(', ')}`);
    }
    for (const k of required) if (v[k] === undefined) this.err(`${path}.${k}`, 'is required');
    return true;
  }
  num(o: Obj, k: string, path: string, r: { min?: number; max?: number; gt?: number; int?: boolean; req?: boolean } = {}): number | undefined {
    const v = o[k];
    if (v === undefined) { if (r.req) this.err(`${path}.${k}`, 'is required'); return undefined; }
    return this.numV(v, `${path}.${k}`, r);
  }
  numV(v: unknown, path: string, r: { min?: number; max?: number; gt?: number; int?: boolean } = {}): number | undefined {
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.err(path, `must be a finite number (got ${show(v)})`); return undefined; }
    if (r.int && !Number.isInteger(v)) this.err(path, `must be an integer (got ${v})`);
    else if (r.gt !== undefined && !(v > r.gt)) this.err(path, `must be > ${r.gt} (got ${v})`);
    else if (r.min !== undefined && v < r.min) this.err(path, `must be >= ${r.min} (got ${v})`);
    else if (r.max !== undefined && v > r.max) this.err(path, `must be <= ${r.max} (got ${v})`);
    return v;
  }
  str(o: Obj, k: string, path: string, r: { re?: RegExp; max?: number; oneOf?: readonly string[]; req?: boolean; hint?: string } = {}): string | undefined {
    const v = o[k], p = `${path}.${k}`;
    if (v === undefined) { if (r.req) this.err(p, 'is required'); return undefined; }
    if (typeof v !== 'string') { this.err(p, `must be a string (got ${show(v)})`); return undefined; }
    if (r.oneOf && !r.oneOf.includes(v)) this.err(p, `must be one of ${r.oneOf.map((x) => `"${x}"`).join(', ')} (got ${show(v)})`);
    else if (r.max !== undefined && v.length > r.max) this.err(p, `must be at most ${r.max} characters`);
    else if (r.re && !r.re.test(v)) this.err(p, `${r.hint ?? `must match ${r.re}`} (got ${show(v)})`);
    return v;
  }
  bool(o: Obj, k: string, path: string) { if (o[k] !== undefined && typeof o[k] !== 'boolean') this.err(`${path}.${k}`, `must be true or false (got ${show(o[k])})`); }
  vec(o: Obj, k: string, path: string, n: number | [number, number], r: { gt?: number; req?: boolean } = {}): number[] | undefined {
    const v = o[k], p = `${path}.${k}`;
    if (v === undefined) { if (r.req) this.err(p, 'is required'); return undefined; }
    const [lo, hi] = typeof n === 'number' ? [n, n] : n;
    if (!Array.isArray(v) || v.length < lo || v.length > hi) { this.err(p, `must be an array of ${lo === hi ? lo : `${lo}-${hi}`} numbers (got ${show(v)})`); return undefined; }
    v.forEach((x, i) => this.numV(x, `${p}[${i}]`, { gt: r.gt }));
    return v as number[];
  }
  arr(o: Obj, k: string, path: string, max: number, each: (v: unknown, p: string, i: number) => void) {
    const v = o[k];
    if (v === undefined) return;
    if (!Array.isArray(v)) { this.err(`${path}.${k}`, 'must be an array'); return; }
    if (v.length > max) this.err(`${path}.${k}`, `has ${v.length} entries; the budget is ${max}`);
    v.slice(0, max).forEach((x, i) => each(x, `${path}.${k}[${i}]`, i));
  }
  path(o: Obj, k: string, path: string, req = false, ext?: RegExp): string | undefined {
    const v = this.str(o, k, path, { req });
    if (v === undefined) return undefined;
    const e = assetPathError(v);
    if (e) this.err(`${path}.${k}`, e);
    else if (ext && !ext.test(v)) this.err(`${path}.${k}`, `must be a ${ext.source.replace(/\\|\$|\(|\)|\?:/g, '').replace(/\|/g, ' / ')} file (got ${show(v)})`);
    return v;
  }
}

/** Why a package-relative path is not allowed, or null when it is fine. */
export function assetPathError(p: string): string | null {
  if (!p) return 'must not be empty';
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) return `must be a relative path inside the package, not a URL (got ${show(p)})`;
  if (p.startsWith('/') || p.includes('\\')) return `must be a relative path with forward slashes (got ${show(p)})`;
  if (p.split('/').some((s) => s === '..' || s === '.' || s === '')) return `must not contain "..", "." or empty segments (got ${show(p)})`;
  if (!/^[A-Za-z0-9._/-]+$/.test(p) || p.length > 128) return `may only use A-Z a-z 0-9 . _ - / and be at most 128 characters (got ${show(p)})`;
  return null;
}

/** SPDX expression check against ALLOWED_LICENSES ("A", "A OR B", "A AND B", optional parentheses). */
export function licenseError(spdx: string): string | null {
  const ids = spdx.replace(/[()]/g, ' ').split(/\s+(?:AND|OR)\s+|\s+/).filter(Boolean);
  const bad = ids.filter((id) => !ALLOWED_LICENSES.includes(id));
  if (!ids.length) return 'must be an SPDX licence id';
  if (!bad.length) return null;
  const nc = bad.find((id) => /-NC|-ND/.test(id));
  if (nc) return `${nc} is not allowed: NonCommercial / NoDerivatives licences cannot be distributed with a GPL-3.0-or-later program`;
  return `"${bad.join('", "')}" is not an accepted SPDX licence id; use one of ${ALLOWED_LICENSES.join(', ')}`;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,23}$/;
const IMG = /\.(png|jpe?g|webp)$/i;
const OBJ_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Validate a parsed map.json. Returns the typed document or throws MapFormatError with every problem found. */
export function validateMapDoc(raw: unknown): { doc: MapDocV1; warnings: string[] } {
  const c = new Checker();
  const R = 'map.json';
  if (!c.obj(raw, R, ['format', 'formatVersion', 'meta', 'units', 'frame', 'size', 'elevationM', 'spawn', 'pilot', 'environment', 'ground', 'primitives', 'gates', 'trees', 'wakeZones', 'indoor', 'lights', 'geometry', 'spawns', 'courses', 'paths', 'actors', 'scenarios'], ['format', 'formatVersion', 'meta', 'size'])) throw new MapFormatError(c.errors);
  const d = raw;
  if (d.format !== undefined && d.format !== FORMAT) c.err(`${R}.format`, `must be "${FORMAT}" (got ${show(d.format)})`);
  if (d.formatVersion !== undefined && d.formatVersion !== FORMAT_VERSION) c.err(`${R}.formatVersion`, typeof d.formatVersion === 'number' && d.formatVersion > FORMAT_VERSION ? `${d.formatVersion} is newer than this simulator supports (${FORMAT_VERSION}); update the simulator` : `must be ${FORMAT_VERSION}`);
  c.str(d, 'units', R, { oneOf: ['m'] });
  c.str(d, 'frame', R, { oneOf: ['ENU'] });
  c.num(d, 'size', R, { gt: 0, max: BUDGETS.halfExtentM });
  c.num(d, 'elevationM', R, { min: -500, max: 9000 });

  const M = `${R}.meta`;
  if (c.obj(d.meta, M, ['id', 'name', 'author', 'license', 'version', 'description', 'preview', 'tags', 'homepage'], ['id', 'name', 'author', 'license', 'version'])) {
    const m = d.meta;
    c.str(m, 'id', M, { re: ID, hint: 'must be 2-24 characters of a-z, 0-9 and "-", starting with a letter or digit' });
    c.str(m, 'name', M, { max: 64, re: /\S/, hint: 'must not be blank' });
    c.str(m, 'author', M, { max: 96, re: /\S/, hint: 'must not be blank' });
    const lic = c.str(m, 'license', M, { max: 120 });
    if (lic !== undefined) { const e = licenseError(lic); if (e) c.err(`${M}.license`, e); }
    c.str(m, 'version', M, { re: /^\d+\.\d+\.\d+$/, hint: 'must be a semantic version like "1.0.0"' });
    c.str(m, 'description', M, { max: 600 });
    c.str(m, 'homepage', M, { max: 200, re: /^https:\/\//, hint: 'must be an https:// URL' });
    c.path(m, 'preview', M, false, IMG);
    c.arr(m, 'tags', M, 8, (t, p) => { if (typeof t !== 'string' || !/^[a-z0-9-]{1,24}$/.test(t)) c.err(p, `must be a short lower-case tag (got ${show(t)})`); });
  }

  const hasBase = Array.isArray(d.geometry) && d.geometry.some((g) => isObj(g) && (g.type === 'quake' || g.type === 'doom'));
  if (d.spawn === undefined && !hasBase) c.err(`${R}.spawn`, 'is required (only maps built on a Quake or Doom geometry entry may omit it)');
  if (d.spawn !== undefined && c.obj(d.spawn, `${R}.spawn`, ['pos', 'yawDeg', 'groundZ'], ['pos'])) {
    c.vec(d.spawn, 'pos', `${R}.spawn`, 3); c.num(d.spawn, 'yawDeg', `${R}.spawn`); c.num(d.spawn, 'groundZ', `${R}.spawn`);
  }
  c.vec(d, 'pilot', R, 3);

  const E = `${R}.environment`;
  if (d.environment !== undefined && c.obj(d.environment, E, ['sky', 'sun', 'fog', 'windScale', 'wind'])) {
    const e = d.environment;
    c.str(e, 'sky', E, { oneOf: ['clear', 'overcast', 'dusk', 'night'] });
    if (e.sun !== undefined && c.obj(e.sun, `${E}.sun`, ['azimuthDeg', 'elevationDeg'], ['azimuthDeg', 'elevationDeg'])) {
      c.num(e.sun, 'azimuthDeg', `${E}.sun`, { min: 0, max: 360 }); c.num(e.sun, 'elevationDeg', `${E}.sun`, { min: -10, max: 90 });
    }
    if (e.fog !== undefined && c.obj(e.fog, `${E}.fog`, ['color', 'density'], ['color', 'density'])) {
      c.str(e.fog, 'color', `${E}.fog`, { re: COLOR, hint: 'must be a colour like "#a9b0b5"' }); c.num(e.fog, 'density', `${E}.fog`, { min: 0, max: 0.1 });
    }
    c.num(e, 'windScale', E, { min: 0, max: 2 });
    if (e.wind !== undefined && c.obj(e.wind, `${E}.wind`, ['speed', 'directionDeg', 'turbulence', 'gusts'], ['speed', 'directionDeg'])) {
      c.num(e.wind, 'speed', `${E}.wind`, { min: 0, max: 30 }); c.num(e.wind, 'directionDeg', `${E}.wind`, { min: 0, max: 360 });
      c.num(e.wind, 'turbulence', `${E}.wind`, { min: 0, max: 3 }); c.num(e.wind, 'gusts', `${E}.wind`, { min: 0, max: 20 });
    }
  }

  const G = `${R}.ground`;
  if (d.ground !== undefined && isObj(d.ground)) {
    const g = d.ground, common = ['type', 'material', 'visible', 'texture'];
    const type = c.str(g, 'type', G, { req: true, oneOf: ['flat', 'heightfield', 'noise'] });
    if (type === 'flat' && c.obj(g, G, [...common, 'z'])) c.num(g, 'z', G);
    if (type === 'heightfield' && c.obj(g, G, [...common, 'image', 'extent', 'center', 'zMin', 'zMax'], ['image', 'extent', 'zMin', 'zMax'])) {
      c.path(g, 'image', G, true, /\.png$/i); c.vec(g, 'extent', G, 2, { gt: 0 }); c.vec(g, 'center', G, 2);
      const lo = c.num(g, 'zMin', G), hi = c.num(g, 'zMax', G);
      if (lo !== undefined && hi !== undefined && hi < lo) c.err(`${G}.zMax`, `must be >= zMin (${lo})`);
    }
    if (type === 'noise' && c.obj(g, G, [...common, 'base', 'layers'], ['layers'])) {
      c.num(g, 'base', G);
      c.arr(g, 'layers', G, 8, (l, p) => {
        if (!c.obj(l, p, ['noise', 'scale', 'octaves', 'seed', 'amplitude', 'mask'], ['scale', 'amplitude'])) return;
        c.str(l, 'noise', p, { oneOf: ['fbm'] }); c.num(l, 'scale', p, { gt: 0 }); c.num(l, 'octaves', p, { int: true, min: 1, max: 8 });
        c.num(l, 'seed', p, { int: true }); c.num(l, 'amplitude', p);
        if (l.mask !== undefined && c.obj(l.mask, `${p}.mask`, ['shape', 'center', 'from', 'to', 'invert'], ['shape', 'from', 'to'])) {
          const mk = l.mask;
          c.str(mk, 'shape', `${p}.mask`, { oneOf: ['square', 'circle'] }); c.vec(mk, 'center', `${p}.mask`, 2);
          const from = c.num(mk, 'from', `${p}.mask`, { min: 0 }), to = c.num(mk, 'to', `${p}.mask`, { min: 0 });
          if (from !== undefined && to !== undefined && !(to > from)) c.err(`${p}.mask.to`, `must be > from (${from})`);
          c.bool(mk, 'invert', `${p}.mask`);
        }
      });
    }
    if (type) { c.str(g, 'material', G, { oneOf: ['grass', 'dirt', 'concrete'] }); c.bool(g, 'visible', G); c.path(g, 'texture', G, false, IMG); }
  } else if (d.ground !== undefined) c.err(G, `must be an object (got ${show(d.ground)})`);

  const common = ['type', 'pos', 'material', 'color', 'tag'];
  c.arr(d, 'primitives', R, BUDGETS.primitives, (p, P) => {
    if (!isObj(p)) { c.err(P, `must be an object (got ${show(p)})`); return; }
    const type = c.str(p, 'type', P, { req: true, oneOf: ['box', 'cylinder', 'sphere'] });
    if (type === 'box' && c.obj(p, P, [...common, 'size', 'yawDeg', 'pitchDeg', 'visual', 'texture', 'text'], ['pos', 'size'])) {
      c.str(p, 'text', P, { max: 40 });
      c.vec(p, 'size', P, 3, { gt: 0 }); c.num(p, 'yawDeg', P); c.num(p, 'pitchDeg', P, { min: -90, max: 90 });
      c.str(p, 'visual', P, { oneOf: VISUALS }); c.path(p, 'texture', P, false, IMG);
    }
    if (type === 'cylinder' && c.obj(p, P, [...common, 'radius', 'height'], ['pos', 'radius', 'height'])) { c.num(p, 'radius', P, { gt: 0 }); c.num(p, 'height', P, { gt: 0 }); }
    if (type === 'sphere' && c.obj(p, P, [...common, 'radius'], ['pos', 'radius'])) c.num(p, 'radius', P, { gt: 0 });
    if (!type) return;
    c.vec(p, 'pos', P, 3); c.str(p, 'material', P, { oneOf: MATERIAL_NAMES });
    c.str(p, 'color', P, { re: COLOR, hint: 'must be a colour like "#2a5bd7"' }); c.str(p, 'tag', P, { max: 32, re: /^[A-Za-z0-9_-]+$/, hint: 'may only use A-Z a-z 0-9 _ -' });
  });
  const gate = (g: unknown, P: string) => {
    if (!c.obj(g, P, ['kind', 'pos', 'yawDeg', 'width', 'height', 'stack', 'onTop'], ['kind', 'pos'])) return;
    const kind = c.str(g, 'kind', P, { oneOf: GATE_KINDS });
    const pos = c.vec(g, 'pos', P, [2, 3]);
    if (kind === 'dive' && pos && pos.length !== 3) c.err(`${P}.pos`, 'a dive gate needs [x, y, z]: z is the height of its frame');
    c.num(g, 'yawDeg', P); c.num(g, 'width', P, { gt: 0, max: 20 }); c.num(g, 'height', P, { gt: 0, max: 20 });
    c.num(g, 'stack', P, { min: 1, max: 6 }); c.bool(g, 'onTop', P);
  };
  c.arr(d, 'gates', R, BUDGETS.gates, gate);
  c.arr(d, 'trees', R, BUDGETS.trees, (t, P) => {
    if (!c.obj(t, P, ['pos', 'height', 'radius', 'type'], ['pos', 'height', 'radius', 'type'])) return;
    c.vec(t, 'pos', P, 2); c.num(t, 'height', P, { gt: 0, max: 60 }); c.num(t, 'radius', P, { gt: 0, max: 20 }); c.str(t, 'type', P, { oneOf: ['pine', 'oak'] });
  });
  c.arr(d, 'wakeZones', R, BUDGETS.wakeZones, (w, P) => {
    if (!c.obj(w, P, ['pos', 'radius', 'height', 'intensity'], ['pos', 'radius', 'height', 'intensity'])) return;
    c.vec(w, 'pos', P, 2); c.num(w, 'radius', P, { gt: 0 }); c.num(w, 'height', P, { gt: 0 }); c.num(w, 'intensity', P, { min: 0, max: 5 });
  });
  c.arr(d, 'indoor', R, BUDGETS.indoor, (w, P) => {
    if (!c.obj(w, P, ['min', 'max', 'windScale'], ['min', 'max'])) return;
    const a = c.vec(w, 'min', P, 3), b = c.vec(w, 'max', P, 3); c.num(w, 'windScale', P, { min: 0, max: 1 });
    if (a && b && a.length === 3 && b.length === 3 && !(a[0] < b[0] && a[1] < b[1] && a[2] < b[2])) c.err(P, 'min must be below max on every axis');
  });
  c.arr(d, 'lights', R, BUDGETS.lights, (l, P) => {
    if (!c.obj(l, P, ['pos', 'color', 'intensity', 'range'], ['pos', 'intensity', 'range'])) return;
    c.vec(l, 'pos', P, 3); c.str(l, 'color', P, { re: COLOR, hint: 'must be a colour like "#fff1dc"' });
    c.num(l, 'intensity', P, { gt: 0, max: 10000 }); c.num(l, 'range', P, { gt: 0, max: 1000 });
  });

  // ---- spawns, courses, paths, actors, scenarios ----
  const ids = (k: string) => new Set((Array.isArray(d[k]) ? d[k] as unknown[] : []).map((x) => (isObj(x) ? x.id : undefined)).filter((x): x is string => typeof x === 'string'));
  const unique = (k: string) => {
    const seen = new Set<string>();
    (Array.isArray(d[k]) ? d[k] as unknown[] : []).forEach((x, i) => { if (isObj(x) && typeof x.id === 'string') { if (seen.has(x.id)) c.err(`${R}.${k}[${i}].id`, `"${x.id}" is used twice`); seen.add(x.id); } });
  };
  const idRule = { req: true, re: OBJ_ID, hint: 'must be 1-32 characters of a-z, 0-9, "_" and "-"' };
  const spawnIds = ids('spawns'), pathIds = ids('paths');
  c.arr(d, 'spawns', R, BUDGETS.spawns, (v, P) => {
    if (!c.obj(v, P, ['id', 'name', 'pos', 'yawDeg', 'groundZ', 'pilot'], ['id', 'pos'])) return;
    c.str(v, 'id', P, idRule); c.str(v, 'name', P, { max: 64 });
    c.vec(v, 'pos', P, 3); c.num(v, 'yawDeg', P); c.num(v, 'groundZ', P); c.vec(v, 'pilot', P, 3);
  });
  unique('spawns');
  let courseGates = 0;
  c.arr(d, 'courses', R, BUDGETS.courses, (v, P) => {
    if (!c.obj(v, P, ['id', 'name', 'gates', 'spawn'], ['id', 'name', 'gates'])) return;
    c.str(v, 'id', P, idRule); c.str(v, 'name', P, { max: 64, re: /\S/, hint: 'must not be blank' });
    const sp = c.str(v, 'spawn', P);
    if (sp !== undefined && !spawnIds.has(sp)) c.err(`${P}.spawn`, `"${sp}" is not the id of an entry in spawns`);
    if (Array.isArray(v.gates) && !v.gates.length) c.err(`${P}.gates`, 'must have at least one gate');
    courseGates += Array.isArray(v.gates) ? v.gates.length : 0;
    c.arr(v, 'gates', P, BUDGETS.gates, gate);
  });
  unique('courses');
  if (courseGates + (Array.isArray(d.gates) ? d.gates.length : 0) > BUDGETS.gates * 4) c.err(`${R}.courses`, `the map has ${courseGates} course gates; all courses together may have at most ${BUDGETS.gates * 4 - (Array.isArray(d.gates) ? d.gates.length : 0)}`);
  c.arr(d, 'paths', R, BUDGETS.paths, (v, P) => {
    if (!c.obj(v, P, ['id', 'points', 'speedMs', 'mode', 'delayS'], ['id', 'points', 'speedMs'])) return;
    c.str(v, 'id', P, idRule); c.num(v, 'speedMs', P, { min: 0, max: 100 }); c.str(v, 'mode', P, { oneOf: PATH_MODES }); c.num(v, 'delayS', P, { min: 0, max: 3600 });
    if (Array.isArray(v.points) && v.points.length < 2) c.err(`${P}.points`, 'must have at least 2 points');
    c.arr(v, 'points', P, BUDGETS.pathPoints, (pt, PP) => { if (!Array.isArray(pt) || pt.length !== 3) c.err(PP, `must be an array of 3 numbers (got ${show(pt)})`); else pt.forEach((x, k) => c.numV(x, `${PP}[${k}]`)); });
  });
  unique('paths');
  c.arr(d, 'actors', R, BUDGETS.actors, (a, P) => {
    if (!isObj(a)) { c.err(P, `must be an object (got ${show(a)})`); return; }
    const common = ['type', 'id', 'name', 'pos', 'path'];
    const type = c.str(a, 'type', P, { req: true, oneOf: ACTOR_TYPES });
    if (type === 'rf-emitter' && c.obj(a, P, [...common, 'freqMHz', 'eirpDbm', 'bwMHz', 'duty', 'antenna'], ['freqMHz', 'eirpDbm'])) {
      c.num(a, 'freqMHz', P, { min: 100, max: 10000 }); c.num(a, 'eirpDbm', P, { min: -30, max: 70 }); c.num(a, 'bwMHz', P, { gt: 0, max: 1000 }); c.num(a, 'duty', P, { min: 0, max: 1 });
      if (a.antenna !== undefined && c.obj(a.antenna, `${P}.antenna`, ['yawDeg', 'pitchDeg', 'beamDeg'], ['yawDeg', 'beamDeg'])) {
        c.num(a.antenna, 'yawDeg', `${P}.antenna`); c.num(a.antenna, 'pitchDeg', `${P}.antenna`, { min: -90, max: 90 }); c.num(a.antenna, 'beamDeg', `${P}.antenna`, { gt: 0, max: 360 });
      }
    }
    if (type === 'ground-station' && c.obj(a, P, [...common, 'link', 'txPowerMw', 'gainDbi'])) {
      c.str(a, 'link', P, { oneOf: ['rc', 'video', 'both'] }); c.num(a, 'txPowerMw', P, { gt: 0, max: 10000 }); c.num(a, 'gainDbi', P, { min: -10, max: 30 });
    }
    if (type === 'detector' && c.obj(a, P, [...common, 'sensor', 'yawDeg', 'pitchDeg', 'fovDeg', 'rangeM', 'r50M', 'sensitivityDbm', 'rateHz', 'confirm'], ['sensor', 'rangeM'])) {
      c.str(a, 'sensor', P, { oneOf: SENSOR_TYPES }); c.num(a, 'yawDeg', P); c.num(a, 'pitchDeg', P, { min: -90, max: 90 });
      const fov = c.vec(a, 'fovDeg', P, 2, { gt: 0 }); if (fov && fov.some((x) => x > 360)) c.err(`${P}.fovDeg`, 'must be at most 360 degrees');
      c.num(a, 'rangeM', P, { gt: 0, max: 20000 }); c.num(a, 'r50M', P, { gt: 0, max: 20000 }); c.num(a, 'sensitivityDbm', P, { min: -150, max: 0 }); c.num(a, 'rateHz', P, { gt: 0, max: 100 });
      const cf = c.vec(a, 'confirm', P, 2, { gt: 0 });
      if (cf && (!Number.isInteger(cf[0]) || !Number.isInteger(cf[1]) || cf[0] > cf[1] || cf[1] > 32)) c.err(`${P}.confirm`, 'must be [m, n]: whole numbers with m <= n <= 32 (m detections in the last n looks)');
    }
    if (type === 'target' && c.obj(a, P, [...common, 'shape', 'size', 'radiusM', 'solid', 'color'])) {
      c.str(a, 'shape', P, { oneOf: TARGET_SHAPES }); c.vec(a, 'size', P, 3, { gt: 0 }); c.num(a, 'radiusM', P, { gt: 0, max: 1000 }); c.bool(a, 'solid', P);
      c.str(a, 'color', P, { re: COLOR, hint: 'must be a colour like "#e8433a"' });
      if (a.solid === true && a.path !== undefined) c.err(`${P}.solid`, 'moving targets (with a path) cannot be solid');
    }
    if (!type) return;
    c.str(a, 'id', P, idRule); c.str(a, 'name', P, { max: 64 }); c.vec(a, 'pos', P, 3);
    const path = c.str(a, 'path', P);
    if (path !== undefined && !pathIds.has(path)) c.err(`${P}.path`, `"${path}" is not the id of an entry in paths`);
    if ((a.pos === undefined) === (a.path === undefined)) c.err(P, 'needs either pos (a fixed place) or path (moves along a path), not both');
  });
  unique('actors');
  c.arr(d, 'scenarios', R, BUDGETS.scenarios, (v, P) => {
    if (typeof v !== 'string') { c.err(P, `must be a package path (got ${show(v)})`); return; }
    const e = assetPathError(v);
    if (e) c.err(P, e); else if (!/\.json$/i.test(v)) c.err(P, `must be a .json file (got ${show(v)})`);
  });

  let bases = 0;
  c.arr(d, 'geometry', R, BUDGETS.geometry, (g, P) => {
    if (!isObj(g)) { c.err(P, `must be an object (got ${show(g)})`); return; }
    const type = c.str(g, 'type', P, { req: true, oneOf: ['quake', 'doom', 'gltf'] });
    if (type === 'quake' && c.obj(g, P, ['type', 'src', 'scale', 'ambient', 'spawnClass', 'textures'], ['src'])) {
      c.path(g, 'src', P, true, /\.map$/i); c.num(g, 'scale', P, { gt: 0, max: 1 }); c.num(g, 'ambient', P, { min: 0, max: 255 });
      c.str(g, 'spawnClass', P, { re: /^[a-z_]+$/, hint: 'must be a Quake entity class name' });
      if (g.textures !== 'builtin:librequake') c.path(g, 'textures', P, false, /\.json$/i);
    }
    if (type === 'doom' && c.obj(g, P, ['type', 'src', 'scale', 'textures'], ['src', 'textures'])) {
      c.path(g, 'src', P, true, /\.json$/i); c.num(g, 'scale', P, { gt: 0, max: 1 }); c.path(g, 'textures', P, true, /\.json$/i);
    }
    if (type === 'gltf' && c.obj(g, P, ['type', 'src', 'pos', 'yawDeg', 'scale', 'collision', 'material'], ['src'])) {
      c.path(g, 'src', P, true, /\.glb$/i); c.vec(g, 'pos', P, 3); c.num(g, 'yawDeg', P); c.num(g, 'scale', P, { gt: 0, max: 1000 });
      c.str(g, 'collision', P, { oneOf: ['mesh', 'box', 'none'] }); c.str(g, 'material', P, { oneOf: MATERIAL_NAMES });
    }
    if ((type === 'quake' || type === 'doom') && ++bases > 1) c.err(P, 'only one Quake or Doom geometry entry is allowed per map');
  });
  if (c.errors.length) throw new MapFormatError(c.errors, c.warnings);
  return { doc: d as unknown as MapDocV1, warnings: c.warnings };
}

// ---------------------------------------------------------------------------------------------
// Image headers and PNG decoding

/** Width / height of a PNG, JPEG or WebP from its header, or null if it is none of those. */
export function imageSize(b: Uint8Array): { type: 'png' | 'jpeg' | 'webp'; w: number; h: number } | null {
  const be32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (b.length > 24 && be32(0) === 0x89504e47 && be32(4) === 0x0d0a1a0a) return { type: 'png', w: be32(16), h: be32(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let o = 2; o + 9 < b.length;) {
      if (b[o] !== 0xff) return null;
      const m = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'jpeg', h: (b[o + 5] << 8) | b[o + 6], w: (b[o + 7] << 8) | b[o + 8] };
      o += 2 + len;
    }
    return null;
  }
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length > 30 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    const k = tag(12), le16 = (o: number) => b[o] | (b[o + 1] << 8), le24 = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
    if (k === 'VP8 ') return { type: 'webp', w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (k === 'VP8L') { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { type: 'webp', w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
    if (k === 'VP8X') return { type: 'webp', w: le24(24) + 1, h: le24(27) + 1 };
  }
  return null;
}

/** Decode a non-interlaced 8/16-bit PNG to its first channel (grey or red), normalised to 0..1. */
export async function decodePngChannel(b: Uint8Array): Promise<{ w: number; h: number; data: Float32Array }> {
  const be32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (imageSize(b)?.type !== 'png') throw new Error('not a PNG file');
  let o = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (o + 8 <= b.length) {
    const len = be32(o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const body = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = be32(o + 8); h = be32(o + 12); depth = body[8]; ctype = body[9]; interlace = body[12]; }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels) throw new Error(`PNG colour type ${ctype} is not supported (use greyscale, RGB or RGBA, not palette)`);
  if (depth !== 8 && depth !== 16) throw new Error(`PNG bit depth ${depth} is not supported (use 8 or 16)`);
  if (interlace) throw new Error('interlaced PNGs are not supported');
  const all = new Uint8Array(idat.reduce((s, x) => s + x.length, 0));
  let k = 0; for (const x of idat) { all.set(x, k); k += x.length; }
  const raw = await inflate(all, 'deflate');
  const bpp = channels * (depth / 8), stride = w * bpp;
  if (raw.length < h * (stride + 1)) throw new Error('truncated PNG data');
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v;
    }
    for (let x = 0; x < w; x++) data[y * w + x] = depth === 8 ? cur[x * bpp] / 255 : ((cur[x * bpp] << 8) | cur[x * bpp + 1]) / 65535;
    prev.set(cur);
  }
  return { w, h, data };
}
