// The operational layer of the flight core: the radio environment (jammers, spoofers, the radio
// horizon), the fibre-optic link, fault injection, the payload and its release, and the navigation
// sensors external autopilots need (magnetometer, rangefinder, optical flow). The flight core
// (flightCore.ts) calls in at the points where each effect lives in the real hardware:
//   - every 50 ms after the RC link budget: jamming of the control link, GNSS state;
//   - per RC packet: a cut link (fault, broken fibre) loses it;
//   - per IMU sample handed to the firmware: gyro / accelerometer faults;
//   - per baro / GPS update: their faults, jamming and spoofing;
//   - per motor command: dead or weak motors;
//   - at 1 kHz: fault start / end, fibre payout, payload release and its fall.
// Without a configuration (or with an empty one) nothing here touches the flight: runs stay
// bit-identical to the plain flight core. Everything random is seeded from the core's seed.
// Times are "ops time": seconds since the configuration was applied (the episode start headless).
import { BANDS, bandJamming, Emitter, GnssJamState, gnssState, JAM_PRESETS, LORA_REQ_SNR_DB, PropagationWorld, receivedDbm } from '../sim/ew';
import { axes, checkFaults, FaultKind, FaultSpec, PERMANENT } from '../sim/faults';
import { Rng, rotate, rotateInv, V3 } from '../sim/math';
import { EarthField, FIELD_ZURICH, Magnetometer, OpticalFlow, Rangefinder } from '../sim/sensors';
import type { QuadParams, QuadSim } from '../sim/quad';
import { G0, isa } from '../sim/atmosphere';

export interface FiberSpec {
  /** fibre on the spool (m); default 10 km */
  lengthM?: number;
  /** fibre mass (g per km); default 60 (a 0.25 mm buffered single-mode fibre) */
  massGPerKm?: number;
  /** empty spool and its mount (g); default 60 */
  spoolMassG?: number;
  /** drag of the paying-out fibre (N) at speed; default 0.3 */
  tensionN?: number;
  /** above this ground speed (m/s) the payout cannot keep up and the fibre snaps; default 40 */
  maxPayoutMps?: number;
}

export interface PayloadSpec {
  name?: string;
  massG: number;
  /** drag area Cd·A of the released body (m²); default 0.002 */
  cdA?: number;
  /** where it hangs (body FLU, m from the CG); default 4 cm under it */
  offset?: [number, number, number];
  /** release when this AUX channel (1-based: AUX1 = channel 5) goes above 1700 µs */
  releaseAux?: number;
}

export type EmitterSpec = Omit<Emitter, 'pos' | 'freqMHz' | 'bandwidthMHz' | 'driftMps' | 'kind'> & {
  kind?: Emitter['kind'];
  /** east, north, and height above the ground (m) */
  pos: [number, number, number];
  /** a named band ('2.4', '900', '5.8', 'gnss', '1.2') instead of freqMHz / bandwidthMHz */
  band?: string;
  freqMHz?: number;
  bandwidthMHz?: number;
  driftMps?: [number, number, number];
};

export interface OpsConfig {
  /** the control and video links: radio (default) or a fibre-optic cable from a spool on the drone */
  link?: { type?: 'radio' | 'fiber'; band?: '2.4' | '900'; fiber?: FiberSpec };
  emitters?: EmitterSpec[];
  faults?: FaultSpec[];
  payload?: PayloadSpec;
  /** the Earth's field for the magnetometer (default: Zurich, the GPS origin) */
  field?: EarthField;
}

export type OpsEvent =
  | { type: 'fault'; t: number; kind: FaultKind; motor?: number; on: boolean }
  | { type: 'payload_release'; t: number; pos: V3; vel: V3 }
  | { type: 'payload_impact'; t: number; pos: V3; speed: number; flightS: number }
  | { type: 'fiber_break'; t: number; reason: string }
  | { type: 'gnss'; t: number; state: 'ok' | 'degraded' | 'lost' | 'spoofed' };

export interface OpsStatus {
  t: number;
  link: { type: 'radio' | 'fiber'; band: '2.4' | '900'; lq: number; rssiDbm: number; marginDb: number; jamDbm: number | null; jamHitFrac: number; cut: boolean };
  /** jamming in the goggles' video channel at the pilot (dBm), and whether the video is lost */
  video: { jamDbm: number | null; lost: boolean };
  gnss: { numSV: number; cn0: number; jsDb: number | null; spoofed: boolean; state: 'ok' | 'degraded' | 'lost' | 'spoofed' };
  /**
   * the navigation solution a GNSS receiver on the drone reports (10 Hz): position (ENU m, with its
   * wandering error, a spoofer's counterfeit offset), velocity, horizontal accuracy; null without a fix
   */
  fix: { pos: [number, number, number]; vel: [number, number, number]; ephM: number; numSV: number } | null;
  fiber: { paidOutM: number; remainingM: number; broken: boolean } | null;
  payload: { name: string; attached: boolean; released: boolean; impact: { pos: V3; speed: number; t: number } | null } | null;
  faults: string[];
}

