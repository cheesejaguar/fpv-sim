// The Cascadia Coast package (public/maps/community/cascadia, built by scripts/build-cascadia-map.mjs
// from USGS lidar, NAIP photos and OpenStreetMap) and the map-format features it brought: a ground
// drape (aerial photo), open water (a sea you can crash into), the real-world GPS origin, the larger
// tree budget, and terrain drawn as fine as its heightfield.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { BUDGETS, loadMapPackage, MapFormatError, PackageSource } from '../src/maps/mapFormat';
import { MAP_LIST } from '../src/maps/maps';
import { BoxPrim, PrimitiveWorld, spawnGroundZ, withSpawn } from '../src/maps/world';
import { seaGeometries } from '../src/render/coast';
import { terrainGrid } from '../src/render/ground';
import { ContactHit, MATERIALS } from '../src/sim/contact';
import { QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { DEFAULT_WIND, Wind } from '../src/sim/wind';

const pub = (p: string) => new URL(`../public/${p}`, import.meta.url);
const schema = JSON.parse(readFileSync(new URL('../schemas/map.v1.schema.json', import.meta.url), 'utf8'));
const schemaCheck = new Ajv({ allErrors: true, strict: false }).compile(schema);

function dirSource(dir: URL): PackageSource {
  const base = dir.pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const files: { path: string; size: number }[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push({ path: relative(base, p).split(sep).join('/'), size: statSync(p).size }); } };
  walk(base);
  return { list: async () => files, url: (p) => `test://${p}`, read: async (p) => new Uint8Array(readFileSync(join(base, p))) };
}
function memSource(files: Record<string, string | Uint8Array>): PackageSource {
  const bytes = (v: string | Uint8Array) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
  return { list: async () => Object.entries(files).map(([path, v]) => ({ path, size: bytes(v).length })), url: (p) => `mem://${p}`, read: async (p) => { if (!(p in files)) throw new Error('no such file'); return bytes(files[p]); } };
}
const minimal = (extra: object = {}) => ({ format: 'fpvsim-map', formatVersion: 1, meta: { id: 'tiny', name: 'Tiny', author: 'Me', license: 'CC0-1.0', version: '1.0.0' }, size: 50, spawn: { pos: [0, 0, 0.25], yawDeg: 90 }, ...extra });
async function load(doc: object, more: Record<string, string | Uint8Array> = {}) {
  return loadMapPackage(memSource({ 'map.json': JSON.stringify(doc), 'ATTRIBUTION.md': '# Tiny\nCC0', ...more }), { strict: true, checkAssets: true });
}
async function errorsOf(doc: object, more: Record<string, string | Uint8Array> = {}): Promise<string[]> {
  try { await load(doc, more); return []; } catch (e) { if (e instanceof MapFormatError) return e.errors; throw e; }
}
/** A minimal JPEG header (SOI + SOF0) of w x h: enough for the size check. */
const jpegHeader = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe('format: drape, water, geo', () => {
  test('the schema and the loader accept them', async () => {
    const doc = minimal({ geo: { lat: 42.17, lon: -124.36 }, water: { level: 0.5, color: '#0d3a45' }, ground: { type: 'flat', z: -2, drape: { image: 'photo.jpg', extent: [80, 60], center: [5, 0], detail: 0.3 } } });
    expect(schemaCheck(doc), JSON.stringify(schemaCheck.errors)).toBe(true);
    const m = (await load(doc, { 'photo.jpg': jpegHeader(512, 384) })).build();
    expect(m.drape).toEqual({ url: 'mem://photo.jpg', x0: -35, y0: -30, w: 80, h: 60, detail: 0.3 });
    expect(m.water).toEqual({ level: 0.5, color: 0x0d3a45 });
    expect(m.geo).toEqual({ lat: 42.17, lon: -124.36 });
  });
  // [what, document, loader error, the schema can express it]
  const bad: [string, object, RegExp, boolean?][] = [
    ['drape on flat ground without an extent', minimal({ ground: { type: 'flat', drape: { image: 'photo.jpg' } } }), /drape\.extent: is required unless the ground is a heightfield/, false],
    ['drape that is not an image', minimal({ ground: { type: 'flat', drape: { image: 'photo.tif', extent: [10, 10] } } }), /drape\.image/],
    ['drape detail above 1', minimal({ ground: { type: 'flat', drape: { image: 'photo.jpg', extent: [10, 10], detail: 2 } } }), /drape\.detail/],
    ['water without a level', minimal({ water: { color: '#000000' } }), /water\.level: is required/],
    ['latitude out of range', minimal({ geo: { lat: 95, lon: 0 } }), /geo\.lat/],
  ];
  test.each(bad)('rejects %s', async (_, doc, re, inSchema = true) => {
    if (inSchema) expect(schemaCheck(doc)).toBe(false);
    expect((await errorsOf(doc, { 'photo.jpg': jpegHeader(64, 64), 'photo.tif': 'x' })).join('\n')).toMatch(re);
  });
  test('the drape has its own, larger image budget', async () => {
    const doc = (w: number) => minimal({ ground: { type: 'flat', drape: { image: 'photo.jpg', extent: [10, 10] } }, primitives: w ? [] : undefined });
    expect(await errorsOf(doc(1), { 'photo.jpg': jpegHeader(BUDGETS.drapePx, BUDGETS.drapePx) })).toEqual([]);
    expect((await errorsOf(doc(1), { 'photo.jpg': jpegHeader(BUDGETS.drapePx + 1, 64) })).join('\n')).toMatch(/drape\.image: "photo\.jpg" is 2049x64 px; the budget is 2048x2048/);
    expect(BUDGETS.drapePx).toBeGreaterThan(BUDGETS.texturePx);
  });
});

