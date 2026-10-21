// Leaderboard, client side: the drone class and summary of a build, the arcade initials entry,
// which laps count (every gate in order, real time, time scale 1), personal bests and the optional
// post (never opened by itself), and the stored values.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CUSTOM_SUMMARY_RE, parseSubmission } from '../server/src/leaderboardCore';
import { courseOf, defaultInitials, LapBoard, onBoard } from '../src/app/leaderboard';
import { KEYS, KV, validPbs } from '../src/app/persist';
import { lapInvalid, newRace, onGate } from '../src/app/race';
import { BATTERIES, FRAMES, MOTORS } from '../src/data/catalog';
import { buildDrone, DEFAULT_SPEC, DroneSpec, PRESETS } from '../src/builder/derive';
import { droneClass, droneSummary, presetOf } from '../src/builder/droneClass';
import { formatLap, parseEntry } from '../src/net/leaderboard';
import { initialsEdit, initialsState } from '../src/ui/menu/initials';

const memKv = (): KV & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } }; };
const whoop = PRESETS.find((p) => /65 mm/.test(p.name))!;

describe('drone class and summary', () => {
  test('a preset is its class, also renamed, with another camera angle or prop direction', () => {
    expect(droneClass(DEFAULT_SPEC)).toBe('freestyle5');
    expect(droneClass(structuredClone(whoop))).toBe('whoop65');
    expect(droneClass({ ...whoop, name: 'My whoop', cameraUptiltDeg: 35, propDirection: 'props-in' })).toBe('whoop65');
    expect(presetOf({ ...PRESETS[1] })?.name).toBe('5" Race 4S');
  });

  test('any other part or setting makes it custom', () => {
    expect(droneClass({ ...DEFAULT_SPEC, prop: 'p-hq5043' })).toBe('custom');
    expect(droneClass({ ...DEFAULT_SPEC, extraMassG: 26 })).toBe('custom');
    expect(droneClass({ ...DEFAULT_SPEC, overrides: { kv: 2000 } })).toBe('custom');
    expect(droneClass({ ...DEFAULT_SPEC, overrides: {} })).toBe('freestyle5');
  });

  test('summaries: the preset name, or size · motor · cells (overrides included)', () => {
    expect(droneSummary(buildDrone(whoop))).toBe('65 mm Tiny Whoop 1S');
    const s = (spec: DroneSpec) => droneSummary(buildDrone(spec));
    expect(s({ ...DEFAULT_SPEC, prop: 'p-hq5043' })).toBe('Custom · 5" · 2207 1950KV · 6S');
    expect(s({ ...whoop, extraMassG: 2 })).toBe('Custom · 65 mm · 0702 26000KV · 1S');
    expect(s({ ...DEFAULT_SPEC, overrides: { kv: 2150, cells: 4 } })).toBe('Custom · 5" · 2207 2150KV · 4S');
  });

  test('every frame, motor and battery gives a summary the server accepts', () => {
    const specs: DroneSpec[] = [...FRAMES.map((f) => ({ ...DEFAULT_SPEC, frame: f.id })), ...MOTORS.map((m) => ({ ...DEFAULT_SPEC, motor: m.id })), ...BATTERIES.map((b) => ({ ...DEFAULT_SPEC, battery: b.id }))];
    for (const spec of specs) {
      const sum = droneSummary({ spec, info: { components: buildDrone(spec).info.components } as any });
      if (droneClass(spec) === 'custom') expect(CUSTOM_SUMMARY_RE.test(sum), sum).toBe(true);
    }
  });
});

describe('arcade initials', () => {
  test('up / down cycle the letter (wrapping), left / right move, typing fills and moves on', () => {
    let s = initialsState('ACE');
    s = initialsEdit(s, { cycle: 1 }); expect(s.letters.join('')).toBe('BCE');
    s = initialsEdit(initialsEdit(s, { cycle: -1 }), { cycle: -1 }); expect(s.letters.join('')).toBe('ZCE');
    s = initialsEdit(s, { move: -1 }); expect(s.pos).toBe(0); // clamped
    s = initialsEdit(s, { move: 1 }); s = initialsEdit(s, { move: 1 }); s = initialsEdit(s, { move: 1 }); expect(s.pos).toBe(2);
    s = initialsEdit(initialsState('AAA'), { type: 'j' }); expect([s.letters.join(''), s.pos]).toEqual(['JAA', 1]);
    s = initialsEdit(initialsEdit(s, { type: 'o' }), { type: 'y' }); expect([s.letters.join(''), s.pos]).toEqual(['JOY', 2]);
    s = initialsEdit(s, { type: 'z' }); expect([s.letters.join(''), s.pos]).toEqual(['JOZ', 2]); // the last letter is overwritten
    expect(initialsEdit(s, { type: '7' })).toBe(s);
    expect(initialsEdit(s, { back: true }).pos).toBe(1);
  });

  test('prefill: the last initials, else the callsign, else AAA', () => {
    expect(initialsState('ab').letters.join('')).toBe('AAA');
    expect(defaultInitials('MAX', 'Pilot')).toBe('MAX');
    expect(defaultInitials('', 'Pilot')).toBe('PIL');
    expect(defaultInitials('', 'Zé 7')).toBe('ZEA');
    expect(defaultInitials('', '🚁')).toBe('AAA');
  });
});

