// 2.4 GHz RC control link (ExpressLRS-style LoRa). Each packet slot at the link rate is received
// or lost according to the uplink margin: transmitter power + antenna gains − free-space path loss
// − obstruction (walls, terrain) + fast fading, against the receiver sensitivity of the chosen packet
// rate. Lost packets are really lost (the flight controller sees no new RC frame), so a bad link
// shows up as jittery control and ultimately Betaflight failsafe. LQ is ELRS's definition: the share
// of the last 100 packet slots that arrived.
import type { V3 } from './math';

export interface RcLinkWorld {
  obstructionDb(a: V3, b: V3): number;
}

/** SX1280 LoRa sensitivity by ELRS 2.4 GHz packet rate (approximate, dBm). */
export const ELRS_SENSITIVITY_DBM: Record<number, number> = { 500: -105, 250: -108, 150: -112, 50: -115 };
/** OSD "RF mode" digit shown as LQ <mode>:<lq> (simulator's own index; ELRS's enum varies by version). */
const RF_MODE: Record<number, number> = { 50: 0, 150: 1, 250: 2, 500: 3 };

const F_MHZ = 2440;

export class RcLink {
  txPowerMw = 250;
  txGainDbi = 2;   // radio's dipole / moxon
  rxGainDbi = 2;   // receiver T-antenna / dipole
  rateHz = 250;
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
    const fspl = 20 * Math.log10(d / 1000) + 20 * Math.log10(F_MHZ) + 32.44;
    this.obsTimer -= dt;
    if (world && this.obsTimer <= 0) {
      this.obsTimer = 0.1;
      // 2.4 GHz penetrates walls better than 5.8 GHz video: scale the video obstruction model
      const target = world.obstructionDb(pilot, quad) * 0.7;
      this.obsDb += (target - this.obsDb) * 0.6;
    }
    // Rician-ish fast fading, worse when obstructed (no line of sight)
    const a = Math.exp(-dt / 0.05);
    this.fade = this.fade * a + Math.sqrt(1 - a * a) * gauss(this.rng);
    const fadeDb = this.fade * (1.5 + Math.min(5, this.obsDb / 5));
    const ptx = 10 * Math.log10(Math.max(1, this.txPowerMw));
    this.rssiDbm = ptx + this.txGainDbi + this.rxGainDbi - fspl - this.obsDb + fadeDb;
    this.marginDb = this.rssiDbm - (ELRS_SENSITIVITY_DBM[this.rateHz] ?? -108);
  }

  /** One packet slot: returns true if the packet arrives. Updates LQ. */
  packet(): boolean {
    // packet success vs margin: ~50 % at sensitivity, steep LoRa waterfall (~2 dB wide)
    const p = 1 / (1 + Math.exp(-(this.marginDb - 0) / 0.9));
    const ok = this.rng() < p;
    this.received += (ok ? 1 : 0) - this.history[this.hIdx];
    this.history[this.hIdx] = ok ? 1 : 0;
    this.hIdx = (this.hIdx + 1) % this.history.length;
    return ok;
  }
}

function gauss(rng: () => number) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
