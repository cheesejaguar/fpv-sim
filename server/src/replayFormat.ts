// Lap replay files (.fpvreplay): a recorded lap's trajectory, motors, sticks, battery and OSD, as
// written by the sim (src/app/replayRecorder.ts), stored with a leaderboard entry, checked by the
// relay (replayCheck.ts) and played back by the replay player. Platform-independent: browsers,
// Workers and Node all have CompressionStream. The format is described in docs/REPLAY_FORMAT.md.
//
//   bytes 0-3  "FPVR"            bytes 4  format version (REPLAY_VERSION)
//   byte  5    compression (1 = gzip)   bytes 6-7  reserved, 0
//   bytes 8-   gzip of: varint header length, header (UTF-8 JSON, ReplayHeader), then one block
//              per header column (varint byte length + `n` zigzag varints: the column quantized to
//              its step `q` and differenced `d` times), then varint OSD byte length + OSD frames.
//
// Columns are stored one after another (all x, then all y …), and smooth signals are differenced
// twice (a position's second difference is its acceleration · dt², a few mm at 100 Hz), so almost
// every value fits one byte and gzip packs the rest. Every block carries its length: a reader skips
// columns it doesn't know or need (the relay decodes the position only).

export const REPLAY_MAGIC = 'FPVR';
export const REPLAY_VERSION = 1;
export const REPLAY_EXT = '.fpvreplay';
export const REPLAY_MIME = 'application/vnd.fpv-sim.replay';
/** Largest replay the relay stores (compressed), and the most a reader inflates (a gzip bomb stops here). */
export const MAX_REPLAY_BYTES = 256 * 1024;
export const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

/** One stored signal: id, quantization step (units per integer step), difference order. */
export interface ColumnDef { id: string; q: number; d: 0 | 1 | 2 }

/** A gate pass: gate id and lap time (s) — 0 for the start through gate 0, the lap time for its finish. */
export interface GatePass { id: number; t: number }

export interface ReplayHeader {
  v: number;
  /** app version and commit that recorded it */
  app: string; commit?: string;
  /** ms since the epoch: when the lap was finished */
  date: number;
  map: string; course: string;
  /** leaderboard class and drone summary (as on the board) */
  cls: string; summary: string;
  /** the lap as the leaderboard has it (integer ms; splits: since gate 0, the last one is the lap) */
  lapMs: number; splitsMs: number[];
  /** every gate passed, in order, from the start through gate 0 to the finish through it */
  gates: GatePass[];
  /** samples per second, sample count, and the lap time (s) of sample 0 (≤ 0: a pre-roll before gate 0) */
  rate: number; n: number; t0: number;
  /** the drone build (DroneSpec): the player builds the same model and FPV camera from it */
  spec: unknown;
  timeScale: number; physicsHz: number;
  wind?: { speed: number; direction: number; turbulence: number; gusts: number };
  timeOfDay?: string;
  /** why the lap doesn't count for the leaderboard (null: it does); laps that don't count are kept locally */
  invalid?: string | null;
  cols: ColumnDef[];
  /** OSD grid recorded (frames in the OSD block) */
  osd?: boolean;
}

/** Columns the sim records (units: m, unit quaternion, rpm, RC µs, V, A, mAh, 0/1, flag bits, 0..1). */
export const COLUMNS: readonly ColumnDef[] = Object.freeze([
  { id: 'px', q: 0.001, d: 2 }, { id: 'py', q: 0.001, d: 2 }, { id: 'pz', q: 0.001, d: 2 },
  { id: 'qw', q: 1 / 8192, d: 2 }, { id: 'qx', q: 1 / 8192, d: 2 }, { id: 'qy', q: 1 / 8192, d: 2 }, { id: 'qz', q: 1 / 8192, d: 2 },
  { id: 'rpm0', q: 25, d: 1 }, { id: 'rpm1', q: 25, d: 1 }, { id: 'rpm2', q: 25, d: 1 }, { id: 'rpm3', q: 25, d: 1 },
  { id: 'rc0', q: 1, d: 1 }, { id: 'rc1', q: 1, d: 1 }, { id: 'rc2', q: 1, d: 1 }, { id: 'rc3', q: 1, d: 1 },
  { id: 'vbus', q: 0.01, d: 1 }, { id: 'ibus', q: 0.1, d: 1 }, { id: 'mah', q: 0.1, d: 1 },
  { id: 'armed', q: 1, d: 1 }, { id: 'modes', q: 1, d: 1 }, { id: 'vrs', q: 0.01, d: 1 },
]);
export const REQUIRED_COLUMNS = ['px', 'py', 'pz', 'qw', 'qx', 'qy', 'qz'] as const;

/** OSD changes at one moment: ms since sample 0, the grid size, and the cells that changed (index y·64 + x). */
export interface OsdFrame { ms: number; cols: number; rows: number; idx: Uint16Array; ch: Uint8Array; attr: Uint8Array }
export const OSD_STRIDE = 64, OSD_CELLS = 64 * 32;

