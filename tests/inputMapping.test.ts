// Gamepad -> RC channel mapping: first-flight defaults, stick geometry, presets vs browser mapping,
// AUX5-12 bindings and radio passthrough.
import { beforeEach, describe, expect, test } from 'vitest';
import { auxMicros, genericJoystickProfile, guessProfile, InputManager, InputProfile, isRadio, isStandard, MODE_ANGLE, readSticks, standardProfile, stick2d, xboxProfile } from '../src/input/gamepad';
import { RadioWizard } from '../src/input/radioWizard';

const store = new Map<string, string>();
Object.assign(globalThis as any, {
  window: { addEventListener: () => {} },
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
});
if (!(globalThis as any).navigator) (globalThis as any).navigator = {};

type Btn = { pressed: boolean; touched: boolean; value: number };
const mkPad = (o: { id?: string; index?: number; mapping?: string; axes?: number[]; pressed?: number[]; values?: Record<number, number> } = {}) => ({
  id: o.id ?? 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: o.index ?? 0, mapping: o.mapping ?? 'standard', connected: true, timestamp: 0,
  axes: o.axes ?? [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (_, i): Btn => { const v = o.values?.[i] ?? (o.pressed?.includes(i) ? 1 : 0); return { pressed: v > 0.5, touched: v > 0, value: v }; }),
}) as unknown as Gamepad;
const setPads = (...pads: Gamepad[]) => { (navigator as any).getGamepads = () => pads; };

beforeEach(() => { store.clear(); setPads(); });

describe('first flight', () => {
  test('a new gamepad starts in Angle with the throttle at idle when the stick is released', () => {
    const im = new InputManager();
    setPads(mkPad());
    const ch = im.poll();
    expect(im.modeIdx).toBe(MODE_ANGLE);
    expect(ch[5]).toBe(2000); // AUX2 high = ANGLE in the sim's Betaflight modes
    expect(ch[2]).toBe(1000); // spring-centred stick, 'upper' throttle: centre = off (not 50 %)
    expect(im.profileFor(mkPad()).throttleMode).toBe('upper');
  });

  test('LB still cycles acro -> horizon -> angle from there', () => {
    const im = new InputManager();
    const seen: number[] = [];
    for (const pressed of [[], [4], [], [4], [], [4]]) { setPads(mkPad({ pressed })); seen.push(im.poll()[5]); }
    expect(seen).toEqual([2000, 1000, 1000, 1500, 1500, 2000]);
  });

  test('the keyboard fallback starts in Angle too', () => {
    const im = new InputManager();
    expect(im.poll()[5]).toBe(2000);
    expect(im.keyboard.modeIdx).toBe(MODE_ANGLE);
  });
});