/** What the layer needs from the flight core. */
export interface OpsHost {
  quad: QuadSim;
  rcLink: { cut: boolean; wired: boolean; band: 'rc24' | 'rc900'; jamHitFrac: number; jamDbm: number; lq: number; rssiDbm: number; marginDb: number; bandDef: typeof BANDS.rc24; txGainDbi: number; rxGainDbi: number };
  world: PropagationWorld & { raycast(o: V3, d: V3, max: number): number };
  map: { terrain(x: number, y: number): number; elevationM: number };
  env: { wind: { meanAt(z: number, o: V3): V3 }; ambientC: number };
  rcBuf: Float32Array;
  simT: number;
  pilot(): V3;
  armed: boolean;
}

/** Check an ops configuration (the scenario's `ops` block). */
export function checkOps(raw: unknown, path = 'ops'): string[] {
  const errs: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [`${path}: expected an object`];
  const o = raw as Record<string, unknown>;
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const vec = (x: unknown) => Array.isArray(x) && x.length === 3 && x.every(num);
  for (const k of Object.keys(o)) if (!['link', 'emitters', 'faults', 'payload', 'field'].includes(k)) errs.push(`${path}.${k}: unknown key`);
  if (o.link !== undefined) {
    const l = o.link;
    if (!isObj(l)) errs.push(`${path}.link: expected an object`);
    else {
      for (const k of Object.keys(l)) if (!['type', 'band', 'fiber'].includes(k)) errs.push(`${path}.link.${k}: unknown key`);
      if (l.type !== undefined && l.type !== 'radio' && l.type !== 'fiber') errs.push(`${path}.link.type: "radio" or "fiber"`);
      if (l.band !== undefined && l.band !== '2.4' && l.band !== '900') errs.push(`${path}.link.band: "2.4" or "900"`);
      if (l.fiber !== undefined) {
        if (!isObj(l.fiber)) errs.push(`${path}.link.fiber: expected an object`);
        else for (const [k, v] of Object.entries(l.fiber)) {
          if (!['lengthM', 'massGPerKm', 'spoolMassG', 'tensionN', 'maxPayoutMps'].includes(k)) errs.push(`${path}.link.fiber.${k}: unknown key`);
          else if (!(num(v) && (v as number) >= 0)) errs.push(`${path}.link.fiber.${k}: expected a number >= 0`);
        }
      }
    }
  }
  if (o.emitters !== undefined) {
    if (!Array.isArray(o.emitters)) errs.push(`${path}.emitters: expected a list`);
    else o.emitters.forEach((e, i) => {
      const p = `${path}.emitters[${i}]`;
      if (!isObj(e)) { errs.push(`${p}: expected an object`); return; }
      for (const k of Object.keys(e)) if (!['id', 'kind', 'pos', 'band', 'freqMHz', 'bandwidthMHz', 'erpW', 'fromS', 'untilS', 'driftMps'].includes(k)) errs.push(`${p}.${k}: unknown key`);
      if (e.kind !== undefined && e.kind !== 'jammer' && e.kind !== 'spoofer') errs.push(`${p}.kind: "jammer" or "spoofer"`);
      if (!vec(e.pos)) errs.push(`${p}.pos: expected [x, y, z]`);
      if (e.band !== undefined && !(typeof e.band === 'string' && e.band in JAM_PRESETS)) errs.push(`${p}.band: one of ${Object.keys(JAM_PRESETS).join(', ')}`);
      if (e.band === undefined && !(num(e.freqMHz) && num(e.bandwidthMHz) && (e.bandwidthMHz as number) > 0)) errs.push(`${p}: give a band, or freqMHz and bandwidthMHz`);
      if (!(num(e.erpW) && (e.erpW as number) > 0)) errs.push(`${p}.erpW: expected watts > 0`);
      for (const k of ['fromS', 'untilS']) if (e[k] !== undefined && !num(e[k])) errs.push(`${p}.${k}: expected seconds`);
      if (e.driftMps !== undefined && !vec(e.driftMps)) errs.push(`${p}.driftMps: expected [ve, vn, vu]`);
    });
  }
  if (o.faults !== undefined) errs.push(...checkFaults(o.faults, `${path}.faults`));
  if (o.payload !== undefined) {
    const p = o.payload;
    if (!isObj(p)) errs.push(`${path}.payload: expected an object`);
    else {
      for (const k of Object.keys(p)) if (!['name', 'massG', 'cdA', 'offset', 'releaseAux'].includes(k)) errs.push(`${path}.payload.${k}: unknown key`);
      if (!(num(p.massG) && (p.massG as number) > 0)) errs.push(`${path}.payload.massG: expected grams > 0`);
      if (p.cdA !== undefined && !(num(p.cdA) && (p.cdA as number) >= 0)) errs.push(`${path}.payload.cdA: expected m² >= 0`);
      if (p.offset !== undefined && !vec(p.offset)) errs.push(`${path}.payload.offset: expected [x, y, z]`);
      if (p.releaseAux !== undefined && !(Number.isInteger(p.releaseAux) && (p.releaseAux as number) >= 1 && (p.releaseAux as number) <= 12)) errs.push(`${path}.payload.releaseAux: AUX 1..12`);
    }
  }
  if (o.field !== undefined) {
    const f = o.field;
    if (!isObj(f) || !num(f.total) || !num(f.inclinationDeg) || !num(f.declinationDeg)) errs.push(`${path}.field: expected { total (gauss), inclinationDeg, declinationDeg }`);
  }
  return errs;
}

