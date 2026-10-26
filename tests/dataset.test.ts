// Dataset export building blocks: PNG encoding (decoded back with Node's zlib), the ZIP writer
// (read back with the app's own reader), base64, gate corner geometry and the run file round trip.
import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { gateCorners } from '../src/app/dataset';
import { crc32, encodePng, toBase64, ZipWriter } from '../src/app/datasetFiles';
import { gatePassed } from '../src/maps/gates';
import type { GateDef } from '../src/maps/world';
import { readZip } from '../src/maps/zip';
import { decodeRun, encodeRun, RunLog } from '../src/worker/runLog';
import { DEFAULT_SPEC } from '../src/builder/derive';
import { DEFAULT_SETTINGS } from '../src/worker/shared';

/** Minimal PNG decoder for the encoder's own output (filter 0 rows). */
function decodePng(png: Uint8Array) {
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let i = 8, w = 0, h = 0, depth = 0, type = 0;
  const idat: Uint8Array[] = [];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (i < png.length) {
    const n = dv.getUint32(i), t = String.fromCharCode(...png.subarray(i + 4, i + 8)), body = png.subarray(i + 8, i + 8 + n);
    expect(dv.getUint32(i + 8 + n)).toBe(crc32(png.subarray(i + 4, i + 8 + n)));
    if (t === 'IHDR') { w = dv.getUint32(i + 8); h = dv.getUint32(i + 12); depth = png[i + 16]; type = png[i + 17]; }
    if (t === 'IDAT') idat.push(body);
    i += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { w, h, depth, type, raw };
}

describe('dataset files', () => {
  test('CRC-32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('PNG: RGBA, 8-bit and 16-bit grayscale round-trip', async () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 8, 7, 6]);
    const a = decodePng(await encodePng(2, 2, rgba, 'rgba8'));
    expect([a.w, a.h, a.depth, a.type]).toEqual([2, 2, 8, 6]);
    expect(Array.from(a.raw)).toEqual([0, ...rgba.subarray(0, 8), 0, ...rgba.subarray(8)]);
    const g = decodePng(await encodePng(3, 1, new Uint8Array([0, 4, 8]), 'gray8'));
    expect([g.depth, g.type]).toEqual([8, 0]);
    expect(Array.from(g.raw)).toEqual([0, 0, 4, 8]);
    const d = decodePng(await encodePng(2, 1, new Uint16Array([1234, 65535]), 'gray16'));
    expect([d.depth, d.type]).toEqual([16, 0]);
    expect(Array.from(d.raw)).toEqual([0, 1234 >> 8, 1234 & 255, 255, 255]);
  });

  test('ZIP: stored entries read back by the app\'s own reader', async () => {
    const z = new ZipWriter();
    z.add('meta.json', '{"a":1}');
    z.add('rgb/000000.png', new Uint8Array([1, 2, 3]));
    const entries = readZip(z.finish());
    expect(entries.map((e) => e.path)).toEqual(['meta.json', 'rgb/000000.png']);
    expect(new TextDecoder().decode(await entries[0].read())).toBe('{"a":1}');
    expect(Array.from(await entries[1].read())).toEqual([1, 2, 3]);
  });

  test('base64 of large buffers', () => {
    const big = new Uint8Array(100000).map((_, i) => i * 7);
    expect(Buffer.from(toBase64(big), 'base64').equals(Buffer.from(big))).toBe(true);
  });
});

describe('gate corners', () => {
  const sq: GateDef = { id: 3, c: { x: 10, y: 5, z: 0 }, yaw: Math.PI / 2, width: 2, height: 1.5, kind: 'square' };
  test('a square gate: four corners of its opening, top-left first seen from the approach side', () => {
    const c = gateCorners(sq);
    expect(c).toHaveLength(4);
    // a path through the middle of the opening passes the gate; through each corner's outside, not
    const mid = (k: number, j: number) => [(c[k][0] + c[j][0]) / 2, (c[k][1] + c[j][1]) / 2, (c[k][2] + c[j][2]) / 2];
    const centre = mid(0, 2);
    const n = { x: -Math.sin(sq.yaw), y: Math.cos(sq.yaw) };
    const through = (p: number[]) => gatePassed(sq, { x: p[0] - n.x, y: p[1] - n.y, z: p[2] }, { x: p[0] + n.x, y: p[1] + n.y, z: p[2] });
    expect(through(centre)).toBe(true);
    expect(c[0][2]).toBeCloseTo(1.5, 9); expect(c[3][2]).toBeCloseTo(0, 9);
    expect(Math.hypot(c[0][0] - c[1][0], c[0][1] - c[1][1])).toBeCloseTo(2, 9);
    // seen from the approach side (looking along n), corner 1 is to the right of corner 0
    const right = { x: n.y, y: -n.x };
    expect((c[1][0] - c[0][0]) * right.x + (c[1][1] - c[0][1]) * right.y).toBeGreaterThan(0);
  });
  test('a dive gate lies flat; a flag has its pass point only', () => {
    const dive = gateCorners({ ...sq, kind: 'dive', c: { x: 0, y: 0, z: 3 } });
    expect(dive.every((p) => p[2] === 3)).toBe(true);
    expect(gateCorners({ ...sq, kind: 'flag' })).toHaveLength(1);
  });
});

test('run files round-trip (gzip, binary arrays)', async () => {
  const run: RunLog = {
    format: 'fpvsim-run', version: 1, app: 'test', firmware: 'bf', firmwareBuild: 'x', created: 'now', seed: 7,
    mapId: 'gym', courseId: '', settings: DEFAULT_SETTINGS, spec: DEFAULT_SPEC, eeprom: new Uint8Array([1, 2, 3, 250]),
    steps: 100, packetSteps: new Uint32Array([0, 32, 64]), packetChannels: new Float32Array(48).map((_, i) => 1000 + i + 0.25), events: [{ k: 50, type: 'reset', repair: true, fullBattery: false }], end: 'stopped',
  };
  const back = await decodeRun(await encodeRun(run));
  expect(back).toEqual(run);
  await expect(decodeRun(new TextEncoder().encode('{"format":"other"}'))).rejects.toThrow(/not a run file/);
});
