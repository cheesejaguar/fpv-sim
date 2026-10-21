// Controller + keyboard navigation for the game menu ("couch" UX): the D-pad / left stick / arrow
// keys move focus spatially between controls, A / Enter activates, B / Esc goes back, LB / RB switch
// tabs, the right stick scrolls. Sliders are adjusted with left / right; A on a dropdown opens a list
// to pick from and A on a text field opens the on-screen keyboard (osk.ts), so passing over either
// never changes it. Gamepads use the standard mapping (Xbox, DualSense, Steam Input, and our WebHID
// Steam driver); other pads (radios, joysticks) get buttons, and once set up their calibrated roll /
// pitch stick, never raw axes (a throttle or switch rests at an end). The menu follows whichever pad
// was used last; the mouse wheel or a click silences a held stick until it is let go.
import { isStandard } from '../../input/gamepad';
import { el } from '../dom';
import { Osk } from './osk';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea, summary, [tabindex]:not([tabindex="-1"])';

export interface NavHooks {
  scope(): HTMLElement;           // the element whose controls are reachable (current screen)
  back(): void;
  tab(dir: -1 | 1): void;         // LB / RB
  scroller(): HTMLElement | null; // for the right stick
}

export type Dir = 'up' | 'down' | 'left' | 'right';

// ---------------------------------------------------------------------------------------------
// Lock: while the Controller tab listens to the pad (stick wizard, Detect, calibration) the pad
// belongs to it. Sweeping sticks must not move focus or drag sliders, and a radio switch that
// reports as button 1 must not act as Back. Keyboard and mouse keep working.

/** 'all': the pad drives nothing in the menu. 'sticks': sticks / D-pad / bumpers are ignored, A and B still work. */
export type NavLockLevel = 'all' | 'sticks';
export interface NavLock { level: NavLockLevel; release(): void }
const locks = new Set<NavLock>();

export function lockNav(level: NavLockLevel = 'all'): NavLock {
  const l: NavLock = { level, release: () => { locks.delete(l); } };
  locks.add(l);
  return l;
}

/** Strongest lock held, or null. */
export function navLockLevel(): NavLockLevel | null {
  let lv: NavLockLevel | null = null;
  for (const l of locks) { if (l.level === 'all') return 'all'; lv = 'sticks'; }
  return lv;
}

// ---------------------------------------------------------------------------------------------

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

/** Where controller / key focus last was: panels that re-render (a dropdown choice, a detected
 *  axis) replace the focused control, and the next press resumes there instead of at the top. */
let last: { el: HTMLElement; key?: string; x: number; y: number } | null = null;

