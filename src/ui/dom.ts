// Tiny DOM helpers for the menus (no framework).
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}

let uid = 0;
/** A document-unique id for aria-describedby / label[for] pairs. */
export const uniqueId = (prefix = 'ui') => `${prefix}-${++uid}`;

/** Phones and tablets: no mouse or trackpad anywhere (`any-pointer: fine` is false). */
let finePointer: MediaQueryList | null | undefined;
// one MediaQueryList, read live (the HUD asks every frame; matchMedia parses the query each call)
export const touchOnly = () => {
  if (finePointer === undefined) finePointer = typeof matchMedia === 'function' ? matchMedia('(any-pointer: fine)') : null;
  return !!finePointer && !finePointer.matches;
};

export interface SliderOpts { label: string; min: number; max: number; step: number; value: number; unit?: string; digits?: number; hint?: string; onInput: (v: number) => void }
export function slider(o: SliderOpts): { row: HTMLElement; set(v: number): void; input: HTMLInputElement } {
  const out = el('span', { class: 'val' });
  const num = (v: number) => (o.step < 1e-3 ? v.toExponential(1) : v.toFixed(o.digits ?? (o.step < 1 ? Math.min(4, Math.ceil(-Math.log10(o.step))) : 0)));
  const fmt = (v: number) => `${num(v)}${o.unit ? ' ' + o.unit : ''}`;
  // help text is visible under the slider (not only a hover tooltip) and read out with it
  const hintId = o.hint ? uniqueId('hint') : undefined, lblId = uniqueId('lbl');
  const input = el('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: o.value, 'aria-labelledby': lblId, 'aria-describedby': hintId }) as HTMLInputElement;
  const show = (v: number) => { out.textContent = fmt(v); input.setAttribute('aria-valuetext', fmt(v)); };
  input.addEventListener('input', () => { const v = parseFloat(input.value); show(v); o.onInput(v); });
  show(o.value);
  const row = el('label', { class: 'slider' }, el('span', { class: 'lbl', id: lblId }, o.label), input, out,
    o.hint ? el('small', { class: 'hint', id: hintId }, o.hint) : null);
  return { row, input, set(v: number) { input.value = String(v); show(v); } };
}

export function select<T extends string>(label: string, options: { value: T; label: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const s = el('select', { onchange: () => onChange(s.value as T) }, ...options.map((o) => el('option', { value: o.value, selected: o.value === value }, o.label))) as HTMLSelectElement;
  return el('label', { class: 'field' }, el('span', { class: 'lbl' }, label), s);
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const c = el('input', { type: 'checkbox', checked: value, onchange: () => onChange(c.checked) }) as HTMLInputElement;
  return el('label', { class: 'check' }, c, el('span', {}, label));
}

export function section(title: string, ...kids: (Node | null)[]): HTMLElement {
  return el('section', { class: 'sec' }, el('h3', {}, title), ...kids);
}

export function kv(rows: [string, string][]): HTMLElement {
  return el('table', { class: 'kv' }, ...rows.map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, v))));
}

// ---------------------------------------------------------------------------------------------
// Confirm dialog (menu-styled, controller / keyboard / touch friendly)

export interface ConfirmOpts {
  title: string;
  body: string | Node;
  ok: string;
  cancel?: string;
  /** destructive: the OK button is red and Cancel gets the initial focus */
  danger?: boolean;
}

const openModals: { el: HTMLElement; done: (ok: boolean) => void }[] = [];

/**
 * Ask before something that can't be undone. Resolves true on OK, false on Cancel / Esc / B /
 * clicking the backdrop. The game menu routes Esc and B here first (cancelTopModal) and scopes
 * controller navigation to the dialog (topModal).
 */
