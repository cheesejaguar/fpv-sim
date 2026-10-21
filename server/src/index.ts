// Cloudflare Worker + Durable Objects for FPV Sim live multiplayer.
//   GET /room/:CODE  (WebSocket upgrade)  -> Durable Object "Room" named by the code
//   GET /rooms                             -> public room directory (server browser), JSON, CORS
//   GET /health                            -> "ok"
// Each room is one Durable Object instance using the WebSocket Hibernation API, so idle rooms cost
// nothing. Public rooms report to a single "Lobby" Durable Object on every roster / map change and
// on a heartbeat alarm while occupied. The relay and directory logic live in roomCore.ts and
// lobbyCore.ts (platform-independent, unit-tested).
import { HEARTBEAT_MS, LobbyCore, RoomListing } from './lobbyCore';
import { MAP_RE, originAllowed, RoomCore, RoomMeta, Sock } from './roomCore';

export interface Env {
  ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
  ALLOWED_ORIGINS: string; // comma-separated; "https://*.vercel.app" style wildcards allowed
}

const CODE_RE = /^[A-Z0-9]{4,8}$/;

function allowList(env: Env): string[] { return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean); }

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  return origin && originAllowed(origin, allowList(env))
    ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Cross-Origin-Resource-Policy': 'cross-origin' }
    : { 'Vary': 'Origin' };
}

const lobbyStub = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('global'));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/rooms') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors(req, env), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
      if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
      const r = await lobbyStub(env).fetch('https://lobby/list');
      return new Response(r.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(req, env) } });
    }
    const m = /^\/room\/([A-Za-z0-9]{4,8})$/.exec(url.pathname);
    if (!m) return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!originAllowed(req.headers.get('Origin'), allowList(env))) return new Response('origin not allowed', { status: 403 });
    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return new Response('bad room code', { status: 400 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    // the object can't recover its own name from the id, so tell it (it reports it to the lobby)
    const fwd = new Request(req, { headers: new Headers(req.headers) });
    fwd.headers.set('X-Room-Code', code);
    return stub.fetch(fwd);
  },
};

export class Room implements DurableObject {
  private core: RoomCore;
  private ready: Promise<void>;
  private code: string | null = null;
  private listed = false;

  constructor(private state: DurableObjectState, private env: Env) {
    this.core = new RoomCore();
    // After hibernation the in-memory roster is gone: sockets that are still open get re-registered
    // (as anonymous; their next "hello" is not needed because clients re-send it on reconnect).
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const [map, code, meta] = await Promise.all([
        this.state.storage.get<string>('map'), this.state.storage.get<string>('code'), this.state.storage.get<RoomMeta>('meta'),
      ]);
      if (map && MAP_RE.test(map)) this.core.map = map;
      if (code && CODE_RE.test(code)) this.code = code;
      if (meta) this.core.meta = meta;
      for (const ws of this.state.getWebSockets()) {
        this.core.open(ws as unknown as Sock);
        const info = ws.deserializeAttachment() as { hello?: string } | null;
        if (info?.hello) this.core.message(ws as unknown as Sock, info.hello);
      }
    });
  }

  async fetch(req: Request): Promise<Response> {
    await this.ready;
    const code = req.headers.get('X-Room-Code');
    if (!this.code && code && CODE_RE.test(code)) { this.code = code; await this.state.storage.put('code', code); }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    this.core.open(server as unknown as Sock); // closes it with 4001 when the room is full
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    if (typeof message !== 'string') return;
    const isHello = message.startsWith('{"t":"hello"');
    // keep the hello so the player can be restored after the object hibernates
    if (isHello) ws.serializeAttachment({ hello: message });
    const hadMeta = !!this.core.meta;
    const changedMap = this.core.message(ws as unknown as Sock, message);
    if (changedMap) await this.state.storage.put('map', changedMap);
    if (!hadMeta && this.core.meta) await this.state.storage.put('meta', this.core.meta);
    if (isHello || changedMap) await this.report();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ready;
    this.core.close(ws as unknown as Sock);
    try { ws.close(); } catch { /* already closed */ }
    await this.report();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.ready;
    this.core.close(ws as unknown as Sock);
    await this.report();
  }

  /** Heartbeat while occupied: keeps a public room listed in the server browser. */
  async alarm(): Promise<void> {
    await this.ready;
    await this.report();
  }

  /** Tell the lobby about this room (or that it is gone), and keep the heartbeat alarm running. */
  private async report(): Promise<void> {
    if (!this.code) return;
    const entry = this.core.listing(this.code);
    try {
      if (entry) {
        await lobbyStub(this.env).fetch('https://lobby/upsert', { method: 'POST', body: JSON.stringify(entry) });
        this.listed = true;
      } else if (this.listed || this.core.meta?.public) {
        await lobbyStub(this.env).fetch('https://lobby/remove', { method: 'POST', body: JSON.stringify({ code: this.code }) });
        this.listed = false;
      }
    } catch { /* the lobby is best-effort; the heartbeat retries */ }
    if (this.core.size > 0) await this.state.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    else {
      await this.state.storage.deleteAlarm();
      // empty room: forget its name / visibility so a new host can set them
      this.core.meta = null;
      await this.state.storage.delete('meta');
    }
  }
}

/** Single global directory of public rooms. Kept in memory and mirrored to storage, because an idle
 *  object can be evicted between room heartbeats (the list would read empty until they re-report). */
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
    let changed = false;
    if (path === '/upsert') changed = this.core.upsert(body);
    else if (path === '/remove' && typeof body?.code === 'string') changed = this.core.remove(body.code);
    else return new Response('not found', { status: 404 });
    if (changed) { this.core.prune(); await this.state.storage.put('rooms', this.core.snapshot()); }
    return new Response(changed ? 'ok' : 'unchanged');
  }
}
