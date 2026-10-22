// MotorAudio against a fake Web Audio graph: unchanged targets are not sent again every frame, and a
// change (the beeper gate flipping, the motors spinning up) still goes out at once.
import { beforeAll, expect, test } from 'vitest';

let calls = 0;
const log: { param: FakeParam; v: number; tc: number }[] = [];
class FakeParam {
  value = 0; automationRate = 'a-rate';
  setTargetAtTime(v: number, _t: number, tc: number) { calls++; log.push({ param: this, v, tc }); return this; }
  setValueAtTime(v: number) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
  exponentialRampToValueAtTime() { return this; }
}
class FakeNode {
  gain = new FakeParam(); frequency = new FakeParam(); Q = new FakeParam(); delayTime = new FakeParam(); pan = new FakeParam();
  positionX = new FakeParam(); positionY = new FakeParam(); positionZ = new FakeParam();
  type = ''; buffer: unknown = null; loop = false; panningModel = ''; distanceModel = ''; refDistance = 0; maxDistance = 0; rolloffFactor = 0;
  connect<T>(n: T) { return n; }
  disconnect() {}
  start() {} stop() {}
}
class FakeContext {
  currentTime = 0; sampleRate = 8000; state = 'running'; destination = new FakeNode();
  createGain() { return new FakeNode(); } createDelay() { return new FakeNode(); } createBiquadFilter() { return new FakeNode(); }
  createPanner() { return new FakeNode(); } createStereoPanner() { return new FakeNode(); } createOscillator() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); } createConvolver() { return new FakeNode(); }
  createBuffer(_c: number, n: number) { const d = [new Float32Array(n), new Float32Array(n)]; return { getChannelData: (i: number) => d[i] }; }
  resume() { return Promise.resolve(); }
}

let MotorAudio: typeof import('../src/render/audio').MotorAudio;
beforeAll(async () => {
  (globalThis as any).window = { AudioContext: FakeContext };
  ({ MotorAudio } = await import('../src/render/audio'));
});

const extras = (beeper: boolean) => ({ beeper, beacon: false, quad: { x: 0, y: 5, z: 2 }, quadVel: { x: 0, y: 0, z: 0 }, listener: { x: 0, y: 0, z: 1.6 }, listenerFwd: { x: 0, y: 1, z: 0 }, enclosed: 0, view: 'fpv' as const });

test('a quad sitting still costs no automation events after the first frame', () => {
  const a = new MotorAudio();
  a.unlock();
  const ctx = (a as any).ctx as FakeContext;
  a.update([0, 0, 0, 0], 0, 3, 14, 5, 0, extras(false)); a.setMuted(false);
  const first = calls;
  expect(first).toBeGreaterThan(30); // everything sent once
  for (let i = 0; i < 100; i++) { ctx.currentTime += 0.007; a.update([0, 0, 0, 0], 0, 3, 14, 5, 0, extras(false)); a.setMuted(false); }
  expect(calls).toBe(first);
});

test('changes go out at once: the beeper gate, spinning motors, mute', () => {
  const a = new MotorAudio();
  a.unlock();
  const ctx = (a as any).ctx as FakeContext;
  a.update([0, 0, 0, 0], 0, 3, 14, 5, 0, extras(false));
  const beep = (a as any).beepGain.gain as FakeParam;
  log.length = 0;
  ctx.currentTime += 0.007; a.update([0, 0, 0, 0], 0, 3, 14, 5, 0, extras(true));
  expect(log.filter((l) => l.param === beep).map((l) => l.v)).toEqual([0.035]); // on, with its 3 ms time constant
  expect(log.find((l) => l.param === beep)!.tc).toBe(0.003);
  log.length = 0;
  ctx.currentTime += 0.007; a.update([20000, 20000, 20000, 20000], 10, 3, 14, 5, 0, extras(true));
  const v0 = (a as any).voices[0];
  expect(log.some((l) => l.param === v0.osc.frequency && l.v === 1000)).toBe(true); // 20 000 rpm × 3 blades / 60
  log.length = 0;
  a.setMuted(true); a.setMuted(true);
  expect(log.filter((l) => l.param === (a as any).speakers.gain).map((l) => l.v)).toEqual([0]);
});

test('the panner position is k-rate', () => {
  const a = new MotorAudio();
  a.unlock();
  const pn = (a as any).quad.panner as FakeNode;
  expect(pn.positionX.automationRate).toBe('k-rate');
});
