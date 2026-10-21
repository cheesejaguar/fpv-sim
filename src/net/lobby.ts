// Server browser client: fetches the relay's public room directory (GET /rooms on the same worker
// that hosts the room WebSockets). Entries are checked like room messages (the relay may be custom).
import { multiplayerUrl } from './config';
import { cleanName, MAP_ID_RE } from './protocol';

export interface RoomListing { code: string; name: string; map: string | null; players: number; max: number; host: string; updated: number }
export interface LobbyResult { rooms: RoomListing[]; latencyMs: number; error: string | null }

const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export function parseListing(x: any): RoomListing | null {
  if (!x || typeof x !== 'object' || typeof x.code !== 'string' || !/^[A-Z0-9]{4,8}$/.test(x.code)) return null;
  if (!int(x.players, 0, 64) || !int(x.max, 1, 64)) return null;
  return {
    code: x.code, name: cleanName(x.name, 32) ?? 'FPV room', host: cleanName(x.host, 20) ?? 'Pilot',
    map: typeof x.map === 'string' && MAP_ID_RE.test(x.map) ? x.map : null,
    players: x.players, max: x.max, updated: Number.isFinite(x.updated) ? x.updated : 0,
  };
}

export async function fetchRooms(timeoutMs = 6000): Promise<LobbyResult> {
  const ws = multiplayerUrl();
  if (!ws) return { rooms: [], latencyMs: 0, error: 'No multiplayer server is configured for this site.' };
  const http = ws.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '') + '/rooms';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const r = await fetch(http, { signal: ctl.signal, cache: 'no-store', mode: 'cors' });
    if (!r.ok) return { rooms: [], latencyMs: 0, error: `The server answered ${r.status}.` };
    const j = await r.json();
    const rooms = Array.isArray(j?.rooms) ? (j.rooms as unknown[]).slice(0, 500).map(parseListing).filter((x): x is RoomListing => !!x) : [];
    return { rooms, latencyMs: performance.now() - t0, error: null };
  } catch (e) {
    return { rooms: [], latencyMs: 0, error: (e as Error).name === 'AbortError' ? 'The server did not answer in time.' : 'Could not reach the server.' };
  } finally { clearTimeout(timer); }
}
