// SharedArrayBuffer layout between the main thread (render / input) and the sim worker.
//
//   ctrl  Int32[16]   : [0] rcSeq  [1] ringHead  [2] osdSeq  [3] osdCols  [4] osdRows  [5] armed
//                       [6] simRunning  [7] fwState (0 none, 1 loading, 2 ok, 3 missing, 4 error)
//                       [8] stickHead (samples written to `sticks`)  [9] live FC sound: bit0 beeper, bit1 DShot beacon
//                       [10] map actors: detectors holding a detection (bit k = detector k in map order)
//                       [11] map actors: targets the quad is at (bit k = target k within its radius)
//   rc    Float32[16] : RC channels in µs (1000..2000), written by main (newest poll)
//   ring  Float64[N*REC]: sim-state history, one record per RING_DT of sim time
//   osd   Uint8[2*64*32]: chars then attributes
//   sticks Float64[STICK_N*STICK_REC]: timestamped stick samples {t, ch0..15}; t in ms since the
//                       epoch (performance.timeOrigin + now), so main and worker clocks compare

export const RING_N = 2048;           // 2.048 s of history at 1 kHz
export const RING_DT = 0.001;         // s between records
export const REC = 44;                // float64 per record

// record field offsets
export const R = {
  t: 0, px: 1, py: 2, pz: 3, qw: 4, qx: 5, qy: 6, qz: 7, wx: 8, wy: 9, wz: 10,
  vx: 11, vy: 12, vz: 13, rpm0: 14, rpm1: 15, rpm2: 16, rpm3: 17,
  vbus: 18, ibus: 19, mah: 20, armed: 21, gx: 22, gy: 23, gz: 24,
  thr: 25, soc: 26, battTemp: 27, motorTemp: 28, vrs: 29, touching: 30, impact: 31,
  m0: 32, m1: 33, m2: 34, m3: 35, cellV: 36, crashFlip: 37, simRate: 38, damage: 39,
  // the RC channels Betaflight last received (roll, pitch, throttle, yaw; µs), for lap replays
  rc0: 40, rc1: 41, rc2: 42, rc3: 43,
} as const;

export const OSD_MAX_COLS = 64, OSD_MAX_ROWS = 32;
export const STICK_N = 64, STICK_REC = 17; // ~64 ms of 1 kHz polls

export interface Shared {
  sab: SharedArrayBuffer;
  ctrl: Int32Array;
  rc: Float32Array;
  ring: Float64Array;
  osd: Uint8Array;
  sticks: Float64Array;
}

export function createShared(sab?: SharedArrayBuffer): Shared {
  const ctrlBytes = 16 * 4, rcBytes = 16 * 4, ringBytes = RING_N * REC * 8, osdBytes = 2 * OSD_MAX_COLS * OSD_MAX_ROWS, stickBytes = STICK_N * STICK_REC * 8;
  const total = ctrlBytes + rcBytes + ringBytes + osdBytes + stickBytes;
  const buf = sab ?? new SharedArrayBuffer(total);
  let o = 0;
  const ctrl = new Int32Array(buf, o, 16); o += ctrlBytes;
  const rc = new Float32Array(buf, o, 16); o += rcBytes;
  const ring = new Float64Array(buf, o, RING_N * REC); o += ringBytes;
  const osd = new Uint8Array(buf, o, 2 * OSD_MAX_COLS * OSD_MAX_ROWS); o += osdBytes;
  const sticks = new Float64Array(buf, o, STICK_N * STICK_REC);
  return { sab: buf, ctrl, rc, ring, osd, sticks };
}

/**
 * Main thread: append one stick sample taken at absolute time tMs (performance.timeOrigin + the
 * Gamepad's timestamp, or + performance.now()). Kept monotonic so the reader can stop at the first
 * sample that is old enough.
 */
export function writeStick(sh: Shared, tMs: number, ch: ArrayLike<number>): void {
  const n = Atomics.load(sh.ctrl, 8), s = sh.sticks;
  if (n > 0) { const prev = s[((n - 1) % STICK_N) * STICK_REC]; if (tMs < prev) tMs = prev; }
  const o = (n % STICK_N) * STICK_REC;
  s[o] = tMs;
  for (let i = 0; i < 16; i++) s[o + 1 + i] = ch[i] ?? 1500;
  Atomics.store(sh.ctrl, 8, n + 1);
}

/**
 * Worker: copy into `out` the newest stick sample taken at or before tMs (no interpolation: a real
 * handset sends whatever it sampled last). False if the ring is empty; when every held sample is
 * newer than tMs the oldest one is used.
 */
