// The relay's Durable Objects (server/src/index.ts) driven with fake state / storage / sockets: what
// reaches the directory and storage (hello flood, debounce, private rooms), hibernation restore,
// empty-room cleanup, and the Worker's /rooms cache and upgrade gates.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// index.ts is typed against @cloudflare/workers-types (server/ only): load it untyped so the app's
// tsconfig doesn't have to know Workers types.
let mod: any;
const PATH = '../server/src/index';
beforeAll(async () => {
  (globalThis as any).WebSocketRequestResponsePair = class { constructor(public request: string, public response: string) {} };
  mod = await import(/* @vite-ignore */ PATH);
});

class FakeWs {
  sent: any[] = []; closed: { code?: number; reason?: string } | null = null; att: unknown = null; attWrites = 0;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code?: number, reason?: string) { this.closed ??= { code, reason }; }
  serializeAttachment(a: unknown) { this.att = JSON.parse(JSON.stringify(a)); this.attWrites++; }
  deserializeAttachment() { return this.att; }
  last(t: string) { return [...this.sent].reverse().find((m) => m.t === t); }
}
class FakeStorage {
  data = new Map<string, unknown>(); alarm: number | null = null; ops: string[] = [];
  async get(k: string | string[]) {
    if (!Array.isArray(k)) return this.data.get(k);
    const m = new Map<string, unknown>(); for (const x of k) if (this.data.has(x)) m.set(x, this.data.get(x)); return m;
  }
  async put(k: string | Record<string, unknown>, v?: unknown) { this.ops.push('put'); if (typeof k === 'string') this.data.set(k, v); else for (const [a, b] of Object.entries(k)) this.data.set(a, b); }
  async delete(k: string) { this.ops.push('delete'); return this.data.delete(k); }
  async deleteAll() { this.ops.push('deleteAll'); this.data.clear(); }
  async getAlarm() { return this.alarm; }
  async setAlarm(t: number) { this.ops.push('setAlarm'); this.alarm = t; }
  async deleteAlarm() { this.ops.push('deleteAlarm'); this.alarm = null; }
}
class FakeState {
  storage = new FakeStorage(); sockets: FakeWs[] = []; auto: any = null;
  acceptWebSocket(ws: FakeWs) { this.sockets.push(ws); }
  getWebSockets() { return this.sockets.filter((s) => !s.closed); }
  setWebSocketAutoResponse(p: unknown) { this.auto = p; }
  async blockConcurrencyWhile<T>(fn: () => Promise<T>) { return fn(); }
}
function fakeEnv() {
  const calls: { path: string; body: any }[] = [];
  let lists = 0;
  const lobby = { fetch: async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/list') { lists++; return new Response(JSON.stringify({ rooms: [{ code: 'ABCDE' }], now: 1 })); }
    calls.push({ path, body: JSON.parse(String(init?.body)) }); return new Response('ok');
  } };
  const forwarded: Request[] = [];
  const env: any = {
    LOBBY: { idFromName: () => 'global', get: () => lobby },
    ROOMS: { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => { forwarded.push(r); return new Response('to room'); } }) },
    ALLOWED_ORIGINS: 'https://fpv-sim-gamma.vercel.app,app://fpv-sim',
  };
  return { env, calls, forwarded, lists: () => lists };
}
const hello = (name: string, extra: object = {}) => JSON.stringify({ t: 'hello', v: 2, name, color: '#ff8800', frame: '5in', ...extra });
const HOST = { room: { name: 'Evening race', public: true } };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });

/** The runtime fires the alarm at time t (a fired alarm is consumed). */
async function fire(r: any, state: FakeState, t: number) { vi.setSystemTime(t); state.storage.alarm = null; await r.alarm(); }

async function room(state = new FakeState(), e = fakeEnv()) {
  const r = new mod.Room(state, e.env);
  const join = async (name: string, extra: object = {}) => { const ws = new FakeWs(); await r.accept(ws, 'ABCDE', '0123456789abcdef'); await r.webSocketMessage(ws, hello(name, extra)); return ws; };
  return { r, state, e, join };
}

