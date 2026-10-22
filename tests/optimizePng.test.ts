// The lossless PNG re-encoder the map textures went through (scripts/optimize-png.mjs): every
// encoding it can pick (1/2/4/8-bit palette with or without transparency, RGB, RGBA) decodes to the
// same pixels, and the shipped textures decode at the size their manifests give.
import { readdirSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

type Png = { w: number; h: number; rgba: Buffer };
type Mod = { decodePng(b: Buffer): Png; optimizePng(b: Buffer): Buffer | null; encodings(img: Png & { keep: Buffer[] }): Buffer[] };
const load = async (): Promise<Mod> => import(/* @vite-ignore */ new URL('../scripts/optimize-png.mjs', import.meta.url).href);

/** A plain 8-bit RGBA PNG (filter 0), as the vendoring scripts used to write them. */
function rgbaPng(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (1 + w * 4) + 1 + x * 4);
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const cases: [string, number, (x: number, y: number) => [number, number, number, number], number][] = [
  // name, palette size (0: truecolour), pixel function, expected colour type
  ['2 colours (1-bit palette)', 2, (x, y) => ((x + y) & 1 ? [200, 10, 10, 255] : [0, 0, 0, 255]), 3],
  ['3 colours (2-bit palette)', 3, (x, y) => [[1, 2, 3, 255], [40, 50, 60, 255], [250, 0, 7, 255]][(x * 7 + y) % 3] as [number, number, number, number], 3],
  ['11 colours (4-bit palette), odd width', 11, (x, y) => [(x * 13 + y) % 11 * 20, 99, 5, 255], 3],
  ['200 colours with transparency (8-bit palette + tRNS)', 200, (x, y) => { const i = (x + y * 37) % 200; return i < 20 ? [0, 0, 0, 0] as [number, number, number, number] : [i, 255 - i, (i * 7) & 255, i < 40 ? 128 : 255]; }, 3],
  ['300 opaque colours (RGB)', 0, (x, y) => [x * 9 & 255, y * 11 & 255, (x * y) & 255, 255], 2],
  ['300 colours with alpha (RGBA)', 0, (x, y) => [x * 9 & 255, y * 11 & 255, (x * y) & 255, x & 1 ? 255 : 77], 6],
];

describe('optimize-png', () => {
  test.each(cases)('%s: every candidate encoding is pixel-identical, the smallest is picked', async (_name, n, px, ct) => {
    const { decodePng, encodings, optimizePng } = await load();
    const w = 37, h = 29;
    const src = rgbaPng(w, h, px);
    const a = decodePng(src);
    const all = encodings({ ...a, keep: [] });
    // the palette when there are at most 256 colours (bit depth by palette size), and truecolour
    expect(all.map((e) => e[25]).sort()).toEqual(n ? [ct, a.rgba.some((_, i) => i % 4 === 3 && a.rgba[i] !== 255) ? 6 : 2].sort() : [ct]);
    if (n) expect(all.find((e) => e[25] === 3)![24]).toBe(n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8);
    for (const e of all) {
      const b = decodePng(e);
      expect([b.w, b.h]).toEqual([w, h]);
      expect(b.rgba.equals(a.rgba)).toBe(true);
    }
    const out = optimizePng(src);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(Math.min(...all.map((e) => e.length)));
    expect(out!.length).toBeLessThan(src.length);
  });

  test('the shipped Quake and Freedoom textures decode at their manifest sizes', async () => {
    const { decodePng } = await load();
    for (const dir of ['quake', 'freedoom']) {
      const base = new URL(`../public/maps/${dir}/textures/`, import.meta.url);
      const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8')) as Record<string, { file: string; w: number; h: number }>;
      const files = new Set(readdirSync(base).filter((f) => f.endsWith('.png')));
      for (const [name, e] of Object.entries(manifest)) {
        expect(files.has(e.file), `${dir}: ${name}`).toBe(true);
        const img = decodePng(readFileSync(new URL(e.file, base)));
        expect([img.w, img.h], `${dir}/${e.file}`).toEqual([e.w, e.h]);
      }
    }
  });
});
