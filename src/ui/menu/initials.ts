// Arcade initials entry for the leaderboard: three letters A-Z. Controller: up / down change the
// letter, left / right (or LB / RB) move between letters, A saves, B skips. Keyboard: type the
// letters, arrows as on the pad, Backspace goes back a letter, Enter saves, Esc skips. Mouse: the
// arrows above and below each letter, a click on a letter selects it. It takes the pad and keys
// from MenuNav as an overlay (like the on-screen keyboard), drawn inline on the screen.
import { el } from '../dom';
import type { Dir, NavOverlay } from './nav';

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface InitialsState { letters: string[]; pos: number }
export type InitialsAction = { cycle: 1 | -1 } | { move: 1 | -1 } | { type: string } | { back: true };

export function initialsState(value: string): InitialsState {
  const v = /^[A-Z]{3}$/.test(value) ? value : 'AAA';
  return { letters: [...v], pos: 0 };
}

/** One edit. Typing a letter sets the selected one and moves on; there is never an empty slot. */
export function initialsEdit(s: InitialsState, a: InitialsAction): InitialsState {
  const letters = s.letters.slice(), n = letters.length;
  if ('cycle' in a) {
    const i = LETTERS.indexOf(letters[s.pos]);
    letters[s.pos] = LETTERS[(i + a.cycle + LETTERS.length) % LETTERS.length];
    return { letters, pos: s.pos };
  }
  if ('move' in a) return { letters, pos: Math.max(0, Math.min(n - 1, s.pos + a.move)) };
  if ('back' in a) return { letters, pos: Math.max(0, s.pos - 1) };
  const ch = a.type.toUpperCase();
  if (ch.length !== 1 || !LETTERS.includes(ch)) return s;
  letters[s.pos] = ch;
  return { letters, pos: Math.min(n - 1, s.pos + 1) };
}

const CSS = `
.lb-ini { display: inline-flex; gap: clamp(10px, 2vw, 18px); margin: 6px 0 14px; outline: none; }
.lb-ini .slot { display: grid; justify-items: center; gap: 4px; }
.lb-ini .ch { width: clamp(64px, 9vw, 92px); height: clamp(80px, 11vw, 112px); display: grid; place-items: center; border-radius: var(--gm-radius, 14px);
  font-family: var(--gm-font-display, inherit); font-size: clamp(44px, 6.4vw, 72px); line-height: 1; color: var(--gm-fg, #e2e8f0);
  background: var(--gm-bg-glass, rgba(15,15,35,.78)); border: 2px solid var(--gm-border-soft, rgba(167,139,250,.22)); cursor: pointer; user-select: none;
  transition: border-color 150ms, box-shadow 150ms, transform 150ms var(--gm-ease-back, ease); }
.lb-ini .slot.is-sel .ch { border-color: var(--gm-accent, #f43f5e); box-shadow: 0 0 0 2px var(--gm-accent, #f43f5e) inset, 0 0 28px rgba(244,63,94,.45); transform: translateY(-2px); }
.lb-ini.idle .slot.is-sel .ch { border-color: var(--gm-secondary, #a78bfa); box-shadow: none; transform: none; }
.lb-ini .arr { width: 44px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--gm-fg-muted, #94a3b8); font-size: 16px; cursor: pointer; }
.lb-ini .arr:hover { color: var(--gm-fg, #e2e8f0); background: rgba(167,139,250,.14); }
.lb-ini .slot:not(.is-sel) .arr { visibility: hidden; }
.lb-ini[aria-disabled=true] { opacity: .6; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .lb-ini .ch { transition: none; } }`;

function injectCss() {
  if (document.getElementById('lb-ini-css')) return;
  document.head.append(el('style', { id: 'lb-ini-css' }, CSS));
}

export interface InitialsHooks {
  /** A / Enter */
  confirm(value: string): void;
  /** B / Esc */
  skip(): void;
  /** hand the pad and keys to the entry (MenuNav.open); also when it is clicked or focused again after another control */
  reopen(entry: InitialsEntry): void;
}