describe('Room durable object', () => {
  test('pings are answered by the runtime (auto-response), not by waking the room', async () => {
    const { state } = await room();
    expect(state.auto).toMatchObject({ request: '{"t":"ping"}', response: '{"t":"pong"}' });
  });

  test('hello flood: only an accepted hello is stored and reported', async () => {
    const { r, e, join } = await room();
    const a = await join('Ann', HOST);
    expect(e.calls.map((c) => c.path)).toEqual(['/upsert']);
    expect(e.calls[0].body).toMatchObject({ code: 'ABCDE', name: 'Evening race', players: 1, owner: '0123456789abcdef' });
    const writes = a.attWrites;
    for (let i = 0; i < 100; i++) { vi.advanceTimersByTime(30); await r.webSocketMessage(a, hello(`Ann${i}`, HOST)); }
    expect(e.calls.length).toBe(1);   // no lobby traffic from repeated hellos
    expect(a.attWrites).toBe(writes); // no attachment rewrites either
  });

  test('directory reports: join / leave at once (max 1/s), map changes at most every 5 s, heartbeat alarm', async () => {
    const { r, state, e, join } = await room();
    const a = await join('Ann', { ...HOST, map: 'field' });
    vi.advanceTimersByTime(200);
    const b = await join('Bo');                      // 0.2 s after the last report: owed, not sent
    expect(e.calls.length).toBe(1);
    expect(state.storage.alarm).toBe(1_000_000 + 1000);
    await fire(r, state, 1_000_000 + 1000);
    expect(e.calls.length).toBe(2);
    expect(e.calls[1].body.players).toBe(2);
    vi.advanceTimersByTime(1500);
    await r.webSocketMessage(b, JSON.stringify({ t: 'map', map: 'bando' }));
    expect(e.calls.length).toBe(2);                 // map change 1.5 s after a report: waits for the 5 s gap
    await fire(r, state, 1_000_000 + 6000);
    expect(e.calls[2].body.map).toBe('bando');
    expect(state.storage.alarm).toBe(1_000_000 + 6000 + 20_000); // public room: heartbeat
    await fire(r, state, 1_000_000 + 26_000);
    expect(e.calls.length).toBe(4);
    vi.setSystemTime(1_000_000 + 27_000);
    await r.webSocketClose(a);                       // a leave goes out at once
    expect(e.calls.length).toBe(5);
    expect(e.calls[4].body.players).toBe(1);
  });

  test('private rooms never talk to the directory and keep no heartbeat alarm', async () => {
    const { r, state, e, join } = await room();
    const a = await join('Ann', { room: { name: 'secret', public: false }, map: 'field' });
    await join('Bo');
    vi.advanceTimersByTime(6000);
    await r.webSocketMessage(a, JSON.stringify({ t: 'map', map: 'bando' }));
    // the only alarm was the hello deadline of the first socket; once it fires nothing re-arms it
    await fire(r, state, 1_000_000 + 10_000);
    expect(state.storage.alarm).toBeNull();
    expect(e.calls).toEqual([]);
  });

  test('a socket that never says hello is closed by the alarm after 10 s', async () => {
    const { r, state, join } = await room();
    await join('Ann');
    const quiet = new FakeWs();
    vi.advanceTimersByTime(3000);
    await r.accept(quiet, 'ABCDE', null);
    await fire(r, state, 1_000_000 + 10_000);
    expect(quiet.closed).toBeNull();
    expect(state.storage.alarm).toBe(1_000_000 + 13_000);
    await fire(r, state, 1_000_000 + 13_000);
    expect(quiet.closed?.code).toBe(4008);
  });

  test('oversized messages close the socket with 1009 before anything is stored or answered', async () => {
    const { r, join } = await room();
    const a = await join('Ann', HOST), b = await join('Bo');
    const att = JSON.stringify(b.att), sent = b.sent.length;
    await r.webSocketMessage(b, hello('x'.repeat(2000)));
    expect(b.closed?.code).toBe(1009);
    expect(b.sent.length).toBe(sent);
    expect(JSON.stringify(b.att)).toBe(att);
    expect(a.last('leave')).toEqual({ t: 'leave', id: 2 });
    const c = await join('Cy');
    await r.webSocketMessage(c, new ArrayBuffer(4096));
    expect(c.closed?.code).toBe(1009);
  });

  test('hibernation: the rebuilt room restores pilots silently (same ids, no ghosts, no re-welcome)', async () => {
    const { state, e, join } = await room();
    const a = await join('Ann', HOST), b = await join('Bo'), c = await join('Cy');
    // a new object on the same state + sockets is what a wake-up from hibernation is
    const { r: woke } = await room(state, e);
    await woke.webSocketClose(c);    // Cy (id 3) leaves while the room sleeps / wakes
    for (const s of [a, b]) s.sent = [];
    const { r: again } = await room(state, e); // woken once more, from the attachments alone
    await again.webSocketMessage(a, JSON.stringify({ t: 's', p: [1, 2, 3], q: [1, 0, 0, 0], r: [1, 2, 3, 4], a: 1, c: 5, h: 0 }));
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([{ t: 's', id: 1, p: [1, 2, 3], q: [1, 0, 0, 0], r: [1, 2, 3, 4], a: 1, c: 5, h: 0 }]);
    const d = new FakeWs();
    await again.accept(d, 'ABCDE', null);
    await again.webSocketMessage(d, hello('Di'));
    expect(d.last('welcome').id).toBe(4); // never Cy's 3
    expect(d.last('welcome').players.map((p: any) => [p.id, p.name])).toEqual([[1, 'Ann'], [2, 'Bo']]);
    expect(a.sent.filter((m) => m.t === 'welcome')).toEqual([]);
    expect(a.sent.filter((m) => m.t === 'join').map((m) => m.player.id)).toEqual([4]);
  });

  test('an empty room is delisted and its storage deleted', async () => {
    const { r, state, e, join } = await room();
    const a = await join('Ann', { ...HOST, map: 'field' });
    expect(state.storage.data.size).toBeGreaterThan(0);
    await r.webSocketClose(a);
    expect(e.calls.map((c) => c.path)).toEqual(['/upsert', '/remove']);
    expect(state.storage.ops).toContain('deleteAll');
    expect(state.storage.data.size).toBe(0);
    expect(state.storage.alarm).toBeNull();
    // a new host can name the room again
    const b = await join('Bo', { room: { name: 'Fresh', public: true } });
    expect(b.last('welcome').map).toBeNull();
    expect(e.calls[2].body).toMatchObject({ name: 'Fresh', host: 'Bo' });
  });
});

