// fpvsim-map v1: declarative JSON map packages (docs/MAP_FORMAT.md, schemas/map.v1.schema.json).
// A package is a folder with map.json + assets. loadMapPackage() reads and strictly validates it
// (structure, budgets, licence files, asset formats), decodes what collision needs (heightfield
// PNG, Quake .map / Doom lump JSON, .glb triangles), and returns a synchronous MapDef builder that
// the physics worker and the renderer both run, so they agree exactly.
//
// NOTE: maps.ts imports this module and this module imports maps.ts (gate geometry). Keep this
// module's top level free of calls into maps.ts, and packageEntry() free of top-level state access.
import { V3 } from '../sim/math';
import type { WakeZone, WindVolume } from '../sim/wind';
import { doomMapDef } from './doomMap';
import { buildGatePrims, type MapEntry } from './maps';
import { quakeMapDef } from './quakeMap';
import { BoxPrim, BrushPrim, fbm, GateDef, MapDef, Material, MAX_MAP_LIGHTS, MeshInstance, Prim } from './world';
import { inflate } from './zip';

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
  lights: MAX_MAP_LIGHTS,         // point lights (fixtures, floodlights)
  geometry: 16,                   // geometry entries
  brushes: 20000,                 // convex brushes from Quake / Doom sources + mesh collision slabs
  meshTriangles: 150000,          // drawn glTF triangles, all meshes
  collisionTriangles: 20000,      // glTF triangles with collision 'mesh', all meshes
  texturePx: 1024,                // max texture width / height
  textureBytes: 1 << 20,
  heightfieldPx: 1025,            // max heightfield width / height
  previewBytes: 512 << 10,
};

export const MATERIAL_NAMES = ['grass', 'dirt', 'concrete', 'metal', 'wood', 'foliage', 'gate'] as const;
export const VISUALS = ['concrete', 'brick', 'metal', 'wood', 'gate', 'pad', 'glass', 'plain', 'led', 'banner', 'screen', 'net'] as const;
export const GATE_KINDS = ['square', 'arch', 'dive', 'flag', 'hurdle', 'ladder'] as const;
const GATE_SIZE: Record<GateDef['kind'], [number, number]> = { square: [1.524, 1.524], arch: [3.0, 2.6], dive: [1.524, 1.524], flag: [1.524, 3.2], hurdle: [3.6, 1.8], ladder: [1.524, 1.524] };

/** SPDX licence ids accepted for maps in the repository (distributable with a GPL-3.0-or-later program). */
export const ALLOWED_LICENSES = [
  'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'Unlicense', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Zlib',
  'Apache-2.0', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'LGPL-2.1-or-later', 'LGPL-3.0-or-later',
];
/** Licences whose terms require shipping the licence text with the files. */
const NEEDS_TEXT = /^(MIT|BSD-|ISC|Zlib|Apache-|GPL-|LGPL-)/;
const ASSET_EXT = /\.(json|png|jpe?g|webp|glb|map|md|txt)$/i;
const DOC_FILE = /^(ATTRIBUTION\.md|README\.md|LICENSE(\.txt|\.md)?|COPYING(\.txt)?|CREDITS(\.txt|\.md)?)$/i;
const FORBIDDEN_EXT = /\.(wad|pak|pk3|bsp|mdl|vpk|exe|dll|js|mjs|html?|svg)$/i;

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
  environment?: { sky?: MapDef['sky']; sun?: { azimuthDeg: number; elevationDeg: number }; fog?: { color: string; density: number }; windScale?: number };
  ground?: GroundDoc;
  primitives?: PrimDoc[];
  gates?: GateDoc[];
  trees?: TreeDoc[];
  wakeZones?: WakeDoc[];
  indoor?: IndoorDoc[];
  lights?: LightDoc[];
  geometry?: GeometryDoc[];
}

