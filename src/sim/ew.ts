// Electromagnetic environment: jammers and GNSS spoofers placed in the world, and what they do to
// the three radio links a drone depends on.
//   - The RC control link (receiver on the drone; ELRS 2.4 GHz or 900 MHz LoRa, frequency hopping):
//     a jammer only hits the hops inside its band, and a hit hop is lost when the jamming power that
//     falls into the receiver's bandwidth beats the signal by more than LoRa's demodulation margin.
//     Lost packets are lost to the real Betaflight, which fails safe exactly as it would in flight.
//   - The 5.8 GHz video link (receiver at the pilot): jamming raises the goggles' noise floor.
//   - GNSS L1 (receiver on the drone): jamming lowers C/N0 (the standard effective-C/N0 formula),
//     satellites drop out as they fall below the tracking threshold and the fix degrades, then is
//     lost; a spoofer that overpowers the real signals captures the receiver and walks its position
//     away along a programmed drift.
// Propagation: free-space path loss, obstruction by the map's buildings and terrain (the video
// link's 5.8 GHz model, scaled for lower frequencies), and a radio-horizon diffraction loss beyond
// the 4/3-earth horizon. Units: dBm, MHz, metres, seconds. Pure functions plus small state.
import type { V3 } from './math';

/** Where a link lives in the spectrum. */
export interface BandDef { lowMHz: number; highMHz: number; /** receiver (channel) bandwidth */ rxBwMHz: number }

export const BANDS = {
  /** ExpressLRS 2.4 GHz: 80 channels over the ISM band, ~0.8 MHz LoRa channel */
  rc24: { lowMHz: 2400, highMHz: 2480, rxBwMHz: 0.8125 },
  /** ExpressLRS / Crossfire 900 MHz (FCC 902–928 MHz), ~0.5 MHz LoRa channel */
  rc900: { lowMHz: 902, highMHz: 928, rxBwMHz: 0.5 },
  /** 5.8 GHz video: one ~20 MHz channel (Raceband R1..R8 span 5658–5917 MHz) */
  vid58: { lowMHz: 5650, highMHz: 5925, rxBwMHz: 20 },
  /** GPS L1 C/A (and Galileo E1) around 1575.42 MHz */
  gnssL1: { lowMHz: 1574.4, highMHz: 1576.4, rxBwMHz: 2.046 },
} satisfies Record<string, BandDef>;
export type BandId = keyof typeof BANDS;

/** Named emitter presets: a jammer's band in one word. */
export const JAM_PRESETS: Record<string, { freqMHz: number; bandwidthMHz: number }> = {
  '2.4': { freqMHz: 2440, bandwidthMHz: 80 },
  '900': { freqMHz: 915, bandwidthMHz: 26 },
  '5.8': { freqMHz: 5800, bandwidthMHz: 300 },
  'gnss': { freqMHz: 1575.42, bandwidthMHz: 20 },
  '1.2': { freqMHz: 1280, bandwidthMHz: 60 },
};

export interface Emitter {
  id?: string;
  /** 'jammer': noise over its band; 'spoofer': counterfeit GNSS signals */
  kind: 'jammer' | 'spoofer';
  pos: V3;
  freqMHz: number;
  bandwidthMHz: number;
  /** effective radiated power toward the drone (W) */
  erpW: number;
  /** active from / until this time (s; the host's clock: episode time headless) */
  fromS?: number;
  untilS?: number;
  /** spoofer: once captured, the reported position walks away at this velocity (ENU, m/s) */
  driftMps?: V3;
}

/** Frequency of a band's centre (MHz). */
export const centreMHz = (b: BandDef) => (b.lowMHz + b.highMHz) / 2;

/** Free-space path loss (dB) over d metres at f MHz. */
export function fsplDb(dM: number, fMHz: number): number {
  return 20 * Math.log10(Math.max(0.5, dM) / 1000) + 20 * Math.log10(fMHz) + 32.44;
}

/** 4/3-earth radio horizon (m) between antennas at heights h1, h2 m above the ground. */
export function radioHorizonM(h1: number, h2: number): number {
  return 4120 * (Math.sqrt(Math.max(0, h1)) + Math.sqrt(Math.max(0, h2)));
}

