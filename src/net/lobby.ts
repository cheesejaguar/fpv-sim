// Server browser client: fetches the relay's public room directory (GET /rooms on the same worker
// that hosts the room WebSockets).
import { multiplayerUrl } from './config';

export interface RoomListing { code: string; name: string; map: string | null; players: number; max: number; host: string; updated: number }
export interface LobbyResult { rooms: RoomListing[]; latencyMs: number; error: string | null }

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
    const rooms: RoomListing[] = Array.isArray(j?.rooms) ? j.rooms.filter((x: any) => typeof x?.code === 'string') : [];
    return { rooms, latencyMs: performance.now() - t0, error: null };
  } catch (e) {
    return { rooms: [], latencyMs: 0, error: (e as Error).name === 'AbortError' ? 'The server did not answer in time.' : 'Could not reach the server.' };
  } finally { clearTimeout(timer); }
}
