// Cloudflare Worker + Durable Object for FPV Sim live multiplayer rooms.
//   GET /room/:CODE  (WebSocket upgrade)  -> Durable Object "Room" named by the code
//   GET /health                            -> "ok"
// Each room is one Durable Object instance using the WebSocket Hibernation API, so idle rooms cost
// nothing. The relay logic lives in roomCore.ts (platform-independent, unit-tested).
import { MAP_RE, originAllowed, RoomCore, Sock } from './roomCore';

export interface Env {
  ROOMS: DurableObjectNamespace;
  ALLOWED_ORIGINS: string; // comma-separated; "https://*.vercel.app" style wildcards allowed
}

const CODE_RE = /^[A-Z0-9]{4,8}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    const m = /^\/room\/([A-Za-z0-9]{4,8})$/.exec(url.pathname);
    if (!m) return new Response('not found', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const allow = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!originAllowed(req.headers.get('Origin'), allow)) return new Response('origin not allowed', { status: 403 });
    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return new Response('bad room code', { status: 400 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    return stub.fetch(req);
  },
};

export class Room implements DurableObject {
  private core: RoomCore;
  private ready: Promise<void>;

  constructor(private state: DurableObjectState, _env: Env) {
    this.core = new RoomCore();
    // After hibernation the in-memory roster is gone: sockets that are still open get re-registered
    // (as anonymous; their next "hello" is not needed because clients re-send it on reconnect).
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const map = await this.state.storage.get<string>('map');
      if (map && MAP_RE.test(map)) this.core.map = map;
      for (const ws of this.state.getWebSockets()) {
        this.core.open(ws as unknown as Sock);
        const info = ws.deserializeAttachment() as { hello?: string } | null;
        if (info?.hello) this.core.message(ws as unknown as Sock, info.hello);
      }
    });
  }

  async fetch(_req: Request): Promise<Response> {
    await this.ready;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    this.core.open(server as unknown as Sock); // closes it with 4001 when the room is full
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    if (typeof message !== 'string') return;
    // keep the hello so the player can be restored after the object hibernates
    if (message.startsWith('{"t":"hello"')) ws.serializeAttachment({ hello: message });
    const changedMap = this.core.message(ws as unknown as Sock, message);
    if (changedMap) await this.state.storage.put('map', changedMap);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ready;
    this.core.close(ws as unknown as Sock);
    try { ws.close(); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.ready;
    this.core.close(ws as unknown as Sock);
  }
}