/** Diffraction loss past the radio horizon (dB): ~10 dB at the horizon growing to 40 dB at twice its range. */
export function horizonLossDb(dM: number, h1: number, h2: number): number {
  const dh = radioHorizonM(h1, h2);
  if (dM <= 0.8 * dh) return 0;
  return Math.min(40, 10 * Math.min(1, (dM - 0.8 * dh) / (0.2 * dh)) + 30 * Math.max(0, (dM - dh) / dh));
}

/**
 * Obstruction scale relative to the 5.8 GHz model (walls, terrain, foliage): lower frequencies
 * diffract around and penetrate obstacles better. ~0.7 at 2.4 GHz (the RC link's own factor).
 */
export const obstructionScale = (fMHz: number) => Math.max(0.35, Math.min(1, 0.7 * Math.pow(fMHz / 2440, 0.45)));

export interface PropagationWorld {
  obstructionDb(a: V3, b: V3): number;
  terrain?(x: number, y: number): number;
}

/** Received power (dBm) of an emitter at a point, with an rx antenna gain toward it (dBi). */
export function receivedDbm(e: Emitter, rx: V3, world: PropagationWorld | null, rxGainDbi = 0): number {
  const d = Math.hypot(rx.x - e.pos.x, rx.y - e.pos.y, rx.z - e.pos.z);
  let loss = fsplDb(d, e.freqMHz);
  if (world) {
    loss += world.obstructionDb(e.pos, rx) * obstructionScale(e.freqMHz);
    const g = world.terrain ?? (() => 0);
    loss += horizonLossDb(d, e.pos.z - g(e.pos.x, e.pos.y), rx.z - g(rx.x, rx.y));
  }
  return 10 * Math.log10(e.erpW * 1000) + rxGainDbi - loss;
}

/** Share of a band an emitter's spectrum covers (0..1), and the overlap in MHz. */
export function bandOverlap(e: Emitter, b: BandDef): { frac: number; mhz: number } {
  const lo = Math.max(e.freqMHz - e.bandwidthMHz / 2, b.lowMHz), hi = Math.min(e.freqMHz + e.bandwidthMHz / 2, b.highMHz);
  const mhz = Math.max(0, hi - lo);
  return { frac: mhz / Math.max(1e-9, b.highMHz - b.lowMHz), mhz };
}

export const active = (e: Emitter, t: number) => (e.fromS === undefined || t >= e.fromS) && (e.untilS === undefined || t < e.untilS);

const dbmToMw = (d: number) => Math.pow(10, d / 10);
const mwToDbm = (m: number) => 10 * Math.log10(Math.max(1e-30, m));

/**
 * Jamming seen by a receiver on a band: the share of its channels (hops) that are hit, and the
 * jamming power inside one receiver channel on a hit channel (dBm; -Infinity: none).
 */
export function bandJamming(emitters: readonly Emitter[], band: BandDef, rx: V3, world: PropagationWorld | null, t: number, rxGainDbi = 0): { hitFrac: number; jamDbm: number } {
  let hit = 0, mw = 0;
  for (const e of emitters) {
    if (e.kind !== 'jammer' || !active(e, t)) continue;
    const ov = bandOverlap(e, band);
    if (ov.mhz <= 0) continue;
    const p = receivedDbm(e, rx, world, rxGainDbi);
    // the jammer spreads its power evenly over its bandwidth: one channel catches rxBw / bandwidth of it
    mw += dbmToMw(p) * Math.min(1, band.rxBwMHz / Math.max(band.rxBwMHz, e.bandwidthMHz));
    hit = Math.max(hit, ov.frac);
  }
  return { hitFrac: Math.min(1, hit), jamDbm: mw > 0 ? mwToDbm(mw) : -Infinity };
}

/** LoRa demodulation SNR floor by ExpressLRS packet rate (dB): SF5..SF8 at 2.4 GHz, SF6..SF9 at 900 MHz. */
export const LORA_REQ_SNR_DB: Record<number, number> = { 500: -2.5, 250: -5, 200: -5, 150: -7.5, 100: -7.5, 50: -10, 25: -12.5 };

// ---- GNSS ----

