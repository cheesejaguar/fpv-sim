// In-flight HUD: race / drill panel, key hints, telemetry, stick view, noise spectrum, crash banner
// and notices, styled like the game menu (hud.css). A small layout engine places every widget so it
// never covers a Betaflight OSD character: it prefers the letterbox bars beside 4:3 analog video,
// then slides along the screen edges to find a gap, collapses the key hints, and as a last resort
// hides low-priority widgets rather than draw over the OSD.
import './hud.css';
import { el } from '../dom';

export interface Rect { x: number; y: number; w: number; h: number }
/** One key / button hint: glyph text, glyph style (key | a | b | x | y | sh), action label. */
export interface KeyHint { glyph: string; cls: string; label: string }
export interface RaceInfo { lap: number; last: number; best: number; gate: number; gates: number; board?: { name: string; color: string; lap: number; best: number; me: boolean }[] }
export interface DrillInfo { inBox: boolean; offBy: number; elapsed: number; score: number; best: number }

type Edge = 'top' | 'bottom' | 'left' | 'right';
type Slot = { bar: 'left' | 'right'; at: 'top' | 'bottom' } | { edge: Edge; pref: 'start' | 'center' | 'end' } | { center: number };

interface Widget { el: HTMLElement; on: boolean; slots: Slot[]; optional: boolean; vertInBar?: boolean }

const M = 14;          // screen margin, px
const PAD_OSD = 6;     // clearance around OSD characters
const PAD_W = 8;       // clearance between HUD widgets

export class Hud {
  readonly root = el('div', { class: 'ghud', 'aria-live': 'polite' });
  private w: Record<string, Widget> = {};
  private raceEl = el('div', { class: 'card race' });
  private keysEl = el('div', { class: 'card keys' });
  private telEl = el('div', { class: 'card tel' });
  private crashEl = el('div', { class: 'crash' });
  private noticeEl = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' } });
  private keysSig = '';
  private keysWant: { items: KeyHint[]; collapsed: boolean } = { items: [], collapsed: false };
  /** Last layout, for tests / debugging: every placed widget and whether it touches the OSD. */
  lastLayout: { name: string; rect: Rect; overlapsOsd: boolean }[] = [];

  constructor(sticks: HTMLCanvasElement, spectrum: HTMLCanvasElement) {
    const add = (name: string, node: HTMLElement, slots: Slot[], optional = false, vertInBar = false) => {
      const wrap = el('div', { class: 'hw off', 'data-hud': name }, node);
      this.root.append(wrap);
      this.w[name] = { el: wrap, on: false, slots, optional, vertInBar };
    };
    // order = placement priority
    add('crash', this.crashEl, [{ center: 0.3 }, { center: 0.5 }, { edge: 'top', pref: 'center' }]);
    add('notices', this.noticeEl, [{ center: 0.62 }, { edge: 'bottom', pref: 'center' }, { center: 0.4 }, { edge: 'left', pref: 'center' }, { edge: 'right', pref: 'center' }, { edge: 'top', pref: 'center' }]);
    add('race', this.raceEl, [{ bar: 'left', at: 'top' }, { bar: 'right', at: 'top' }, { edge: 'top', pref: 'center' }, { edge: 'left', pref: 'center' }, { edge: 'right', pref: 'center' }, { edge: 'bottom', pref: 'center' }]);
    add('tel', this.telEl, [{ bar: 'right', at: 'top' }, { edge: 'right', pref: 'start' }, { edge: 'left', pref: 'start' }, { edge: 'top', pref: 'end' }, { edge: 'bottom', pref: 'end' }], true);
    add('sticks', el('div', { class: 'card sticks' }, sticks), [{ bar: 'right', at: 'bottom' }, { edge: 'bottom', pref: 'end' }, { edge: 'right', pref: 'end' }, { edge: 'left', pref: 'end' }], true);
    add('spec', el('div', { class: 'card spec' }, spectrum), [{ bar: 'left', at: 'bottom' }, { edge: 'bottom', pref: 'start' }, { edge: 'left', pref: 'end' }, { edge: 'right', pref: 'end' }], true);
    add('keys', this.keysEl, [{ bar: 'left', at: 'bottom' }, { bar: 'right', at: 'bottom' }, { edge: 'bottom', pref: 'center' }, { edge: 'top', pref: 'center' }, { edge: 'left', pref: 'end' }, { edge: 'right', pref: 'end' }], true, true);
  }

  private show(name: string, on: boolean) { const w = this.w[name]; if (w.on !== on) { w.on = on; w.el.classList.toggle('off', !on); } }

  setVisible(v: boolean) { this.root.style.display = v ? '' : 'none'; }

