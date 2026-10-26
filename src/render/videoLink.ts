// 5.8 GHz video link budget: free-space path loss, two-ray ground reflection (multipath nulls),
// obstruction losses (ray-marched through map primitives), antenna orientation, and fast fading.
// Produces carrier-to-noise ratio for analog FM video, or link margin for digital systems.
import type { VideoSpec } from '../data/catalog';
import type { PrimitiveWorld } from '../maps/world';
import type { V3 } from '../sim/math';

/**
 * freeze: digital decoder holding the last frame. lost: 0..1 "no signal" (goggles show black + the
 * OSD drops, since HD OSD travels over the same link). block: compression / break-up amount.
 * margin: digital link margin (dB; analog: = cnr). bitrateMbps: what the goggles report (0 analog / HDZero).
 */
export interface LinkState { cnr: number; freeze: boolean; lost: number; block: number; distance: number; rssiDbm: number; latencyExtraMs: number; margin: number; bitrateMbps: number }

/** Top video bitrate of each digital system (Mbps), which the encoder steps down as the margin shrinks. */
export function maxBitrateMbps(system: VideoSpec['system']): number {
  return system === 'dji-o4' ? 60 : system === 'dji-o3' || system === 'walksnail' ? 50 : 0;
}
/** Bitrate the encoder settles on at a given link margin (MCS fallback below ~10 dB of margin). */
export function bitrateAt(system: VideoSpec['system'], margin: number): number {
  return maxBitrateMbps(system) * Math.max(0.08, Math.min(1, (margin + 4) / 14));
}

/** Digital receiver state machine: real digital links don't fade, they hold, drop, and re-sync. */
type DigiState = 'ok' | 'frozen' | 'lost' | 'resync';

const F_MHZ = 5800, LAMBDA = 299.792458 / F_MHZ;
const NOISE_FLOOR_DBM = -98; // ~ -174 + 10log10(18 MHz) + 6 dB receiver NF

export class VideoLink {
  private fade = 0;
  private fadeV = 0;
  private obsDb = 0;
  private obsTimer = 0;
  private digi: DigiState = 'ok';
  private digiT = 0;       // time in the current state
  private freezeFor = 0;   // how long this freeze holds before the picture is lost
  state: LinkState = { cnr: 40, freeze: false, lost: 0, block: 0, distance: 0, rssiDbm: -40, latencyExtraMs: 0, margin: 30, bitrateMbps: 0 };
  rxGainDbi = 8;       // goggle patch + omni diversity
  txGainDbi = 2;       // lollipop / pagoda
  /**
   * The operational environment (src/worker/ops.ts): jamming in the goggles' channel (dBm), a
   * fibre-optic link (no radio: a clean picture), the video lost (a fault, a broken fibre)
   */
  ew = { jamDbm: -Infinity, wired: false, lost: false };

  /** Link effects switched off: a perfect link (distance / RSSI keep their last values). */
  clean(video: VideoSpec) {
    this.state = { ...this.state, cnr: 45, block: 0, freeze: false, lost: 0, latencyExtraMs: 0, margin: 30, bitrateMbps: maxBitrateMbps(video.system) };
    return this.state;
  }

  /** Respawn: back next to the pilot, the receiver re-acquires quickly. */
  reset() { this.digi = 'resync'; this.digiT = 0.4; this.fade = this.fadeV = 0; this.obsDb = 0; this.obsTimer = 0; }