/** Nominal C/N0 of a strong GPS satellite in the open (dB-Hz); weaker ones down to ~ -8 dB from it. */
export const GNSS_CN0_NOMINAL = 46;
/** Received power of the authentic signals at the antenna (dBm, L1 C/A minimum −128.5). */
export const GNSS_SIGNAL_DBM = -127;
/** Tracking threshold (dB-Hz): satellites below it are lost. */
export const GNSS_TRACK_DBHZ = 26;
/** Patch antenna gain toward a jammer near the horizon (dBi): the pattern looks up. */
export const GNSS_HORIZON_GAIN_DBI = -4;

export interface GnssJamState {
  /** jamming-to-signal ratio at the receiver (dB; -Infinity: none) */
  jsDb: number;
  /** C/N0 of the strongest satellite after jamming (dB-Hz) */
  cn0: number;
  /** satellites still tracked (of `sats` in view) */
  numSV: number;
  /** horizontal error grows as C/N0 falls: CEP multiplier over the open-sky value */
  cepScale: number;
  /** a spoofer holds the receiver */
  spoofed: boolean;
  spoofer: Emitter | null;
}

/**
 * Effective C/N0 under jamming: 1 / (1/C/N0 + (J/S) / (Q·Rc)), Rc = 1.023 Mchip/s, Q = 1 for
 * broadband noise (Betz; Kaplan & Hegarty, Understanding GPS, ch. 9).
 */
export function effectiveCn0(cn0DbHz: number, jsDb: number, q = 1, rcHz = 1.023e6): number {
  if (!Number.isFinite(jsDb)) return cn0DbHz;
  const inv = Math.pow(10, -cn0DbHz / 10) + Math.pow(10, jsDb / 10) / (q * rcHz);
  return -10 * Math.log10(inv);
}

/**
 * GNSS state at a receiver: `sats` satellites in view spread over 8 dB of C/N0 below nominal;
 * each is tracked while its jammed C/N0 stays above the threshold.
 */
export function gnssState(emitters: readonly Emitter[], rx: V3, world: PropagationWorld | null, t: number, sats = 12): GnssJamState {
  let jamMw = 0, best: Emitter | null = null, bestDbm = -Infinity;
  for (const e of emitters) {
    if (!active(e, t)) continue;
    const ov = bandOverlap(e, BANDS.gnssL1);
    if (ov.mhz <= 0) continue;
    const p = receivedDbm(e, rx, world, GNSS_HORIZON_GAIN_DBI);
    if (e.kind === 'jammer') jamMw += dbmToMw(p) * Math.min(1, ov.mhz / e.bandwidthMHz);
    else if (p > bestDbm) { bestDbm = p; best = e; }
  }
  const jsDb = jamMw > 0 ? mwToDbm(jamMw) - GNSS_SIGNAL_DBM : -Infinity;
  const cn0 = effectiveCn0(GNSS_CN0_NOMINAL, jsDb);
  let numSV = 0;
  for (let k = 0; k < sats; k++) if (cn0 - (8 * k) / Math.max(1, sats - 1) >= GNSS_TRACK_DBHZ) numSV++;
  // a counterfeit signal 3 dB over the authentic ones (and not drowned by jamming) captures the tracking loops
  const spoofed = !!best && bestDbm > GNSS_SIGNAL_DBM + 3 && effectiveCn0(GNSS_CN0_NOMINAL + (bestDbm - GNSS_SIGNAL_DBM), jsDb) >= GNSS_TRACK_DBHZ + 4;
  const cepScale = Math.min(20, Math.pow(10, Math.max(0, GNSS_CN0_NOMINAL - 4 - cn0) / 20));
  return { jsDb, cn0, numSV: spoofed ? sats : numSV, cepScale: spoofed ? 1 : cepScale, spoofed, spoofer: spoofed ? best : null };
}

/** Link-margin field for planning: margin (dB) of `fn` at every cell of a square grid around a centre. */
export function marginGrid(centre: V3, halfM: number, n: number, z: (x: number, y: number) => number, fn: (p: V3) => number): { xs: number[]; ys: number[]; margin: number[][] } {
  const xs: number[] = [], ys: number[] = [], margin: number[][] = [];
  for (let i = 0; i < n; i++) { xs.push(centre.x - halfM + (2 * halfM * i) / (n - 1)); ys.push(centre.y - halfM + (2 * halfM * i) / (n - 1)); }
  for (const y of ys) margin.push(xs.map((x) => fn({ x, y, z: z(x, y) })));
  return { xs, ys, margin };
}
