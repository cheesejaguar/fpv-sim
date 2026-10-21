// Global lap leaderboard, server side: what a plausible submission is, how a board keeps each
// pilot's best and its top 100, the Leaderboard Durable Object on a real SQLite database
// (node:sqlite) with its replays, the Worker's /leaderboard routes (CORS, origin, size, replay
// check, rate limit, hashing, admin delete, cache, replays), and the track / class / gate tables
// against the real maps and presets.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import {
  BOARD_SIZE, CLASSES, CUSTOM_SUMMARY_RE, decide, Entry, hasTrack, initialsAllowed, LAP_MIME, MAX_PER_NETWORK, minLapMs, packLap, parseQuery, parseSubmission,
  ranked, SubmitLimiter, SUBMITS_PER_WINDOW, TRACKS, unpackLap,
} from '../server/src/leaderboardCore';
import { TRACK_GATES } from '../server/src/trackGates';
import { syntheticLap } from './helpers/replayLap';
import { buildDrone, PRESETS } from '../src/builder/derive';
import { CLASS_IDS, PRESET_CLASS } from '../src/builder/droneClass';
import { courseOf } from '../src/app/leaderboard';
import { openingCentre } from '../src/maps/gates';
import { loadMapPackage, PackageSource } from '../src/maps/mapFormat';
import { MAP_LIST, MAPS } from '../src/maps/maps';
import { GateDef, MapDef, withCourse } from '../src/maps/world';

const CLIENT = '0123456789abcdef0123456789abcdef';
const splits = (n: number, lapMs: number) => Array.from({ length: n }, (_, i) => Math.round(((i + 1) * lapMs) / n));
const lap = (extra: Record<string, unknown> = {}) => ({ v: 2, client: CLIENT, map: 'field', class: 'freestyle5', initials: 'ACE', lapMs: 24_000, splitsMs: splits(13, 24_000), timeScale: 1, summary: 'whatever', ...extra });

describe('submissions', () => {
  test('a plausible lap passes; the preset summary is the server’s own', () => {
    const p = parseSubmission(lap());
    expect(p).toMatchObject({ ok: true, sub: { map: 'field', course: '', cls: 'freestyle5', initials: 'ACE', lapMs: 24_000, summary: '5" Freestyle 6S' } });
  });

  test.each([
    ['version', { v: 3 }], ['client id', { client: 'nope' }],
    ['map from disk', { map: 'local-abc123' }], ['unknown map', { map: 'bando' }], ['unknown course', { course: 'nope' }],
    ['class', { class: 'rocket' }], ['lowercase initials', { initials: 'ace' }], ['4 letters', { initials: 'ACES' }], ['blocked initials', { initials: 'ASS' }],
    ['slow motion', { timeScale: 0.5 }], ['too fast', { lapMs: 1000, splitsMs: splits(13, 1000) }],
    ['splits missing', { splitsMs: splits(12, 24_000) }], ['splits out of order', { splitsMs: [...splits(13, 24_000)].reverse() }],
    ['splits ≠ lap', { splitsMs: splits(13, 23_000) }], ['non-integer', { lapMs: 24_000.5 }],
  ])('refuses: %s', (_, extra) => {
    expect(parseSubmission(lap(extra)).ok).toBe(false);
  });

  test('a client from before replays is told to reload', () => {
    expect(parseSubmission(lap({ v: 1 }))).toEqual({ ok: false, error: expect.stringMatching(/reload the page/) });
  });

  test('the lap envelope: JSON, then the replay', () => {
    const b = packLap('{"a":1}', Uint8Array.of(9, 8, 7));
    expect(unpackLap(b)).toEqual({ json: '{"a":1}', replay: Uint8Array.of(9, 8, 7) });
    expect(unpackLap(new TextEncoder().encode('{"a":1}'))).toBeNull();
    expect(unpackLap(packLap('x'.repeat(3000), Uint8Array.of(1)))).toBeNull(); // the JSON part has its 2 KB limit
  });

  test('custom builds keep the fixed summary format, anything else becomes "Custom"', () => {
    const ok = parseSubmission(lap({ class: 'custom', summary: 'Custom · 5" · 2207 1950KV · 6S' }));
    expect(ok.ok && ok.sub.summary).toBe('Custom · 5" · 2207 1950KV · 6S');
    const junk = parseSubmission(lap({ class: 'custom', summary: 'visit my site <a href=…>' }));
    expect(junk.ok && junk.sub.summary).toBe('Custom');
  });

  test('courses are boards of their own', () => {
    expect(hasTrack('practice', 'slalom')).toBe(true);
    expect(hasTrack('practice', '')).toBe(false);
    expect(parseSubmission(lap({ map: 'practice', course: 'slalom', splitsMs: splits(10, 24_000) })).ok).toBe(true);
  });

  test('initials: three letters, no slurs', () => {
    for (const s of ['ACE', 'ZZZ', 'BOB']) expect(initialsAllowed(s)).toBe(true);
    for (const s of ['ace', 'AB', 'ABCD', 'A1C', 'FAG', 'KKK', 'NIG', 'FUK', ' AC']) expect(initialsAllowed(s)).toBe(false);
  });

  test('minimum laps follow the class: a whoop can’t lap the stadium as fast as a 5"', () => {
    expect(minLapMs('field', 'whoop65')).toBeGreaterThan(3 * minLapMs('field', 'freestyle5'));
    expect(minLapMs('practice:powerloop', 'custom')).toBe(2000); // the floor
    expect(minLapMs('nope', 'custom')).toBe(Infinity);
  });

  test('queries', () => {
    expect(parseQuery(new URLSearchParams('map=field'))).toEqual({ map: 'field', course: '', cls: 'all' });
    expect(parseQuery(new URLSearchParams('map=practice&course=figure8&class=whoop65'))).toEqual({ map: 'practice', course: 'figure8', cls: 'whoop65' });
    expect(parseQuery(new URLSearchParams('map=field&class=nope'))).toBeNull();
    expect(parseQuery(new URLSearchParams('map=__proto__'))).toBeNull();
  });
});

