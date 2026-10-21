// Room protocol: message shapes, checked on arrival. A pilot can point the sim at any relay (custom
// relay URL in the Multiplayer tab), so nothing a relay sends is trusted to be well-formed: every
// message is parsed into a known type with finite numbers, right-length vectors, a valid colour and
// a cleaned, length-limited name, or dropped.

/** v2: per-motor rpm, sender clock + paused flag in poses, runtime-answered ping (server PROTOCOL). */
export const PROTOCOL = 2;
// Fixed strings: the relay runtime answers this ping itself (no room wake-up), so the pong carries
// nothing and the client times the round trip.
export const PING = '{"t":"ping"}';

export interface PeerInfo { id: number; name: string; color: string; frame: string; v: number }
export type RelayMsg =
  | { t: 'welcome'; id: number; v: number; map: string | null; players: PeerInfo[] }
  | { t: 'join'; player: PeerInfo }
  | { t: 'leave'; id: number }
  /** r: rpm per motor (Betaflight order); c: sender clock ms (v2); h: sender paused (menu open) */
  | { t: 's'; id: number; p: number[]; q: number[]; r: number[]; a: 0 | 1; c?: number; h: 0 | 1 }
  | { t: 'map'; map: string; by: number }
  | { t: 'lap'; id: number; lap: number; last: number; best: number }
  | { t: 'pong'; c?: number }
  | { t: 'error'; msg: string }
  /** the relay is about to close this connection with `code` (room full, busy, hello timeout) */
  | { t: 'bye'; code: number; msg: string };

const MAX_RAW = 32_768;   // a welcome with 8 pilots is ~1 KB
const MAX_PLAYERS = 32;
export const MAP_ID_RE = /^(?!(?:__proto__|constructor|prototype)$)[a-z0-9_-]{1,24}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const FRAME_RE = /^[a-z0-9_-]{1,12}$/i;

const fin = (v: unknown, lim: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
const vec = (v: unknown, n: number, lim: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => fin(x, lim));
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 1e9;

/** Printable, single-line, at most `max` code points; null if nothing is left. */
export function cleanName(s: unknown, max = 20): string | null {
  if (typeof s !== 'string' || s.length > 256) return null;
  const t = s.normalize('NFKC').replace(/\p{Cc}/gu, ' ').replace(/[\p{Cf}\p{Cs}\p{Co}<>]/gu, '').replace(/\s+/gu, ' ').trim();
  return Array.from(t).slice(0, max).join('').trim() || null;
}

export function parsePeer(v: any): PeerInfo | null {
  if (!v || typeof v !== 'object' || !isId(v.id)) return null;
  const name = cleanName(v.name);
  if (!name) return null;
  return {
    id: v.id, name,
    color: typeof v.color === 'string' && COLOR_RE.test(v.color) ? v.color.toLowerCase() : '#39b6ff',
    frame: typeof v.frame === 'string' && FRAME_RE.test(v.frame) ? v.frame : '5in',
    v: Number.isInteger(v.v) && v.v > 0 && v.v < 1000 ? v.v : 1, // pilots without a version predate them
  };
}

const mapId = (v: unknown): string | null => (typeof v === 'string' && MAP_ID_RE.test(v) ? v : null);
/** A pilot's own from-disk map (see maps/localMaps.ts): never sent to a room. */
export const isLocalMapId = (id: string) => id.startsWith('local-');

/** Roster note for a pilot on another protocol version (they still fly; some details may differ). */
export function versionNote(v: number): string | null {
  return v < PROTOCOL ? 'uses an older version' : v > PROTOCOL ? 'uses a newer version (reload to update)' : null;
}

export function parseRelay(raw: unknown): RelayMsg | null {
  if (typeof raw !== 'string' || raw.length > MAX_RAW) return null;
  let m: any;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  switch (m.t) {
    case 'welcome': {
      if (!isId(m.id) || (m.players !== undefined && (!Array.isArray(m.players) || m.players.length > MAX_PLAYERS))) return null;
      const players = ((m.players ?? []) as unknown[]).map(parsePeer).filter((p): p is PeerInfo => !!p && p.id !== m.id);
      return { t: 'welcome', id: m.id, v: Number.isInteger(m.v) && m.v > 0 ? m.v : 1, map: mapId(m.map), players };
    }
    case 'join': { const player = parsePeer(m.player); return player ? { t: 'join', player } : null; }
    case 'leave': return isId(m.id) ? { t: 'leave', id: m.id } : null;
    case 's': {
      if (!isId(m.id) || !vec(m.p, 3, 1e5) || !vec(m.q, 4, 2) || (m.a !== 0 && m.a !== 1)) return null;
      const n = Math.hypot(m.q[0], m.q[1], m.q[2], m.q[3]);
      if (n < 0.5) return null; // not a rotation
      // v1 pilots send one mean rpm; v2 one per motor
      const r = fin(m.r, 1e6) ? [m.r, m.r, m.r, m.r] : vec(m.r, 4, 1e6) ? m.r.slice() : null;
      if (!r) return null;
      return { t: 's', id: m.id, p: m.p.slice(), q: m.q.map((x: number) => x / n), r, a: m.a, ...(fin(m.c, 1e13) ? { c: m.c } : {}), h: m.h === 1 ? 1 : 0 };
    }
    case 'map': { const map = mapId(m.map); return map ? { t: 'map', map, by: isId(m.by) ? m.by : 0 } : null; }
    case 'lap':
      if (!isId(m.id) || !fin(m.lap, 1e6) || m.lap < 0 || !fin(m.last, 1e6) || m.last < 0 || !fin(m.best, 1e7) || m.best < 0) return null;
      return { t: 'lap', id: m.id, lap: Math.floor(m.lap), last: m.last, best: m.best };
    case 'pong': return fin(m.c, 1e15) ? { t: 'pong', c: m.c } : { t: 'pong' };
    case 'error': { const msg = cleanName(m.msg, 160); return { t: 'error', msg: msg ?? 'server error' }; }
    case 'bye': return Number.isInteger(m.code) && m.code >= 1000 && m.code <= 4999 ? { t: 'bye', code: m.code, msg: cleanName(m.msg, 160) ?? '' } : null;
    default: return null; // unknown types (a newer relay) are ignored
  }
}
