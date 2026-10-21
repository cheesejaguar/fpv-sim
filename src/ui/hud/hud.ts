// In-flight HUD: race / drill panel, key hints, telemetry, stick view, noise spectrum, crash banner,
// notices and the arming coach, styled like the game menu (hud.css). A small layout engine places
// every widget so it never covers a Betaflight OSD character: it prefers the letterbox bars beside
// 4:3 analog video, then slides along the screen edges to find a gap, collapses the key hints, and as
// a last resort hides low-priority widgets rather than draw over the OSD.
// Widgets are rebuilt only when what they show changes (the HUD is fed every frame).
import './hud.css';
import { el } from '../dom';
import { CoachAdvice, adviceSig } from './coach';

export interface Rect { x: number; y: number; w: number; h: number }
/** One key / button hint: glyph text, glyph style (key | a | b | x | y | sh), action label. */
export interface KeyHint { glyph: string; cls: string; label: string }
/** Lap panel. gates = 0: no course on this map, only the room roster (board) is shown. */
export interface RaceInfo { lap: number; last: number; best: number; gate: number; gates: number; room?: string; board?: { name: string; color: string; lap: number; best: number; me: boolean }[] }
export interface DrillInfo { inBox: boolean; offBy: number; elapsed: number; score: number; best: number }

type Edge = 'top' | 'bottom' | 'left' | 'right';
type Slot = { bar: 'left' | 'right'; at: 'top' | 'bottom' } | { edge: Edge; pref: 'start' | 'center' | 'end' } | { center: number };

interface Widget { el: HTMLElement; on: boolean; slots: Slot[]; optional: boolean; vertInBar?: boolean }

const M = 14;          // screen margin, px
const PAD_OSD = 6;     // clearance around OSD characters
const PAD_W = 8;       // clearance between HUD widgets
const FLASH_MS = 1600; // lap complete / new best highlight on the race card

export class Hud {
  // no aria-live here: telemetry changes every frame. Only notices, the coach and the crash banner speak.
  readonly root = el('div', { class: 'ghud' });
  private w: Record<string, Widget> = {};
  private raceEl = el('div', { class: 'card race' });
  private keysEl = el('div', { class: 'card keys' });
  private telEl = el('div', { class: 'card tel' });
  private crashEl = el('div', { class: 'crash', role: 'alert' });
  private noticeEl = el('div', { class: 'notices', role: 'status' });
  private coachEl = el('div', { class: 'card coach', role: 'status' });
  private keysSig = '';
  private keysWant: { items: KeyHint[]; collapsed: boolean } = { items: [], collapsed: false };
  private raceSig = '';
  private noticeList: HTMLElement[] = [];
  private telText = '';
  private crashText = '';
  private coachSig = '';
  private visible = true;
  private prevLap = 0;
  private prevBest = Infinity;
  private flash: { kind: 'lap' | 'best'; until: number } | null = null;
  /** Tap / click on the "Menu" key hint (touch screens have no Esc / Start). Wired by the app. */
  onMenuTap: (() => void) | null = null;
  /** Last layout, for tests / debugging: every placed widget and whether it touches the OSD. */
  lastLayout: { name: string; rect: Rect; overlapsOsd: boolean }[] = [];