describe('stick geometry', () => {
  test('circle -> square: full diagonal reaches 1.0 on both axes, axes and centre unchanged', () => {
    const d = Math.SQRT1_2;
    const [x, y] = stick2d(d, -d, 0, true);
    expect(x).toBeCloseTo(1, 4); expect(y).toBeCloseTo(-1, 4);
    expect(stick2d(1, 0, 0, true)[0]).toBeCloseTo(1, 6);
    expect(stick2d(0.5, 0, 0, true)[0]).toBeCloseTo(0.5, 6);
    const [sx, sy] = stick2d(0.1, 0.05, 0, true);
    expect(sx).toBeCloseTo(0.1, 2); expect(sy).toBeCloseTo(0.05, 2);
    // a gate that overshoots at the diagonal (many pads read ~0.78) still clamps to the corner
    expect(stick2d(0.8, 0.8, 0, true).map((v) => +v.toFixed(4))).toEqual([1, 1]);
    // without the remap a diagonal stays on the circle
    expect(stick2d(d, d, 0, false)[0]).toBeCloseTo(d, 6);
  });

  test('radial deadzone: round dead spot, and no snapping of small cross-axis moves', () => {
    expect(stick2d(0.03, 0.03, 0.05, false)).toEqual([0, 0]);
    const [x, y] = stick2d(0.5, 0.03, 0.05, false);
    expect(y).toBeGreaterThan(0.02); // a per-axis deadzone would have zeroed it
    expect(x).toBeCloseTo((0.5 - 0.05 * 0.5 / Math.hypot(0.5, 0.03)) / 0.95, 1);
    expect(stick2d(1, 0, 0.05, false)[0]).toBeCloseTo(1, 6); // still full travel
  });

  test('a standard pad pairs the right stick for roll + pitch; radios keep per-axis processing', () => {
    const d = Math.SQRT1_2, p = standardProfile('x');
    const s = readSticks(mkPad({ axes: [0, 0, d, -d] }), p); // right stick up-right, full
    expect(s.roll).toBeCloseTo(1, 3); expect(s.pitch).toBeCloseTo(1, 3);
    const off = readSticks(mkPad({ axes: [0, 0, d, -d] }), { ...p, circleToSquare: false });
    expect(off.roll).toBeCloseTo(d, 3);
    const radio = readSticks(mkPad({ mapping: '', axes: [d, -d, 0, 0] }), genericJoystickProfile('r'));
    expect(radio.roll).toBeCloseTo((d - 0.02) / 0.98, 3); // AETR axes, no pairing, no square
  });

  test('saved gamepad profiles from before the option get square sticks; radios do not', () => {
    const im = new InputManager();
    const old: InputProfile = { ...xboxProfile('a'), throttleMode: 'full' };
    delete old.circleToSquare;
    im.profiles[mkPad().id] = old;
    setPads(mkPad({ axes: [0, 0, Math.SQRT1_2, -Math.SQRT1_2] })); // right stick full up-right
    im.poll();
    expect(im.channels[0]).toBeCloseTo(2000, 0);
    expect(im.channels[1]).toBeCloseTo(2000, 0);
    expect(im.profileFor(mkPad()).throttleMode).toBe('full'); // existing profiles keep their throttle
  });
});

