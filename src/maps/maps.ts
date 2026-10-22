// The launch maps: a Grand Prix stadium race course and an abandoned industrial
// "bando" for freestyle (procedural but deterministic), plus classic id Software Quake levels built
// from their GPL'd .map sources (see public/maps/quake/ATTRIBUTION.md), and a Freedoom level
// (BSD-3-Clause; see public/maps/freedoom/ATTRIBUTION.md).
import communityIndex from '../../public/maps/community/index.json';
import freedoomTextures from '../../public/maps/freedoom/textures/manifest.json';
import { doomMapDef } from './doomMap';
import type { PackageSource } from './mapFormat';
import { quakeMapDef } from './quakeMap';
import { BoxPrim, fbm, MapDef, Prim, seededRandom } from './world';
import { worldCupMap } from './worldCup';
import { gymMap, mountainMap, nightMap, parkMap, practiceMap, TRAINING_CREDIT } from './training';

// Map packages (mapFormat.ts): the loader and its decoders are fetched the first time a package map
// is loaded, not at startup. Same signatures as mapFormat's packageEntry / httpSource.
type MapFormatModule = typeof import('./mapFormat');
let mapFormatModule: Promise<MapFormatModule> | undefined;
function httpSource(baseUrl: string): (mf: MapFormatModule) => PackageSource { return (mf) => mf.httpSource(baseUrl); }
function packageEntry(id: string, info: { name: string; author: string; license: string }, src: () => (mf: MapFormatModule) => PackageSource): MapEntry {
  return {
    name: info.name,
    credit: `Community map by ${info.author} (${info.license})`, // as mapFormat.packageEntry
    community: { author: info.author, license: info.license, local: false },
    build: () => { throw new Error(`map ${id} not loaded: await preloadMap('${id}') first`); },
    prepare: async () => {
      // (a failed chunk fetch is not cached: the next attempt retries)
      const mf = await (mapFormatModule ??= import('./mapFormat').catch((e) => { mapFormatModule = undefined; throw e; }));
      return mf.packageEntry(id, info, () => src()(mf)).prepare!();
    },
  };
}

const deg = Math.PI / 180;

// Gate builders live in ./gates (shared with the worker's pass detection); the race course map is
// the Grand Prix stadium in ./worldCup (id 'field' so saved settings keep pointing at it).
// The training maps (whoop gym, park, practice field, mountains, night course) are in ./training.
export { buildGatePrims } from './gates';
export const fieldMap = worldCupMap;

// ---------------------------------------------------------------------------------------------

