// Map packages come from strangers (published user maps): a hostile file must fail fast with an
// error, not hang or exhaust the memory of everyone who loads it. And a legal map-sized primitive
// must not cost the collision world a quarter of a million grid cells.
import { deflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { BUDGETS, decodePngChannel, glbTriangles, validateMapDoc } from '../src/maps/mapFormat';
import { MAPS } from '../src/maps/maps';
import { MapDef, PrimitiveWorld } from '../src/maps/world';
import { ContactHit, MATERIALS } from '../src/sim/contact';

const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}
const ihdr = (w: number, h: number) => { const b = new Uint8Array(13), dv = new DataView(b.buffer); dv.setUint32(0, w); dv.setUint32(4, h); b[8] = 8; b[9] = 0; return chunk('IHDR', b); };
const png = (...chunks: Uint8Array[]) => new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks.map((c) => Buffer.from(c)), Buffer.from(chunk('IEND', new Uint8Array(0)))]));

describe('PNG heightfields', () => {
  test('an honest 8-bit greyscale PNG decodes', async () => {
    const raw = new Uint8Array([0, 0, 255, 0, 128, 64]); // 2 rows of 2 px, filter 0
    const d = await decodePngChannel(png(ihdr(2, 2), chunk('IDAT', deflateSync(raw))));
    expect(d.w).toBe(2); expect([...d.data].map((v) => Math.round(v * 255))).toEqual([0, 255, 128, 64]);
  });
  test('a second IHDR (a decoy for the size check) is refused', async () => {
    await expect(decodePngChannel(png(ihdr(4, 4), ihdr(8000, 8000), chunk('IDAT', deflateSync(new Uint8Array(20)))))).rejects.toThrow(/IHDR/);
  });
  test('a PNG larger than the heightfield budget is refused before decoding', async () => {
    await expect(decodePngChannel(png(ihdr(BUDGETS.heightfieldPx + 1, 4), chunk('IDAT', deflateSync(new Uint8Array(10)))))).rejects.toThrow(/at most 1025 px/);
  });
  test('a deflate bomb stops at the size the image needs', async () => {
    const bomb = deflateSync(new Uint8Array(64 << 20)); // 64 MiB of zeros in ~64 KB, for a 4x4 image
    const t0 = performance.now();
    await expect(decodePngChannel(png(ihdr(4, 4), chunk('IDAT', bomb)))).rejects.toThrow(/inflates to more than/);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

/** A .glb with one triangle mesh and the given nodes / scene roots. */
function glb(nodes: object[], roots: number[], extra: object = {}): Uint8Array {
  const bin = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: roots }], nodes, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }], ...extra };
  let js = new TextEncoder().encode(JSON.stringify(json));
  if (js.length % 4) js = new Uint8Array([...js, ...new Array(4 - (js.length % 4)).fill(0x20)]);
  const out = new Uint8Array(12 + 8 + js.length + 8 + bin.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(js, 20);
  dv.setUint32(20 + js.length, bin.length, true); dv.setUint32(24 + js.length, 0x004e4942, true); out.set(bin, 28 + js.length);
  return out;
}

describe('glTF triangles', () => {
  test('nodes shared as a DAG are visited once (no exponential blow-up)', () => {
    // 6 levels, each node listing the next one 30 times: 30^6 = 729 million paths to the mesh
    const nodes = [...Array.from({ length: 6 }, (_, i) => ({ children: new Array(30).fill(i + 1) })), { mesh: 0 }];
    const t0 = performance.now(), r = glbTriangles(glb(nodes, [0]));
    expect(r.triangles).toBe(1);
    expect(performance.now() - t0).toBeLessThan(500);
  });
  test('an accessor count no real mesh needs is refused before anything is allocated', () => {
    expect(() => glbTriangles(glb([{ mesh: 0 }], [0], { accessors: [{ componentType: 5126, count: 2e9, type: 'VEC3' }] }))).toThrow(/count .* out of range/);
  });
  test('non-finite vertex positions are refused', () => {
    // (JSON has no Infinity: two nested 1e300 scales overflow to it)
    expect(() => glbTriangles(glb([{ children: [1], scale: [1e300, 1e300, 1e300] }, { mesh: 0, scale: [1e300, 1e300, 1e300] }], [0]))).toThrow(/finite/);
  });
});

describe('big primitives', () => {
  const ground = (): MapDef => ({ ...MAPS.field(), trees: [], gates: [], prims: [{ kind: 'box', c: { x: 0, y: 0, z: 50 }, half: { x: 2000, y: 2000, z: 0.5 }, yaw: 0.3, mat: 'concrete' }] });
  test('a map-sized slab builds in milliseconds and still collides everywhere', () => {
    const t0 = performance.now(), w = new PrimitiveWorld(ground());
    expect(performance.now() - t0).toBeLessThan(200); // (was ~1 s and 300 MB)
    const o: ContactHit = { depth: 0, nx: 0, ny: 0, nz: 0, material: MATERIALS.grass };
    for (const [x, y] of [[0, 0], [900, -700], [-1500, 300]]) {
      expect(w.sphere({ x, y, z: 50.55 }, 0.1, o), `${x}, ${y}`).toBe(true);
      expect(o.nz).toBeCloseTo(1, 6);
      w.near({ x, y, z: 50.55 }, 0.3);
      expect(w.sphereNear({ x, y, z: 50.55 }, 0.1, o)).toBe(true);
    }
    expect(w.raycast({ x: 100, y: 100, z: 60 }, { x: 0, y: 0, z: -1 }, 20)).toBeCloseTo(9.5, 6);
  });
  test('the validator caps primitive sizes at the map size budget', () => {
    const doc = (size: number[]) => ({ format: 'fpvsim-map', formatVersion: 1, meta: { id: 'big', name: 'Big', author: 'Me', license: 'CC0-1.0', version: '1.0.0' }, size: 100, spawn: { pos: [0, 0, 0] }, primitives: [{ type: 'box', pos: [0, 0, 0], size }] });
    expect(() => validateMapDoc(doc([4000, 4000, 1]))).not.toThrow();
    expect(() => validateMapDoc(doc([40000, 40000, 1]))).toThrow(/must be <= 4000/);
  });
});