  constructor(sticks: HTMLCanvasElement, spectrum: HTMLCanvasElement) {
    const add = (name: string, node: HTMLElement, slots: Slot[], optional = false, vertInBar = false) => {
      const wrap = el('div', { class: 'hw off', 'data-hud': name }, node);
      this.root.append(wrap);
      this.w[name] = { el: wrap, on: false, slots, optional, vertInBar };
    };
    // order = placement priority (must-show widgets first: their fallback may not avoid later ones)
    add('crash', this.crashEl, [{ center: 0.3 }, { center: 0.5 }, { edge: 'top', pref: 'center' }]);
    add('notices', this.noticeEl, [{ center: 0.62 }, { edge: 'bottom', pref: 'center' }, { center: 0.4 }, { edge: 'left', pref: 'center' }, { edge: 'right', pref: 'center' }, { edge: 'top', pref: 'center' }]);
    add('race', this.raceEl, [{ bar: 'left', at: 'top' }, { bar: 'right', at: 'top' }, { edge: 'top', pref: 'center' }, { edge: 'left', pref: 'center' }, { edge: 'right', pref: 'center' }, { edge: 'bottom', pref: 'center' }]);
    // optional, so after the must-show widgets: it finds a gap around them or waits
    add('coach', this.coachEl, [{ center: 0.8 }, { edge: 'bottom', pref: 'center' }, { center: 0.24 }, { edge: 'top', pref: 'center' }, { edge: 'left', pref: 'center' }, { edge: 'right', pref: 'center' }, { bar: 'left', at: 'top' }, { bar: 'right', at: 'top' }], true);
    add('tel', this.telEl, [{ bar: 'right', at: 'top' }, { edge: 'right', pref: 'start' }, { edge: 'left', pref: 'start' }, { edge: 'top', pref: 'end' }, { edge: 'bottom', pref: 'end' }], true);
    add('sticks', el('div', { class: 'card sticks' }, sticks), [{ bar: 'right', at: 'bottom' }, { edge: 'bottom', pref: 'end' }, { edge: 'right', pref: 'end' }, { edge: 'left', pref: 'end' }], true);
    add('spec', el('div', { class: 'card spec' }, spectrum), [{ bar: 'left', at: 'bottom' }, { edge: 'bottom', pref: 'start' }, { edge: 'left', pref: 'end' }, { edge: 'right', pref: 'end' }], true);
    add('keys', this.keysEl, [{ bar: 'left', at: 'bottom' }, { bar: 'right', at: 'bottom' }, { edge: 'bottom', pref: 'center' }, { edge: 'top', pref: 'center' }, { edge: 'left', pref: 'end' }, { edge: 'right', pref: 'end' }], true, true);
  }

  private show(name: string, on: boolean) { const w = this.w[name]; if (w.on !== on) { w.on = on; w.el.classList.toggle('off', !on); } }

  setVisible(v: boolean) { if (v !== this.visible) { this.visible = v; this.root.style.display = v ? '' : 'none'; } }

