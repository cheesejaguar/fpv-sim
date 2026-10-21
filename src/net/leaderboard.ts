// Global lap leaderboard client: reads a board (GET /leaderboard on the relay that hosts the rooms)
// and submits laps (POST). Like the server browser, everything the relay sends is checked, since a
// pilot can point the sim at any relay.
import { CLASSES, hasTrack, LB_VERSION } from '../../server/src/leaderboardCore';
import { multiplayerUrl } from './config';

export interface BoardEntry { id: number; initials: string; lapMs: number; cls: string; summary: string; at: number }
export interface BoardResult { entries: BoardEntry[]; error: string | null }
export interface LapSubmission { map: string; course: string; cls: string; initials: string; lapMs: number; splitsMs: number[]; summary: string; client: string }
/** stored: the lap is on the board now (rank, id); else why not: 'slower' (the pilot's entry there
 *  is faster: id, rank), 'unranked' (slower than the board's last place) or an error. */
export interface SubmitResult { ok: boolean; stored: boolean; reason?: 'slower' | 'unranked'; id?: number; rank?: number | null; entries: BoardEntry[]; error: string | null }

const MAX_ENTRIES = 200;
const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export function parseEntry(x: any): BoardEntry | null {
  if (!x || typeof x !== 'object' || !int(x.id, 1, 1e12) || typeof x.initials !== 'string' || !/^[A-Z]{3}$/.test(x.initials)) return null;
  if (!int(x.lapMs, 1, 3_600_000) || typeof x.cls !== 'string' || !Object.prototype.hasOwnProperty.call(CLASSES, x.cls)) return null;
  // the summary is the server's preset name or the fixed custom format; anything else is cut down to plain text
  const summary = typeof x.summary === 'string' ? x.summary.replace(/[^\p{L}\p{N} ·"'+.:/-]/gu, '').slice(0, 48) : '';
  return { id: x.id, initials: x.initials, lapMs: x.lapMs, cls: x.cls, summary: summary || CLASSES[x.cls].name, at: Number.isFinite(x.at) ? x.at : 0 };
}
const entries = (j: any): BoardEntry[] => (Array.isArray(j?.entries) ? (j.entries as unknown[]).slice(0, MAX_ENTRIES).map(parseEntry).filter((e): e is BoardEntry => !!e) : []);

/** The relay's HTTP origin (the room URL with http(s)), or null when none is configured. */
function relayHttp(): string | null {
  const ws = multiplayerUrl();
  return ws ? ws.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '') : null;
}

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; json: any } | { error: string }> {
  const base = relayHttp();
  if (!base) return { error: 'No leaderboard server is configured for this site.' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base + path, { ...init, signal: ctl.signal, mode: 'cors' });
    let json: any = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, json };
  } catch (e) {
    return { error: (e as Error).name === 'AbortError' ? 'The leaderboard server did not answer in time.' : 'Could not reach the leaderboard server.' };
  } finally { clearTimeout(timer); }
}

/** One board: cls 'all' or a class id; course '' for a map's only course. */
export async function fetchBoard(map: string, course: string, cls: string, timeoutMs = 6000): Promise<BoardResult> {
  const qs = new URLSearchParams({ map, ...(course ? { course } : {}), class: cls });
  const r = await call(`/leaderboard?${qs}`, { cache: 'no-store' }, timeoutMs);
  if ('error' in r) return { entries: [], error: r.error };
  if (r.status !== 200) return { entries: [], error: typeof r.json?.error === 'string' ? `The server answered ${r.status} (${r.json.error.slice(0, 80)}).` : `The server answered ${r.status}.` };
  return { entries: entries(r.json), error: null };
}

export async function submitLap(s: LapSubmission, timeoutMs = 8000): Promise<SubmitResult> {
  const body = JSON.stringify({ v: LB_VERSION, client: s.client, map: s.map, course: s.course || undefined, class: s.cls, initials: s.initials, lapMs: s.lapMs, splitsMs: s.splitsMs, timeScale: 1, summary: s.summary });
  const r = await call('/leaderboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, cache: 'no-store' }, timeoutMs);
  if ('error' in r) return { ok: false, stored: false, entries: [], error: r.error };
  const j = r.json;
  if (r.status !== 200 || j?.ok !== true) {
    const why = typeof j?.error === 'string' ? j.error.slice(0, 120) : `The server answered ${r.status}.`;
    return { ok: false, stored: false, entries: [], error: why };
  }
  return {
    ok: true, stored: j.stored === true,
    reason: j.reason === 'slower' || j.reason === 'unranked' ? j.reason : undefined,
    id: int(j.id, 1, 1e12) ? j.id : undefined, rank: int(j.rank, 1, 10_000) ? j.rank : null,
    entries: entries(j), error: null,
  };
}

/** m:ss.mmm (the board's lap time format). */
export function formatLap(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const t = Math.round(ms), m = Math.floor(t / 60_000), s = Math.floor((t % 60_000) / 1000), r = t % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

/** One entry (share links): its track, its rank on its class board and that board's top 5. */
export interface EntryResult { entry: (BoardEntry & { map: string; course: string }) | null; rank: number | null; total: number; top: BoardEntry[]; error: string | null }

export async function fetchEntry(id: number, timeoutMs = 8000): Promise<EntryResult> {
  const none = (error: string): EntryResult => ({ entry: null, rank: null, total: 0, top: [], error });
  const r = await call(`/leaderboard/entry/${id}`, { cache: 'no-store' }, timeoutMs);
  if ('error' in r) return none(r.error);
  if (r.status === 404) return none('This lap is no longer on the leaderboard.');
  if (r.status !== 200) return none(`The server answered ${r.status}.`);
  const j = r.json, e = parseEntry(j?.entry);
  const map = j?.entry?.map, course = j?.entry?.course ?? '';
  if (!e || !hasTrack(map, course)) return none('The server sent something unexpected.');
  return { entry: { ...e, map, course }, rank: int(j.rank, 1, 10_000) ? j.rank : null, total: int(j.total, 0, 10_000) ? j.total : 0, top: entries({ entries: j.top }).slice(0, 5), error: null };
}
