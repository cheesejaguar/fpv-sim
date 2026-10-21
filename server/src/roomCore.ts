// Platform-independent multiplayer room logic (relay + roster + shared map), used by the Cloudflare
// Durable Object in index.ts and unit-tested directly. The server is a relay: each pilot's own
// browser runs the full simulation (physics + Betaflight); peers only exchange compact pose updates.
import { cleanDisplayName } from './sanitize';

export const MAX_PLAYERS = 8;          // pilots who said hello
export const MAX_SOCKETS = 12;         // raw connections, including ones that have not said hello yet
export const MAX_MSG_BYTES = 1024;
export const RATE_LIMIT_PER_S = 40;    // client sends 30 Hz state + occasional control messages
export const NAME_MAX = 20;
export const ROOM_NAME_MAX = 32;
export const HELLO_TIMEOUT_MS = 10_000;
export const MAP_COOLDOWN_MS = 5_000;  // at most one map change per room per 5 s
/** Room protocol version. v2: per-motor rpm, sender clock + paused flag in poses, runtime ping. */
export const PROTOCOL = 2;
// Answered by the runtime itself (DurableObjectState.setWebSocketAutoResponse), so keepalive pings
// never wake a hibernated room. Fixed strings: the client times the round trip itself.
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';

/** v: the pilot's protocol version (1 = clients from before versions existed). */
export interface PlayerInfo { id: number; name: string; color: string; frame: string; v: number }

/** Set by the room's first pilot (the host): display name and whether it is listed in the browser.
 *  owner: hashed client IP of the host (caps listed rooms per client; never shown). */
export interface RoomMeta { name: string; public: boolean; host: string; owner?: string }

/** A socket's hibernation attachment: enough to rebuild the roster silently after the room wakes. */
export interface SockState { at: number; ip?: string; info?: PlayerInfo; nextId?: number }

/** What one message changed, so the Durable Object persists / reports only real changes. */
export interface MsgResult { joined: PlayerInfo | null; left: PlayerInfo | null; mapChanged: string | null; metaChanged: boolean }

/** Minimal socket surface the core needs (a Cloudflare WebSocket satisfies it). */
export interface Sock { send(data: string): void; close(code?: number, reason?: string): void }

interface Conn { sock: Sock; info: PlayerInfo | null; tokens: number; lastRefill: number; at: number; ip: string }

// ---------- message validation ----------
const num = (v: unknown, lim = 1e7): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
const vec = (v: unknown, n: number, lim = 1e7): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => num(x, lim));
// never JS prototype member names, never a pilot's own from-disk map ("local-…", not shareable)
export const MAP_RE = /^(?!(?:__proto__|constructor|prototype)$)(?!local-)[a-z0-9_-]{1,24}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const FRAME_RE = /^[a-z0-9_-]{1,12}$/i;
const OWNER_RE = /^[0-9a-f]{8,64}$/;

export function sanitizeName(s: unknown): string { return cleanDisplayName(s, NAME_MAX) || 'Pilot'; }
export function sanitizeRoomName(s: unknown): string { return cleanDisplayName(s, ROOM_NAME_MAX); }

const validInfo = (i: any): i is PlayerInfo => !!i && Number.isInteger(i.id) && i.id > 0 && typeof i.name === 'string' && typeof i.color === 'string' && typeof i.frame === 'string';
export const validMeta = (m: any): m is RoomMeta => !!m && typeof m.name === 'string' && typeof m.public === 'boolean' && typeof m.host === 'string';

const noChange = (): MsgResult => ({ joined: null, left: null, mapChanged: null, metaChanged: false });

export class RoomCore {
  private conns = new Map<Sock, Conn>();
  private nextIdV = 1;
  private lastMapChange = -Infinity;
  map: string | null = null;
  meta: RoomMeta | null = null;
  constructor(private now: () => number = () => Date.now(), initialMap: string | null = null) { this.map = initialMap; }

  /** raw sockets (hello'd or not) */
  get size() { return this.conns.size; }
  get nextId() { return this.nextIdV; }