export interface ReplayData { header: ReplayHeader; columns: Record<string, Float64Array>; osd: OsdFrame[] }

// ---------------------------------------------------------------------------------------------
// varints (unsigned LEB128) of zigzag-mapped integers. Plain arithmetic, not 32-bit bit operations,
// so any integer below 2^53 survives.

class Writer {
  buf = new Uint8Array(1024); n = 0;
  private grow(k: number) { if (this.n + k > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); b.set(this.buf.subarray(0, this.n)); this.buf = b; } }
  byte(b: number) { this.grow(1); this.buf[this.n++] = b; }
  uvar(v: number) {
    this.grow(8);
    while (v >= 128) { this.buf[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.buf[this.n++] = v;
  }
  svar(v: number) { this.uvar(v >= 0 ? 2 * v : -2 * v - 1); }
  bytes(b: Uint8Array) { this.grow(b.length); this.buf.set(b, this.n); this.n += b.length; }
  get out() { return this.buf.subarray(0, this.n); }
}

class Reader {
  p = 0;
  constructor(readonly b: Uint8Array, readonly end = b.length) {}
  uvar(): number {
    let v = 0, mul = 1, x: number;
    do {
      if (this.p >= this.end) throw new Error('truncated replay');
      x = this.b[this.p++];
      v += (x & 127) * mul; mul *= 128;
      if (mul > 2 ** 56) throw new Error('corrupt replay (varint too long)');
    } while (x & 128);
    return v;
  }
  svar(): number { const u = this.uvar(); return u % 2 ? -(u + 1) / 2 : u / 2; }
  byte(): number { if (this.p >= this.end) throw new Error('truncated replay'); return this.b[this.p++]; }
}

// ---------------------------------------------------------------------------------------------
// gzip

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream, max: number): Promise<Uint8Array> {
  const reader = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(t).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); throw new Error('replay too big'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Encoding

/** Quantize, difference and varint-encode one column. */
export function encodeColumn(values: ArrayLike<number>, c: ColumnDef, w = new Writer()): Uint8Array {
  let a = 0, b = 0; // the previous two quantized values
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    const q = Number.isFinite(x) ? Math.round(x / c.q) : 0;
    const d = c.d === 0 || i === 0 ? q : c.d === 1 || i === 1 ? q - a : q - 2 * a + b;
    w.svar(d);
    b = a; a = q;
  }
  return w.out;
}

/** Decode `n` values of a column (`r` positioned at its first varint). */
function decodeColumn(r: Reader, n: number, c: ColumnDef): Float64Array {
  const out = new Float64Array(n);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const d = r.svar();
    const q = c.d === 0 || i === 0 ? d : c.d === 1 || i === 1 ? a + d : d + 2 * a - b;
    out[i] = q * c.q;
    b = a; a = q;
  }
  return out;
}

/** Quaternions q and −q are the same attitude: keep each sample in the hemisphere of the one before, so the stream stays smooth. */
export function continuousQuats(w: Float64Array, x: Float64Array, y: Float64Array, z: Float64Array) {
  for (let i = 1; i < w.length; i++) {
    if (w[i] * w[i - 1] + x[i] * x[i - 1] + y[i] * y[i - 1] + z[i] * z[i - 1] < 0) { w[i] = -w[i]; x[i] = -x[i]; y[i] = -y[i]; z[i] = -z[i]; }
  }
}

function encodeOsd(frames: readonly OsdFrame[], w: Writer) {
  let ms = 0, cols = -1, rows = -1;
  for (const f of frames) {
    const resize = f.cols !== cols || f.rows !== rows;
    w.uvar(Math.max(0, Math.round(f.ms - ms))); ms = Math.max(ms, Math.round(f.ms));
    w.uvar(resize ? 1 : 0);
    if (resize) { w.uvar(f.cols); w.uvar(f.rows); cols = f.cols; rows = f.rows; }
    w.uvar(f.idx.length);
    let prev = -1;
    for (let k = 0; k < f.idx.length; k++) { w.uvar(f.idx[k] - prev - 1); prev = f.idx[k]; w.byte(f.ch[k]); w.byte(f.attr[k]); }
  }
}

