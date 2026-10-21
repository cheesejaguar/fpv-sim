// Platform-independent multiplayer room logic (relay + roster + shared map), used by the Cloudflare
// Durable Object in index.ts and unit-tested directly. The server is a relay: each pilot's own
// browser runs the full simulation (physics + Betaflight); peers only exchange compact pose updates.

export const MAX_PLAYERS = 8;
export const MAX_MSG_BYTES = 1024;
export const RATE_LIMIT_PER_S = 40;   // client sends 30 Hz state + occasional control messages
export const NAME_MAX = 20;

export interface PlayerInfo { id: number; name: string; color: string; frame: string }

/** Minimal socket surface the core needs (a Cloudflare WebSocket satisfies it). */
export interface Sock { send(data: string): void; close(code?: number, reason?: string): void }

interface Conn { sock: Sock; info: PlayerInfo | null; tokens: number; lastRefill: number }

// ---------- message validation ----------
const num = (v: unknown, lim = 1e7): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
const vec = (v: unknown, n: number, lim = 1e7): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => num(x, lim));
export const MAP_RE = /^[a-z0-9_-]{1,24}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const FRAME_RE = /^[a-z0-9_-]{1,12}$/i;

export function sanitizeName(s: unknown): string {
  const t = typeof s === 'string' ? s : '';
  // printable characters only, collapse whitespace, trim to NAME_MAX
  const clean = t.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return clean || 'Pilot';
}

export class RoomCore {
  private conns = new Map<Sock, Conn>();
  private nextId = 1;
  map: string | null = null;
  constructor(private now: () => number = () => Date.now(), initialMap: string | null = null) { this.map = initialMap; }

  get size() { return this.conns.size; }
  players(): PlayerInfo[] { return [...this.conns.values()].flatMap((c) => (c.info ? [c.info] : [])); }

  /** A socket connected. Returns false (and closes it) if the room is full. */
  open(sock: Sock): boolean {
    if (this.conns.size >= MAX_PLAYERS) { sock.close(4001, 'room full'); return false; }
    this.conns.set(sock, { sock, info: null, tokens: RATE_LIMIT_PER_S, lastRefill: this.now() });
    return true;
  }

  close(sock: Sock): void {
    const c = this.conns.get(sock);
    if (!c) return;
    this.conns.delete(sock);
    if (c.info) this.broadcast({ t: 'leave', id: c.info.id }, sock);
  }

  /** Handle one text message. Returns the map id if it changed (so the caller can persist it). */
  message(sock: Sock, raw: string): string | null {
    const c = this.conns.get(sock);
    if (!c) return null;
    if (raw.length > MAX_MSG_BYTES) { this.err(sock, 'message too large'); return null; }
    // token bucket rate limit
    const t = this.now();
    c.tokens = Math.min(RATE_LIMIT_PER_S, c.tokens + ((t - c.lastRefill) / 1000) * RATE_LIMIT_PER_S);
    c.lastRefill = t;
    if (c.tokens < 1) return null; // silently drop excess (state is superseded by the next one anyway)
    c.tokens -= 1;
    let m: any;
    try { m = JSON.parse(raw); } catch { this.err(sock, 'bad json'); return null; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') { this.err(sock, 'bad message'); return null; }

    if (m.t === 'hello') {
      if (c.info) return null;
      const info: PlayerInfo = {
        id: this.nextId++,
        name: sanitizeName(m.name),
        color: typeof m.color === 'string' && COLOR_RE.test(m.color) ? m.color.toLowerCase() : '#39b6ff',
        frame: typeof m.frame === 'string' && FRAME_RE.test(m.frame) ? m.frame : '5in',
      };
      let changed: string | null = null;
      if (!this.map && typeof m.map === 'string' && MAP_RE.test(m.map)) { this.map = m.map; changed = this.map; }
      c.info = info;
      this.send(sock, { t: 'welcome', id: info.id, map: this.map, players: this.players().filter((p) => p.id !== info.id) });
      this.broadcast({ t: 'join', player: info }, sock);
      return changed;
    }
    if (!c.info) { this.err(sock, 'say hello first'); return null; }
    const id = c.info.id;
    switch (m.t) {
      case 's': // pose: position (m), quaternion, mean rpm, armed
        if (!vec(m.p, 3, 1e5) || !vec(m.q, 4, 2) || !num(m.r, 1e6) || (m.a !== 0 && m.a !== 1)) return null;
        this.broadcast({ t: 's', id, p: m.p, q: m.q, r: m.r, a: m.a }, sock);
        return null;
      case 'map':
        if (typeof m.map !== 'string' || !MAP_RE.test(m.map) || m.map === this.map) return null;
        this.map = m.map;
        this.broadcast({ t: 'map', map: this.map, by: id }, null);
        return this.map;
      case 'lap':
        if (!num(m.lap, 1e6) || !num(m.last, 1e6) || !num(m.best, 1e7)) return null;
        this.broadcast({ t: 'lap', id, lap: m.lap, last: m.last, best: m.best }, sock);
        return null;
      case 'ping':
        if (!num(m.c, 1e15)) return null;
        this.send(sock, { t: 'pong', c: m.c });
        return null;
      default:
        this.err(sock, 'unknown type');
        return null;
    }
  }

  private send(sock: Sock, msg: object) { try { sock.send(JSON.stringify(msg)); } catch { /* socket gone */ } }
  private err(sock: Sock, msg: string) { this.send(sock, { t: 'error', msg }); }
  private broadcast(msg: object, except: Sock | null) {
    const s = JSON.stringify(msg);
    for (const c of this.conns.values()) if (c.sock !== except && c.info) { try { c.sock.send(s); } catch { /* ignore */ } }
  }
}

/** Origin allow-list check; entries may be exact origins or "https://*.suffix" wildcards. */
export function originAllowed(origin: string | null, allowList: string[]): boolean {
  if (!origin) return false;
  for (const a of allowList) {
    if (a === origin) return true;
    const m = /^(https?):\/\/\*\.(.+)$/.exec(a);
    if (m && origin.startsWith(m[1] + '://') && origin.endsWith('.' + m[2])) return true;
    if (a.endsWith(':*') && origin.startsWith(a.slice(0, -1))) return true; // http://localhost:*
  }
  return false;
}
