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

export interface SliderOpts { label: string; min: number; max: number; step: number; value: number; unit?: string; digits?: number; hint?: string; onInput: (v: number) => void }
export function slider(o: SliderOpts): { row: HTMLElement; set(v: number): void; input: HTMLInputElement } {
  const out = el('span', { class: 'val' });
  const num = (v: number) => (o.step < 1e-3 ? v.toExponential(1) : v.toFixed(o.digits ?? (o.step < 1 ? Math.min(4, Math.ceil(-Math.log10(o.step))) : 0)));
  const fmt = (v: number) => `${num(v)}${o.unit ? ' ' + o.unit : ''}`;
  const input = el('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: o.value }) as HTMLInputElement;
  input.addEventListener('input', () => { const v = parseFloat(input.value); out.textContent = fmt(v); o.onInput(v); });
  out.textContent = fmt(o.value);
  const row = el('label', { class: 'slider', title: o.hint ?? '' }, el('span', { class: 'lbl' }, o.label), input, out);
  return { row, input, set(v: number) { input.value = String(v); out.textContent = fmt(v); } };
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
