// Share links, server side: GET /leaderboard/entry/:id, the public entry a phone draws a lap's
// cards from (its track, its rank on its class board and that board's top 5). The pure part
// (entryView) and the Worker route over the Leaderboard Durable Object on node:sqlite.
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { Entry, ENTRY_TOP, entryView } from '../server/src/leaderboardCore';

const CLIENT = '0123456789abcdef0123456789abcdef';
const splits = (n: number, lapMs: number) => Array.from({ length: n }, (_, i) => Math.round(((i + 1) * lapMs) / n));
const lap = (extra: Record<string, unknown> = {}) => ({ v: 1, client: CLIENT, map: 'field', class: 'freestyle5', initials: 'ACE', lapMs: 24_000, splitsMs: splits(13, 24_000), timeScale: 1, summary: 'whatever', ...extra });

const row = (id: number, lapMs: number, extra: Partial<Entry> = {}): Entry => ({
  id, map: 'field', course: '', cls: 'freestyle5', owner: `owner${id}`, net: `net${id}`, initials: 'ACE', lapMs, splitsMs: [lapMs], summary: '5" Freestyle 6S', at: id, ...extra,
});

describe('entryView', () => {
  test('ranks the entry on its own class board and sends that board’s top 5', () => {
    const rows = [row(1, 30_000), row(2, 25_000), row(3, 27_000, { cls: 'race5' }), ...[4, 5, 6, 7, 8].map((id) => row(id, 20_000 + id * 100))];
    const v = entryView(rows, 1)!;
    expect(v.rank).toBe(7);
    expect(v.total).toBe(7); // the race5 lap is on another board
    expect(v.top.map((e) => e.id)).toEqual([4, 5, 6, 7, 8]);
    expect(v.top.length).toBe(ENTRY_TOP);
    expect(v.entry).toEqual({ id: 1, initials: 'ACE', lapMs: 30_000, cls: 'freestyle5', summary: '5" Freestyle 6S', at: 1, map: 'field', course: '' });
    // never the hashes or the splits
    expect(JSON.stringify(v)).not.toMatch(/owner|net\d|splits/);
    expect(entryView(rows, 3)).toMatchObject({ rank: 1, total: 1 });
    expect(entryView(rows, 99)).toBeNull();
  });
});

let sqlite: any = null;
try { sqlite = await import('node:sqlite'); } catch { /* Node without node:sqlite: these tests are skipped */ }
let mod: any;
const INDEX = '../server/src/index';
beforeAll(async () => {
  (globalThis as any).WebSocketRequestResponsePair ??= class { constructor(public request: string, public response: string) {} };
  mod = await import(/* @vite-ignore */ INDEX);
});

describe.skipIf(!sqlite)('Worker GET /leaderboard/entry/:id', () => {
  const ORIGIN = 'https://fpv-sim-gamma.vercel.app';
  function env() {
    const db = new sqlite.DatabaseSync(':memory:');
    const sql = { exec: (q: string, ...b: unknown[]) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
    const obj = new mod.Leaderboard({ storage: { sql } }, {});
    let calls = 0;
    const stub = { fetch: (url: string, init?: RequestInit) => { calls++; return obj.fetch(new Request(url, init)); } };
    return { calls: () => calls, env: { LEADERBOARD: { idFromName: () => 'global', get: () => stub }, ALLOWED_ORIGINS: ORIGIN, IP_SALT: 'salt' } as any };
  }
  const post = (e: any, body: unknown, ip: string) => mod.default.fetch(new Request('https://relay.example/leaderboard', {
    method: 'POST', body: JSON.stringify(body), headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  }), e);
  const get = (e: any, path: string, origin = ORIGIN) => mod.default.fetch(new Request(`https://relay.example${path}`, { headers: { Origin: origin } }), e);

  test('one entry: its track, rank and top 5; CORS and a short cache; unknown ids 404', async () => {
    vi.setSystemTime(7_000_000);
    const e = env();
    const a = await (await post(e.env, lap({ map: 'quarry-loop', splitsMs: splits(8, 24_000) }), '203.0.113.1')).json();
    await post(e.env, lap({ map: 'quarry-loop', initials: 'BOB', lapMs: 23_000, splitsMs: splits(8, 23_000), client: 'f'.repeat(32) }), '203.0.113.2');
    const r = await get(e.env, `/leaderboard/entry/${a.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=10');
    const j = await r.json();
    expect(j).toMatchObject({ entry: { id: a.id, initials: 'ACE', lapMs: 24_000, map: 'quarry-loop', course: '', cls: 'freestyle5' }, rank: 2, total: 2 });
    expect(j.top.map((x: any) => x.initials)).toEqual(['BOB', 'ACE']);
    expect(Object.keys(j.entry).sort()).toEqual(['at', 'cls', 'course', 'id', 'initials', 'lapMs', 'map', 'summary']);
    const calls = e.calls();
    await get(e.env, `/leaderboard/entry/${a.id}`);
    expect(e.calls()).toBe(calls); // the isolate cache
    // a new lap on the board moves ranks: the cached entry is dropped
    await post(e.env, lap({ map: 'quarry-loop', initials: 'CAT', lapMs: 22_000, splitsMs: splits(8, 22_000), client: 'e'.repeat(32) }), '203.0.113.3');
    expect((await (await get(e.env, `/leaderboard/entry/${a.id}`)).json()).rank).toBe(3);
    const missing = await get(e.env, '/leaderboard/entry/424242');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).toBe('no-store');
    expect((await get(e.env, '/leaderboard/entry/abc')).status).toBe(404); // not the route
    // any page may read a public entry, but only allowed origins get CORS
    expect((await get(e.env, `/leaderboard/entry/${a.id}`, 'https://evil.example')).headers.get('Access-Control-Allow-Origin')).toBeNull();
    const del = await mod.default.fetch(new Request(`https://relay.example/leaderboard/entry/${a.id}`, { method: 'DELETE', headers: { Origin: ORIGIN } }), e.env);
    expect(del.status).toBe(405);
    vi.useRealTimers();
  });
});
