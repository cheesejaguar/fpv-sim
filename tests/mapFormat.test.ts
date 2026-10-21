// fpvsim-map v1 packages: the JSON Schema and the loader agree on good and bad documents, the
// budgets and licence rules are enforced, the Bando reference port matches bandoMap() exactly, the
// example map's heightfield + glTF collision work in flight, zipped packages load, and the
// community index is generated deterministically and committed up to date.
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import Ajv from 'ajv';
import { describe, expect, test } from 'vitest';
import { buildDrone, DEFAULT_SPEC } from '../src/builder/derive';
import { BUDGETS, glbTriangles, licenseError, loadMapPackage, MapFormatError, PackageSource, validateMapDoc } from '../src/maps/mapFormat';
import { bandoMap, MAP_LIST } from '../src/maps/maps';
import { BoxPrim, CylPrim, PrimitiveWorld, spawnGroundZ } from '../src/maps/world';
import { readZip } from '../src/maps/zip';
import { ContactHit, MATERIALS } from '../src/sim/contact';
import { QuadSim } from '../src/sim/quad';
import { WakeField } from '../src/sim/wake';
import { DEFAULT_WIND, Wind } from '../src/sim/wind';

const ROOT = new URL('../', import.meta.url);
const pub = (p: string) => new URL(`../public/${p}`, import.meta.url);
const schema = JSON.parse(readFileSync(new URL('schemas/map.v1.schema.json', ROOT), 'utf8'));
const schemaCheck = new Ajv({ allErrors: true, strict: false }).compile(schema);

function dirSource(dir: URL): PackageSource {
  const base = dir.pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const files: { path: string; size: number }[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push({ path: relative(base, p).split(sep).join('/'), size: statSync(p).size }); } };
  walk(base);
  return { list: async () => files, url: (p) => `test://${p}`, read: async (p) => { if (!files.some((f) => f.path === p)) throw new Error('no such file'); return new Uint8Array(readFileSync(join(base, p))); } };
}
function memSource(files: Record<string, string | Uint8Array>): PackageSource {
  const bytes = (v: string | Uint8Array) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
  return {
    list: async () => Object.entries(files).map(([path, v]) => ({ path, size: bytes(v).length })),
    url: (p) => `mem://${p}`,
    read: async (p) => { if (!(p in files)) throw new Error('no such file'); return bytes(files[p]); },
  };
}
const quarry = () => JSON.parse(readFileSync(pub('maps/community/quarry-loop/map.json'), 'utf8'));
const minimal = (extra: object = {}) => ({ format: 'fpvsim-map', formatVersion: 1, meta: { id: 'tiny', name: 'Tiny', author: 'Me', license: 'CC0-1.0', version: '1.0.0' }, size: 50, spawn: { pos: [0, 0, 0.25], yawDeg: 90 }, ...extra });
const pkg = (doc: object, more: Record<string, string | Uint8Array> = {}) => memSource({ 'map.json': JSON.stringify(doc), 'ATTRIBUTION.md': '# Tiny\nCC0', ...more });
async function errorsOf(src: PackageSource, opts = { strict: true }): Promise<string[]> {
  try { await loadMapPackage(src, { ...opts, checkAssets: true }); return []; } catch (e) { if (e instanceof MapFormatError) return e.errors; throw e; }
}

describe('schema and loader agree', () => {
  test.each(['maps/community/quarry-loop/map.json', 'maps/bando/map.json'])('%s is valid', (f) => {
    const doc = JSON.parse(readFileSync(pub(f), 'utf8'));
    expect(schemaCheck(doc), JSON.stringify(schemaCheck.errors)).toBe(true);
    expect(() => validateMapDoc(doc)).not.toThrow();
  });

  // [what, document, loader error, the schema can express it]
  const bad: [string, object, RegExp, boolean?][] = [
    ['unknown property', minimal({ sizee: 3 }), /sizee: unknown property/],
    ['typo in a primitive', minimal({ primitives: [{ type: 'box', pos: [0, 0, 0], siz: [1, 1, 1] }] }), /primitives\[0\]\.siz: unknown property.*\n?|primitives\[0\]\.size: is required/],
    ['negative size', minimal({ primitives: [{ type: 'box', pos: [0, 0, 0], size: [1, -1, 1] }] }), /primitives\[0\]\.size\[1\]: must be > 0/],
    ['wrong format version', { ...minimal(), formatVersion: 2 }, /newer than this simulator supports/],
    ['NonCommercial licence', minimal({ meta: { ...minimal().meta, license: 'CC-BY-NC-4.0' } }), /NonCommercial/],
    ['bad id', minimal({ meta: { ...minimal().meta, id: 'My Map' } }), /meta\.id: must be 2-24 characters/],
    ['missing spawn', { ...minimal(), spawn: undefined }, /spawn: is required/],
    ['path traversal', minimal({ ground: { type: 'heightfield', image: '../secret.png', extent: [10, 10], zMin: 0, zMax: 1 } }), /must not contain "\.\."/],
    ['URL asset', minimal({ primitives: [{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], texture: 'https://example.com/a.png' }] }), /not a URL/],
    ['dive gate without z', minimal({ gates: [{ kind: 'dive', pos: [0, 0] }] }), /dive gate needs \[x, y, z\]/],
    ['bad colour', minimal({ primitives: [{ type: 'sphere', pos: [0, 0, 1], radius: 1, color: 'red' }] }), /colour like/],
    ['two base geometries', minimal({ geometry: [{ type: 'quake', src: 'a.map' }, { type: 'quake', src: 'b.map' }] }), /only one Quake or Doom/, false],
  ];
  test.each(bad)('rejects %s', async (_, doc, re, inSchema = true) => {
    const clean = JSON.parse(JSON.stringify(doc));
    if (inSchema) expect(schemaCheck(clean)).toBe(false);
    const errs = await errorsOf(pkg(clean));
    expect(errs.join('\n')).toMatch(re);
  });
});

