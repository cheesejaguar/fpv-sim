// Synthesised motor / prop sound: per motor, a blade-pass tone (B·rpm/60) with harmonics, the
// motor's electrical whine (poles/2 · rpm/60) and broadband prop noise that scales with load.
export class MotorAudio {
  private ctx: AudioContext | null = null;
  private voices: { osc: OscillatorNode; whine: OscillatorNode; g: GainNode; wg: GainNode; nf: BiquadFilterNode; ng: GainNode }[] = [];
  private master!: GainNode;
  enabled = true;
  volume = 0.5;

  start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = this.volume; this.master.connect(ctx.destination);
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    for (let k = 0; k < 4; k++) {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      const g = ctx.createGain(); g.gain.value = 0;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
      osc.connect(lp).connect(g).connect(this.master);
      const whine = ctx.createOscillator(); whine.type = 'triangle';
      const wg = ctx.createGain(); wg.gain.value = 0; whine.connect(wg).connect(this.master);
      const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
      const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.Q.value = 0.8;
      const ng = ctx.createGain(); ng.gain.value = 0;
      n.connect(nf).connect(ng).connect(this.master);
      osc.start(); whine.start(); n.start(ctx.currentTime + Math.random());
      this.voices.push({ osc, whine, g, wg, nf, ng });
    }
  }

  update(rpm: number[], loadA: number, blades: number, poles: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, t, 0.05);
    for (let k = 0; k < 4; k++) {
      const v = this.voices[k], r = Math.abs(rpm[k] ?? 0);
      const f = Math.max(20, (r / 60) * blades);
      v.osc.frequency.setTargetAtTime(f, t, 0.01);
      v.whine.frequency.setTargetAtTime(Math.max(40, (r / 60) * (poles / 2) * 2), t, 0.01);
      const a = Math.min(1, r / 30000);
      v.g.gain.setTargetAtTime(0.05 * a * a, t, 0.02);
      v.wg.gain.setTargetAtTime(0.004 * a, t, 0.02);
      v.nf.frequency.setTargetAtTime(400 + f * 2, t, 0.02);
      v.ng.gain.setTargetAtTime(0.06 * a * a + Math.min(0.08, loadA / 2500), t, 0.03);
    }
  }
}
