// Personal bests and the global lap leaderboard. race.ts reports every completed lap here; one that
// counts (see race.ts) and beats the pilot's best on this track with this drone class is saved and
// noted on the HUD for a moment. On a map with a global board it can then be posted with arcade
// initials, but only if the pilot chooses to: a card while disarmed (click, or L), or the pause
// menu's "Post your lap". Nothing opens by itself, so a flight is never interrupted.
import { hasTrack, trackKey } from '../../server/src/leaderboardCore';
import type { MapDef } from '../maps/world';
import { BoardEntry, BoardResult, fetchBoard, submitLap, SubmitResult } from '../net/leaderboard';
import { KEYS, KV, load, PbRecord, PbTable, save, validClientId, validInitials, validPbs } from './persist';

/** A completed lap (all gates in order). invalid: why it doesn't count, or null. */
export interface LapResult { map: string; course: string; cls: string; summary: string; lapMs: number; splitsMs: number[]; invalid: string | null }
/** A personal best waiting for the pilot's initials. prevMs: the best it beat (null: the first). */
export interface PendingPb { key: string; map: string; course: string; cls: string; summary: string; lapMs: number; splitsMs: number[]; prevMs: number | null }
/** HUD note after a lap: a new personal best, or a lap that would have been one but doesn't count. */
export interface LapNote { kind: 'pb' | 'invalid'; lapMs: number; text: string; until: number }

const NOTE_MS = 5000;
const RECORD_TTL_MS = 60_000; // HUD record: refetched at most once a minute (and after a submission)

export const pbKey = (map: string, course: string, cls: string) => `${trackKey(map, course)}|${cls}`;

/** The course a map is flying: the id of the course whose gates it flies (MapDef.courses, see withCourse), else ''. */
export function courseOf(map: MapDef): string {
  const courses = (map as { courses?: { id: string; gates: unknown }[] }).courses;
  return courses?.find((c) => c.gates === map.gates)?.id ?? '';
}

/** Built-in tracks only: maps loaded from disk ("local-…") and maps without a board keep local bests. */
export const onBoard = (map: string, course: string) => !map.startsWith('local-') && hasTrack(map, course);

