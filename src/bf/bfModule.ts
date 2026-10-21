// Thin typed wrapper around the Betaflight WebAssembly build (public/bf/betaflight.mjs).
// The C API is defined in firmware/bfwasm (see firmware/README.md). This file owns the mapping
// between the simulator's body frame (FLU: x forward, y left, z up) and Betaflight's sensor frame.

export interface BfAxisMap {
  /** sign applied to (wx, wy, wz) FLU body rates before handing to bf_set_gyro_acc */
  gyro: [number, number, number];
  /** sign applied to (ax, ay, az) FLU specific force */
  acc: [number, number, number];
}

/**
 * Betaflight body convention: +roll = right wing down, +pitch = nose up, +yaw = nose right.
 * In FLU: right-wing-down is +wx, nose-up is -wy, nose-right is -wz. The firmware bridge documents
 * whether it expects already-converted BF-frame values; adjust here to match firmware/README.md.
 */
export const DEFAULT_AXIS_MAP: BfAxisMap = { gyro: [1, -1, -1], acc: [1, -1, -1] };

type EmModule = {
  HEAPU8: Uint8Array; HEAPU16: Uint16Array; HEAP16: Int16Array; HEAPF32: Float32Array;
  _malloc(n: number): number; _free(p: number): void;
  [k: `_bf_${string}`]: ((...a: number[]) => number) | undefined;
};

export class Betaflight {
  private m: EmModule;
  private pRc: number; private pMot: number; private pErpm: number; private pSer: number; private pAtt: number; private pDbg: number;
  axis: BfAxisMap = DEFAULT_AXIS_MAP;
  readonly version: string;

  private constructor(m: EmModule, version: string) {
    this.m = m;
    this.version = version;
    this.pRc = m._malloc(32);
    this.pMot = m._malloc(16);
    this.pErpm = m._malloc(16);
    this.pSer = m._malloc(4096);
    this.pAtt = m._malloc(12);
    this.pDbg = m._malloc(16);
  }

  /** Instantiate from an already-imported Emscripten factory (Node tests). */
  static async fromFactory(factory: (o: object) => Promise<unknown>): Promise<Betaflight> {
    const m = (await factory({ print: () => {}, printErr: () => {} })) as EmModule;
    return new Betaflight(m, 'Betaflight 4.5.5 (WASM)');
  }

  static async load(url = '/bf/betaflight.mjs'): Promise<Betaflight> {
    // Load the Emscripten ES module through a Blob URL: the file lives in /public (served as-is),
    // which Vite refuses to import directly in dev. wasm is located via locateFile below.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
    const mod = await import(/* @vite-ignore */ blobUrl);
    URL.revokeObjectURL(blobUrl);
    const factory = mod.default ?? mod.createBetaflight ?? mod;
    const m: EmModule = await factory({ locateFile: (p: string) => new URL(url.replace(/[^/]+$/, '') + p, self.location.origin).href, print: () => {}, printErr: () => {} });
    const fn = (m as any)._bf_version;
    let version = 'Betaflight 4.5.5 (WASM)';
    if (typeof fn === 'function') {
      const p = fn();
      if (p) { let s = ''; for (let i = p; m.HEAPU8[i] && i < p + 64; i++) s += String.fromCharCode(m.HEAPU8[i]); version = s; }
    }
    return new Betaflight(m, version);
  }

  private f(name: string): (...a: number[]) => number {
    const fn = (this.m as any)['_' + name];
    if (typeof fn !== 'function') throw new Error(`firmware export missing: ${name}`);
    return fn;
  }
  private has(name: string) { return typeof (this.m as any)['_' + name] === 'function'; }

  init(): number { return this.f('bf_init')(); }
  step(dtUs: number): void { this.f('bf_step')(dtUs); }

  /** Body rates (rad/s, FLU) and specific force (m/s², FLU). */
  setImu(wx: number, wy: number, wz: number, ax: number, ay: number, az: number): void {
    const g = this.axis.gyro, a = this.axis.acc;
    // never let a non-finite sample into the firmware: it would poison its filter states for good
    const ok = (v: number) => (Number.isFinite(v) ? v : 0);
    this.f('bf_set_gyro_acc')(ok(wx) * g[0], ok(wy) * g[1], ok(wz) * g[2], ok(ax) * a[0], ok(ay) * a[1], Number.isFinite(az) ? az * a[2] : 9.80665 * a[2]);
  }
  setRc(ch: ArrayLike<number>): void {
    const h = this.m.HEAPU16, base = this.pRc >> 1;
    for (let i = 0; i < 16; i++) h[base + i] = Math.round(ch[i] ?? 1500);
    this.f('bf_set_rc')(this.pRc);
  }
  /** RC link statistics (CRSF-style): LQ %, uplink RSSI dBm, RF mode index. No-op on older builds. */
  setLinkStats(lqPercent: number, rssiDbm: number, rfMode: number): void {
    if (this.has('bf_set_link_stats')) this.f('bf_set_link_stats')(lqPercent, rssiDbm, rfMode);
  }
  setBattery(volts: number, amps: number, mahDrawn: number): void { this.f('bf_set_battery')(volts, amps, mahDrawn); }
  setErpm(erpm: ArrayLike<number>): void {
    const h = this.m.HEAPF32, base = this.pErpm >> 2;
    for (let i = 0; i < 4; i++) h[base + i] = erpm[i];
    this.f('bf_set_erpm')(this.pErpm);
  }
  setBaro(pa: number): void { if (this.has('bf_set_baro')) this.f('bf_set_baro')(pa); }
  /** Fills out[0..3] with DShot values; returns true when armed. */
  getMotors(out: Uint16Array | number[]): boolean {
    const armed = this.f('bf_get_motors')(this.pMot);
    const h = this.m.HEAPU16, base = this.pMot >> 1;
    for (let i = 0; i < 4; i++) out[i] = h[base + i];
    return armed !== 0;
  }
  motorsReversed(): boolean { return this.has('bf_get_motor_reversed') ? this.f('bf_get_motor_reversed')() !== 0 : false; }