// ---------------------------------------------------------------------------------------------
// Laps

function rig(timeScale = 1) {
  const sent: number[] = [];
  const lb = new LapBoard(memKv());
  const gates = [0, 1, 2].map((id) => ({ id, kind: 'square', c: { x: id * 10, y: 0, z: 0 }, yaw: 0, width: 2, height: 2 }));
  const ctx: any = {
    map: { id: 'field', gates }, race: newRace(), sim: { timeScale }, spec: DEFAULT_SPEC, build: { spec: DEFAULT_SPEC, info: {} },
    mp: { sendLap: (n: number) => sent.push(n) }, lb,
  };
  const pass = (gate: number, t: number, wall = t * 1000) => onGate(ctx, gate, t, wall);
  return { ctx, lb, sent, pass };
}

describe('lap validity', () => {
  test('a lap passes every gate in order and records the splits', () => {
    const { ctx, lb, sent, pass } = rig();
    pass(0, 10); pass(1, 14); pass(2, 18.5); pass(0, 22.25);
    expect(ctx.race.lapCount).toBe(1);
    expect(ctx.race.lastLap).toBeCloseTo(12.25);
    expect(sent).toEqual([1]);
    expect(lb.pbs['field|freestyle5']).toMatchObject({ lapMs: 12_250, splitsMs: [4000, 8500, 12_250], summary: '5" Freestyle 6S' });
  });

  test('a skipped gate (a message from before a respawn) never completes a lap', () => {
    const { ctx, pass } = rig();
    pass(0, 10); pass(2, 12); pass(0, 13); // gate 1 missing
    expect(ctx.race.lapCount).toBe(0);
    pass(1, 15); pass(2, 17); pass(0, 20); // the lap started at 13 is whole
    expect(ctx.race.lapCount).toBe(1);
    expect(ctx.race.lastLap).toBeCloseTo(7);
    pass(0, 21); // gate 0 again at once: not a lap
    expect(ctx.race.lapCount).toBe(1);
    pass(7, 22); // not this map's
    expect(ctx.race.nextGate).toBe(1);
  });

  test('slow motion, pauses and a changed drone don’t count', () => {
    expect(lapInvalid({ timeScale: 0.5, simLap: 20, wallLap: 40, clsAtStart: 'a', cls: 'a' })).toMatch(/Slow motion/);
    expect(lapInvalid({ timeScale: 1, simLap: 20, wallLap: 26, clsAtStart: 'a', cls: 'a' })).toMatch(/paused/);
    expect(lapInvalid({ timeScale: 1, simLap: 20, wallLap: 20.3, clsAtStart: 'a', cls: 'a' })).toBeNull(); // message timing slack
    expect(lapInvalid({ timeScale: 1, simLap: 20, wallLap: 20, clsAtStart: 'a', cls: 'b' })).toMatch(/drone/);
    const slow = rig(0.5);
    slow.pass(0, 10, 0); slow.pass(1, 12, 4000); slow.pass(2, 14, 8000); slow.pass(0, 16, 12_000);
    expect(slow.ctx.race.lapCount).toBe(1); // still a lap on the HUD
    expect(slow.lb.pbs['field|freestyle5']).toBeUndefined();
    expect(slow.lb.pending).toBeNull();
    expect(slow.lb.note).toMatchObject({ kind: 'invalid', text: expect.stringMatching(/time scale 0\.50/) });
    // paused mid-lap (the menu): real time ran on, the sim didn't
    const paused = rig();
    paused.pass(0, 10, 10_000); paused.pass(1, 12, 12_000); paused.pass(2, 14, 60_000); paused.pass(0, 16, 62_000);
    expect(paused.lb.pbs['field|freestyle5']).toBeUndefined();
  });
});

