// Controller + keyboard navigation for the game menu ("couch" UX): the D-pad / left stick / arrow
// keys move focus spatially between controls, A / Enter activates, B / Esc goes back, LB / RB switch
// tabs, the right stick scrolls. Sliders and dropdowns are adjusted with left / right.
// Gamepads use the standard mapping (Xbox, DualSense, Steam Input, and our WebHID Steam driver).

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea, summary, [tabindex]:not([tabindex="-1"])';

export interface NavHooks {
  scope(): HTMLElement;           // the element whose controls are reachable (current screen)
  back(): void;
  tab(dir: -1 | 1): void;         // LB / RB
  scroller(): HTMLElement | null; // for the right stick
}

type Dir = 'up' | 'down' | 'left' | 'right';

const visible = (e: HTMLElement) => {
  if (e.closest('[hidden], .hidden, [inert]')) return false;
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

export function focusables(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

/** Spatial focus move: nearest control in that direction, favouring ones aligned with the current. */
export function moveFocus(scope: HTMLElement, dir: Dir, from: HTMLElement | null): HTMLElement | null {
  const all = focusables(scope);
  if (!all.length) return null;
  if (!from || !scope.contains(from)) return all[0];
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestCost = Infinity;
  for (const e of all) {
    if (e === from || e.contains(from) || from.contains(e)) continue;
    const b = e.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    let main: number, cross: number;
    // edge-to-edge distance along the move, centre offset across it
    if (dir === 'down') { main = b.top - a.bottom; cross = bx - ax; if (by <= ay + 1) continue; }
    else if (dir === 'up') { main = a.top - b.bottom; cross = bx - ax; if (by >= ay - 1) continue; }
    else if (dir === 'right') { main = b.left - a.right; cross = by - ay; if (bx <= ax + 1) continue; }
    else { main = a.left - b.right; cross = by - ay; if (bx >= ax - 1) continue; }
    // overlapping on the cross axis (same row / column) is strongly preferred
    const overlap = dir === 'up' || dir === 'down' ? Math.min(a.right, b.right) - Math.max(a.left, b.left) : Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    const cost = Math.max(0, main) + Math.abs(cross) * (overlap > 0 ? 0.3 : 2.5) + (overlap > 0 ? 0 : 40);
    if (cost < bestCost) { bestCost = cost; best = e; }
  }
  return best;
}

/** Mark the element focused by controller / keys so the focus ring shows even after mouse use. */
export function focusEl(e: HTMLElement | null) {
  if (!e) return;
  document.querySelectorAll('.gm .is-focus').forEach((x) => x.classList.remove('is-focus'));
  e.classList.add('is-focus');
  e.focus({ preventScroll: true });
  e.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  e.addEventListener('blur', () => e.classList.remove('is-focus'), { once: true });
}

/** Left / right on a slider or dropdown changes its value; returns true if handled. */
function adjust(e: HTMLElement, d: -1 | 1): boolean {
  if (e instanceof HTMLInputElement && e.type === 'range') {
    const step = parseFloat(e.step) || 1, min = parseFloat(e.min), max = parseFloat(e.max);
    const span = (max - min) / step;
    const n = span > 60 ? Math.round(span / 40) : 1; // coarse steps on very fine sliders
    e.value = String(Math.min(max, Math.max(min, parseFloat(e.value) + d * step * n)));
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (e instanceof HTMLSelectElement) {
    const i = Math.min(e.options.length - 1, Math.max(0, e.selectedIndex + d));
    if (i !== e.selectedIndex) { e.selectedIndex = i; e.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  }
  return false;
}

const isTextField = (e: Element | null) => e instanceof HTMLTextAreaElement || (e instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes(e.type));

export class MenuNav {
  private raf = 0;
  private prev: boolean[] = [];
  private held: { key: string; next: number } | null = null;
  enabled = false;
  /** true once a controller was used: the hint bar shows controller glyphs instead of keys */
  usingPad = false;
  onDevice: (() => void) | null = null;

  constructor(private hooks: NavHooks, private pads: () => Gamepad[]) {
    window.addEventListener('keydown', (e) => this.key(e), true);
  }

  start() { if (!this.enabled) { this.enabled = true; this.prev = []; this.raf = requestAnimationFrame(() => this.tick()); } }
  stop() { this.enabled = false; cancelAnimationFrame(this.raf); }

  private current(): HTMLElement | null {
    const a = document.activeElement as HTMLElement | null;
    return a && this.hooks.scope().contains(a) && a !== this.hooks.scope() ? a : null;
  }

  move(dir: Dir) {
    const cur = this.current();
    if (cur && (dir === 'left' || dir === 'right') && adjust(cur, dir === 'left' ? -1 : 1)) return;
    const next = moveFocus(this.hooks.scope(), dir, cur);
    if (next) focusEl(next);
  }

  activate() {
    const cur = this.current();
    if (!cur) { this.move('down'); return; }
    if (cur instanceof HTMLInputElement && (cur.type === 'checkbox' || cur.type === 'radio')) cur.click();
    else if (cur instanceof HTMLSelectElement) adjust(cur, 1);
    else if (isTextField(cur)) (cur as HTMLInputElement).select();
    else cur.click();
  }

  private key(e: KeyboardEvent) {
    if (!this.enabled || e.defaultPrevented) return;
    const t = e.target as Element | null;
    const typing = isTextField(t);
    const map: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (typing) (t as HTMLElement).blur(); else this.hooks.back(); this.setPad(false); return; }
    if (typing) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.move(map[e.key]); } return; }
    if (map[e.key]) {
      // native behaviour for sliders and dropdowns on left/right; selects open with Enter/Space
      if ((t instanceof HTMLInputElement && t.type === 'range') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault(); this.move(map[e.key]); this.setPad(false); return;
    }
    if (e.key === 'q' || e.key === 'Q' || e.key === 'PageUp') { this.hooks.tab(-1); e.preventDefault(); }
    if (e.key === 'e' || e.key === 'E' || e.key === 'PageDown') { this.hooks.tab(1); e.preventDefault(); }
    if (e.key === 'Backspace') { e.preventDefault(); this.hooks.back(); }
  }

  private setPad(on: boolean) { if (this.usingPad !== on) { this.usingPad = on; this.onDevice?.(); } }

  private tick() {
    if (!this.enabled) return;
    this.raf = requestAnimationFrame(() => this.tick());
    const pad = this.pads()[0];
    if (!pad) return;
    const b = pad.buttons.map((x) => x.pressed || x.value > 0.6);
    const ax = pad.axes;
    const rise = (i: number) => b[i] && !this.prev[i];
    // a fresh menu: ignore buttons that were already held when it opened
    if (!this.prev.length) { this.prev = b; return; }
    const now = performance.now();
    if (b.some((x, i) => x && !this.prev[i]) || Math.hypot(ax[0] ?? 0, ax[1] ?? 0) > 0.6) this.setPad(true);
    if (rise(0)) this.activate();
    if (rise(1)) this.hooks.back();
    if (rise(4)) this.hooks.tab(-1);
    if (rise(5)) this.hooks.tab(1);
    // directional input with key-repeat (350 ms delay, then every 110 ms)
    const lx = ax[0] ?? 0, ly = ax[1] ?? 0;
    const dir: Dir | null = b[12] || ly < -0.6 ? 'up' : b[13] || ly > 0.6 ? 'down' : b[14] || lx < -0.6 ? 'left' : b[15] || lx > 0.6 ? 'right' : null;
    if (!dir) this.held = null;
    else if (!this.held || this.held.key !== dir) { this.held = { key: dir, next: now + 350 }; this.move(dir); }
    else if (now >= this.held.next) { this.held.next = now + 110; this.move(dir); }
    // right stick scrolls long pages
    const ry = ax[3] ?? 0;
    if (Math.abs(ry) > 0.25) this.hooks.scroller()?.scrollBy({ top: ry * 18 });
    this.prev = b;
  }
}
