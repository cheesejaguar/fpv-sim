// Share links, server side: GET /leaderboard/entry/:id, the public entry a phone draws a lap's
// cards from (its track, its rank on its class board and that board's top 5). The pure part
// (entryView) and the Worker route over the Leaderboard Durable Object on node:sqlite.
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { Entry, ENTRY_TOP, entryView, LAP_MIME, LB_VERSION, packLap } from '../server/src/leaderboardCore';
import { syntheticLap } from './helpers/replayLap';

const CLIENT = '0123456789abcdef0123456789abcdef';
const splits = (n: number, lapMs: number) => Array.from({ length: n }, (_, i) => Math.round(((i + 1) * lapMs) / n));
const lap = (extra: Record<string, unknown> = {}) => ({ v: LB_VERSION, client: CLIENT, map: 'field', class: 'freestyle5', initials: 'ACE', lapMs: 24_000, splitsMs: splits(13, 24_000), timeScale: 1, summary: 'whatever', ...extra });

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
    expect(v.entry).toEqual({ id: 1, initials: 'ACE', lapMs: 30_000, cls: 'freestyle5', summary: '5" Freestyle 6S', at: 1, replay: false, map: 'field', course: '' });
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
    // (Cloudflare binds a BLOB as an ArrayBuffer; node:sqlite wants a typed array)
    const sql = { exec: (q: string, ...b: unknown[]) => { const rows = db.prepare(q).all(...b.map((x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x))); return { toArray: () => rows }; } };
    const obj = new mod.Leaderboard({ storage: { sql } }, {});
    let calls = 0;
    const stub = { fetch: (url: string, init?: RequestInit) => { calls++; return obj.fetch(new Request(url, init)); } };
    return { calls: () => calls, env: { LEADERBOARD: { idFromName: () => 'global', get: () => stub }, ALLOWED_ORIGINS: ORIGIN, IP_SALT: 'salt' } as any };
  }
  const post = (e: any, body: Uint8Array, ip: string) => mod.default.fetch(new Request('https://relay.example/leaderboard', {
    method: 'POST', body: body as BodyInit, headers: { Origin: ORIGIN, 'Content-Type': LAP_MIME, 'CF-Connecting-IP': ip },
  }), e);
  /** A lap that flies quarry-loop at `speed` m/s, posted with its replay as the client does (the relay checks it). */
  const flown = async (speed: number, extra: Record<string, unknown> = {}) => {
    const l = await syntheticLap('quarry-loop', 'freestyle5', { speed });
    return { lapMs: l.lapMs, body: packLap(JSON.stringify(lap({ map: 'quarry-loop', lapMs: l.lapMs, splitsMs: l.splitsMs, ...extra })), l.replay) };
  };
  const get = (e: any, path: string, origin = ORIGIN) => mod.default.fetch(new Request(`https://relay.example${path}`, { headers: { Origin: origin } }), e);

  test('one entry: its track, rank and top 5; CORS and a short cache; unknown ids 404', async () => {
    vi.setSystemTime(7_000_000);
    const e = env();
    const ace = await flown(14);
    const a = await (await post(e.env, ace.body, '203.0.113.1')).json();
    expect(a, JSON.stringify(a)).toMatchObject({ ok: true });
    await post(e.env, (await flown(15, { initials: 'BOB', client: 'f'.repeat(32) })).body, '203.0.113.2');
    const r = await get(e.env, `/leaderboard/entry/${a.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=10');
    const j = await r.json();
    expect(j).toMatchObject({ entry: { id: a.id, initials: 'ACE', lapMs: ace.lapMs, map: 'quarry-loop', course: '', cls: 'freestyle5', replay: true }, rank: 2, total: 2 });
    expect(j.top.map((x: any) => x.initials)).toEqual(['BOB', 'ACE']);
    expect(Object.keys(j.entry).sort()).toEqual(['at', 'cls', 'course', 'id', 'initials', 'lapMs', 'map', 'replay', 'summary']);
    const calls = e.calls();
    await get(e.env, `/leaderboard/entry/${a.id}`);
    expect(e.calls()).toBe(calls); // the isolate cache
    // a new lap on the board moves ranks: the cached entry is dropped
    await post(e.env, (await flown(16, { initials: 'CAT', client: 'e'.repeat(32) })).body, '203.0.113.3');
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