export function stickAt(sh: Shared, tMs: number, out: Float32Array | number[]): boolean {
  const n = Atomics.load(sh.ctrl, 8), s = sh.sticks;
  if (n <= 0) return false;
  // never read the slot the writer may be filling next: at most STICK_N - 2 back
  const oldest = Math.max(0, n - (STICK_N - 1));
  let i = n - 1;
  while (i > oldest && s[(i % STICK_N) * STICK_REC] > tMs) i--;
  const o = (i % STICK_N) * STICK_REC;
  for (let k = 0; k < 16; k++) out[k] = s[o + 1 + k];
  return true;
}

const EV_N = 32;   // stick-change events kept by StickSampler (≥ 40 ms of a 4 ms input)
const GAP_N = 15;  // gaps in the input-rate median

/**
 * Per-packet stick sampling for the RC link (worker), as a real handset + ELRS receiver hand the FC
 * a fresh stick value in every packet.
 *
 * Fast inputs (updating about as often as the packets or faster: Chrome reads XInput / USB pads at
 * 250 Hz on its own clock): each packet takes the newest sample taken at least latencyMs + offsetMs
 * before its slot, no interpolation, a near-constant latency. Sampling right at an update edge
 * would pick the older or the newer report at random (timer jitter), duplicating / skipping
 * packets, which Betaflight's feedforward turns into spikes. Like ELRS "mixer sync" aligning a
 * handset's stick sampling to the RF packets, offsetMs slowly moves the sampling instant to the
 * middle between input updates (and wraps by one update period if the clocks drift). Inputs
 * updating much faster than the packets (gaps < minGapMs) don't have that problem: there the offset
 * stays put.
 *
 * Slow inputs (a radio in BLE joystick mode reports at ~30-90 Hz, irregularly): the newest sample
 * would hand Betaflight a staircase, 2-6 identical packets and then a jump, which no real quad sees
 * (its receiver gets a fresh value every packet). Betaflight's feedforward treats the jump as the
 * stick moving 2-6 packets' worth in one packet interval (it assumes at most one duplicate) and its
 * 250 Hz RC smoothing passes the steps: ~2-3x feedforward spikes at the input rate, the motors
 * slammed from idle to full on yaw (no D, no feedforward rate limit there), a "snap" turn. The
 * update interval is measured (median gap between stick changes, inputMs) and the stick channels
 * are reconstructed between reports: the stick is taken to move linearly from one report to the
 * next over at most about one update interval (a longer gap is a pause, then a move), and each
 * packet gets that reconstruction interpMs = inputMs + visMarginMs in the past, so the next report
 * is normally already in. Latency trade-off: the staircase was already late by half an interval on
 * average plus the mixer-sync offset, so the reconstruction costs only a few ms more (measured in
 * tests/stickPath.test.ts: 13.5 -> 17.1 ms at 90 Hz, 21.2 -> 23.3 ms at 60 Hz, 25.6 -> 32.2 ms at
 * 40 Hz); a missed or late report holds the last value until it arrives, then catches up (no
 * jump). AUX channels (switches) are never delayed or interpolated. The delay switches in and out
 * slowly (slewMs per packet), so the device being recognised never steps the sticks.
 */
export class StickSampler {
  offsetMs = 0;
  /** RC packet interval (ms); the worker keeps it at 1000 / rcLinkHz. */
  packetMs = 4;
  /** Measured update interval of the input device (ms): median gap between stick changes; 0 = not yet known. */
  inputMs = 0;
  /** Reconstruction delay in use (ms); 0 = fast input, newest sample. */
  interpMs = 0;
  private wantMs = 0;
  private evT = new Float64Array(EV_N); private evV = new Float64Array(EV_N * 4); private evN = 0;
  private seen = 0;
  private gaps: number[] = [];
  private sorted: number[] = [];
  /**
   * visMarginMs: a report reaches the ring up to ~5 ms after its timestamp (the browser stamps an HID
   * report when it arrives, then polls gamepads every 4 ms on Windows, then our poll); latencyMs covers
   * 2.5 of it, this the rest, so the next report is in before the reconstruction needs it.
   */
  constructor(public latencyMs = 2.5, public gain = 0.05, public maxOffsetMs = 10, public minGapMs = 2.5,
    public maxInterpMs = 40, public slewMs = 0.25, public visMarginMs = 3) {}