  race(r: RaceInfo | null, d: DrillInfo | null, now = performance.now()) {
    if (d) {
      const sig = `d|${d.inBox}|${d.offBy.toFixed(1)}|${d.score.toFixed(0)}|${d.best.toFixed(0)}|${d.elapsed.toFixed(1)}`;
      if (sig !== this.raceSig) {
        this.raceSig = sig;
        this.raceEl.className = 'card race drill';
        this.raceEl.replaceChildren(
          el('div', { class: 'lap' }, el('span', { class: 'k' }, 'HOVER DRILL')),
          el('dl', {},
            el('dt', {}, 'Box'), el('dd', { class: d.inBox ? 'inbox' : 'outbox' }, d.inBox ? 'IN' : `+${d.offBy.toFixed(1)} m`),
            el('dt', {}, 'Score'), el('dd', {}, `${d.score.toFixed(0)} %`),
            el('dt', {}, 'Best'), el('dd', { class: 'best' }, `${d.best.toFixed(0)} %`)),
          el('div', { class: 'gate' }, `${d.elapsed.toFixed(1)} / 30 s`), el('div', { class: 'bar' }, el('i', { style: { width: `${Math.min(100, (d.elapsed / 30) * 100)}%` } })));
      }
      this.show('race', true);
      return;
    }
    if (!r) { this.raceSig = ''; this.show('race', false); return; }
    // a lap just completed: flash the card (rose glow, "NEW BEST" when it beat the previous best)
    if (r.lap > this.prevLap) this.flash = { kind: r.best < this.prevBest && this.prevBest < Infinity ? 'best' : 'lap', until: now + FLASH_MS };
    this.prevLap = r.lap; this.prevBest = r.best;
    const flash = this.flash && now < this.flash.until ? this.flash.kind : null;
    const t = (s: number) => (s > 0 && s < Infinity ? `${s.toFixed(2)} s` : '—');
    const board = r.board ?? [];
    const sig = `r|${r.lap}|${t(r.last)}|${t(r.best)}|${r.gate}/${r.gates}|${r.room ?? ''}|${flash ?? ''}|${board.map((b) => `${b.name}${b.color}${b.lap}${t(b.best)}${b.me}`).join(',')}`;
    if (sig !== this.raceSig) {
      this.raceSig = sig;
      const list = board.length ? el('ol', { class: 'board' }, ...board.map((b, i) => el('li', { class: b.me ? 'me' : '' },
        el('span', {}, `${i + 1}`), el('span', { class: 'dot', style: { background: b.color } }), el('span', { class: 'nm' }, b.name), el('span', {}, r.gates ? (b.best < Infinity ? b.best.toFixed(2) : '—') : '')))) : null;
      if (!r.gates) {
        // no gates on this map: just who is in the room
        this.raceEl.className = 'card race roster';
        this.raceEl.replaceChildren(
          el('div', { class: 'lap' }, el('span', { class: 'k' }, r.room ? `ROOM ${r.room}` : 'ROOM'), el('span', { class: 'v sm' }, `${board.length}`)),
          el('div', { class: 'gate' }, 'No race gates on this map'), ...(list ? [list] : []));
      } else {
        this.raceEl.className = `card race${flash ? ` flash${flash === 'best' ? ' flash-best' : ''}` : ''}`;
        const kids: HTMLElement[] = [
          el('div', { class: 'lap' }, el('span', { class: 'k' }, 'LAP'), el('span', { class: 'v' }, String(r.lap)), flash === 'best' ? el('span', { class: 'tag' }, 'NEW BEST') : null),
          el('dl', {}, el('dt', {}, 'Last'), el('dd', {}, t(r.last)), el('dt', {}, 'Best'), el('dd', { class: 'best' }, t(r.best))),
          el('div', { class: 'gate' }, `Gate ${r.gate} / ${r.gates}`),
          el('div', { class: 'bar' }, el('i', { style: { width: `${(100 * (r.gate - 1)) / Math.max(1, r.gates)}%` } })),
        ];
        if (list) kids.push(list);
        this.raceEl.replaceChildren(...kids);
      }
    }
    this.show('race', true);
  }

  /** Key hints: full while disarmed, a single dim "menu" chip once flying (layout may collapse more). */
  /** items[0] is the menu hint, the only one left when collapsed (a few seconds after arming). */
  keys(items: KeyHint[], collapsed: boolean) { this.keysWant = { items, collapsed }; this.show('keys', true); }

  private renderKeys(all: KeyHint[], collapsed: boolean, inBar: boolean) {
    const tap = !!this.onMenuTap;
    const sig = `${all.map((k) => k.glyph + k.label).join()}|${collapsed}|${inBar}|${tap}`;
    if (sig === this.keysSig) return;
    this.keysSig = sig;
    const items = (collapsed ? all.slice(0, 1) : all).map((k, i) => {
      const kids = [el('span', { class: `kg ${k.cls}` }, k.glyph), k.label];
      // the menu hint is a real button: tap it on a touch screen, click it with the mouse
      if (i === 0 && tap) return el('button', { class: 'kh kmenu', type: 'button', tabindex: '-1', 'aria-label': 'Open the menu', onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: () => this.onMenuTap?.() }, ...kids);
      return el('span', { class: 'kh' }, ...kids);
    });
    this.keysEl.className = `card keys${collapsed ? ' dim' : ''}${inBar && !collapsed ? ' vert' : ''}`;
    this.keysEl.replaceChildren(...items);
  }

