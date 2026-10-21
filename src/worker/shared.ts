// SharedArrayBuffer layout between the main thread (render / input) and the sim worker.
//
//   ctrl  Int32[16]   : [0] rcSeq  [1] ringHead  [2] osdSeq  [3] osdCols  [4] osdRows  [5] armed
//                       [6] simRunning  [7] fwState (0 none, 1 loading, 2 ok, 3 missing, 4 error)
//   rc    Float32[16] : RC channels in µs (1000..2000), written by main
//   ring  Float64[N*REC]: sim-state history, one record per RING_DT of sim time
//   osd   Uint8[2*64*32]: chars then attributes

export const RING_N = 2048;           // 2.048 s of history at 1 kHz
export const RING_DT = 0.001;         // s between records
export const REC = 40;                // float64 per record

// record field offsets
export const R = {
  t: 0, px: 1, py: 2, pz: 3, qw: 4, qx: 5, qy: 6, qz: 7, wx: 8, wy: 9, wz: 10,
  vx: 11, vy: 12, vz: 13, rpm0: 14, rpm1: 15, rpm2: 16, rpm3: 17,
  vbus: 18, ibus: 19, mah: 20, armed: 21, gx: 22, gy: 23, gz: 24,
  thr: 25, soc: 26, battTemp: 27, motorTemp: 28, vrs: 29, touching: 30, impact: 31,
  m0: 32, m1: 33, m2: 34, m3: 35, cellV: 36, crashFlip: 37, simRate: 38, damage: 39,
} as const;

export const OSD_MAX_COLS = 64, OSD_MAX_ROWS = 32;

export interface Shared {
  sab: SharedArrayBuffer;
  ctrl: Int32Array;
  rc: Float32Array;
  ring: Float64Array;
  osd: Uint8Array;
}

export function createShared(sab?: SharedArrayBuffer): Shared {
  const ctrlBytes = 16 * 4, rcBytes = 16 * 4, ringBytes = RING_N * REC * 8, osdBytes = 2 * OSD_MAX_COLS * OSD_MAX_ROWS;
  const total = ctrlBytes + rcBytes + ringBytes + osdBytes;
  const buf = sab ?? new SharedArrayBuffer(total);
  let o = 0;
  const ctrl = new Int32Array(buf, o, 16); o += ctrlBytes;
  const rc = new Float32Array(buf, o, 16); o += rcBytes;
  const ring = new Float64Array(buf, o, RING_N * REC); o += ringBytes;
  const osd = new Uint8Array(buf, o, 2 * OSD_MAX_COLS * OSD_MAX_ROWS);
  return { sab: buf, ctrl, rc, ring, osd };
}

/** Interpolated state at sim time t from the ring (returns false if t is outside the history). */
export function sampleRing(sh: Shared, t: number, out: Float64Array): boolean {
  const head = Atomics.load(sh.ctrl, 1);
  if (head <= 1) return false;
  const newest = (head - 1) % RING_N;
  const tNew = sh.ring[newest * REC];
  const back = Math.floor((tNew - t) / RING_DT);
  let i1 = head - 1 - Math.max(0, back);
  if (i1 < head - RING_N + 2) i1 = head - RING_N + 2;
  if (i1 < 1) i1 = 1;
  const a = ((i1 - 1) % RING_N) * REC, b = (i1 % RING_N) * REC;
  const ta = sh.ring[a], tb = sh.ring[b];
  const u = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 1;
  for (let k = 0; k < REC; k++) out[k] = sh.ring[a + k] + (sh.ring[b + k] - sh.ring[a + k]) * u;
  // quaternion: renormalise after lerp (nlerp), keep hemisphere
  if (sh.ring[a + 4] * sh.ring[b + 4] + sh.ring[a + 5] * sh.ring[b + 5] + sh.ring[a + 6] * sh.ring[b + 6] + sh.ring[a + 7] * sh.ring[b + 7] < 0) {
    for (let k = 4; k < 8; k++) out[k] = sh.ring[a + k] - (sh.ring[b + k] + sh.ring[a + k]) * u;
  }
  const n = Math.hypot(out[4], out[5], out[6], out[7]) || 1;
  for (let k = 4; k < 8; k++) out[k] /= n;
  return true;
}

export function newestTime(sh: Shared): number {
  const head = Atomics.load(sh.ctrl, 1);
  if (head <= 0) return 0;
  return sh.ring[((head - 1) % RING_N) * REC];
}

// ---------- worker messages ----------
export interface SimSettings {
  mapId: string;
  physicsHz: number;
  timeScale: number;
  damage: boolean;
  wind: { speed: number; direction: number; turbulence: number; gusts: number };
  propwash: number;
  rcLinkHz: number;     // ELRS packet rate
  ambientC: number;
  paused: boolean;
}

export const DEFAULT_SETTINGS: SimSettings = {
  mapId: 'field', physicsHz: 8000, timeScale: 1, damage: true,
  wind: { speed: 2.5, direction: 240, turbulence: 1, gusts: 2 },
  propwash: 1, rcLinkHz: 250, ambientC: 20, paused: false,
};

export type ToWorker =
  | { type: 'init'; sab: SharedArrayBuffer; spec: unknown; settings: SimSettings }
  | { type: 'spec'; spec: unknown }
  | { type: 'settings'; settings: SimSettings }
  | { type: 'reset'; repair?: boolean; fullBattery?: boolean }
  | { type: 'cli'; text: string }
  | { type: 'cliBatch'; lines: string[]; id: number }
  | { type: 'factoryReset' }
  | { type: 'spectrum'; on: boolean }
  | { type: 'registerMap'; id: string; info: { name: string; author: string; license: string }; urls: Record<string, string> };

export interface Telemetry {
  t: number;
  fw: string;
  armingFlags: number;
  armingFlagNames: string[];
  modeFlags: number;
  motorTemps: number[];
  rotorDamage: { thrust: number; broken: boolean }[];
  battery: { v: number; i: number; soc: number; mah: number; tempC: number; sag: number; cellV: number };
  simRate: number;
  stepCostUs: number;
  attitudeDeg: number[];
  crash: string | null;
  derived?: unknown;
}

export type FromWorker =
  | { type: 'ready'; fw: string }
  | { type: 'fwMissing'; reason: string }
  | { type: 'telemetry'; tel: Telemetry }
  | { type: 'cliOut'; text: string }
  | { type: 'cliBatchDone'; id: number; output: string }
  | { type: 'built'; info: unknown }
  | { type: 'log'; text: string }
  | { type: 'gate'; gate: number; t: number }
  | { type: 'spectrum'; spec: GyroSpectrum };

/**
 * Gyro noise spectra computed in the worker (the 1 kHz state ring is too slow for this).
 * raw/filtered: 3 axes (roll, pitch, yaw) x `bins` values, amplitude in dB re 1 °/s, bin k = k·binHz.
 * filtered comes from Betaflight's debug_mode = GYRO_FILTERED (integer °/s); hasFiltered stays false
 * until debug[0..2] has carried a GYRO_FILTERED-looking signal since the overlay was switched on.
 */
export interface GyroSpectrum {
  binHz: number;
  bins: number;
  raw: Float32Array;
  filtered: Float32Array;
  hasFiltered: boolean;
  /** worst-case level of Betaflight's 1 °/s debug rounding in this analysis: filtered detail below it is not real */
  filteredFloorDb: number;
  /** mechanical rotation frequency of each motor, Hz */
  motorHz: number[];
  /** blades per prop: blade-pass = motorHz · blades */
  blades: number;
}