/** The .fpvreplay bytes of a recording. `columns` must hold `header.n` values for each of header.cols. */
export async function encodeReplay(d: ReplayData): Promise<Uint8Array> {
  const h = d.header, w = new Writer();
  const head = new TextEncoder().encode(JSON.stringify({ ...h, osd: d.osd.length > 0 }));
  w.uvar(head.length); w.bytes(head);
  for (const c of h.cols) {
    const v = d.columns[c.id];
    if (!v || v.length !== h.n) throw new Error(`replay column ${c.id}: expected ${h.n} values`);
    const block = encodeColumn(v, c);
    w.uvar(block.length); w.bytes(block);
  }
  const osd = new Writer();
  encodeOsd(d.osd, osd);
  w.uvar(osd.n); w.bytes(osd.out);
  const body = await pipe(w.out, new CompressionStream('gzip'), MAX_INFLATED_BYTES * 2);
  const out = new Uint8Array(8 + body.length);
  out.set([0x46, 0x50, 0x56, 0x52, REPLAY_VERSION, 1, 0, 0]);
  out.set(body, 8);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Decoding

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The header fields every reader relies on, checked; throws on a file that isn't a replay of this format. */
function checkHeader(raw: unknown): ReplayHeader {
  if (!isObj(raw)) throw new Error('corrupt replay header');
  const h = raw as unknown as ReplayHeader;
  if (h.v !== REPLAY_VERSION) throw new Error(`unsupported replay version ${String(h.v)}`);
  if (typeof h.map !== 'string' || typeof h.course !== 'string' || typeof h.cls !== 'string') throw new Error('replay header: track');
  if (!num(h.rate) || h.rate < 10 || h.rate > 1000 || !Number.isInteger(h.n) || h.n < 2 || h.n > 2_000_000 || !num(h.t0)) throw new Error('replay header: samples');
  if (!num(h.lapMs) || !Array.isArray(h.splitsMs) || !h.splitsMs.every(num)) throw new Error('replay header: lap');
  if (!Array.isArray(h.gates) || !h.gates.every((g) => isObj(g) && Number.isInteger(g.id) && num(g.t))) throw new Error('replay header: gates');
  if (!Array.isArray(h.cols) || !h.cols.every((c) => isObj(c) && typeof c.id === 'string' && num(c.q) && c.q > 0 && (c.d === 0 || c.d === 1 || c.d === 2))) throw new Error('replay header: columns');
  for (const id of REQUIRED_COLUMNS) if (!h.cols.some((c) => c.id === id)) throw new Error(`replay without ${id}`);
  return h;
}

/** Inflate and read the header; `body` is the inflated payload, `at` where the columns start. */
export async function openReplay(bytes: Uint8Array, maxInflated = MAX_INFLATED_BYTES): Promise<{ header: ReplayHeader; body: Uint8Array; at: number }> {
  if (bytes.length < 9 || bytes[0] !== 0x46 || bytes[1] !== 0x50 || bytes[2] !== 0x56 || bytes[3] !== 0x52) throw new Error('not an FPV Sim replay');
  if (bytes[4] !== REPLAY_VERSION) throw new Error(`unsupported replay version ${bytes[4]} (this version reads ${REPLAY_VERSION})`);
  if (bytes[5] !== 1) throw new Error('unknown replay compression');
  let body: Uint8Array;
  try { body = await pipe(bytes.subarray(8), new DecompressionStream('gzip'), maxInflated); } catch (e) { throw new Error((e as Error).message === 'replay too big' ? 'replay too big' : 'corrupt replay (gzip)'); }
  const r = new Reader(body);
  const len = r.uvar();
  if (len > MAX_HEADER_BYTES || r.p + len > body.length) throw new Error('corrupt replay header');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(body.subarray(r.p, r.p + len))); } catch { throw new Error('corrupt replay header'); }
  return { header: checkHeader(raw), body, at: r.p + len };
}

/** Decode the columns in `only` (default: every column) of an opened replay, plus the OSD frames if asked. */
export function readColumns(o: { header: ReplayHeader; body: Uint8Array; at: number }, only?: readonly string[], withOsd = true): { columns: Record<string, Float64Array>; osd: OsdFrame[] } {
  const { header: h, body } = o;
  const r = new Reader(body);
  r.p = o.at;
  const columns: Record<string, Float64Array> = Object.create(null);
  for (const c of h.cols) {
    const len = r.uvar(), end = r.p + len;
    if (end > body.length) throw new Error('truncated replay');
    if (!only || only.includes(c.id)) {
      const cr = new Reader(body, end);
      cr.p = r.p;
      columns[c.id] = decodeColumn(cr, h.n, c);
    }
    r.p = end;
  }
  const osd: OsdFrame[] = [];
  if (withOsd && r.p < body.length) {
    const len = r.uvar(), end = Math.min(body.length, r.p + len);
    const or = new Reader(body, end);
    or.p = r.p;
    let ms = 0, cols = 30, rows = 16;
    while (or.p < end) {
      ms += or.uvar();
      if (or.uvar() & 1) { cols = Math.min(OSD_STRIDE, or.uvar()); rows = Math.min(32, or.uvar()); }
      const m = Math.min(OSD_CELLS, or.uvar());
      const idx = new Uint16Array(m), ch = new Uint8Array(m), attr = new Uint8Array(m);
      let prev = -1;
      for (let k = 0; k < m; k++) { prev += or.uvar() + 1; idx[k] = Math.min(OSD_CELLS - 1, prev); ch[k] = or.byte(); attr[k] = or.byte(); }
      osd.push({ ms, cols, rows, idx, ch, attr });
    }
  }
  return { columns, osd };
}

/** A whole replay: header, every column, the OSD. */
export async function decodeReplay(bytes: Uint8Array): Promise<ReplayData> {
  const o = await openReplay(bytes);
  const { columns, osd } = readColumns(o);
  return { header: o.header, columns, osd };
}