export function bandoMap(): MapDef {
  const rnd = seededRandom(4242);
  const terrain = (x: number, y: number) => {
    const r = Math.max(Math.abs(x), Math.abs(y));
    const outer = Math.min(1, Math.max(0, (r - 80) / 60));
    return (outer > 0 ? outer * fbm(x / 60, y / 60, 3, 2) * 6 : 0) + fbm(x / 8, y / 8, 2, 7) * 0.04; // (no hill noise inside the yard)
  };
  const prims: Prim[] = [];
  const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0, visual: BoxPrim['visual'] = 'concrete', mat: BoxPrim['mat'] = 'concrete', tag?: string) =>
    prims.push({ kind: 'box', c: { x, y, z }, half: { x: hx, y: hy, z: hz }, yaw, mat, visual, tag });

  // --- main building: 3 storeys, 36 x 22 m, 4 m floor height, columns on a 6 m grid ---
  const BX = 0, BY = 20, W = 18, D = 11, FH = 4, FLOORS = 3, T = 0.25;
  for (let f = 0; f <= FLOORS; f++) {
    const z = f * FH;
    if (f > 0) {
      // floor slab with holes (broken floors to dive through)
      const holes = f === 1 ? [[-9, 3], [6, -4]] : f === 2 ? [[0, 0], [12, 4]] : [[-12, -3], [9, 2]];
      for (let ix = -W; ix < W; ix += 3) for (let iy = -D; iy < D; iy += 3) {
        if (holes.some(([hx, hy]) => Math.abs(ix + 1.5 - hx) < 2.5 && Math.abs(iy + 1.5 - hy) < 2)) continue;
        box(BX + ix + 1.5, BY + iy + 1.5, z, 1.5, 1.5, T / 2);
      }
    }
    if (f === FLOORS) break;
    // columns
    for (let ix = -W + 3; ix <= W - 3; ix += 6) for (let iy = -D + 2.75; iy <= D - 2.75; iy += 5.5) box(BX + ix, BY + iy, z + FH / 2, 0.3, 0.3, FH / 2);
    // facade walls with window openings (window = gap between wall segments)
    for (const side of [-1, 1]) {
      for (let ix = -W; ix < W; ix += 4) {
        const cx = BX + ix + 2;
        const doorway = f === 0 && side === -1 && (ix === -2 || ix === 10);       // big ground-floor openings
        if (!doorway) box(cx, BY + side * D, z + 0.6, 2, T / 2, 0.6, 0, 'brick'); // sill wall
        box(cx, BY + side * D, z + FH - 0.5, 2, T / 2, 0.5, 0, 'brick');          // lintel
        box(cx - 1.65, BY + side * D, z + FH / 2, 0.35, T / 2, FH / 2, 0, 'brick'); // pier
      }
      for (let iy = -D; iy < D; iy += 5.5) {
        const cy = BY + iy + 2.75;
        box(BX + side * W, cy, z + 0.6, T / 2, 2.75, 0.6, 0, 'brick');
        box(BX + side * W, cy, z + FH - 0.5, T / 2, 2.75, 0.5, 0, 'brick');
        box(BX + side * W, cy - 2.3, z + FH / 2, T / 2, 0.45, FH / 2, 0, 'brick');
      }
    }
  }
  // stairwell + roof parapet + rooftop structures
  for (let s = 0; s < 12; s++) box(BX + W - 2.5, BY - D + 1 + s * 0.35, (s + 1) * 0.33, 1.2, 0.18, 0.17, 0, 'concrete');
  const roofZ = FLOORS * FH;
  box(BX, BY - D, roofZ + 0.5, W, 0.12, 0.5); box(BX, BY + D, roofZ + 0.5, W, 0.12, 0.5);
  box(BX - W, BY, roofZ + 0.5, 0.12, D, 0.5); box(BX + W, BY, roofZ + 0.5, 0.12, D, 0.5);
  box(BX - 8, BY + 4, roofZ + 1.4, 2, 2, 1.4, 0, 'metal', 'metal');   // AC unit / lift housing
  box(BX + 10, BY - 5, roofZ + 2, 1.2, 1.2, 2, 0, 'brick');            // chimney stack
  // --- secondary low warehouse with open roof trusses ---
  const WX = -38, WY = -6;
  for (const side of [-1, 1]) box(WX, WY + side * 8, 3, 12, 0.2, 3, 0, 'metal', 'metal');
  box(WX - 12, WY, 3, 0.2, 8, 3, 0, 'metal', 'metal');
  box(WX + 12, WY - 5, 3, 0.2, 3, 3, 0, 'metal', 'metal'); box(WX + 12, WY + 5, 3, 0.2, 3, 3, 0, 'metal', 'metal');
  for (let i = -10; i <= 10; i += 4) box(WX + i, WY, 6.1, 0.12, 8, 0.12, 0, 'metal', 'metal'); // trusses (gaps between)
  // --- water tower: classic power-loop target ---
  for (const [dx, dy] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) prims.push({ kind: 'cyl', c: { x: 40 + dx, y: -20 + dy, z: 0 }, r: 0.25, h: 14, mat: 'metal' });
  prims.push({ kind: 'cyl', c: { x: 40, y: -20, z: 14 }, r: 3.2, h: 4.5, mat: 'metal', color: 0x8a8f94, tag: 'tank' });
  // --- debris: containers, pallets, a burnt car ---
  for (let i = 0; i < 6; i++) box(-10 + i * 2.6, -22, 1.3, 1.22, 3.05, 1.3, 0.04 * i, 'metal', 'metal', `container${i}`);
  box(-6, -22, 3.9, 1.22, 3.05, 1.3, 0.1, 'metal', 'metal', 'container-top');
  for (let i = 0; i < 18; i++) { const x = (rnd() - 0.5) * 120, y = (rnd() - 0.5) * 100; if (Math.abs(x - BX) < W + 4 && Math.abs(y - BY) < D + 4) continue; box(x, y, 0.1, 0.6, 0.5, 0.1, rnd() * 3, 'wood', 'wood', 'pallet'); }
  box(22, 8, 0.7, 2.2, 0.9, 0.7, 0.4, 'metal', 'metal', 'car');
  // perimeter fence posts
  for (let i = -60; i <= 60; i += 5) { prims.push({ kind: 'cyl', c: { x: i, y: -50, z: 0 }, r: 0.04, h: 2.2, mat: 'metal' }); prims.push({ kind: 'cyl', c: { x: i, y: 70, z: 0 }, r: 0.04, h: 2.2, mat: 'metal' }); }
  const trees: MapDef['trees'] = [];
  for (let i = 0; i < 140; i++) { const a = rnd() * Math.PI * 2, r = 90 + rnd() * 100; trees.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, h: 7 + rnd() * 10, r: 2 + rnd() * 2, type: rnd() < 0.3 ? 'pine' : 'oak' }); }
  for (const [x, y] of [[-20, 45], [30, 40], [55, 5]]) trees.push({ x, y, h: 10 + rnd() * 5, r: 3, type: 'oak' });
  return {
    id: 'bando', name: 'Bando — Abandoned Industrial', size: 160, terrain, groundMat: 'dirt', prims, gates: [],
    spawn: { pos: { x: 0, y: -8, z: 0.25 }, yaw: 90 * deg }, sun: { azimuthDeg: 135, elevationDeg: 24 }, sky: 'overcast',
    // wake zones = obstacle footprints (the wake is laid out downwind for the live wind direction)
    wakeZones: [
      { x: BX, y: BY, radius: 14, height: roofZ, intensity: 1.5 },
      { x: WX, y: WY, radius: 10, height: 6.2, intensity: 1.0 },
    ],
    // inside the main building the wind is all but gone (open windows); the warehouse has no roof
    indoor: [
      { min: { x: BX - W, y: BY - D, z: 0 }, max: { x: BX + W, y: BY + D, z: roofZ }, scale: 0.1 },
      { min: { x: WX - 12, y: WY - 8, z: 0 }, max: { x: WX + 12, y: WY + 8, z: 6 }, scale: 0.35 },
    ],
    elevationM: 40, trees,
  };
}