describe('budgets and licence rules', () => {
  test('too many primitives', async () => {
    const prims = Array.from({ length: BUDGETS.primitives + 1 }, (_, i) => ({ type: 'sphere', pos: [i % 50, Math.floor(i / 50), 1], radius: 0.2 }));
    expect((await errorsOf(pkg(minimal({ primitives: prims })))).join()).toMatch(/budget is 5000/);
  });
  test('gate parts count against the primitive budget', async () => {
    const prims = Array.from({ length: BUDGETS.primitives - 2 }, (_, i) => ({ type: 'sphere', pos: [i % 50, Math.floor(i / 50), 1], radius: 0.2 }));
    expect((await errorsOf(pkg(minimal({ primitives: prims, gates: [{ kind: 'square', pos: [0, 5] }] }))))[0]).toMatch(/including generated gate parts/);
  });
  test('oversized files and textures', async () => {
    const big = new Uint8Array(BUDGETS.fileBytes + 1);
    expect((await errorsOf(pkg(minimal(), { 'huge.png': big }))).join()).toMatch(/per-file budget/);
    // a 2048 x 2048 PNG header
    const png = new Uint8Array(33); png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 8, 0, 0, 0, 8, 0]);
    const errs = await errorsOf(pkg(minimal({ primitives: [{ type: 'box', pos: [0, 0, 1], size: [1, 1, 1], texture: 't.png' }] }), { 't.png': png }));
    expect(errs.join()).toMatch(/2048x2048 px; the budget is 1024x1024/);
  });
  test('forbidden and unknown file types', async () => {
    expect((await errorsOf(pkg(minimal(), { 'doom2.wad': 'IWAD' }))).join()).toMatch(/not allowed in map packages/);
    expect((await errorsOf(pkg(minimal(), { 'run.js': 'x' }))).join()).toMatch(/not allowed/);
    expect((await errorsOf(pkg(minimal(), { 'a.blend': 'x' }))).join()).toMatch(/unsupported file type/);
  });
  test('repository rules: ATTRIBUTION.md, licence text, folder name', async () => {
    const noAttr = memSource({ 'map.json': JSON.stringify(minimal()) });
    expect((await errorsOf(noAttr)).join()).toMatch(/ATTRIBUTION\.md is missing/);
    expect(await errorsOf(noAttr, { strict: false })).toEqual([]); // local testing: only a warning
    const mit = minimal({ meta: { ...minimal().meta, license: 'MIT' } });
    expect((await errorsOf(pkg(mit))).join()).toMatch(/MIT requires its full licence text/);
    expect(await errorsOf(pkg(mit, { 'LICENSE.txt': 'MIT License ...' }))).toEqual([]);
    await expect(loadMapPackage(pkg(minimal()), { strict: true, folderId: 'other' })).rejects.toThrow(/must equal the package folder name "other"/);
  });
  test('accepted licences', () => {
    for (const l of ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'BSD-3-Clause', 'GPL-3.0-or-later', 'CC-BY-4.0 AND MIT', '(MIT OR Apache-2.0)']) expect(licenseError(l), l).toBeNull();
    for (const l of ['CC-BY-ND-4.0', 'Proprietary', 'All rights reserved', 'CC-BY-NC-SA-4.0']) expect(licenseError(l), l).not.toBeNull();
  });
});

