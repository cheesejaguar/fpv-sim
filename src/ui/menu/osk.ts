// On-screen keyboard for text entry with a controller (callsign, room code, room search, CLI line).
// MenuNav opens it when A is pressed on a text field. The field keeps DOM focus the whole time, so
// its caret stays visible and a physical keyboard still types into it; the OSK only highlights a
// key. D-pad / stick move, A types, X backspace, Y space, LB / RB move the cursor, B closes.
// Room-code fields (class / label / placeholder "code", or data-osk="code") get uppercase A-Z 0-9.
import { el } from '../dom';
import type { Dir, NavOverlay } from './nav';

export type OskMode = 'text' | 'code' | 'number';
export type OskAction = 'shift' | 'back' | 'space' | 'enter' | 'done' | 'left' | 'right';
export interface OskKey { label: string; ch?: string; act?: OskAction; grow?: number; aria?: string }

const chars = (s: string): OskKey[] => [...s].map((c) => ({ label: c, ch: c }));
const K = {
  shift: { label: '⇧', act: 'shift', grow: 1.4, aria: 'Shift' },
  back: { label: '⌫', act: 'back', grow: 1.4, aria: 'Backspace' },
  space: { label: 'Space', act: 'space', grow: 5, aria: 'Space' },
  left: { label: '◀', act: 'left', aria: 'Cursor left' },
  right: { label: '▶', act: 'right', aria: 'Cursor right' },
  enter: { label: '⏎ Enter', act: 'enter', grow: 2, aria: 'Enter' },
  done: { label: '✓ Done', act: 'done', grow: 2, aria: 'Done' },
} satisfies Record<string, OskKey>;

/** Key rows for a mode. Text mode is lowercase unless shifted. */
export function oskRows(mode: OskMode, shift = false): OskKey[][] {
  if (mode === 'number') return [chars('123'), chars('456'), chars('789'), [...chars('-0.'), K.back], [K.left, K.right, K.enter, K.done]];
  if (mode === 'code') return [chars('1234567890'), chars('QWERTYUIOP'), chars('ASDFGHJKL'), [...chars('ZXCVBNM'), K.back], [K.left, K.right, K.enter, K.done]];
  const c = (s: string) => chars(shift ? s.toUpperCase() : s);
  return [chars('1234567890'), c('qwertyuiop'), c('asdfghjkl'), [K.shift, ...c('zxcvbnm'), K.back], chars('-_=.,:/#\'@'), [K.left, K.right, K.space, K.enter, K.done]];
}

/** Which layout a field wants. */
export function oskModeFor(i: { type: string; className: string; placeholder: string; name?: string; dataset?: DOMStringMap; getAttribute(n: string): string | null }): OskMode {
  const d = i.dataset?.osk;
  if (d === 'code' || d === 'text' || d === 'number') return d;
  if (i.type === 'number') return 'number';
  return /\bcode\b/i.test(`${i.className} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''} ${i.name ?? ''}`) ? 'code' : 'text';
}

export interface OskText { value: string; caret: number; end?: number } // end > caret: selected text

/** Apply one key to a value (typed text replaces a selection; maxLength < 0 = unlimited). */
export function oskEdit(s: OskText, k: { ch?: string; act?: OskAction }, maxLength = -1): OskText {
  const v = s.value, a = Math.max(0, Math.min(v.length, s.caret)), b = Math.max(a, Math.min(v.length, s.end ?? a));
  const insert = (t: string): OskText => {
    if (maxLength >= 0 && v.length - (b - a) + t.length > maxLength) return { value: v, caret: a, end: b };
    return { value: v.slice(0, a) + t + v.slice(b), caret: a + t.length };
  };
  if (k.ch) return insert(k.ch);
  switch (k.act) {
    case 'space': return insert(' ');
    case 'back': return b > a ? { value: v.slice(0, a) + v.slice(b), caret: a } : a > 0 ? { value: v.slice(0, a - 1) + v.slice(a), caret: a - 1 } : { value: v, caret: 0 };
    case 'left': return { value: v, caret: b > a ? a : Math.max(0, a - 1) };
    case 'right': return { value: v, caret: b > a ? b : Math.min(v.length, a + 1) };
  }
  return { value: v, caret: a, end: b };
}