  /** Directory entry for the server browser, or null if the room is private or empty. */
  listing(code: string): { code: string; name: string; map: string | null; players: number; max: number; host: string; owner?: string } | null {
    const n = this.players().length;
    if (!this.meta?.public || n === 0) return null;
    return { code, name: this.meta.name, map: this.map, players: n, max: MAX_PLAYERS, host: this.meta.host, ...(this.meta.owner ? { owner: this.meta.owner } : {}) };
  }
  players(): PlayerInfo[] { return [...this.conns.values()].flatMap((c) => (c.info ? [c.info] : [])); }

  /** A socket connected. Returns false (and closes it) if the room is full or has too many sockets. */
  open(sock: Sock, at = this.now(), ip = ''): boolean {
    if (this.players().length >= MAX_PLAYERS) { this.bye(sock, 4001, 'room full'); return false; }
    // half-open connections that never say hello are swept after HELLO_TIMEOUT_MS: "try again later"
    if (this.conns.size >= MAX_SOCKETS) { this.bye(sock, 1013, 'room busy'); return false; }
    this.conns.set(sock, { sock, info: null, tokens: RATE_LIMIT_PER_S, lastRefill: this.now(), at, ip: OWNER_RE.test(ip) ? ip : '' });
    return true;
  }

  /** Re-register a socket that survived hibernation, from its attachment: same id, no join broadcast,
   *  no second welcome (the pilot never noticed the room went to sleep). */
  restore(sock: Sock, st: unknown): void {
    const s = (st && typeof st === 'object' ? st : {}) as Partial<SockState>;
    const info = validInfo(s.info) ? { ...s.info, v: Number.isInteger(s.info.v) ? s.info.v : 1 } : null;
    this.conns.set(sock, { sock, info, tokens: RATE_LIMIT_PER_S, lastRefill: this.now(), at: num(s.at, 1e15) ? s.at : this.now(), ip: typeof s.ip === 'string' && OWNER_RE.test(s.ip) ? s.ip : '' });
    if (info) this.nextIdV = Math.max(this.nextIdV, info.id + 1);
    if (Number.isInteger(s.nextId)) this.nextIdV = Math.max(this.nextIdV, s.nextId!);
  }

  /** Attachment to store for a socket (call after its hello was accepted). */
  state(sock: Sock): SockState | null {
    const c = this.conns.get(sock);
    return c ? { at: c.at, ...(c.ip ? { ip: c.ip } : {}), ...(c.info ? { info: c.info } : {}), nextId: this.nextIdV } : null;
  }

  /** Socket gone. Returns the pilot who left (null if it never said hello or was unknown). */
  close(sock: Sock): PlayerInfo | null {
    const c = this.conns.get(sock);
    if (!c) return null;
    this.conns.delete(sock);
    if (c.info) this.broadcast({ t: 'leave', id: c.info.id }, sock);
    return c.info;
  }

  /** Close a socket from our side (oversized message, room full at hello, hello timeout). tell: send
   *  a last {t:'bye'} first, so the client can act at once (the close handshake itself can take
   *  seconds to reach its onclose); never for abuse such as oversized messages. */
  drop(sock: Sock, code: number, reason: string, tell = false): PlayerInfo | null {
    const left = this.close(sock);
    if (tell) this.bye(sock, code, reason);
    else try { sock.close(code, reason); } catch { /* already closed */ }
    return left;
  }
  private bye(sock: Sock, code: number, reason: string) {
    this.send(sock, { t: 'bye', code, msg: reason });
    try { sock.close(code, reason); } catch { /* already closed */ }
  }

  /** Close sockets that have not said hello within HELLO_TIMEOUT_MS. Returns how many were closed. */
  sweep(t = this.now()): number {
    let n = 0;
    for (const c of [...this.conns.values()]) if (!c.info && t - c.at >= HELLO_TIMEOUT_MS) { this.drop(c.sock, 4008, 'hello timeout', true); n++; }
    return n;
  }
  /** When the next un-hello'd socket times out (ms epoch), or null. */
  helloDeadline(): number | null {
    let d: number | null = null;
    for (const c of this.conns.values()) if (!c.info) d = Math.min(d ?? Infinity, c.at + HELLO_TIMEOUT_MS);
    return d;
  }

