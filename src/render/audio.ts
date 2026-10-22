// Synthesised quad sound, heard from where the listener is. Per motor: a blade-pass tone (B·rpm/60)
// with harmonics, the motor's electrical whine (poles/2 · rpm/60) and broadband prop noise that
// scales with load; plus the flight controller's piezo beeper and the DShot beacon (ESCs beeping
// through the motors). Everything the quad emits goes through one spatial chain:
//   propagation delay d/343 s, smoothed (so a fly-by bends in pitch: Doppler), natural 1/d falloff
//   (no floor: a quad 500 m out is gone), air absorption as a distance low-pass, 3D panning from the
//   listener's facing (line-of-sight and chase views), and a reverb send for enclosed spaces (a
//   generated impulse response). Other pilots' quads get the same chain, one each.
// Pure helpers are exported for the tests; nothing here touches the DOM at import time.

export const SPEED_OF_SOUND = 343;
/** Distance (m) inside which the quad plays at full level; ~1/d beyond. */
export const REF_DISTANCE = 4;
const MAX_DELAY = 2.5;

type V3 = { x: number; y: number; z: number };

/** What the frame loop knows about the listener and the quad (ENU metres). */
export interface AudioExtras {
  /** the flight controller's beeper output (on = sounding); held on for long = the beeper switch */
  beeper?: boolean;
  /** DShot beacon active (ESCs beep through the motors while disarmed) */
  beacon?: boolean;
  quad?: V3; quadVel?: V3;
  listener?: V3; listenerFwd?: V3;
  /** 0 open sky .. 1 fully enclosed (reverb send) */
  enclosed?: number;
  view?: 'fpv' | 'chase' | 'los';
}

/** Level, delay and air absorption for a source d metres away. */
export function propagation(d: number): { gain: number; delay: number; lowpassHz: number } {
  const dist = Math.max(0, d);
  return {
    // spherical spreading (1/d, no floor) plus excess attenuation over ground and air
    gain: Math.min(1, REF_DISTANCE / Math.max(dist, 1e-3)) * Math.exp(-dist / 900),
    delay: Math.min(MAX_DELAY - 0.05, dist / SPEED_OF_SOUND),
    // air absorption + ground effect take the top end off with distance
    lowpassHz: Math.max(350, Math.min(20000, 20000 / (1 + dist / 35))),
  };
}

/**
 * Direction of a source in listener space (three.js audio convention: x right, y up, -z ahead),
 * unit length, from ENU positions and the listener's forward vector. No facing (or degenerate):
 * straight ahead.
 */
export function listenerDir(src: V3, lis: V3, fwd?: V3): [number, number, number] {
  const dx = src.x - lis.x, dy = src.y - lis.y, dz = src.z - lis.z, d = Math.hypot(dx, dy, dz);
  if (!fwd || d < 1e-3) return [0, 0, -1];
  const fl = Math.hypot(fwd.x, fwd.y);
  if (fl < 1e-6) return [0, 0, -1];
  const fx = fwd.x / fl, fy = fwd.y / fl; // heading in the horizontal plane; right = (fy, -fx)
  const ahead = (dx * fx + dy * fy) / d, right = (dx * fy - dy * fx) / d, up = dz / d;
  return [right, up, -ahead];
}

// Betaflight beeper sequences (src/main/io/beeper.c): on / off durations in 10 ms units. While the
// condition lasts the firmware restarts the sequence, so the repeating ones loop.
export const BEEP_PATTERNS = {
  arming: { seq: [30, 5, 5, 5], repeat: false },
  disarming: { seq: [15, 5, 15, 5], repeat: false },
  gyroCalibrated: { seq: [20, 10, 20, 10, 20, 10], repeat: false },
  lowBattery: { seq: [25, 50], repeat: true },
  critBattery: { seq: [50, 2], repeat: true },
  rxLost: { seq: [50, 50], repeat: true },
  /** beeper switch (lost-model finder): short beeps as long as it is on */
  rxSet: { seq: [10, 10], repeat: true },
  /** RX lost while landing: SOS */
  sos: { seq: [10, 10, 10, 10, 10, 40, 40, 10, 40, 10, 40, 40, 10, 10, 10, 10, 10, 70], repeat: true },
} as const;
export type BeepKind = keyof typeof BEEP_PATTERNS;