  race(r: RaceInfo | null, d: DrillInfo | null) {
    if (d) {
      this.raceEl.className = 'card race drill';
      this.raceEl.replaceChildren(
        el('div', { class: 'lap' }, el('span', { class: 'k' }, 'HOVER DRILL')),
        el('dl', {},
          el('dt', {}, 'Box'), el('dd', { class: d.inBox ? 'inbox' : 'outbox' }, d.inBox ? 'IN' : `+${d.offBy.toFixed(1)} m`),
          el('dt', {}, 'Score'), el('dd', {}, `${d.score.toFixed(0)} %`),
          el('dt', {}, 'Best'), el('dd', { class: 'best' }, `${d.best.toFixed(0)} %`)),
        el('div', { class: 'gate' }, `${d.elapsed.toFixed(1)} / 30 s`), el('div', { class: 'bar' }, el('i', { style: { width: `${Math.min(100, (d.elapsed / 30) * 100)}%` } })));
      this.show('race', true);
      return;
    }
    if (!r) { this.show('race', false); return; }
    const t = (s: number) => (s > 0 && s < Infinity ? `${s.toFixed(2)} s` : '—');
    this.raceEl.className = 'card race';
    const kids = [
      el('div', { class: 'lap' }, el('span', { class: 'k' }, 'LAP'), el('span', { class: 'v' }, String(r.lap))),
      el('dl', {}, el('dt', {}, 'Last'), el('dd', {}, t(r.last)), el('dt', {}, 'Best'), el('dd', { class: 'best' }, t(r.best))),
      el('div', { class: 'gate' }, `Gate ${r.gate} / ${r.gates}`),
      el('div', { class: 'bar' }, el('i', { style: { width: `${(100 * (r.gate - 1)) / Math.max(1, r.gates)}%` } })),
      r.board?.length ? el('ol', { class: 'board' }, ...r.board.map((b, i) => el('li', { class: b.me ? 'me' : '' },
        el('span', {}, `${i + 1}`), el('span', { class: 'dot', style: { background: b.color } }), el('span', {}, b.name), el('span', {}, b.best < Infinity ? b.best.toFixed(2) : '—')))) : null,
    ].filter((n) => n !== null) as HTMLElement[];
    this.raceEl.replaceChildren(...kids);
    this.show('race', true);
  }

  /** Key hints: full while disarmed, a single dim "menu" chip once flying (layout may collapse more). */
  /** items[0] is the menu hint, the only one left when collapsed (a few seconds after arming). */
  keys(items: KeyHint[], collapsed: boolean) { this.keysWant = { items, collapsed }; this.show('keys', true); }

  private renderKeys(all: KeyHint[], collapsed: boolean, inBar: boolean) {
    const sig = `${all.map((k) => k.glyph + k.label).join()}|${collapsed}|${inBar}`;
    if (sig === this.keysSig) return;
    this.keysSig = sig;
    const items = (collapsed ? all.slice(0, 1) : all).map((k) => el('span', { class: 'kh' }, el('span', { class: `kg ${k.cls}` }, k.glyph), k.label));
    this.keysEl.className = `card keys${collapsed ? ' dim' : ''}${inBar && !collapsed ? ' vert' : ''}`;
    this.keysEl.replaceChildren(...items);
  }

  tel(lines: string[] | null) { if (lines) this.telEl.textContent = lines.join('\n'); this.show('tel', !!lines); }
  sticks(on: boolean) { this.show('sticks', on); }
  spectrum(on: boolean) { this.show('spec', on); }
  crash(text: string | null) { if (text) this.crashEl.textContent = text; this.show('crash', !!text); }
  notices(items: HTMLElement[]) { this.noticeEl.replaceChildren(...items); this.show('notices', items.length > 0); }

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
      if (!r && name === 'notices') { node.classList.add('narrow'); r = tryPlace(); }
      else if (r && name === 'notices') node.classList.remove('narrow');
      if (!r && !w.optional) {
        // important (race / notices / crash): least-bad spot rather than nothing
        r = leastOverlap(w, node.offsetWidth, node.offsetHeight, W, H, barL, barR, osd);
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

function leastOverlap(w: Widget, ww: number, hh: number, W: number, H: number, barL: number, barR: number, osd: Rect[]): Rect | null {
  let best: Rect | null = null, bestA = Infinity;
  for (const s of w.slots) for (const c of candidates(s, ww, hh, W, H, barL, barR)) {
    const r = { x: Math.max(M, Math.min(W - ww - M, c.x)), y: Math.max(M, Math.min(H - hh - M, c.y)), w: ww, h: hh };
    let a = 0;
    for (const o of osd) { const ix = Math.min(o.x + o.w, r.x + r.w) - Math.max(o.x, r.x), iy = Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y); if (ix > 0 && iy > 0) a += ix * iy; }
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
