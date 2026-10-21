// Personal bests and the global lap leaderboard. race.ts reports every completed lap here; one that
// counts (see race.ts) and beats the pilot's best on this track with this drone class is saved and
// noted on the HUD for a moment. On a map with a global board it can then be posted with arcade
// initials, but only if the pilot chooses to: a card while disarmed (click, or L), or the pause
// menu's "Post your lap". Nothing opens by itself, so a flight is never interrupted. A personal
// best's replay is kept in IndexedDB (one per board), posted with the lap and watchable offline.
import { hasTrack, trackKey } from '../../server/src/leaderboardCore';
import type { MapDef } from '../maps/world';
import { BoardEntry, BoardResult, fetchBoard, submitLap, SubmitResult } from '../net/leaderboard';
import { IdbKv, KvStore, MemoryKv } from '../worker/kv';
import { KEYS, KV, load, PbRecord, PbTable, save, validClientId, validEntryIds, validInitials, validPbs } from './persist';

/** A completed lap (all gates in order). invalid: why it doesn't count, or null. replay: its recording, once encoded. */
export interface LapResult { map: string; course: string; cls: string; summary: string; lapMs: number; splitsMs: number[]; invalid: string | null; replay?: Promise<Uint8Array | null> }
/** A personal best waiting for the pilot's initials. prevMs: the best it beat (null: the first). replay: its recording (else the stored one). */
export interface PendingPb { key: string; map: string; course: string; cls: string; summary: string; lapMs: number; splitsMs: number[]; prevMs: number | null; replay?: Promise<Uint8Array | null> }
/** A personal best's replay as stored in IndexedDB (database fpv-sim-replays), by board key. */
export interface StoredReplay { lapMs: number; at: number; bytes: Uint8Array }

/** Why a best without a replay can't be posted. */
export const NO_REPLAY = 'This lap has no replay (laps flown before replays existed have none), and laps are posted with their replay. Fly a new personal best to post it.';
/** HUD note after a lap: a new personal best, or a lap that would have been one but doesn't count. */
export interface LapNote { kind: 'pb' | 'invalid'; lapMs: number; text: string; until: number }

const NOTE_MS = 5000;
const RECORD_TTL_MS = 60_000; // HUD record: refetched at most once a minute (and after a submission)

export const pbKey = (map: string, course: string, cls: string) => `${trackKey(map, course)}|${cls}`;

/** A lap as the board keeps it: whole ms, the last split equal to the (rounded) lap. */
export function roundLap(lapMs: number, splitsMs: number[]): { lapMs: number; splitsMs: number[] } {
  const l = Math.round(lapMs), s = splitsMs.map((x) => Math.round(x));
  if (s.length) s[s.length - 1] = l;
  return { lapMs: l, splitsMs: s };
}

/** The course a map is flying: the id of the course whose gates it flies (MapDef.courses, see withCourse), else ''. */
export function courseOf(map: Pick<MapDef, 'gates' | 'courses'>): string {
  return map.courses?.find((c) => c.gates === map.gates)?.id ?? '';
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
  /** this browser's board entries (a faster lap posted replaces the pilot's entry with a new id) */
  private own: Set<number>;
  private noted = new Set<string>(); // "doesn't count" reasons already shown this session
  /** HUD record per board: entry undefined = not known (yet), null = the board is empty */
  private records = new Map<string, { at: number; entry: BoardEntry | null | undefined; busy: boolean }>();

  /** personal-best replays by board key (IndexedDB; in memory where there is none) */
  private replays: KvStore;

  constructor(private kv?: KV | null, replays?: KvStore) {
    this.replays = replays ?? (typeof indexedDB !== 'undefined' ? new IdbKv(indexedDB, (why) => console.warn(`personal-best replays are not kept: ${why}`), 3000, 'fpv-sim-replays') : new MemoryKv());
    this.pbs = load(KEYS.pbs, validPbs, kv);
    this.client = load(KEYS.lbClient, validClientId, kv);
    if (!this.client) { this.client = randomClient(); save(KEYS.lbClient, this.client, kv); }
    this.own = new Set(load(KEYS.lbMine, validEntryIds, kv));
  }

  get initials(): string { return load(KEYS.initials, validInitials, this.kv); }

  pb(map: string, course: string, cls: string): PbRecord | undefined { return this.pbs[pbKey(map, course, cls)]; }

  /** Is this board entry the pilot's own (posted from this browser)? */
  isMine(id: number): boolean { return this.own.has(id); }

  /** A lap was completed. Returns 'pb' (a new personal best), 'invalid' (faster, but it doesn't count) or null. */
  onLap(l: LapResult, now = performance.now(), date = Date.now()): 'pb' | 'invalid' | null {
    const key = pbKey(l.map, l.course, l.cls), prev = this.pbs[key];
    const lapMs = Math.round(l.lapMs);
    if (prev && prev.lapMs <= lapMs) return null;
    if (l.invalid) {
      if (!this.noted.has(l.invalid)) { this.noted.add(l.invalid); this.note = { kind: 'invalid', lapMs, text: l.invalid, until: now + NOTE_MS }; }
      return 'invalid';
    }
    const { splitsMs } = roundLap(l.lapMs, l.splitsMs); // (the last split rounded the same way as the lap)
    this.pbs[key] = { lapMs, splitsMs, at: date, summary: l.summary };
    save(KEYS.pbs, this.pbs, this.kv);
    // its replay replaces the board's stored one once encoded (if this is still the best by then)
    void l.replay?.then((bytes) => { if (bytes && this.pbs[key]?.lapMs === lapMs) void this.replays.set(key, { lapMs, at: date, bytes } satisfies StoredReplay); }, () => {});
    const board = onBoard(l.map, l.course);
    if (board) this.pending = { key, map: l.map, course: l.course, cls: l.cls, summary: l.summary, lapMs, splitsMs, prevMs: prev?.lapMs ?? null, replay: l.replay };
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

  /** The stored replay of the pilot's best on a board (null: none, or only one of an older best). */
  async localReplay(map: string, course: string, cls: string): Promise<Uint8Array | null> {
    const key = pbKey(map, course, cls), pb = this.pbs[key];
    return pb ? this.storedReplay(key, pb.lapMs) : null;
  }

  private async storedReplay(key: string, lapMs: number): Promise<Uint8Array | null> {
    const r = (await this.replays.get(key).catch(() => undefined)) as Partial<StoredReplay> | undefined;
    return r && r.lapMs === lapMs && r.bytes instanceof Uint8Array ? r.bytes : null;
  }

  /** Post a personal best with these initials (remembered for next time), with its replay. */
  async submit(p: PendingPb, initials: string): Promise<SubmitResult> {
    save(KEYS.initials, initials, this.kv);
    const replay = (await p.replay?.catch(() => null)) ?? (await this.storedReplay(p.key, p.lapMs));
    if (!replay) return { ok: false, stored: false, entries: [], error: NO_REPLAY };
    const r = await submitLap({ map: p.map, course: p.course, cls: p.cls, initials, lapMs: p.lapMs, splitsMs: p.splitsMs, summary: p.summary, client: this.client, replay });
    if (r.ok && r.id) {
      const pb = this.pbs[p.key];
      if (pb && pb.lapMs === p.lapMs) { pb.submitted = { id: r.id, at: Date.now() }; save(KEYS.pbs, this.pbs, this.kv); }
      if (!this.own.has(r.id)) { this.own.add(r.id); save(KEYS.lbMine, [...this.own], this.kv); }
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
