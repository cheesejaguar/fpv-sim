// Cloudflare Worker + Durable Objects for FPV Sim live multiplayer.
//   GET /room/:CODE  (WebSocket upgrade)  -> Durable Object "Room" named by the code
//   GET /rooms                             -> public room directory (server browser), JSON, CORS
//   GET /leaderboard?map=&course=&class=   -> a global lap leaderboard, JSON, CORS
//   GET /leaderboard/entry/:id             -> one entry, its track, rank and board top 5 (share links), JSON, CORS
//   POST /leaderboard                      -> submit a lap (allowed origins only)
//   DELETE /leaderboard/:id                -> remove an entry (Authorization: Bearer ADMIN_TOKEN)
//   GET /health                            -> "ok"
// Each room is one Durable Object instance using the WebSocket Hibernation API, so idle rooms cost
// nothing: keepalive pings are answered by the runtime without waking the object, and a room's
// alarm runs only for public rooms (directory heartbeat) and for sockets that still owe a hello.
// Public rooms report to a single "Lobby" Durable Object when pilots join or leave (debounced) and on
// the heartbeat. Lap leaderboards live in one "Leaderboard" Durable Object (SQLite). The relay,
// directory and leaderboard logic live in roomCore.ts, lobbyCore.ts and leaderboardCore.ts
// (platform-independent, unit-tested).
import { decide, Entry, entryView, MAX_BODY_BYTES, parseQuery, parseSubmission, rankOf, ranked, SubmitLimiter, toPublic, trackKey } from './leaderboardCore';
import { HEARTBEAT_MS, LobbyCore, RoomListing } from './lobbyCore';
import { MAP_RE, MAX_MSG_BYTES, originAllowed, PING, PONG, RoomCore, Sock, SockState, validMeta } from './roomCore';

export interface Env {
  ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  LEADERBOARD: DurableObjectNamespace;
  /** comma-separated origins / patterns, see originPattern() in roomCore.ts */
  ALLOWED_ORIGINS: string;
  /** optional Workers Rate Limiting binding: room connections per client IP */
  RATE_LIMITER?: RateLimit;
  /** optional KV namespace: a key "code:ABCDE" or "ip:203.0.113.7" refuses that room / client */
  DENYLIST?: KVNamespace;
  /** optional secret: salt for the hashed client IPs (listed rooms per client, leaderboard entries) */
  IP_SALT?: string;
  /** optional secret: enables DELETE /leaderboard/:id (removal requests, moderation) */
  ADMIN_TOKEN?: string;
}

const CODE_RE = /^[A-Z0-9]{4,8}$/;
// (not exported: every export of a Worker's main module must be a handler or a Durable Object class)
const ROOMS_CACHE_MS = 3_000;   // GET /rooms: one lobby read per isolate per 3 s
const REPORT_URGENT_MS = 1_000; // join / leave reach the directory at once (at most 1/s)
const REPORT_MIN_MS = 5_000;    // other changes (map) at most every 5 s

function allowList(env: Env): string[] { return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean); }

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  return origin && originAllowed(origin, allowList(env))
    ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Cross-Origin-Resource-Policy': 'cross-origin' }
    : { 'Vary': 'Origin' };
}

const lobbyStub = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('global'));

