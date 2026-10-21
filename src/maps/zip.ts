// Minimal .zip reader for map packages (stored + deflate entries, no zip64, no encryption).
// Uses DecompressionStream('deflate-raw'), available in browsers, workers and Node >= 21.

export interface ZipEntry { path: string; size: number; read(): Promise<Uint8Array> }

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export async function inflate(data: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** List the files in a zip archive (directories omitted). Throws on archives it cannot read. */
export function readZip(buf: Uint8Array): ZipEntry[] {
  // end of central directory record: last 22 bytes + up to 64 KiB comment
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  if (p === 0xffffffff || count === 0xffff) throw new Error('zip64 archives are not supported');
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const flags = u16(buf, p + 8), method = u16(buf, p + 10);
    const csize = u32(buf, p + 20), size = u32(buf, p + 24);
    const nlen = u16(buf, p + 28), xlen = u16(buf, p + 30), clen = u16(buf, p + 32);
    const local = u32(buf, p + 42);
    const path = dec.decode(buf.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (path.endsWith('/')) continue;
    if (flags & 1) throw new Error(`${path}: encrypted zip entries are not supported`);
    if (method !== 0 && method !== 8) throw new Error(`${path}: unsupported zip compression method ${method}`);
    if (u32(buf, local) !== 0x04034b50) throw new Error(`${path}: corrupt zip local header`);
    const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
    const raw = buf.subarray(start, start + csize);
    out.push({ path, size, read: async () => (method === 0 ? raw.slice() : inflate(raw, 'deflate-raw')) });
  }
  return out;
}
