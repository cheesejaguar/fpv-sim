// Game menu screens for the global lap leaderboard: the board itself (filtered by track and drone
// class, LB / RB or Q / E switch the class) and the arcade initials entry for a new personal best.
// Hosted by GameMenu (gameMenu.ts), in its design language (theme.css).
import { CUSTOM, TRACKS } from '../../../server/src/leaderboardCore';
import { defaultInitials, LapBoard, onBoard, PendingPb } from '../../app/leaderboard';
import { CLASS_IDS, className } from '../../builder/droneClass';
import { MAP_LIST, MAPS } from '../../maps/maps';
import { BoardEntry, BoardResult, formatLap, SubmitResult } from '../../net/leaderboard';
import { el } from '../dom';
import { icon } from './icons';
import { InitialsEntry } from './initials';
import type { NavOverlay } from './nav';

export interface Track { key: string; map: string; course: string; label: string }

const courseNames = new Map<string, string>();
/** A course's own name (procedural maps build synchronously), else its id spelled out. */
function courseName(map: string, course: string): string {
  const k = `${map}:${course}`;
  let n = courseNames.get(k);
  if (n === undefined) {
    const e = MAP_LIST[map];
    try { if (e && !e.source && !e.prepare) n = MAPS[map]().courses?.find((c) => c.id === course)?.name; } catch { /* unbuildable: the id */ }
    n ??= course.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
    courseNames.set(k, n);
  }
  return n;
}

/** Tracks with a global board that this build has, in the server's order. */
export function boardTracks(): Track[] {
  return Object.keys(TRACKS).flatMap((key) => {
    const [map, course = ''] = key.split(':');
    if (!MAP_LIST[map] || !onBoard(map, course)) return [];
    const name = MAP_LIST[map].name.split(' — ')[0];
    return [{ key, map, course, label: course ? `${name} · ${courseName(map, course)}` : name }];
  });
}