/** Is the buzzer on t seconds into a pattern? (one-shots stay off after their end) */
export function beepOn(kind: BeepKind, t: number): boolean {
  const { seq, repeat } = BEEP_PATTERNS[kind];
  const total = seq.reduce((a, b) => a + b, 0) / 100;
  if (t < 0 || (!repeat && t >= total)) return false;
  let u = (t % total) * 100;
  for (let i = 0; i < seq.length; i++) { if (u < seq[i]) return i % 2 === 0; u -= seq[i]; }
  return false;
}
/** Buzzer pitch: a typical 5 V FC piezo resonates around 2.7-4 kHz. */
export const BEEPER_HZ = 3100;
/** DShot beacon: ~260 ms beeps, resent every 1.2 s (DSHOT_BEACON_GUARD_DELAY). */
export const BEACON_ON = 0.26, BEACON_PERIOD = 1.2, BEACON_HZ = 1760;
export const beaconOn = (t: number) => ((t % BEACON_PERIOD) + BEACON_PERIOD) % BEACON_PERIOD < BEACON_ON;

/**
 * Reverb impulse response for an enclosed concrete space: a few early reflections, then a
 * decorrelated noise tail decaying 60 dB in rt60 s that also loses its highs faster (absorption).
 */
export function impulseResponse(rate: number, rt60 = 1.3, seconds = 1.6, seed = 7): Float32Array[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = Math.max(1, Math.floor(rate * seconds));
  return [0, 1].map(() => {
    const d = new Float32Array(n);
    for (let k = 0; k < 6; k++) { const i = Math.floor((0.007 + rnd() * 0.035) * rate); if (i < n) d[i] += (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.4) * Math.exp(-k * 0.3); }
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate, env = Math.exp((-6.91 * t) / rt60) * Math.min(1, t / 0.004);
      const a = 0.85 - 0.6 * Math.min(1, t / rt60); // one-pole low-pass closing over the tail
      lp += a * ((rnd() * 2 - 1) - lp);
      d[i] += lp * env * 0.6;
    }
    return d;
  });
}

// ---------------------------------------------------------------------------------------------

/** The target last sent to each AudioParam (see target()). */
const sent = new WeakMap<AudioParam, number>();
/**
 * setTargetAtTime, unless the param is already heading for (practically) the same value. The frame
 * loop updates ~35 params every frame (11 more per remote pilot) and most of them hold still most of
 * the time (idle or paused motors, the beeper off, volume and mute, the panner in FPV); each call is
 * a binding call that adds an automation event. A target that changes, even by a step (the beeper
 * and beacon gates), goes out at once with its own time constant. The tolerance (1e-5 relative) is
 * far below anything audible: 0.02 Hz at 2 kHz, 0.3 us of a 30 ms propagation delay.
 */
function target(p: AudioParam, v: number, t: number, tc: number) {
  const prev = sent.get(p);
  if (prev !== undefined && Math.abs(v - prev) <= 1e-5 * Math.max(Math.abs(v), Math.abs(prev)) + 1e-9) return;
  sent.set(p, v);
  p.setTargetAtTime(v, t, tc);
}

