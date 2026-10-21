// Menu navigation without a DOM: the controller lock, following the pad used last, and the
// on-screen keyboard's layouts and editing.
import { beforeEach, expect, test } from 'vitest';
import { lockNav, MenuNav, navLockLevel } from '../src/ui/menu/nav';
import { oskEdit, oskModeFor, oskRows } from '../src/ui/menu/osk';

// just enough browser for MenuNav (no DOM is touched: the scope has no controls)
Object.assign(globalThis as any, {
  window: { addEventListener: () => {} },
  document: { activeElement: null },
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
});

type Btn = { pressed: boolean; touched: boolean; value: number };
const pad = (index: number, mapping = 'standard') => ({
  id: `pad ${index}`, index, mapping, connected: true, timestamp: 0, axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (): Btn => ({ pressed: false, touched: false, value: 0 })),
});
const press = (p: ReturnType<typeof pad>, i: number, on = true) => { p.buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 }; };

function rig(pads: ReturnType<typeof pad>[]) {
  const calls = { back: 0, tabs: [] as number[], scroll: 0 };
  const scope = { querySelectorAll: () => [], contains: () => false, closest: () => null } as unknown as HTMLElement;
  const nav = new MenuNav({ scope: () => scope, back: () => calls.back++, tab: (d) => calls.tabs.push(d), scroller: () => ({ scrollBy: () => calls.scroll++ }) as unknown as HTMLElement }, () => pads as unknown as Gamepad[]);
  nav.start();
  const tick = () => (nav as any).tick();
  return { nav, calls, tick };
}

let held: { release(): void }[] = [];
beforeEach(() => { held.forEach((l) => l.release()); held = []; });

test('lock levels: the strongest held lock wins, released locks are gone', () => {
  expect(navLockLevel()).toBeNull();
  const a = lockNav('sticks'); held.push(a);
  expect(navLockLevel()).toBe('sticks');
  const b = lockNav(); held.push(b);
  expect(navLockLevel()).toBe('all');
  b.release();
  expect(navLockLevel()).toBe('sticks');
  a.level = 'all';
  expect(navLockLevel()).toBe('all');
  a.release();
  expect(navLockLevel()).toBeNull();
});

test('buttons held when the menu opens are ignored; B goes back once per press', () => {
  const p = pad(0); press(p, 1);
  const { calls, tick } = rig([p]);
  tick(); tick();
  expect(calls.back).toBe(0);
  press(p, 1, false); tick(); press(p, 1); tick(); tick();
  expect(calls.back).toBe(1);
});

test('a full lock silences the pad (a radio switch on button 1 is not Back); "sticks" keeps A / B only', () => {
  const p = pad(0);
  const { calls, tick } = rig([p]);
  tick();
  held.push(lockNav('all'));
  press(p, 1); tick(); press(p, 4); tick();
  expect(calls.back).toBe(0); expect(calls.tabs).toEqual([]);
  // still held when the lock goes: no stale edge fires afterwards
  held.pop()!.release(); tick();
  expect(calls.back).toBe(0);
  press(p, 1, false); press(p, 4, false); tick();
  held.push(lockNav('sticks'));
  press(p, 1); press(p, 5); p.axes[3] = 1; tick();
  expect(calls.back).toBe(1); expect(calls.tabs).toEqual([]); expect(calls.scroll).toBe(0);
});

test('the menu follows the pad used last, not just the first one listed', () => {
  const a = pad(0), b = pad(1);
  const { calls, tick } = rig([a, b]);
  tick(); tick();
  a.axes[3] = 0.9; tick(); // pad A's right stick: scrolls while A drives the menu
  expect(calls.scroll).toBe(1); // first listed pad by default
  press(b, 4); tick();
  expect(calls.tabs).toEqual([-1]);
  const s = calls.scroll; tick(); tick();
  expect(calls.scroll).toBe(s);  // pad B drives now
  press(a, 3); tick();           // a press on pad A takes over again
  expect(calls.scroll).toBe(s + 1);
});

test('a radio (non-standard) never auto-repeats or scrolls from resting axes', () => {
  const radio = pad(0, '');
  radio.axes[1] = 1; radio.axes[3] = 0.9; // throttle at the bottom, a channel resting off-centre
  const { nav, calls, tick } = rig([radio]);
  const moves: string[] = [];
  nav.move = (d) => { moves.push(d); };
  for (let k = 0; k < 6; k++) tick();
  expect(moves).toEqual([]); expect(calls.scroll).toBe(0);
  radio.axes[1] = 0; tick(); radio.axes[1] = 1; for (let k = 0; k < 6; k++) tick();
  expect(moves).toEqual(['down']); // one step per push
  const gp = pad(1); gp.axes[1] = 1;
  const r2 = rig([gp]), m2: string[] = [];
  r2.nav.move = (d) => { m2.push(d); };
  r2.tick(); r2.tick();
  expect(m2).toEqual([]); // held when the menu opened: wait for the stick to come back
  gp.axes[1] = 0; r2.tick(); gp.axes[1] = 1; r2.tick();
  expect(m2).toEqual(['down']); // a standard pad's stick moves (and repeats like the D-pad)
});

