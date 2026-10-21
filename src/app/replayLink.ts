// Replay permalinks: /?replay=<leaderboard entry id>[&t=<lap time, s>] opens that lap's replay over
// the title screen, at that moment of the lap when t is given. The relay serves the replay
// (GET /leaderboard/:id/replay); an entry that left the board, or a lap posted before replays, says so.

export interface ReplayLink { id: number; t?: number }

const ID_RE = /^\d{1,12}$/;
/** The approach to gate 0 is recorded too, so a start time may be a little negative. */
const T_MIN = -5, T_MAX = 3600;

/** The replay a page URL's query asks for, or null (not a replay link, or a malformed one). */
export function parseReplayLink(search: string): ReplayLink | null {
  const q = new URLSearchParams(search), id = q.get('replay');
  if (!id || !ID_RE.test(id) || Number(id) <= 0) return null;
  const t = Number(q.get('t'));
  return q.has('t') && Number.isFinite(t) && t >= T_MIN && t <= T_MAX ? { id: Number(id), t: Math.round(t * 100) / 100 } : { id: Number(id) };
}

/** The permalink to a board entry's replay, optionally starting at lap time t (s, kept to 0.01 s). */
export function replayUrl(origin: string, id: number, t?: number): string {
  const q = new URLSearchParams({ replay: String(id) });
  if (t !== undefined && Number.isFinite(t)) q.set('t', (Math.round(Math.max(T_MIN, Math.min(T_MAX, t)) * 100) / 100).toString());
  return `${origin.replace(/\/$/, '')}/?${q}`;
}

/** The page URL without its replay link (other parameters, such as an invite's ?room=, are kept). */
export function withoutReplayLink(href: string): string {
  const u = new URL(href);
  u.searchParams.delete('replay'); u.searchParams.delete('t');
  return `${u.pathname}${u.search}${u.hash}`;
}