/** An emitter spec with its band filled in. */
export function toEmitter(s: EmitterSpec): Emitter {
  const preset = s.band ? JAM_PRESETS[s.band] : undefined;
  return {
    id: s.id, kind: s.kind ?? 'jammer', pos: { x: s.pos[0], y: s.pos[1], z: s.pos[2] },
    freqMHz: s.freqMHz ?? preset?.freqMHz ?? 2440, bandwidthMHz: s.bandwidthMHz ?? preset?.bandwidthMHz ?? 80,
    erpW: s.erpW, fromS: s.fromS, untilS: s.untilS,
    driftMps: s.driftMps ? { x: s.driftMps[0], y: s.driftMps[1], z: s.driftMps[2] } : undefined,
  };
}

interface ActiveFault { f: FaultSpec; until: number; stuck?: number[] }

const FIBER_DEFAULTS: Required<FiberSpec> = { lengthM: 10000, massGPerKm: 60, spoolMassG: 60, tensionN: 0.3, maxPayoutMps: 40 };

export class OpsLayer {
  readonly config: OpsConfig;
  /** ops time 0 on the core's clock */
  readonly t0: number;
  /** the emitters, in the world (their spec heights are above the ground: placed on the first attach) */
  readonly emitters: Emitter[];
  private placed = false;
  readonly events: OpsEvent[] = [];
  /** listener for events as they happen (the worker forwards them) */
  onEvent: ((e: OpsEvent) => void) | null = null;
  readonly mag: Magnetometer;
  readonly range: Rangefinder;
  readonly flow: OpticalFlow;
  /** the faults still to come, in time order, and the ones in force */
  private pending: FaultSpec[];
  private activeF: ActiveFault[] = [];
  private rng: Rng;
  // fibre
  private fiber: Required<FiberSpec> | null;
  paidOutM = 0; fiberBroken = false;
  private lastPos: V3 | null = null;
  // payload
  attached = false; released = false;
  private proj: { pos: V3; vel: V3; t0: number } | null = null;
  impact: { pos: V3; speed: number; t: number } | null = null;
  // mass bookkeeping: the build's own mass properties, and what was added to them
  private baseMass = 0; private baseInertia: QuadParams['inertia'] | null = null;
  // links and GNSS
  gnss: GnssJamState = { jsDb: -Infinity, cn0: 46, numSV: 12, cepScale: 1, spoofed: false, spoofer: null };
  private gnssShown: OpsStatus['gnss']['state'] = 'ok';
  private spoofT0 = 0;
  videoJamDbm = -Infinity;
  private baroOffsetM = 0; private baroHeld: number | null = null; private lastBaroT = -1;
  // fault effects, recomputed when the set changes
  private motorScale: number[] = [];
  private gyroBias = [0, 0, 0]; private gyroNoise = [0, 0, 0]; private gyroStuck: (number | null)[] = [null, null, null];
  private accBias = [0, 0, 0];
  private gpsLost = false; private gpsScale = 1; videoLost = false;
  private readonly gOut = { x: 0, y: 0, z: 0 }; private readonly aOut = { x: 0, y: 0, z: 0 };
  /** the IMU or motor path is touched (fast check in the 8 kHz loop) */
  imuTouched = false; motorsTouched = false;

  constructor(config: OpsConfig, t0: number, seed: number) {
    const errs = checkOps(config);
    if (errs.length) throw new Error(`invalid ops configuration:\n  ${errs.join('\n  ')}`);
    this.config = config;
    this.t0 = t0;
    this.emitters = (config.emitters ?? []).map(toEmitter);
    this.pending = [...(config.faults ?? [])].sort((a, b) => a.at - b.at);
    this.rng = new Rng(seed ^ 0x0b5e);
    this.mag = new Magnetometer(config.field ?? FIELD_ZURICH, seed ^ 0x3a6);
    this.range = new Rangefinder(seed ^ 0x7a6);
    this.flow = new OpticalFlow(seed ^ 0xf10);
    this.fiber = config.link?.type === 'fiber' ? { ...FIBER_DEFAULTS, ...config.link.fiber } : null;
  }

