// Precomputed propeller BEMT tables (src/builder/bemtTables.ts, scripts/build-bemt-tables.mjs): the
// binary form round-trips bit for bit, and a fetched table is what buildDrone() then uses, so the
// page and the worker skip the ~1.2 s solve without changing the physics.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { decodeTable, encodeTable } from '../src/builder/bemtTables';
import { buildDrone, DEFAULT_SPEC, hasPropTable, preloadPropTable, propGeometry } from '../src/builder/derive';
import { PROPS } from '../src/data/catalog';
import { buildBemtTable, BemtTable } from '../src/sim/bemt';

const bits = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function expectSameTable(a: BemtTable, b: BemtTable) {
  expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
  for (const [k, v] of Object.entries(a)) {
    const w = (b as unknown as Record<string, unknown>)[k];
    if (v instanceof Float32Array) { expect(w).toBeInstanceOf(Float32Array); expect(bits(w as Float32Array).equals(bits(v)), k).toBe(true); }
    else expect(Object.is(w, v), k).toBe(true);
  }
}

// a prop no other test in this file builds: its table is computed here once, directly
const prop = PROPS.find((p) => p.id !== DEFAULT_SPEC.prop)!;
let direct: BemtTable | null = null;
const table = () => (direct ??= buildBemtTable(propGeometry(prop), prop.calib));

afterEach(() => { vi.unstubAllGlobals(); });

describe('BEMT table binary form', () => {
  test('encode -> decode is bit-identical, every field', () => {
    const t = table();
    const back = decodeTable(encodeTable(t));
    expectSameTable(t, back);
    // own, aligned buffers (not views into the download)
    expect(back.ct.byteOffset).toBe(0);
    // also from a Node Buffer (the test setup reads the tables from disk): its slice() is a view
    const fromDisk = decodeTable(Buffer.concat([Buffer.alloc(3), Buffer.from(encodeTable(t))]).subarray(3));
    expectSameTable(t, fromDisk);
  }, 60000);

  test('garbage, truncated and padded files are refused', () => {
    const bytes = encodeTable(table());
    expect(() => decodeTable(new Uint8Array(8))).toThrow(/truncated/);
    expect(() => decodeTable(bytes.slice(0, bytes.length - 4))).toThrow(/truncated/);
    expect(() => decodeTable(new Uint8Array([...bytes, 0, 0, 0, 0]))).toThrow(/trailing/);
    const bad = bytes.slice(); bad[0] ^= 0xff;
    expect(() => decodeTable(bad)).toThrow(/not a table/);
  }, 60000);
});

describe('preloadPropTable', () => {
  test('a fetched table is the one buildDrone uses: same physics, no solve', async () => {
    const bytes = encodeTable(table());
    const fetchStub = vi.fn(async () => new Response(bytes, { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    expect(hasPropTable(prop.id)).toBe(false);
    expect(await preloadPropTable(prop.id, { url: '/bemt/test.bin' })).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(hasPropTable(prop.id)).toBe(true);
    // a second preload is free
    expect(await preloadPropTable(prop.id, { url: '/bemt/test.bin' })).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const t0 = performance.now();
    const b = buildDrone({ ...DEFAULT_SPEC, prop: prop.id });
    expect(performance.now() - t0).toBeLessThan(400); // (the solve takes ~1.2 s)
    expectSameTable(table(), b.tables);
  }, 60000);

  test('a failed download resolves false and leaves the table to be computed', async () => {
    const other = PROPS.find((p) => p.id !== prop.id && p.id !== DEFAULT_SPEC.prop)!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    expect(await preloadPropTable(other.id, { url: '/bemt/missing.bin' })).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
    expect(await preloadPropTable(other.id, { url: '/bemt/garbage.bin' })).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await preloadPropTable(other.id, { url: '/bemt/offline.bin' })).toBe(false);
    expect(hasPropTable(other.id)).toBe(false);
    expect(await preloadPropTable('no-such-prop', { url: '/x.bin' })).toBe(false);
  });
});
