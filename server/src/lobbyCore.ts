// Public room directory for the server browser. Rooms that their host marked public report their
// name / map / player count here when someone joins or leaves, and every HEARTBEAT_MS while occupied;
// entries that stop reporting expire after EXPIRE_MS, so crashed or emptied rooms disappear on their
// own. Platform-independent (unit-tested); the Durable Object wrapper lives in index.ts.
import { cleanDisplayName } from './sanitize';

export const HEARTBEAT_MS = 20_000;
export const EXPIRE_MS = 60_000;
export const MAX_LISTED = 200;
export const MAX_PER_OWNER = 3;   // listed rooms per client (hashed IP of the host)
export const ROOM_NAME_MAX = 32;

export interface RoomListing {
  code: string;      // join code
  name: string;      // host-chosen display name
  map: string | null;
  players: number;
  max: number;
  host: string;      // host pilot name
  updated: number;   // ms epoch of the last report
  owner?: string;    // hashed client IP of the host: internal, never listed
}
export type PublicListing = Omit<RoomListing, 'owner'>;

const CODE_RE = /^[A-Z0-9]{4,8}$/;
const MAP_RE = /^(?!(?:__proto__|constructor|prototype)$)(?!local-)[a-z0-9_-]{1,24}$/; // see roomCore MAP_RE
const OWNER_RE = /^[0-9a-f]{8,64}$/;

export function sanitizeRoomName(s: unknown): string { return cleanDisplayName(s, ROOM_NAME_MAX) || 'FPV room'; }

export class LobbyCore {
  private rooms = new Map<string, RoomListing>();
  constructor(private now: () => number = () => Date.now()) {}

  /** A room reported itself: 'added' (new entry), 'updated' (refresh), or null if refused (invalid,
   *  directory full, or its host already has MAX_PER_OWNER rooms listed). */
  upsert(r: Partial<RoomListing>): 'added' | 'updated' | null {
    if (typeof r.code !== 'string' || !CODE_RE.test(r.code)) return null;
    const players = Number(r.players), max = Number(r.max);
    if (!Number.isInteger(players) || players < 1 || players > 64 || !Number.isInteger(max) || max < 1 || max > 64) return null;
    const prev = this.rooms.get(r.code);
    const owner = typeof r.owner === 'string' && OWNER_RE.test(r.owner) ? r.owner : prev?.owner;
    if (!prev) {
      if (this.rooms.size >= MAX_LISTED) this.prune();
      if (this.rooms.size >= MAX_LISTED) return null;
      if (owner && this.ownedBy(owner) >= MAX_PER_OWNER) return null;
    }
    this.rooms.set(r.code, {
      code: r.code,
      name: sanitizeRoomName(r.name),
      map: typeof r.map === 'string' && MAP_RE.test(r.map) ? r.map : null,
      players, max,
      host: cleanDisplayName(r.host, 20) || 'Pilot',
      updated: this.now(),
      ...(owner ? { owner } : {}),
    });
    return prev ? 'updated' : 'added';
  }

  private ownedBy(owner: string): number { let n = 0; for (const v of this.rooms.values()) if (v.owner === owner && this.now() - v.updated <= EXPIRE_MS) n++; return n; }

  remove(code: string): boolean { return this.rooms.delete(code); }

  /** Snapshot for persistence (the hosting object can be evicted from memory when idle). */
  snapshot(): RoomListing[] { return [...this.rooms.values()]; }
  restore(list: RoomListing[]): void {
    for (const r of list) if (r && typeof r.code === 'string' && CODE_RE.test(r.code) && typeof r.updated === 'number') this.rooms.set(r.code, r);
    this.prune();
  }

  prune(): void {
    const t = this.now();
    for (const [k, v] of this.rooms) if (t - v.updated > EXPIRE_MS) this.rooms.delete(k);
  }

  /** Current public rooms, busiest first (without the internal owner field). */
  list(): PublicListing[] {
    this.prune();
    return [...this.rooms.values()].sort((a, b) => b.players - a.players || b.updated - a.updated).map(({ owner: _o, ...r }) => r);
  }
}
