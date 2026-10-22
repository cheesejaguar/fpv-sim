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
  HEAPU8: Uint8Array; HEAPU16: Uint16Array; HEAP16: Int16Array; HEAP32: Int32Array; HEAPF32: Float32Array;
  _malloc(n: number): number; _free(p: number): void;
  [k: `_bf_${string}`]: ((...a: number[]) => number) | undefined;
};
type Fn = (...a: number[]) => number;

/** The firmware download started ahead of Betaflight.load (see prefetch). */
export interface FirmwarePrefetch {
  /** the Emscripten glue (.mjs) source */
  glue: Promise<string>;
  /** the compiled .wasm, ready to instantiate */
  wasm: Promise<WebAssembly.Module>;
}

/** Versioned URL suffix: a new firmware build always reaches the browser (see vite.config.ts). */
function versionQuery(bust?: string): string {
  const q = [typeof __FW_VERSION__ === 'string' ? `v=${__FW_VERSION__}` : '', bust ? `r=${bust}` : ''].filter(Boolean).join('&');
  return q ? `?${q}` : '';
}
const wasmUrlOf = (url: string, v: string) => new URL(url.replace(/[^/]+$/, '') + 'betaflight.wasm' + v, self.location.origin).href;

async function fetchOk(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(/\?.*$/, '')}`);
  return res;
}

/** Fetch + compile the .wasm, streaming when the server labels it application/wasm. */
async function compileWasm(url: string, init: RequestInit): Promise<WebAssembly.Module> {
  const res = await fetchOk(url, init);
  if (typeof WebAssembly.compileStreaming === 'function' && /application\/wasm/i.test(res.headers.get('Content-Type') ?? '')) return WebAssembly.compileStreaming(res);
  return WebAssembly.compile(await res.arrayBuffer());
}

export class Betaflight {
  private m: EmModule;
  private pRc: number; private pMot: number; private pErpm: number; private pSer: number; private pAtt: number; private pDbg: number; private pGps: number;
  axis: BfAxisMap = DEFAULT_AXIS_MAP;
  readonly version: string;
  // the exports, looked up once (a missing required one throws when called, as before; optional
  // ones are undefined on older builds and their wrappers degrade gracefully)
  private readonly xInit: Fn; private readonly xStep: Fn; private readonly xGyroAcc: Fn; private readonly xRc: Fn;
  private readonly xBattery: Fn; private readonly xErpm: Fn; private readonly xMotors: Fn;
  private readonly xSerWrite: Fn; private readonly xSerRead: Fn;
  private readonly xOsdFrame: Fn; private readonly xOsdCols: Fn; private readonly xOsdRows: Fn; private readonly xOsdChars: Fn; private readonly xOsdAttrs: Fn;
  private readonly xEepPtr: Fn; private readonly xEepSize: Fn; private readonly xEepLoaded: Fn; private readonly xEepDirty: Fn;
  private readonly xArmFlags: Fn; private readonly xModeFlags: Fn; private readonly xAttitude: Fn;
  private readonly oLinkStats?: Fn; private readonly oBaro?: Fn; private readonly oReversed?: Fn; private readonly oDebug?: Fn;
  private readonly oGyroRate?: Fn; private readonly oCalAcc?: Fn; private readonly oAccCal?: Fn; private readonly oAccCalibrating?: Fn;
  private readonly oBeeper?: Fn; private readonly oBeacon?: Fn; private readonly oYawSpin?: Fn; private readonly oCpuLoad?: Fn; private readonly oGps?: Fn;

  private constructor(m: EmModule, version: string) {
    this.m = m;
    this.version = version;
    const req = (name: string): Fn => {
      const fn = m[`_${name}` as `_bf_${string}`];
      return typeof fn === 'function' ? fn : () => { throw new Error(`firmware export missing: ${name}`); };
    };
    const opt = (name: string): Fn | undefined => {
      const fn = m[`_${name}` as `_bf_${string}`];
      return typeof fn === 'function' ? fn : undefined;
    };
    this.xInit = req('bf_init'); this.xStep = req('bf_step'); this.xGyroAcc = req('bf_set_gyro_acc'); this.xRc = req('bf_set_rc');
    this.xBattery = req('bf_set_battery'); this.xErpm = req('bf_set_erpm'); this.xMotors = req('bf_get_motors');
    this.xSerWrite = req('bf_serial_write'); this.xSerRead = req('bf_serial_read');
    this.xOsdFrame = req('bf_osd_frame'); this.xOsdCols = req('bf_osd_cols'); this.xOsdRows = req('bf_osd_rows'); this.xOsdChars = req('bf_osd_chars'); this.xOsdAttrs = req('bf_osd_attrs');
    this.xEepPtr = req('bf_eeprom_ptr'); this.xEepSize = req('bf_eeprom_size'); this.xEepLoaded = req('bf_eeprom_loaded'); this.xEepDirty = req('bf_eeprom_dirty');
    this.xArmFlags = req('bf_arming_disable_flags'); this.xModeFlags = req('bf_get_flight_mode_flags'); this.xAttitude = req('bf_get_attitude');
    this.oLinkStats = opt('bf_set_link_stats'); this.oBaro = opt('bf_set_baro'); this.oReversed = opt('bf_get_motor_reversed'); this.oDebug = opt('bf_get_debug');
    this.oGyroRate = opt('bf_set_gyro_rate'); this.oCalAcc = opt('bf_calibrate_acc'); this.oAccCal = opt('bf_acc_calibrated'); this.oAccCalibrating = opt('bf_acc_calibrating');
    this.oBeeper = opt('bf_get_beeper'); this.oBeacon = opt('bf_get_beacon'); this.oYawSpin = opt('bf_yaw_spin_detected'); this.oCpuLoad = opt('bf_cpu_load'); this.oGps = opt('bf_gps_info');
    this.pRc = m._malloc(32);
    this.pMot = m._malloc(16);
    this.pErpm = m._malloc(16);
    this.pSer = m._malloc(4096);
    this.pAtt = m._malloc(12);
    this.pDbg = m._malloc(16);
    this.pGps = m._malloc(64);
  }

  /**
   * Instantiate from an already-imported Emscripten factory (Node tests). wasm: an already compiled
   * module to instantiate (as load() does) instead of letting the glue fetch the .wasm itself.
   */
  static async fromFactory(factory: (o: object) => Promise<unknown>, wasm?: Promise<WebAssembly.Module>): Promise<Betaflight> {
    const m = await Betaflight.instantiate(factory, wasm);
    return new Betaflight(m, wasm ? Betaflight.readVersion(m) : 'Betaflight 4.5.5 (WASM)');
  }

  private static async instantiate(factory: (o: object) => Promise<unknown>, wasm?: Promise<WebAssembly.Module>): Promise<EmModule> {
    if (!wasm) return (await factory({ print: () => {}, printErr: () => {} })) as EmModule;
    // Emscripten has no failure path for instantiateWasm: a failed instantiation rejects this race
    let fail!: (e: unknown) => void;
    const failed = new Promise<never>((_, rej) => { fail = rej; });
    return (await Promise.race([failed, factory({
      instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
        wasm.then(async (module) => done(await WebAssembly.instantiate(module, imports), module)).catch(fail);
        return {}; // the exports arrive through done()
      },
      print: () => {}, printErr: () => {},
    })])) as EmModule;
  }

  private static readVersion(m: EmModule): string {
    const fn = (m as any)._bf_version;
    let version = 'Betaflight 4.5.5 (WASM)';
    if (typeof fn === 'function') {
      const p = fn();
      if (p) { let s = ''; for (let i = p; m.HEAPU8[i] && i < p + 64; i++) s += String.fromCharCode(m.HEAPU8[i]); version = s; }
    }
    return version;
  }

  /**
   * Start downloading the firmware now (both files in parallel, the .wasm compiled as it streams in),
   * to be handed to load() later: the worker calls this as soon as it starts, before it has a map or
   * a drone. The promises never count as unhandled rejections; load() reports a failure.
   */
  static prefetch(url = '/bf/betaflight.mjs'): FirmwarePrefetch {
    const v = versionQuery();
    const glue = fetchOk(url + v, {}).then((r) => r.text());
    const wasm = compileWasm(wasmUrlOf(url, v), { credentials: 'same-origin' });
    glue.catch(() => {}); wasm.catch(() => {});
    return { glue, wasm };
  }

  /** bust: extra query token (a retry after a failed download bypasses any cached copy) */
  static async load(url = '/bf/betaflight.mjs', opts: { signal?: AbortSignal; bust?: string; prefetched?: FirmwarePrefetch } = {}): Promise<Betaflight> {
    // Load the Emscripten ES module through a Blob URL: the file lives in /public (served as-is),
    // which Vite refuses to import directly in dev. The .wasm is fetched and compiled separately
    // (in parallel with the glue) and handed over through Module.instantiateWasm.
    const v = versionQuery(opts.bust);
    const init: RequestInit = { signal: opts.signal, cache: opts.bust ? 'reload' : 'default' };
    const pre = opts.bust ? undefined : opts.prefetched;
    const wasm = pre?.wasm ?? compileWasm(wasmUrlOf(url, v), { ...init, credentials: 'same-origin' });
    wasm.catch(() => {}); // awaited below, after the glue
    const text = await (pre?.glue ?? fetchOk(url + v, init).then((r) => r.text()));
    const blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const mod = await import(/* @vite-ignore */ blobUrl);
    URL.revokeObjectURL(blobUrl);
    const factory = mod.default ?? mod.createBetaflight ?? mod;
    const m = await Betaflight.instantiate(factory, wasm);
    return new Betaflight(m, Betaflight.readVersion(m));
  }

  init(): number { return this.xInit(); }
  step(dtUs: number): void { this.xStep(dtUs); }

  /** Body rates (rad/s, FLU) and specific force (m/s², FLU). */
  setImu(wx: number, wy: number, wz: number, ax: number, ay: number, az: number): void {
    const g = this.axis.gyro, a = this.axis.acc;
    // never let a non-finite sample into the firmware: it would poison its filter states for good
    this.xGyroAcc(
      (Number.isFinite(wx) ? wx : 0) * g[0], (Number.isFinite(wy) ? wy : 0) * g[1], (Number.isFinite(wz) ? wz : 0) * g[2],
      (Number.isFinite(ax) ? ax : 0) * a[0], (Number.isFinite(ay) ? ay : 0) * a[1], (Number.isFinite(az) ? az : 9.80665) * a[2],
    );
  }
  setRc(ch: ArrayLike<number>): void {
    const h = this.m.HEAPU16, base = this.pRc >> 1;
    for (let i = 0; i < 16; i++) h[base + i] = Math.round(ch[i] ?? 1500);
    this.xRc(this.pRc);
  }
  /** RC link statistics (CRSF-style): LQ %, uplink RSSI dBm, RF mode index. No-op on older builds. */
  setLinkStats(lqPercent: number, rssiDbm: number, rfMode: number): void { this.oLinkStats?.(lqPercent, rssiDbm, rfMode); }
  setBattery(volts: number, amps: number, mahDrawn: number): void { this.xBattery(volts, amps, mahDrawn); }
  setErpm(erpm: ArrayLike<number>): void {
    const h = this.m.HEAPF32, base = this.pErpm >> 2;
    for (let i = 0; i < 4; i++) h[base + i] = erpm[i];
    this.xErpm(this.pErpm);
  }
  setBaro(pa: number): void { this.oBaro?.(pa); }
  /** Fills out[0..3] with DShot values; returns true when armed. */
  getMotors(out: Uint16Array | number[]): boolean {
    const armed = this.xMotors(this.pMot);
    const h = this.m.HEAPU16, base = this.pMot >> 1;
    for (let i = 0; i < 4; i++) out[i] = h[base + i];
    return armed !== 0;
  }
  motorsReversed(): boolean { return this.oReversed ? this.oReversed() !== 0 : false; }

  serialWrite(port: number, data: Uint8Array): number {
    let off = 0;
    while (off < data.length) {
      const n = Math.min(4096, data.length - off);
      this.m.HEAPU8.set(data.subarray(off, off + n), this.pSer);
      const w = this.xSerWrite(port, this.pSer, n);
      if (w <= 0) break;
      off += w;
    }
    return off;
  }
  serialRead(port: number): Uint8Array {
    const chunks: Uint8Array[] = [];
    for (let guard = 0; guard < 64; guard++) {
      const n = this.xSerRead(port, this.pSer, 4096);
      if (n <= 0) break;
      chunks.push(this.m.HEAPU8.slice(this.pSer, this.pSer + n));
      if (n < 4096) break;
    }
    if (chunks.length === 1) return chunks[0];
    const len = chunks.reduce((a, c) => a + c.length, 0), out = new Uint8Array(len);
    let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  osdFrame(): number { return this.xOsdFrame() >>> 0; }
  osdSize(): { cols: number; rows: number } { return { cols: this.xOsdCols(), rows: this.xOsdRows() }; }
  /** Copies the OSD char + attribute planes into dst (chars first, then attrs, each cols*rows). */
  osdCopy(dst: Uint8Array, maxCols: number, maxRows: number): { cols: number; rows: number } {
    const { cols, rows } = this.osdSize();
    const pc = this.xOsdChars(), pa = this.xOsdAttrs();
    const h = this.m.HEAPU8;
    const c = Math.min(cols, maxCols), r = Math.min(rows, maxRows);
    for (let y = 0; y < r; y++) {
      dst.set(h.subarray(pc + y * cols, pc + y * cols + c), y * maxCols);
      dst.set(h.subarray(pa + y * cols, pa + y * cols + c), maxCols * maxRows + y * maxCols);
    }
    return { cols: c, rows: r };
  }

  eepromGet(): Uint8Array {
    const p = this.xEepPtr(), n = this.xEepSize();
    return this.m.HEAPU8.slice(p, p + n);
  }
  eepromSet(data: Uint8Array): void {
    const p = this.xEepPtr(), n = this.xEepSize();
    this.m.HEAPU8.set(data.subarray(0, n), p);
    this.xEepLoaded(1);
  }
  eepromDirty(): boolean { return this.xEepDirty() !== 0; }

  armingDisableFlags(): number { return this.xArmFlags() >>> 0; }
  flightModeFlags(): number { return this.xModeFlags() >>> 0; }
  attitude(): [number, number, number] {
    this.xAttitude(this.pAtt);
    const h = this.m.HEAPF32, b = this.pAtt >> 2;
    return [h[b], h[b + 1], h[b + 2]];
  }
  /** debug[0..7] into `out` without allocating (for per-step sampling); false if not exported. */
  debugInto(out: Int16Array): boolean {
    if (!this.oDebug) return false;
    this.oDebug(this.pDbg);
    out.set(this.m.HEAP16.subarray(this.pDbg >> 1, (this.pDbg >> 1) + 8));
    return true;
  }
  debug(): number[] {
    if (!this.oDebug) return [];
    this.oDebug(this.pDbg);
    const h = this.m.HEAP16, b = this.pDbg >> 1;
    return Array.from(h.subarray(b, b + 8));
  }

  // ---- realism extras (older firmware builds lack them: every wrapper degrades gracefully) ----
  /**
   * Output data rate of the simulated gyro chip (8000, 6400, 6664 or 3200 Hz). Takes effect at the
   * next boot, so call it before init(). Below 8 kHz, call setImu() only on steps where the chip
   * latched a fresh sample: Betaflight's gyro task then locks onto that timing (virtual EXTI).
   */
  setGyroRate(hz: number): void { this.oGyroRate?.(Math.round(hz)); }
  /** Start Betaflight's accelerometer level calibration (~0.4 s, quad level and still; saves itself). */
  calibrateAcc(): boolean { if (!this.oCalAcc) return false; this.oCalAcc(); return true; }
  /** The stored config holds an accelerometer calibration (true on builds without the check). */
  accCalibrated(): boolean { return this.oAccCal ? this.oAccCal() !== 0 : true; }
  /** A calibration started by calibrateAcc() is still averaging. */
  accCalibrating(): boolean { return this.oAccCalibrating ? this.oAccCalibrating() !== 0 : false; }
  /** The FC's buzzer output is on (Betaflight's own beeper sequences). */
  beeper(): boolean { return this.oBeeper ? this.oBeeper() !== 0 : false; }
  /** The ESCs are playing a DShot beacon tone (motors beeping). */
  beacon(): boolean { return this.oBeacon ? this.oBeacon() !== 0 : false; }
  /** Yaw spin recovery active (gyro yaw rate above yaw_spin_threshold). */
  yawSpinDetected(): boolean { return this.oYawSpin ? this.oYawSpin() !== 0 : false; }
  /** Betaflight's CPU load in % (emulated F7 task timings); 0 on older builds. */
  cpuLoad(): number { return this.oCpuLoad ? this.oCpuLoad() : 0; }
  /** GPS as the FC sees it, or null on builds without GPS. */
  gpsInfo(): BfGpsInfo | null {
    if (!this.oGps) return null;
    this.oGps(this.pGps);
    const h = this.m.HEAP32, b = this.pGps >> 2;
    return {
      state: h[b], fix: h[b + 1] !== 0, numSat: h[b + 2], lat: h[b + 3] / 1e7, lon: h[b + 4] / 1e7, altM: h[b + 5] / 100,
      groundSpeed: h[b + 6] / 100, courseDeg: h[b + 7] / 10, homeFix: h[b + 8] !== 0, homeDistM: h[b + 9], homeDirDeg: h[b + 10] / 10, // GPS_directionToHome is in decidegrees
    };
  }
}

/** Betaflight's GPS solution (bf_gps_info). state 5 = GPS_STATE_RECEIVING_DATA. */
export interface BfGpsInfo {
  state: number; fix: boolean; numSat: number; lat: number; lon: number; altM: number;
  groundSpeed: number; courseDeg: number; homeFix: boolean; homeDistM: number; homeDirDeg: number;
}

/** Host serial port index (UARTn = n - 1) of the simulator's default port assignment. */
export const BF_PORT = { cli: 0, blackbox: 1, gps: 2 } as const;

/** Betaflight 4.5 armingDisableFlags_e names, bit order (fc/runtime_config.h). */
export const ARMING_FLAG_NAMES = [
  'NO_GYRO', 'FAILSAFE', 'RX_FAILSAFE', 'NOT_DISARMED', 'BOXFAILSAFE', 'RUNAWAY_TAKEOFF', 'CRASH_DETECTED', 'THROTTLE',
  'ANGLE', 'BOOT_GRACE_TIME', 'NOPREARM', 'LOAD', 'CALIBRATING', 'CLI', 'CMS_MENU', 'BST', 'MSP', 'PARALYZE', 'GPS',
  'RESC', 'DSHOT_TELEM', 'REBOOT_REQUIRED', 'DSHOT_BITBANG', 'ACC_CALIBRATION', 'MOTOR_PROTOCOL', 'ARM_SWITCH',
];

export function armingFlagNames(flags: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < ARMING_FLAG_NAMES.length; i++) if (flags & (1 << i)) out.push(ARMING_FLAG_NAMES[i]);
  return out;
}