describe('Bando: JSON package is identical to bandoMap()', async () => {
  const ts = bandoMap();
  const m = await loadMapPackage(dirSource(pub('maps/bando/')));
  const js = m.build('bando');

  test('metadata, spawn, environment', () => {
    expect(js.name).toBe(ts.name); expect(js.size).toBe(ts.size); expect(js.groundMat).toBe(ts.groundMat);
    expect(js.sky).toBe(ts.sky); expect(js.sun).toEqual(ts.sun); expect(js.elevationM).toBe(ts.elevationM);
    expect(js.spawn).toEqual(ts.spawn); expect(js.wakeZones).toEqual(ts.wakeZones); expect(js.trees).toEqual(ts.trees);
    expect(js.gates).toEqual([]); expect(spawnGroundZ(js)).toBe(spawnGroundZ(ts));
  });
  test('terrain matches bit for bit', () => {
    for (let x = -350; x <= 350; x += 3.7) for (let y = -350; y <= 350; y += 4.1) expect(js.terrain(x, y)).toBe(ts.terrain(x, y));
  });
  test('every primitive matches', () => {
    expect(js.prims.length).toBe(ts.prims.length);
    ts.prims.forEach((a, i) => {
      const b = js.prims[i];
      expect(b.kind).toBe(a.kind); expect(b.c).toEqual(a.c); expect(b.mat).toBe(a.mat); expect(b.tag).toBe(a.tag);
      if (a.kind === 'box') {
        const bb = b as BoxPrim;
        expect(bb.half).toEqual(a.half); expect(bb.visual).toBe(a.visual); expect(bb.yaw).toBeCloseTo(a.yaw, 12); expect(bb.pitch ?? 0).toBe(a.pitch ?? 0);
      } else if (a.kind === 'cyl') {
        const bc = b as CylPrim;
        expect(bc.r).toBe(a.r); expect(bc.h).toBe(a.h); expect(bc.color).toBe(a.color);
      }
    });
  });
  test('the registry flies the JSON version', () => {
    expect(MAP_LIST.bando.prepare).toBeTypeOf('function');
    expect(MAP_LIST.bando.community).toBeUndefined();
  });
});

describe('example community map: quarry-loop', async () => {
  const m = await loadMapPackage(dirSource(pub('maps/community/quarry-loop/')), { strict: true, folderId: 'quarry-loop', checkAssets: true });
  const map = m.build();
  const world = new PrimitiveWorld(map);
  const hit: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };

  test('loads in strict mode without warnings and is registered from the index', () => {
    expect(m.warnings).toEqual([]);
    expect(m.stats).toMatchObject({ gates: 8, trees: 36, brushes: 132, collisionTriangles: 132 });
    expect(MAP_LIST['quarry-loop']).toMatchObject({ name: 'Quarry Loop', community: { author: 'fpv-sim contributors', license: 'CC0-1.0', local: false } });
    expect(map.meshes?.[0]).toMatchObject({ url: 'test://arch.glb', pos: { x: 0, y: 18, z: 0 }, scale: 1 });
    expect(map.fog).toEqual({ color: 0xc9d3dc, density: 0.003 });
    expect(map.prims.some((p) => p.kind === 'box' && p.texture === 'test://textures/hazard.png')).toBe(true);
  });
  test('heightfield: flat quarry floor, raised rim, gates stand on it', () => {
    const floor = -1 + 16 * Math.round(16 / 255 * 255) / 255; // z = 0 quantised to 8 bits
    expect(map.terrain(0, 0)).toBeCloseTo(floor, 6);
    expect(map.terrain(0, 0)).toBeCloseTo(0, 1);
    expect(map.terrain(100, 0)).toBeGreaterThan(11);
    expect(map.terrain(500, 500)).toBe(map.terrain(120, 120)); // clamps at the edge
    for (const g of map.gates) if (g.kind !== 'dive') expect(g.c.z).toBe(map.terrain(g.c.x, g.c.y));
    expect(world.sphere({ x: 0, y: -34, z: spawnGroundZ(map) + 0.03 }, 0.05, hit)).toBe(true);
  });
  test('glTF arch has exact triangle collision', () => {
    const glb = glbTriangles(new Uint8Array(readFileSync(pub('maps/community/quarry-loop/arch.glb'))));
    expect(glb.triangles).toBe(132);
    expect(world.sphere({ x: 0, y: 18, z: 4.55 }, 0.1, hit)).toBe(true);      // on top of the arch
    expect(hit.nz).toBeGreaterThan(0.95);
    expect(world.sphere({ x: 0, y: 18, z: 2 }, 0.1, hit)).toBe(false);       // inside the tunnel: free
    expect(world.raycast({ x: 0, y: 18, z: 1 }, { x: 0, y: 0, z: 1 }, 10)).toBeCloseTo(3, 3); // inner radius 4
    expect(world.raycast({ x: 0, y: 10, z: 2 }, { x: 0, y: 1, z: 0 }, 20)).toBe(Infinity);    // fly straight through
  });
  const flight = (from: { x: number; y: number; z: number }, yaw: number, v: number) => {
    const q = new QuadSim(buildDrone(DEFAULT_SPEC).params, 8000);
    const env = { world, wind: new Wind({ ...DEFAULT_WIND, speed20ft: 0 }), wake: new WakeField(), ambientC: 20, altitudeOffset: 0, damageEnabled: false };
    q.reset(from, yaw);
    q.s.vel = { x: v * Math.cos(yaw), y: v * Math.sin(yaw), z: 0 };
    const path: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < 8000; i++) { q.command([1000, 1000, 1000, 1000], false); q.step(1 / 8000, env); path.push({ ...q.s.pos }); }
    return path;
  };
  test('a quad flies through the arch untouched', () => {
    const p = flight({ x: 0, y: 8, z: 2.4 }, Math.PI / 2, 15);
    expect(p.at(-1)!.y).toBeGreaterThan(20); // passed through (falling, but clear of the walls)
    expect(Math.min(...p.filter((q) => Math.abs(q.y - 18) < 1.5).map((q) => Math.abs(q.x)))).toBeLessThan(0.5);
  });
  test('a quad hitting the arch side does not tunnel into the wall', () => {
    const p = flight({ x: -12, y: 18, z: 2.5 }, 0, 25);
    const r = p.filter((q) => Math.abs(q.y - 18) < 1.4).map((q) => Math.hypot(q.x, q.z));
    expect(Math.min(...r)).toBeLessThan(5.2); // its arms reached the wall (and glanced off / over it) ...
    expect(Math.min(...r)).toBeGreaterThan(4.45); // ... without ever entering it
  });
});