test('after a lock, a stick still pushed (the one just detected) does not move focus', () => {
  const gp = pad(0);
  const { nav, tick } = rig([gp]);
  const moves: string[] = [];
  nav.move = (d) => { moves.push(d); };
  tick(); tick();
  const l = lockNav(); held.push(l);
  gp.axes[1] = -1; tick(); tick();
  l.release(); tick(); tick();
  expect(moves).toEqual([]);
  gp.axes[1] = 0; tick(); gp.buttons[13] = { pressed: true, touched: true, value: 1 }; tick();
  expect(moves).toEqual(['down']);
});

test('OSK layouts: room codes are uppercase letters and digits only', () => {
  const code = oskRows('code').flat().filter((k) => k.ch).map((k) => k.ch).join('');
  expect(code).toMatch(/^[A-Z0-9]+$/);
  expect(code.length).toBe(36);
  expect(oskRows('code').flat().some((k) => k.act === 'space')).toBe(false);
  const text = oskRows('text').flat().map((k) => k.ch ?? '').join('');
  expect(text).toContain('q'); expect(text).toContain('_'); expect(text).toContain('=');
  expect(oskRows('text', true).flat().map((k) => k.ch ?? '').join('')).toContain('Q');
});

test('OSK mode per field', () => {
  const f = (o: { type?: string; className?: string; placeholder?: string; aria?: string; osk?: string }) => ({ type: o.type ?? 'text', className: o.className ?? '', placeholder: o.placeholder ?? '', dataset: o.osk ? { osk: o.osk } : {}, getAttribute: (n: string) => (n === 'aria-label' ? o.aria ?? null : null) });
  expect(oskModeFor(f({ className: 'gm-input code', placeholder: 'CODE', aria: 'Room code' }))).toBe('code');
  expect(oskModeFor(f({ placeholder: 'ROOM CODE' }))).toBe('code');
  expect(oskModeFor(f({ className: 'gm-input', placeholder: 'Search rooms, hosts or codes', aria: 'Search rooms' }))).toBe('text');
  expect(oskModeFor(f({ className: 'cli-in', placeholder: 'Type a CLI command (e.g. "status", "get rpm", "diff")' }))).toBe('text');
  expect(oskModeFor(f({ aria: 'Pilot name' }))).toBe('text');
  expect(oskModeFor(f({ type: 'number' }))).toBe('number');
  expect(oskModeFor(f({ osk: 'code', aria: 'Callsign' }))).toBe('code');
});

test('OSK editing: insert at the caret, backspace, selection, cursor keys, maxlength', () => {
  expect(oskEdit({ value: 'set', caret: 3 }, { ch: '_' })).toEqual({ value: 'set_', caret: 4 });
  expect(oskEdit({ value: 'ac', caret: 1 }, { ch: 'b' })).toEqual({ value: 'abc', caret: 2 });
  expect(oskEdit({ value: 'abc', caret: 2 }, { act: 'back' })).toEqual({ value: 'ac', caret: 1 });
  expect(oskEdit({ value: 'abc', caret: 0 }, { act: 'back' })).toEqual({ value: 'abc', caret: 0 });
  expect(oskEdit({ value: 'Pilot', caret: 0, end: 5 }, { ch: 'X' })).toEqual({ value: 'X', caret: 1 }); // replaces a selection
  expect(oskEdit({ value: 'Pilot', caret: 0, end: 5 }, { act: 'back' })).toEqual({ value: '', caret: 0 });
  expect(oskEdit({ value: 'ab', caret: 1 }, { act: 'space' })).toEqual({ value: 'a b', caret: 2 });
  expect(oskEdit({ value: 'ab', caret: 1 }, { act: 'left' }).caret).toBe(0);
  expect(oskEdit({ value: 'ab', caret: 2 }, { act: 'right' }).caret).toBe(2);
  expect(oskEdit({ value: 'ABCD1234', caret: 8 }, { ch: '5' }, 8).value).toBe('ABCD1234'); // full
  expect(oskEdit({ value: 'ABCD1234', caret: 0, end: 1 }, { ch: 'Z' }, 8).value).toBe('ZBCD1234');
});
