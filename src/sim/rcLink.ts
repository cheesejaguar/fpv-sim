// RC control link (ExpressLRS-style LoRa, 2.4 GHz or 900 MHz). Each packet slot at the link rate is received
// or lost according to the uplink margin: transmitter power + antenna gains − free-space path loss
// − obstruction (walls, terrain) + fast fading, against the receiver sensitivity of the chosen packet
// rate. Lost packets are really lost (the flight controller sees no new RC frame), so a bad link
// shows up as jittery control and ultimately Betaflight failsafe. LQ is ELRS's definition: the share
// of the last 100 packet slots that arrived. Jammers (src/sim/ew.ts) knock out the hops they cover.
import { BANDS, LORA_REQ_SNR_DB } from './ew';
import type { V3 } from './math';

export interface RcLinkWorld {
  obstructionDb(a: V3, b: V3): number;
}

/** SX1280 LoRa sensitivity by ELRS 2.4 GHz packet rate (approximate, dBm). */
export const ELRS_SENSITIVITY_DBM: Record<number, number> = { 500: -105, 250: -108, 150: -112, 50: -115 };
/** ExpressLRS 900 MHz (SX127x) sensitivity by packet rate (approximate, dBm). */
export const ELRS900_SENSITIVITY_DBM: Record<number, number> = { 200: -112, 100: -117, 50: -120, 25: -123 };
/** OSD "RF mode" digit shown as LQ <mode>:<lq> (simulator's own index; ELRS's enum varies by version). */
const RF_MODE: Record<number, number> = { 50: 0, 150: 1, 250: 2, 500: 3 };

export class RcLink {
  txPowerMw = 250;
  txGainDbi = 2;   // radio's dipole / moxon
  rxGainDbi = 2;   // receiver T-antenna / dipole
  rateHz = 250;
  /** the link's band: ELRS 2.4 GHz or 900 MHz */
  band: 'rc24' | 'rc900' = 'rc24';
  /**
   * Jamming at the receiver (src/sim/ew.ts bandJamming): the share of hop channels a jammer covers
   * and its power inside one channel (dBm). A hop on a jammed channel is lost when the signal does
   * not beat the jamming by LoRa's demodulation SNR.
   */
  jamHitFrac = 0;
  jamDbm = -Infinity;
  /** the link is cut (a fault, a broken fibre): no packet arrives */
  cut = false;
  /** a fibre-optic link: every packet arrives, whatever the radio environment */
  wired = false;
  private history = new Uint8Array(100);
  private hIdx = 0;
  private received = 100;
  private fade = 0;
  private obsDb = 0;
  private obsTimer = 0;
  private rng: () => number;
  /** Last computed uplink RSSI (dBm) and margin over sensitivity (dB). */
  rssiDbm = -40;
  marginDb = 60;

  constructor(seed = 0x5eed) {
    let s = seed >>> 0;
    this.rng = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    this.history.fill(1);
  }

  get lq(): number { return this.received; }
  get rfMode(): number { return RF_MODE[this.rateHz] ?? 2; }

  reset(): void { this.history.fill(1); this.received = 100; this.hIdx = 0; this.fade = 0; }

  /** Update the slowly varying link budget (call at ~20 Hz). */
  updateBudget(world: RcLinkWorld | null, pilot: V3, quad: V3, dt: number): void {
    const dx = quad.x - pilot.x, dy = quad.y - pilot.y, dz = quad.z - pilot.z;
    const d = Math.max(0.5, Math.hypot(dx, dy, dz));
    const fMHz = this.band === 'rc900' ? 915 : 2440;
    const fspl = 20 * Math.log10(d / 1000) + 20 * Math.log10(fMHz) + 32.44;
    this.obsTimer -= dt;
    if (world && this.obsTimer <= 0) {
      this.obsTimer = 0.1;
      // 2.4 GHz (900 MHz more so) penetrates walls better than 5.8 GHz video: scale the video obstruction model
      const target = world.obstructionDb(pilot, quad) * (this.band === 'rc900' ? 0.45 : 0.7);
      this.obsDb += (target - this.obsDb) * 0.6;
    }
    // Rician-ish fast fading, worse when obstructed (no line of sight)
    const a = Math.exp(-dt / 0.05);
    this.fade = this.fade * a + Math.sqrt(1 - a * a) * gauss(this.rng);
    const fadeDb = this.fade * (1.5 + Math.min(5, this.obsDb / 5));
    const ptx = 10 * Math.log10(Math.max(1, this.txPowerMw));
    this.rssiDbm = ptx + this.txGainDbi + this.rxGainDbi - fspl - this.obsDb + fadeDb;
    this.marginDb = this.rssiDbm - this.sensitivityDbm();
  }

  /** Receiver sensitivity at the current band and packet rate (dBm). */
  sensitivityDbm(): number {
    return this.band === 'rc900' ? ELRS900_SENSITIVITY_DBM[this.rateHz] ?? -117 : ELRS_SENSITIVITY_DBM[this.rateHz] ?? -108;
  }

  /** The receiver's band (for the jamming model). */
  get bandDef() { return BANDS[this.band]; }

  /** Margin (dB) a packet on a jammed channel has: signal over jamming, against the LoRa SNR floor. */
  jammedMarginDb(): number {
    return Math.min(this.marginDb, this.rssiDbm - this.jamDbm - (LORA_REQ_SNR_DB[this.rateHz] ?? -5));
  }

  /** One packet slot: returns true if the packet arrives. Updates LQ. */
  packet(): boolean {
    let ok: boolean;
    if (this.cut) ok = false;
    else if (this.wired) ok = true;
    else {
      // a hop lands on a jammed channel with the jammer's band share (frequency hopping's resilience)
      const jammed = this.jamHitFrac > 0 && this.rng() < this.jamHitFrac;
      const m = jammed ? this.jammedMarginDb() : this.marginDb;
      // packet success vs margin: ~50 % at sensitivity, steep LoRa waterfall (~2 dB wide)
      const p = 1 / (1 + Math.exp(-(m - 0) / 0.9));
      ok = this.rng() < p;
    }
    this.received += (ok ? 1 : 0) - this.history[this.hIdx];
    this.history[this.hIdx] = ok ? 1 : 0;
    this.hIdx = (this.hIdx + 1) % this.history.length;
    return ok;
  }
}

function gauss(rng: () => number) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