  /** speed: quad ground speed (m/s), which sets how fast multipath fading decorrelates. */
  update(video: VideoSpec, world: PrimitiveWorld, pilot: V3, quad: V3, quadUp: V3, dt: number, now: number, speed = 0): LinkState {
    void now;
    const dx = quad.x - pilot.x, dy = quad.y - pilot.y, dz = quad.z - pilot.z;
    const d = Math.max(0.5, Math.hypot(dx, dy, dz));
    const fspl = 20 * Math.log10(d / 1000) + 20 * Math.log10(F_MHZ) + 32.44;
    // two-ray ground reflection: phase difference between direct and ground-reflected paths
    const h1 = Math.max(0.2, pilot.z - world.groundHeight(pilot.x, pilot.y)), h2 = Math.max(0.05, quad.z - world.groundHeight(quad.x, quad.y));
    const horiz = Math.hypot(dx, dy);
    const dRef = Math.hypot(horiz, h1 + h2) - Math.hypot(horiz, h2 - h1);
    const phase = (2 * Math.PI * dRef) / LAMBDA;
    const gamma = -0.6; // ground reflection coefficient (grazing, lossy)
    const twoRay = 20 * Math.log10(Math.max(0.05, Math.hypot(1 + gamma * Math.cos(phase), gamma * Math.sin(phase))));
    // obstruction (10 Hz)
    this.obsTimer -= dt;
    if (this.obsTimer <= 0) { this.obsTimer = 0.1; const target = world.obstructionDb(pilot, quad); this.obsDb += (target - this.obsDb) * 0.6; }
    // antenna pattern: dipole null along the antenna axis (quad's up vector roughly)
    const cosA = Math.abs((quadUp.x * dx + quadUp.y * dy + quadUp.z * dz) / d);
    const pattern = -12 * Math.pow(cosA, 4);
    // the frame, battery and props shadow the VTX antenna (mounted on top / rear) when the pilot is
    // under the quad's belly: inverted, or flying overhead
    // (cosine of the pilot direction against the quad's up axis: -1 = straight under the belly)
    const pilotSide = -(quadUp.x * dx + quadUp.y * dy + quadUp.z * dz) / d;
    const bodyBlock = -10 * smooth(-0.35, -0.9, pilotSide);
    // fast fading: decorrelates every ~λ/2 of travel (2.6 cm at 5.8 GHz), so flicker speeds up with speed
    const tau = Math.min(0.08, Math.max(0.004, LAMBDA / 2 / Math.max(0.05, speed)));
    const a = Math.exp(-dt / tau);
    this.fadeV = this.fadeV * a + Math.sqrt(1 - a * a) * gauss();
    this.fade = this.fadeV * (2 + Math.min(4, this.obsDb / 6));
    const ptx = 10 * Math.log10(Math.max(1, video.vtxPowerMw));
    const rssi = ptx + this.txGainDbi + this.rxGainDbi - fspl + twoRay - this.obsDb + pattern + bodyBlock + this.fade;
    // jamming adds to the receiver's noise floor
    const floor = Number.isFinite(this.ew.jamDbm) ? 10 * Math.log10(Math.pow(10, NOISE_FLOOR_DBM / 10) + Math.pow(10, this.ew.jamDbm / 10)) : NOISE_FLOOR_DBM;
    const snr = this.ew.lost ? -40 : this.ew.wired ? 50 : rssi - floor;
    const s = this.state;
    s.distance = d; s.rssiDbm = rssi;
    if (video.kind === 'analog') {
      // analog degrades gradually: CNR drives snow, sparkles, tearing and colour loss in the shader
      s.cnr = snr - 6; // FM demod: CNR relative to the 18 MHz channel
      s.freeze = false; s.lost = 0; s.block = 0; s.latencyExtraMs = 0; s.margin = s.cnr; s.bitrateMbps = 0;
      return s;
    }
    // digital: link margin vs sensitivity (OFDM with MCS fallback is ~8 dB more robust for DJI)
    const hdz = video.system === 'hdzero';
    const robust = video.system.startsWith('dji') ? 10 : video.system === 'walksnail' ? 7 : 3;
    const margin = snr + robust - 14;
    s.cnr = 40;
    // DJI / Walksnail: bitrate drops then macroblocks; HDZero (no inter-frame compression) breaks up
    // in strips and pixel errors earlier but degrades more gradually
    s.block = Math.max(0, Math.min(1, hdz ? (9 - margin) / 12 : (6 - margin) / 8));
    s.latencyExtraMs = hdz ? 0 : Math.max(0, (8 - margin) * 3); // MCS drop / retransmits add latency
    this.digiT += dt;
    const go = (st: DigiState) => { this.digi = st; this.digiT = 0; };
    switch (this.digi) {
      case 'ok':
        // HDZero has no frame buffer to hold: it goes straight to break-up then black
        if (margin < (hdz ? -6 : -2)) { if (hdz) go('lost'); else { go('frozen'); this.freezeFor = 0.25 + Math.random() * 0.6; } }
        break;
      case 'frozen':
        if (margin > 0) go('ok');                       // brief dropout: picture resumes
        else if (this.digiT > this.freezeFor) go('lost');
        break;
      case 'lost':
        if (margin > 1) go('resync');                   // signal back: receiver must re-acquire
        break;
      case 'resync':
        if (margin < -2) go('lost');
        else if (this.digiT > (hdz ? 0.15 : 0.6)) go('ok');
        break;
    }
    s.freeze = this.digi === 'frozen';
    s.lost = this.digi === 'lost' || this.digi === 'resync' ? 1 : 0;
    s.margin = margin;
    // the goggles' bitrate readout follows the encoder's rate control (~0.3 s), and drops to 0 without a link
    const rate = this.digi === 'ok' ? bitrateAt(video.system, margin) : 0;
    s.bitrateMbps += (rate - s.bitrateMbps) * Math.min(1, dt / 0.3);
    return s;
  }
}

function smooth(e0: number, e1: number, x: number) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
