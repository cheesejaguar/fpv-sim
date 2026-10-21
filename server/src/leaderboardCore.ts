// Global lap leaderboard: which tracks and drone classes have a board, what a plausible submission
// looks like, and how a board keeps each pilot's best and its top BOARD_SIZE. Platform-independent
// (unit-tested, and imported by the client for the track / class lists); the Durable Object wrapper
// lives in index.ts. The sim runs in the pilot's browser, so none of this proves a lap was flown:
// it keeps the board to plausible times and limits what one client or network can post.
import { MAX_REPLAY_BYTES } from './replayFormat';
import { blocked } from './sanitize';

/** Submission format version (the client's `v`). 2: posted together with the lap's replay (packLap). */
export const LB_VERSION = 2;
export const BOARD_SIZE = 100;        // entries kept per board (track + class)
export const MAX_BODY_BYTES = 2048;   // a submission's JSON: one with 13 splits is ~400 bytes
/** POST /leaderboard: the lap's JSON and its replay in one body (see packLap). */
export const LAP_MIME = 'application/vnd.fpv-sim.lap';
export const MAX_POST_BYTES = 8 + MAX_BODY_BYTES + MAX_REPLAY_BYTES;
export const MAX_PER_NETWORK = 3;     // entries per board from one network (hashed IP), other than your own
export const SUBMITS_PER_WINDOW = 20; // submissions per network per window (the Durable Object's own limit)
export const SUBMIT_WINDOW_MS = 10 * 60_000;
export const MAX_LAP_MS = 10 * 60_000;
export const MIN_SPLIT_MS = 20;       // between two gates (a stacked ladder still takes longer)
export const MIN_LAP_FLOOR_MS = 2_000;

/**
 * Tracks with a board: built-in maps (shipped with the site) with timed gates, by `map` or
 * `map:course` (MapDef.courses). gates: timed passes per lap; pathM: the closed polyline through the
 * gate openings' centres, a lower bound for any real racing line (tests/leaderboard.test.ts checks
 * both against the maps). Maps loaded from disk ("local-…") never have a board.
 */
export const TRACKS: Readonly<Record<string, { gates: number; pathM: number }>> = Object.freeze({
  field: { gates: 13, pathM: 307 },
  'quarry-loop': { gates: 8, pathM: 238.7 },
  // training maps
  gym: { gates: 8, pathM: 53.5 },
  'practice:spec': { gates: 10, pathM: 252.8 },
  'practice:slalom': { gates: 10, pathM: 183.3 },
  'practice:figure8': { gates: 2, pathM: 120 },
  'practice:powerloop': { gates: 2, pathM: 9 },
  mountains: { gates: 2, pathM: 4178.9 },
  night: { gates: 10, pathM: 246.3 },
});

/**
 * Drone classes: the sim's presets (by a stable id; the client maps its PRESETS to these) and
 * `custom` for anything else. vmax (m/s): a generous top speed for the class (~1.3x the preset's
 * estimated level top speed; dives add some), used for the per-track minimum lap. amax (m/s²): the
 * most it can speed up, full thrust plus gravity in a dive with 25 % to spare (a lap's replay is
 * checked against both, see replayCheck.ts).
 */
export const CLASSES: Readonly<Record<string, { name: string; vmax: number; amax: number }>> = Object.freeze({
  freestyle5: { name: '5" Freestyle 6S', vmax: 62, amax: 135 },
  race5: { name: '5" Race 4S', vmax: 55, amax: 110 },
  'freestyle5-o4': { name: '5" Freestyle DJI O4 + GoPro', vmax: 62, amax: 120 },
  'freestyle5-hdz': { name: '5" HDZero 6S', vmax: 60, amax: 130 },
  longrange7: { name: '7" Long Range Li-ion', vmax: 39, amax: 70 },
  whoop65: { name: '65 mm Tiny Whoop 1S', vmax: 16, amax: 55 },
  whoop75: { name: '75 mm Whoop 1S', vmax: 16, amax: 55 },
  cinewhoop3: { name: '3" Cinewhoop 4S HD', vmax: 35, amax: 80 },
  toothpick3: { name: '3" Toothpick 4S', vmax: 39, amax: 100 },
  custom: { name: 'Custom', vmax: 70, amax: 250 },
});
export const CUSTOM = 'custom';

