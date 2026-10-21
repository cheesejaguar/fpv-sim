// Cloudflare Worker + Durable Objects for FPV Sim live multiplayer.
//   GET /room/:CODE  (WebSocket upgrade)  -> Durable Object "Room" named by the code
//   GET /rooms                             -> public room directory (server browser), JSON, CORS
//   GET /health                            -> "ok"
// Each room is one Durable Object instance using the WebSocket Hibernation API, so idle rooms cost
// nothing: keepalive pings are answered by the runtime without waking the object, and a room's
// alarm runs only for public rooms (directory heartbeat) and for sockets that still owe a hello.
// Public rooms report to a single "Lobby" Durable Object when pilots join or leave (debounced) and on
// the heartbeat. The relay and directory logic live in roomCore.ts and lobbyCore.ts
// (platform-independent, unit-tested).
import { HEARTBEAT_MS, LobbyCore, RoomListing } from './lobbyCore';
import { MAP_RE, MAX_MSG_BYTES, originAllowed, PING, PONG, RoomCore, Sock, SockState, validMeta } from './roomCore';

export interface Env {
  ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  /** comma-separated origins / patterns, see originPattern() in roomCore.ts */
  ALLOWED_ORIGINS: string;
  /** optional Workers Rate Limiting binding: room connections per client IP */
  RATE_LIMITER?: RateLimit;
  /** optional KV namespace: a key "code:ABCDE" or "ip:203.0.113.7" refuses that room / client */
  DENYLIST?: KVNamespace;
  /** optional secret: salt for the hashed client IPs (listed rooms per client) */
  IP_SALT?: string;
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

async function denied(kv: KVNamespace, code: string, ip: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([kv.get(`code:${code}`, { cacheTtl: 60 }), ip ? kv.get(`ip:${ip}`, { cacheTtl: 60 }) : null]);
    return a !== null || b !== null;
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
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
    if (env.DENYLIST && (await denied(env.DENYLIST, code, ip))) return new Response('forbidden', { status: 403 });
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