  /** Add faults to the schedule (times in ops time). */
  schedule(faults: FaultSpec[]) {
    const errs = checkFaults(faults);
    if (errs.length) throw new Error(`invalid faults:\n  ${errs.join('\n  ')}`);
    this.pending.push(...faults);
    this.pending.sort((a, b) => a.at - b.at);
  }

  /** ops time at core time t */
  time(t: number): number { return t - this.t0; }

  private emit(e: OpsEvent) { this.events.push(e); if (this.events.length > 1000) this.events.shift(); this.onEvent?.(e); }

  /** A fresh quad (a build, a respawn): link wiring, the payload back on, the spool full, the mass set. */
  attach(h: OpsHost, rebuilt: boolean) {
    const q = h.quad;
    // emitter heights are above the ground under them
    if (!this.placed) {
      this.placed = true;
      for (const e of this.emitters) e.pos.z += h.map.terrain(e.pos.x, e.pos.y);
    }
    if (rebuilt || !this.baseInertia) { this.baseMass = q.p.mass; this.baseInertia = { ...q.p.inertia }; }
    h.rcLink.wired = !!this.fiber;
    h.rcLink.band = this.config.link?.band === '900' ? 'rc900' : 'rc24';
    this.paidOutM = 0; this.fiberBroken = false; this.lastPos = null;
    h.rcLink.cut = this.cutNow();
    this.attached = !!this.config.payload; this.released = false; this.proj = null; this.impact = null;
    this.updateMass(h);
    // a warm receiver: it has a solution from the first sample on, not 0.1 s later
    this.fixAcc = 0; this.updateFix(h, this.time(h.simT));
  }

  /** Remove every effect from the quad (the configuration is being replaced or dropped). */
  detach(h: OpsHost) {
    if (this.baseInertia) h.quad.setMassProperties(this.baseMass, this.baseInertia);
    h.quad.extForce.x = 0; h.quad.extForce.y = 0; h.quad.extForce.z = 0;
    const rc = h.rcLink;
    rc.cut = false; rc.wired = false; rc.jamHitFrac = 0; rc.jamDbm = -Infinity; rc.band = 'rc24';
  }

  /** The quad's mass and inertia with the payload and the fibre still on the spool. */
  private updateMass(h: OpsHost) {
    if (!this.baseInertia) return;
    let m = this.baseMass;
    const I = { ...this.baseInertia };
    const add = (mass: number, r: V3) => {
      m += mass;
      I.xx += mass * (r.y * r.y + r.z * r.z); I.yy += mass * (r.x * r.x + r.z * r.z); I.zz += mass * (r.x * r.x + r.y * r.y);
    };
    const pl = this.config.payload;
    if (pl && this.attached) { const o = pl.offset ?? [0, 0, -0.04]; add(pl.massG / 1000, { x: o[0], y: o[1], z: o[2] }); }
    if (this.fiber) add((this.fiber.spoolMassG + this.fiber.massGPerKm * Math.max(0, this.fiber.lengthM - this.paidOutM) / 1000) / 1000, { x: -0.03, y: 0, z: -0.03 });
    if (m !== h.quad.p.mass) h.quad.setMassProperties(m, I);
  }

  private cutNow(): boolean { return this.fiberBroken || this.activeF.some((a) => a.f.kind === 'rc_loss'); }

  /** 20 Hz: control-link jamming at the drone, video jamming at the pilot, the GNSS environment. */
  updateLinks(h: OpsHost) {
    const t = this.time(h.simT), q = h.quad.s.pos, rc = h.rcLink;
    if (!this.emitters.length) return;
    const pw: PropagationWorld = { obstructionDb: (a, b) => h.world.obstructionDb(a, b), terrain: (x, y) => h.map.terrain(x, y) };
    if (!this.fiber) {
      const j = bandJamming(this.emitters, rc.bandDef, q, pw, t, rc.rxGainDbi);
      rc.jamHitFrac = j.hitFrac; rc.jamDbm = j.jamDbm;
      this.videoJamDbm = bandJamming(this.emitters, BANDS.vid58, h.pilot(), pw, t, 8).jamDbm;
    }
    const g = gnssState(this.emitters, q, pw, t);
    if (g.spoofed && !this.gnss.spoofed) this.spoofT0 = t;
    this.gnss = g;
  }