/** A custom build's summary, as the client writes it: Custom · 5" · 2207 1950KV · 6S */
export const CUSTOM_SUMMARY_RE = /^Custom · (?:\d{1,2}"|\d{2,3} mm) · \d{3,4}(?:\.\d)? \d{3,6}KV · \d{1,2}S$/;

const MAP_RE = /^(?!local-)[a-z0-9_-]{1,24}$/;
const COURSE_RE = /^[a-z0-9_-]{1,24}$/;
const CLIENT_RE = /^[0-9a-f]{32}$/;
const HASH_RE = /^[0-9a-f]{8,64}$/;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export const trackKey = (map: string, course = '') => (course ? `${map}:${course}` : map);
export const hasTrack = (map: unknown, course: unknown = ''): boolean =>
  typeof map === 'string' && MAP_RE.test(map) && typeof course === 'string' && (course === '' || COURSE_RE.test(course)) && own(TRACKS, trackKey(map, course));
export const hasClass = (c: unknown): c is string => typeof c === 'string' && own(CLASSES, c);

/** Fastest lap a class can plausibly fly on a track (ms): 85 % of the gate polyline at vmax. */
export function minLapMs(track: string, cls: string): number {
  const t = TRACKS[track], c = CLASSES[cls];
  if (!t || !c) return Infinity;
  return Math.max(MIN_LAP_FLOOR_MS, Math.floor(((0.85 * t.pathM) / c.vmax) * 1000));
}

// ---------------------------------------------------------------------------------------------
// Initials

export const INITIALS_RE = /^[A-Z]{3}$/;
// Three-letter slurs, profanity and hate symbols (arcade cabinets have always refused these),
// besides what sanitize.ts blocks in names. Identity words are deliberately not on it.
const BAD_INITIALS = new Set([
  'ASS', 'CUM', 'FAG', 'FGT', 'FCK', 'FKU', 'FUC', 'FUK', 'FUQ', 'FUX', 'KKK', 'NIG', 'NGR', 'NGA', 'NIP', 'WOP',
  'SEX', 'TIT', 'DIK', 'DIC', 'DIX', 'COK', 'KOK', 'CNT', 'KNT', 'JIZ', 'JIS', 'HOE', 'SHT', 'VAG', 'PNS',
  'NAZ', 'SUK', 'WTF', 'ANL', 'XXX',
]);
export function initialsAllowed(s: unknown): s is string {
  return typeof s === 'string' && INITIALS_RE.test(s) && !BAD_INITIALS.has(s) && !blocked(s);
}

// ---------------------------------------------------------------------------------------------
// Submissions

/** A validated lap, as the client posted it (`client`: its random browser token, hashed before storage). */
export interface Submission { map: string; course: string; cls: string; initials: string; lapMs: number; splitsMs: number[]; summary: string; client: string }

export type Parsed = { ok: true; sub: Submission } | { ok: false; error: string };

const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/**
 * Check a posted lap: a board's track and a known class, arcade initials, time scale 1, a lap no
 * faster than the class can fly that track, and one split per gate that add up to the lap. The
 * summary of a preset class is the server's own preset name; a custom one must be the client's
 * fixed format (no free text reaches the board besides the initials).
 */
export function parseSubmission(raw: unknown): Parsed {
  const r = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const fail = (error: string): Parsed => ({ ok: false, error });
  if (r.v === 1) return fail('this version of FPV Sim can no longer post laps: reload the page to update it');
  if (r.v !== LB_VERSION) return fail('unsupported version');
  if (typeof r.client !== 'string' || !CLIENT_RE.test(r.client)) return fail('bad client id');
  const course = r.course ?? '';
  if (!hasTrack(r.map, course)) return fail('no leaderboard for this map');
  const map = r.map as string, track = trackKey(map, course as string);
  if (!hasClass(r.class)) return fail('unknown drone class');
  const cls = r.class;
  if (!initialsAllowed(r.initials)) return fail('initials must be three letters A-Z');
  if (r.timeScale !== 1) return fail('only laps at time scale 1 count');
  if (!int(r.lapMs, 1, MAX_LAP_MS)) return fail('bad lap time');
  const lapMs = r.lapMs;
  if (lapMs < minLapMs(track, cls)) return fail('lap time not plausible for this track and drone');
  const splits = r.splitsMs, gates = TRACKS[track].gates;
  if (!Array.isArray(splits) || splits.length !== gates || !splits.every((s) => int(s, 1, MAX_LAP_MS))) return fail('need one split per gate');
  for (let i = 0, prev = 0; i < splits.length; prev = splits[i], i++) if (splits[i] - prev < MIN_SPLIT_MS) return fail('splits out of order');
  if (splits[splits.length - 1] !== lapMs) return fail('splits do not add up to the lap');
  const summary = cls === CUSTOM ? (typeof r.summary === 'string' && CUSTOM_SUMMARY_RE.test(r.summary) ? r.summary : 'Custom') : CLASSES[cls].name;
  return { ok: true, sub: { map, course: course as string, cls, initials: r.initials as string, lapMs, splitsMs: splits.slice(), summary, client: r.client } };
}

// ---------------------------------------------------------------------------------------------
// Boards

/** A stored entry. owner: hashed client token (one entry per owner per board); net: hashed IP; replay: one is stored. */
export interface Entry {
  id: number; map: string; course: string; cls: string;
  owner: string; net: string;
  initials: string; lapMs: number; splitsMs: number[]; summary: string; at: number;
  replay?: boolean;
}
/** What GET /leaderboard shows (never the owner or network hashes, nor the splits). replay: GET /leaderboard/:id/replay has one. */
export interface PublicEntry { id: number; initials: string; lapMs: number; cls: string; summary: string; at: number; replay: boolean }

export const toPublic = (e: Entry): PublicEntry => ({ id: e.id, initials: e.initials, lapMs: e.lapMs, cls: e.cls, summary: e.summary, at: e.at, replay: !!e.replay });
const faster = (a: Entry, b: Entry) => a.lapMs - b.lapMs || a.at - b.at || a.id - b.id;

/** Ranked board. `rows`: one track's entries (any classes); cls 'all' keeps each owner's best across classes. */
export function ranked(rows: Entry[], cls: string, limit = BOARD_SIZE): Entry[] {
  const list = cls === 'all' ? rows : rows.filter((r) => r.cls === cls);
  const sorted = [...list].sort(faster);
  if (cls !== 'all') return sorted.slice(0, limit);
  const seen = new Set<string>(), out: Entry[] = [];
  for (const r of sorted) if (!seen.has(r.owner)) { seen.add(r.owner); out.push(r); if (out.length >= limit) break; }
  return out;
}

export type Decision =
  /** store it (update = the owner's existing entry id, else insert); evict: entries pushed off the board */
  | { kind: 'store'; update: number | null; evict: number[] }
  /** the owner's entry on this board is already as fast or faster */
  | { kind: 'slower'; best: Entry }
  /** the board is full and this lap is slower than its last entry */
  | { kind: 'unranked' }
  /** this network already has MAX_PER_NETWORK other entries on the board */
  | { kind: 'network' };

/** What a new lap does to one board (`rows`: that track + class). */
export function decide(rows: Entry[], sub: { lapMs: number }, owner: string, net: string, now: number): Decision {
  const mine = rows.find((r) => r.owner === owner);
  if (mine && mine.lapMs <= sub.lapMs) return { kind: 'slower', best: mine };
  const others = rows.filter((r) => r !== mine);
  if (!mine && HASH_RE.test(net) && others.filter((r) => r.net === net).length >= MAX_PER_NETWORK) return { kind: 'network' };
  const next = [...others, { id: Infinity, lapMs: sub.lapMs, at: now } as Entry].sort(faster);
  const keep = next.slice(0, BOARD_SIZE);
  if (!keep.some((r) => r.id === Infinity)) return { kind: 'unranked' };
  return { kind: 'store', update: mine?.id ?? null, evict: next.slice(BOARD_SIZE).map((r) => r.id) };
}

/** POST /leaderboard body (LAP_MIME): "FPVL", the JSON's length (u32 little-endian), the submission JSON, then the replay. */
export function packLap(json: string, replay: Uint8Array): Uint8Array<ArrayBuffer> {
  const j = new TextEncoder().encode(json), out = new Uint8Array(8 + j.length + replay.length);
  out.set([0x46, 0x50, 0x56, 0x4c]);
  new DataView(out.buffer).setUint32(4, j.length, true);
  out.set(j, 8); out.set(replay, 8 + j.length);
  return out;
}

/** The JSON and the replay of a posted body, or null when it isn't one (or its JSON part is over maxJson bytes). */
export function unpackLap(body: Uint8Array, maxJson = MAX_BODY_BYTES): { json: string; replay: Uint8Array } | null {
  if (body.length < 8 || body[0] !== 0x46 || body[1] !== 0x50 || body[2] !== 0x56 || body[3] !== 0x4c) return null;
  const n = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(4, true);
  if (n > maxJson || 8 + n > body.length) return null;
  return { json: new TextDecoder().decode(body.subarray(8, 8 + n)), replay: body.subarray(8 + n) };
}

/** 1-based rank of entry `id` on a ranked list, or null. */
export function rankOf(list: Entry[], id: number): number | null { const i = list.findIndex((r) => r.id === id); return i < 0 ? null : i + 1; }

/** Submissions per network (hashed IP), per window: kept in the Durable Object's memory. */
export class SubmitLimiter {
  private seen = new Map<string, number[]>();
  constructor(private now: () => number = () => Date.now(), private max = SUBMITS_PER_WINDOW, private windowMs = SUBMIT_WINDOW_MS) {}
  /** true if `net` may submit now (and counts it). */
  take(net: string): boolean {
    const t = this.now(), list = (this.seen.get(net) ?? []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.max) { this.seen.set(net, list); return false; }
    list.push(t);
    this.seen.set(net, list);
    if (this.seen.size > 5000) for (const [k, v] of this.seen) if (!v.some((x) => t - x < this.windowMs)) this.seen.delete(k);
    return true;
  }
}

/** GET /leaderboard query: a board's track and 'all' or a class. */
export function parseQuery(p: URLSearchParams): { map: string; course: string; cls: string } | null {
  const map = p.get('map') ?? '', course = p.get('course') ?? '', cls = p.get('class') || 'all';
  if (!hasTrack(map, course) || (cls !== 'all' && !hasClass(cls))) return null;
  return { map, course, cls };
}

// ---------------------------------------------------------------------------------------------
// One entry (share links)

export const ENTRY_TOP = 5; // board rows sent with an entry (a share card's top 5)

/** What GET /leaderboard/entry/:id shows: the public entry with its track, its rank on its class board, and that board's top. */
export interface EntryView {
  entry: PublicEntry & { map: string; course: string };
  rank: number | null;
  total: number;
  top: PublicEntry[];
}

/** Entry `id` among `rows` (its track's entries, any classes), ranked on its own class board; null if it isn't there. */
export function entryView(rows: Entry[], id: number): EntryView | null {
  const e = rows.find((r) => r.id === id);
  if (!e) return null;
  const list = ranked(rows, e.cls);
  return { entry: { ...toPublic(e), map: e.map, course: e.course }, rank: rankOf(list, id), total: list.length, top: list.slice(0, ENTRY_TOP).map(toPublic) };
}
