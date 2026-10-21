// Public room directory for the server browser. Rooms that their host marked public report their
// name / map / player count here when someone joins or leaves, and every HEARTBEAT_MS while occupied;
// entries that stop reporting expire after EXPIRE_MS, so crashed or emptied rooms disappear on their
// own. Platform-independent (unit-tested); the Durable Object wrapper lives in index.ts.

export const HEARTBEAT_MS = 20_000;
export const EXPIRE_MS = 60_000;
export const MAX_LISTED = 200;
export const ROOM_NAME_MAX = 32;

export interface RoomListing {
  code: string;      // join code
  name: string;      // host-chosen display name
  map: string | null;
  players: number;
  max: number;
  host: string;      // host pilot name
  updated: number;   // ms epoch of the last report
}

const CODE_RE = /^[A-Z0-9]{4,8}$/;
const MAP_RE = /^(?!(?:__proto__|constructor|prototype)$)[a-z0-9_-]{1,24}$/; // never JS prototype member names

export function sanitizeRoomName(s: unknown): string {
  const t = typeof s === 'string' ? s : '';
  return t.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX) || 'FPV room';
}

export class LobbyCore {
  private rooms = new Map<string, RoomListing>();
  constructor(private now: () => number = () => Date.now()) {}

  /** A room reported itself. Invalid reports are ignored. */
  upsert(r: Partial<RoomListing>): boolean {
    if (typeof r.code !== 'string' || !CODE_RE.test(r.code)) return false;
    const players = Number(r.players), max = Number(r.max);
    if (!Number.isInteger(players) || players < 1 || players > 64 || !Number.isInteger(max) || max < 1 || max > 64) return false;
    if (this.rooms.size >= MAX_LISTED && !this.rooms.has(r.code)) this.prune();
    if (this.rooms.size >= MAX_LISTED && !this.rooms.has(r.code)) return false;
    this.rooms.set(r.code, {
      code: r.code,
      name: sanitizeRoomName(r.name),
      map: typeof r.map === 'string' && MAP_RE.test(r.map) ? r.map : null,
      players, max,
      host: sanitizeRoomName(r.host).slice(0, 20),
      updated: this.now(),
    });
    return true;
  }

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

  /** Current public rooms, busiest first. */
  list(): RoomListing[] {
    this.prune();
    return [...this.rooms.values()].sort((a, b) => b.players - a.players || b.updated - a.updated);
  }
}