  /** The GNSS state the receiver should report now (faults over the environment). */
  gnssReport(): { numSV: number | undefined; cepScale: number; offset: V3 | null; state: OpsStatus['gnss']['state'] } {
    const g = this.gnss;
    let state: OpsStatus['gnss']['state'] = 'ok';
    let numSV: number | undefined;
    let offset: V3 | null = null;
    if (this.gpsLost) { numSV = 0; state = 'lost'; }
    else if (g.spoofed && g.spoofer) {
      const dt = Math.max(0, this.lastT - this.spoofT0), d = g.spoofer.driftMps ?? { x: 0, y: 0, z: 0 };
      offset = { x: d.x * dt, y: d.y * dt, z: d.z * dt };
      state = 'spoofed';
    } else if (this.emitters.length && g.numSV < 12) { numSV = g.numSV; state = g.numSV < 4 ? 'lost' : 'degraded'; }
    const cepScale = this.gpsScale * g.cepScale;
    if (state === 'ok' && cepScale > 1.5) state = 'degraded';
    return { numSV, cepScale, offset, state };
  }
  private lastT = 0;
  // the receiver's own solution (10 Hz): first-order Gauss-Markov error (as the u-blox model, ubxGps.ts)
  private fixAcc = 0; private fixT = 0;
  private gErr: V3 | null = null;
  cepM = 1.5; tauS = 30;
  fix: OpsStatus['fix'] = null;

  private updateFix(h: OpsHost, t: number) {
    const rep = this.gnssReport(), s = h.quad.s;
    const numSV = rep.numSV ?? 12, sig = (this.cepM * rep.cepScale) / 1.1774;
    if (!this.gErr) this.gErr = { x: sig * this.rng.gauss(), y: sig * this.rng.gauss(), z: 1.6 * sig * this.rng.gauss() };
    const a = Math.exp(-Math.max(0, t - this.fixT) / this.tauS), w = Math.sqrt(1 - a * a);
    this.fixT = t;
    const g = this.gErr;
    g.x = g.x * a + w * sig * this.rng.gauss(); g.y = g.y * a + w * sig * this.rng.gauss(); g.z = g.z * a + w * 1.6 * sig * this.rng.gauss();
    if (numSV < 4) { this.fix = null; return; }
    const o = rep.offset ?? { x: 0, y: 0, z: 0 };
    this.fix = {
      pos: [s.pos.x + g.x + o.x, s.pos.y + g.y + o.y, s.pos.z + g.z + o.z],
      vel: [s.vel.x + 0.08 * this.rng.gauss(), s.vel.y + 0.08 * this.rng.gauss(), s.vel.z + 0.12 * this.rng.gauss()],
      ephM: this.cepM * rep.cepScale * 1.2, numSV,
    };
  }

  /** Motor commands on their way to the ESCs (dead or weak outputs). */
  motors(cmd: Uint16Array) {
    const s = this.motorScale;
    for (let k = 0; k < cmd.length; k++) {
      const f = s[k];
      if (f === undefined || f === 1) continue;
      cmd[k] = f <= 0 ? 0 : cmd[k] < 48 ? cmd[k] : Math.round(48 + (cmd[k] - 48) * f);
    }
  }

  /** The gyro sample the firmware reads (rad/s, board frame). */
  gyro(g: V3): V3 {
    const o = this.gOut, b = this.gyroBias, n = this.gyroNoise, st = this.gyroStuck;
    const v = [g.x, g.y, g.z];
    for (let i = 0; i < 3; i++) {
      v[i] = st[i] ?? v[i] + b[i] + (n[i] ? n[i] * this.rng.gauss() : 0);
    }
    o.x = v[0]; o.y = v[1]; o.z = v[2];
    return o;
  }
  /** The accelerometer sample the firmware reads (m/s²). */
  acc(a: V3): V3 {
    const o = this.aOut, b = this.accBias;
    o.x = a.x + b[0]; o.y = a.y + b[1]; o.z = a.z + b[2];
    return o;
  }

  /** The barometer's pressure (Pa) after faults. */
  baro(pa: number, rho: number): number {
    if (this.baroHeld !== null) return this.baroHeld;
    return pa - this.baroOffsetM * rho * G0;
  }