export class InitialsEntry implements NavOverlay {
  readonly el: HTMLElement;
  private slots: { root: HTMLElement; ch: HTMLElement }[];
  private s: InitialsState;
  private live = false;
  private disabledV = false;
  onClose: (() => void) | null = null;

  constructor(initial: string, private hooks: InitialsHooks) {
    injectCss();
    this.s = initialsState(initial);
    this.slots = this.s.letters.map((_, i) => {
      const ch = el('span', { class: 'ch', onclick: () => { if (!this.disabledV) { this.s = { letters: this.s.letters, pos: i }; this.draw(); } } });
      const arrow = (d: 1 | -1) => el('button', { class: 'arr', type: 'button', tabindex: '-1', 'aria-label': d > 0 ? 'Next letter' : 'Previous letter', onclick: () => this.edit({ cycle: d }) }, d > 0 ? '▲' : '▼');
      const root = el('div', { class: 'slot', role: 'spinbutton', 'aria-label': `Letter ${i + 1} of 3` }, arrow(1), ch, arrow(-1));
      return { root, ch };
    });
    this.el = el('div', { class: 'lb-ini idle', role: 'group', 'aria-label': 'Your initials', tabindex: '0', 'data-autofocus': true }, ...this.slots.map((x) => x.root));
    // pointer or focus back on the widget after something else was used: it takes the pad + keys again
    const take = () => this.take();
    this.el.addEventListener('pointerdown', take);
    this.el.addEventListener('focusin', take);
    this.draw();
  }

  /** Take the pad and keys (MenuNav overlay) unless disabled or already holding them. */
  take() { if (!this.live && !this.disabledV) { this.hooks.reopen(this); this.setLive(true); } }

  get target(): HTMLElement { return this.el; }
  get value(): string { return this.s.letters.join(''); }

  /** MenuNav took it (true) or let go of it. */
  setLive(on: boolean) { this.live = on; this.el.classList.toggle('idle', !on); }
  set disabled(v: boolean) { this.disabledV = v; this.el.setAttribute('aria-disabled', String(v)); if (v) this.close(); }

  private edit(a: InitialsAction) {
    if (this.disabledV) return;
    this.s = initialsEdit(this.s, a);
    this.draw();
  }

  private draw() {
    this.slots.forEach((x, i) => {
      x.ch.textContent = this.s.letters[i];
      x.root.classList.toggle('is-sel', i === this.s.pos);
      x.root.setAttribute('aria-valuetext', this.s.letters[i]);
    });
  }

  // NavOverlay: the pad and keys while it is live
  move(dir: Dir) {
    if (dir === 'up' || dir === 'down') this.edit({ cycle: dir === 'up' ? 1 : -1 });
    else this.edit({ move: dir === 'left' ? -1 : 1 });
  }
  activate() { if (!this.disabledV) this.hooks.confirm(this.value); }
  back() { this.hooks.skip(); }
  /** X: back a letter, LB / RB: move */
  button(i: number) { if (i === 2) this.edit({ back: true }); else if (i === 4 || i === 5) this.edit({ move: i === 4 ? -1 : 1 }); }
  key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const dirs: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    // Enter on another focused control (Skip, Tab-ed to) is that control's
    const elsewhere = () => { const a = document.activeElement; return !!a && a !== document.body && !this.el.contains(a); };
    if (dirs[e.key]) this.move(dirs[e.key]);
    else if (e.key === 'Backspace') this.edit({ back: true });
    else if (e.key === 'Enter') { if (elsewhere()) return false; this.activate(); }
    else if (e.key.length === 1 && /[a-z]/i.test(e.key)) this.edit({ type: e.key });
    else return false; // Tab, Space on a button, …: the page handles them
    return true;
  }
  close() { const cb = this.onClose; this.onClose = null; this.setLive(false); cb?.(); }
}