/** One sound source's path to the listener: delay -> air low-pass -> panner -> level, + reverb send. */
class SpatialChain {
  readonly input: GainNode;
  private delay: DelayNode;
  private lp: BiquadFilterNode;
  private panner: PannerNode | StereoPannerNode;
  private out: GainNode;
  private send: GainNode;
  private lastD = -1;
  private lastDir: [number, number, number] = [NaN, NaN, NaN];
  constructor(private ctx: AudioContext, dest: AudioNode, reverb: AudioNode | null) {
    this.input = ctx.createGain();
    this.delay = ctx.createDelay(MAX_DELAY);
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 20000; this.lp.Q.value = 0.5;
    let p: PannerNode | StereoPannerNode;
    try {
      const pn = ctx.createPanner();
      pn.panningModel = 'HRTF'; pn.distanceModel = 'linear'; pn.refDistance = 1; pn.maxDistance = 1e4; pn.rolloffFactor = 0; // level is ours
      // the direction is set once a frame anyway: per render quantum (k-rate) is plenty, and spares the
      // panner its per-sample azimuth / elevation path while the position automation runs
      for (const q of [pn.positionX, pn.positionY, pn.positionZ]) { try { if (q) q.automationRate = 'k-rate'; } catch { /* fixed a-rate */ } }
      p = pn;
    } catch { p = ctx.createStereoPanner(); }
    this.panner = p;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    this.send = ctx.createGain(); this.send.gain.value = 0;
    this.input.connect(this.delay).connect(this.lp).connect(this.panner).connect(this.out).connect(dest);
    if (reverb) this.lp.connect(this.send).connect(reverb);
  }
  /** distance (m), listener-space direction, enclosure 0..1. A jump (teleport, view switch) resets the delay instead of sweeping it. */
  set(d: number, dir: [number, number, number], enclosed: number, levelScale = 1) {
    const t = this.ctx.currentTime, pr = propagation(d), jump = this.lastD < 0 || Math.abs(d - this.lastD) > 25;
    this.lastD = d;
    if (jump) {
      this.delay.delayTime.cancelScheduledValues(t); this.delay.delayTime.setValueAtTime(pr.delay, t); sent.set(this.delay.delayTime, pr.delay);
      this.out.gain.cancelScheduledValues(t); this.out.gain.setValueAtTime(0, t); sent.delete(this.out.gain);
    } else target(this.delay.delayTime, pr.delay, t, 0.06); // smooth: the rate of change is the Doppler shift
    target(this.out.gain, pr.gain * levelScale, t, jump ? 0.02 : 0.05);
    target(this.lp.frequency, pr.lowpassHz, t, 0.05);
    target(this.send.gain, 0.5 * Math.pow(Math.max(0, Math.min(1, enclosed)), 1.5) * pr.gain * levelScale, t, 0.1);
    const p = this.panner;
    if ('positionX' in p && p.positionX) {
      target(p.positionX, dir[0], t, 0.03); target(p.positionY, dir[1], t, 0.03); target(p.positionZ, dir[2], t, 0.03);
    } else if ('setPosition' in p) {
      if (dir[0] !== this.lastDir[0] || dir[1] !== this.lastDir[1] || dir[2] !== this.lastDir[2]) { (p as PannerNode).setPosition(dir[0], dir[1], dir[2]); this.lastDir = [dir[0], dir[1], dir[2]]; }
    } else target((p as StereoPannerNode).pan, Math.max(-1, Math.min(1, dir[0])), t, 0.03);
  }
  disconnect() { this.input.disconnect(); this.out.disconnect(); this.send.disconnect(); }
}

interface RemoteVoice { chain: SpatialChain; osc: OscillatorNode; g: GainNode; noise: AudioBufferSourceNode; nf: BiquadFilterNode; ng: GainNode; seen: number }
export interface RemoteSound { id: number; pos: V3; rpm: number[] | number }