  tel(lines: string[] | null) {
    if (lines) { const t = lines.join('\n'); if (t !== this.telText) { this.telText = t; this.telEl.textContent = t; } }
    this.show('tel', !!lines);
  }
  sticks(on: boolean) { this.show('sticks', on); }
  spectrum(on: boolean) { this.show('spec', on); }
  crash(text: string | null) {
    if (text && text !== this.crashText) { this.crashText = text; this.crashEl.textContent = text; }
    if (!text) this.crashText = '';
    this.show('crash', !!text);
  }
  /** The notice cards to show (persistent elements): the list is only re-attached when it changes. */
  notices(items: HTMLElement[]) {
    if (items.length !== this.noticeList.length || items.some((n, i) => n !== this.noticeList[i])) { this.noticeList = items.slice(); this.noticeEl.replaceChildren(...items); }
    this.show('notices', items.length > 0);
  }

  /** Arming coach card (disarmed only): why Betaflight won't arm and the fix, or first-flight steps. */
  coach(a: CoachAdvice | null) {
    const sig = adviceSig(a);
    if (sig !== this.coachSig) {
      this.coachSig = sig;
      if (a) {
        const kids: HTMLElement[] = [el('b', {}, a.title, a.osd ? el('span', { class: 'osd', title: 'As shown in the OSD and by the CLI status command' }, a.osd) : null)];
        if (a.why) kids.push(el('p', { class: 'why' }, a.why));
        kids.push(el('p', { class: 'fix' }, a.fix));
        if (a.steps) kids.push(el('ol', { class: 'steps', 'aria-label': 'First flight' }, ...a.steps.map((s, i) => el('li', { class: s.state },
          el('span', { class: 'n', 'aria-hidden': 'true' }, s.state === 'done' ? '✓' : String(i + 1)), s.text, s.glyph ? el('span', { class: 'kg key' }, s.glyph) : null,
          s.state === 'done' ? el('span', { class: 'sr-only' }, ' (done)') : null))));
        this.coachEl.replaceChildren(...kids);
      }
    }
    this.show('coach', !!a);
  }

  // -------------------------------------------------------------------------------------------
  /**
   * Place the visible widgets. osdCells: screen rects of drawn OSD characters (empty in spectator
   * views); frame: the video frame on screen (its letterbox bars are free space).
   */
  layout(osdCells: Rect[], frame: Rect | null) {
    const W = this.root.clientWidth || innerWidth, H = this.root.clientHeight || innerHeight;
    const osd = osdCells.map((r) => inflate(r, PAD_OSD));
    const placed: Rect[] = [];
    const out: typeof this.lastLayout = [];
    const barL = frame ? frame.x : 0, barR = frame ? W - (frame.x + frame.w) : 0;
    for (const [name, w] of Object.entries(this.w)) {
      if (!w.on) continue;
      const node = w.el;
      const tryPlace = (): Rect | null => {
        const ww = node.offsetWidth, hh = node.offsetHeight;
        for (const s of w.slots) for (const c of candidates(s, ww, hh, W, H, barL, barR)) {
          if (c.x < M - 0.5 || c.y < M - 0.5 || c.x + ww > W - M + 0.5 || c.y + hh > H - M + 0.5) continue;
          const r = { x: c.x, y: c.y, w: ww, h: hh };
          if (osd.some((o) => hit(o, r)) || placed.some((p) => hit(inflate(p, PAD_W), r))) continue;
          return r;
        }
        return null;
      };
      // key hints: try the vertical list (fits a letterbox bar), then the row, then the single chip
      let r: Rect | null = null;
      if (name === 'keys') {
        const { items, collapsed } = this.keysWant;
        if (!collapsed) { this.renderKeys(items, false, true); r = tryPlace(); }
        if (!r && !collapsed) { this.renderKeys(items, false, false); r = tryPlace(); }
        if (!r) { this.renderKeys(items, true, false); r = tryPlace(); }
      } else r = tryPlace();
      // notices and the coach: try a narrower card before giving up on the preferred spots
      if (name === 'notices' || name === 'coach') {
        if (!r) { node.classList.add('narrow'); r = tryPlace(); } else node.classList.remove('narrow');
      }
      if (!r && !w.optional) {
        // important (race / notices / crash): least-bad spot rather than nothing
        r = leastOverlap(w, node.offsetWidth, node.offsetHeight, W, H, barL, barR, osd, placed);
      }
      if (!r) { node.style.visibility = 'hidden'; continue; }
      node.style.visibility = '';
      node.style.left = `${Math.round(r.x)}px`; node.style.top = `${Math.round(r.y)}px`;
      placed.push(r);
      out.push({ name, rect: r, overlapsOsd: osdCells.some((o) => hit(o, r!)) });
    }
    this.lastLayout = out;
  }
}

