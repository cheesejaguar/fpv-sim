// QR code encoder for the "send to my phone" link: byte mode, versions 1-40, error correction L / M /
// Q / H, all eight masks scored with the standard penalty rules (ISO/IEC 18004), as in Project
// Nayuki's reference QR Code generator (MIT), which this follows. Encoded on the device: no QR
// service is ever asked (privacy.html promises no third-party requests).

export type Ecc = 'L' | 'M' | 'Q' | 'H';
const ECC_ORDER: Ecc[] = ['L', 'M', 'Q', 'H'];
const ECC_FORMAT: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// per version (index 0 unused), per level: error-correction codewords per block, and block count
const ECC_PER_BLOCK: Record<Ecc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS: Record<Ecc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** A QR symbol: size x size modules, modules[y][x] true = dark. */
export interface QrCode { version: number; size: number; ecc: Ecc; mask: number; modules: boolean[][] }

/** Data modules of a version (everything but function patterns), in bits. */
function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const a = Math.floor(ver / 7) + 2; n -= (25 * a - 10) * a - 55; if (ver >= 7) n -= 36; }
  return n;
}
const dataCodewords = (ver: number, ecc: Ecc) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecc][ver] * BLOCKS[ecc][ver];

// Reed-Solomon over GF(2^8), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data: number[], div: number[]): number[] {
  const r = new Array<number>(div.length).fill(0);
  for (const b of data) {
    const f = b ^ (r.shift() as number);
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

/** Split the data into blocks, add each block's error correction, interleave. */
function withEcc(data: number[], ver: number, ecc: Ecc): number[] {
  const nb = BLOCKS[ecc][ver], el = ECC_PER_BLOCK[ecc][ver], raw = Math.floor(rawModules(ver) / 8);
  const short = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const div = rsDivisor(el), blocks: number[][] = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - el + (i < short ? 0 : 1));
    k += d.length;
    const e = rsRemainder(d, div);
    if (i < short) d.push(0); // padding slot, skipped when interleaving
    blocks.push(d.concat(e));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - el || j >= short) out.push(b[i]); });
  return out;
}

function alignment(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
  const out = [6];
  for (let p = ver * 4 + 10; out.length < n; p -= step) out.splice(1, 0, p);
  return out;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly size: number; m: boolean[][]; fn: boolean[][];
  constructor(size: number) {
    this.size = size;
    this.m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  set(x: number, y: number, dark: boolean) { this.m[y][x] = dark; this.fn[y][x] = true; }
}

function drawFunction(g: Grid, ver: number) {
  const n = g.size;
  for (let i = 0; i < n; i++) { g.set(6, i, i % 2 === 0); g.set(i, 6, i % 2 === 0); } // timing
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < n && y >= 0 && y < n) g.set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  const al = alignment(ver), na = al.length;
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) g.set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(g, 'L', 0); // reserve (overwritten once the mask is chosen)
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const b = ((bits >>> i) & 1) !== 0, a = n - 11 + (i % 3), c = Math.floor(i / 3);
      g.set(a, c, b); g.set(c, a, b);
    }
  }
}

function drawFormat(g: Grid, ecc: Ecc, mask: number) {
  const data = (ECC_FORMAT[ecc] << 3) | mask;
  let r = data;
  for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  const bits = ((data << 10) | r) ^ 0x5412, bit = (i: number) => ((bits >>> i) & 1) !== 0, n = g.size;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6)); g.set(8, 8, bit(7)); g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, n - 15 + i, bit(i));
  g.set(8, n - 8, true); // the dark module
}

function drawCodewords(g: Grid, words: number[]) {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? n - 1 - v : v;
      if (!g.fn[y][x] && i < words.length * 8) { g.m[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
    }
  }
}

function applyMask(g: Grid, mask: number) {
  const f = MASKS[mask];
  for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (!g.fn[y][x] && f(x, y)) g.m[y][x] = !g.m[y][x];
}

/** Penalty score of a masked symbol (lower is better). */
function penalty(g: Grid): number {
  const n = g.size, m = g.m;
  let p = 0;
  const finderLike = (h: number[]) => {
    const c = h[1];
    const core = c > 0 && h[2] === c && h[3] === c * 3 && h[4] === c && h[5] === c;
    return (core && h[0] >= c * 4 && h[6] >= c ? 1 : 0) + (core && h[6] >= c * 4 && h[0] >= c ? 1 : 0);
  };
  const line = (get: (i: number) => boolean) => {
    let color = false, run = 0;
    const hist = [0, 0, 0, 0, 0, 0, 0];
    const push = (len: number) => { if (hist[0] === 0) len += n; hist.pop(); hist.unshift(len); };
    for (let i = 0; i < n; i++) {
      if (get(i) === color) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
      else { push(run); if (!color) p += finderLike(hist) * 40; color = get(i); run = 1; }
    }
    // end of the line: as if followed by the light quiet zone
    if (color) { push(run); run = 0; }
    run += n; push(run);
    p += finderLike(hist) * 40;
  };
  for (let y = 0; y < n; y++) line((x) => m[y][x]);
  for (let x = 0; x < n; x++) line((y) => m[y][x]);
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (m[y][x]) dark++;
    if (x < n - 1 && y < n - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  }
  const total = n * n;
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

/**
 * Encode text (UTF-8, byte mode) in the smallest version that fits at `ecc`, raising the error
 * correction level for free when the data still fits. Throws if it is longer than version 40 holds.
 */
export function encodeQr(text: string, ecc: Ecc = 'M'): QrCode {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  const bitsFor = (v: number) => 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
  for (; ver <= 40; ver++) if (bitsFor(ver) <= dataCodewords(ver, ecc) * 8) break;
  if (ver > 40) throw new Error('text too long for a QR code');
  for (const e of ECC_ORDER.slice(ECC_ORDER.indexOf(ecc) + 1)) if (bitsFor(ver) <= dataCodewords(ver, e) * 8) ecc = e;
  // bit stream: mode 0100, length, bytes, terminator, pad to a byte, then 0xEC 0x11 ...
  const bits: number[] = [];
  const put = (v: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(ver, ecc) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const g = new Grid(ver * 4 + 17);
  drawFunction(g, ver);
  drawCodewords(g, withEcc(data, ver, ecc));
  let best = 0, bestP = Infinity;
  for (let k = 0; k < 8; k++) {
    applyMask(g, k); drawFormat(g, ecc, k);
    const p = penalty(g);
    if (p < bestP) { bestP = p; best = k; }
    applyMask(g, k); // undo
  }
  applyMask(g, best); drawFormat(g, ecc, best);
  return { version: ver, size: g.size, ecc, mask: best, modules: g.m };
}

/** Draw a code onto a 2D context: dark modules on white, with the standard 4-module quiet zone. */
export function drawQr(ctx: CanvasRenderingContext2D, q: QrCode, x: number, y: number, px: number, dark = '#0f0f23', light = '#ffffff') {
  const quiet = 4, s = (q.size + quiet * 2) * px;
  ctx.fillStyle = light;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = dark;
  for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) if (q.modules[r][c]) ctx.fillRect(x + (c + quiet) * px, y + (r + quiet) * px, px, px);
}
