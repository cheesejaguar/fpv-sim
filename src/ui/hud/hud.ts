// In-flight HUD: race / drill panel, key hints, telemetry, stick view, noise spectrum, crash banner,
// notices and the arming coach, styled like the game menu (hud.css). A small layout engine places
// every widget so it never covers a Betaflight OSD character: it prefers the letterbox bars beside
// 4:3 analog video, then slides along the screen edges to find a gap, collapses the key hints, and as
// a last resort hides low-priority widgets rather than draw over the OSD.
// Widgets are rebuilt only when what they show changes (the HUD is fed every frame), and laid out
// again only when something that matters to the layout changed.
import './hud.css';
import { el } from '../dom';
import { CoachAdvice, adviceSig } from './coach';

export interface Rect { x: number; y: number; w: number; h: number }
/** One key / button hint: glyph text, glyph style (key | a | b | x | y | sh), action label. */
export interface KeyHint { glyph: string; cls: string; label: string }
/** Lap panel. gates = 0: no course on this map, only the room roster (board) is shown. pb: the
 *  pilot's personal best here with this drone class (s); record: the global leaderboard's fastest. */
export interface RaceInfo {
  lap: number; last: number; best: number; gate: number; gates: number; room?: string;
  board?: { name: string; color: string; lap: number; best: number; me: boolean }[];
  pb?: number; record?: { initials: string; lap: number; mine: boolean };
}
export interface DrillInfo { inBox: boolean; offBy: number; elapsed: number; score: number; best: number }

type Edge = 'top' | 'bottom' | 'left' | 'right';
type Slot = { bar: 'left' | 'right'; at: 'top' | 'bottom' } | { edge: Edge; pref: 'start' | 'center' | 'end' } | { center: number };
interface Size { w: number; h: number }

/**
 * One placed widget. Its size is measured only when what it shows changed (dirty), once per
 * variant: the key hints come as a vertical list (fits a letterbox bar), a row and a single chip;
 * notices and the coach as a normal and a narrow card. Placement then works on those sizes alone,
 * and the DOM is written once at the end (only what changed), so a layout pass costs one forced
 * layout at most, and none while nothing on the HUD changes.
 */
interface Widget {
  name: string; el: HTMLElement; on: boolean; slots: Slot[]; optional: boolean; vertInBar?: boolean;
  dirty: boolean; sizes: (Size | null)[]; variant: number; x: number; y: number; hidden: boolean;
}

const M = 14;          // screen margin, px
const PAD_OSD = 6;     // clearance around OSD characters
const PAD_W = 8;       // clearance between HUD widgets
const FLASH_MS = 1600; // lap complete / new best highlight on the race card
const RELAYOUT_MS = 1000; // a full pass at least this often anyway (web fonts arriving, missed changes)
const KEYS_VERT = 0, KEYS_ROW = 1, KEYS_CHIP = 2, NARROW = 1;

export class Hud {
  // no aria-live here: telemetry changes every frame. Only notices, the coach and the crash banner speak.
  readonly root = el('div', { class: 'ghud' });
  private w: Record<string, Widget> = {};
  private order: Widget[] = [];
  private raceEl = el('div', { class: 'card race' });
  private keysEl = el('div', { class: 'card keys' });
  private telEl = el('div', { class: 'card tel' });
  private crashEl = el('div', { class: 'crash', role: 'alert' });
  private noticeEl = el('div', { class: 'notices', role: 'status' });
  private coachEl = el('div', { class: 'card coach', role: 'status' });
  private keysSig = '';
  private keysWant: { items: KeyHint[]; collapsed: boolean } = { items: [], collapsed: false };
  private keysItemsSig = '';
  private keysBuiltSig = '';
  private keysNodes: HTMLElement[] = [];
  private raceSig = '';
  private drillEls: { box: HTMLElement; score: HTMLElement; best: HTMLElement; gate: HTMLElement; bar: HTMLElement; barW: string } | null = null;
  private noticeList: HTMLElement[] = [];
  private telText = '';
  private telShape = '';
  private crashText = '';
  private coachSig = '';
  private coachLast: CoachAdvice | null = null;
  private visible = true;
  private prevLap = 0;
  private prevBest = Infinity;
  private flash: { kind: 'lap' | 'best'; until: number } | null = null;
  // what the last layout pass worked from: viewport, video frame, OSD rects, when it ran
  private vw = typeof innerWidth === 'number' ? innerWidth : 0;
  private vh = typeof innerHeight === 'number' ? innerHeight : 0;
  private laidW = -1; private laidH = -1;
  private laidFrame: Rect | null = null;
  private laidOsd: Rect[] = [];
  private laidAt = -Infinity;
  private relayout = true;
  /** Tap / click on the "Menu" key hint (touch screens have no Esc / Start). Wired by the app. */
  onMenuTap: (() => void) | null = null;
  /** Last layout, for tests / debugging: every placed widget and whether it touches the OSD. */
  lastLayout: { name: string; rect: Rect; overlapsOsd: boolean }[] = [];