  serialWrite(port: number, data: Uint8Array): number {
    let off = 0;
    while (off < data.length) {
      const n = Math.min(4096, data.length - off);
      this.m.HEAPU8.set(data.subarray(off, off + n), this.pSer);
      const w = this.f('bf_serial_write')(port, this.pSer, n);
      if (w <= 0) break;
      off += w;
    }
    return off;
  }
  serialRead(port: number): Uint8Array {
    const chunks: Uint8Array[] = [];
    for (let guard = 0; guard < 64; guard++) {
      const n = this.f('bf_serial_read')(port, this.pSer, 4096);
      if (n <= 0) break;
      chunks.push(this.m.HEAPU8.slice(this.pSer, this.pSer + n));
      if (n < 4096) break;
    }
    if (chunks.length === 1) return chunks[0];
    const len = chunks.reduce((a, c) => a + c.length, 0), out = new Uint8Array(len);
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  osdFrame(): number { return this.f('bf_osd_frame')() >>> 0; }
  osdSize(): { cols: number; rows: number } { return { cols: this.f('bf_osd_cols')(), rows: this.f('bf_osd_rows')() }; }
  /** Copies the OSD char + attribute planes into dst (chars first, then attrs, each cols*rows). */
  osdCopy(dst: Uint8Array, maxCols: number, maxRows: number): { cols: number; rows: number } {
    const { cols, rows } = this.osdSize();
    const pc = this.f('bf_osd_chars')(), pa = this.f('bf_osd_attrs')();
    const h = this.m.HEAPU8;
    const c = Math.min(cols, maxCols), r = Math.min(rows, maxRows);
    for (let y = 0; y < r; y++) {
      dst.set(h.subarray(pc + y * cols, pc + y * cols + c), y * maxCols);
      dst.set(h.subarray(pa + y * cols, pa + y * cols + c), maxCols * maxRows + y * maxCols);
    }
    return { cols: c, rows: r };
  }

  eepromGet(): Uint8Array {
    const p = this.f('bf_eeprom_ptr')(), n = this.f('bf_eeprom_size')();
    return this.m.HEAPU8.slice(p, p + n);
  }
  eepromSet(data: Uint8Array): void {
    const p = this.f('bf_eeprom_ptr')(), n = this.f('bf_eeprom_size')();
    this.m.HEAPU8.set(data.subarray(0, n), p);
    this.f('bf_eeprom_loaded')(1);
  }
  eepromDirty(): boolean { return this.f('bf_eeprom_dirty')() !== 0; }

  armingDisableFlags(): number { return this.f('bf_arming_disable_flags')() >>> 0; }
  flightModeFlags(): number { return this.f('bf_get_flight_mode_flags')() >>> 0; }
  attitude(): [number, number, number] {
    this.f('bf_get_attitude')(this.pAtt);
    const h = this.m.HEAPF32, b = this.pAtt >> 2;
    return [h[b], h[b + 1], h[b + 2]];
  }
  /** debug[0..7] into `out` without allocating (for per-step sampling); false if not exported. */
  debugInto(out: Int16Array): boolean {
    if (!this.has('bf_get_debug')) return false;
    this.f('bf_get_debug')(this.pDbg);
    out.set(this.m.HEAP16.subarray(this.pDbg >> 1, (this.pDbg >> 1) + 8));
    return true;
  }
  debug(): number[] {
    if (!this.has('bf_get_debug')) return [];
    this.f('bf_get_debug')(this.pDbg);
    const h = this.m.HEAP16, b = this.pDbg >> 1;
    return Array.from(h.subarray(b, b + 8));
  }
}

/** Betaflight 4.5 armingDisableFlags_e names, bit order. */
export const ARMING_FLAG_NAMES = [
  'NO_GYRO', 'FAILSAFE', 'RX_FAILSAFE', 'BAD_RX_RECOVERY', 'BOXFAILSAFE', 'RUNAWAY_TAKEOFF', 'CRASH_DETECTED', 'THROTTLE',
  'ANGLE', 'BOOT_GRACE_TIME', 'NOPREARM', 'LOAD', 'CALIBRATING', 'CLI', 'CMS_MENU', 'BST', 'MSP', 'PARALYZE', 'GPS',
  'RESC', 'RPMFILTER', 'REBOOT_REQUIRED', 'DSHOT_BITBANG', 'ACC_CALIBRATION', 'MOTOR_PROTOCOL', 'ARM_SWITCH',
];

export function armingFlagNames(flags: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < ARMING_FLAG_NAMES.length; i++) if (flags & (1 << i)) out.push(ARMING_FLAG_NAMES[i]);
  return out;
}