const CSS = `
.osk { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%); z-index: 80; width: min(720px, calc(100vw - 32px));
  padding: 14px; border-radius: var(--gm-radius, 14px); background: var(--gm-card, #1e1c35); border: 1px solid var(--gm-border, #4c1d95);
  box-shadow: var(--gm-shadow, 0 18px 40px rgba(0,0,0,.45)); color: var(--gm-fg, #e2e8f0); font-size: 16px; }
.osk-head { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; margin-bottom: 8px; }
.osk-label, .osk-count { color: var(--gm-fg-muted, #94a3b8); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; font-variant-numeric: tabular-nums; }
.osk-preview { min-height: 38px; padding: 6px 10px; border-radius: 8px; background: rgba(15,15,35,.85); border: 1px solid var(--gm-border-soft, rgba(167,139,250,.22));
  font-family: ui-monospace, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
.osk-preview i { display: inline-block; width: 2px; height: 1.15em; margin: 0 -1px; vertical-align: text-bottom; background: var(--gm-ring, #c4b5fd); animation: osk-blink 1s steps(1) infinite; }
@keyframes osk-blink { 50% { opacity: 0; } }
.osk-row { display: flex; gap: 6px; justify-content: center; margin-top: 6px; }
.osk-key { flex: 1 1 0; min-width: 0; max-width: 62px; height: 44px; padding: 0; border-radius: 8px; background: #27273b; border: 1px solid var(--gm-border-soft, rgba(167,139,250,.22));
  color: inherit; font: inherit; font-size: 17px; cursor: pointer; white-space: nowrap; overflow: hidden; }
.osk-key.wide { max-width: none; }
.osk-key[aria-pressed=true] { border-color: var(--gm-secondary, #a78bfa); color: var(--gm-secondary, #a78bfa); }
.osk-key.is-sel { background: var(--gm-primary, #7c3aed); color: #fff; outline: 3px solid var(--gm-ring, #c4b5fd); outline-offset: 2px; }
.osk-hints { display: flex; flex-wrap: wrap; gap: 6px 16px; justify-content: center; margin-top: 10px; color: var(--gm-fg-muted, #94a3b8); font-size: 13px; }
.osk-hints b { color: var(--gm-fg, #e2e8f0); font-weight: 600; }
@media (max-width: 640px) { .osk { bottom: 8px; padding: 10px; } .osk-key { height: 38px; font-size: 15px; } .osk-row { gap: 4px; } }
@media (prefers-reduced-motion: reduce) { .osk-preview i { animation: none; } }`;

/** Spatial focus helper (nav.ts moveFocus), passed in to keep this module free of a runtime cycle. */
export type Spatial = (scope: HTMLElement, dir: Dir, from: HTMLElement | null) => HTMLElement | null;

export class Osk implements NavOverlay {
  readonly el: HTMLElement;
  readonly mode: OskMode;
  private board = el('div', { class: 'osk-board' });
  private preview = el('div', { class: 'osk-preview', 'aria-live': 'polite' });
  private count = el('span', { class: 'osk-count' });
  private keys = new Map<HTMLButtonElement, OskKey>();
  private sel: HTMLButtonElement | null = null;
  private shift = false;
  private pos: number;
  private readonly start: string;
  private readonly sync = () => this.show();
  onClose: (() => void) | null = null;

