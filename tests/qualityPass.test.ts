// Small regressions from the quality pass: API replies stay in request order (errors too), a
// randomized fault motor is a whole motor number with even odds, stored settings keep a user map and
// long course ids, a broken controller profile is caught, a full-range throttle has no centre dead
// band, and an oversized replay header fails at encoding.
import { describe, expect, test } from 'vitest';
import { validSim } from '../src/app/persist';
import { genericJoystickProfile, readSticks, validProfile } from '../src/input/gamepad';
import { encodeReplay } from '../server/src/replayFormat';
import { ApiSession } from '../src/api/protocol';
import { sampleOps } from '../src/scenario/randomize';
import { Rng } from '../src/sim/math';

describe('API session', () => {
  test('an invalid request is answered in turn, not ahead of the requests before it', async () => {
    const out: { id?: unknown; ok: boolean }[] = [];
    // a reset that takes a while, then a broken step: the step's error must come second
    const s = new ApiSession({ handle: async () => { await new Promise((r) => setTimeout(r, 30)); return {}; } }, (t) => out.push(JSON.parse(t)));
    void s.receive(JSON.stringify({ cmd: 'reset' }));
    await s.receive('{"cmd": "step", "action": {"roll": "lots"}}');
    expect(out.map((r) => r.ok)).toEqual([true, false]);
  });
});

describe('scenario randomization', () => {
  test('faultMotor { uniform: [1, 4] } picks motors 1-4 with even odds', () => {
    const rng = new Rng(3), n = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 8000; i++) {
      const o = sampleOps({ faults: [{ kind: 'motor_failure', at: 1, motor: 1 }] }, { faultMotor: { uniform: [1, 4] } }, rng);
      n[o.faults![0].motor!]++;
    }
    expect(n[0]).toBe(0); expect(n[5]).toBe(0);
    for (const k of [1, 2, 3, 4]) expect(n[k] / 8000).toBeGreaterThan(0.22);
  });
});

// ---- app: settings, controller profiles, sticks, replays ----

describe('stored settings', () => {
  test('a user map flown last session is kept (restored once fetched), a course id may be 32 characters', () => {
    const s = validSim({ mapId: 'u-abcdefghijklmnopqrst', courseId: 'downhill-technical-section-a' });
    expect(s.mapId).toBe('u-abcdefghijklmnopqrst');
    expect(s.courseId).toBe('downhill-technical-section-a');
    expect(validSim({ mapId: 'not-a-map' }).mapId).not.toBe('not-a-map');
  });
});

describe('controller input', () => {
  const pad = (axes: number[]) => ({ id: 'Generic USB Joystick', index: 0, mapping: '', axes, buttons: [], connected: true, timestamp: 0 }) as unknown as Gamepad;
  test('a stored profile missing its sticks is not valid (it is replaced by the guess)', () => {
    const p = genericJoystickProfile();
    expect(validProfile(p)).toBe(true);
    const { roll: _r, ...broken } = p;
    expect(validProfile(broken)).toBe(false);
    expect(validProfile({ ...p, throttle: { ...p.throttle, min: 'low' } })).toBe(false);
  });
  test('a full-range throttle has no dead band around its middle', () => {
    const p = genericJoystickProfile(); // throttle on axis 2, inverted, full range
    const t = (raw: number) => readSticks(pad([0, 0, raw, 0]), p).throttle;
    // 1 % off centre moves the throttle (a 2 % deadzone held it at mid-stick)
    expect(Math.abs(t(-0.01) - t(0))).toBeGreaterThan(0.005);
  });
});

describe('replays', () => {
  test('a header longer than readers accept fails at encoding, with the reason', async () => {
    const header = { cols: [], n: 0, spec: { apScripts: { 'big.lua': 'x'.repeat(20000) } } } as unknown as Parameters<typeof encodeReplay>[0]['header'];
    await expect(encodeReplay({ header, columns: {}, osd: [] } as unknown as Parameters<typeof encodeReplay>[0])).rejects.toThrow(/replay header is \d+ bytes; at most 16384/);
  });
});