/** Mark the element focused by controller / keys so the focus ring shows even after mouse use. */
export function focusEl(e: HTMLElement | null) {
  if (!e) return;
  document.querySelectorAll('.gm .is-focus').forEach((x) => x.classList.remove('is-focus'));
  e.classList.add('is-focus');
  e.focus({ preventScroll: true });
  e.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  e.addEventListener('blur', () => e.classList.remove('is-focus'), { once: true });
  const r = e.getBoundingClientRect();
  last = { el: e, key: e.dataset.key, x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** The control to resume on when nothing in scope has focus: the same one if it is still there,
 *  its re-rendered twin (same data-key), else the control now nearest to where focus was. */
function resume(scope: HTMLElement): HTMLElement | null {
  if (!last) return null;
  if (last.el.isConnected) return scope.contains(last.el) && visible(last.el) ? last.el : null;
  const all = focusables(scope);
  const twin = last.key ? all.find((e) => e.dataset.key === last!.key) : undefined;
  if (twin) return twin;
  let best: HTMLElement | null = null, bd = Infinity;
  for (const e of all) {
    const r = e.getBoundingClientRect(), d = Math.hypot(r.left + r.width / 2 - last.x, r.top + r.height / 2 - last.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** Left / right on a slider changes its value; returns true if handled. Dropdowns are not
 *  adjusted by passing over them (A opens a list instead). */
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
  return false;
}

const isTextField = (e: Element | null) => e instanceof HTMLTextAreaElement || (e instanceof HTMLInputElement && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(e.type));

/** A modal picker inside the menu (dropdown list, on-screen keyboard): it gets the pad and keys first. */
export interface NavOverlay {
  readonly target: HTMLElement;     // the control it edits: the overlay closes if that leaves the page
  readonly el: HTMLElement;
  move(dir: Dir): void;
  activate(): void;                 // A
  back(): void;                     // B / Esc
  button?(i: number): void;         // other pad buttons (OSK: X backspace, Y space, LB / RB caret)
  key?(e: KeyboardEvent): boolean;  // a key while open; true = handled (default prevented)
  close(): void;                    // remove it; calls onClose
  onClose: (() => void) | null;
}

// ---------------------------------------------------------------------------------------------
// Dropdown list for the pad: native <select> popups can't be driven by a gamepad.

const PICK_CSS = `
.nav-pick { position: fixed; z-index: 80; min-width: 220px; max-height: 50vh; overflow: auto; margin: 0; padding: 6px; list-style: none;
  border-radius: var(--gm-radius-sm, 9px); background: var(--gm-card-hi, #262347); border: 1px solid var(--gm-border, #4c1d95);
  box-shadow: var(--gm-shadow, 0 18px 40px rgba(0,0,0,.45)); color: var(--gm-fg, #e2e8f0); font-size: 15px; }
.nav-pick li { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 7px; cursor: pointer; }
.nav-pick li:hover { background: rgba(167, 139, 250, 0.16); }
.nav-pick li.is-sel { background: var(--gm-primary, #7c3aed); color: #fff; }
.nav-pick li[data-current]::after { content: '✓'; margin-left: auto; }
.nav-pick li[aria-disabled=true] { opacity: .45; cursor: default; }
.nav-pick-hint { padding: 6px 12px 2px; font-size: 12px; color: var(--gm-fg-muted, #94a3b8); }`;

function injectCss(id: string, css: string) {
  if (document.getElementById(id)) return;
  document.head.append(el('style', { id }, css));
}

let pickSeq = 0;

export class SelectPicker implements NavOverlay {
  readonly el: HTMLElement;
  private items: HTMLElement[];
  private i: number;
  onClose: (() => void) | null = null;

  constructor(readonly target: HTMLSelectElement, host: HTMLElement) {
    injectCss('nav-pick-css', PICK_CSS);
    const name = target.getAttribute('aria-label') || target.labels?.[0]?.textContent?.trim() || 'Choose';
    const id = `nav-pick-${++pickSeq}`;
    this.items = [...target.options].map((o, i) => el('li', {
      id: `${id}-${i}`, role: 'option', 'aria-selected': 'false', 'aria-disabled': o.disabled ? 'true' : undefined, 'data-current': i === target.selectedIndex || undefined,
      // keep focus on the select (no blur flicker); a click picks
      onpointerdown: (e: Event) => e.preventDefault(), onclick: () => { if (!o.disabled) { this.i = i; this.activate(); } },
    }, o.textContent ?? ''));
    this.el = el('ul', { class: 'nav-pick', role: 'listbox', id, 'aria-label': name }, ...this.items,
      el('li', { class: 'nav-pick-hint', role: 'presentation', 'aria-hidden': 'true' }, 'A choose · B cancel'));
    target.setAttribute('aria-expanded', 'true');
    target.setAttribute('aria-controls', id);
    host.append(this.el);
    // under the dropdown, or above it when there is no room below
    const r = target.getBoundingClientRect(), below = innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 200 && above > below;
    Object.assign(this.el.style, { left: `${Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 220) - 8))}px`, minWidth: `${Math.max(220, r.width)}px`, maxHeight: `${Math.max(160, Math.min(innerHeight * 0.6, up ? above : below))}px` });
    if (up) this.el.style.bottom = `${innerHeight - r.top + 4}px`; else this.el.style.top = `${r.bottom + 4}px`;
    this.i = Math.max(0, target.selectedIndex);
    this.show();
  }

  private show() {
    this.items.forEach((x, k) => { x.classList.toggle('is-sel', k === this.i); x.setAttribute('aria-selected', String(k === this.i)); });
    this.target.setAttribute('aria-activedescendant', this.items[this.i]?.id ?? '');
    this.items[this.i]?.scrollIntoView({ block: 'nearest' });
  }

  /** Nearest enabled option from `from` going `d` (inclusive), clamped at the ends. */
  private step(d: 1 | -1, from = this.i + d) {
    for (let k = from; k >= 0 && k < this.items.length; k += d) if (!this.target.options[k].disabled) { this.i = k; break; }
    this.show();
  }

  move(dir: Dir) { if (dir === 'up') this.step(-1); else if (dir === 'down') this.step(1); }

  activate() {
    const s = this.target, changed = this.i !== s.selectedIndex;
    this.close();
    if (changed) {
      s.selectedIndex = this.i;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (s.isConnected) focusEl(s);
  }

  back() { this.close(); if (this.target.isConnected) focusEl(this.target); }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'ArrowUp') this.step(-1);
    else if (e.key === 'ArrowDown') this.step(1);
    else if (e.key === 'Home') this.step(1, 0);
    else if (e.key === 'End') this.step(-1, this.items.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') this.activate();
    else if (e.key === 'Tab') { this.close(); return false; }
    else return e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    return true;
  }

  close() {
    this.el.remove();
    this.target.removeAttribute('aria-expanded'); this.target.removeAttribute('aria-controls'); this.target.removeAttribute('aria-activedescendant');
    const cb = this.onClose; this.onClose = null; cb?.();
  }
}

// ---------------------------------------------------------------------------------------------

interface PadState { b: boolean[]; stick: boolean; dir: Dir | null }

/** Direction of a push on axes 0 / 1 (left stick on standard pads). */
const axisDir = (x = 0, y = 0): Dir | null => (y < -0.6 ? 'up' : y > 0.6 ? 'down' : x < -0.6 ? 'left' : x > 0.6 ? 'right' : null);

export class MenuNav {
  private raf = 0;
  private padPrev = new Map<string, PadState>();
  private padKey: string | null = null;
  private held: { key: string; next: number } | null = null;
  /** D-pad buttons / left+right stick held when the menu opened or while a lock was on (the stick
   *  just detected is still pushed): they count again only once let go. */
  private mute = new Set<number>();
  private muteStick = false;
  private overlay: NavOverlay | null = null;
  enabled = false;
  /** true once a controller was used: the hint bar shows controller glyphs instead of keys */
  usingPad = false;
  onDevice: (() => void) | null = null;

  /** stick: a non-standard pad's set-up roll / pitch (-1..1, y down), or null (see InputManager.navStick) */
  constructor(private hooks: NavHooks, private pads: () => Gamepad[], private stick: (g: Gamepad) => [number, number] | null = () => null) {
    window.addEventListener('keydown', (e) => this.key(e), true);
    // a click anywhere else dismisses an open list / keyboard (mouse users)
    window.addEventListener('pointerdown', (e) => {
      const o = this.overlay, t = e.target as Node | null;
      if (o && t && !o.el.contains(t) && !o.target.contains(t)) o.close();
      this.mouseTookOver();
    }, true);
    window.addEventListener('wheel', () => this.mouseTookOver(), { capture: true, passive: true });
  }

  /** Mouse / trackpad in use: a stick held now must not fight it (scrolling, moving focus) until let go. */
  private mouseTookOver() { this.muteStick = true; this.held = null; }

  start() { if (!this.enabled) { this.enabled = true; this.padPrev.clear(); this.held = null; this.raf = requestAnimationFrame(() => this.tick()); } }
  stop() { this.enabled = false; cancelAnimationFrame(this.raf); this.overlay?.close(); }

  /** Open dropdown list or on-screen keyboard, if any. */
  get openOverlay(): NavOverlay | null { return this.overlay; }

  private current(): HTMLElement | null {
    const a = document.activeElement as HTMLElement | null;
    return a && this.hooks.scope().contains(a) && a !== this.hooks.scope() ? a : null;
  }

  private host(): HTMLElement { return this.hooks.scope().closest<HTMLElement>('.gm') ?? document.body; }

  private open(o: NavOverlay) {
    this.overlay?.close();
    this.overlay = o;
    o.onClose = () => { if (this.overlay === o) this.overlay = null; };
  }

  move(dir: Dir) {
    if (this.overlay) { this.overlay.move(dir); return; }
    const scope = this.hooks.scope();
    const cur = this.current();
    if (cur && (dir === 'left' || dir === 'right') && adjust(cur, dir === 'left' ? -1 : 1)) return;
    const next = cur ? moveFocus(scope, dir, cur) : resume(scope) ?? moveFocus(scope, dir, null);
    if (next) focusEl(next);
  }

  activate() {
    if (this.overlay) { this.overlay.activate(); return; }
    const cur = this.current();
    if (!cur) { this.move('down'); return; }
    if (cur instanceof HTMLInputElement && (cur.type === 'checkbox' || cur.type === 'radio')) cur.click();
    else if (cur instanceof HTMLSelectElement) this.open(new SelectPicker(cur, this.host()));
    else if (cur instanceof HTMLInputElement && isTextField(cur)) {
      if (cur.readOnly) cur.select(); // e.g. an invite link: select it for copying
      else this.open(new Osk(cur, this.host(), moveFocus));
    } else if (cur instanceof HTMLTextAreaElement) cur.focus();
    else cur.click();
  }

  private key(e: KeyboardEvent) {
    if (!this.enabled || e.defaultPrevented) return;
    const t = e.target as Element | null;
    const o = this.overlay;
    if (o) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); o.back(); }
      else if (o.key?.(e)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    const typing = isTextField(t);
    const map: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (typing) (t as HTMLElement).blur(); else this.hooks.back(); this.setPad(false); return; }
    if (typing) {
      // a single-line field hands up / down to the menu; a textarea (the diff box) keeps them for its lines
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !(t instanceof HTMLTextAreaElement)) { e.preventDefault(); this.move(map[e.key]); }
      return;
    }
    if (map[e.key]) {
      // native left / right on sliders; dropdowns open with Enter / Space, arrows move on
      if ((t instanceof HTMLInputElement && t.type === 'range') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault(); this.move(map[e.key]); this.setPad(false); return;
    }
    if (e.key === 'q' || e.key === 'Q' || e.key === 'PageUp') { this.hooks.tab(-1); e.preventDefault(); }
    if (e.key === 'e' || e.key === 'E' || e.key === 'PageDown') { this.hooks.tab(1); e.preventDefault(); }
    if (e.key === 'Backspace') { e.preventDefault(); this.hooks.back(); }
  }

  private setPad(on: boolean) { if (this.usingPad !== on) { this.usingPad = on; this.onDevice?.(); } }

  /** The pad driving the menu: the newest button press (or stick push on a standard pad, since a
   *  radio's axes rest anywhere), else the first listed (InputManager lists its active pad first). */
  private pick(pads: Gamepad[]): { g: Gamepad; b: boolean[]; prev: PadState | null } | null {
    const snaps = pads.map((g) => ({
      g, k: `${g.index}|${g.id}`, b: g.buttons.map((x) => x.pressed || x.value > 0.6),
      stick: isStandard(g) && Math.hypot(g.axes[0] ?? 0, g.axes[1] ?? 0) > 0.6, dir: axisDir(g.axes[0], g.axes[1]),
    }));
    const before = this.padKey;
    for (const s of snaps) {
      const p = this.padPrev.get(s.k);
      if (p && (s.b.some((x, i) => x && !p.b[i]) || (s.stick && !p.stick))) this.padKey = s.k;
    }
    const s = snaps.find((x) => x.k === this.padKey) ?? snaps[0];
    const prev = s ? this.padPrev.get(s.k) ?? null : null;
    this.padPrev = new Map(snaps.map((x) => [x.k, { b: x.b, stick: x.stick, dir: x.dir }])); // forgets unplugged pads
    if (!s) return null;
    this.padKey = s.k;
    if (s.k !== before) this.held = null;
    return { g: s.g, b: s.b, prev };
  }

  private tick() {
    if (!this.enabled) return;
    this.raf = requestAnimationFrame(() => this.tick());
    if (this.overlay && !this.overlay.target.isConnected) this.overlay.close();
    const cur = this.pick(this.pads());
    if (!cur) return;
    const { g: pad, b } = cur, std = isStandard(pad), ax = pad.axes;
    // the left stick on a standard pad; elsewhere the set-up roll / pitch stick, or nothing
    const xy = std ? [ax[0] ?? 0, ax[1] ?? 0] : this.stick(pad);
    const stickDir = xy ? axisDir(xy[0], xy[1]) : null, ry = std ? ax[3] ?? 0 : 0;
    const lock = navLockLevel();
    // a fresh menu, a pad seen for the first time, or a lock: what is held now must be let go first
    if (!cur.prev || lock) {
      this.mute = new Set([12, 13, 14, 15].filter((i) => b[i]));
      this.muteStick = !!stickDir || Math.abs(ry) > 0.25;
      this.held = null;
    }
    if (!cur.prev || lock === 'all') return;
    const prev = cur.prev.b;
    const rise = (i: number) => b[i] && !prev[i];
    const now = performance.now();
    if (b.some((x, i) => x && !prev[i]) || (!!stickDir && !this.muteStick)) this.setPad(true);
    if (rise(0)) this.activate();
    if (rise(1)) { if (this.overlay) this.overlay.back(); else this.hooks.back(); }
    if (lock === 'sticks') return;
    if (this.overlay) { for (const i of [2, 3, 4, 5]) if (rise(i)) this.overlay?.button?.(i); }
    else { if (rise(4)) this.hooks.tab(-1); if (rise(5)) this.hooks.tab(1); }
    for (const i of this.mute) if (!b[i]) this.mute.delete(i);
    if (this.muteStick && !stickDir && Math.abs(ry) <= 0.25) this.muteStick = false;
    // directional input with key-repeat (350 ms delay, then every 110 ms). Indices 12-15 are the
    // D-pad only on the standard layout (a radio's buttons are its channels 9-16)
    const on = (i: number) => std && b[i] && !this.mute.has(i);
    const btnDir: Dir | null = on(12) ? 'up' : on(13) ? 'down' : on(14) ? 'left' : on(15) ? 'right' : null;
    const dir = btnDir ?? (this.muteStick ? null : stickDir);
    if (!dir) this.held = null;
    else if (!this.held || this.held.key !== dir) { this.held = { key: dir, next: now + 350 }; this.move(dir); }
    else if (now >= this.held.next) { this.held.next = now + 110; this.move(dir); }
    // right stick scrolls long pages (standard pads: elsewhere axis 3 can be any resting channel)
    if (!this.overlay && std && !this.muteStick && Math.abs(ry) > 0.25) this.hooks.scroller()?.scrollBy({ top: ry * 18 });
  }
}