describe('boards', () => {
  let id = 0;
  const e = (owner: string, lapMs: number, o: Partial<Entry> = {}): Entry => ({ id: ++id, map: 'field', course: '', cls: 'freestyle5', owner, net: `net${owner}0000`, initials: 'AAA', lapMs, splitsMs: [], summary: '', at: id, ...o });

  test('one entry per pilot: only a faster lap replaces it', () => {
    const rows = [e('aaaa', 20_000), e('bbbb', 21_000)];
    expect(decide(rows, { lapMs: 22_000 }, 'aaaa', 'netx', 99)).toMatchObject({ kind: 'slower', best: rows[0] });
    expect(decide(rows, { lapMs: 20_000 }, 'aaaa', 'netx', 99).kind).toBe('slower'); // a tie doesn't move you
    expect(decide(rows, { lapMs: 19_000 }, 'aaaa', 'netx', 99)).toEqual({ kind: 'store', update: rows[0].id, evict: [] });
    expect(decide(rows, { lapMs: 25_000 }, 'cccc', 'netx', 99)).toEqual({ kind: 'store', update: null, evict: [] });
  });

  test(`a full board keeps the top ${BOARD_SIZE}`, () => {
    const rows = Array.from({ length: BOARD_SIZE }, (_, i) => e(`p${i}`, 20_000 + i * 10));
    expect(decide(rows, { lapMs: 99_000 }, 'late', 'netl', 1e9).kind).toBe('unranked');
    const d = decide(rows, { lapMs: 20_005 }, 'fast', 'netf', 1e9);
    expect(d).toEqual({ kind: 'store', update: null, evict: [rows[BOARD_SIZE - 1].id] });
  });

  test(`one network gets at most ${MAX_PER_NETWORK} entries per board (its own updates still count)`, () => {
    const net = 'deadbeefdeadbeef';
    const rows = Array.from({ length: MAX_PER_NETWORK }, (_, i) => e(`own${i}`, 30_000 + i, { net }));
    expect(decide(rows, { lapMs: 25_000 }, 'fresh', net, 1).kind).toBe('network');
    expect(decide(rows, { lapMs: 25_000 }, 'own1', net, 1).kind).toBe('store');
  });

  test('"all" ranks each pilot once, by their fastest class', () => {
    const rows = [e('aaaa', 20_000, { cls: 'race5' }), e('aaaa', 19_000, { cls: 'freestyle5' }), e('bbbb', 19_500, { cls: 'custom' })];
    expect(ranked(rows, 'all').map((r) => [r.owner, r.lapMs])).toEqual([['aaaa', 19_000], ['bbbb', 19_500]]);
    expect(ranked(rows, 'race5').map((r) => r.lapMs)).toEqual([20_000]);
  });

  test('submission rate per network', () => {
    let t = 0;
    const l = new SubmitLimiter(() => t);
    for (let i = 0; i < SUBMITS_PER_WINDOW; i++) expect(l.take('n')).toBe(true);
    expect(l.take('n')).toBe(false);
    expect(l.take('other')).toBe(true);
    t += 11 * 60_000;
    expect(l.take('n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The tables against the game itself

function dirSource(dir: URL): PackageSource {
  const base = dir.pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const files: { path: string; size: number }[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push({ path: relative(base, p).split(sep).join('/'), size: statSync(p).size }); } };
  walk(base);
  return { list: async () => files, url: (p) => `test://${p}`, read: async (p) => new Uint8Array(readFileSync(join(base, p))) };
}
const pathM = (g: GateDef[]) => g.reduce((s, x, i) => { const a = openingCentre(x), b = openingCentre(g[(i + 1) % g.length]); return s + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z); }, 0);

/** Built-in maps whose MapDef can be built here (procedural ones, community packages from public/). */
async function builtInMaps(): Promise<MapDef[]> {
  const out: MapDef[] = [];
  for (const [id, e] of Object.entries(MAP_LIST)) {
    if (e.source) continue; // Quake / Doom levels: no gates
    if (e.community) out.push((await loadMapPackage(dirSource(new URL(`../public/maps/community/${id}/`, import.meta.url)))).build(id));
    else if (!e.prepare) out.push(MAPS[id]());
  }
  return out;
}

describe('tracks match the maps', async () => {
  const maps = await builtInMaps();
  const courses = (m: MapDef) => m.courses ?? [];

  test('every built-in map with gates (and every course) has a board, with the right gates and length', () => {
    for (const m of maps) {
      const runs: [string, GateDef[]][] = courses(m).length ? courses(m).map((c) => [`${m.id}:${c.id}`, c.gates]) : m.gates.length ? [[m.id, m.gates]] : [];
      for (const [key, gates] of runs) {
        expect(TRACKS[key], key).toBeDefined();
        expect(TRACKS[key].gates, key).toBe(gates.length);
        expect(Math.abs(TRACKS[key].pathM - pathM(gates)), key).toBeLessThan(0.5);
      }
    }
  });

  test('the course a map flies (default, or picked in Simulation → Course) is a board', () => {
    for (const m of maps) {
      if (m.gates.length) { const c = courseOf(m); expect(TRACKS[c ? `${m.id}:${c}` : m.id], m.id).toBeDefined(); }
      for (const c of courses(m)) {
        const flown = withCourse(m, c.id);
        expect(courseOf(flown), `${m.id}:${c.id}`).toBe(c.gates === m.gates ? courses(m).find((x) => x.gates === m.gates)!.id : c.id);
        expect(TRACKS[`${m.id}:${courseOf(flown)}`], `${m.id}:${c.id}`).toBeDefined();
      }
    }
  });

  test('the relay’s gate table (trackGates.ts) is each track’s gates (node scripts/build-track-gates.mjs)', () => {
    expect(Object.keys(TRACK_GATES).sort()).toEqual(Object.keys(TRACKS).sort());
    for (const m of maps) {
      const runs: [string, GateDef[]][] = courses(m).length ? courses(m).map((c) => [`${m.id}:${c.id}`, c.gates]) : m.gates.length ? [[m.id, m.gates]] : [];
      for (const [key, gates] of runs) {
        const t = TRACK_GATES[key];
        expect(t?.length, key).toBe(gates.length);
        gates.forEach((g, i) => {
          const r = t[i], where = `${key} gate ${g.id}`;
          expect([r.id, r.kind], where).toEqual([g.id, g.kind]);
          for (const [a, b] of [[r.x, g.c.x], [r.y, g.c.y], [r.z, g.c.z], [r.w, g.width], [r.h, g.height]]) expect(Math.abs(a - b), where).toBeLessThan(0.002);
          expect(Math.abs(r.yaw - g.yaw), where).toBeLessThan(1e-4);
        });
      }
    }
  });

  test('every board this build has a map for is that map’s', () => {
    for (const key of Object.keys(TRACKS)) {
      const [map, course] = key.split(':');
      const m = maps.find((x) => x.id === map);
      if (!MAP_LIST[map]) continue; // a map added on another branch: checked once it is here
      expect(m, key).toBeDefined();
      if (course) expect(courses(m!).some((c) => c.id === course), key).toBe(true);
      else expect(m!.gates.length, key).toBeGreaterThan(0);
    }
  });
});

describe('classes match the presets', () => {
  test('every preset has a class with its name, and every class is in the menu', () => {
    for (const p of PRESETS) {
      const id = PRESET_CLASS[p.name];
      expect(id, p.name).toBeDefined();
      expect(CLASSES[id].name).toBe(p.name.replace(/^Beginner: /, ''));
    }
    expect([...CLASS_IDS].sort()).toEqual(Object.keys(CLASSES).sort());
  });

  test('no real lap is ever refused: each class’s vmax is well above its top speed, amax above full thrust plus gravity', () => {
    for (const p of PRESETS) {
      const info = buildDrone(p).info, c = CLASSES[PRESET_CLASS[p.name]];
      expect(c.vmax, p.name).toBeGreaterThanOrEqual(1.25 * info.estTopSpeedKmh / 3.6);
      expect(c.amax, p.name).toBeGreaterThanOrEqual(1.2 * (info.thrustToWeight + 1) * 9.81);
    }
  }, 60_000); // builds every preset

  test('the custom format is what the client writes', () => {
    expect(CUSTOM_SUMMARY_RE.test('Custom · 65 mm · 0702 26000KV · 1S')).toBe(true);
    expect(CUSTOM_SUMMARY_RE.test('Custom · 7" · 2806.5 1300KV · 6S')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The Durable Object (SQLite) and the Worker's routes

let sqlite: any = null;
try { sqlite = await import('node:sqlite'); } catch { /* Node without node:sqlite: these tests are skipped */ }
// index.ts is typed against @cloudflare/workers-types (server/ only): loaded untyped, as in serverRoom.test.ts
let mod: any;
const INDEX = '../server/src/index';
beforeAll(async () => {
  (globalThis as any).WebSocketRequestResponsePair ??= class { constructor(public request: string, public response: string) {} };
  mod = await import(/* @vite-ignore */ INDEX);
});

/** storage.sql over node:sqlite (exec(query, ...bindings).toArray(), as on Cloudflare). */
function sqlStorage() {
  const db = new sqlite.DatabaseSync(':memory:');
  // (Cloudflare binds a BLOB as an ArrayBuffer; node:sqlite wants a typed array)
  return { db, sql: { exec: (q: string, ...b: unknown[]) => { const rows = db.prepare(q).all(...b.map((x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x))); return { toArray: () => rows }; } } };
}

describe.skipIf(!sqlite)('Leaderboard Durable Object', () => {
  const make = () => { const s = sqlStorage(); return { ...s, obj: new mod.Leaderboard({ storage: { sql: s.sql } }, {}) }; };
  const submit = (obj: any, raw: object, owner: string, net = 'aaaabbbbccccdddd', replay?: Uint8Array) => obj.fetch(new Request('https://board/submit', { method: 'POST', body: replay ? packLap(JSON.stringify({ raw, owner, net }), replay) : JSON.stringify({ raw, owner, net }) })).then((r: Response) => r.json());
  const replayOf = (obj: any, id: number) => obj.fetch(new Request(`https://board/replay?id=${id}`));
  const list = (obj: any, qs: string) => obj.fetch(new Request(`https://board/list?${qs}`)).then((r: Response) => r.json());

  test('stores, ranks, keeps each pilot’s best, never shows hashes or splits', async () => {
    const { obj, db } = make();
    expect(await submit(obj, lap({ lapMs: 30_000, splitsMs: splits(13, 30_000) }), 'owner0001')).toMatchObject({ ok: true, stored: true, rank: 1 });
    expect(await submit(obj, lap({ initials: 'BOB', lapMs: 25_000, splitsMs: splits(13, 25_000) }), 'owner0002')).toMatchObject({ stored: true, rank: 1 });
    expect(await submit(obj, lap({ lapMs: 31_000, splitsMs: splits(13, 31_000) }), 'owner0001')).toMatchObject({ stored: false, reason: 'slower', rank: 2 });
    const better = await submit(obj, lap({ initials: 'ZED', lapMs: 24_000 }), 'owner0001');
    expect(better).toMatchObject({ stored: true, rank: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM laps').get().n).toBe(2); // the pilot's entry replaced
    const l = await list(obj, 'map=field&class=freestyle5');
    expect(l.entries.map((x: any) => [x.initials, x.lapMs])).toEqual([['ZED', 24_000], ['BOB', 25_000]]);
    expect(Object.keys(l.entries[0]).sort()).toEqual(['at', 'cls', 'id', 'initials', 'lapMs', 'replay', 'summary']);
    expect(JSON.stringify(l)).not.toContain('owner0001');
    expect((await list(obj, 'map=field&class=race5')).entries).toEqual([]);
    expect((await list(obj, 'map=field')).entries.length).toBe(2);
  });

  test('refuses what the Worker would (checked again), deletes by id', async () => {
    const { obj } = make();
    expect(await submit(obj, lap({ timeScale: 0.5 }), 'owner0001')).toMatchObject({ ok: false });
    const r = await submit(obj, lap(), 'owner0001');
    const del = await obj.fetch(new Request('https://board/delete', { method: 'POST', body: JSON.stringify({ id: r.id }) }));
    expect(del.status).toBe(200);
    expect((await list(obj, 'map=field&class=freestyle5')).entries).toEqual([]);
    expect((await obj.fetch(new Request('https://board/delete', { method: 'POST', body: JSON.stringify({ id: r.id }) }))).status).toBe(404);
  });

  test('replays: stored with their entry, gone with it (a faster lap is a new entry); old entries have none', async () => {
    const { obj, db } = make();
    const r1 = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    const a = await submit(obj, lap({ lapMs: 30_000, splitsMs: splits(13, 30_000) }), 'owner0001', 'net0000000000001', r1);
    expect(a).toMatchObject({ stored: true, rank: 1 });
    expect(new Uint8Array(await (await replayOf(obj, a.id)).arrayBuffer())).toEqual(r1);
    expect((await list(obj, 'map=field&class=freestyle5')).entries[0]).toMatchObject({ id: a.id, replay: true });
    // a lap posted before replays existed (no replay row)
    const old = await submit(obj, lap({ initials: 'OLD', lapMs: 31_000, splitsMs: splits(13, 31_000) }), 'owner0002');
    expect((await replayOf(obj, old.id)).status).toBe(404);
    expect((await list(obj, 'map=field&class=freestyle5')).entries[1]).toMatchObject({ initials: 'OLD', replay: false });
    // the first pilot improves: a new id with the new replay, the old one's replay is gone
    const b = await submit(obj, lap({ lapMs: 29_000, splitsMs: splits(13, 29_000) }), 'owner0001', 'net0000000000001', Uint8Array.of(1, 2, 3));
    expect(b.id).not.toBe(a.id);
    expect((await replayOf(obj, a.id)).status).toBe(404);
    expect([...new Uint8Array(await (await replayOf(obj, b.id)).arrayBuffer())]).toEqual([1, 2, 3]);
    // a slower lap stores nothing
    await submit(obj, lap({ lapMs: 35_000, splitsMs: splits(13, 35_000) }), 'owner0001', 'net0000000000001', Uint8Array.of(4));
    expect(db.prepare('SELECT COUNT(*) AS n FROM replays').get().n).toBe(1);
    await obj.fetch(new Request('https://board/delete', { method: 'POST', body: JSON.stringify({ id: b.id }) }));
    expect(db.prepare('SELECT COUNT(*) AS n FROM replays').get().n).toBe(0);
  });

  test('a full board drops its slowest entry', async () => {
    const { obj, db } = make();
    for (let i = 0; i < BOARD_SIZE; i++) {
      const ms = 20_000 + i * 100;
      await submit(obj, lap({ lapMs: ms, splitsMs: splits(13, ms) }), `owner${String(i).padStart(4, '0')}`, `net${String(i).padStart(13, '0')}`);
    }
    expect(await submit(obj, lap({ lapMs: 40_000, splitsMs: splits(13, 40_000) }), 'ownerlate', 'netlate000000000')).toMatchObject({ stored: false, reason: 'unranked' });
    const slowest = db.prepare('SELECT id FROM laps ORDER BY lap_ms DESC LIMIT 1').get().id;
    db.prepare('INSERT INTO replays (lap_id, data, bytes) VALUES (?, ?, 1)').run(slowest, Uint8Array.of(1));
    expect(await submit(obj, lap({ lapMs: 20_050, splitsMs: splits(13, 20_050) }), 'ownerfast', 'netfast000000000', Uint8Array.of(2))).toMatchObject({ stored: true, rank: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n, MAX(lap_ms) AS worst FROM laps').get()).toEqual({ n: BOARD_SIZE, worst: 20_000 + (BOARD_SIZE - 2) * 100 });
    expect(db.prepare('SELECT lap_id FROM replays').all().map((r: any) => r.lap_id)).not.toContain(slowest); // its replay went with it
  });
});

describe.skipIf(!sqlite)('Worker /leaderboard', () => {
  const ORIGIN = 'https://fpv-sim-gamma.vercel.app';
  function env(extra: Record<string, unknown> = {}) {
    const s = sqlStorage();
    const obj = new mod.Leaderboard({ storage: { sql: s.sql } }, {});
    let calls = 0;
    const stub = { fetch: (url: string, init?: RequestInit) => { calls++; return obj.fetch(new Request(url, init)); } };
    return { db: s.db, calls: () => calls, env: { LEADERBOARD: { idFromName: () => 'global', get: () => stub }, ALLOWED_ORIGINS: `${ORIGIN},app://fpv-sim`, IP_SALT: 'salt', ...extra } as any };
  }
  const post = (e: any, body: unknown, headers: Record<string, string> = {}) => mod.default.fetch(new Request('https://relay.example/leaderboard', {
    method: 'POST', body: typeof body === 'string' || body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body), headers: { Origin: ORIGIN, 'Content-Type': body instanceof Uint8Array ? LAP_MIME : 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers },
  }), e);
  /** A lap that flies quarry-loop (its replay passes the relay's check), as the client posts it. */
  const flown = async (extra: Record<string, unknown> = {}) => {
    const l = await syntheticLap('quarry-loop');
    return { l, body: packLap(JSON.stringify(lap({ map: 'quarry-loop', lapMs: l.lapMs, splitsMs: l.splitsMs, ...extra })), l.replay) };
  };
  const get = (e: any, qs: string) => mod.default.fetch(new Request(`https://relay.example/leaderboard?${qs}`, { headers: { Origin: ORIGIN } }), e);

  test('GET: CORS, a short cache, unknown boards refused', async () => {
    vi.setSystemTime(9_000_000);
    const e = env();
    const r = await get(e.env, 'map=field&class=whoop65');
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=10');
    expect((await r.json()).entries).toEqual([]);
    await get(e.env, 'map=field&class=whoop65');
    expect(e.calls()).toBe(1); // the isolate cache
    expect((await get(e.env, 'map=local-x')).status).toBe(400);
    const pre = await mod.default.fetch(new Request('https://relay.example/leaderboard', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), e.env);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    vi.useRealTimers();
  });

  test('POST: allowed origins only, size limit, validation, rate limit; stores hashes, not the IP or token', async () => {
    const e = env();
    expect((await post(e.env, lap({ map: 'quarry-loop', splitsMs: splits(8, 24_000) }), { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(e.env, 'x'.repeat(5000))).status).toBe(413);
    expect((await post(e.env, '{nope')).status).toBe(400);
    const bad = await post(e.env, lap({ initials: 'abc' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/initials/);
    // a lap needs its replay, and the replay has to fly that lap
    const bare = await post(e.env, lap({ map: 'quarry-loop', splitsMs: splits(8, 24_000) }));
    expect([bare.status, (await bare.json()).error]).toEqual([400, expect.stringMatching(/with its replay/)]);
    const { l, body } = await flown();
    const wrong = await post(e.env, packLap(JSON.stringify(lap({ map: 'quarry-loop', lapMs: l.lapMs + 300, splitsMs: [...l.splitsMs.slice(0, -1), l.lapMs + 300] })), l.replay));
    expect([wrong.status, (await wrong.json()).error]).toEqual([400, expect.stringMatching(/^replay: /)]);
    const ok = await post(e.env, body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, stored: true, rank: 1 });
    const row = e.db.prepare('SELECT owner, net FROM laps').get();
    expect(row.owner).toMatch(/^[0-9a-f]{32}$/);
    expect(row.net).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain(CLIENT);
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');
    // a fresh read sees the new lap at once (the isolate cache of that track is dropped)
    expect((await (await get(e.env, 'map=quarry-loop&class=all')).json()).entries.length).toBe(1);
    const limited = { ...e.env, RATE_LIMITER: { limit: async ({ key }: { key: string }) => ({ success: key !== 'lb:203.0.113.7' }) } };
    expect((await post(limited, body)).status).toBe(429);
  });

  test('GET /leaderboard/:id/replay: the stored bytes, CORS, cached for a day; none: 404', async () => {
    const e = env();
    const { l, body } = await flown();
    const { id } = await (await post(e.env, body)).json();
    const get1 = (path: string, headers: Record<string, string> = { Origin: ORIGIN }) => mod.default.fetch(new Request(`https://relay.example${path}`, { headers }), e.env);
    const r = await get1(`/leaderboard/${id}/replay`);
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('application/vnd.fpv-sim.replay');
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(l.replay);
    const none = await get1('/leaderboard/999999/replay');
    expect([none.status, none.headers.get('Cache-Control')]).toEqual([404, 'public, max-age=60']);
    expect((await mod.default.fetch(new Request(`https://relay.example/leaderboard/${id}/replay`, { method: 'POST', headers: { Origin: ORIGIN } }), e.env)).status).toBe(405);
    expect((await (await get(e.env, 'map=quarry-loop&class=all')).json()).entries[0]).toMatchObject({ id, replay: true });
  });

  test('DELETE needs the admin token', async () => {
    const e = env({ ADMIN_TOKEN: 'sekrit' });
    const { id } = await (await post(e.env, (await flown({ initials: 'DEL' })).body)).json();
    const del = (auth?: string) => mod.default.fetch(new Request(`https://relay.example/leaderboard/${id}`, { method: 'DELETE', headers: auth ? { Authorization: auth } : {} }), e.env);
    expect((await del()).status).toBe(404);
    expect((await del('Bearer wrong')).status).toBe(404);
    expect((await del('Bearer sekrit')).status).toBe(200);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM laps').get().n).toBe(0);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM replays').get().n).toBe(0); // and its replay
    expect((await mod.default.fetch(new Request(`https://relay.example/leaderboard/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer x' } }), env().env)).status).toBe(404); // no token set: no admin route
  });
});