  constructor(sticks: HTMLCanvasElement, spectrum: HTMLCanvasElement) {
    const add = (name: string, node: HTMLElement, slots: Slot[], optional = false, vertInBar = false) => {
      const wrap = el('div', { class: 'hw off', 'data-hud': name }, node);
      this.root.append(wrap);
      const w: Widget = { name, el: wrap, on: false, slots, optional, vertInBar, dirty: true, sizes: [], variant: -1, x: NaN, y: NaN, hidden: false };
      this.w[name] = w; this.order.push(w);
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
    // the viewport size without reading layout (the HUD is position: fixed over the whole window)
    if (typeof addEventListener === 'function') addEventListener('resize', () => { this.vw = innerWidth; this.vh = innerHeight; this.relayout = true; });
  }

  private show(name: string, on: boolean) { const w = this.w[name]; if (w.on !== on) { w.on = on; w.el.classList.toggle('off', !on); w.dirty = true; } }

  /** Something inside a widget changed size (e.g. a notice card's text, set by the app): measure it again. */
  invalidate(name: string) { const w = this.w[name]; if (w) w.dirty = true; }

  setVisible(v: boolean) { if (v !== this.visible) { this.visible = v; this.root.style.display = v ? '' : 'none'; if (v) this.relayout = true; } }

  race(r: RaceInfo | null, d: DrillInfo | null, now = performance.now()) {
    if (d) {
      // the drill card is built once, then only its texts change (they tick 10+ times a second)
      let e = this.drillEls;
      if (!e) {
        this.raceSig = '';
        const box = el('dd'), score = el('dd'), best = el('dd', { class: 'best' }), gate = el('div', { class: 'gate' }), bar = el('i');
        this.raceEl.className = 'card race drill';
        this.raceEl.replaceChildren(
          el('div', { class: 'lap' }, el('span', { class: 'k' }, 'HOVER DRILL')),
          el('dl', {}, el('dt', {}, 'Box'), box, el('dt', {}, 'Score'), score, el('dt', {}, 'Best'), best),
          gate, el('div', { class: 'bar' }, bar));
        e = this.drillEls = { box, score, best, gate, bar, barW: '' };
        this.w.race.dirty = true;
      }
      const boxCls = d.inBox ? 'inbox' : 'outbox';
      if (e.box.className !== boxCls) e.box.className = boxCls;
      const grew = sized(e.box, d.inBox ? 'IN' : `+${d.offBy.toFixed(1)} m`) | sized(e.score, `${d.score.toFixed(0)} %`)
        | sized(e.best, `${d.best.toFixed(0)} %`) | sized(e.gate, `${d.elapsed.toFixed(1)} / 30 s`);
      if (grew) this.w.race.dirty = true;
      const bw = `${Math.min(100, (d.elapsed / 30) * 100).toFixed(1)}%`;
      if (bw !== e.barW) { e.barW = bw; e.bar.style.width = bw; }
      this.show('race', true);
      return;
    }
    this.drillEls = null;
    if (!r) { this.raceSig = ''; this.show('race', false); return; }
    // a lap just completed: flash the card (rose glow, "NEW BEST" when it beat the previous best)
    if (r.lap > this.prevLap) this.flash = { kind: r.best < this.prevBest && this.prevBest < Infinity ? 'best' : 'lap', until: now + FLASH_MS };
    this.prevLap = r.lap; this.prevBest = r.best;
    const flash = this.flash && now < this.flash.until ? this.flash.kind : null;
    const t = (s: number) => (s > 0 && s < Infinity ? `${s.toFixed(2)} s` : '—');
    const board = r.board ?? [];
    const rec = r.record;
    const sig = `r|${r.lap}|${t(r.last)}|${t(r.best)}|${r.gate}/${r.gates}|${r.room ?? ''}|${flash ?? ''}|${board.map((b) => `${b.name}${b.color}${b.lap}${t(b.best)}${b.me}`).join(',')}|${t(r.pb ?? 0)}|${rec ? `${rec.initials}${t(rec.lap)}${rec.mine}` : ''}`;
    if (sig !== this.raceSig) {
      this.raceSig = sig;
      this.w.race.dirty = true;
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
          el('dl', {}, el('dt', {}, 'Last'), el('dd', {}, t(r.last)), el('dt', {}, 'Best'), el('dd', { class: 'best' }, t(r.best)),
            ...(r.pb ? [el('dt', { title: 'Your personal best on this track with this drone class' }, 'PB'), el('dd', {}, t(r.pb))] : []),
            ...(rec ? [el('dt', { title: 'Fastest lap on the global leaderboard for this drone class' }, 'Record'), el('dd', { class: rec.mine ? 'rec mine' : 'rec' }, el('span', { class: 'ini' }, rec.initials), t(rec.lap))] : [])),
          el('div', { class: 'gate' }, `Gate ${r.gate} / ${r.gates}`),
          el('div', { class: 'bar' }, el('i', { style: { width: `${(100 * (r.gate - 1)) / Math.max(1, r.gates)}%` } })),
        ];
        if (list) kids.push(list);
        this.raceEl.replaceChildren(...kids);
      }
    }
    this.show('race', true);
  }

  /** Key hints: full while disarmed, a single dim "menu" chip once flying (layout may collapse more).
   *  items[0] is the menu hint, the only one left when collapsed (a few seconds after arming). Pass
   *  the same array while the hints are the same: a new one is compared and measured again. */
  keys(items: KeyHint[], collapsed: boolean) {
    const want = this.keysWant;
    if (items !== want.items) {
      const sig = items.map((k) => k.glyph + k.label).join();
      if (sig !== this.keysItemsSig) { this.keysItemsSig = sig; this.w.keys.dirty = true; }
      want.items = items;
    }
    if (collapsed !== want.collapsed) { want.collapsed = collapsed; this.relayout = true; }
    this.show('keys', true);
  }

  /** Render one variant of the key hints (KEYS_VERT / KEYS_ROW / KEYS_CHIP), if it isn't already.
   *  The hint elements are built once per set of hints and shared by the variants. */
  private renderKeys(variant: number) {
    const tap = !!this.onMenuTap;
    const sig = `${this.keysItemsSig}|${variant}|${tap}`;
    if (sig === this.keysSig) return;
    this.keysSig = sig;
    const built = `${this.keysItemsSig}|${tap}`;
    if (built !== this.keysBuiltSig) {
      this.keysBuiltSig = built;
      this.keysNodes = this.keysWant.items.map((k, i) => {
        const kids = [el('span', { class: `kg ${k.cls}` }, k.glyph), k.label];
        // the menu hint is a real button: tap it on a touch screen, click it with the mouse
        if (i === 0 && tap) return el('button', { class: 'kh kmenu', type: 'button', tabindex: '-1', 'aria-label': 'Open the menu', onmousedown: (e: MouseEvent) => e.preventDefault(), onclick: () => this.onMenuTap?.() }, ...kids);
        return el('span', { class: 'kh' }, ...kids);
      });
    }
    const collapsed = variant === KEYS_CHIP, inBar = variant === KEYS_VERT;
    this.keysEl.className = `card keys${collapsed ? ' dim' : ''}${inBar ? ' vert' : ''}`;
    this.keysEl.replaceChildren(...(collapsed ? this.keysNodes.slice(0, 1) : this.keysNodes));
  }

  tel(lines: string[] | null) {
    if (lines) {
      const t = lines.join('\n');
      if (t !== this.telText) {
        this.telText = t; this.telEl.textContent = t;
        // monospace: the card's size follows the line count and the longest line only
        let longest = 0; for (const l of lines) if (l.length > longest) longest = l.length;
        const shape = `${lines.length}x${longest}`;
        if (shape !== this.telShape) { this.telShape = shape; this.w.tel.dirty = true; }
      }
    }
    this.show('tel', !!lines);
  }
  sticks(on: boolean) { this.show('sticks', on); }
  spectrum(on: boolean) { this.show('spec', on); }
  crash(text: string | null) {
    if (text && text !== this.crashText) { this.crashText = text; this.crashEl.textContent = text; this.w.crash.dirty = true; }
    if (!text) this.crashText = '';
    this.show('crash', !!text);
  }
  /** The notice cards to show (persistent elements): the list is only re-attached when it changes.
   *  A card's own text changing is reported with invalidate('notices'). */
  notices(items: HTMLElement[]) {
    if (items.length !== this.noticeList.length || items.some((n, i) => n !== this.noticeList[i])) { this.noticeList = items.slice(); this.noticeEl.replaceChildren(...items); this.w.notices.dirty = true; }
    this.show('notices', items.length > 0);
  }

  /** Arming coach card (disarmed only): why Betaflight won't arm and the fix, or first-flight steps.
   *  The same advice object as last time is taken as unchanged. */
  coach(a: CoachAdvice | null) {
    if (a !== this.coachLast) {
      this.coachLast = a;
      const sig = adviceSig(a);
      if (sig !== this.coachSig) {
        this.coachSig = sig;
        this.w.coach.dirty = true;
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
    }
    this.show('coach', !!a);
  }

  // -------------------------------------------------------------------------------------------
  /** Variants a widget is measured in (see Widget). */
  private variants(w: Widget): number[] {
    return w.name === 'keys' ? [KEYS_VERT, KEYS_ROW, KEYS_CHIP] : w.name === 'notices' || w.name === 'coach' ? [0, NARROW] : [0];
  }
  /** Put a widget's DOM into one of its variants. */
  private setVariant(w: Widget, v: number) {
    if (w.name === 'keys') this.renderKeys(v);
    else if (w.name === 'notices' || w.name === 'coach') w.el.classList.toggle('narrow', v === NARROW);
    w.variant = v;
  }

  /**
   * Place the visible widgets. osdCells: screen rects of drawn OSD characters (empty in spectator
   * views); frame: the video frame on screen (its letterbox bars are free space). Skipped while
   * nothing it depends on changed (at least once a second it runs anyway).
   */
  layout(osdCells: Rect[], frame: Rect | null, now = performance.now()) {
    const W = this.vw || this.root.clientWidth, H = this.vh || this.root.clientHeight;
    const resized = W !== this.laidW || H !== this.laidH;
    // the viewport sets the font size; once a second everything is measured again anyway (web
    // fonts arriving, a change nobody reported)
    const remeasure = resized || now - this.laidAt >= RELAYOUT_MS;
    let dirty = this.relayout || remeasure || !sameRect(frame, this.laidFrame) || !sameRects(osdCells, this.laidOsd);
    for (const w of this.order) if (w.on && w.dirty) dirty = true;
    if (!dirty) return;
    this.relayout = false; this.laidW = W; this.laidH = H; this.laidAt = now;
    this.laidFrame = frame ? { ...frame } : null; this.laidOsd = osdCells.map((r) => ({ ...r }));
    // ---- measure: the widgets whose content (or the viewport, which sets the font size) changed.
    // Plain widgets first, all read in one go (one layout); then the ones with variants.
    const need = this.order.filter((w) => w.on && (w.dirty || remeasure || !w.sizes.length));
    for (const w of need) if (this.variants(w).length === 1) w.sizes = [{ w: w.el.offsetWidth, h: w.el.offsetHeight }];
    for (const w of need) {
      const vs = this.variants(w);
      if (vs.length === 1) continue;
      w.sizes = [];
      for (const v of vs) { this.setVariant(w, v); w.sizes[v] = { w: w.el.offsetWidth, h: w.el.offsetHeight }; }
    }
    for (const w of need) w.dirty = false;
    // ---- place, from the sizes alone
    const osd = osdCells.map((r) => inflate(r, PAD_OSD));
    const placedPad: Rect[] = [];
    const out: typeof this.lastLayout = [];
    const barL = frame ? frame.x : 0, barR = frame ? W - (frame.x + frame.w) : 0;
    const plan: { w: Widget; v: number; r: Rect | null }[] = [];
    for (const w of this.order) {
      if (!w.on) continue;
      const tryPlace = (sz: Size | null): Rect | null => {
        if (!sz) return null;
        const ww = sz.w, hh = sz.h;
        for (const s of w.slots) for (const c of candidates(s, ww, hh, W, H, barL, barR)) {
          if (c.x < M - 0.5 || c.y < M - 0.5 || c.x + ww > W - M + 0.5 || c.y + hh > H - M + 0.5) continue;
          const r = { x: c.x, y: c.y, w: ww, h: hh };
          if (osd.some((o) => hit(o, r)) || placedPad.some((p) => hit(p, r))) continue;
          return r;
        }
        return null;
      };
      let r: Rect | null = null, v = 0;
      if (w.name === 'keys') {
        // key hints: the vertical list (fits a letterbox bar), then the row, then the single chip
        const collapsed = this.keysWant.collapsed;
        if (!collapsed) { v = KEYS_VERT; r = tryPlace(w.sizes[v]); }
        if (!r && !collapsed) { v = KEYS_ROW; r = tryPlace(w.sizes[v]); }
        if (!r) { v = KEYS_CHIP; r = tryPlace(w.sizes[v]); }
      } else if (w.name === 'notices' || w.name === 'coach') {
        // notices and the coach: a narrower card before giving up on the preferred spots
        r = tryPlace(w.sizes[0]);
        if (!r) { v = NARROW; r = tryPlace(w.sizes[v]); }
      } else r = tryPlace(w.sizes[0]);
      if (!r && !w.optional) {
        // important (race / notices / crash): least-bad spot rather than nothing
        const sz = w.sizes[v] ?? { w: 0, h: 0 };
        r = leastOverlap(w, sz.w, sz.h, W, H, barL, barR, osd, placedPad);
      }
      plan.push({ w, v, r });
      if (!r) continue;
      placedPad.push(inflate(r, PAD_W));
      out.push({ name: w.name, rect: r, overlapsOsd: osdCells.some((o) => hit(o, r!)) });
    }
    // ---- write: only what changed
    for (const { w, v, r } of plan) {
      if (w.variant !== v) this.setVariant(w, v);
      const hide = !r;
      if (hide !== w.hidden) { w.hidden = hide; w.el.style.visibility = hide ? 'hidden' : ''; }
      if (!r) continue;
      const x = Math.round(r.x), y = Math.round(r.y);
      if (x !== w.x) { w.x = x; w.el.style.left = `${x}px`; }
      if (y !== w.y) { w.y = y; w.el.style.top = `${y}px`; }
    }
    this.lastLayout = out;
  }
}

/** Set a text; true when its length changed (tabular digits: the box only grows or shrinks then). */
function sized(n: HTMLElement, t: string): number {
  const old = n.textContent ?? '';
  if (old === t) return 0;
  n.textContent = t;
  return old.length !== t.length ? 1 : 0;
}
function sameRect(a: Rect | null, b: Rect | null) { return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h); }
function sameRects(a: Rect[], b: Rect[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameRect(a[i], b[i])) return false;
  return true;
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
function leastOverlap(w: Widget, ww: number, hh: number, W: number, H: number, barL: number, barR: number, osd: Rect[], placedPad: Rect[]): Rect | null {
  let best: Rect | null = null, bestA = Infinity;
  const area = (a: Rect, b: Rect) => { const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return ix > 0 && iy > 0 ? ix * iy : 0; };
  for (const s of w.slots) for (const c of candidates(s, ww, hh, W, H, barL, barR)) {
    const r = { x: Math.max(M, Math.min(W - ww - M, c.x)), y: Math.max(M, Math.min(H - hh - M, c.y)), w: ww, h: hh };
    let a = 0;
    for (const o of osd) a += 4 * area(o, r);
    for (const p of placedPad) a += area(p, r);
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
