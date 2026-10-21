// 5.8 GHz video link budget: free-space path loss, two-ray ground reflection (multipath nulls),
// obstruction losses (ray-marched through map primitives), antenna orientation, and fast fading.
// Produces carrier-to-noise ratio for analog FM video, or link margin for digital systems.
import type { VideoSpec } from '../data/catalog';
import type { PrimitiveWorld } from '../maps/world';
import type { V3 } from '../sim/math';

export interface LinkState { cnr: number; freeze: boolean; block: number; distance: number; rssiDbm: number; latencyExtraMs: number }

const F_MHZ = 5800, LAMBDA = 299.792458 / F_MHZ;
const NOISE_FLOOR_DBM = -98; // ~ -174 + 10log10(18 MHz) + 6 dB receiver NF

export class VideoLink {
  private fade = 0;
  private fadeV = 0;
  private obsDb = 0;
  private obsTimer = 0;
  private freezeUntil = 0;
  state: LinkState = { cnr: 40, freeze: false, block: 0, distance: 0, rssiDbm: -40, latencyExtraMs: 0 };
  rxGainDbi = 8;       // goggle patch + omni diversity
  txGainDbi = 2;       // lollipop / pagoda

  update(video: VideoSpec, world: PrimitiveWorld, pilot: V3, quad: V3, quadUp: V3, dt: number, now: number): LinkState {
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
    // fast fading (Rician-ish, decorrelates with motion)
    const a = Math.exp(-dt / 0.08);
    this.fadeV = this.fadeV * a + Math.sqrt(1 - a * a) * gauss();
    this.fade = this.fadeV * (2 + Math.min(4, this.obsDb / 6));
    const ptx = 10 * Math.log10(Math.max(1, video.vtxPowerMw));
    const rssi = ptx + this.txGainDbi + this.rxGainDbi - fspl + twoRay - this.obsDb + pattern + this.fade;
    const snr = rssi - NOISE_FLOOR_DBM;
    const s = this.state;
    s.distance = d; s.rssiDbm = rssi;
    if (video.kind === 'analog') {
      s.cnr = snr - 6; // FM demod: CNR relative to the 18 MHz channel
      s.freeze = false; s.block = 0; s.latencyExtraMs = 0;
    } else {
      // digital: link margin vs sensitivity (OFDM w/ MCS fallback is ~8 dB more robust for DJI)
      const robust = video.system.startsWith('dji') ? 10 : video.system === 'walksnail' ? 7 : 3;
      const margin = snr + robust - 14;
      s.cnr = 40;
      s.block = Math.max(0, Math.min(1, (6 - margin) / 8));
      if (margin < -2 && now > this.freezeUntil && Math.random() < dt * 4) this.freezeUntil = now + 0.15 + Math.random() * 0.5;
      s.freeze = now < this.freezeUntil;
      s.latencyExtraMs = Math.max(0, (8 - margin) * 3); // MCS drop / retransmits add latency
    }
    return s;
  }
}

function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