// ---------------------------------------------------------------------------------------------
// Registry. Maps with a `source` are data files under public/ that must be fetched (preloadMap)
// before build() can run synchronously; both the worker and the renderer do this.

export interface MapEntry {
  name: string;
  credit: string;                         // source + license, shown in the map selector and README
  source?: string;                        // file under public/ (fetched by preloadMap)
  build: (src?: string) => MapDef;
  /** Map packages (mapFormat.ts): async load + validate, then a synchronous builder. */
  prepare?: () => Promise<() => MapDef>;
  community?: { author: string; license: string; local: boolean };
}

const QUAKE_CREDIT = "id Software's original map source (GPL, released by John Romero 2006); textures: LibreQuake (BSD-3-Clause). Not affiliated with or endorsed by id Software or the LibreQuake project.";

export const MAP_LIST: Record<string, MapEntry> = {
  field: { name: 'FPV Grand Prix Stadium', credit: 'Original (this project, GPL-3.0-or-later); course sized from FAI F9 / MultiGP gate specs', build: fieldMap },
  // training maps (./training): procedural, original
  gym: { name: 'Whoop Gym — Indoor tiny-whoop course', credit: `${TRAINING_CREDIT}; gates and rim sized for 65-75 mm whoops`, build: gymMap },
  practice: { name: 'Practice Field — Spec track + drills', credit: `${TRAINING_CREDIT}; obstacles sized from MultiGP gate specs`, build: practiceMap },
  park: { name: 'Meadow Park — Open field freestyle', credit: TRAINING_CREDIT, build: parkMap },
  mountains: { name: 'Ridgeline — Mountain long range', credit: TRAINING_CREDIT, build: mountainMap },
  night: { name: 'Night Session — Floodlit race course', credit: TRAINING_CREDIT, build: nightMap },
  // fpvsim-map package (public/maps/bando/), generated from bandoMap() above and verified identical by tests/mapFormat.test.ts
  bando: { ...packageEntry('bando', { name: 'Bando — Abandoned Industrial', author: 'fpv-sim', license: 'GPL-3.0-or-later' }, () => httpSource(publicBase() + 'maps/bando/')), credit: 'Original (this project, GPL-3.0-or-later)', community: undefined },
  'quake-e1m1': {
    name: 'Quake E1M1 — The Slipgate Complex', credit: `E1M1 by id Software (level design: John Romero). ${QUAKE_CREDIT}`, source: 'maps/quake/e1m1.map',
    build: (src) => quakeMapDef(src!, { id: 'quake-e1m1', name: 'Quake E1M1 — The Slipgate Complex', ambient: 40 }),
  },
  'quake-dm3': {
    name: 'Quake DM3 — The Abandoned Base', credit: `DM3 by id Software. ${QUAKE_CREDIT}`, source: 'maps/quake/dm3.map',
    build: (src) => quakeMapDef(src!, { id: 'quake-dm3', name: 'Quake DM3 — The Abandoned Base', ambient: 40 }),
  },
  'freedoom-map01': {
    name: 'Freedoom MAP01 — Hydroelectric Plant',
    credit: 'Freedoom Phase 2 MAP01 and its textures, © 2001-2024 Contributors to the Freedoom project (BSD-3-Clause). Not affiliated with or endorsed by the Freedoom project.',
    source: 'maps/freedoom/map01.json',
    build: (src) => doomMapDef(src!, { id: 'freedoom-map01', name: 'Freedoom MAP01 — Hydroelectric Plant', textures: freedoomTextures, textureBase: 'maps/freedoom/textures/' }),
  },
};
// Map ids arrive from other pilots (room map changes) and from storage: with no prototype, ids such
// as `constructor` or `__proto__` are simply unknown, instead of resolving to Object.prototype members.
Object.setPrototypeOf(MAP_LIST, null);