  /** The room emptied: forget its map, name and visibility so a new host can set them. */
  reset(): void { this.map = null; this.meta = null; this.nextIdV = 1; this.lastMapChange = -Infinity; }

  /** Handle one text message. */
  message(sock: Sock, raw: string): MsgResult {
    const res = noChange();
    const c = this.conns.get(sock);
    if (!c) return res;
    // checked before anything is parsed or stored; never answered, the connection just ends
    if (raw.length > MAX_MSG_BYTES) { res.left = this.drop(sock, 1009, 'message too big'); return res; }
    // token bucket rate limit
    const t = this.now();
    c.tokens = Math.min(RATE_LIMIT_PER_S, c.tokens + ((t - c.lastRefill) / 1000) * RATE_LIMIT_PER_S);
    c.lastRefill = t;
    if (c.tokens < 1) return res; // silently drop excess (state is superseded by the next one anyway)
    c.tokens -= 1;
    let m: any;
    try { m = JSON.parse(raw); } catch { this.err(sock, 'bad json'); return res; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') { this.err(sock, 'bad message'); return res; }

    if (m.t === 'hello') {
      if (c.info) return res; // a repeated hello changes nothing (and costs nothing)
      if (this.players().length >= MAX_PLAYERS) { this.drop(sock, 4001, 'room full', true); return res; }
      const info: PlayerInfo = {
        id: this.nextIdV++,
        name: sanitizeName(m.name),
        color: typeof m.color === 'string' && COLOR_RE.test(m.color) ? m.color.toLowerCase() : '#39b6ff',
        frame: typeof m.frame === 'string' && FRAME_RE.test(m.frame) ? m.frame : '5in',
        v: Number.isInteger(m.v) && m.v > 0 && m.v < 1000 ? m.v : 1,
      };
      if (!this.map && typeof m.map === 'string' && MAP_RE.test(m.map)) { this.map = m.map; res.mapChanged = this.map; }
      // the first pilot to describe the room (normally its creator) names it and picks visibility
      if (!this.meta && m.room && typeof m.room === 'object') {
        this.meta = { name: sanitizeRoomName(m.room.name) || `${info.name}'s room`, public: m.room.public === true, host: info.name, ...(c.ip ? { owner: c.ip } : {}) };
        res.metaChanged = true;
      }
      c.info = info; res.joined = info;
      this.send(sock, { t: 'welcome', id: info.id, v: PROTOCOL, map: this.map, players: this.players().filter((p) => p.id !== info.id) });
      this.broadcast({ t: 'join', player: info }, sock);
      return res;
    }
    if (!c.info) { this.err(sock, 'say hello first'); return res; }
    const id = c.info.id;
    switch (m.t) {
      case 's': { // pose: position (m), quaternion, rpm (per motor, or one mean from v1 clients), armed
        if (!vec(m.p, 3, 1e5) || !vec(m.q, 4, 2) || !(num(m.r, 1e6) || vec(m.r, 4, 1e6)) || (m.a !== 0 && m.a !== 1)) return res;
        // v2: sender clock (ms) so receivers can time poses by when they were sampled, and paused
        const clock = num(m.c, 1e13) ? m.c : undefined, paused = m.h === 1 ? 1 : 0;
        const mean = typeof m.r === 'number' ? m.r : (m.r as number[]).reduce((s, x) => s + Math.abs(x), 0) / 4;
        this.broadcastPose({ t: 's', id, p: m.p, q: m.q, r: m.r, a: m.a, ...(clock !== undefined ? { c: clock } : {}), h: paused }, { t: 's', id, p: m.p, q: m.q, r: Math.round(mean), a: m.a }, sock);
        return res;
      }
      case 'map':
        if (typeof m.map !== 'string' || !MAP_RE.test(m.map) || m.map === this.map) return res;
        if (t - this.lastMapChange < MAP_COOLDOWN_MS) {
          // flood guard: refused, and the sender is told which map the room is still flying
          if (this.map) this.send(sock, { t: 'map', map: this.map, by: 0 });
          this.err(sock, 'map changes are limited to one every 5 s');
          return res;
        }
        this.map = m.map; this.lastMapChange = t;
        this.broadcast({ t: 'map', map: this.map, by: id }, null);
        res.mapChanged = this.map;
        return res;
      case 'lap':
        if (!num(m.lap, 1e6) || !num(m.last, 1e6) || !num(m.best, 1e7)) return res;
        this.broadcast({ t: 'lap', id, lap: m.lap, last: m.last, best: m.best }, sock);
        return res;
      case 'ping': // v1 clients (the runtime answers the fixed v2 ping before it gets here)
        if (num(m.c, 1e15)) this.send(sock, { t: 'pong', c: m.c });
        else if (raw === PING) this.send(sock, JSON.parse(PONG));
        return res;
      default:
        this.err(sock, 'unknown type');
        return res;
    }
  }

  private send(sock: Sock, msg: object) { try { sock.send(JSON.stringify(msg)); } catch { /* socket gone */ } }
  private err(sock: Sock, msg: string) { this.send(sock, { t: 'error', msg }); }
  private broadcast(msg: object, except: Sock | null) {
    const s = JSON.stringify(msg);
    for (const c of this.conns.values()) if (c.sock !== except && c.info) { try { c.sock.send(s); } catch { /* ignore */ } }
  }
  /** Poses go out in the receiver's protocol: v1 clients only understand one mean rpm. */
  private broadcastPose(v2: object, v1: object, except: Sock) {
    let s2: string | null = null, s1: string | null = null;
    for (const c of this.conns.values()) {
      if (c.sock === except || !c.info) continue;
      const s = c.info.v >= 2 ? (s2 ??= JSON.stringify(v2)) : (s1 ??= JSON.stringify(v1));
      try { c.sock.send(s); } catch { /* ignore */ }
    }
  }
}

// ---------- origin allow-list ----------
const patterns = new Map<string, RegExp | null>();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compile one allow-list entry. Without "*" it is an exact origin (any scheme, e.g. the desktop
 *  build's "app://fpv-sim"). http(s) entries may use "*" for part of ONE host label ([a-z0-9-]+:
 *  "https://fpv-sim-*-team.vercel.app") or for the port ("http://localhost:*"). A "*" that is a whole
 *  label, or sits in the registrable domain ("https://*.vercel.app", "https://x.*.app"), would admit
 *  other people's sites, so such entries are refused (they match nothing). */
export function originPattern(entry: string): RegExp | null {
  const a = entry.trim().toLowerCase();
  if (!a.includes('*')) return a ? new RegExp(`^${esc(a)}$`) : null;
  const m = /^(https?):\/\/([a-z0-9.*-]+)(?::(\d{1,5}|\*))?$/.exec(a);
  if (!m) return null;
  const labels = m[2].split('.');
  if (labels.some((l) => !l || /^\**$/.test(l))) return null;
  if (labels.length > 1 && labels.slice(-2).some((l) => l.includes('*'))) return null;
  const host = labels.map((l) => l.split('*').map(esc).join('[a-z0-9-]+')).join('\\.');
  const port = m[3] === undefined ? '' : m[3] === '*' ? ':\\d{1,5}' : `:${m[3]}`;
  return new RegExp(`^${m[1]}://${host}${port}$`);
}

export function originAllowed(origin: string | null, allowList: string[]): boolean {
  if (!origin || origin.length > 256) return false;
  const o = origin.toLowerCase();
  return allowList.some((a) => {
    if (!patterns.has(a)) patterns.set(a, originPattern(a));
    return patterns.get(a)?.test(o) ?? false;
  });
}