/** Hashed client IP: lets the directory cap rooms per client without storing addresses. */
async function hashIp(ip: string, salt = 'fpv-sim-rooms'): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip}`));
  return [...new Uint8Array(d).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Any of these denylist keys present ("code:ABCDE", "ip:203.0.113.7")? */
async function denied(kv: KVNamespace, keys: string[]): Promise<boolean> {
  try {
    return (await Promise.all(keys.map((k) => kv.get(k, { cacheTtl: 60 })))).some((v) => v !== null);
  } catch { return false; } // the denylist is best-effort: never take the relay down with it
}

// GET /rooms is polled by every open server browser (10 s); keep one lobby read in flight per isolate
let roomsCache: { at: number; body: Promise<string> } | null = null;
function roomsJson(env: Env): Promise<string> {
  const now = Date.now();
  if (!roomsCache || now - roomsCache.at > ROOMS_CACHE_MS) {
    const body = lobbyStub(env).fetch('https://lobby/list').then((r) => { if (!r.ok) throw new Error(`lobby ${r.status}`); return r.text(); });
    const entry = { at: now, body };
    roomsCache = entry;
    body.catch(() => { if (roomsCache === entry) roomsCache = null; });
  }
  return roomsCache.body;
}

// ---------------------------------------------------------------------------------------------
// Leaderboard routes
const BOARD_CACHE_MS = 10_000; // GET /leaderboard: one board read per isolate per 10 s
const boardStub = (env: Env) => env.LEADERBOARD.get(env.LEADERBOARD.idFromName('global'));
const boardCache = new Map<string, { at: number; body: Promise<string> }>();
const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function boardJson(env: Env, q: { map: string; course: string; cls: string }): Promise<string> {
  const key = `${trackKey(q.map, q.course)}|${q.cls}`, now = Date.now();
  let hit = boardCache.get(key);
  if (!hit || now - hit.at > BOARD_CACHE_MS) {
    const qs = new URLSearchParams({ map: q.map, course: q.course, class: q.cls });
    const body = boardStub(env).fetch(`https://board/list?${qs}`).then((r) => { if (!r.ok) throw new Error(`board ${r.status}`); return r.text(); });
    const entry = { at: now, body };
    boardCache.set(key, (hit = entry));
    body.catch(() => { if (boardCache.get(key) === entry) boardCache.delete(key); });
  }
  return hit.body;
}

// GET /leaderboard/entry/:id (share links): the same 10 s isolate cache, dropped whenever a lap is posted
const ENTRY_CACHE_MAX = 500;
const entryCache = new Map<number, { at: number; body: Promise<{ status: number; text: string }> }>();
function entryJson(env: Env, id: number): Promise<{ status: number; text: string }> {
  const now = Date.now();
  let hit = entryCache.get(id);
  if (!hit || now - hit.at > BOARD_CACHE_MS) {
    if (entryCache.size >= ENTRY_CACHE_MAX) entryCache.clear();
    const body = boardStub(env).fetch(`https://board/entry?id=${id}`).then(async (r) => {
      if (!r.ok && r.status !== 404) throw new Error(`board ${r.status}`);
      return { status: r.status, text: await r.text() };
    });
    const entry = { at: now, body };
    entryCache.set(id, (hit = entry));
    body.catch(() => { if (entryCache.get(id) === entry) entryCache.delete(id); });
  }
  return hit.body;
}