  /** 1 kHz: faults on and off, the fibre, the payload. */
  tick(h: OpsHost, dt: number) {
    const t = this.time(h.simT);
    this.lastT = t;
    let changed = false;
    while (this.pending.length && this.pending[0].at <= t) {
      const f = this.pending.shift()!;
      this.start(h, f);
      changed = true;
    }
    for (let i = this.activeF.length - 1; i >= 0; i--) {
      if (t >= this.activeF[i].until) {
        const a = this.activeF.splice(i, 1)[0];
        this.emit({ type: 'fault', t, kind: a.f.kind, motor: a.f.motor, on: false });
        changed = true;
      }
    }
    if (changed) this.recompute(h);
    // barometer drift accumulates while the fault is on
    const drift = this.activeF.reduce((acc, a) => acc + (a.f.kind === 'baro_drift' ? a.f.value ?? 0 : 0), 0);
    if (drift) this.baroOffsetM += drift * dt;

    const q = h.quad, s = q.s;
    // fibre: it lies where the drone flew, so the payout is the path flown; it pulls back and lightens the spool
    if (this.fiber && !this.fiberBroken) {
      if (this.lastPos && (h.armed || this.paidOutM > 0)) {
        const d = Math.hypot(s.pos.x - this.lastPos.x, s.pos.y - this.lastPos.y, s.pos.z - this.lastPos.z);
        this.paidOutM += d;
        const v = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
        if (this.paidOutM >= this.fiber.lengthM) this.breakFiber(h, t, `the spool ran out at ${Math.round(this.fiber.lengthM)} m`);
        else if (v > this.fiber.maxPayoutMps) this.breakFiber(h, t, `payout too fast (${v.toFixed(0)} m/s)`);
        if (!this.fiberBroken && v > 0.05) {
          const k = -this.fiber.tensionN * Math.min(1, v / 2) / v;
          q.extForce.x = s.vel.x * k; q.extForce.y = s.vel.y * k; q.extForce.z = s.vel.z * k;
        } else { q.extForce.x = 0; q.extForce.y = 0; q.extForce.z = 0; }
        if (Math.floor(this.paidOutM / 25) !== Math.floor((this.paidOutM - d) / 25)) this.updateMass(h); // every 25 m
      }
      this.lastPos = { ...s.pos };
    }
    // payload: released by its AUX switch
    const pl = this.config.payload;
    if (pl && this.attached && pl.releaseAux && h.rcBuf[3 + pl.releaseAux] > 1700) this.release(h);
    if (this.proj) this.fall(h, dt, t);
    this.fixAcc += dt;
    if (this.fixAcc >= 0.1 - 1e-9) { this.fixAcc = 0; this.updateFix(h, t); }
    // GNSS state changes are events
    const st = this.gnssReport().state;
    if (st !== this.gnssShown) { this.gnssShown = st; this.emit({ type: 'gnss', t, state: st }); }
  }

  private breakFiber(h: OpsHost, t: number, reason: string) {
    this.fiberBroken = true;
    h.rcLink.cut = true;
    h.quad.extForce.x = 0; h.quad.extForce.y = 0; h.quad.extForce.z = 0;
    this.emit({ type: 'fiber_break', t, reason });
  }

  /** Drop the payload now (the API's `release`, a fault-list event, the AUX switch). */
  release(h: OpsHost): boolean {
    const pl = this.config.payload;
    if (!pl || !this.attached) return false;
    const s = h.quad.s, o = pl.offset ?? [0, 0, -0.04];
    const off = rotate({ x: 0, y: 0, z: 0 }, s.q, { x: o[0], y: o[1], z: o[2] });
    // the payload leaves with the airframe's velocity at its attachment point (v + w x r)
    const wb = s.w, r = { x: o[0], y: o[1], z: o[2] };
    const wxr = rotate({ x: 0, y: 0, z: 0 }, s.q, { x: wb.y * r.z - wb.z * r.y, y: wb.z * r.x - wb.x * r.z, z: wb.x * r.y - wb.y * r.x });
    const pos = { x: s.pos.x + off.x, y: s.pos.y + off.y, z: s.pos.z + off.z };
    const vel = { x: s.vel.x + wxr.x, y: s.vel.y + wxr.y, z: s.vel.z + wxr.z };
    const t = this.time(h.simT);
    this.attached = false; this.released = true;
    this.proj = { pos, vel, t0: t };
    this.updateMass(h);
    this.emit({ type: 'payload_release', t, pos: { ...pos }, vel: { ...vel } });
    return true;
  }

  /** The released payload falls: gravity and quadratic drag in the wind, until it hits something. */
  private fall(h: OpsHost, dt: number, t: number) {
    const p = this.proj!, pl = this.config.payload!;
    const m = pl.massG / 1000, cdA = pl.cdA ?? 0.002;
    const air = isa(Math.max(0, p.pos.z + h.map.elevationM), h.env.ambientC - 15);
    const w = h.env.wind.meanAt(Math.max(0.5, p.pos.z - h.map.terrain(p.pos.x, p.pos.y)), { x: 0, y: 0, z: 0 });
    const rx = p.vel.x - w.x, ry = p.vel.y - w.y, rz = p.vel.z - w.z, vr = Math.hypot(rx, ry, rz);
    const k = (0.5 * air.rho * cdA * vr) / m;
    const n = 4, h4 = dt / n; // 4 kHz substeps (a fast drop moves ~5 cm per ms)
    for (let i = 0; i < n; i++) {
      const a = { x: -k * rx, y: -k * ry, z: -G0 - k * rz };
      const from = { ...p.pos };
      p.vel.x += a.x * h4; p.vel.y += a.y * h4; p.vel.z += a.z * h4;
      p.pos.x += p.vel.x * h4; p.pos.y += p.vel.y * h4; p.pos.z += p.vel.z * h4;
      const step = Math.hypot(p.pos.x - from.x, p.pos.y - from.y, p.pos.z - from.z);
      const dir = step > 0 ? { x: (p.pos.x - from.x) / step, y: (p.pos.y - from.y) / step, z: (p.pos.z - from.z) / step } : { x: 0, y: 0, z: -1 };
      const hit = step > 0 ? h.world.raycast(from, dir, step) : Infinity;
      const ground = h.map.terrain(p.pos.x, p.pos.y);
      if (hit <= step || p.pos.z <= ground) {
        const at = hit <= step ? { x: from.x + dir.x * hit, y: from.y + dir.y * hit, z: from.z + dir.z * hit } : { x: p.pos.x, y: p.pos.y, z: ground };
        const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
        this.impact = { pos: at, speed, t };
        this.proj = null;
        this.emit({ type: 'payload_impact', t, pos: at, speed, flightS: t - p.t0 });
        return;
      }
      if (t - p.t0 > 120) { this.proj = null; return; } // lost (off the map)
    }
  }