describe('Cascadia Coast package', async () => {
  const doc = JSON.parse(readFileSync(pub('maps/community/cascadia/map.json'), 'utf8'));
  const m = await loadMapPackage(dirSource(pub('maps/community/cascadia/')), { strict: true, folderId: 'cascadia', checkAssets: true });
  const map = m.build();
  const world = new PrimitiveWorld(map);
  const hit: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };
  const bridge = map.prims.filter((p): p is BoxPrim => p.kind === 'box' && p.tag === 'bridge');
  const W = map.water!.level;

  test('valid in strict mode, within budget, credited and registered from the index', () => {
    expect(schemaCheck(doc), JSON.stringify(schemaCheck.errors)).toBe(true);
    expect(m.warnings).toEqual([]);
    expect(doc.trees.length).toBeGreaterThan(5000);
    expect(doc.trees.length).toBeLessThanOrEqual(BUDGETS.trees);
    expect(readFileSync(pub('maps/community/cascadia/map.json')).length).toBeLessThan(BUDGETS.mapJsonBytes);
    const credit = readFileSync(pub('maps/community/cascadia/ATTRIBUTION.md'), 'utf8');
    for (const s of ['USGS 3D Elevation Program', 'National Agriculture Imagery Program', '© OpenStreetMap contributors', 'CC BY 4.0']) expect(credit).toContain(s);
    expect(MAP_LIST.cascadia).toMatchObject({ community: { license: 'CC-BY-4.0', local: false } });
  });

  test('georeferenced: real GPS origin, the photo laid exactly over the lidar heightfield', () => {
    expect(map.geo).toEqual({ lat: 42.17, lon: -124.3625 });
    expect(map.drape).toMatchObject({ x0: -800, y0: -800, w: 1600, h: 1600 });
    expect(map.terrainRes).toBeCloseTo(1600 / 1024, 9);
    expect(terrainGrid(map)).toBe(800); // the mesh as fine as the budget allows (~2 m), not the default 320
    expect(map.size * 2.2).toBeLessThanOrEqual(1600); // the drawn terrain stays on the data
  });

  test('the real coast: sea to the west, a high headland, sea stacks standing out of the water', () => {
    expect(map.terrain(-700, 0)).toBeLessThan(W - 5);   // open sea floor
    expect(map.terrain(600, 300)).toBeGreaterThan(80);   // forested ridge inland
    const s = withSpawn(map, 'point').spawn;
    expect(s.groundZ!).toBeGreaterThan(50);             // Thomas Point clifftop ...
    let drop = 0;
    for (let d = 20; d <= 200; d += 5) drop = Math.max(drop, s.groundZ! - map.terrain(s.pos.x - d, s.pos.y));
    expect(drop).toBeGreaterThan(50);                    // ... a 50 m+ drop to the sea to the west
    const stack = withSpawn(map, 'stack').spawn;
    expect(stack.groundZ!).toBeGreaterThan(10);
    const ring = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => map.terrain(stack.pos.x + 45 * Math.cos(k * 0.785), stack.pos.y + 45 * Math.sin(k * 0.785)));
    expect(ring.filter((z) => z < W).length).toBeGreaterThanOrEqual(6); // water all round it
  });

  test('Thomas Creek Bridge: 291 m of steel truss, its deck ~105 m above the creek, on two towers', () => {
    expect(bridge.length).toBeGreaterThan(300);
    const xs = bridge.map((p) => p.c.x), ys = bridge.map((p) => p.c.y);
    const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    expect(span).toBeGreaterThan(280);
    expect(span).toBeLessThan(300);
    const deckTop = Math.max(...bridge.map((p) => p.c.z + p.half.z));
    const creek = Math.min(...[0.4, 0.45, 0.5, 0.55, 0.6].map((f) => map.terrain(Math.min(...xs) + f * (Math.max(...xs) - Math.min(...xs)), Math.max(...ys) - f * (Math.max(...ys) - Math.min(...ys)))));
    expect(deckTop - creek).toBeGreaterThan(95);
    expect(deckTop - creek).toBeLessThan(115);
    // the deck is solid: a sphere resting on it at mid-span is held up there
    const mid = bridge.filter((p) => p.c.z > deckTop - 1.5 && p.visual === 'concrete').sort((a, b) => Math.hypot(a.c.x - (xs[0] + xs.at(-1)!) / 2, a.c.y - (ys[0] + ys.at(-1)!) / 2) - Math.hypot(b.c.x - (xs[0] + xs.at(-1)!) / 2, b.c.y - (ys[0] + ys.at(-1)!) / 2))[0];
    expect(world.sphere({ x: mid.c.x, y: mid.c.y, z: mid.c.z + mid.half.z + 0.05 }, 0.1, hit)).toBe(true);
    expect(hit.nz).toBeGreaterThan(0.95);
    // and there is room to fly under it: clear air 30 m below the deck
    expect(world.sphere({ x: mid.c.x, y: mid.c.y, z: deckTop - 30 }, 1, hit)).toBe(false);
    expect(map.prims.filter((p) => p.tag === 'bridge-footing').length).toBe(8);
  });

  test('every spawn is a level pad the quad can arm on, clear of trees', () => {
    expect(map.spawns!.map((s) => s.id)).toEqual(['point', 'bridge', 'beach', 'stack', 'meadow']);
    for (const s of map.spawns!) {
      const pad = map.prims.find((p): p is BoxPrim => p.kind === 'box' && p.tag === 'pad' && Math.abs(p.c.x - s.pos.x) < 0.01 && Math.abs(p.c.y - s.pos.y) < 0.01)!;
      expect(pad, s.id).toBeDefined();
      expect(pad.c.z + pad.half.z, s.id).toBeCloseTo(s.groundZ!, 2);
      expect(spawnGroundZ(withSpawn(map, s.id)), s.id).toBeCloseTo(s.groundZ!, 6);
      expect(s.groundZ!, s.id).toBeGreaterThan(W);
      // the pad's top is flat (the terrain under it may slope)
      for (const [dx, dy] of [[-0.5, -0.5], [0.5, 0.5], [0.5, -0.5]]) {
        expect(world.sphere({ x: s.pos.x + dx, y: s.pos.y + dy, z: s.groundZ! + 0.04 }, 0.05, hit), s.id).toBe(true);
        expect(hit.nz, s.id).toBeGreaterThan(0.99);
      }
      expect(map.trees.some((t) => Math.hypot(t.x - s.pos.x, t.y - s.pos.y) < 10), s.id).toBe(false);
    }
  });

  test('trees grow on dry land and never through the bridge', () => {
    const xs = bridge.map((p) => p.c.x), ys = bridge.map((p) => p.c.y), deckLow = Math.min(...bridge.filter((p) => p.c.z > 90).map((p) => p.c.z - p.half.z));
    for (const t of map.trees) {
      expect(map.terrain(t.x, t.y)).toBeGreaterThan(W + 2);
      const top = map.terrain(t.x, t.y) + 0.62 * t.h + t.r;
      const near = t.x > Math.min(...xs) - 8 && t.x < Math.max(...xs) + 8 && t.y > Math.min(...ys) - 8 && t.y < Math.max(...ys) + 8;
      if (near && bridge.some((p) => Math.hypot(p.c.x - t.x, p.c.y - t.y) < t.r + 6)) expect(top).toBeLessThan(deckLow);
    }
  });

  test('the sea is a surface: a quad dropped over it stops at the water, not on the sea floor', () => {
    expect(world.groundHeight(-700, 0)).toBe(W);
    expect(world.sphere({ x: -700, y: 0, z: W + 0.05 }, 0.1, hit)).toBe(true);
    expect(hit.material).toBe(MATERIALS.water);
    expect(world.raycast({ x: -700, y: 0, z: 20 }, { x: 0, y: 0, z: -1 }, 40)).toBeCloseTo(20 - W, 1);
    // on land the ground is the ground
    expect(world.sphere({ x: 600, y: 300, z: map.terrain(600, 300) + 0.05 }, 0.1, hit)).toBe(true);
    expect(hit.material).toBe(MATERIALS.dirt);
    const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, 4000);
    const env = { world, wind: new Wind({ ...DEFAULT_WIND, speed20ft: 0 }), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false };
    q.reset({ x: -700, y: 0, z: W + 6 }, 0);
    for (let i = 0; i < 4000 * 3; i++) { q.command([0, 0, 0, 0], false); q.step(1 / 4000, env); env.wake.step(1 / 4000, { x: 0, y: 0, z: 0 }, 0); }
    expect(q.s.pos.z).toBeGreaterThan(W - 0.3);
    expect(q.s.pos.z).toBeLessThan(W + 0.5);
    expect(Math.hypot(q.s.vel.x, q.s.vel.y, q.s.vel.z)).toBeLessThan(0.5); // water does not bounce it back up
  });

  test('the sea mesh: depth from the terrain, dry land left out, open sea out to the horizon', () => {
    const [grid, ring] = seaGeometries(map, 64);
    const depth = grid.getAttribute('aDepth'), pos = grid.getAttribute('position');
    let deep = 0;
    for (let i = 0; i < depth.count; i++) {
      expect(pos.getY(i)).toBe(W);
      expect(depth.getX(i)).toBeCloseTo(W - map.terrain(pos.getX(i), -pos.getZ(i)), 4);
      if (depth.getX(i) > 5) deep++;
    }
    expect(deep).toBeGreaterThan(depth.count * 0.25);
    expect(grid.getIndex()!.count / 6).toBeLessThan(64 * 64 * 0.75); // inland quads skipped
    expect(ring.boundingSphere!.radius).toBeGreaterThan(3000);       // past the camera's far plane
  });
});
