import { describe, expect, test } from 'vitest';
import { bindActive, controllerKind, djiRc3Profile, guessProfile } from '../src/input/gamepad';
import { RadioWizard } from '../src/input/radioWizard';

// Simulated radio: throttle on axis 5 (up = -1), yaw axis 0, pitch axis 2 (forward = -1), roll axis 1,
// arm = 2-position switch on axis 4 (off = -1), mode = 3-position switch on axis 3 (rest -1).
function fakePad() {
  const axes = [0, 0, 0, -1, -1, 1, 0, 0];
  const buttons = Array.from({ length: 12 }, () => ({ pressed: false, value: 0, touched: false }));
  return { id: 'DJI Virtual Joystick (Vendor: 2ca3 Product: 1021)', index: 0, mapping: '', axes, buttons, connected: true, timestamp: 0 } as any;
}

describe('controller detection', () => {
  test.each([
    ['Xbox 360 Controller (XInput STANDARD GAMEPAD)', 'xbox'],
    ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'xbox'],
    ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'playstation'],
    ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0df2)', 'playstation'],
    ['DJI Virtual Joystick (Vendor: 2ca3 Product: 1021)', 'dji'],
    ['Steam Controller (2026) — WebHID Puck (Vendor: 28de Product: 1304)', 'steam'],
    ['Logitech Extreme 3D (Vendor: 046d Product: c215)', 'generic'],
  ])('%s -> %s', (id, kind) => expect(controllerKind({ id })).toBe(kind));

  test('DJI radio gets the radio profile and asks for setup', () => {
    const p = guessProfile(fakePad());
    expect(p.kind).toBe('dji');
    expect(p.needsSetup).toBe(true);
    expect(p.roll.deadzone).toBe(0);
  });
});

describe('radio setup wizard', () => {
  test('detects scrambled, reversed axes and switch-on-axis bindings', () => {
    const pad = fakePad();
    const w = new RadioWizard(djiRc3Profile(pad.id));
    w.next(pad); // centred, throttle down
    pad.axes[5] = -1; w.update(pad);                 // throttle up = axis 5 going negative
    expect(w.profile.throttle).toMatchObject({ index: 5, invert: true });
    pad.axes[0] = 1; w.update(pad);                  // yaw right
    expect(w.profile.yaw).toMatchObject({ index: 0, invert: false });
    pad.axes[0] = 0; pad.axes[2] = -1; w.update(pad); // pitch forward = axis 2 negative
    expect(w.profile.pitch).toMatchObject({ index: 2, invert: true });
    pad.axes[2] = 0; pad.axes[1] = 1; w.update(pad);  // roll right
    expect(w.profile.roll).toMatchObject({ index: 1, invert: false });
    expect(w.current.key).toBe('sweep');
    for (const v of [-1, 1]) { pad.axes[0] = v; pad.axes[1] = v; pad.axes[2] = v; pad.axes[5] = v; w.update(pad); }
    pad.axes[0] = 0; pad.axes[1] = 0; pad.axes[2] = 0; pad.axes[5] = 1;
    w.next(pad);
    expect(w.profile.throttle.center).toBeCloseTo(0, 5);
    expect(w.profile.roll).toMatchObject({ min: -1, max: 1, center: 0 });
    pad.axes[4] = 1; w.update(pad);                   // arm switch on axis 4
    expect(w.profile.arm).toMatchObject({ src: 'axis', index: 4, mode: 'hold', invert: false });
    pad.axes[4] = -1;
    pad.axes[3] = 0; w.update(pad);                   // mode switch to middle
    expect(w.profile.mode).toMatchObject({ src: 'axis', index: 3, mode: 'switch3' });
    expect(w.finished).toBe(true);
    expect(w.profile.needsSetup).toBe(false);
    // binding semantics
    pad.axes[4] = 1; expect(bindActive(pad, w.profile.arm!)).toBe(true);
    pad.axes[4] = -1; expect(bindActive(pad, w.profile.arm!)).toBe(false);
  });

  test('momentary button becomes toggle, latching switch becomes hold', () => {
    const pad = fakePad();
    const w = new RadioWizard(djiRc3Profile(pad.id));
    w.step = 6; w.next = w.next.bind(w);
    (w as any).snapshot(pad);
    pad.buttons[3].pressed = true; w.update(pad, 0);
    pad.buttons[3].pressed = false; w.update(pad, 700);
    expect(w.profile.arm).toMatchObject({ src: 'button', index: 3, mode: 'toggle' });
    (w as any).snapshot(pad);
    pad.buttons[7].pressed = true; w.update(pad, 1000); w.update(pad, 1700);
    expect(w.profile.mode).toMatchObject({ src: 'button', index: 7, mode: 'hold' });
  });
});