describe('personal bests and posting', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const lap = (lapMs: number, extra: object = {}) => ({ map: 'field', course: '', cls: 'freestyle5', summary: '5" Freestyle 6S', lapMs, splitsMs: [lapMs / 2, lapMs], invalid: null, ...extra });

  test('only a faster lap is a new best; it waits for the pilot (nothing opens by itself)', () => {
    const kv = memKv(), lb = new LapBoard(kv);
    expect(lb.onLap(lap(30_000), 0)).toBe('pb');
    expect(lb.pending).toMatchObject({ lapMs: 30_000, prevMs: null });
    expect(lb.noteNow(100)?.kind).toBe('pb');
    expect(lb.noteNow(6000)).toBeNull(); // a short note
    expect(lb.onLap(lap(31_000), 7000)).toBeNull();
    expect(lb.onLap(lap(29_000), 8000)).toBe('pb');
    expect(lb.pending).toMatchObject({ lapMs: 29_000, prevMs: 30_000 });
    expect(new LapBoard(kv).pbs['field|freestyle5'].lapMs).toBe(29_000); // stored
    lb.skip();
    expect(lb.pending).toBeNull();
    expect(lb.offer('field', '', 'freestyle5')).toMatchObject({ lapMs: 29_000 }); // posted later, from the board
  });

  test('maps from disk keep a local best, without a board', () => {
    const lb = new LapBoard(memKv());
    expect(onBoard('local-abc', '')).toBe(false);
    expect(lb.onLap(lap(30_000, { map: 'local-abc' }), 0)).toBe('pb');
    expect(lb.pending).toBeNull();
    expect(lb.note?.text).toMatch(/no global leaderboard/);
  });

  test('posting sends a lap the server accepts and remembers the entry', async () => {
    let sent: any = null;
    vi.stubGlobal('location', { hostname: 'example.com' });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true, stored: true, id: 42, rank: 3, entries: [{ id: 7, initials: 'TOP', lapMs: 20_000, cls: 'freestyle5', summary: '5" Freestyle 6S', at: 1 }] }));
    });
    const kv = memKv(), lb = new LapBoard(kv);
    lb.onLap({ ...lap(24_000), splitsMs: Array.from({ length: 13 }, (_, i) => ((i + 1) * 24_000) / 13) }, 0);
    const r = await lb.submit(lb.pending!, 'ACE');
    expect(r).toMatchObject({ ok: true, stored: true, id: 42, rank: 3 });
    expect(sent.url).toBe('https://fpv-sim-rooms.newsanjose.workers.dev/leaderboard');
    expect(parseSubmission(sent.body).ok).toBe(true);
    expect(lb.pending).toBeNull();
    expect(lb.isMine(42)).toBe(true);
    lb.onLap(lap(23_000), 10_000); // a newer best, not posted (yet): the entry on the board is still the pilot's
    expect(new LapBoard(kv).isMine(42)).toBe(true);
    expect(lb.initials).toBe('ACE');
    expect(lb.record('field', '', 'freestyle5')).toMatchObject({ initials: 'TOP' });
  });

  test('offline: the best stays pending to post later', async () => {
    vi.stubGlobal('location', { hostname: 'example.com' });
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const lb = new LapBoard(memKv());
    lb.onLap(lap(24_000), 0);
    const r = await lb.submit(lb.pending!, 'ACE');
    expect(r).toMatchObject({ ok: false, error: 'Could not reach the leaderboard server.' });
    expect(lb.pending).not.toBeNull();
  });
});

describe('stored values and server replies', () => {
  test('personal bests: bad keys and records are dropped', () => {
    const t = validPbs({ 'field|freestyle5': { lapMs: 20_000, splitsMs: [10_000, 20_000], at: 5, summary: 'x', submitted: { id: 3, at: 6 } }, 'practice:slalom|custom': { lapMs: 1, splitsMs: 'no', at: 1, summary: 7 }, 'BAD KEY': { lapMs: 1, at: 1 }, 'field|race5': { lapMs: -3, at: 1 } });
    expect(Object.keys(t)).toEqual(['field|freestyle5', 'practice:slalom|custom']);
    expect(t['practice:slalom|custom']).toEqual({ lapMs: 1, splitsMs: [], at: 1, summary: '' });
    expect(validPbs('junk')).toEqual({});
    const kv = memKv();
    kv.setItem(KEYS.pbs, '{not json');
    expect(new LapBoard(kv).pbs).toEqual({});
  });

  test('board entries from a relay are checked', () => {
    expect(parseEntry({ id: 1, initials: 'ACE', lapMs: 20_000, cls: 'freestyle5', summary: '5" Freestyle 6S', at: 1 })).toMatchObject({ initials: 'ACE' });
    expect(parseEntry({ id: 1, initials: '<b>', lapMs: 20_000, cls: 'freestyle5' })).toBeNull();
    expect(parseEntry({ id: 1, initials: 'ACE', lapMs: 20_000, cls: 'rocket' })).toBeNull();
    expect(parseEntry({ id: 1, initials: 'ACE', lapMs: 20_000, cls: 'custom', summary: '<img src=x onerror=alert(1)>' })?.summary).not.toMatch(/[<>=()]/);
  });

  test('lap times read m:ss.mmm', () => {
    expect(formatLap(23_456)).toBe('0:23.456');
    expect(formatLap(83_007)).toBe('1:23.007');
    expect(formatLap(0)).toBe('—');
  });

  test('a map flying one of its courses is that course', () => {
    const gates = [{ id: 1 }], other = [{ id: 2 }];
    expect(courseOf({ gates, courses: [{ id: 'a', gates: other }, { id: 'b', gates }] } as any)).toBe('b');
    expect(courseOf({ gates } as any)).toBe('');
  });
});