export class MotorAudio {
  private ctx: AudioContext | null = null;
  private voices: { osc: OscillatorNode; whine: OscillatorNode; g: GainNode; wg: GainNode; nf: BiquadFilterNode; ng: GainNode }[] = [];
  private master!: GainNode;
  private speakers!: GainNode;
  private reverb: ConvolverNode | null = null;
  private quad!: SpatialChain;
  private beepOsc!: OscillatorNode;
  private beepGain!: GainNode;
  private stream: MediaStreamAudioDestinationNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private remotes = new Map<number, RemoteVoice>();
  private spatialKnown = false;
  private beepHeldSince = -1;
  private pattern: { kind: BeepKind; t0: number } | null = null;
  private beaconT0 = -1;
  private last: { listener?: V3; fwd?: V3; view?: AudioExtras['view']; enclosed: number } = { enclosed: 0 };
  private muted = false;
  enabled = true;
  volume = 0.5;
  /** the FC's beeper and the ESCs' DShot beacon, relative to the rest (Settings: Beeper volume) */
  beeperLevel = 1;

  /**
   * Browsers only let audio start after a mouse / touch / keyboard gesture on the page; gamepad and
   * WebHID controller input does not count. Call this from every such gesture: it creates the
   * context the first time and resumes it whenever the browser has suspended it.
   */
  unlock() {
    this.start();
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  /** True when sound is enabled but the browser is still blocking playback. */
  get blocked(): boolean { return this.enabled && (!this.ctx || this.ctx.state !== 'running'); }

  start() {
    if (this.ctx) return;
    // Safari < 14.1 only has the prefixed constructor; some WebKit builds have no Web Audio at all
    const AC: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = this.enabled ? this.volume : 0;
    this.speakers = ctx.createGain(); this.speakers.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.speakers).connect(ctx.destination);
    try {
      this.reverb = ctx.createConvolver();
      const ir = impulseResponse(ctx.sampleRate), buf = ctx.createBuffer(2, ir[0].length, ctx.sampleRate);
      buf.getChannelData(0).set(ir[0]); buf.getChannelData(1).set(ir[1]);
      this.reverb.buffer = buf;
      this.reverb.connect(this.master);
    } catch { this.reverb = null; }
    this.quad = new SpatialChain(ctx, this.master, this.reverb);
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;
    for (let k = 0; k < 4; k++) {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      const g = ctx.createGain(); g.gain.value = 0;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
      osc.connect(lp).connect(g).connect(this.quad.input);
      const whine = ctx.createOscillator(); whine.type = 'triangle';
      const wg = ctx.createGain(); wg.gain.value = 0; whine.connect(wg).connect(this.quad.input);
      const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.Q.value = 0.8;
      const ng = ctx.createGain(); ng.gain.value = 0;
      n.connect(nf).connect(ng).connect(this.quad.input);
      osc.start(); whine.start(); n.start(ctx.currentTime + Math.random());
      this.voices.push({ osc, whine, g, wg, nf, ng });
    }
    // piezo: a square wave through its resonance
    this.beepOsc = ctx.createOscillator(); this.beepOsc.type = 'square'; this.beepOsc.frequency.value = BEEPER_HZ;
    const res = ctx.createBiquadFilter(); res.type = 'bandpass'; res.frequency.value = BEEPER_HZ; res.Q.value = 3;
    this.beepGain = ctx.createGain(); this.beepGain.gain.value = 0;
    this.beepOsc.connect(res).connect(this.beepGain).connect(this.quad.input);
    this.beepOsc.start();
  }