export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const titleId = uniqueId('dlg'), bodyId = uniqueId('dlg');
    const prevFocus = document.activeElement as HTMLElement | null;
    const card = el('div', { class: 'gm-modal-card' });
    const root = el('div', { class: 'gm-modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': bodyId }, card);
    const finish = (ok: boolean) => {
      const i = openModals.findIndex((m) => m.el === root);
      if (i < 0) return;
      openModals.splice(i, 1);
      root.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1]?.el !== root) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      else if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...card.querySelectorAll<HTMLElement>('button')];
        const i = f.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
      }
    };
    const okBtn = el('button', { class: `gm-btn ${o.danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, o.ok);
    const cancelBtn = el('button', { class: 'gm-btn ghost', onclick: () => finish(false) }, o.cancel ?? 'Cancel');
    card.append(
      el('h2', { id: titleId }, o.title),
      typeof o.body === 'string' ? el('p', { id: bodyId }, o.body) : el('div', { id: bodyId }, o.body),
      el('div', { class: 'gm-actions' }, cancelBtn, okBtn));
    root.addEventListener('pointerdown', (e) => { if (e.target === root) finish(false); });
    (document.querySelector<HTMLElement>('.gm:not(.hidden)') ?? document.body).append(root);
    openModals.push({ el: root, done: finish });
    document.addEventListener('keydown', onKey, true);
    // show which answer is selected (controllers and keyboards answer with A / Enter)
    requestAnimationFrame(() => { const b = o.danger ? cancelBtn : okBtn; b.classList.add('is-focus'); b.addEventListener('blur', () => b.classList.remove('is-focus'), { once: true }); b.focus({ preventScroll: true }); });
  });
}

/**
 * A menu-styled dialog with any content (forms, progress): the caller closes it. Esc / B / the
 * backdrop call onCancel (the dialog stays open unless that closes it). Shares the confirm dialogs'
 * stack, so the game menu routes Esc / B and controller navigation to it.
 */
export function openModal(o: { label: string; card: HTMLElement; onCancel(): void; className?: string }): { root: HTMLElement; close(): void } {
  const prevFocus = document.activeElement as HTMLElement | null;
  const root = el('div', { class: `gm-modal ${o.className ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': o.label }, o.card);
  const focusable = () => [...o.card.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea, a[href]')].filter((e) => e.offsetParent !== null || e === document.activeElement);
  const onKey = (e: KeyboardEvent) => {
    if (openModals[openModals.length - 1]?.el !== root) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); o.onCancel(); }
    else if (e.key === 'Tab') { // keep focus inside the dialog
      const f = focusable(), i = f.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    }
  };
  const close = () => {
    const i = openModals.findIndex((m) => m.el === root);
    if (i < 0) return;
    openModals.splice(i, 1);
    root.remove();
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
  };
  root.addEventListener('pointerdown', (e) => { if (e.target === root) o.onCancel(); });
  (document.querySelector<HTMLElement>('.gm:not(.hidden)') ?? document.body).append(root);
  openModals.push({ el: root, done: () => o.onCancel() });
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => (o.card.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus({ preventScroll: true }));
  return { root, close };
}

/** The open dialog, if any (the menu scopes controller navigation to it). */
export const topModal = (): HTMLElement | null => openModals[openModals.length - 1]?.el ?? null;
/** Cancel the open dialog (Esc / B). Returns false when none was open. */
export function cancelTopModal(): boolean { const m = openModals[openModals.length - 1]; if (!m) return false; m.done(false); return true; }

// ---------------------------------------------------------------------------------------------
// Panel lifecycle: "Discard unsaved changes?" guards and clean-up when a panel leaves the page.

export interface LeaveGuard {
  /** true while there are edits that leaving would lose */
  dirty(): boolean;
  /** what would be lost, for the confirm dialog */
  what?(): string;
}

const guards = new WeakMap<Element, LeaveGuard>();
const unmounts = new WeakMap<Element, () => void>();

/** Ask before the menu leaves (tab switch, back, close) while `g.dirty()` is true. */
export function setLeaveGuard(node: HTMLElement, g: LeaveGuard) { guards.set(node, g); node.dataset.leaveGuard = ''; }

/** The first dirty guard inside `scope`, if any. */
export function dirtyGuard(scope: Element | null): LeaveGuard | null {
  if (!scope) return null;
  for (const n of [scope, ...scope.querySelectorAll('[data-leave-guard]')]) { const g = guards.get(n); if (g?.dirty()) return g; }
  return null;
}

/** Run `fn` once when the menu throws `node` away (runUnmounts on an ancestor). */
export function onUnmount(node: HTMLElement, fn: () => void) { unmounts.set(node, fn); node.dataset.unmount = ''; }

export function runUnmounts(scope: Element | null) {
  if (!scope) return;
  for (const n of [scope, ...scope.querySelectorAll('[data-unmount]')]) { const f = unmounts.get(n); if (f) { unmounts.delete(n); try { f(); } catch (e) { console.warn(e); } } }
}
