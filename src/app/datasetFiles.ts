// File encoders for dataset export, in the browser without libraries: PNG (8-bit RGBA, 8-bit and
// 16-bit grayscale, zlib through CompressionStream('deflate')), a ZIP writer (stored entries: the
// PNGs are compressed already) and base64.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

/** zlib-wrapped deflate (RFC 1950), as PNG's IDAT wants. */
export async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}

export type PngKind = 'rgba8' | 'gray8' | 'gray16';

/**
 * Encode a PNG. data: rgba8 = 4 bytes per pixel; gray8 = 1; gray16 = Uint16Array (one value per
 * pixel, written big-endian as PNG requires). Rows top first.
 */
export async function encodePng(width: number, height: number, data: Uint8Array | Uint16Array, kind: PngKind): Promise<Uint8Array> {
  const bpp = kind === 'rgba8' ? 4 : kind === 'gray16' ? 2 : 1;
  const stride = width * bpp, raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter: none
    if (kind === 'gray16') {
      const src = data as Uint16Array;
      for (let x = 0; x < width; x++) { const v = src[y * width + x]; raw[o + 1 + 2 * x] = v >> 8; raw[o + 2 + 2 * x] = v & 255; }
    } else raw.set((data as Uint8Array).subarray(y * stride, (y + 1) * stride), o + 1);
  }
  const idat = await zlib(raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = kind === 'gray16' ? 16 : 8; // bit depth
  ihdr[9] = kind === 'rgba8' ? 6 : 0;   // colour type: RGBA / grayscale
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return concat([sig, ...chunks]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A ZIP archive of stored (uncompressed) entries, built incrementally. */
export class ZipWriter {
  private parts: Uint8Array[] = [];
  private central: Uint8Array[] = [];
  private offset = 0;
  private count = 0;
  readonly enc = new TextEncoder();

  get size() { return this.offset; }

  add(path: string, data: Uint8Array | string) {
    const body = typeof data === 'string' ? this.enc.encode(data) : data;
    const name = this.enc.encode(path), crc = crc32(body);
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, body.length, true);
    lv.setUint16(26, name.length, true); local.set(name, 30);
    const cen = new Uint8Array(46 + name.length), cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, body.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, this.offset, true); cen.set(name, 46);
    this.parts.push(local, body); this.central.push(cen);
    this.offset += local.length + body.length; this.count++;
  }

  finish(): Uint8Array {
    const cenSize = this.central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, this.count, true); ev.setUint16(10, this.count, true);
    ev.setUint32(12, cenSize, true); ev.setUint32(16, this.offset, true);
    return concat([...this.parts, ...this.central, end]);
  }
}

export function toBase64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}
