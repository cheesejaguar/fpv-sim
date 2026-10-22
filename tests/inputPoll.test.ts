// InputManager's allocation-free poll path: the per-profile action-button cache follows profile
// edits, the menu hands the controls back through onResume, and the pad choice is unchanged.
import { expect, test } from 'vitest';
import { InputManager, readSticks, standardProfile } from '../src/input/gamepad';

const store = new Map<string, string>();
Object.assign(globalThis as any, {
  window: { addEventListener: () => {} },
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
});
if (!(globalThis as any).navigator) (globalThis as any).navigator = {};

const mkPad = (index: number, pressed: number[] = [], id = 'test pad') => ({
  id, index, mapping: 'standard', connected: true, timestamp: 0, axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: pressed.includes(i) ? 1 : 0 })),
}) as unknown as Gamepad;

test('action buttons follow an edited profile (same object, a binding replaced)', () => {
  const im = new InputManager();
  const p = standardProfile('x');
  expect(im.actionButtons(mkPad(0), p).battery).toBe(1);
  expect(im.actionButtons(mkPad(0), p)).toBe(im.actionButtons(mkPad(0), p)); // cached
  p.reset = 1; // respawn moved to B: B can't also be "new battery"
  expect(im.actionButtons(mkPad(0), p).battery).toBeUndefined();
  p.actions = { camera: 8 };
  expect(im.actionButtons(mkPad(0), p).camera).toBe(8);
  p.needsSetup = true; // unknown stick layout: no implicit buttons, only the explicit one
  expect(im.actionButtons(mkPad(0), p)).toEqual({ camera: 8 });
});

test('a press edge fires once across polls (double-buffered button state)', () => {
  const im = new InputManager();
  const fired: string[] = [];
  im.onAction = (a) => fired.push(a);
  im.profiles['test pad'] = standardProfile('test pad');
  const seq = [[], [12], [12], [12], [], [12], [], [], [13], [13]];
  for (const b of seq) { (navigator as any).getGamepads = () => [mkPad(0, b)]; im.poll(); }
  expect(fired).toEqual(['camera', 'camera', 'telemetry']);
});

test('onResume fires when a menu gives the controls back, not when it takes them', () => {
  const im = new InputManager();
  let n = 0;
  im.onResume = () => n++;
  im.suspended = true; expect(n).toBe(0);
  im.suspended = true; expect(n).toBe(0);
  im.suspended = false; expect(n).toBe(1);
  im.suspended = false; expect(n).toBe(1);
});

test('the active pad stays in use; without it the first connected pad is taken', () => {
  const im = new InputManager();
  (navigator as any).getGamepads = () => [null, mkPad(1, [], 'a'), mkPad(2, [], 'b'), null];
  im.poll();
  expect(im.active?.index).toBe(1);
  im.activeIndex = 2; im.poll();
  expect(im.active?.index).toBe(2);
  (navigator as any).getGamepads = () => [null, mkPad(1, [], 'a'), null, null];
  im.poll();
  expect(im.active?.index).toBe(1);
  expect(im.activeIndex).toBe(1);
  (navigator as any).getGamepads = () => [null, null, null, null];
  im.poll();
  expect(im.active).toBeNull();
});

test('readSticks fills the object it is given', () => {
  const out = { roll: 9, pitch: 9, yaw: 9, throttle: 9 };
  const pad = mkPad(0); (pad.axes as number[])[2] = 1;
  expect(readSticks(pad, standardProfile('x'), out)).toBe(out);
  expect(out.roll).toBeCloseTo(1, 6);
  expect(out.pitch).toBeCloseTo(0, 9);
});