describe('presets need the standard mapping', () => {
  test('known vendor with a non-standard mapping (Firefox on Linux) gets a generic profile and the setup prompt', () => {
    const p = guessProfile(mkPad({ mapping: '' }));
    expect(p.kind).toBe('generic');
    expect(p.needsSetup).toBe(true);
    expect(p.throttleMode).toBe('upper'); // still a spring-centred gamepad stick
  });
  test('the same pad with the standard mapping gets the vendor preset', () => {
    const p = guessProfile(mkPad());
    expect(p).toMatchObject({ kind: 'xbox', throttleMode: 'upper', circleToSquare: true });
    expect(p.needsSetup).toBeUndefined();
    expect(guessProfile(mkPad({ id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)' })).kind).toBe('playstation');
    expect(guessProfile(mkPad({ id: 'Logitech Extreme 3D (Vendor: 046d Product: c215)', mapping: '' }))).toMatchObject({ needsSetup: true, throttleMode: 'full' });
  });
  test('a vendor preset saved earlier on a non-standard mapping is flagged for setup', () => {
    const im = new InputManager();
    const pad = mkPad({ mapping: '' });
    im.profiles[pad.id] = xboxProfile(pad.id);
    const p = im.profileFor(pad);
    expect(p.kind).toBe('generic');
    expect(p.needsSetup).toBe(true);
    expect(im.actionButtons(pad, p)).toEqual({}); // no D-pad / B actions on an unknown layout
  });
  test('the stick wizard keeps a gamepad self-centring throttle, radios get full travel', () => {
    for (const [mapping, start, want] of [['standard', 'upper', 'upper'], ['standard', 'trigger', 'upper'], ['', 'full', 'full']] as const) {
      const pad = mkPad({ mapping, axes: [0, 0, 0, 0] }) as any;
      const w = new RadioWizard({ ...standardProfile(pad.id), throttleMode: start });
      w.next(pad);
      pad.axes[1] = -1; w.update(pad);
      expect(w.profile.throttle).toMatchObject({ index: 1, invert: true });
      expect(w.profile.throttleMode).toBe(want);
    }
  });
});

describe('AUX5-12', () => {
  test('buttons, 2- / 3-position switches, pots and toggles map to CH9-16', () => {
    const im = new InputManager();
    const p = standardProfile('x');
    p.aux = [
      { src: 'button', index: 6, mode: 'hold' },              // AUX5: LT held
      { src: 'axis', index: 4, mode: 'switch3' },             // AUX6: 3-pos switch
      { src: 'axis', index: 5, mode: 'axis' },                // AUX7: pot
      { src: 'button', index: 10, mode: 'toggle' },           // AUX8: LS click toggles
      { src: 'axis', index: 4, mode: 'hold', invert: true },  // AUX9: same switch, reversed 2-pos
    ];
    const id = mkPad().id;
    im.profiles[id] = p;
    const run = (axes: number[], pressed: number[] = []) => { setPads(mkPad({ axes, pressed })); return [...im.poll().slice(8, 16)]; };
    expect(run([0, 0, 0, 0, -1, -0.5])).toEqual([1000, 1000, 1250, 1000, 2000, 1500, 1500, 1500]);
    expect(run([0, 0, 0, 0, 0, 1], [6, 10])).toEqual([2000, 1500, 2000, 2000, 1000, 1500, 1500, 1500]);
    expect(run([0, 0, 0, 0, 1, 1], [6, 10])[3]).toBe(2000); // held: no second toggle
    expect(run([0, 0, 0, 0, 1, 1])[3]).toBe(2000);
    expect(run([0, 0, 0, 0, 1, 1], [10])[3]).toBe(1000);  // pressed again: off
    im.suspended = true;                                    // menu open: toggles don't flip
    run([0, 0, 0, 0, 1, 1]); expect(run([0, 0, 0, 0, 1, 1], [10])[3]).toBe(1000);
    expect(auxMicros(mkPad({ values: { 7: 0.25 } }), { src: 'button', index: 7, mode: 'axis' })).toBe(1250); // analog trigger
  });

  test('a button bound to an AUX channel is no longer a sim action', () => {
    const im = new InputManager();
    const p = { ...standardProfile('x'), aux: [{ src: 'button' as const, index: 12, mode: 'hold' as const }] };
    expect(im.actionButtons(mkPad(), p).camera).toBeUndefined();
    expect(im.actionButtons(mkPad(), p).telemetry).toBe(13);
  });
});

describe('radio passthrough and capture', () => {
  test('axes go straight to CH1..N; the arm channel still drops while the menu is open', () => {
    const im = new InputManager();
    const pad = mkPad({ id: 'EdgeTX Radiomaster TX16S Joystick (Vendor: 1209 Product: 4f54)', mapping: '', axes: [-1, 0.5, -1, 0, 1, 0, -1, 0.2] });
    im.profiles[pad.id] = { ...genericJoystickProfile(pad.id), passthrough: true };
    setPads(pad);
    const ch = im.poll();
    expect([...ch.slice(0, 8)]).toEqual([1000, 1750, 1000, 1500, 2000, 1500, 1000, 1600]);
    expect(im.armed).toBe(true);
    expect([...ch.slice(8)]).toEqual(Array(8).fill(1500));
    im.suspended = true;
    expect(im.poll()[4]).toBe(1000);
  });

  test('while the Controller tab captures the pad, the menu button does not toggle the menu', () => {
    const im = new InputManager();
    let menus = 0;
    im.onMenu = () => menus++;
    im.suspended = true;
    for (const pressed of [[], [9], []]) { setPads(mkPad({ pressed })); im.poll(); }
    expect(menus).toBe(1);
    im.capture = 1;
    for (const pressed of [[9], []]) { setPads(mkPad({ pressed })); im.poll(); }
    expect(menus).toBe(1);
  });

  test('pads() lists the active pad first (menu navigation falls back to the first)', () => {
    const im = new InputManager();
    setPads(mkPad({ index: 0, id: 'radio', mapping: '' }), mkPad({ index: 1 }));
    im.activeIndex = 1;
    expect(im.pads().map((g) => g.index)).toEqual([1, 0]);
  });
});

// ExpressLRS in BLE joystick mode: X / Y = CH1 / CH2, then AUX1 (arm switch), throttle, yaw, AUX2 …
// in an order that depends on the library version and the OS. Some browsers label it "standard".
describe('radios the browser presents as gamepads', () => {
  const ELRS = 'ELRS Joystick (STANDARD GAMEPAD Vendor: e502 Product: bbab)';
  const elrs = (axes = [0, 0, -1, -1, 0, -1, 0, 0]) => mkPad({ id: ELRS, mapping: 'standard', axes });

  test.each([
    [ELRS, true], ['ELRS Joystick', true], ['RadioMaster TX16S Joystick (Vendor: 1209 Product: 4f54)', true],
    ['FrSky Taranis Joystick (Vendor: 0483 Product: 5710)', true], ['EdgeTX Radiomaster Boxer Joystick', true],
    ['Xbox 360 Controller (XInput STANDARD GAMEPAD)', false], ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', false],
    ['Steam Controller (2026) — WebHID Puck (Vendor: 28de Product: 1304)', false],
    ['DJI Virtual Joystick (Vendor: 2ca3 Product: 1021)', false], // has its own radio profile
  ])('%s is a radio: %s', (id, radio) => expect(isRadio({ id })).toBe(radio));

  test('is never treated as the standard layout, so it gets no Xbox-style preset', () => {
    const pad = elrs();
    expect(isStandard(pad)).toBe(false);
    const p = guessProfile(pad);
    expect(p.needsSetup).toBe(true);
    expect(p.circleToSquare).toBe(false);
  });

  test('flies nothing until set up: its arm switch on axis 2 cannot roll it, its throttle cannot spin the motors', () => {
    const im = new InputManager();
    setPads(elrs());
    const ch = im.poll();
    expect(im.blocked).toBe(true);
    expect(ch[0]).toBe(1500); expect(ch[1]).toBe(1500); expect(ch[3]).toBe(1500);
    expect(ch[2]).toBe(1000);
    expect(ch[4]).toBe(1000); // disarmed
    expect(im.navStick(elrs())).toBeNull(); // and the menu ignores its sticks
  });

  test('a saved Xbox-style preset from before radios were recognised is replaced by the setup prompt', () => {
    store.set('fpv-input-profiles', JSON.stringify({ [ELRS]: { ...standardProfile(ELRS) } }));
    const im = new InputManager();
    const p = im.profileFor(elrs());
    expect(p.needsSetup).toBe(true);
    expect(p.name).not.toBe(standardProfile().name);
  });

  test('after the setup it flies, and its calibrated right stick drives the menu', () => {
    const im = new InputManager();
    const pad = elrs();
    const p = im.profileFor(pad);
    // as the wizard leaves it: roll X, pitch Y (forward = -1), throttle axis 3 (up = +1), yaw axis 4
    Object.assign(p, { needsSetup: false, roll: { ...p.roll, index: 0 }, pitch: { ...p.pitch, index: 1, invert: true }, throttle: { ...p.throttle, index: 3, invert: false }, yaw: { ...p.yaw, index: 4 } });
    im.setProfile(pad, p);
    const flying = elrs([0.5, 0, -1, -1, 0, -1, 0, 0]);
    setPads(flying);
    const ch = im.poll();
    expect(im.blocked).toBe(false);
    expect(ch[0]).toBe(1750); // roll stick half right, no gamepad radial deadzone or square-corner stretch
    expect(ch[2]).toBe(1000); // throttle at the bottom
    expect(im.navStick(elrs([0, -1, -1, -1, 0, -1, 0, 0]))).toEqual([0, -1]); // pitch forward = up
  });
});