  constructor(readonly target: HTMLInputElement, host: HTMLElement, private spatial: Spatial) {
    if (!document.getElementById('osk-css')) document.head.append(el('style', { id: 'osk-css' }, CSS));
    this.mode = oskModeFor(target);
    this.start = target.value;
    this.pos = target.value.length;
    const name = target.getAttribute('aria-label') || target.labels?.[0]?.textContent?.trim() || target.placeholder || 'Text';
    const hint = (k: string, t: string) => el('span', {}, el('b', {}, k), ` ${t}`);
    this.el = el('div', { class: 'osk', role: 'dialog', 'aria-label': `On-screen keyboard: ${name}` },
      el('div', { class: 'osk-head' }, el('span', { class: 'osk-label' }, name), this.preview, this.count),
      this.board,
      el('div', { class: 'osk-hints', 'aria-hidden': 'true' }, hint('A', 'type'), hint('X', '⌫'), this.mode === 'text' ? hint('Y', 'space') : null, hint('LB / RB', 'cursor'), hint('B', 'done')));
    host.append(this.el);
    this.setCaret(this.pos, this.pos);
    for (const ev of ['input', 'keyup', 'click', 'select'] as const) target.addEventListener(ev, this.sync);
    this.build();
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  /** (Re)draw the keys, keeping the highlight on the same row / column. */
  private build() {
    const at = this.sel ? this.where(this.sel) : { r: 1, c: 0 };
    this.keys.clear();
    const rows = oskRows(this.mode, this.shift).map((row) => el('div', { class: 'osk-row' }, ...row.map((k) => {
      const b = el('button', {
        type: 'button', tabindex: '-1', class: `osk-key${k.grow ? ' wide' : ''}`, 'aria-label': k.aria, 'aria-pressed': k.act === 'shift' ? String(this.shift) : undefined,
        // keep focus (and the caret) in the field
        onpointerdown: (e: Event) => e.preventDefault(), onclick: () => { this.pick(b); this.press(k); },
      }, k.label) as HTMLButtonElement;
      if (k.grow) b.style.flexGrow = String(k.grow);
      this.keys.set(b, k);
      return b;
    })));
    this.board.replaceChildren(...rows);
    const row = rows[Math.min(at.r, rows.length - 1)];
    this.pick((row.children[Math.min(at.c, row.children.length - 1)] as HTMLButtonElement) ?? null);
    this.show();
  }

  private where(b: HTMLElement) {
    const row = b.parentElement!, rows = [...this.board.children];
    return { r: Math.max(0, rows.indexOf(row)), c: Math.max(0, [...row.children].indexOf(b)) };
  }

  private pick(b: HTMLButtonElement | null) {
    this.sel?.classList.remove('is-sel');
    this.sel = b;
    b?.classList.add('is-sel');
  }

  private caret(): { a: number; b: number } {
    try { const a = this.target.selectionStart, b = this.target.selectionEnd; if (a != null && b != null) return { a, b }; } catch { /* no selection API on this type */ }
    return { a: this.pos, b: this.pos };
  }

  private setCaret(a: number, b = a) {
    this.pos = a;
    try { this.target.setSelectionRange(a, b); } catch { /* type without selection (number) */ }
  }

  private show() {
    const v = this.target.value, { a } = this.caret();
    this.preview.replaceChildren(v.slice(0, a), el('i', { 'aria-hidden': 'true' }), v.slice(a));
    const max = this.target.maxLength;
    this.count.textContent = max >= 0 ? `${v.length}/${max}` : '';
  }

  private press(k: OskKey) {
    if (k.act === 'shift') { this.shift = !this.shift; this.build(); return; }
    if (k.act === 'done') { this.back(); return; }
    if (k.act === 'enter') { this.submit(); return; }
    if (k.act === 'space' && this.mode !== 'text') return;
    const { a, b } = this.caret();
    const next = oskEdit({ value: this.target.value, caret: a, end: b }, k, this.target.maxLength);
    if (next.value !== this.target.value) {
      this.target.value = next.value;
      this.target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    this.setCaret(next.caret, next.end ?? next.caret);
    if (k.ch && this.shift) { this.shift = false; this.build(); } // one-shot shift, like a phone keyboard
    this.show();
  }

  move(dir: Dir) {
    if (!this.sel) { this.build(); return; }
    let n = this.spatial(this.board, dir, this.sel) as HTMLButtonElement | null;
    if (!n && (dir === 'left' || dir === 'right')) { // wrap around within the row
      const row = [...this.sel.parentElement!.children] as HTMLButtonElement[];
      n = dir === 'left' ? row[row.length - 1] : row[0];
    }
    if (n) this.pick(n);
  }

  activate() { const k = this.sel && this.keys.get(this.sel); if (k) this.press(k); }

  button(i: number) {
    if (i === 2) this.press(K.back);
    else if (i === 3) this.press(K.space);
    else if (i === 4) this.press(K.left);
    else if (i === 5) this.press(K.right);
  }

  /** Physical keys while open: typing goes straight into the field. */
  key(e: KeyboardEvent): boolean {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { this.move(e.key === 'ArrowUp' ? 'up' : 'down'); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') this.close(); // the field's own Enter handler still runs
    return false;
  }

  /** Close, keeping the text (B, Done, Esc). */
  back() {
    this.close();
    if (this.target.value !== this.start) this.target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Enter: close, then let the field act on it (CLI send, join by code). */
  private submit() {
    this.back();
    this.target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  }

  close() {
    if (!this.el.isConnected && !this.onClose) return;
    this.el.remove();
    for (const ev of ['input', 'keyup', 'click', 'select'] as const) this.target.removeEventListener(ev, this.sync);
    const cb = this.onClose; this.onClose = null; cb?.();
  }
}