  /** Fill `out` for the packet slot at tMs (ms since the epoch); false if no sample exists. */
  sample(sh: Shared, tMs: number, out: Float32Array | number[]): boolean {
    const n = Atomics.load(sh.ctrl, 8), s = sh.sticks;
    if (n <= 0) return false;
    this.track(sh, n);
    const T = tMs - this.latencyMs - this.offsetMs;
    const oldest = Math.max(0, n - (STICK_N - 1));
    let i = n - 1;
    while (i > oldest && s[(i % STICK_N) * STICK_REC] > T) i--;
    const ti = s[(i % STICK_N) * STICK_REC];
    // the next update after the chosen one (equal timestamps = the same report polled again)
    let j = i + 1;
    while (j < n && s[(j % STICK_N) * STICK_REC] <= ti) j++;
    if (this.interpMs === 0 && j < n && ti <= T) {
      const gap = s[(j % STICK_N) * STICK_REC] - ti;
      if (gap >= this.minGapMs && gap < 50) {
        this.offsetMs += this.gain * ((T - ti) - gap / 2); // aim for mid-way between updates
        // drifting clocks: slip by one update, with a quarter-gap of hysteresis so jitter can't toggle it
        if (this.offsetMs > Math.min(this.maxOffsetMs, 1.25 * gap)) this.offsetMs -= gap;
        if (this.offsetMs < -0.25 * gap) this.offsetMs += gap;
        this.offsetMs = Math.max(-0.4 * this.latencyMs, Math.min(this.maxOffsetMs, this.offsetMs));
      }
    }
    const o = (i % STICK_N) * STICK_REC;
    for (let k = 0; k < 16; k++) out[k] = s[o + 1 + k];
    // slow input: sticks from the reconstruction, interpMs in the past
    if (this.interpMs > 0 && this.evN > 0) for (let c = 0; c < 4; c++) out[c] = this.recon(T - this.interpMs, c);
    // the delay follows the measured input rate, with hysteresis; pads the browser polls at 250 Hz
    // (4 ms) always keep the newest-sample path, whatever the link rate
    if (this.inputMs > Math.max(1.5 * this.packetMs, 6)) this.wantMs = Math.min(this.inputMs + this.visMarginMs, this.maxInterpMs);
    else if (this.inputMs < Math.max(1.25 * this.packetMs, 5)) this.wantMs = 0;
    this.interpMs = Math.max(0, this.interpMs + Math.max(-this.slewMs, Math.min(this.slewMs, this.wantMs - this.interpMs)));
    return true;
  }

  /** Consume new ring samples: stick-change events (channels 0..3) and the input's update interval. */
  private track(sh: Shared, n: number): void {
    const s = sh.sticks;
    for (let i = Math.max(this.seen, n - (STICK_N - 1)); i < n; i++) {
      const o = (i % STICK_N) * STICK_REC, t = s[o];
      const last = this.evN - 1, lo = (last % EV_N) * 4;
      if (this.evN > 0 && s[o + 1] === this.evV[lo] && s[o + 2] === this.evV[lo + 1] && s[o + 3] === this.evV[lo + 2] && s[o + 4] === this.evV[lo + 3]) continue;
      const gap = this.evN > 0 ? t - this.evT[last % EV_N] : Infinity;
      if (gap < 0.3) { for (let c = 0; c < 4; c++) this.evV[lo + c] = s[o + 1 + c]; continue; } // same report, value settled
      if (gap < 60) {
        this.gaps.push(gap);
        if (this.gaps.length > GAP_N) this.gaps.shift();
        if (this.gaps.length >= 5) {
          const g = this.sorted; g.length = 0; for (const x of this.gaps) g.push(x);
          g.sort((a, b) => a - b);
          this.inputMs = g[g.length >> 1];
        }
      }
      const k = this.evN % EV_N;
      this.evT[k] = t; for (let c = 0; c < 4; c++) this.evV[k * 4 + c] = s[o + 1 + c];
      this.evN++;
    }
    this.seen = n;
  }

