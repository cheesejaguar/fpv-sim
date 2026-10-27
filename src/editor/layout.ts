// The map builder's window layout, as in Unity and Unreal: a top bar, the Place panel docked left,
// the Outliner over the Details panel docked right, Problems / History docked under the viewport and
// a status bar along the bottom. Docks resize by their edges (double click: default size), fold
// away from the top bar, and keep their sizes in the builder's preferences. The 3D view shows
// through the viewport cell; the camera centres itself on it (EditorCamera.setViewport).
import { el } from '../ui/dom';
import { DEFAULT_PREFS, DOCK, type EditorPrefs } from './prefs';

export type DockName = 'left' | 'right' | 'bottom';

export class Docks {
  readonly root = el('div', { class: 'ed', role: 'application', 'aria-label': 'Map builder' });
  readonly bar = el('header', { class: 'ed-bar' });
  readonly left = el('aside', { class: 'ed-dock ed-left', 'aria-label': 'Place' });
  readonly right = el('aside', { class: 'ed-dock ed-right' });
  readonly outliner = el('section', { class: 'ed-pane ed-out-pane', 'aria-label': 'Outliner' });
  readonly details = el('section', { class: 'ed-pane ed-det-pane', 'aria-label': 'Details' });
  readonly bottom = el('section', { class: 'ed-dock ed-bottom', 'aria-label': 'Problems and history' });
  readonly status = el('footer', { class: 'ed-status' });
  /** the viewport cell: the canvas shows through; its overlays (toolbar, axis gizmo, box select) live here */
  readonly view = el('div', { class: 'ed-view' });
  readonly toast = el('div', { class: 'ed-toast', role: 'status', 'aria-live': 'polite' });
  private ro: ResizeObserver | null = null;

  constructor(private prefs: EditorPrefs, private onView: (r: DOMRect) => void, private onSaved: () => void) {
    const split = (cls: string, f: (dx: number, dy: number, start: Record<string, number>) => void, reset: () => void, start: () => Record<string, number>) => {
      const h = el('div', { class: `ed-split ${cls}`, role: 'separator', 'aria-orientation': cls.includes('h') ? 'horizontal' : 'vertical' });
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        const x0 = e.clientX, y0 = e.clientY, s0 = start();
        this.root.classList.add('ed-resizing');
        const move = (ev: PointerEvent) => { f(ev.clientX - x0, ev.clientY - y0, s0); this.apply(); };
        const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); this.root.classList.remove('ed-resizing'); this.onSaved(); };
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      });
      h.addEventListener('dblclick', () => { reset(); this.apply(); this.onSaved(); });
      return h;
    };
    const P = this.prefs, clamp = (v: number, [a, b]: readonly [number, number]) => Math.min(b, Math.max(a, v));
    this.left.append(split('v', (dx, _, s) => { P.left = clamp(s.v + dx, DOCK.left); }, () => { P.left = DEFAULT_PREFS.left; }, () => ({ v: P.left })));
    this.right.append(this.outliner,
      split('h inner', (_, dy, s) => { P.outlinerShare = Math.min(0.85, Math.max(0.15, s.v + dy / Math.max(1, this.right.clientHeight))); }, () => { P.outlinerShare = DEFAULT_PREFS.outlinerShare; }, () => ({ v: P.outlinerShare })),
      this.details,
      split('v', (dx, _, s) => { P.right = clamp(s.v - dx, DOCK.right); }, () => { P.right = DEFAULT_PREFS.right; }, () => ({ v: P.right })));
    this.bottom.append(split('h', (_, dy, s) => { P.bottom = clamp(s.v - dy, DOCK.bottom); }, () => { P.bottom = DEFAULT_PREFS.bottom; }, () => ({ v: P.bottom })));
    this.root.append(this.bar, this.left, this.view, this.right, this.bottom, this.status, this.toast);
    if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => { const r = this.view.getBoundingClientRect(); if (r.width > 0) this.onView(r); }); this.ro.observe(this.view); }
    this.apply();
  }

  /** Sizes and folded docks from the preferences onto the grid. */
  apply() {
    const P = this.prefs, s = this.root.style;
    s.setProperty('--ed-l', P.leftOpen ? `${P.left}px` : '0px');
    s.setProperty('--ed-r', P.rightOpen ? `${P.right}px` : '0px');
    s.setProperty('--ed-b', P.bottomOpen ? `${P.bottom}px` : '0px');
    s.setProperty('--ed-share', `${(P.outlinerShare * 100).toFixed(2)}%`);
    this.left.hidden = !P.leftOpen; this.right.hidden = !P.rightOpen; this.bottom.hidden = !P.bottomOpen;
    const r = this.view.getBoundingClientRect();
    if (r.width > 0) this.onView(r); // (not laid out yet: the resize observer reports it)
  }

  /** Open, close or flip a dock. */
  toggle(d: DockName, on?: boolean) {
    const k = `${d}Open` as const;
    this.prefs[k] = on ?? !this.prefs[k];
    this.apply(); this.onSaved();
  }

  dispose() { this.ro?.disconnect(); this.root.remove(); }
}