  private start(h: OpsHost, f: FaultSpec) {
    const t = this.time(h.simT);
    this.emit({ type: 'fault', t, kind: f.kind, motor: f.motor, on: true });
    if (f.kind === 'payload_release') { this.release(h); return; }
    if (f.kind === 'prop_damage') {
      const a = h.quad.aero[(f.motor ?? 1) - 1];
      if (a) { const v = f.value ?? 1; a.damage = { ...a.damage, thrustFactor: Math.max(0, a.damage.thrustFactor * (1 - v)), torqueFactor: Math.max(0.05, a.damage.torqueFactor * (1 - 0.8 * v)), broken: v >= 1 || a.damage.broken }; }
      return;
    }
    if (f.kind === 'battery_degraded') { h.quad.battery.setAgeFactor(h.quad.battery.p.ageFactor * (f.value ?? 2)); return; }
    if (PERMANENT.includes(f.kind)) return;
    const a: ActiveFault = { f, until: f.duration !== undefined ? f.at + f.duration : Infinity };
    if (f.kind === 'gyro_stuck') { const g = h.quad.imu.gyroOut; a.stuck = [g.x, g.y, g.z]; }
    if (f.kind === 'baro_failure') this.baroHeld = null; // set on the next read below
    this.activeF.push(a);
  }

  /** Recompute the fault effects from the faults in force. */
  private recompute(h: OpsHost) {
    const n = h.quad.motors.length;
    this.motorScale = new Array(n).fill(1);
    this.gyroBias = [0, 0, 0]; this.gyroNoise = [0, 0, 0]; this.gyroStuck = [null, null, null]; this.accBias = [0, 0, 0];
    this.gpsLost = false; this.gpsScale = 1; this.videoLost = false;
    const d2r = Math.PI / 180;
    let baroFail = false;
    this.mag.extra.x = 0; this.mag.extra.y = 0; this.mag.extra.z = 0;
    for (const a of this.activeF) {
      const f = a.f, v = f.value ?? 0;
      switch (f.kind) {
        case 'motor_failure': this.motorScale[(f.motor ?? 1) - 1] = 0; break;
        case 'motor_degraded': this.motorScale[(f.motor ?? 1) - 1] *= v; break;
        case 'gyro_bias': for (const i of axes(f.axis)) this.gyroBias[i] += v * d2r; break;
        case 'gyro_noise': for (const i of axes(f.axis)) this.gyroNoise[i] = Math.hypot(this.gyroNoise[i], v * d2r); break;
        case 'gyro_stuck': for (const i of axes(f.axis)) this.gyroStuck[i] = a.stuck![i]; break;
        case 'acc_bias': for (const i of axes(f.axis)) this.accBias[i] += v; break;
        case 'mag_interference': for (const i of axes(f.axis)) { if (i === 0) this.mag.extra.x += v; else if (i === 1) this.mag.extra.y += v; else this.mag.extra.z += v; } break;
        case 'baro_failure': baroFail = true; break;
        case 'gps_loss': this.gpsLost = true; break;
        case 'gps_degraded': this.gpsScale *= v; break;
        case 'video_loss': this.videoLost = true; break;
        default: break;
      }
    }
    if (!baroFail) this.baroHeld = null;
    else if (this.baroHeld === null) {
      const air = isa(h.quad.s.pos.z + h.map.elevationM, h.env.ambientC - 15);
      this.baroHeld = air.pressure;
    }
    this.motorsTouched = this.motorScale.some((x) => x !== 1);
    this.imuTouched = this.gyroBias.some((x) => x !== 0) || this.gyroNoise.some((x) => x !== 0) || this.gyroStuck.some((x) => x !== null) || this.accBias.some((x) => x !== 0);
    h.rcLink.cut = this.cutNow();
  }

  /** The navigation sensors now (for observations and external autopilots). */
  navSensors(h: OpsHost): { mag: [number, number, number]; rangeM: number | null; flow: { x: number; y: number; quality: number } | null } {
    const s = h.quad.s;
    const m = this.mag.sample(s.q, s.ibus);
    const r = this.range.sample(h.world, s.pos, s.q);
    const vb = rotateInv({ x: 0, y: 0, z: 0 }, s.q, s.vel);
    const fl = Number.isFinite(r) ? this.flow.sample(r, vb, s.w) : null;
    return { mag: [m.x, m.y, m.z], rangeM: Number.isFinite(r) ? r : null, flow: fl ? { x: fl.x, y: fl.y, quality: fl.quality } : null };
  }