  /**
   * Stick channel c at time tau: linear from each report to the next over at most interpMs (a longer
   * gap was a pause: hold, then the move); the newest report holds until the next one arrives.
   */
  private recon(tau: number, c: number): number {
    const first = Math.max(0, this.evN - EV_N);
    let k = this.evN - 1;
    while (k > first && this.evT[k % EV_N] > tau) k--;
    const v0 = this.evV[(k % EV_N) * 4 + c];
    if (k === this.evN - 1 || this.evT[k % EV_N] > tau) return v0;
    const t0 = this.evT[k % EV_N], t1 = this.evT[(k + 1) % EV_N], v1 = this.evV[((k + 1) % EV_N) * 4 + c];
    const start = Math.max(t0, t1 - this.interpMs), d = t1 - start;
    const f = d > 1e-9 ? Math.max(0, Math.min(1, (tau - start) / d)) : 1;
    return v0 + (v1 - v0) * f;
  }
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
  /** a drill course of the map (MapDef.courses) timed instead of its default gates; '' = default */
  courseId?: string;
  /** a named spawn variant of the map (MapDef.spawns) to start from; '' = the map's (or course's) spawn */
  spawnId?: string;
  physicsHz: number;
  timeScale: number;
  damage: boolean;
  wind: { speed: number; direction: number; turbulence: number; gusts: number };
  propwash: number;
  rcLinkHz: number;     // ELRS packet rate
  rcTxPowerMw?: number; // RC transmitter power (ELRS: 10..1000 mW)
  ambientC: number;
  paused: boolean;
  /** lower physicsHz 8000 -> 4000 -> 2000 when the machine can't keep real time (default on) */
  autoRate?: boolean;
}

export const DEFAULT_SETTINGS: SimSettings = {
  mapId: 'gym', courseId: '', physicsHz: 8000, timeScale: 1, damage: true, // new pilots: the whoop in a windless hall
  wind: { speed: 2.5, direction: 240, turbulence: 1, gusts: 2 },
  propwash: 1, rcLinkHz: 250, rcTxPowerMw: 250, ambientC: 20, paused: false, autoRate: true,
};

export type ToWorker =
  /** t0: sim time to start the clock at (a restarted worker continues the ring's timeline) */
  | { type: 'init'; sab: SharedArrayBuffer; spec: unknown; settings: SimSettings; t0?: number }
  | { type: 'spec'; spec: unknown }
  | { type: 'settings'; settings: SimSettings }
  | { type: 'reset'; repair?: boolean; fullBattery?: boolean; at?: { x: number; y: number; z: number; yawDeg: number } }
  | { type: 'cli'; text: string }
  | { type: 'cliBatch'; lines: string[]; id: number }
  | { type: 'factoryReset' }
  | { type: 'spectrum'; on: boolean }
  /** Betaflight's own blackbox log (.bbl, one log per armed session) recorded so far */
  | { type: 'getBbl'; id: number }
  | { type: 'clearBbl' }
  /** begin a reproducible run (runLog.ts) with this seed: a fresh FC, everything reseeded, sticks recorded */
  | { type: 'runStart'; seed: number }
  /** stop the run (or fetch the last one): answered by { type: 'run' } */
  | { type: 'runStop'; id: number }
  /** answered by { type: 'synced' } once every message before it, firmware work included, is done */
  | { type: 'sync'; id: number }
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
  /** Betaflight's buzzer output (its beeper sequences: arming, RX loss, low battery, AUX beeper) */
  beeper: boolean;
  /** the ESCs are playing a DShot beacon tone through the motors */
  beacon: boolean;
  /** Betaflight's CPU load in % (emulated F7 task timings) */
  cpuLoad: number;
  /** GPS as the flight controller sees it; null on firmware without GPS */
  gps: { fix: boolean; sats: number; homeDistM: number; homeDirDeg: number } | null;
  /** peak approach speed of the newest impact (m/s) and its sim time (s); t < 0: none yet */
  impact?: { speed: number; t: number };
  /** map actors: sim time their clock started (actor time = ring t - actorT0) */
  actorT0?: number;
  /** RC uplink margin (dB) and the interference in it (mW), for the API's observations */
  rc?: { marginDb: number; interfMw: number; lq: number };
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
  /** a detector of the map's actors began (on) / stopped holding a detection (t: actor time) */
  | { type: 'detect'; id: string; name: string; index: number; on: boolean; t: number }
  | { type: 'spectrum'; spec: GyroSpectrum }
  /** the simulator can't go on (uncaught error); the page has to be reloaded */
  | { type: 'fatal'; reason: string }
  /**
   * After every map load: `id` is the map the physics now flies, `requested` the one asked for;
   * ok = false: it failed and the worker fell back to `id`, so the renderer must follow.
   */
  | { type: 'mapLoaded'; id: string; requested: string; ok: boolean; error?: string }
  /** the machine can't keep real time: the worker lowered the physics rate */
  | { type: 'overload'; simRate: number; physicsHz: number }
  | { type: 'bbl'; id: number; data: ArrayBuffer; sessions: number }
  /** a reproducible run began / ended (reason: why it ended) */
  | { type: 'runState'; active: boolean; seed?: number; reason?: string }
  | { type: 'synced'; id: number }
  /** the run as a .fpvrun file (empty when there was none) */
  | { type: 'run'; id: number; data: ArrayBuffer; seconds: number; reason: string };

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