  /** Mute the speakers (the DVR stream keeps recording). */
  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) target(this.speakers.gain, m ? 0 : 1, this.ctx.currentTime, 0.02); // (the frame loop says so every frame)
  }

  /** What the pilot hears, for recording (DVR); null until the audio has been unlocked. */
  mediaStream(): MediaStream | null {
    if (!this.ctx) return null;
    if (!this.stream) {
      try { this.stream = this.ctx.createMediaStreamDestination(); this.master.connect(this.stream); } catch { return null; }
    }
    return this.stream.stream;
  }

  /** Play one of Betaflight's beeper patterns from the quad (null stops a repeating one). */
  beep(kind: BeepKind | null) {
    this.pattern = kind && this.ctx ? { kind, t0: this.ctx.currentTime } : null;
  }

  /**
   * rpm per motor, battery current (A), blades, motor poles. distance: listener to quad (m), used
   * when extras carry no positions. wash: prop-wash / VRS fraction 0..1 (buffeting). extras:
   * positions / facing for the spatial chain, beeper and beacon (see AudioExtras).
   */
  update(rpm: number[], loadA: number, blades: number, poles: number, distance = 1, wash = 0, extras?: AudioExtras) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    target(this.master.gain, this.enabled ? this.volume : 0, t, 0.05);
    // ---- where the quad is, relative to the listener ----
    let d = distance, dir: [number, number, number] = [0, 0, -1];
    if (extras?.quad && extras.listener) {
      this.spatialKnown = true;
      d = Math.hypot(extras.quad.x - extras.listener.x, extras.quad.y - extras.listener.y, extras.quad.z - extras.listener.z);
      // FPV: the pilot is under goggles facing the quad's general direction: no panning, the
      // distance cues (delay, level, air) stay; spectator views pan from the camera's facing
      if (extras.view !== 'fpv') dir = listenerDir(extras.quad, extras.listener, extras.listenerFwd);
    }
    if (extras) this.last = { listener: extras.listener, fwd: extras.listenerFwd, view: extras.view, enclosed: extras.enclosed ?? 0 };
    this.quad.set(d, dir, this.last.enclosed);
    // ---- motors (or the DShot beacon through them) ----
    const spinning = rpm.some((r) => Math.abs(r) > 500);
    if (extras?.beacon && !spinning) { if (this.beaconT0 < 0) this.beaconT0 = t; } else this.beaconT0 = -1;
    const beacon = this.beaconT0 >= 0 && beaconOn(t - this.beaconT0);
    for (let k = 0; k < 4; k++) {
      const v = this.voices[k], r = Math.abs(rpm[k] ?? 0);
      const f = Math.max(20, (r / 60) * blades);
      if (this.beaconT0 >= 0) {
        // ESC beacon: the windings driven at an audio tone, each motor a touch apart
        target(v.osc.frequency, BEACON_HZ * (1 + k * 0.004), t, 0.002);
        target(v.g.gain, beacon ? 0.018 * this.beeperLevel : 0, t, 0.004);
        target(v.wg.gain, 0, t, 0.01); target(v.ng.gain, 0, t, 0.01);
        continue;
      }
      target(v.osc.frequency, f, t, 0.01);
      // electrical frequency: pole pairs × mechanical revolutions per second
      target(v.whine.frequency, Math.max(40, (r / 60) * (poles / 2)), t, 0.01);
      const a = Math.min(1, r / 30000);
      target(v.g.gain, 0.05 * a * a, t, 0.02);
      target(v.wg.gain, 0.004 * a, t, 0.02);
      // in prop wash the broadband noise drops in pitch and flutters (blades chopping their own wake)
      const flutter = wash > 0.05 ? 1 + wash * (Math.random() - 0.5) * 1.6 : 1;
      target(v.nf.frequency, (400 + f * 2) * (1 - 0.5 * wash), t, 0.02);
      target(v.ng.gain, (0.06 * a * a + Math.min(0.08, loadA / 2500) + 0.05 * wash * a) * flutter, t, 0.012);
    }
    // ---- beeper: the FC's buzzer output; held on (the beeper switch) it plays the lost-model beeps ----
    let on = false;
    if (extras?.beeper) {
      if (this.beepHeldSince < 0) this.beepHeldSince = t;
      on = t - this.beepHeldSince < 0.6 || beepOn('rxSet', t - this.beepHeldSince - 0.6);
    } else this.beepHeldSince = -1;
    if (this.pattern) {
      const pt = t - this.pattern.t0;
      on ||= beepOn(this.pattern.kind, pt);
      if (!BEEP_PATTERNS[this.pattern.kind].repeat && pt > 2) this.pattern = null;
    }
    // a 3.1 kHz piezo sits where hearing is most sensitive: well under the motors at full level
    target(this.beepGain.gain, on ? 0.035 * this.beeperLevel : 0, t, 0.003);
  }

  /** Crash / prop strike from the quad: a low thud plus a plastic-and-carbon clatter, strength 0..1. */
  impact(strength: number, distance = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf || !this.enabled || strength <= 0) return;
    // with positions known the spatial chain places it (delay, level, pan); else the old 1/d level
    const t = ctx.currentTime, k = Math.min(1, strength) * (this.spatialKnown ? 1 : Math.min(1, REF_DISTANCE / Math.max(0.1, distance)));
    const burst = (freq: number, q: number, gain: number, decay: number) => {
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.setValueAtTime(gain * k, t); g.gain.exponentialRampToValueAtTime(1e-4, t + decay);
      n.connect(f).connect(g).connect(this.spatialKnown ? this.quad.input : this.master);
      n.start(t, Math.random()); n.stop(t + decay + 0.05);
    };
    // (both paths end in the master gain, which carries the volume)
    burst(140, 0.7, 0.9, 0.18);   // body thud
    burst(2600, 1.2, 0.35, 0.09); // props / carbon clatter
  }

  /**
   * Other pilots' quads (ENU positions, rpm per motor or their average), heard from `listener`
   * (with the facing given to update()). The 6 nearest play; voices for quads that left fade out.
   */
  updateRemote(list: RemoteSound[], listener: V3, fwd?: V3) {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf) return;
    const t = ctx.currentTime, facing = fwd ?? this.last.fwd, view = this.last.view;
    const near = list.map((r) => ({ r, d: Math.hypot(r.pos.x - listener.x, r.pos.y - listener.y, r.pos.z - listener.z) })).sort((a, b) => a.d - b.d).slice(0, 6);
    for (const { r, d } of near) {
      let v = this.remotes.get(r.id);
      if (!v) {
        const chain = new SpatialChain(ctx, this.master, this.reverb);
        const osc = ctx.createOscillator(); osc.type = 'sawtooth';
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
        const g = ctx.createGain(); g.gain.value = 0;
        osc.connect(lp).connect(g).connect(chain.input);
        const noise = ctx.createBufferSource(); noise.buffer = this.noiseBuf; noise.loop = true;
        const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.Q.value = 0.8;
        const ng = ctx.createGain(); ng.gain.value = 0;
        noise.connect(nf).connect(ng).connect(chain.input);
        osc.start(); noise.start(t + Math.random());
        v = { chain, osc, g, noise, nf, ng, seen: t };
        this.remotes.set(r.id, v);
      }
      v.seen = t;
      const rpm = Array.isArray(r.rpm) ? r.rpm.reduce((s, x) => s + Math.abs(x), 0) / Math.max(1, r.rpm.length) : Math.abs(r.rpm);
      const f = Math.max(20, (rpm / 60) * 3), a = Math.min(1, rpm / 30000); // blade count unknown: tri-blades
      target(v.osc.frequency, f, t, 0.02);
      target(v.g.gain, 0.1 * a * a, t, 0.03);          // four motors' worth
      target(v.nf.frequency, 400 + f * 2, t, 0.03);
      target(v.ng.gain, 0.14 * a * a, t, 0.03);
      v.chain.set(d, view === 'fpv' ? [0, 0, -1] : listenerDir(r.pos, listener, facing), this.last.enclosed);
    }
    for (const [id, v] of this.remotes) {
      if (v.seen === t) continue;
      target(v.g.gain, 0, t, 0.05); target(v.ng.gain, 0, t, 0.05);
      if (t - v.seen > 0.5) { v.osc.stop(); v.noise.stop(); v.chain.disconnect(); this.remotes.delete(id); }
    }
  }
}