describe('Lobby durable object', () => {
  test('storage is written when a room is added or removed, not on heartbeats', async () => {
    const state = new FakeState();
    const lobby = new mod.Lobby(state, {});
    const post = (path: string, body: object) => lobby.fetch(new Request(`https://lobby${path}`, { method: 'POST', body: JSON.stringify(body) }));
    const entry = { code: 'ABCDE', name: 'x', map: 'field', players: 1, max: 8, host: 'A' };
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(20_000); expect((await post('/upsert', { ...entry, players: 1 + (i % 3) })).status).toBe(200); }
    expect(state.storage.ops.filter((o) => o === 'put').length).toBe(1);
    await post('/remove', { code: 'ABCDE' });
    expect(state.storage.ops.filter((o) => o === 'put').length).toBe(2);
    const owner = 'abcdefabcdef0123';
    const refused = await Promise.all(['AAAA', 'BBBB', 'CCCC', 'DDDD'].map((code) => post('/upsert', { ...entry, code, owner })));
    expect(refused.map((r) => r.status)).toEqual([200, 200, 200, 429]);
    const list = await (await lobby.fetch(new Request('https://lobby/list'))).json();
    expect(list.rooms.length).toBe(3);
    expect(JSON.stringify(list)).not.toContain(owner);
  });
});

describe('Worker entry', () => {
  const upgrade = (origin: string, extra: Record<string, string> = {}) => new Request('https://relay.example/room/abcde', { headers: { Upgrade: 'websocket', Origin: origin, 'CF-Connecting-IP': '203.0.113.7', ...extra } });

  test('GET /rooms is cached for 3 s and says so', async () => {
    vi.setSystemTime(5_000_000);
    const e = fakeEnv();
    const get = () => mod.default.fetch(new Request('https://relay.example/rooms', { headers: { Origin: 'https://fpv-sim-gamma.vercel.app' } }), e.env);
    const r1 = await get();
    expect(r1.headers.get('Cache-Control')).toBe('public, max-age=3');
    expect(r1.headers.get('Access-Control-Allow-Origin')).toBe('https://fpv-sim-gamma.vercel.app');
    expect((await r1.json()).rooms[0].code).toBe('ABCDE');
    for (let i = 0; i < 20; i++) await get();
    expect(e.lists()).toBe(1);
    vi.setSystemTime(5_000_000 + 3100);
    await get();
    expect(e.lists()).toBe(2);
  });

  test('upgrades: origin allow-list, optional rate limiter and denylist, headers set by the worker', async () => {
    const e = fakeEnv();
    expect((await mod.default.fetch(upgrade('https://evil.example'), e.env)).status).toBe(403);
    // app://fpv-sim (desktop build) is an exact entry
    const ok = await mod.default.fetch(upgrade('app://fpv-sim', { 'X-Client-Hash': 'forged', 'X-Room-Code': 'OTHER' }), e.env);
    expect(await ok.text()).toBe('to room');
    const fwd = e.forwarded[0];
    expect(fwd.headers.get('X-Room-Code')).toBe('ABCDE');
    expect(fwd.headers.get('X-Client-Hash')).toMatch(/^[0-9a-f]{32}$/);
    expect(fwd.headers.get('X-Client-Hash')).not.toContain('203.0.113.7');
    // optional bindings, used only when present
    const limited = { ...e.env, RATE_LIMITER: { limit: async ({ key }: { key: string }) => ({ success: key !== '203.0.113.7' }) } };
    expect((await mod.default.fetch(upgrade('app://fpv-sim'), limited)).status).toBe(429);
    const kv = (keys: string[]) => ({ get: async (k: string) => (keys.includes(k) ? '1' : null) });
    expect((await mod.default.fetch(upgrade('app://fpv-sim'), { ...e.env, DENYLIST: kv(['code:ABCDE']) })).status).toBe(403);
    expect((await mod.default.fetch(upgrade('app://fpv-sim'), { ...e.env, DENYLIST: kv(['ip:203.0.113.7']) })).status).toBe(403);
    expect((await mod.default.fetch(upgrade('app://fpv-sim'), { ...e.env, DENYLIST: kv(['code:OTHER']) })).status).toBe(200);
  });
});