function publicBase() { return (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'; }

// community map packages under public/maps/community/ (index generated by scripts/build-map-index.mjs)
for (const m of communityIndex.maps as { id: string; name: string; author: string; license: string }[]) {
  if (MAP_LIST[m.id]) continue; // never shadow a built-in map
  MAP_LIST[m.id] = packageEntry(m.id, m, () => httpSource(publicBase() + `maps/community/${m.id}/`));
}

const sources = new Map<string, string>();
const built = new Map<string, MapDef>();
const prepared = new Map<string, () => MapDef>();

/** Fetch a map's data files (no-op for procedural maps). Must resolve before MAPS[id]() is called. */
export async function preloadMap(id: string): Promise<void> {
  const e = MAP_LIST[id];
  if (e?.prepare) { if (!prepared.has(id)) prepared.set(id, await e.prepare()); return; }
  if (!e?.source || sources.has(id)) return;
  const base = publicBase();
  const res = await fetch(base + e.source);
  if (!res.ok) throw new Error(`map ${id}: HTTP ${res.status} for ${e.source}`);
  sources.set(id, await res.text());
}

/** Provide a map's source text directly (tests, offline use). */
export function provideMapSource(id: string, text: string) { sources.set(id, text); built.delete(id); }

/** Add or replace a map at runtime (maps loaded from disk). Its cached data is dropped. */
export function registerMap(id: string, e: MapEntry) {
  MAP_LIST[id] = e; MAPS[id] = () => buildMap(id);
  sources.delete(id); built.delete(id); prepared.delete(id);
}

function buildMap(id: string): MapDef {
  const e = MAP_LIST[id];
  if (e.prepare) {
    const make = prepared.get(id);
    if (!make) throw new Error(`map ${id} not loaded: await preloadMap('${id}') first`);
    let m = built.get(id);
    if (!m) built.set(id, (m = make()));
    return m;
  }
  if (!e.source) return e.build();
  let m = built.get(id);
  if (!m) {
    const src = sources.get(id);
    if (src === undefined) throw new Error(`map ${id} not loaded: await preloadMap('${id}') first`);
    built.set(id, (m = e.build(src)));
  }
  return m;
}

export const MAPS: Record<string, () => MapDef> = Object.assign(Object.create(null) as Record<string, () => MapDef>, Object.fromEntries(Object.keys(MAP_LIST).map((id) => [id, () => buildMap(id)])));
/** True only for a map this build knows (own property; never inherited names). */
export const hasMap = (id: unknown): id is string => typeof id === 'string' && Object.prototype.hasOwnProperty.call(MAPS, id);