export const shortDate = (at: number) => (at > 0 ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// ---------------------------------------------------------------------------------------------
// Leaderboard screen

export interface BoardScreenHost {
  board: LapBoard;
  /** what the pilot flies now: the board shown first */
  current(): { map: string; course: string; cls: string };
  backBar(): HTMLElement;
  /** LB / RB (Q / E): switch the class filter */
  setTabs(t: { count: number; go: (d: -1 | 1) => void }): void;
  /** post a saved personal best (opens the initials entry) */
  post(map: string, course: string, cls: string): void;
}

const CLASS_FILTERS = ['all', ...CLASS_IDS];
const filterLabel = (c: string) => (c === 'all' ? 'All drones' : c === CUSTOM ? 'Custom builds' : className(c));
let filter: { track: string; cls: string } | null = null; // kept for the session
const cache = new Map<string, { at: number; r: BoardResult }>();
const CACHE_MS = 30_000;

/** Show a particular board next time the screen opens (after posting a lap). */
export function showBoard(map: string, course: string, cls: string) { filter = { track: course ? `${map}:${course}` : map, cls }; }
/** A posted lap changed this board: drop what was cached of it. */
export function boardChanged(map: string, course: string) { const t = course ? `${map}:${course}` : map; for (const k of cache.keys()) if (k.startsWith(`${t}|`)) cache.delete(k); }

export function boardScreen(h: BoardScreenHost): HTMLElement {
  const tracks = boardTracks();
  if (!filter || !tracks.some((t) => t.key === filter!.track)) {
    const c = h.current(), here = tracks.find((t) => t.map === c.map && t.course === c.course);
    filter = { track: (here ?? tracks[0])?.key ?? '', cls: filter?.cls ?? c.cls };
  }
  const f = filter;
  const track = () => tracks.find((t) => t.key === f.track) ?? tracks[0];
  const tbody = el('tbody');
  const meta = el('span', { class: 'gm-chip' }, el('span', { class: 'dot' }), '…');
  const empty = el('div'), mine = el('div');
  const refresh = el('button', { class: 'gm-btn', 'data-key': 'lb-refresh', onclick: () => void load(true) }, icon('refresh'), 'Refresh') as HTMLButtonElement;
  let state: { loading: boolean; r: BoardResult | null } = { loading: false, r: null };
  let seq = 0;

  const draw = () => {
    const t = track(), r = state.r;
    meta.className = `gm-chip ${state.loading ? 'warn' : r?.error ? 'err' : 'ok'}`;
    meta.lastChild!.textContent = state.loading ? 'Loading…' : r?.error ? 'Offline' : `${r?.entries.length ?? 0} lap${r?.entries.length === 1 ? '' : 's'}`;
    refresh.disabled = state.loading;
    drawMine(t, r);
    if (state.loading && !r?.entries.length) {
      tbody.replaceChildren(...[0, 1, 2, 3].map(() => el('tr', { class: 'gm-row gm-skel' }, ...[0, 1, 2, 3, 4].map(() => el('td', {}, el('span', {}, '.'))))));
      empty.replaceChildren();
      return;
    }
    const list = r?.entries ?? [];
    tbody.replaceChildren(...list.map((e, i) => row(e, i + 1, h.board.isMine(e.id))));
    if (r?.error) empty.replaceChildren(el('div', { class: 'gm-empty' }, icon('wifiOff'), el('h4', {}, 'Can’t reach the leaderboard'), el('p', {}, r.error),
      el('p', {}, 'Your personal bests are saved on this computer: post them here once you are back online.')));
    else if (!list.length) empty.replaceChildren(el('div', { class: 'gm-empty' }, icon('trophy'), el('h4', {}, 'No laps on this board yet'),
      el('p', {}, `Fly Race mode on ${t?.label ?? 'this track'}${f.cls === 'all' ? '' : ` with the ${filterLabel(f.cls)}`} and set the first time.`)));
    else empty.replaceChildren();
  };

  const row = (e: BoardEntry, rank: number, me: boolean) => el('tr', { class: `gm-row lb-row${me ? ' me' : ''}`, tabindex: '0', 'aria-label': `Rank ${rank}: ${e.initials}, ${formatLap(e.lapMs)}, ${e.summary}${me ? ' (you)' : ''}` },
    el('td', {}, el('span', { class: `lb-rank${rank <= 3 ? ` r${rank}` : ''}` }, String(rank))),
    el('td', {}, el('span', { class: 'lb-ini-cell' }, e.initials), me ? el('span', { class: 'gm-badge green' }, 'YOU') : null),
    el('td', { class: 'lb-time' }, formatLap(e.lapMs)),
    el('td', { class: 'lb-drone' }, e.summary),
    el('td', { class: 'lb-date' }, shortDate(e.at)));

  // the pilot's own best on the selected board: posted (and where), or a button to post it
  const drawMine = (t: Track | undefined, r: BoardResult | null) => {
    if (!t || f.cls === 'all') { mine.replaceChildren(); return; }
    const pb = h.board.pb(t.map, t.course, f.cls);
    if (!pb) { mine.replaceChildren(el('p', { class: 'gm-room-sub lb-mine' }, `No counted lap of yours here with the ${filterLabel(f.cls)} yet.`)); return; }
    const rank = pb.submitted ? (r?.entries.findIndex((e) => e.id === pb.submitted!.id) ?? -1) + 1 : 0;
    const status = pb.submitted ? (rank > 0 ? `#${rank} on the board` : `posted ${shortDate(pb.submitted.at)}`) : 'not posted yet';
    const postable = !pb.submitted && pb.splitsMs.length > 0;
    mine.replaceChildren(el('div', { class: 'gm-card lb-mine' },
      el('div', {}, el('h3', {}, 'Your best'), el('p', {}, el('b', { class: 'lb-time' }, formatLap(pb.lapMs)), ` · ${shortDate(pb.at)} · ${status}`)),
      postable ? el('button', { class: 'gm-btn primary', 'data-key': 'lb-post', onclick: () => h.post(t.map, t.course, f.cls) }, icon('trophy'), 'Post to leaderboard') : null));
  };

  const load = async (force = false) => {
    const t = track();
    if (!t) return;
    const key = `${t.key}|${f.cls}`, hit = cache.get(key), my = ++seq;
    if (hit && !force && Date.now() - hit.at < CACHE_MS) { state = { loading: false, r: hit.r }; draw(); return; }
    state = { loading: true, r: hit?.r ?? null }; draw();
    const r = await h.board.board(t.map, t.course, f.cls);
    if (my !== seq) return; // another filter was picked meanwhile
    if (!r.error) cache.set(key, { at: Date.now(), r });
    state = { loading: false, r: r.error && hit ? { ...hit.r, error: r.error } : r };
    if (tbody.isConnected) draw();
  };

  const mapSel = el('select', { class: 'gm-input', 'data-key': 'lb-map', 'aria-label': 'Track', onchange: () => { f.track = mapSel.value; void load(); } },
    ...tracks.map((t) => el('option', { value: t.key, selected: t.key === f.track }, t.label))) as HTMLSelectElement;
  const clsSel = el('select', { class: 'gm-input', 'data-key': 'lb-class', 'aria-label': 'Drone class', onchange: () => { f.cls = clsSel.value; void load(); } },
    ...CLASS_FILTERS.map((c) => el('option', { value: c, selected: c === f.cls }, filterLabel(c)))) as HTMLSelectElement;
  h.setTabs({ count: CLASS_FILTERS.length, go: (d) => {
    const i = CLASS_FILTERS.indexOf(f.cls);
    f.cls = CLASS_FILTERS[(i + d + CLASS_FILTERS.length) % CLASS_FILTERS.length];
    clsSel.value = f.cls;
    void load();
  } });
  draw();
  void load();
  return el('div', {},
    h.backBar(), el('h1', { class: 'gm-h1' }, 'Leaderboard'),
    el('p', { class: 'gm-lead' }, 'The fastest laps worldwide, one per pilot, by track and drone class. Laps count when every gate is passed in order, in real time at time scale 1. The board keeps the top 100.'),
    el('div', { class: 'gm-toolbar' },
      el('label', { class: 'gm-field lb-filter' }, el('span', {}, 'Track'), mapSel),
      el('label', { class: 'gm-field lb-filter' }, el('span', {}, 'Drone class'), clsSel),
      el('span', { class: 'gm-spacer', style: { flex: '1' } }), meta, refresh),
    mine,
    tracks.length ? el('table', { class: 'gm-table lb' },
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Pilot'), el('th', {}, 'Lap'), el('th', {}, 'Drone'), el('th', {}, 'Date'))),
      tbody) : el('div', { class: 'gm-empty' }, icon('map'), el('h4', {}, 'No leaderboard tracks in this version')),
    empty);
}

// ---------------------------------------------------------------------------------------------
// Initials entry (a new personal best)

export interface InitialsScreenHost {
  board: LapBoard;
  pending: PendingPb;
  trackLabel: string;
  callsign: string;
  usingPad(): boolean;
  /** hand the pad + keys to the entry */
  open(o: NavOverlay): void;
  /** finished (saved, skipped): continue; board = show the board it was posted to */
  done(board: boolean): void;
}

export interface InitialsScreen { el: HTMLElement; skip(): void; busy(): boolean }

export function initialsScreen(h: InitialsScreenHost): InitialsScreen {
  const p = h.pending;
  let saving = false, finished = false;
  const status = el('div', { role: 'status', 'aria-live': 'polite', class: 'lb-status' });
  const actions = el('div', { class: 'gm-actions' });
  const entry = new InitialsEntry(defaultInitials(h.board.initials, h.callsign), {
    confirm: (v) => void save(v),
    skip: () => skip(),
    reopen: (e) => h.open(e),
  });
  const hint = el('p', { class: 'gm-room-sub lb-hint' });
  const drawHint = () => {
    hint.textContent = h.usingPad()
      ? 'D-pad up / down: change the letter · left / right: move · A: save · B: skip'
      : 'Type your initials · arrow keys change and move · Enter: save · Esc: skip';
  };
  const skip = () => { if (saving) return; if (!finished) h.board.skip(); finished = true; h.done(false); };
  const buttons = (kind: 'edit' | 'done' | 'retry') => {
    if (kind === 'done') {
      actions.replaceChildren(
        el('button', { class: 'gm-btn cta', 'data-key': 'ini-board', 'data-autofocus': true, onclick: () => h.done(true) }, icon('trophy'), 'View leaderboard'),
        el('button', { class: 'gm-btn ghost', 'data-key': 'ini-continue', onclick: () => h.done(false) }, 'Continue'));
      return;
    }
    actions.replaceChildren(
      el('button', { class: 'gm-btn cta', 'data-key': 'ini-save', onclick: () => void save(entry.value) }, icon('trophy'), kind === 'retry' ? 'Retry' : 'Save to leaderboard'),
      el('button', { class: 'gm-btn ghost', 'data-key': 'ini-skip', onclick: () => skip() }, 'Skip'));
  };
  const save = async (initials: string) => {
    if (saving || finished) return;
    saving = true; entry.disabled = true;
    actions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    status.replaceChildren(el('p', { class: 'gm-room-sub' }, 'Posting your lap…'));
    const r = await h.board.submit(p, initials);
    saving = false;
    if (!r.ok) {
      entry.disabled = false;
      status.replaceChildren(el('div', { class: 'gm-callout warn' }, icon('alert'), el('div', {},
        el('p', {}, el('b', {}, 'Not posted. '), r.error ?? 'Something went wrong.'),
        el('p', { class: 'gm-room-sub' }, 'Your personal best is saved on this computer: you can post it later from the leaderboard.'))));
      buttons('retry');
      entry.take();
      return;
    }
    finished = true;
    status.replaceChildren(result(r, p));
    buttons('done');
    (actions.querySelector('[data-autofocus]') as HTMLElement | null)?.focus({ preventScroll: true });
  };
  buttons('edit');
  drawHint();
  const gain = p.prevMs ? p.prevMs - p.lapMs : 0;
  const root = el('div', { class: 'lb-new' },
    el('p', { class: 'gm-tagline' }, 'New personal best'),
    el('h1', { class: 'gm-hero lb-hero' }, formatLap(p.lapMs)),
    el('p', { class: 'gm-lead' }, `${h.trackLabel} · ${p.summary}${gain > 0 ? ` · ${(gain / 1000).toFixed(3)} s faster than your last best` : ''}`),
    el('h2', { class: 'gm-section-title' }, 'Enter your initials'),
    entry.el, hint, actions, status);
  // the entry takes the pad and keys as soon as it is on screen (and again whenever it is clicked)
  requestAnimationFrame(() => { if (root.isConnected && !saving && !finished) entry.take(); drawHint(); });
  return { el: root, skip, busy: () => saving };
}

function result(r: SubmitResult, p: PendingPb): HTMLElement {
  const msg = (title: string, sub: string) => el('div', { class: 'gm-callout lb-result' }, icon('trophy'), el('div', {}, el('p', {}, el('b', {}, title)), el('p', { class: 'gm-room-sub' }, sub)));
  const label = p.cls === CUSTOM ? 'custom builds' : className(p.cls);
  if (r.stored) return msg(r.rank ? `You are #${r.rank} on the board!` : 'Posted!', `${formatLap(p.lapMs)} on the ${label} board.`);
  if (r.reason === 'slower') return msg('Your entry on the board is faster', `It stays${r.rank ? ` at #${r.rank}` : ''}: one entry per pilot.`);
  const last = r.entries[r.entries.length - 1];
  return msg('Not in the top 100 yet', last ? `The board’s 100th lap is ${formatLap(last.lapMs)}. Keep flying!` : 'Keep flying!');
}

/** The track a map flies, if it has a board (the label for the initials screen). */
export function trackLabelOf(map: string, course: string): string {
  return boardTracks().find((t) => t.map === map && t.course === course)?.label ?? MAP_LIST[map]?.name.split(' — ')[0] ?? map;
}