/** Bearer token check that doesn't leak the token's length or prefix through timing. */
async function adminOk(req: Request, env: Env): Promise<boolean> {
  const token = env.ADMIN_TOKEN, got = /^Bearer (.+)$/.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (!token || !got) return false;
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([h(token), h(got)]);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function leaderboard(req: Request, env: Env, url: URL): Promise<Response> {
  const c = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...c, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
  const one = /^\/leaderboard\/entry\/(\d{1,12})$/.exec(url.pathname);
  if (one) {
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405, headers: c });
    try {
      const r = await entryJson(env, Number(one[1]));
      return json(r.text, r.status, { 'Cache-Control': r.status === 200 ? `public, max-age=${BOARD_CACHE_MS / 1000}` : 'no-store', ...c });
    } catch {
      return json({ error: 'leaderboard unavailable' }, 503, { 'Cache-Control': 'no-store', ...c });
    }
  }
  const del = /^\/leaderboard\/(\d{1,12})$/.exec(url.pathname);
  if (del) {
    if (req.method !== 'DELETE' || !(await adminOk(req, env))) return new Response('not found', { status: 404 });
    const r = await boardStub(env).fetch('https://board/delete', { method: 'POST', body: JSON.stringify({ id: Number(del[1]) }) });
    boardCache.clear(); entryCache.clear();
    return json(await r.text(), r.status, { 'Cache-Control': 'no-store' });
  }
  if (url.pathname !== '/leaderboard') return new Response('not found', { status: 404 });
  if (req.method === 'GET') {
    const q = parseQuery(url.searchParams);
    if (!q) return json({ entries: [], error: 'unknown board' }, 400, { 'Cache-Control': 'no-store', ...c });
    try {
      return json(await boardJson(env, q), 200, { 'Cache-Control': `public, max-age=${BOARD_CACHE_MS / 1000}`, ...c });
    } catch {
      return json({ entries: [], error: 'leaderboard unavailable' }, 503, { 'Cache-Control': 'no-store', ...c });
    }
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: c });
  const reply = (body: unknown, status: number) => json(body, status, { 'Cache-Control': 'no-store', ...c });
  if (!originAllowed(req.headers.get('Origin'), allowList(env))) return reply({ ok: false, error: 'origin not allowed' }, 403);
  if (Number(req.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) return reply({ ok: false, error: 'too big' }, 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return reply({ ok: false, error: 'too big' }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return reply({ ok: false, error: 'bad json' }, 400); }
  const p = parseSubmission(raw);
  if (!p.ok) return reply({ ok: false, error: p.error }, 400);
  const ip = req.headers.get('CF-Connecting-IP') ?? '';
  if (env.RATE_LIMITER && ip) {
    try { if (!(await env.RATE_LIMITER.limit({ key: `lb:${ip}` })).success) return reply({ ok: false, error: 'too many submissions, try again in a minute' }, 429); } catch { /* limiter unavailable: allow */ }
  }
  if (env.DENYLIST && ip && (await denied(env.DENYLIST, [`ip:${ip}`]))) return reply({ ok: false, error: 'forbidden' }, 403);
  // the board stores hashes only: of the client's random token (one entry per pilot per board) and
  // of its IP (entries per network), both salted
  const [owner, net] = await Promise.all([hashIp(`client|${p.sub.client}`, env.IP_SALT), ip ? hashIp(ip, env.IP_SALT) : Promise.resolve('')]);
  const r = await boardStub(env).fetch('https://board/submit', { method: 'POST', body: JSON.stringify({ raw, owner, net }) });
  const track = trackKey(p.sub.map, p.sub.course);
  for (const k of boardCache.keys()) if (k.startsWith(`${track}|`)) boardCache.delete(k);
  entryCache.clear(); // ranks on that board may have moved
  return reply(await r.text(), r.status);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/leaderboard' || url.pathname.startsWith('/leaderboard/')) return leaderboard(req, env, url);
    if (url.pathname === '/rooms') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req, env), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
      try {
        const body = await roomsJson(env);
        return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ROOMS_CACHE_MS / 1000}`, ...cors(req, env) } });
      } catch {
        return new Response(JSON.stringify({ rooms: [], error: 'directory unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(req, env) } });
      }
    }
    const m = /^\/room\/([A-Za-z0-9]{4,8})$/.exec(url.pathname);
    if (!m) return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!originAllowed(req.headers.get('Origin'), allowList(env))) return new Response('origin not allowed', { status: 403 });
    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return new Response('bad room code', { status: 400 });
    const ip = req.headers.get('CF-Connecting-IP') ?? '';
    if (env.RATE_LIMITER && ip) {
      try { if (!(await env.RATE_LIMITER.limit({ key: ip })).success) return new Response('too many connections', { status: 429 }); } catch { /* limiter unavailable: allow */ }
    }
    if (env.DENYLIST && (await denied(env.DENYLIST, [`code:${code}`, ...(ip ? [`ip:${ip}`] : [])]))) return new Response('forbidden', { status: 403 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    // the object can't recover its own name from the id, so tell it (it reports it to the lobby);
    // both headers are always overwritten here, so a client can't supply its own
    const fwd = new Request(req, { headers: new Headers(req.headers) });
    fwd.headers.set('X-Room-Code', code);
    fwd.headers.set('X-Client-Hash', ip ? await hashIp(ip, env.IP_SALT) : '');
    return stub.fetch(fwd);
  },
};

export class Room implements DurableObject {
  private core = new RoomCore();
  private ready: Promise<void>;
  private code: string | null = null;
  private codeSaved = false;
  private listed = false;
  private lastReport = 0;              // ms epoch of the last directory report
  private reportDue = 0;               // a debounced report is owed at this time (0: none)
  private alarmAt: number | null = null;
  private wiped = true;                // storage is already empty (nothing to delete)

  constructor(private state: DurableObjectState, private env: Env) {
    // pings never wake (or bill) a hibernated room: the runtime answers them
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get<unknown>(['map', 'code', 'meta']);
      const map = saved.get('map'), code = saved.get('code'), meta = saved.get('meta');
      if (typeof map === 'string' && MAP_RE.test(map)) this.core.map = map;
      if (typeof code === 'string' && CODE_RE.test(code)) { this.code = code; this.codeSaved = true; }
      if (validMeta(meta)) { this.core.meta = meta; this.listed = meta.public; } // may be listed: remove it when it empties
      this.alarmAt = await this.state.storage.getAlarm();
      this.wiped = saved.size === 0 && this.alarmAt === null;
      // woken from hibernation: rebuild the roster from the sockets' attachments (same ids, no join
      // broadcast, no second welcome), so pilots never notice the room slept
      for (const ws of this.state.getWebSockets()) this.core.restore(ws as unknown as Sock, ws.deserializeAttachment());
    });
  }

  async fetch(req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    await this.accept(server, req.headers.get('X-Room-Code'), req.headers.get('X-Client-Hash'));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A new connection (separate from fetch() so tests can drive it without a WebSocketPair). */
  async accept(server: WebSocket, code: string | null, ipHash: string | null): Promise<void> {
    await this.ready;
    if (code && CODE_RE.test(code) && (!this.codeSaved || this.code !== code)) {
      this.code = code; this.codeSaved = true; this.wiped = false;
      await this.state.storage.put('code', code);
    }
    this.state.acceptWebSocket(server);
    const st: SockState = { at: Date.now(), ...(ipHash ? { ip: ipHash } : {}) };
    server.serializeAttachment(st);
    // refused (room full / too many sockets) -> already closed with 4001 / 1013
    if (this.core.open(server as unknown as Sock, st.at, st.ip)) await this.schedule();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    const sock = ws as unknown as Sock;
    if (typeof message !== 'string') {
      // the protocol is text only; oversized binary ends the connection like oversized text
      if (message.byteLength > MAX_MSG_BYTES) await this.settle(this.core.drop(sock, 1009, 'message too big') ? 'roster' : null);
      return;
    }
    const res = this.core.message(sock, message); // size-checked first: nothing oversized is parsed or stored
    // only an accepted hello is stored, so hibernation can restore the pilot (repeated hellos cost
    // nothing). Every socket's attachment carries the room's next id too, so a restored room never
    // hands out the id of a pilot who already left.
    if (res.joined) for (const w of this.state.getWebSockets()) { const s = this.core.state(w as unknown as Sock); if (s) w.serializeAttachment(s); }
    if (res.mapChanged || res.metaChanged) {
      const puts: Record<string, unknown> = {};
      if (res.mapChanged) puts.map = res.mapChanged;
      if (res.metaChanged) puts.meta = this.core.meta;
      await this.state.storage.put(puts);
      this.wiped = false;
    }
    if (res.joined || res.left) await this.settle('roster');
    else if (res.mapChanged) await this.settle('map');
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ready;
    const left = this.core.close(ws as unknown as Sock);
    try { ws.close(); } catch { /* already closed */ }
    await this.settle(left ? 'roster' : null);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.ready;
    await this.settle(this.core.close(ws as unknown as Sock) ? 'roster' : null);
  }

  /** Hello deadlines, debounced directory reports and the public-room heartbeat share one alarm. */
  async alarm(): Promise<void> {
    await this.ready;
    this.alarmAt = null;
    this.core.sweep(Date.now()); // sockets that never said hello
    if (this.core.size === 0) { await this.wipe(); return; }
    const now = Date.now();
    const heartbeat = this.core.meta?.public && now - this.lastReport >= HEARTBEAT_MS - 100;
    if ((this.reportDue && now >= this.reportDue - 100) || heartbeat) await this.report(0);
    await this.schedule();
  }

  /** After a change: wipe an empty room, else tell the directory (debounced) and re-arm the alarm. */
  private async settle(kind: 'roster' | 'map' | null): Promise<void> {
    if (this.core.size === 0) { await this.wipe(); return; }
    if (kind) await this.report(kind === 'roster' ? REPORT_URGENT_MS : REPORT_MIN_MS);
    await this.schedule();
  }

  /** Tell the lobby about this room (or that it is gone), at most once per minGap ms; a report that
   *  comes too soon is owed and sent by the alarm. Private rooms never talk to the lobby. */
  private async report(minGap: number): Promise<void> {
    if (!this.code || !(this.core.meta?.public || this.listed)) { this.reportDue = 0; return; }
    const now = Date.now();
    if (now - this.lastReport < minGap) { const due = this.lastReport + minGap; this.reportDue = this.reportDue ? Math.min(this.reportDue, due) : due; return; }
    this.reportDue = 0; this.lastReport = now;
    const entry = this.core.listing(this.code);
    try {
      if (entry) {
        await lobbyStub(this.env).fetch('https://lobby/upsert', { method: 'POST', body: JSON.stringify(entry) });
        this.listed = true;
      } else if (this.listed) {
        await lobbyStub(this.env).fetch('https://lobby/remove', { method: 'POST', body: JSON.stringify({ code: this.code }) });
        this.listed = false;
      }
    } catch { /* the lobby is best-effort; the heartbeat retries */ }
  }

  private async schedule(): Promise<void> {
    let at = Infinity;
    const hello = this.core.helloDeadline();
    if (hello !== null) at = Math.min(at, hello);
    if (this.reportDue) at = Math.min(at, this.reportDue);
    if (this.code && this.core.meta?.public && this.core.players().length) at = Math.min(at, this.lastReport + HEARTBEAT_MS);
    // an earlier alarm than needed just fires and re-arms: only move it earlier (fewer storage writes)
    if (at === Infinity || (this.alarmAt !== null && this.alarmAt <= at)) return;
    this.alarmAt = at;
    this.wiped = false;
    await this.state.storage.setAlarm(at);
  }

  /** The room emptied: delist it and delete everything it stored. */
  private async wipe(): Promise<void> {
    if (this.listed && this.code) {
      try { await lobbyStub(this.env).fetch('https://lobby/remove', { method: 'POST', body: JSON.stringify({ code: this.code }) }); } catch { /* expires anyway */ }
    }
    this.core.reset();
    this.listed = false; this.reportDue = 0; this.lastReport = 0;
    if (this.wiped) return;
    this.wiped = true; this.codeSaved = false; this.alarmAt = null;
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }
}

/** Single global directory of public rooms. Kept in memory and mirrored to storage, because an idle
 *  object can be evicted between room heartbeats. The copy is written only when a room is added or
 *  removed, not on heartbeats; after an eviction, rooms whose stored timestamp has expired reappear
 *  on their next heartbeat (<= HEARTBEAT_MS). */
export class Lobby implements DurableObject {
  private core = new LobbyCore();
  private ready: Promise<void>;
  constructor(private state: DurableObjectState, _env: Env) {
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get<RoomListing[]>('rooms');
      if (Array.isArray(saved)) this.core.restore(saved);
    });
  }

  async fetch(req: Request): Promise<Response> {
    await this.ready;
    const path = new URL(req.url).pathname;
    if (path === '/list') return new Response(JSON.stringify({ rooms: this.core.list(), now: Date.now() }), { headers: { 'Content-Type': 'application/json' } });
    if (req.method !== 'POST') return new Response('bad request', { status: 400 });
    let body: any;
    try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
    let changed = false, reply = 'ok', status = 200;
    if (path === '/upsert') {
      const r = this.core.upsert(body);
      changed = r === 'added';
      if (!r) { reply = 'refused'; status = 429; }
    } else if (path === '/remove' && typeof body?.code === 'string') changed = this.core.remove(body.code);
    else return new Response('not found', { status: 404 });
    if (changed) { this.core.prune(); await this.state.storage.put('rooms', this.core.snapshot()); }
    return new Response(reply, { status });
  }
}

/** The minimal SQL surface used (a SQLite-backed Durable Object's `storage.sql`; tests pass node:sqlite). */
export interface Sql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS laps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map TEXT NOT NULL, course TEXT NOT NULL, cls TEXT NOT NULL,
    owner TEXT NOT NULL, net TEXT NOT NULL,
    initials TEXT NOT NULL, lap_ms INTEGER NOT NULL, splits TEXT NOT NULL, summary TEXT NOT NULL, at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS laps_track ON laps (map, course, lap_ms)',
];

/**
 * Every lap leaderboard, in one SQLite-backed object: a board holds at most BOARD_SIZE entries per
 * track and class and each pilot (hashed client token) at most once, so the table stays small
 * (tracks x classes x 100 rows). Reached only through the Worker, which validates and hashes first;
 * submissions are checked again here.
 */
export class Leaderboard implements DurableObject {
  private sql: Sql;
  private limiter = new SubmitLimiter();
  constructor(state: DurableObjectState, _env: Env) {
    this.sql = state.storage.sql as unknown as Sql;
    for (const q of SCHEMA) this.sql.exec(q);
  }

  private track(map: string, course: string): Entry[] {
    return this.sql.exec('SELECT id, map, course, cls, owner, net, initials, lap_ms, splits, summary, at FROM laps WHERE map = ? AND course = ?', map, course).toArray().map((r) => ({
      id: Number(r.id), map: String(r.map), course: String(r.course), cls: String(r.cls), owner: String(r.owner), net: String(r.net),
      initials: String(r.initials), lapMs: Number(r.lap_ms), splitsMs: JSON.parse(String(r.splits)) as number[], summary: String(r.summary), at: Number(r.at),
    }));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/list') {
      const q = parseQuery(url.searchParams);
      if (!q) return out({ entries: [], error: 'unknown board' }, 400);
      return out({ map: q.map, course: q.course, class: q.cls, entries: ranked(this.track(q.map, q.course), q.cls).map(toPublic), now: Date.now() });
    }
    if (url.pathname === '/entry') {
      const id = Number(url.searchParams.get('id'));
      const at = Number.isInteger(id) && id > 0 ? this.sql.exec('SELECT map, course FROM laps WHERE id = ?', id).toArray()[0] : undefined;
      const view = at ? entryView(this.track(String(at.map), String(at.course)), id) : null;
      return view ? out(view) : out({ error: 'not found' }, 404);
    }
    if (req.method !== 'POST') return out({ ok: false, error: 'bad request' }, 400);
    let body: any;
    try { body = await req.json(); } catch { return out({ ok: false, error: 'bad json' }, 400); }
    if (url.pathname === '/delete') {
      const id = Number(body?.id);
      const n = Number.isInteger(id) ? this.sql.exec('DELETE FROM laps WHERE id = ? RETURNING id', id).toArray().length : 0;
      return out({ ok: n > 0, deleted: n }, n ? 200 : 404);
    }
    if (url.pathname !== '/submit') return out({ ok: false, error: 'not found' }, 404);
    const p = parseSubmission(body?.raw);
    const owner = typeof body?.owner === 'string' ? body.owner : '', net = typeof body?.net === 'string' ? body.net : '';
    if (!p.ok) return out({ ok: false, error: p.error }, 400);
    if (!owner) return out({ ok: false, error: 'bad request' }, 400);
    if (net && !this.limiter.take(net)) return out({ ok: false, error: 'too many submissions, try again later' }, 429);
    const s = p.sub, now = Date.now();
    const rows = this.track(s.map, s.course), board = rows.filter((r) => r.cls === s.cls);
    const d = decide(board, s, owner, net, now);
    if (d.kind === 'network') return out({ ok: false, error: 'too many entries from your network on this board' }, 429);
    if (d.kind === 'unranked') return out({ ok: true, stored: false, reason: 'unranked', entries: ranked(board, s.cls).map(toPublic) });
    if (d.kind === 'slower') {
      const list = ranked(board, s.cls);
      return out({ ok: true, stored: false, reason: 'slower', id: d.best.id, rank: rankOf(list, d.best.id), entries: list.map(toPublic) });
    }
    // (no await from here on: the writes and the read-back are one atomic step for the object)
    const values = [s.initials, s.lapMs, JSON.stringify(s.splitsMs), s.summary, now, net];
    let id: number;
    if (d.update !== null) {
      this.sql.exec('UPDATE laps SET initials = ?, lap_ms = ?, splits = ?, summary = ?, at = ?, net = ? WHERE id = ?', ...values, d.update);
      id = d.update;
    } else {
      id = Number(this.sql.exec('INSERT INTO laps (initials, lap_ms, splits, summary, at, net, map, course, cls, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        ...values, s.map, s.course, s.cls, owner).toArray()[0].id);
    }
    for (const e of d.evict) this.sql.exec('DELETE FROM laps WHERE id = ?', e);
    const list = ranked(this.track(s.map, s.course), s.cls);
    return out({ ok: true, stored: true, id, rank: rankOf(list, id), entries: list.map(toPublic) });
  }
}