export class MapFormatError extends Error {
  constructor(readonly errors: string[], readonly warnings: string[] = []) {
    super(`invalid map package:\n  - ${errors.join('\n  - ')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Structural validation

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (v: unknown) => { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 40 ? s.slice(0, 37) + '...' : s; };

class Checker {
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

/** Validate a parsed map.json. Returns the typed document or throws MapFormatError with every problem found. */
export function validateMapDoc(raw: unknown): { doc: MapDocV1; warnings: string[] } {
  const c = new Checker();
  const R = 'map.json';
  if (!c.obj(raw, R, ['format', 'formatVersion', 'meta', 'units', 'frame', 'size', 'elevationM', 'spawn', 'pilot', 'environment', 'ground', 'primitives', 'gates', 'trees', 'wakeZones', 'indoor', 'lights', 'geometry'], ['format', 'formatVersion', 'meta', 'size'])) throw new MapFormatError(c.errors);
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
  if (d.environment !== undefined && c.obj(d.environment, E, ['sky', 'sun', 'fog', 'windScale'])) {
    const e = d.environment;
    c.str(e, 'sky', E, { oneOf: ['clear', 'overcast', 'dusk', 'night'] });
    if (e.sun !== undefined && c.obj(e.sun, `${E}.sun`, ['azimuthDeg', 'elevationDeg'], ['azimuthDeg', 'elevationDeg'])) {
      c.num(e.sun, 'azimuthDeg', `${E}.sun`, { min: 0, max: 360 }); c.num(e.sun, 'elevationDeg', `${E}.sun`, { min: -10, max: 90 });
    }
    if (e.fog !== undefined && c.obj(e.fog, `${E}.fog`, ['color', 'density'], ['color', 'density'])) {
      c.str(e.fog, 'color', `${E}.fog`, { re: COLOR, hint: 'must be a colour like "#a9b0b5"' }); c.num(e.fog, 'density', `${E}.fog`, { min: 0, max: 0.1 });
    }
    c.num(e, 'windScale', E, { min: 0, max: 2 });
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
  c.arr(d, 'gates', R, BUDGETS.gates, (g, P) => {
    if (!c.obj(g, P, ['kind', 'pos', 'yawDeg', 'width', 'height', 'stack', 'onTop'], ['kind', 'pos'])) return;
    const kind = c.str(g, 'kind', P, { oneOf: GATE_KINDS });
    const pos = c.vec(g, 'pos', P, [2, 3]);
    if (kind === 'dive' && pos && pos.length !== 3) c.err(`${P}.pos`, 'a dive gate needs [x, y, z]: z is the height of its frame');
    c.num(g, 'yawDeg', P); c.num(g, 'width', P, { gt: 0, max: 20 }); c.num(g, 'height', P, { gt: 0, max: 20 });
    c.num(g, 'stack', P, { min: 1, max: 6 }); c.bool(g, 'onTop', P);
  });
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
// Asset decoding

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

/** Triangles (ENU metres, before placement) of a binary glTF 2.0 file, its drawn triangle count and its embedded images. */
export function glbTriangles(b: Uint8Array): { positions: Float64Array; triangles: number; images: Uint8Array[] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a binary glTF (.glb) file');
  if (dv.getUint32(4, true) !== 2) throw new Error(`glTF version ${dv.getUint32(4, true)} is not supported (need 2.0)`);
  let json: any = null, bin: Uint8Array | null = null;
  for (let o = 12; o + 8 <= Math.min(b.length, dv.getUint32(8, true));) {
    const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(b.subarray(o + 8, o + 8 + len)));
    else if (type === 0x004e4942 && !bin) bin = b.subarray(o + 8, o + 8 + len);
    o += 8 + len;
  }
  if (!json) throw new Error('.glb has no JSON chunk');
  const okExt = /^KHR_(materials_|texture_transform|mesh_quantization$)/;
  const bad = (json.extensionsRequired ?? []).filter((e: string) => !okExt.test(e));
  if (bad.length) throw new Error(`required glTF extensions are not supported: ${bad.join(', ')} (no Draco / meshopt / KTX2; export uncompressed)`);
  for (const buf of json.buffers ?? []) if (buf.uri !== undefined) throw new Error('.glb must embed its buffers (external or data: URIs are not supported)');
  for (const img of json.images ?? []) if (img.uri !== undefined) throw new Error('.glb must embed its images in the binary chunk');
  const COMP: Record<number, [number, (o: number) => number]> = {
    5120: [1, (o) => dv.getInt8(o)], 5121: [1, (o) => dv.getUint8(o)], 5122: [2, (o) => dv.getInt16(o, true)],
    5123: [2, (o) => dv.getUint16(o, true)], 5125: [4, (o) => dv.getUint32(o, true)], 5126: [4, (o) => dv.getFloat32(o, true)],
  };
  const NUM: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const accessor = (i: number): number[] => {
    const a = json.accessors?.[i];
    if (!a) throw new Error(`glTF accessor ${i} missing`);
    if (a.sparse) throw new Error('sparse glTF accessors are not supported');
    const [size, get] = COMP[a.componentType] ?? []; const n = NUM[a.type];
    if (!get || !n) throw new Error(`glTF accessor ${i}: unsupported type`);
    if (a.bufferView === undefined) return new Array(a.count * n).fill(0);
    const bv = json.bufferViews[a.bufferView];
    if (!bin || bv.buffer !== 0) throw new Error('glTF buffer view outside the .glb binary chunk');
    const stride = bv.byteStride ?? size * n, out: number[] = new Array(a.count * n);
    const off0 = bin.byteOffset - b.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    if (off0 + stride * (a.count - 1) + size * n > bin.byteOffset - b.byteOffset + bin.length) throw new Error(`glTF accessor ${i} runs past the binary chunk`);
    const norm = a.normalized ? ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 } as Record<number, number>)[a.componentType] ?? 1 : 1;
    for (let e = 0; e < a.count; e++) for (let k = 0; k < n; k++) out[e * n + k] = get(off0 + e * stride + k * size) / norm;
    return out;
  };
  const mul = (a: number[], m: number[]) => { const r = new Array(16).fill(0); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) r[j * 4 + i] += a[k * 4 + i] * m[j * 4 + k]; return r; };
  const local = (n: any): number[] => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
  };
  const pos: number[] = [];
  let triangles = 0;
  const visit = (ni: number, parent: number[], depth: number) => {
    const n = json.nodes?.[ni];
    if (!n || depth > 64) return;
    const m = mul(parent, local(n));
    if (n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives ?? []) {
      if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) continue;
      const v = accessor(p.attributes.POSITION);
      const idx = p.indices !== undefined ? accessor(p.indices) : [...Array(v.length / 3).keys()];
      triangles += Math.floor(idx.length / 3);
      for (const i of idx) {
        const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
        const gx = m[0] * x + m[4] * y + m[8] * z + m[12], gy = m[1] * x + m[5] * y + m[9] * z + m[13], gz = m[2] * x + m[6] * y + m[10] * z + m[14];
        pos.push(gx, -gz, gy); // glTF (+X right, +Y up, +Z toward the viewer) -> ENU: x = east, y = north = -Z, z = up = +Y
      }
    }
    for (const c of n.children ?? []) visit(c, m, depth + 1);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  for (const ni of scene?.nodes ?? []) visit(ni, I, 0);
  const images: Uint8Array[] = [];
  for (const img of json.images ?? []) {
    const bv = json.bufferViews?.[img.bufferView];
    if (bin && bv) images.push(bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
  }
  return { positions: new Float64Array(pos), triangles, images };
}

const SLAB_T = 0.05; // mesh collision: each triangle is a solid slab this thick behind its front face (m)

/** One triangle as a thin convex brush (front face, back face, three edge planes): exact sphere / ray collision. */
export function triangleBrush(a: number[], b: number[], c: number[], mat: Material, tag?: string): BrushPrim | null {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l < 1e-8) return null; // degenerate
  n = n.map((x) => x / l);
  const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const back = [a, b, c].map((p) => p.map((x, k) => x - n[k] * SLAB_T));
  const planes = [n[0], n[1], n[2], dot(n, a), -n[0], -n[1], -n[2], -dot(n, back[0])];
  const tri = [a, b, c];
  for (let i = 0; i < 3; i++) {
    const p = tri[i], q = tri[(i + 1) % 3], e = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    let m = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]]; // outward for CCW seen from n
    const ml = Math.hypot(m[0], m[1], m[2]);
    m = m.map((x) => x / ml);
    planes.push(m[0], m[1], m[2], dot(m, p));
  }
  const edges: number[] = [];
  for (let i = 0; i < 3; i++) { const j = (i + 1) % 3; edges.push(...tri[i], ...tri[j], ...back[i], ...back[j], ...tri[i], ...back[i]); }
  const all = [...tri, ...back];
  const min = { x: Math.min(...all.map((p) => p[0])), y: Math.min(...all.map((p) => p[1])), z: Math.min(...all.map((p) => p[2])) };
  const max = { x: Math.max(...all.map((p) => p[0])), y: Math.max(...all.map((p) => p[1])), z: Math.max(...all.map((p) => p[2])) };
  return { kind: 'brush', c: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }, planes: new Float64Array(planes), edges: new Float64Array(edges), min, max, mat, tag };
}

// ---------------------------------------------------------------------------------------------
// Terrain

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Height function for a ground spec (heightfield already decoded). Shared by worker and renderer. */
export function makeTerrain(g: GroundDoc | undefined, hf?: { w: number; h: number; data: Float32Array }): (x: number, y: number) => number {
  if (!g) return () => 0;
  if (g.type === 'flat') { const z = g.z ?? 0; return () => z; }
  if (g.type === 'heightfield') {
    const { w, h, data } = hf!, [ex, ey] = g.extent, [cx, cy] = g.center ?? [0, 0], z0 = g.zMin, dz = g.zMax - g.zMin;
    const x0 = cx - ex / 2, y1 = cy + ey / 2;
    return (x, y) => {
      // pixel (0, 0) is the north-west corner; columns run east, rows run south; edges clamp
      const u = Math.min(w - 1, Math.max(0, ((x - x0) / ex) * (w - 1))), v = Math.min(h - 1, Math.max(0, ((y1 - y) / ey) * (h - 1)));
      const i = Math.min(w - 2, Math.floor(u)), j = Math.min(h - 2, Math.floor(v)), fu = u - i, fv = v - j;
      const a = data[j * w + i], b = data[j * w + i + 1], c = data[(j + 1) * w + i], d = data[(j + 1) * w + i + 1];
      return z0 + dz * (a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv);
    };
  }
  const base = g.base ?? 0;
  const layers = g.layers.map((l) => {
    const oct = l.octaves ?? 4, seed = l.seed ?? 1, s = l.scale, amp = l.amplitude, mk = l.mask;
    if (!mk) return (x: number, y: number) => fbm(x / s, y / s, oct, seed) * amp;
    const [mx, my] = mk.center ?? [0, 0], span = mk.to - mk.from, inv = !!mk.invert, sq = mk.shape === 'square';
    return (x: number, y: number) => {
      const r = sq ? Math.max(Math.abs(x - mx), Math.abs(y - my)) : Math.hypot(x - mx, y - my);
      const m = clamp01((r - mk.from) / span);
      return (inv ? 1 - m : m) * fbm(x / s, y / s, oct, seed) * amp;
    };
  });
  return (x, y) => { let z = base; for (const f of layers) z += f(x, y); return z; };
}

// ---------------------------------------------------------------------------------------------
// Package loading

export interface PackageSource {
  /** Read a package file by its relative path (rejects when it does not exist). */
  read(path: string): Promise<Uint8Array>;
  /** A URL the renderer can load the file from (textures, meshes). */
  url(path: string): string;
  /** Every file in the package with its size, when the source can list them (validation, budgets). */
  list?(): Promise<{ path: string; size: number }[]>;
}

export interface LoadOptions {
  /** Repository rules: ATTRIBUTION.md + licence text required, meta.id must equal this folder name. */
  strict?: boolean;
  folderId?: string;
  /** Also open every texture / preview to check its format and size (validator, local loading). */
  checkAssets?: boolean;
}

export interface MapStats { primitives: number; gates: number; trees: number; brushes: number; meshTriangles: number; collisionTriangles: number; bytes?: number }

export interface LoadedMap {
  doc: MapDocV1;
  warnings: string[];
  stats: MapStats;
  /** Build a fresh MapDef (synchronous; same result every call). */
  build(id?: string): MapDef;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const hex = (s: string | undefined) => (s === undefined ? undefined : parseInt(s.slice(1), 16));
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const deg = Math.PI / 180;

/** Read, validate and decode a map package. Throws MapFormatError listing every problem. */
export async function loadMapPackage(src: PackageSource, opts: LoadOptions = {}): Promise<LoadedMap> {
  const errors: string[] = [], warnings: string[] = [];
  const files = src.list ? await src.list() : null;
  const has = (p: string) => !files || files.some((f) => f.path === p);
  const tryRead = async (p: string, what: string): Promise<Uint8Array | null> => {
    if (!has(p)) { errors.push(`${what}: file "${p}" is not in the package`); return null; }
    try { return await src.read(p); } catch (e) { errors.push(`${what}: cannot read "${p}" (${(e as Error).message ?? e})`); return null; }
  };

  // ---- files and budgets ----
  if (files) {
    let total = 0;
    for (const f of files) {
      total += f.size;
      const e = assetPathError(f.path);
      if (e) errors.push(`file "${f.path}": name ${e}`);
      else if (FORBIDDEN_EXT.test(f.path)) errors.push(`file "${f.path}": this file type is not allowed in map packages (no game archives, executables or scripts)`);
      else if (!ASSET_EXT.test(f.path)) errors.push(`file "${f.path}": unsupported file type (allowed: .json .png .jpg .webp .glb .map .md .txt)`);
      if (f.size > BUDGETS.fileBytes) errors.push(`file "${f.path}": ${(f.size / 1048576).toFixed(1)} MiB exceeds the per-file budget of ${BUDGETS.fileBytes / 1048576} MiB`);
    }
    if (total > BUDGETS.packageBytes) errors.push(`package is ${(total / 1048576).toFixed(1)} MiB; the budget is ${BUDGETS.packageBytes / 1048576} MiB`);
    const mj = files.find((f) => f.path === 'map.json');
    if (mj && mj.size > BUDGETS.mapJsonBytes) errors.push(`map.json is ${(mj.size / 1024).toFixed(0)} KiB; the budget is ${BUDGETS.mapJsonBytes / 1024} KiB`);
  }

  const mapBytes = await tryRead('map.json', 'package');
  if (!mapBytes) throw new MapFormatError(errors);
  let raw: unknown;
  try { raw = JSON.parse(text(mapBytes)); } catch (e) { throw new MapFormatError([...errors, `map.json: not valid JSON (${(e as Error).message})`]); }
  let doc: MapDocV1;
  try { ({ doc } = validateMapDoc(raw)); } catch (e) { if (e instanceof MapFormatError) throw new MapFormatError([...errors, ...e.errors], e.warnings); throw e; }

  // ---- licence files ----
  if (opts.folderId !== undefined && doc.meta.id !== opts.folderId) errors.push(`map.json.meta.id: "${doc.meta.id}" must equal the package folder name "${opts.folderId}"`);
  if (files) {
    const names = files.map((f) => f.path);
    const need = opts.strict ? errors : warnings;
    if (!names.includes('ATTRIBUTION.md')) need.push('ATTRIBUTION.md is missing: state who made the map and every asset in it, their sources and licences');
    if (NEEDS_TEXT.test(doc.meta.license.replace(/[()]/g, '')) && !names.some((n) => /^(LICENSE|COPYING)(\.txt|\.md)?$/i.test(n)))
      need.push(`${doc.meta.license} requires its full licence text: add LICENSE.txt to the package`);
  }

  // ---- referenced assets ----
  const referenced = new Set(['map.json']);
  const images: [string, string, number, number][] = []; // path, what, max px, max bytes
  if (doc.meta.preview) { referenced.add(doc.meta.preview); images.push([doc.meta.preview, 'map.json.meta.preview', 4096, BUDGETS.previewBytes]); }
  if (doc.ground?.texture) { referenced.add(doc.ground.texture); images.push([doc.ground.texture, 'map.json.ground.texture', BUDGETS.texturePx, BUDGETS.textureBytes]); }
  (doc.primitives ?? []).forEach((p, i) => { if (p.type === 'box' && p.texture && !referenced.has(p.texture)) { referenced.add(p.texture); images.push([p.texture, `map.json.primitives[${i}].texture`, BUDGETS.texturePx, BUDGETS.textureBytes]); } });

  let hf: { w: number; h: number; data: Float32Array } | undefined;
  if (doc.ground?.type === 'heightfield') {
    const g = doc.ground;
    referenced.add(g.image);
    const b = await tryRead(g.image, 'map.json.ground.image');
    if (b) {
      const sz = imageSize(b);
      if (!sz || sz.type !== 'png') errors.push(`map.json.ground.image: "${g.image}" is not a PNG file`);
      else if (sz.w > BUDGETS.heightfieldPx || sz.h > BUDGETS.heightfieldPx || sz.w < 2 || sz.h < 2) errors.push(`map.json.ground.image: ${sz.w}x${sz.h} px; heightfields must be 2..${BUDGETS.heightfieldPx} px per side`);
      else try { hf = await decodePngChannel(b); } catch (e) { errors.push(`map.json.ground.image: ${(e as Error).message}`); }
    }
  }

  let baseDef: ((id: string) => MapDef) | null = null;
  const meshes: { inst: MeshInstance; brushes: BrushPrim[]; box?: BoxPrim }[] = [];
  let meshTriangles = 0, collisionTriangles = 0;
  for (const [gi, g] of (doc.geometry ?? []).entries()) {
    const P = `map.json.geometry[${gi}]`;
    referenced.add(g.src);
    const b = await tryRead(g.src, `${P}.src`);
    if (!b) continue;
    if (g.type === 'quake') {
      const srcText = text(b);
      let tex: Record<string, { file: string; w: number; h: number }> | undefined, texDir = '';
      if (g.textures && g.textures !== 'builtin:librequake') {
        referenced.add(g.textures); texDir = dirOf(g.textures);
        const t = await tryRead(g.textures, `${P}.textures`);
        if (t) try { tex = JSON.parse(text(t)); for (const v of Object.values(tex!)) referenced.add(texDir + v.file); } catch (e) { errors.push(`${P}.textures: not valid JSON (${(e as Error).message})`); }
      }
      baseDef = (id) => {
        const m = quakeMapDef(srcText, { id, name: doc.meta.name, scale: g.scale, ambient: g.ambient ?? 40, spawnClass: g.spawnClass });
        if (tex) { m.quake!.textures = tex; m.quake!.textureUrl = (f) => src.url(texDir + f); }
        return m;
      };
    } else if (g.type === 'doom') {
      const srcText = text(b);
      referenced.add(g.textures);
      const texDir = dirOf(g.textures);
      const t = await tryRead(g.textures, `${P}.textures`);
      if (t) try {
        const tex = JSON.parse(text(t)) as Record<string, { file: string; w: number; h: number }>;
        for (const v of Object.values(tex)) referenced.add(texDir + v.file);
        baseDef = (id) => {
          const m = doomMapDef(srcText, { id, name: doc.meta.name, scale: g.scale, textures: tex, textureBase: '' });
          m.quake!.textureUrl = (f) => src.url(texDir + f);
          return m;
        };
      } catch (e) { errors.push(`${P}.textures: not valid JSON (${(e as Error).message})`); }
    } else {
      let tri: ReturnType<typeof glbTriangles>;
      try { tri = glbTriangles(b); } catch (e) { errors.push(`${P}.src: ${(e as Error).message}`); continue; }
      meshTriangles += tri.triangles;
      if (opts.checkAssets) tri.images.forEach((im, k) => {
        const sz = imageSize(im), what = `${P}.src: "${g.src}" image ${k}`;
        if (!sz) errors.push(`${what} is not PNG, JPEG or WebP (KTX2 / Basis are not supported)`);
        else if (sz.w > BUDGETS.texturePx || sz.h > BUDGETS.texturePx) errors.push(`${what} is ${sz.w}x${sz.h} px; the budget is ${BUDGETS.texturePx}x${BUDGETS.texturePx}`);
        if (im.length > BUDGETS.textureBytes) errors.push(`${what} is ${(im.length / 1024).toFixed(0)} KiB; the budget is ${BUDGETS.textureBytes / 1024} KiB`);
      });
      const s = g.scale ?? 1, yaw = (g.yawDeg ?? 0) * deg, [px, py, pz] = g.pos ?? [0, 0, 0], co = Math.cos(yaw), si = Math.sin(yaw);
      const P3 = tri.positions, place = (i: number) => { const x = P3[i] * s, y = P3[i + 1] * s; return [px + co * x - si * y, py + si * x + co * y, pz + P3[i + 2] * s]; };
      const entry: (typeof meshes)[number] = { inst: { url: src.url(g.src), pos: { x: px, y: py, z: pz }, yaw, scale: s }, brushes: [] };
      const mat = g.material ?? 'concrete', coll = g.collision ?? 'mesh';
      if (coll === 'mesh') {
        collisionTriangles += tri.triangles;
        for (let i = 0; i + 8 < P3.length; i += 9) { const br = triangleBrush(place(i), place(i + 3), place(i + 6), mat, `mesh${gi}`); if (br) entry.brushes.push(br); }
      } else if (coll === 'box' && P3.length) {
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < P3.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P3[i + k] * s); hi[k] = Math.max(hi[k], P3[i + k] * s); }
        const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
        entry.box = { kind: 'box', c: { x: px + co * cx - si * cy, y: py + si * cx + co * cy, z: pz + (lo[2] + hi[2]) / 2 }, half: { x: (hi[0] - lo[0]) / 2, y: (hi[1] - lo[1]) / 2, z: (hi[2] - lo[2]) / 2 }, yaw, mat, tag: `mesh${gi}` };
      }
      meshes.push(entry);
    }
  }
  if (meshTriangles > BUDGETS.meshTriangles) errors.push(`glTF meshes have ${meshTriangles} triangles; the budget is ${BUDGETS.meshTriangles}`);
  if (collisionTriangles > BUDGETS.collisionTriangles) errors.push(`glTF meshes with collision "mesh" have ${collisionTriangles} triangles; the budget is ${BUDGETS.collisionTriangles} (use collision "box" or "none", or a simpler collision mesh)`);

  if (opts.checkAssets) for (const [p, what, px, bytes] of images) {
    const b = await tryRead(p, what);
    if (!b) continue;
    const sz = imageSize(b);
    if (!sz) errors.push(`${what}: "${p}" is not a PNG, JPEG or WebP image`);
    else if (sz.w > px || sz.h > px) errors.push(`${what}: "${p}" is ${sz.w}x${sz.h} px; the budget is ${px}x${px}`);
    if (b.length > bytes) errors.push(`${what}: "${p}" is ${(b.length / 1024).toFixed(0)} KiB; the budget is ${bytes / 1024} KiB`);
  } else for (const [p, what] of images) if (!has(p)) errors.push(`${what}: file "${p}" is not in the package`);

  if (files) for (const f of files) if (!referenced.has(f.path) && !DOC_FILE.test(f.path)) warnings.push(`file "${f.path}" is not referenced by map.json (remove it, or it ships for nothing)`);

  // ---- build once now: catches errors in external sources and counts the result against the budgets ----
  const build = (id = doc.meta.id): MapDef => {
    const base = baseDef?.(id) ?? null;
    const terrain = doc.ground ? makeTerrain(doc.ground, hf) : base ? base.terrain : makeTerrain(undefined);
    const prims: Prim[] = base ? [...base.prims] : [];
    const gates: GateDef[] = (doc.gates ?? []).map((g, i) => {
      const [w, h] = GATE_SIZE[g.kind];
      return { id: i, kind: g.kind, c: { x: g.pos[0], y: g.pos[1], z: g.pos[2] ?? terrain(g.pos[0], g.pos[1]) }, yaw: (g.yawDeg ?? 0) * deg, width: g.width ?? w, height: g.height ?? h, ...(g.stack != null ? { stack: g.stack } : {}), ...(g.onTop ? { onTop: true } : {}) };
    });
    buildGatePrims(gates, prims);
    for (const p of doc.primitives ?? []) {
      const c: V3 = { x: p.pos[0], y: p.pos[1], z: p.pos[2] }, mat: Material = p.material ?? 'concrete';
      const extra = { ...(p.color !== undefined && { color: hex(p.color) }), ...(p.tag !== undefined && { tag: p.tag }) };
      if (p.type === 'box') prims.push({ kind: 'box', c, half: { x: p.size[0] / 2, y: p.size[1] / 2, z: p.size[2] / 2 }, yaw: (p.yawDeg ?? 0) * deg, ...(p.pitchDeg && { pitch: p.pitchDeg * deg }), mat, visual: p.visual ?? (p.texture ? 'plain' : 'concrete'), ...extra, ...(p.texture && { texture: src.url(p.texture) }), ...(p.text && { text: p.text }) });
      else if (p.type === 'cylinder') prims.push({ kind: 'cyl', c, r: p.radius, h: p.height, mat: p.material ?? 'metal', ...extra });
      else prims.push({ kind: 'sphere', c, r: p.radius, mat, ...extra });
    }
    for (const m of meshes) { prims.push(...m.brushes); if (m.box) prims.push({ ...m.box, c: { ...m.box.c }, half: { ...m.box.half } }); }
    const env = doc.environment ?? {};
    const wakeZones: WakeZone[] = (doc.wakeZones ?? []).map((w) => ({ x: w.pos[0], y: w.pos[1], radius: w.radius, height: w.height, intensity: w.intensity }));
    const def: MapDef = {
      id, name: doc.meta.name, size: doc.size, terrain,
      groundMat: doc.ground?.material ?? base?.groundMat ?? 'grass', prims, gates,
      spawn: doc.spawn ? { pos: { x: doc.spawn.pos[0], y: doc.spawn.pos[1], z: doc.spawn.pos[2] }, yaw: (doc.spawn.yawDeg ?? 0) * deg, ...(doc.spawn.groundZ !== undefined && { groundZ: doc.spawn.groundZ }) } : base!.spawn,
      sun: env.sun ? { ...env.sun } : base?.sun ?? { azimuthDeg: 200, elevationDeg: 45 },
      sky: env.sky ?? base?.sky ?? 'clear',
      wakeZones: [...(base?.wakeZones ?? []), ...wakeZones],
      elevationM: doc.elevationM ?? base?.elevationM ?? 0,
      trees: (doc.trees ?? []).map((t) => ({ x: t.pos[0], y: t.pos[1], h: t.height, r: t.radius, type: t.type })),
    };
    const indoor: WindVolume[] = [...(base?.indoor ?? []), ...(doc.indoor ?? []).map((v) => ({ min: { x: v.min[0], y: v.min[1], z: v.min[2] }, max: { x: v.max[0], y: v.max[1], z: v.max[2] }, scale: v.windScale ?? 0.1 }))];
    if (indoor.length) def.indoor = indoor;
    const ground = doc.ground ? doc.ground.visible : base?.ground;
    if (ground !== undefined) def.ground = ground;
    const pilot = doc.pilot ? { x: doc.pilot[0], y: doc.pilot[1], z: doc.pilot[2] } : doc.spawn ? undefined : base?.pilot;
    if (pilot) def.pilot = pilot;
    const windScale = env.windScale ?? base?.windScale;
    if (windScale !== undefined) def.windScale = windScale;
    if (base?.quake) def.quake = base.quake;
    if (env.fog) def.fog = { color: hex(env.fog.color)!, density: env.fog.density };
    if (doc.lights?.length) def.lights = doc.lights.map((l) => ({ pos: { x: l.pos[0], y: l.pos[1], z: l.pos[2] }, color: hex(l.color) ?? 0xffffff, intensity: l.intensity, range: l.range }));
    if (doc.ground?.texture) def.groundTexture = src.url(doc.ground.texture);
    if (meshes.length) def.meshes = meshes.map((m) => ({ ...m.inst, pos: { ...m.inst.pos } }));
    return def;
  };

  let stats: MapStats = { primitives: 0, gates: 0, trees: 0, brushes: 0, meshTriangles, collisionTriangles, bytes: files?.reduce((s, f) => s + f.size, 0) };
  if (!errors.length) {
    try {
      const m = build();
      const brushes = m.prims.filter((p) => p.kind === 'brush').length;
      stats = { ...stats, primitives: m.prims.length - brushes, gates: m.gates.length, trees: m.trees.length, brushes };
      if (stats.primitives > BUDGETS.primitives) errors.push(`map has ${stats.primitives} primitives including generated gate parts; the budget is ${BUDGETS.primitives}`);
      if (brushes > BUDGETS.brushes) errors.push(`map has ${brushes} convex brushes (Quake / Doom geometry and mesh collision); the budget is ${BUDGETS.brushes}`);
      const sp = m.spawn.pos;
      if (Math.abs(sp.x) > m.size || Math.abs(sp.y) > m.size) warnings.push(`spawn (${sp.x}, ${sp.y}) is outside the playable area (size ${m.size} m)`);
    } catch (e) { errors.push(`map does not build: ${(e as Error).message ?? e}`); }
  }
  if (errors.length) throw new MapFormatError(errors, warnings);
  return { doc, warnings, stats, build };
}

// ---------------------------------------------------------------------------------------------
// Registry adapters (used by maps.ts; no module-level state touched here, see the note at the top)

/** Source for a package served over HTTP under `baseUrl` (ends with "/"). */
export function httpSource(baseUrl: string): PackageSource {
  return {
    url: (p) => baseUrl + p,
    async read(p) {
      const r = await fetch(baseUrl + p);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

/** Source for a package held as a path -> URL table (blob: URLs of a package loaded from disk). */
export function urlTableSource(urls: Record<string, string>): PackageSource {
  return {
    url: (p) => urls[p] ?? '',
    async read(p) {
      if (!urls[p]) throw new Error('no such file');
      return new Uint8Array(await (await fetch(urls[p])).arrayBuffer());
    },
  };
}

/** A map-registry entry for a package. */
export function packageEntry(id: string, info: { name: string; author: string; license: string; local?: boolean }, src: () => PackageSource): MapEntry {
  return {
    name: info.name,
    credit: `${info.local ? 'Loaded from disk' : 'Community map'} by ${info.author} (${info.license})`,
    community: { author: info.author, license: info.license, local: !!info.local },
    build: () => { throw new Error(`map ${id} not loaded: await preloadMap('${id}') first`); },
    prepare: async () => { const m = await loadMapPackage(src()); return () => m.build(id); },
  };
}