function randomClient(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Prefill for the initials entry: the last ones used, else the first three letters of the callsign. */
export function defaultInitials(last: string, callsign: string): string {
  if (/^[A-Z]{3}$/.test(last)) return last;
  const letters = callsign.normalize('NFKD').toUpperCase().replace(/[^A-Z]/g, '');
  return (letters + 'AAA').slice(0, 3);
}

export class LapBoard {
  readonly pbs: PbTable;
  pending: PendingPb | null = null;
  note: LapNote | null = null;
  private client: string;
  private noted = new Set<string>(); // "doesn't count" reasons already shown this session
  /** HUD record per board: entry undefined = not known (yet), null = the board is empty */
  private records = new Map<string, { at: number; entry: BoardEntry | null | undefined; busy: boolean }>();

  constructor(private kv?: KV | null) {
    this.pbs = load(KEYS.pbs, validPbs, kv);
    this.client = load(KEYS.lbClient, validClientId, kv);
    if (!this.client) { this.client = randomClient(); save(KEYS.lbClient, this.client, kv); }
  }

  get initials(): string { return load(KEYS.initials, validInitials, this.kv); }

  pb(map: string, course: string, cls: string): PbRecord | undefined { return this.pbs[pbKey(map, course, cls)]; }

  /** Entry ids of the pilot's own submitted laps (to mark their rows). */
  ownIds(): Set<number> {
    const s = new Set<number>();
    for (const pb of Object.values(this.pbs)) if (pb.submitted) s.add(pb.submitted.id);
    return s;
  }

  /** A lap was completed. Returns 'pb' (a new personal best), 'invalid' (faster, but it doesn't count) or null. */
  onLap(l: LapResult, now = performance.now(), date = Date.now()): 'pb' | 'invalid' | null {
    const key = pbKey(l.map, l.course, l.cls), prev = this.pbs[key];
    const lapMs = Math.round(l.lapMs);
    if (prev && prev.lapMs <= lapMs) return null;
    if (l.invalid) {
      if (!this.noted.has(l.invalid)) { this.noted.add(l.invalid); this.note = { kind: 'invalid', lapMs, text: l.invalid, until: now + NOTE_MS }; }
      return 'invalid';
    }
    const splitsMs = l.splitsMs.map((s) => Math.round(s));
    splitsMs[splitsMs.length - 1] = lapMs; // rounded the same way as the lap
    this.pbs[key] = { lapMs, splitsMs, at: date, summary: l.summary };
    save(KEYS.pbs, this.pbs, this.kv);
    const board = onBoard(l.map, l.course);
    if (board) this.pending = { key, map: l.map, course: l.course, cls: l.cls, summary: l.summary, lapMs, splitsMs, prevMs: prev?.lapMs ?? null };
    this.note = { kind: 'pb', lapMs, text: board ? 'Saved. Once you land you can post it to the leaderboard.' : 'Saved on this computer (this map has no global leaderboard).', until: now + NOTE_MS };
    return 'pb';
  }

  /** The HUD note to show now, if any. */
  noteNow(now = performance.now()): LapNote | null { return this.note && now < this.note.until ? this.note : null; }

  /** Offer a saved personal best (not posted yet) for the board, e.g. from the leaderboard screen. */
  offer(map: string, course: string, cls: string): PendingPb | null {
    const key = pbKey(map, course, cls), pb = this.pbs[key];
    if (!pb || !onBoard(map, course) || pb.splitsMs.length === 0) return null;
    this.pending = { key, map, course, cls, summary: pb.summary, lapMs: pb.lapMs, splitsMs: pb.splitsMs.slice(), prevMs: null };
    return this.pending;
  }

  skip() { this.pending = null; }

  /** Post a personal best with these initials (remembered for next time). */
  async submit(p: PendingPb, initials: string): Promise<SubmitResult> {
    save(KEYS.initials, initials, this.kv);
    const r = await submitLap({ map: p.map, course: p.course, cls: p.cls, initials, lapMs: p.lapMs, splitsMs: p.splitsMs, summary: p.summary, client: this.client });
    if (r.ok && r.id) {
      const pb = this.pbs[p.key];
      if (pb && pb.lapMs === p.lapMs) { pb.submitted = { id: r.id, at: Date.now() }; save(KEYS.pbs, this.pbs, this.kv); }
    }
    if (r.ok) {
      if (this.pending === p) this.pending = null;
      this.records.set(this.recordKey(p.map, p.course, p.cls), { at: performance.now(), entry: r.entries[0] ?? null, busy: false });
    }
    return r;
  }

  /** A board for the leaderboard screen (also refreshes the HUD record of that class). */
  async board(map: string, course: string, cls: string): Promise<BoardResult> {
    const r = await fetchBoard(map, course, cls);
    if (!r.error && cls !== 'all') this.records.set(this.recordKey(map, course, cls), { at: performance.now(), entry: r.entries[0] ?? null, busy: false });
    return r;
  }

  private recordKey(map: string, course: string, cls: string) { return pbKey(map, course, cls); }

  /**
   * The board's fastest lap for the race HUD: undefined until known, null when the board is empty.
   * Fetched in the background at most once a minute; when the server can't be reached the HUD
   * just shows none.
   */
  record(map: string, course: string, cls: string, now = performance.now()): BoardEntry | null | undefined {
    if (!onBoard(map, course)) return undefined;
    const k = this.recordKey(map, course, cls), r = this.records.get(k);
    if (!r || (!r.busy && now - r.at > RECORD_TTL_MS)) {
      const next = { at: now, entry: r?.entry, busy: true };
      this.records.set(k, next);
      void fetchBoard(map, course, cls).then((b) => {
        if (b.error) { next.busy = false; return; } // keep what we had; retried after the TTL
        this.records.set(k, { at: performance.now(), entry: b.entries[0] ?? null, busy: false });
      });
      return next.entry;
    }
    return r.entry;
  }
}