  /** The operational picture now. */
  status(h: OpsHost): OpsStatus {
    const rc = h.rcLink, g = this.gnss, rep = this.gnssReport(), pl = this.config.payload;
    const fin = (x: number) => (Number.isFinite(x) ? x : null);
    return {
      t: this.time(h.simT),
      link: { type: this.fiber ? 'fiber' : 'radio', band: rc.band === 'rc900' ? '900' : '2.4', lq: rc.lq, rssiDbm: rc.rssiDbm, marginDb: rc.marginDb, jamDbm: fin(rc.jamDbm), jamHitFrac: rc.jamHitFrac, cut: rc.cut },
      video: { jamDbm: fin(this.videoJamDbm), lost: this.videoLost || (!!this.fiber && this.fiberBroken) },
      gnss: { numSV: rep.numSV ?? g.numSV, cn0: g.cn0, jsDb: fin(g.jsDb), spoofed: g.spoofed, state: rep.state },
      fix: this.fix,
      fiber: this.fiber ? { paidOutM: this.paidOutM, remainingM: Math.max(0, this.fiber.lengthM - this.paidOutM), broken: this.fiberBroken } : null,
      payload: pl ? { name: pl.name ?? 'payload', attached: this.attached, released: this.released, impact: this.impact } : null,
      faults: this.activeF.map((a) => a.f.kind + (a.f.motor ? ` (motor ${a.f.motor})` : a.f.axis ? ` (${a.f.axis})` : '')),
    };
  }

  /**
   * A planning map: over a square around `centre` at `heightM` above the ground, the RC link margin
   * (dB, with the jamming of a hit channel; < 0: packets lost), the share of hop channels jammed,
   * and the GNSS satellites still tracked, from the pilot's position and the current emitters.
   */
  linkMap(h: OpsHost, o: { centre: [number, number]; halfM: number; n: number; heightM: number; txPowerMw: number; rateHz: number }) {
    const rc = h.rcLink, pilot = h.pilot(), t = this.time(h.simT);
    const pw: PropagationWorld = { obstructionDb: (a, b) => h.world.obstructionDb(a, b), terrain: (x, y) => h.map.terrain(x, y) };
    const band = rc.bandDef, fMHz = (band.lowMHz + band.highMHz) / 2;
    const sens = rc.band === 'rc900' ? ({ 200: -112, 100: -117, 50: -120, 25: -123 } as Record<number, number>)[o.rateHz] ?? -117 : ({ 500: -105, 250: -108, 150: -112, 50: -115 } as Record<number, number>)[o.rateHz] ?? -108;
    const req = LORA_REQ_SNR_DB[o.rateHz] ?? -5;
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < o.n; i++) { xs.push(o.centre[0] - o.halfM + (2 * o.halfM * i) / (o.n - 1)); ys.push(o.centre[1] - o.halfM + (2 * o.halfM * i) / (o.n - 1)); }
    const marginDb: number[][] = [], jammedFrac: number[][] = [], gnssSats: number[][] = [];
    for (const y of ys) {
      const mr: number[] = [], jr: number[] = [], gr: number[] = [];
      for (const x of xs) {
        const p = { x, y, z: h.map.terrain(x, y) + o.heightM };
        const sig = receivedDbm({ kind: 'jammer', pos: pilot, freqMHz: fMHz, bandwidthMHz: 1, erpW: (o.txPowerMw / 1000) * Math.pow(10, rc.txGainDbi / 10) }, p, pw, rc.rxGainDbi);
        const j = this.fiber ? { hitFrac: 0, jamDbm: -Infinity } : bandJamming(this.emitters, band, p, pw, t, rc.rxGainDbi);
        mr.push(this.fiber ? 99 : Math.round(10 * Math.min(sig - sens, j.hitFrac > 0 ? sig - j.jamDbm - req : Infinity)) / 10);
        jr.push(j.hitFrac);
        gr.push(gnssState(this.emitters, p, pw, t).numSV);
      }
      marginDb.push(mr); jammedFrac.push(jr); gnssSats.push(gr);
    }
    return { xs, ys, heightM: o.heightM, pilot: [pilot.x, pilot.y, pilot.z], link: this.fiber ? 'fiber' : rc.band === 'rc900' ? '900' : '2.4', marginDb, jammedFrac, gnssSats };
  }

  /** Received power of each emitter at a point (dBm), for displays and planning. */
  emitterPowers(h: OpsHost, at: V3): { id: string; dbm: number }[] {
    return this.emitters.map((e, i) => ({ id: e.id ?? `emitter ${i + 1}`, dbm: receivedDbm(e, at, h.world) }));
  }
}