describe('zipped packages', () => {
  function zip(files: Record<string, Uint8Array>, deflate: boolean): Uint8Array {
    const parts: Buffer[] = [], central: Buffer[] = [];
    let off = 0;
    for (const [name, data] of Object.entries(files)) {
      const body = deflate ? deflateRawSync(data) : Buffer.from(data), n = Buffer.from(name), crc = crc32(data);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
      parts.push(lh, n, body); central.push(ch, n); off += 30 + n.length + body.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return new Uint8Array(Buffer.concat([...parts, cd, end]));
  }
  test.each([true, false])('round trip (deflate %s)', async (deflate) => {
    const dir = new URL('maps/community/quarry-loop/', pub(''));
    const src = dirSource(dir), files: Record<string, Uint8Array> = {};
    for (const f of await src.list!()) files[`quarry-loop/${f.path}`] = await src.read(f.path);
    const entries = readZip(zip(files, deflate));
    const strip = (p: string) => p.slice('quarry-loop/'.length);
    const zsrc: PackageSource = { list: async () => entries.map((e) => ({ path: strip(e.path), size: e.size })), url: (p) => p, read: async (p) => entries.find((e) => strip(e.path) === p)!.read() };
    const m = await loadMapPackage(zsrc, { strict: true, checkAssets: true });
    expect(m.build().prims.length).toBe((await loadMapPackage(src)).build().prims.length);
  });
});

describe('community index', () => {
  test('generated from the package folders and committed up to date', async () => {
    const { buildIndex, serialize } = await import(/* @vite-ignore */ new URL('scripts/build-map-index.mjs', ROOT).href);
    const { index, problems } = buildIndex();
    expect(problems).toEqual([]);
    expect(readFileSync(pub('maps/community/index.json'), 'utf8').replace(/\r\n/g, '\n')).toBe(serialize(index));
    expect(index.maps.map((m: { id: string }) => m.id)).toContain('quarry-loop');
  });
  test('lists valid packages and reports broken ones', async () => {
    const { buildIndex } = await import(/* @vite-ignore */ new URL('scripts/build-map-index.mjs', ROOT).href);
    const dir = mkdtempSync(join(tmpdir(), 'fpv-maps-'));
    for (const [id, body] of [['b-map', { meta: { id: 'b-map', name: 'B', author: 'X', license: 'MIT', version: '1.0.0', preview: 'p.jpg' } }], ['a-map', { meta: { id: 'a-map', name: 'A', author: 'Y', license: 'CC0-1.0', version: '0.1.0' } }], ['wrong', { meta: { id: 'other' } }]] as const) {
      mkdirSync(join(dir, id)); writeFileSync(join(dir, id, 'map.json'), JSON.stringify(body));
    }
    mkdirSync(join(dir, 'empty'));
    const { index, problems } = buildIndex(dir);
    expect(index.maps).toEqual([
      { id: 'a-map', name: 'A', author: 'Y', license: 'CC0-1.0', version: '0.1.0' },
      { id: 'b-map', name: 'B', author: 'X', license: 'MIT', version: '1.0.0', preview: 'maps/community/b-map/p.jpg' },
    ]);
    expect(problems).toHaveLength(2);
  });
});