function inflate(r: Rect, d: number): Rect { return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d }; }
function hit(a: Rect, b: Rect) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

/** Candidate top-left corners for a slot, best first. Edge slots slide along the edge to find gaps. */
function candidates(s: Slot, w: number, h: number, W: number, H: number, barL: number, barR: number): { x: number; y: number }[] {
  if ('bar' in s) {
    const bw = s.bar === 'left' ? barL : barR;
    if (bw < w + 2 * M) return [];
    const x = s.bar === 'left' ? Math.max(M, (barL - w) / 2) : W - barR + Math.max(M, (barR - w) / 2);
    return [{ x, y: s.at === 'top' ? M : H - h - M }];
  }
  if ('center' in s) return [{ x: (W - w) / 2, y: H * s.center - h / 2 }];
  const step = 12, list: { x: number; y: number; d: number }[] = [];
  if (s.edge === 'top' || s.edge === 'bottom') {
    const y = s.edge === 'top' ? M : H - h - M;
    const pref = s.pref === 'start' ? M : s.pref === 'end' ? W - w - M : (W - w) / 2;
    for (let x = M; x <= W - w - M; x += step) list.push({ x, y, d: Math.abs(x - pref) });
    list.push({ x: pref, y, d: -1 });
  } else {
    const x = s.edge === 'left' ? M : W - w - M;
    const pref = s.pref === 'start' ? M : s.pref === 'end' ? H - h - M : (H - h) / 2;
    for (let y = M; y <= H - h - M; y += step) list.push({ x, y, d: Math.abs(y - pref) });
    list.push({ x, y: pref, d: -1 });
  }
  return list.sort((a, b) => a.d - b.d);
}

/** Spot with the least OSD covered (and, after that, the least of the widgets already placed). */
function leastOverlap(w: Widget, ww: number, hh: number, W: number, H: number, barL: number, barR: number, osd: Rect[], placed: Rect[]): Rect | null {
  let best: Rect | null = null, bestA = Infinity;
  const area = (a: Rect, b: Rect) => { const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return ix > 0 && iy > 0 ? ix * iy : 0; };
  for (const s of w.slots) for (const c of candidates(s, ww, hh, W, H, barL, barR)) {
    const r = { x: Math.max(M, Math.min(W - ww - M, c.x)), y: Math.max(M, Math.min(H - hh - M, c.y)), w: ww, h: hh };
    let a = 0;
    for (const o of osd) a += 4 * area(o, r);
    for (const p of placed) a += area(inflate(p, PAD_W), r);
    if (a < bestA) { bestA = a; best = r; }
  }
  return best;
}

/** OSD character cells (row-major occupancy) -> screen rects, one per horizontal run. */
export function osdRects(occ: Uint8Array, cols: number, rows: number, osd: Rect): Rect[] {
  const cw = osd.w / cols, ch = osd.h / rows, out: Rect[] = [];
  for (let y = 0; y < rows; y++) {
    let x = 0;
    while (x < cols) {
      if (!occ[y * cols + x]) { x++; continue; }
      const x0 = x;
      while (x < cols && occ[y * cols + x]) x++;
      out.push({ x: osd.x + x0 * cw, y: osd.y + y * ch, w: (x - x0) * cw, h: ch });
    }
  }
  return out;
}
