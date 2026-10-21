// Controller buttons for the sim actions (battery, camera, telemetry, drill, spectrum).
import { expect, test } from 'vitest';
import { djiRc3Profile, InputManager, ps5Profile, standardProfile, STANDARD_ACTIONS } from '../src/input/gamepad';

// minimal browser globals for InputManager in Node
const store = new Map<string, string>();
Object.assign(globalThis as any, {
  window: { addEventListener: () => {} },
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
});
if (!(globalThis as any).navigator) (globalThis as any).navigator = {};

const pad = (pressed: number[], mapping = 'standard') => ({
  id: 'test pad', index: 0, mapping, connected: true, timestamp: 0, axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: pressed.includes(i) ? 1 : 0 })),
}) as unknown as Gamepad;

test('standard pads get B = battery and the D-pad for camera / telemetry / drill / spectrum', () => {
  const im = new InputManager();
  const acts = im.actionButtons(pad([]), standardProfile('x'));
  expect(acts).toEqual(STANDARD_ACTIONS);
  expect(im.actionButtons(pad([]), ps5Profile('x')).battery).toBe(1); // ○ on a DualSense
});

test('a press fires the action once (edge), and not while a menu is open', () => {
  const im = new InputManager();
  const fired: string[] = [];
  im.onAction = (a) => fired.push(a);
  const p = standardProfile('t'); im.profiles['test pad'] = p;
  const run = (pressed: number[]) => { (navigator as any).getGamepads = () => [pad(pressed)]; im.poll(); };
  run([]); run([1]); run([1]); run([]); run([12]); run([13]);
  expect(fired).toEqual(['battery', 'camera', 'telemetry']);
  im.suspended = true; run([]); run([1]);
  expect(fired).toEqual(['battery', 'camera', 'telemetry']);
});

test('radios / unmapped joysticks get no implicit action buttons, and bound buttons are never reused', () => {
  const im = new InputManager();
  expect(im.actionButtons(pad([], ''), djiRc3Profile('x'))).toEqual({});
  const p = { ...standardProfile('x'), reset: 1 }; // someone moved respawn to B
  expect(im.actionButtons(pad([]), p).battery).toBeUndefined();
});
