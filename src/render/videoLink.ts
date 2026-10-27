// 5.8 GHz video link budget: free-space path loss, two-ray ground reflection (multipath nulls),
// obstruction losses (ray-marched through map primitives), antenna orientation, and fast fading.
// Produces carrier-to-noise ratio for analog FM video, or link margin for digital systems.
import type { VideoSpec } from '../data/catalog';
import type { ActorDef, PrimitiveWorld } from '../maps/world';
import { bandOverlap, fsplDb, interferenceMw, posAt, sinrDb, VIDEO_BAND, type EmitterDef } from '../sim/actors';
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
  // map actors (actorRf): interference at the receiving site and its antenna gain (null: the goggles')
  private interfMw = 0;
  private rxOverride: number | null = null;

  /** Link effects switched off: a perfect link (distance / RSSI keep their last values). */
  clean(video: VideoSpec) {
    this.state = { ...this.state, cnr: 45, block: 0, freeze: false, lost: 0, latencyExtraMs: 0, margin: 30, bitrateMbps: maxBitrateMbps(video.system) };
    return this.state;
  }

  /** Respawn: back next to the pilot, the receiver re-acquires quickly. */
  reset() { this.digi = 'resync'; this.digiT = 0.4; this.fade = this.fadeV = 0; this.obsDb = 0; this.obsTimer = 0; }

  /**
   * speed: quad ground speed (m/s), which sets how fast multipath fading decorrelates. actorT: the
   * map's actor time (s), when its actors take part: ground stations with a video link are more
   * receivers (diversity: the best signal-to-noise wins), and in-band emitters add to the noise.
   */
  update(video: VideoSpec, world: PrimitiveWorld, pilot: V3, quad: V3, quadUp: V3, dt: number, now: number, speed = 0, actorT?: number): LinkState {
    void now;
    const actors = actorT !== undefined ? world.map.actors : undefined;
    if (actors?.length) {
      const rf = this.actorRf(world, actors, actorT!, pilot, quad, dt);
      if (rf) { pilot = rf.site; this.interfMw = rf.interfMw; this.rxOverride = rf.index ? rf.gainDbi : null; }
      else { this.interfMw = 0; this.rxOverride = null; }
    } else { this.interfMw = 0; this.rxOverride = null; }
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
    const rssi = ptx + this.txGainDbi + (this.rxOverride ?? this.rxGainDbi) - fspl + twoRay - this.obsDb + pattern + bodyBlock + this.fade;
    // (in-band emitters of the map: signal over noise + interference)
    const snr = this.interfMw > 0 ? sinrDb(rssi, NOISE_FLOOR_DBM, this.interfMw) : rssi - NOISE_FLOOR_DBM;
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

  /**
   * The map's actors: which receiver hears the quad (index 0 the pilot's goggles, k the k-th video
   * ground station) and the in-band interference there; null when no actor touches the video link.
   */
  actorRf(world: PrimitiveWorld, actors: readonly ActorDef[], t: number, pilot: V3, quad: V3, dt: number): VideoRf | null {
    return videoRf(this.rf, this.rxGainDbi, world, actors, t, pilot, quad, dt);
  }
  private readonly rf: RfState = { timer: 0, siteObs: [], emObs: [], site: 0, out: { x: 0, y: 0, z: 0 } };
}

export interface VideoRf { site: V3; gainDbi: number; interfMw: number; index: number }
interface RfState { timer: number; siteObs: number[]; emObs: number[][]; site: number; out: V3 }

function videoRf(self: RfState, rxGainDbi: number, world: PrimitiveWorld, actors: readonly ActorDef[], t: number, pilot: V3, quad: V3, dt: number): VideoRf | null {
  const paths = world.map.paths;
  const emitters = actors.filter((a): a is EmitterDef => a.type === 'rf-emitter' && bandOverlap(a.freqMHz, a.bwMHz, VIDEO_BAND) > 0);
  const stations = actors.filter((a) => a.type === 'ground-station' && a.link !== 'rc');
  if (!emitters.length && !stations.length) return null;
  // the receiving sites: the pilot's goggles, then each video ground station
  const sites: { pos: V3; gain: number }[] = [{ pos: { ...pilot }, gain: rxGainDbi }];
  for (const s of stations) sites.push({ pos: posAt(s, paths, t), gain: s.type === 'ground-station' ? s.gainDbi : 0 });
  self.timer -= dt;
  if (self.timer <= 0 || self.siteObs.length !== sites.length) {
    self.timer = 0.1;
    self.siteObs = sites.map((s) => world.obstructionDb(s.pos, quad));
    self.emObs = sites.map((s) => emitters.map((e) => world.obstructionDb(posAt(e, paths, t), s.pos)));
  }
  // each site's signal to noise + interference (deterministic budget: path loss, walls, antenna gain)
  let best = -Infinity, bi = 0, cur = -Infinity;
  const interf: number[] = [];
  sites.forEach((s, k) => {
    let i = 0;
    emitters.forEach((e, j) => { i += interferenceMw(e, posAt(e, paths, t), s.pos, VIDEO_BAND, self.emObs[k]?.[j] ?? 0, s.gain); });
    interf.push(i);
    const d = Math.max(0.5, Math.hypot(quad.x - s.pos.x, quad.y - s.pos.y, quad.z - s.pos.z));
    const snr = sinrDb(s.gain - fsplDb(d / 1000, VIDEO_BAND.fMHz) - (self.siteObs[k] ?? 0), NOISE_FLOOR_DBM, i);
    if (snr > best) { best = snr; bi = k; }
    if (k === self.site) cur = snr;
  });
  // (a diversity receiver switches when another antenna is clearly better)
  if (self.site < sites.length && cur > best - 2) bi = self.site;
  self.site = bi;
  const s = sites[bi];
  self.out.x = s.pos.x; self.out.y = s.pos.y; self.out.z = s.pos.z;
  return { site: self.out, gainDbi: s.gain, interfMw: interf[bi], index: bi };
}

function smooth(e0: number, e1: number, x: number) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
