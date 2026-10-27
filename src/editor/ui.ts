// The map builder's panels: toolbar (top), palette (left: Race / Freestyle / Environment /
// Simulation), inspector (right: every property of the selection, several objects at once, or the
// map's meta when nothing is selected) and the problems list with the budget meters (bottom).
// Plain DOM through el(); every field commits one undoable command.
import { ALLOWED_LICENSES, BUDGETS, GATE_KINDS, GATE_SIZE, MATERIAL_NAMES, NEEDS_TEXT, TARGET_SHAPES, VISUALS, type ActorDoc, type GroundDoc, type NoiseLayer, type PrimDoc } from '../maps/mapDoc';
import { el } from '../ui/dom';
import { icon, type IconName } from '../ui/menu/icons';
import type { Editor, Place } from './editor';
import { KIND_NAMES, refKind, type Op, type Path } from './editorDoc';
import { lapLength, courseGates, coursePath } from './racing';
import { placePrefab, prefabById, prefabDefaults, PREFABS } from './prefabs';
import { renderScenarioForm, newScenario } from './scenarioForm';
import { deriveId } from './templates';
import { requantize, resample } from './terrain';
import { freeId, groupMembers } from './transform';

type Obj = Record<string, any>;
const key = (p: Path) => JSON.stringify(p);
const fmt = (v: number, d = 2) => (Number.isInteger(v) ? String(v) : v.toFixed(d).replace(/\.?0+$/, ''));
/** bare: icon only (the label is its accessible name and part of its tooltip) */
const btn = (label: string, onclick: () => void, o: { icon?: IconName; title?: string; on?: boolean; cls?: string; disabled?: boolean; bare?: boolean } = {}) =>
  el('button', { type: 'button', class: `ed-btn${o.cls ? ' ' + o.cls : ''}${o.bare ? ' ed-ico' : ''}`, title: o.title ?? (o.bare ? label : undefined), 'aria-label': o.bare ? label : undefined, 'aria-pressed': o.on === undefined ? undefined : String(o.on), disabled: o.disabled, onclick }, o.icon ? icon(o.icon) : null, o.bare ? null : label);
const sec = (title: string, ...kids: (Node | string | null | undefined)[]) => el('section', { class: 'ed-sec' }, el('h3', {}, title), ...kids);
const row = (...kids: (Node | string | null | undefined)[]) => el('div', { class: 'ed-row' }, ...kids);
const note = (t: string) => el('p', { class: 'ed-note' }, t);

// ---------------------------------------------------------------------------------------------
// Fields: each edits the same property of every selected object (paths), shows "mixed" when they differ

interface NumOpts { step?: number; min?: number; max?: number; opt?: boolean; unit?: string; placeholder?: string }
function common(e: Editor, paths: Path[]): { v: unknown; mixed: boolean } {
  const vals = paths.map((p) => e.ed.get(p)), s = vals.map((v) => JSON.stringify(v));
  return { v: vals[0], mixed: s.some((x) => x !== s[0]) };
}
function labelled(label: string, input: HTMLElement, unit?: string) {
  return el('label', { class: 'ed-field' }, el('span', { class: 'lbl' }, label), input, unit ? el('span', { class: 'unit' }, unit) : null);
}
function numIn(value: number | undefined, mixed: boolean, o: NumOpts, commit: (v: number | undefined) => void): HTMLInputElement {
  const i = el('input', { type: 'number', step: o.step ?? 'any', min: o.min, max: o.max, value: value === undefined || mixed ? '' : fmt(value, 4), placeholder: mixed ? '—' : o.placeholder ?? (o.opt ? 'default' : ''), title: mixed ? 'Mixed values: a new value sets them all' : undefined }) as HTMLInputElement;
  i.addEventListener('change', () => {
    if (i.value.trim() === '') { if (o.opt) commit(undefined); return; }
    let v = Number(i.value);
    if (!Number.isFinite(v)) return;
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    commit(v);
  });
  return i;
}
export function num(e: Editor, label: string, paths: Path[], o: NumOpts = {}): HTMLElement {
  const c = common(e, paths);
  return labelled(label, numIn(c.v as number | undefined, c.mixed, o, (v) => e.setProps(paths, v, `Set ${label.toLowerCase()}`)), o.unit);
}
/** n numbers in one array property ([x, y, z] …); optional: blank all to remove it. */
export function vec(e: Editor, label: string, paths: Path[], n: number, o: NumOpts & { names?: string[]; def?: number[] } = {}): HTMLElement {
  const vals = paths.map((p) => e.ed.get(p) as number[] | undefined), names = o.names ?? ['x', 'y', 'z', 'w'];
  const box = el('span', { class: 'ed-vec' });
  for (let k = 0; k < n; k++) {
    const mixed = vals.some((v) => v?.[k] !== vals[0]?.[k]);
    const inp = numIn(vals[0]?.[k], mixed, { ...o, opt: false, placeholder: names[k] }, (v) => {
      const ops: Op[] = paths.map((p, i) => { const base = [...(vals[i] ?? o.def ?? new Array(n).fill(0))]; base[k] = v; return { k: 'set', path: p, v: base }; });
      e.ed.apply(`Set ${label.toLowerCase()}`, ops);
    });
    inp.setAttribute('aria-label', `${label} ${names[k]}`);
    box.append(inp);
  }
  return el('div', { class: 'ed-field' }, el('span', { class: 'lbl' }, label), box, o.unit ? el('span', { class: 'unit' }, o.unit) : null,
    o.opt && vals.some((v) => v !== undefined) ? el('button', { type: 'button', class: 'ed-x', title: `Remove ${label.toLowerCase()}`, 'aria-label': `Remove ${label.toLowerCase()}`, onclick: () => e.setProps(paths, undefined, `Remove ${label.toLowerCase()}`) }, '×') : null);
}
export function sel(e: Editor, label: string, paths: Path[], options: readonly string[] | { value: string; label: string }[], o: { opt?: string; onSet?: (v: string | undefined) => void } = {}): HTMLElement {
  const c = common(e, paths), opts = (options as (string | { value: string; label: string })[]).map((x) => (typeof x === 'string' ? { value: x, label: x } : x));
  const s = el('select', {}, c.mixed ? el('option', { value: '\u0000', selected: true }, 'mixed') : null, o.opt !== undefined ? el('option', { value: '', selected: !c.mixed && c.v === undefined }, o.opt) : null,
    ...opts.map((x) => el('option', { value: x.value, selected: !c.mixed && c.v === x.value }, x.label))) as HTMLSelectElement;
  s.addEventListener('change', () => { if (s.value === '\u0000') return; const v = s.value === '' && o.opt !== undefined ? undefined : s.value; if (o.onSet) o.onSet(v); else e.setProps(paths, v, `Set ${label.toLowerCase()}`); });
  return labelled(label, s);
}
export function chk(e: Editor, label: string, paths: Path[], def = false): HTMLElement {
  const c = common(e, paths), on = c.mixed ? false : ((c.v as boolean | undefined) ?? def);
  const i = el('input', { type: 'checkbox', checked: on }) as HTMLInputElement;
  if (c.mixed) i.indeterminate = true;
  i.addEventListener('change', () => e.setProps(paths, i.checked === def ? undefined : i.checked, `Set ${label.toLowerCase()}`));
  return el('label', { class: 'ed-check' }, i, el('span', {}, label));
}
export function text(e: Editor, label: string, paths: Path[], o: { opt?: boolean; max?: number; placeholder?: string; area?: boolean } = {}): HTMLElement {
  const c = common(e, paths);
  const i = el(o.area ? 'textarea' : 'input', { ...(o.area ? { rows: 3 } : { type: 'text' }), maxlength: o.max, spellcheck: false, placeholder: c.mixed ? 'mixed' : o.placeholder ?? '' }) as HTMLInputElement;
  i.value = c.mixed || c.v === undefined ? '' : String(c.v);
  i.addEventListener('change', () => { const v = i.value.trim(); e.setProps(paths, v === '' && o.opt ? undefined : v, `Set ${label.toLowerCase()}`); });
  return labelled(label, i);
}
export function color(e: Editor, label: string, paths: Path[], o: { opt?: boolean; def?: string } = {}): HTMLElement {
  const c = common(e, paths);
  const i = el('input', { type: 'color', value: (!c.mixed && (c.v as string)) || o.def || '#888888' }) as HTMLInputElement;
  i.addEventListener('input', () => e.setProps(paths, i.value, `Set ${label.toLowerCase()}`, `color:${key(paths[0])}`));
  return el('div', { class: 'ed-field' }, el('span', { class: 'lbl' }, label), i, c.v === undefined && !c.mixed ? el('span', { class: 'unit' }, 'default') : null,
    o.opt && c.v !== undefined ? el('button', { type: 'button', class: 'ed-x', title: 'Default colour', 'aria-label': `Default ${label.toLowerCase()}`, onclick: () => e.setProps(paths, undefined, `Reset ${label.toLowerCase()}`) }, '×') : null);
}
/** A texture picker: package images, "none", or import one. */
function texture(e: Editor, label: string, paths: Path[]): HTMLElement {
  const imgs = [...e.ed.assets.keys()].filter((p) => /\.(png|jpe?g|webp)$/i.test(p) && p !== e.ed.doc.meta.preview);
  const f = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'ed-file', 'aria-label': `Import ${label.toLowerCase()}` }) as HTMLInputElement;
  f.addEventListener('change', async () => { const file = f.files?.[0]; if (file) { const p = await e.importTexture(file); if (p) e.setProps(paths, p, `Set ${label.toLowerCase()}`); } });
  return el('div', {}, sel(e, label, paths, imgs, { opt: 'none' }), el('label', { class: 'ed-btn ed-small' }, 'Import image…', f));
}
const plainBtn = (label: string, onclick: () => void, title?: string) => btn(label, onclick, { title, cls: 'ed-small' });

// ---------------------------------------------------------------------------------------------
// Toolbar

export function renderToolbar(e: Editor): HTMLElement {
  const m = e.mode, tool = e.tool.t;
  const mode = (id: typeof m, label: string, ic: IconName, k: string) => btn(label, () => { if (tool !== 'select') e.setTool({ t: 'select' }); e.setMode(id); }, { icon: ic, on: tool === 'select' && m === id, title: `${label} (${k})` });
  const snapSel = (label: string, cur: number, vals: number[], unit: string, set: (v: number) => void) => {
    const s = el('select', { 'aria-label': label, title: label, onchange: () => set(Number(s.value)) }, ...vals.map((v) => el('option', { value: v, selected: v === cur }, v ? `${v} ${unit}` : 'off'))) as HTMLSelectElement;
    return el('label', { class: 'ed-snap' }, el('span', {}, label), s);
  };
  const f = e.s.fly, doc = e.ed.doc;
  const fly = el('details', { class: 'ed-pop' }, el('summary', { class: 'ed-btn primary' }, icon('play'), 'Fly'),
    el('div', { class: 'ed-pop-card' },
      labelled('Course', el('select', { onchange: (ev: Event) => { f.course = (ev.target as HTMLSelectElement).value; } }, el('option', { value: '' }, 'Main course'), ...(doc.courses ?? []).map((c) => el('option', { value: c.id, selected: c.id === f.course }, c.name)))),
      labelled('Spawn', el('select', { onchange: (ev: Event) => { f.spawn = (ev.target as HTMLSelectElement).value; } }, el('option', { value: '' }, 'Main spawn (or the course\'s)'), ...(doc.spawns ?? []).map((s) => el('option', { value: s.id, selected: s.id === f.spawn }, s.name ?? s.id)))),
      el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: f.race, onchange: (ev: Event) => { f.race = (ev.target as HTMLInputElement).checked; } }), el('span', {}, 'Race (lap timing)')),
      note('Registers the draft as a local map and flies it with the real physics and Betaflight. Esc → Back to editor returns here.'),
      btn('Fly now', () => void e.fly(), { cls: 'primary', icon: 'play' })));
  return el('div', { class: 'ed-bar-in' },
    el('div', { class: 'ed-title' }, el('b', {}, doc.meta.name || 'Untitled map'), el('small', {}, e.saved)),
    el('div', { class: 'ed-group', role: 'group', 'aria-label': 'Transform' },
      mode('select', 'Select', 'target', '1'), mode('move', 'Move', 'layers', '2'), mode('rotate', 'Turn', 'rotate', '3'), mode('scale', 'Scale', 'sliders', '4')),
    el('div', { class: 'ed-group' },
      snapSel('Grid', e.snap.grid, [0, 0.1, 0.25, 0.5, 1, 2, 5], 'm', (v) => { e.snap.grid = v; e.setMode(e.mode); }),
      snapSel('Angle', e.snap.angle, [0, 5, 15, 45, 90], '°', (v) => { e.snap.angle = v; e.setMode(e.mode); })),
    el('div', { class: 'ed-group' },
      btn('Duplicate', () => e.duplicate(), { icon: 'copy', title: 'Duplicate (Ctrl+D)', disabled: !e.sel.length, bare: true }),
      btn('Align to ground', () => e.toGround(), { icon: 'download', title: 'Align to ground', disabled: !e.sel.length, bare: true }),
      btn('Delete', () => e.del(), { icon: 'logout', title: 'Delete (Del)', disabled: !e.sel.length, bare: true })),
    el('div', { class: 'ed-group' },
      btn('Undo', () => e.undo(), { icon: 'back', title: e.ed.canUndo ? `Undo ${e.ed.undoLabel.toLowerCase()} (Ctrl+Z)` : 'Nothing to undo', disabled: !e.ed.canUndo, bare: true }),
      btn('Redo', () => e.redo(), { icon: 'repeat', title: e.ed.canRedo ? `Redo ${e.ed.redoLabel.toLowerCase()} (Ctrl+Shift+Z)` : 'Nothing to redo', disabled: !e.ed.canRedo, bare: true })),
    el('div', { class: 'ed-group' },
      btn(e.cam.mode === 'orbit' ? 'Orbit' : 'Fly cam', () => { e.cam.mode = e.cam.mode === 'orbit' ? 'fly' : 'orbit'; e.renderBox('toolbar'); }, { icon: 'globe', title: 'Camera (T): orbit round the view centre, or fly (WASD, Q / E, drag to look)' })),
    el('span', { class: 'ed-spacer' }),
    el('div', { class: 'ed-group' },
      btn('Validate', () => void e.validate(), { icon: 'check', title: 'Validate: check the whole package as the map validator does', bare: true }),
      fly,
      btn('Export', () => void e.exportZip(), { icon: 'download', title: 'Export a .zip package (ATTRIBUTION.md and LICENSE.txt included)' }),
      e.canPublish ? btn('Publish', () => void e.publish(), { icon: 'upload', title: 'Publish as a user map' }) : null,
      btn('Exit', () => void e.exit(), { icon: 'home', title: 'Exit to the menu (the draft is saved)', bare: true })));
}

// ---------------------------------------------------------------------------------------------
// Palette

const TABS: { id: Editor['pal']['tab']; label: string; icon: IconName }[] = [
  { id: 'race', label: 'Race', icon: 'flag' }, { id: 'freestyle', label: 'Freestyle', icon: 'drone' }, { id: 'environment', label: 'Environment', icon: 'wind' }, { id: 'simulation', label: 'Simulation', icon: 'activity' },
];
const placing = (e: Editor, p: Partial<Place> & { kind: Place['kind'] }) => e.tool.t === 'place' && e.tool.p.kind === p.kind && Object.entries(p).every(([k, v]) => k === 'actor' ? (e.tool as { p: { actor?: ActorDoc } }).p.actor?.id === (v as ActorDoc).id : (e.tool as { p: Obj }).p[k] === v);
const toolBtn = (e: Editor, label: string, p: Place, o: { icon?: IconName; title?: string } = {}) =>
  btn(label, () => e.setTool(placing(e, p) ? { t: 'select' } : { t: 'place', p }), { ...o, on: placing(e, p), cls: 'ed-tool' });

export function renderPalette(e: Editor): HTMLElement {
  const tab = e.pal.tab;
  const bar = el('div', { class: 'ed-tabs', role: 'tablist', 'aria-label': 'Palette' }, ...TABS.map((t) => el('button', {
    type: 'button', role: 'tab', class: 'ed-tab', 'aria-selected': String(t.id === tab),
    onclick: () => { e.pal.tab = t.id; e.renderBox('palette', true); },
    onkeydown: (ev: KeyboardEvent) => { if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { const i = TABS.findIndex((x) => x.id === tab); e.pal.tab = TABS[(i + (ev.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id; e.renderBox('palette', true); (document.querySelector('.ed-tab[aria-selected="true"]') as HTMLElement | null)?.focus(); } },
  }, icon(t.icon), t.label)));
  const body = tab === 'race' ? racePalette(e) : tab === 'freestyle' ? freestylePalette(e) : tab === 'environment' ? environmentPalette(e) : simulationPalette(e);
  return el('div', {}, bar, el('div', { class: 'ed-tabbody', role: 'tabpanel' }, ...body));
}

/** Number input bound to a plain object (palette settings, not the document). */
function palNum(label: string, obj: Obj, k: string, o: NumOpts = {}, after?: () => void): HTMLElement {
  return labelled(label, numIn(obj[k], false, o, (v) => { if (v === undefined) delete obj[k]; else obj[k] = v; after?.(); }), o.unit);
}

function prefabParams(e: Editor, id: string): HTMLElement {
  const pf = prefabById(id)!, cur = (e.pal.prefab[id] ??= {});
  return el('div', { class: 'ed-sub' }, note(pf.blurb), ...pf.params.map((p) => palNum(p.label, cur, p.key, { min: p.min, max: p.max, step: p.step, unit: p.unit, placeholder: String(p.def) })));
}
function prefabButtons(e: Editor, tab: 'race' | 'freestyle'): HTMLElement[] {
  const out: HTMLElement[] = [el('div', { class: 'ed-grid' }, ...PREFABS.filter((p) => p.tab === tab).map((p) => toolBtn(e, p.name, { kind: 'prefab', id: p.id }, { title: p.blurb })))];
  if (e.tool.t === 'place' && e.tool.p.kind === 'prefab' && prefabById(e.tool.p.id)?.tab === tab) out.push(prefabParams(e, e.tool.p.id));
  return out;
}

function racePalette(e: Editor): HTMLElement[] {
  const doc = e.ed.doc, c = e.s.course, G = e.pal.gate;
  const cur = e.tool.t === 'place' && e.tool.p.kind === 'gate' ? e.tool.p.gate : null;
  const def = cur ? GATE_SIZE[cur] : null;
  const gates = sec('Gates',
    el('div', { class: 'ed-grid' }, ...GATE_KINDS.map((k) => toolBtn(e, k[0].toUpperCase() + k.slice(1), { kind: 'gate', gate: k }, { title: `Place ${k} gates: click the ground (or a gate, to stack on top). They face the way the camera looks.` }))),
    cur ? el('div', { class: 'ed-sub' },
      palNum('Width', G, 'width', { min: 0.3, max: 20, step: 0.1, unit: 'm', opt: true, placeholder: fmt(def![0]) }),
      palNum('Height', G, 'height', { min: 0.3, max: 20, step: 0.1, unit: 'm', opt: true, placeholder: fmt(def![1]) }),
      cur === 'ladder' ? palNum('Openings', G, 'stack', { min: 1, max: 6, step: 1, opt: true, placeholder: '3' }) : null,
      note('New gates go to the end of the course\'s lap order. Click on a gate to stack the new one on top of it.')) : null);

  // ---- courses and lap order ----
  const courses = doc.courses ?? [];
  const cs = el('select', { 'aria-label': 'Course', onchange: (ev: Event) => e.setCourse(Number((ev.target as HTMLSelectElement).value)) },
    el('option', { value: -1, selected: c < 0 }, `Main course (${doc.gates?.length ?? 0} gates)`), ...courses.map((x, i) => el('option', { value: i, selected: c === i }, `${x.name} (${x.gates.length})`)));
  const addCourse = () => {
    if (courses.length >= BUDGETS.courses) { e.toast(`At most ${BUDGETS.courses} courses`); return; }
    const id = freeId(courses.map((x) => x.id), 'course'), sp = doc.spawn?.pos ?? [0, 0, 0];
    e.ed.apply('Add course', [{ k: 'ins', path: ['courses'], i: courses.length, v: { id, name: `Course ${id.split('-').pop()}`, gates: [{ kind: 'square', pos: [sp[0], sp[1] + 10] }] } }]);
    e.setCourse(courses.length);
  };
  const list = (doc.courses?.[c]?.gates ?? (c < 0 ? doc.gates : undefined)) ?? [], base = coursePath(c);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= list.length || from === to) return;
    const next = [...list]; const [g] = next.splice(from, 1); next.splice(to, 0, g);
    e.ed.apply('Reorder gates', [{ k: 'set', path: base, v: next }]);
    e.select([[...base, to]]);
  };
  let dragFrom = -1;
  const order = el('ol', { class: 'ed-list ed-laps', 'aria-label': 'Lap order' }, ...list.map((g, i) => {
    const selected = e.sel.some((r) => key(r) === key([...base, i]));
    const li = el('li', { draggable: 'true', class: selected ? 'on' : '' },
      el('button', { type: 'button', class: 'ed-li-main', onclick: () => { e.select([[...base, i]]); e.frameSelection(); } }, el('b', {}, String(i + 1)), ` ${g.kind} `, el('small', {}, `(${fmt(g.pos[0], 1)}, ${fmt(g.pos[1], 1)})`)),
      el('button', { type: 'button', class: 'ed-x', 'aria-label': `Gate ${i + 1} earlier`, title: 'Earlier in the lap', disabled: i === 0, onclick: () => move(i, i - 1) }, '↑'),
      el('button', { type: 'button', class: 'ed-x', 'aria-label': `Gate ${i + 1} later`, title: 'Later in the lap', disabled: i === list.length - 1, onclick: () => move(i, i + 1) }, '↓'));
    li.addEventListener('dragstart', (ev) => { dragFrom = i; ev.dataTransfer?.setData('text/plain', String(i)); li.classList.add('dragging'); });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (ev) => { ev.preventDefault(); li.classList.add('over'); });
    li.addEventListener('dragleave', () => li.classList.remove('over'));
    li.addEventListener('drop', (ev) => { ev.preventDefault(); li.classList.remove('over'); if (dragFrom >= 0) move(dragFrom, i); dragFrom = -1; });
    return li;
  }));
  const named = c >= 0 ? courses[c] : null;
  const L = e.def ? lapLength(courseGates(e.def, c)) : 0;
  const course = sec('Course',
    row(cs, plainBtn('New', addCourse, 'Add an alternative course (timed on its own)')),
    named ? el('div', { class: 'ed-sub' },
      text(e, 'Name', [['courses', c, 'name']], { max: 64 }),
      text(e, 'Id', [['courses', c, 'id']], { max: 32 }),
      sel(e, 'Starts at', [['courses', c, 'spawn']], (doc.spawns ?? []).map((s) => ({ value: s.id, label: s.name ?? s.id })), { opt: 'the main spawn' }),
      plainBtn('Delete course', () => { e.setCourse(-1); e.ed.apply('Delete course', [{ k: 'del', path: ['courses'], i: c }]); })) : null,
    list.length ? order : note('No gates yet: pick a gate kind above and click the ground.'),
    list.length ? note('Drag to change the lap order (or use ↑ ↓).') : null,
    el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: e.pal.line, onchange: (ev: Event) => { e.pal.line = (ev.target as HTMLInputElement).checked; e.refreshOverlay(); e.renderBox('palette'); } }), el('span', {}, 'Show the racing line')),
    list.length > 1 ? el('p', { class: 'ed-stat' }, `Lap ${fmt(L, 1)} m (gate to gate)`, e.pal.line && e.racingLineLength ? ` · racing line ${fmt(e.racingLineLength, 1)} m from the pad` : '') : null);
  return [gates, course,
    sec('Start', el('div', { class: 'ed-grid' }, toolBtn(e, 'Spawn pad', { kind: 'spawnPad' }, { title: 'A start pad with a named spawn on it' }), toolBtn(e, 'Spawn only', { kind: 'spawn' }))),
    sec('Race furniture', ...prefabButtons(e, 'race'))];
}

function freestylePalette(e: Editor): HTMLElement[] {
  const P = e.pal.prim, doc = e.ed.doc, cur = e.tool.t === 'place' && e.tool.p.kind === 'prim' ? e.tool.p.type : null;
  const vs = (label: string, k: 'material' | 'visual', vals: readonly string[]) => labelled(label, el('select', { onchange: (ev: Event) => { (P as Obj)[k] = (ev.target as HTMLSelectElement).value; } }, ...vals.map((v) => el('option', { value: v, selected: P[k] === v }, v))));
  const prims = sec('Primitives',
    el('div', { class: 'ed-grid' }, toolBtn(e, 'Box', { kind: 'prim', type: 'box' }), toolBtn(e, 'Cylinder', { kind: 'prim', type: 'cylinder' }), toolBtn(e, 'Sphere', { kind: 'prim', type: 'sphere' })),
    cur ? el('div', { class: 'ed-sub' },
      cur === 'box' ? labelled('Size', el('span', { class: 'ed-vec' }, ...[0, 1, 2].map((k) => numIn(P.size[k], false, { min: 0.01, step: 0.1, placeholder: 'xyz'[k] }, (v) => { if (v) P.size[k] = v; }))), 'm')
        : palNum('Radius', P, 'radius', { min: 0.01, step: 0.05, unit: 'm' }),
      cur === 'cylinder' ? palNum('Height', P, 'height', { min: 0.01, step: 0.1, unit: 'm' }) : null,
      vs('Material', 'material', MATERIAL_NAMES), cur === 'box' ? vs('Look', 'visual', VISUALS) : null,
      labelled('Colour', el('input', { type: 'color', value: P.color ?? '#888888', oninput: (ev: Event) => { P.color = (ev.target as HTMLInputElement).value; } })),
      cur === 'box' ? labelled('Texture', el('select', { onchange: (ev: Event) => { P.texture = (ev.target as HTMLSelectElement).value || undefined; } }, el('option', { value: '' }, 'none'), ...[...e.ed.assets.keys()].filter((p) => /^textures\//.test(p)).map((p) => el('option', { value: p, selected: P.texture === p }, p)))) : null,
      note('Material sets the collision sound and friction; look and colour how it is drawn. Place on the ground or on top of another object.')) : null);
  // ---- trees ----
  const T = e.pal.trees;
  const trees = sec(`Trees (${doc.trees?.length ?? 0} / ${BUDGETS.trees})`,
    el('div', { class: 'ed-grid' }, btn('Tree brush', () => e.setTool(e.tool.t === 'trees' ? { t: 'select' } : { t: 'trees' }), { on: e.tool.t === 'trees', cls: 'ed-tool' }), toolBtn(e, 'Single tree', { kind: 'tree' })),
    e.tool.t === 'trees' || (e.tool.t === 'place' && e.tool.p.kind === 'tree') ? el('div', { class: 'ed-sub' },
      palNum('Density', T, 'density', { min: 0.1, max: 30, step: 0.1, unit: '/100 m²' }), palNum('Brush radius', T, 'radius', { min: 1, max: 60, step: 0.5, unit: 'm' }),
      labelled('Type', el('select', { onchange: (ev: Event) => { T.type = (ev.target as HTMLSelectElement).value as typeof T.type; } }, ...['mixed', 'pine', 'oak'].map((v) => el('option', { value: v, selected: T.type === v }, v)))),
      palNum('Height from', T, 'hMin', { min: 1, max: 60, step: 0.5, unit: 'm' }), palNum('to', T, 'hMax', { min: 1, max: 60, step: 0.5, unit: 'm' }),
      el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: T.erase, onchange: (ev: Event) => { T.erase = (ev.target as HTMLInputElement).checked; } }), el('span', {}, 'Erase instead'))) : null);
  // ---- glTF ----
  let coll: 'box' | 'mesh' | 'none' = 'box';
  const f = el('input', { type: 'file', accept: '.glb,model/gltf-binary', class: 'ed-file', 'aria-label': 'Import a .glb mesh' }) as HTMLInputElement;
  f.addEventListener('change', () => { const file = f.files?.[0]; if (file) void e.importGlb(file, coll); f.value = ''; });
  const mesh = sec('glTF mesh',
    labelled('Collision', el('select', { onchange: (ev: Event) => { coll = (ev.target as HTMLSelectElement).value as typeof coll; } }, el('option', { value: 'box' }, 'box (its bounds)'), el('option', { value: 'mesh' }, 'mesh (every triangle)'), el('option', { value: 'none' }, 'none (scenery)'))),
    el('label', { class: 'ed-btn ed-small' }, icon('upload'), 'Import .glb…', f),
    meter('Triangles', e.meshStats.triangles, BUDGETS.meshTriangles), meter('With mesh collision', e.meshStats.collision, BUDGETS.collisionTriangles),
    note('Binary glTF 2.0 with embedded buffers and textures; no Draco / meshopt / KTX2. Placed at the view centre.'));
  return [prims, sec('Prefabs', ...prefabButtons(e, 'freestyle')), trees, terrainSection(e), mesh];
}

function terrainSection(e: Editor): HTMLElement {
  const g = e.ed.doc.ground, hf = g?.type === 'heightfield' && !!e.ed.grid, B = e.pal.brush;
  const res = el('select', { 'aria-label': 'Heightfield resolution', onchange: (ev: Event) => { e.pal.hfRes = Number((ev.target as HTMLSelectElement).value); } }, ...[129, 257, 513, 1025].map((v) => el('option', { value: v, selected: e.pal.hfRes === v }, `${v} px`)));
  const ops: { id: typeof B.op; label: string }[] = [{ id: 'raise', label: 'Raise' }, { id: 'lower', label: 'Lower' }, { id: 'smooth', label: 'Smooth' }, { id: 'flatten', label: 'Flatten' }, { id: 'noise', label: 'Noise' }];
  return sec('Terrain',
    hf ? null : el('div', {}, note(`The ground is ${g ? g.type : 'flat at 0 m'}. Sculpting works on a heightfield: convert keeps its current shape.`), row(res, plainBtn('Convert to heightfield', () => e.convertToHeightfield()))),
    hf ? el('div', {},
      btn('Sculpt', () => e.setTool(e.tool.t === 'sculpt' ? { t: 'select' } : { t: 'sculpt' }), { on: e.tool.t === 'sculpt', cls: 'ed-tool', icon: 'map' }),
      el('div', { class: 'ed-seg', role: 'group', 'aria-label': 'Brush' }, ...ops.map((o) => btn(o.label, () => { B.op = o.id; e.renderBox('palette', true); }, { on: B.op === o.id }))),
      palNum('Radius', B, 'radius', { min: 0.5, max: 200, step: 0.5, unit: 'm' }),
      palNum('Strength', B, 'strength', { min: 0.05, max: 40, step: 0.05, unit: B.op === 'smooth' || B.op === 'flatten' ? '/s' : 'm/s' }),
      labelled('Falloff', el('select', { onchange: (ev: Event) => { B.falloff = (ev.target as HTMLSelectElement).value as typeof B.falloff; } }, ...['smooth', 'linear', 'constant'].map((v) => el('option', { value: v, selected: B.falloff === v }, v)))),
      note('Drag on the terrain. Heights are limited to the ground\'s height range (Environment → Ground).')) : null);
}

function environmentPalette(e: Editor): HTMLElement[] {
  const doc = e.ed.doc, env = doc.environment ?? {};
  const sky = sec('Sky and air',
    sel(e, 'Sky', [['environment', 'sky']], ['clear', 'overcast', 'dusk', 'night'], { opt: 'clear (default)' }),
    el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: !!env.sun, onchange: (ev: Event) => e.setProps([['environment', 'sun']], (ev.target as HTMLInputElement).checked ? { azimuthDeg: 200, elevationDeg: 45 } : undefined, 'Set sun') }), el('span', {}, 'Own sun position')),
    env.sun ? el('div', { class: 'ed-sub' }, num(e, 'Azimuth', [['environment', 'sun', 'azimuthDeg']], { min: 0, max: 360, step: 1, unit: '°' }), num(e, 'Elevation', [['environment', 'sun', 'elevationDeg']], { min: -10, max: 90, step: 1, unit: '°' })) : null,
    el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: !!env.fog, onchange: (ev: Event) => e.setProps([['environment', 'fog']], (ev.target as HTMLInputElement).checked ? { color: '#a9b0b5', density: 0.004 } : undefined, 'Set fog') }), el('span', {}, 'Fog')),
    env.fog ? el('div', { class: 'ed-sub' }, color(e, 'Colour', [['environment', 'fog', 'color']]), num(e, 'Density', [['environment', 'fog', 'density']], { min: 0, max: 0.1, step: 0.001 })) : null,
    num(e, 'Elevation', [['elevationM']], { min: -500, max: 9000, step: 10, unit: 'm ASL', opt: true }),
    note('Elevation sets the air density (thinner air: less thrust and drag).'));
  const wind = sec('Wind',
    el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: !!env.wind, onchange: (ev: Event) => e.setProps([['environment', 'wind']], (ev.target as HTMLInputElement).checked ? { speed: 3, directionDeg: 240, turbulence: 1, gusts: 2 } : undefined, 'Set wind') }), el('span', {}, 'The map suggests a wind')),
    env.wind ? el('div', { class: 'ed-sub' },
      num(e, 'Speed', [['environment', 'wind', 'speed']], { min: 0, max: 30, step: 0.5, unit: 'm/s' }), num(e, 'From', [['environment', 'wind', 'directionDeg']], { min: 0, max: 360, step: 5, unit: '°' }),
      num(e, 'Turbulence', [['environment', 'wind', 'turbulence']], { min: 0, max: 3, step: 0.1, opt: true }), num(e, 'Gusts', [['environment', 'wind', 'gusts']], { min: 0, max: 20, step: 0.5, unit: '/min', opt: true }),
      note('Applied when the map loads, unless the pilot or a scenario sets another.')) : null,
    num(e, 'Wind scale', [['environment', 'windScale']], { min: 0, max: 2, step: 0.05, opt: true, placeholder: '1' }));
  const volumes = sec('Volumes and lights',
    el('div', { class: 'ed-grid' },
      toolBtn(e, `Indoor zone (${doc.indoor?.length ?? 0})`, { kind: 'indoor' }, { title: 'A box where the wind is scaled down (halls, tunnels)' }),
      toolBtn(e, `Wake zone (${doc.wakeZones?.length ?? 0})`, { kind: 'wake' }, { title: 'Turbulent air behind buildings and trees' }),
      toolBtn(e, `Light (${doc.lights?.length ?? 0} / ${BUDGETS.lights})`, { kind: 'light' }, { title: 'A point light (fixture, floodlight)' })));
  const spawn = sec('Spawn and pilot',
    row(plainBtn('Select the main spawn', () => { e.select([['spawn']]); e.frameSelection(); }),
      doc.pilot ? plainBtn('Select the pilot', () => { e.select([['pilot']]); e.frameSelection(); }) : plainBtn('Add a pilot position', () => { const s = doc.spawn?.pos ?? [0, 0, 0]; e.setProps([['pilot']], [s[0] - 2, s[1] - 2, Math.round((e.terrainAt(s[0] - 2, s[1] - 2) + 1.6) * 100) / 100], 'Add pilot'); e.select([['pilot']]); })),
    note('The pilot position is where the video receiver and the line-of-sight view stand (default: 2 m behind the spawn).'));
  return [sky, wind, groundSection(e), volumes, spawn];
}

function groundSection(e: Editor): HTMLElement {
  const g = e.ed.doc.ground, G = ['ground'];
  const setType = (t: string) => {
    if (t === g?.type) return;
    const keep = { ...(g?.material && { material: g.material }), ...(g?.visible !== undefined && { visible: g.visible }), ...(g?.texture && { texture: g.texture }) };
    if (t === 'heightfield') { e.convertToHeightfield(); return; }
    const v: GroundDoc = t === 'flat' ? { type: 'flat', ...keep } : { type: 'noise', base: 0, layers: [{ scale: 60, amplitude: 4, octaves: 4, seed: 1 }], ...keep };
    e.ed.apply('Set ground', [{ k: 'set', path: G, v }, ...(e.ed.grid ? [{ k: 'grid', v: null } as Op] : [])]);
  };
  const typeSel = labelled('Type', el('select', { onchange: (ev: Event) => setType((ev.target as HTMLSelectElement).value) }, ...['flat', 'noise', 'heightfield'].map((t) => el('option', { value: t, selected: (g?.type ?? 'flat') === t }, t))));
  const kids: (HTMLElement | null)[] = [typeSel];
  if (!g || g.type === 'flat') kids.push(num(e, 'Height', [[...G, 'z']], { step: 0.1, unit: 'm', opt: true, placeholder: '0' }));
  else if (g.type === 'noise') {
    kids.push(num(e, 'Base', [[...G, 'base']], { step: 0.5, unit: 'm', opt: true, placeholder: '0' }));
    g.layers.forEach((l: NoiseLayer, i: number) => {
      const L = [...G, 'layers', i];
      kids.push(el('div', { class: 'ed-sub' }, el('h4', {}, `Layer ${i + 1}`),
        num(e, 'Scale', [[...L, 'scale']], { min: 0.1, step: 1, unit: 'm' }), num(e, 'Amplitude', [[...L, 'amplitude']], { step: 0.5, unit: 'm' }),
        num(e, 'Octaves', [[...L, 'octaves']], { min: 1, max: 8, step: 1, opt: true, placeholder: '4' }), num(e, 'Seed', [[...L, 'seed']], { step: 1, opt: true, placeholder: '1' }),
        el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: !!l.mask, onchange: (ev: Event) => e.setProps([[...L, 'mask']], (ev.target as HTMLInputElement).checked ? { shape: 'circle', from: 20, to: 60 } : undefined, 'Set mask') }), el('span', {}, 'Flat in the middle (mask)')),
        l.mask ? el('div', {}, sel(e, 'Mask shape', [[...L, 'mask', 'shape']], ['circle', 'square']), num(e, 'Flat to', [[...L, 'mask', 'from']], { min: 0, step: 1, unit: 'm' }), num(e, 'Full from', [[...L, 'mask', 'to']], { min: 0, step: 1, unit: 'm' }), chk(e, 'Invert', [[...L, 'mask', 'invert']])) : null,
        g.layers.length > 1 ? plainBtn('Remove layer', () => e.ed.apply('Remove layer', [{ k: 'del', path: [...G, 'layers'], i }])) : null));
    });
    if (g.layers.length < 8) kids.push(plainBtn('Add layer', () => e.ed.insert([...G, 'layers'], { scale: 20, amplitude: 1, seed: g.layers.length + 1 }, 'Add layer')));
  } else {
    const grid = e.ed.grid;
    const range = (k: 'zMin' | 'zMax') => labelled(k === 'zMin' ? 'Lowest' : 'Highest', numIn(g[k], false, { step: 1 }, (v) => {
      if (v === undefined || !grid) return;
      const to: [number, number] = k === 'zMin' ? [v, g.zMax] : [g.zMin, v];
      if (!(to[1] > to[0])) { e.toast('The highest point must be above the lowest'); return; }
      // the terrain keeps its heights: the grid is re-quantised into the new range
      e.ed.apply('Set height range', [{ k: 'set', path: [...G, k], v }, { k: 'grid', v: requantize(grid, [g.zMin, g.zMax], to) }]);
    }), 'm');
    const resSel = el('select', { 'aria-label': 'Resolution', onchange: (ev: Event) => { const n = Number((ev.target as HTMLSelectElement).value); if (grid && n !== grid.w) e.ed.apply('Resample heightfield', [{ k: 'grid', v: resample(grid, n, n) }]); } },
      ...[...new Set([129, 257, 513, 1025, grid?.w ?? 257])].sort((a, b) => a - b).map((v) => el('option', { value: v, selected: grid?.w === v }, `${v} x ${grid && grid.w === v ? grid.h : v} px`)));
    const imp = el('input', { type: 'file', accept: 'image/png', class: 'ed-file', 'aria-label': 'Import heightfield PNG' }) as HTMLInputElement;
    imp.addEventListener('change', () => { const f = imp.files?.[0]; if (f) void e.importHeightfield(f); imp.value = ''; });
    kids.push(vec(e, 'Extent', [[...G, 'extent']], 2, { min: 1, step: 1, unit: 'm', names: ['east-west', 'north-south'] }), vec(e, 'Centre', [[...G, 'center']], 2, { step: 1, unit: 'm', opt: true, def: [0, 0] }),
      range('zMin'), range('zMax'), labelled('Resolution', resSel),
      row(el('label', { class: 'ed-btn ed-small' }, 'Import PNG…', imp), plainBtn('Export PNG', () => void e.exportHeightfield())),
      note('Changing the height range keeps the terrain\'s heights (clipped to the new range). 16-bit greyscale PNG: black = lowest, white = highest, north at the top.'));
  }
  kids.push(sel(e, 'Material', [[...G, 'material']], ['grass', 'dirt', 'concrete'], { opt: 'grass (default)' }), chk(e, 'Drawn', [[...G, 'visible']], true), g ? texture(e, 'Texture', [[...G, 'texture']]) : null);
  return sec('Ground', ...kids);
}

const ACTOR_PRESETS: { label: string; title: string; actor: ActorDoc }[] = [
  { label: 'Jammer', title: 'An RF emitter on the 2.4 GHz control band', actor: { type: 'rf-emitter', id: 'jammer', name: 'Jammer', freqMHz: 2440, eirpDbm: 33, bwMHz: 80 } },
  { label: 'Interferer', title: 'Another link\'s traffic: a 5.8 GHz video transmitter, on and off', actor: { type: 'rf-emitter', id: 'interferer', name: 'Interferer', freqMHz: 5800, eirpDbm: 25, bwMHz: 20, duty: 0.4 } },
  { label: 'Ground station', title: 'Relay / diversity receiver site: the best site carries the link', actor: { type: 'ground-station', id: 'station', name: 'Ground station', link: 'both' } },
  { label: 'Camera', title: 'Optical detector', actor: { type: 'detector', id: 'camera', name: 'Camera', sensor: 'camera', fovDeg: [60, 40], rangeM: 300 } },
  { label: 'Radar', title: 'Radar detector', actor: { type: 'detector', id: 'radar', name: 'Radar', sensor: 'radar', fovDeg: [90, 30], rangeM: 1000 } },
  { label: 'RF detector', title: 'Detects the quad\'s video transmitter', actor: { type: 'detector', id: 'rf-det', name: 'RF detector', sensor: 'rf', rangeM: 1500 } },
  { label: 'Target', title: 'Something to reach, inspect or track', actor: { type: 'target', id: 'target', name: 'Target', shape: 'box', radiusM: 1 } },
  { label: 'Person', title: 'A person-sized target', actor: { type: 'target', id: 'person', name: 'Person', shape: 'person' } },
  { label: 'Vehicle', title: 'A vehicle-sized target (bind it to a path to move it)', actor: { type: 'target', id: 'vehicle', name: 'Vehicle', shape: 'vehicle' } },
];

function simulationPalette(e: Editor): HTMLElement[] {
  const doc = e.ed.doc;
  const listOf = <T>(items: T[] | undefined, path: (i: number) => Path, labelOf: (x: T, i: number) => string, empty: string) => items?.length
    ? el('ul', { class: 'ed-list' }, ...items.map((x, i) => el('li', { class: e.sel.some((r) => key(r).startsWith(key(path(i)).slice(0, -1))) ? 'on' : '' }, el('button', { type: 'button', class: 'ed-li-main', onclick: () => { e.select([path(i)]); e.frameSelection(); } }, labelOf(x, i)))))
    : note(empty);
  const spawns = sec(`Spawns (${doc.spawns?.length ?? 0} / ${BUDGETS.spawns})`,
    el('div', { class: 'ed-grid' }, toolBtn(e, 'Spawn pad', { kind: 'spawnPad' }), toolBtn(e, 'Spawn only', { kind: 'spawn' })),
    listOf(doc.spawns, (i) => ['spawns', i], (s) => `${s.name ?? s.id} · ${s.id}`, 'Named start variants (pick one in New game, Fly, or a scenario\'s start.spawn).'));
  const pathTool = e.tool.t === 'path';
  const paths = sec(`Paths (${doc.paths?.length ?? 0} / ${BUDGETS.paths})`,
    btn(pathTool ? 'Finish path' : 'Draw a path', () => e.setTool(pathTool ? { t: 'select' } : { t: 'path', index: null }), { on: pathTool, cls: 'ed-tool', title: 'Click points on the ground; Enter or Esc to finish' }),
    listOf(doc.paths, (i) => ['paths', i, 'points', 0], (p) => `${p.id} · ${p.points.length} points · ${p.speedMs} m/s ${p.mode ?? 'loop'}`, 'Polylines that actors move along (sim time).'));
  const actors = sec(`Actors (${doc.actors?.length ?? 0} / ${BUDGETS.actors})`,
    el('div', { class: 'ed-grid' }, ...ACTOR_PRESETS.map((a) => toolBtn(e, a.label, { kind: 'actor', actor: a.actor }, { title: a.title }))),
    listOf(doc.actors, (i) => ['actors', i], (a) => `${a.name ?? a.id} · ${a.type}${a.path ? ` on ${a.path}` : ''}`, 'RF emitters, ground stations, detectors and targets for research scenarios.'));
  const scs = doc.scenarios ?? [];
  const scen = sec(`Scenarios (${scs.length} / ${BUDGETS.scenarios})`,
    scs.length ? el('ul', { class: 'ed-list' }, ...scs.map((p) => el('li', { class: e.pal.scenario === p ? 'on' : '' }, el('button', { type: 'button', class: 'ed-li-main', onclick: () => { e.pal.scenario = p; e.select([]); } }, p)))) : note('fpvsim-scenario files bundled with the map: a task, conditions and randomization on this map, run in the live sim or headless.'),
    plainBtn('New scenario', () => newScenario(e)));
  return [spawns, paths, actors, scen];
}

// ---------------------------------------------------------------------------------------------
// Inspector

export function renderInspector(e: Editor): HTMLElement {
  const refs = e.sel;
  if (!refs.length) return e.pal.scenario && e.ed.doc.scenarios?.includes(e.pal.scenario) ? renderScenarioForm(e, e.pal.scenario) : metaPanel(e);
  const kinds = new Set(refs.map(refKind));
  const head = el('div', { class: 'ed-insp-head' }, el('h2', {}, refs.length === 1 ? KIND_NAMES[refKind(refs[0])!] ?? 'Object' : `${refs.length} objects`),
    el('div', { class: 'ed-row' }, plainBtn('Frame (F)', () => e.frameSelection()), plainBtn('Deselect (Esc)', () => e.select([]))));
  const kids: (HTMLElement | null)[] = [head];
  const group = prefabGroup(e);
  if (group) kids.push(group);
  if (kinds.size === 1) {
    const k = [...kinds][0]!, P = (f: string | (string | number)[]) => refs.map((r) => [...r, ...(Array.isArray(f) ? f : [f])]);
    const objs = refs.map((r) => e.ed.get(r) as Obj);
    switch (k) {
      case 'prim': kids.push(...primFields(e, refs, objs, P)); break;
      case 'gate': kids.push(...gateFields(e, refs, objs, P)); break;
      case 'tree': kids.push(vec(e, 'Position', P('pos'), 2, { step: 0.1, unit: 'm' }), num(e, 'Height', P('height'), { min: 0.5, max: 60, step: 0.5, unit: 'm' }), num(e, 'Crown radius', P('radius'), { min: 0.1, max: 20, step: 0.1, unit: 'm' }), sel(e, 'Type', P('type'), ['pine', 'oak'])); break;
      case 'spawn': case 'mainSpawn': kids.push(...spawnFields(e, refs, objs, P, k === 'mainSpawn')); break;
      case 'pilot': kids.push(vec(e, 'Position', refs, 3, { step: 0.1, unit: 'm' }), note('Eye height: about 1.6 m above the ground.')); break;
      case 'light': kids.push(vec(e, 'Position', P('pos'), 3, { step: 0.1, unit: 'm' }), color(e, 'Colour', P('color'), { opt: true, def: '#ffffff' }), num(e, 'Intensity', P('intensity'), { min: 0.01, max: 10000, step: 10 }), num(e, 'Range', P('range'), { min: 0.1, max: 1000, step: 1, unit: 'm' }), note(`Illuminance ~ intensity / distance² (the sun is ~4.5). ${e.ed.doc.lights?.length ?? 0} of ${BUDGETS.lights} lights.`)); break;
      case 'indoor': kids.push(vec(e, 'Min corner', P('min'), 3, { step: 0.1, unit: 'm' }), vec(e, 'Max corner', P('max'), 3, { step: 0.1, unit: 'm' }), num(e, 'Wind scale', P('windScale'), { min: 0, max: 1, step: 0.01, opt: true, placeholder: '0.1' }), note('Wind inside this box is multiplied by the wind scale.')); break;
      case 'wake': kids.push(vec(e, 'Position', P('pos'), 2, { step: 0.1, unit: 'm' }), num(e, 'Radius', P('radius'), { min: 0.1, step: 0.5, unit: 'm' }), num(e, 'Height', P('height'), { min: 0.1, step: 0.5, unit: 'm' }), num(e, 'Intensity', P('intensity'), { min: 0, max: 5, step: 0.1 })); break;
      case 'actor': kids.push(...actorFields(e, refs, objs, P)); break;
      case 'pathPoint': kids.push(...pathFields(e, refs)); break;
      case 'mesh': kids.push(el('p', { class: 'ed-stat' }, objs.map((o) => o.src).join(', ')), vec(e, 'Position', P('pos'), 3, { step: 0.1, unit: 'm', def: [0, 0, 0] }), num(e, 'Yaw', P('yawDeg'), { step: 1, unit: '°', opt: true }), num(e, 'Scale', P('scale'), { min: 0.001, max: 1000, step: 0.1, opt: true, placeholder: '1' }), sel(e, 'Collision', P('collision'), ['mesh', 'box', 'none'], { opt: 'mesh (default)' }), sel(e, 'Material', P('material'), MATERIAL_NAMES, { opt: 'concrete (default)' })); break;
    }
  } else kids.push(note('Several kinds of object: move, turn, copy or delete them together.'));
  kids.push(arrayTool(e));
  return el('div', {}, ...kids);
}

function primFields(e: Editor, refs: Path[], objs: Obj[], P: (f: string) => Path[]): (HTMLElement | null)[] {
  const types = new Set(objs.map((o) => o.type)), t = types.size === 1 ? objs[0].type as PrimDoc['type'] : null;
  const convert = (to: string) => {
    const ops: Op[] = refs.map((r, i) => {
      const o = objs[i], keep = { material: o.material, ...(o.color && { color: o.color }), ...(o.tag && { tag: o.tag }), ...(o['x-group'] && { 'x-group': o['x-group'] }) };
      const r0 = o.type === 'box' ? Math.max(o.size[0], o.size[1]) / 2 : o.radius, h = o.type === 'box' ? o.size[2] : o.type === 'cylinder' ? o.height : o.radius * 2;
      const base = o.type === 'cylinder' ? o.pos[2] : o.pos[2] - h / 2; // bottom of the old shape
      const v = to === 'box' ? { type: 'box', pos: [o.pos[0], o.pos[1], base + h / 2], size: [2 * r0, 2 * r0, h], ...keep } : to === 'cylinder' ? { type: 'cylinder', pos: [o.pos[0], o.pos[1], base], radius: r0, height: h, ...keep } : { type: 'sphere', pos: [o.pos[0], o.pos[1], base + r0], radius: r0, ...keep };
      return { k: 'set', path: r, v };
    });
    e.ed.apply('Change shape', ops);
  };
  const out: (HTMLElement | null)[] = [
    labelled('Shape', el('select', { onchange: (ev: Event) => convert((ev.target as HTMLSelectElement).value) }, ...(t ? [] : [el('option', { selected: true }, 'mixed')]), ...['box', 'cylinder', 'sphere'].map((x) => el('option', { value: x, selected: t === x }, x)))),
    vec(e, 'Position', P('pos'), 3, { step: 0.1, unit: 'm' }),
  ];
  if (t === 'box') {
    const vis = objs[0].visual;
    out.push(vec(e, 'Size', P('size'), 3, { min: 0.001, step: 0.1, unit: 'm' }), num(e, 'Yaw', P('yawDeg'), { step: 1, unit: '°', opt: true }), num(e, 'Pitch', P('pitchDeg'), { min: -90, max: 90, step: 1, unit: '°', opt: true }),
      sel(e, 'Look', P('visual'), VISUALS, { opt: 'concrete (default)' }), texture(e, 'Texture', P('texture')),
      vis === 'banner' || vis === 'screen' ? text(e, 'Text', P('text'), { opt: true, max: 40 }) : null);
  } else if (t === 'cylinder') out.push(num(e, 'Radius', P('radius'), { min: 0.001, step: 0.05, unit: 'm' }), num(e, 'Height', P('height'), { min: 0.001, step: 0.1, unit: 'm' }), note('A cylinder stands on its position.'));
  else if (t === 'sphere') out.push(num(e, 'Radius', P('radius'), { min: 0.001, step: 0.05, unit: 'm' }));
  out.push(sel(e, 'Material', P('material'), MATERIAL_NAMES, { opt: t === 'cylinder' ? 'metal (default)' : 'concrete (default)' }), color(e, 'Colour', P('color'), { opt: true }), text(e, 'Tag', P('tag'), { opt: true, max: 32, placeholder: 'none' }));
  return out;
}

function gateFields(e: Editor, refs: Path[], objs: Obj[], P: (f: string) => Path[]): (HTMLElement | null)[] {
  const kind = new Set(objs.map((o) => o.kind)).size === 1 ? objs[0].kind as keyof typeof GATE_SIZE : null, d = kind ? GATE_SIZE[kind] : null;
  const ground = objs.every((o) => o.pos.length === 2);
  const out: (HTMLElement | null)[] = [
    sel(e, 'Kind', P('kind'), GATE_KINDS, { onSet: (v) => { if (!v) return; e.ed.apply('Change gate kind', refs.map((r, i) => ({ k: 'set', path: r, v: { ...objs[i], kind: v, pos: v === 'dive' && objs[i].pos.length === 2 ? [objs[i].pos[0], objs[i].pos[1], Math.round((e.terrainAt(objs[i].pos[0], objs[i].pos[1]) + 2) * 100) / 100] : objs[i].pos } }))); } }),
    vec(e, 'Position', P('pos'), ground ? 2 : 3, { step: 0.1, unit: 'm' }),
    kind !== 'dive' ? el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: ground, onchange: (ev: Event) => {
      const on = (ev.target as HTMLInputElement).checked;
      e.ed.apply(on ? 'Put gate on the ground' : 'Lift gate', refs.map((r, i) => { const o = { ...objs[i] }; if (on) { o.pos = [o.pos[0], o.pos[1]]; delete o.onTop; } else o.pos = [o.pos[0], o.pos[1], Math.round(e.terrainAt(o.pos[0], o.pos[1]) * 100) / 100]; return { k: 'set', path: r, v: o }; }));
    } }), el('span', {}, 'Stands on the terrain')) : null,
    num(e, 'Yaw', P('yawDeg'), { step: 5, unit: '°', opt: true, placeholder: '0 (fly north)' }),
    num(e, 'Width', P('width'), { min: 0.1, max: 20, step: 0.1, unit: 'm', opt: true, placeholder: d ? fmt(d[0]) : 'default' }),
    num(e, 'Height', P('height'), { min: 0.1, max: 20, step: 0.1, unit: 'm', opt: true, placeholder: d ? fmt(d[1]) : 'default' }),
    kind === 'ladder' ? num(e, 'Openings', P('stack'), { min: 1, max: 6, step: 1, opt: true, placeholder: '3' }) : null,
    !ground ? chk(e, 'On top of something (no legs)', P('onTop')) : null,
    row(plainBtn('Turn round', () => e.ed.apply('Turn gate round', refs.map((r, i) => ({ k: 'set', path: [...r, 'yawDeg'], v: ((((objs[i].yawDeg ?? 0) + 180) % 360) + 540) % 360 - 180 })))) ),
  ];
  if (refs.length === 1) {
    const r = refs[0], base = r.slice(0, -1), i = r[r.length - 1] as number, n = (e.ed.get(base) as unknown[]).length;
    const move = (to: number) => { const l = [...(e.ed.get(base) as unknown[])]; const [g] = l.splice(i, 1); l.splice(to, 0, g); e.ed.apply('Reorder gates', [{ k: 'set', path: base, v: l }]); e.select([[...base, to]]); };
    out.push(el('p', { class: 'ed-stat' }, `Gate ${i + 1} of ${n} in the lap`, ' ', el('button', { type: 'button', class: 'ed-x', disabled: i === 0, onclick: () => move(i - 1), 'aria-label': 'Earlier in the lap' }, '↑'), el('button', { type: 'button', class: 'ed-x', disabled: i === n - 1, onclick: () => move(i + 1), 'aria-label': 'Later in the lap' }, '↓')));
  }
  return out;
}

function spawnFields(e: Editor, refs: Path[], objs: Obj[], P: (f: string) => Path[], main: boolean): (HTMLElement | null)[] {
  const one = refs.length === 1 ? objs[0] : null;
  return [
    main ? null : text(e, 'Id', P('id'), { max: 32 }), main ? null : text(e, 'Name', P('name'), { opt: true, max: 64 }),
    vec(e, 'Position', P('pos'), 3, { step: 0.1, unit: 'm' }), num(e, 'Heading', P('yawDeg'), { step: 5, unit: '°', opt: true, placeholder: '0 = east, 90 = north' }),
    num(e, 'Floor height', P('groundZ'), { step: 0.1, unit: 'm', opt: true, placeholder: 'terrain' }),
    main ? note('The default start. Also check Environment → Spawn and pilot.') : vec(e, 'Pilot at', P('pilot'), 3, { step: 0.1, unit: 'm', opt: true, def: one ? [one.pos[0] - 2, one.pos[1] - 2, one.pos[2] + 1.6] : [0, 0, 1.6] }),
    !main && one ? row(
      plainBtn('Make it the main spawn', () => e.ed.apply('Set main spawn', [{ k: 'set', path: ['spawn'], v: { pos: one.pos, ...(one.yawDeg !== undefined && { yawDeg: one.yawDeg }), ...(one.groundZ !== undefined && { groundZ: one.groundZ }) } }])),
      plainBtn('Fly from here', () => { e.s.fly.spawn = one.id; void e.fly(); })) : null,
  ];
}

function actorFields(e: Editor, refs: Path[], objs: Obj[], P: (f: string | (string | number)[]) => Path[]): (HTMLElement | null)[] {
  const types = new Set(objs.map((o) => o.type)), t = types.size === 1 ? objs[0].type as ActorDoc['type'] : null, one = refs.length === 1 ? objs[0] : null;
  const paths = e.ed.doc.paths ?? [];
  const out: (HTMLElement | null)[] = [];
  if (one) out.push(text(e, 'Id', P('id'), { max: 32 }));
  out.push(text(e, 'Name', P('name'), { opt: true, max: 64 }));
  // placement: fixed, or moving along a path
  const bound = objs.every((o) => o.path), free = objs.every((o) => !o.path);
  out.push(labelled('Placement', el('select', { onchange: (ev: Event) => {
    const v = (ev.target as HTMLSelectElement).value;
    e.ed.apply('Set placement', refs.map((r, i) => {
      const o = { ...objs[i] };
      if (v === '') { if (o.path) { const p = paths.find((x) => x.id === o.path); o.pos = p ? [...p.points[0]] : [0, 0, 0]; delete o.path; } }
      else { delete o.pos; o.path = v; if (o.type === 'target') delete o.solid; }
      return { k: 'set', path: r, v: o };
    }));
  } }, ...(bound || free ? [] : [el('option', { selected: true }, 'mixed')]), el('option', { value: '', selected: free }, 'Fixed position'), ...paths.map((p) => el('option', { value: p.id, selected: bound && objs[0].path === p.id }, `Moves along ${p.id}`)))));
  if (free) out.push(vec(e, 'Position', P('pos'), 3, { step: 0.1, unit: 'm' }));
  else if (!paths.length) out.push(note('Draw a path first (Simulation → Paths).'));
  if (t === 'rf-emitter') {
    const ant = objs.every((o) => o.antenna);
    out.push(num(e, 'Frequency', P('freqMHz'), { min: 100, max: 10000, step: 1, unit: 'MHz' }), num(e, 'EIRP', P('eirpDbm'), { min: -30, max: 70, step: 1, unit: 'dBm' }),
      num(e, 'Bandwidth', P('bwMHz'), { min: 0.01, max: 1000, step: 1, unit: 'MHz', opt: true, placeholder: '20' }), num(e, 'Duty cycle', P('duty'), { min: 0, max: 1, step: 0.05, opt: true, placeholder: '1' }),
      el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: ant, onchange: (ev: Event) => e.setProps(P('antenna'), (ev.target as HTMLInputElement).checked ? { yawDeg: 0, pitchDeg: 0, beamDeg: 60 } : undefined, 'Set antenna') }), el('span', {}, 'Directional antenna')),
      ant ? el('div', { class: 'ed-sub' }, num(e, 'Aim (yaw)', P(['antenna', 'yawDeg']), { step: 5, unit: '°' }), num(e, 'Aim (pitch)', P(['antenna', 'pitchDeg']), { min: -90, max: 90, step: 1, unit: '°', opt: true }), num(e, 'Beam width', P(['antenna', 'beamDeg']), { min: 1, max: 360, step: 5, unit: '°' })) : null,
      note('In band of the RC (2.4 GHz / 868 / 915 MHz) or video (5.8 GHz) link, it raises the noise floor: lower link quality, failsafe close in.'));
  } else if (t === 'ground-station') out.push(sel(e, 'Link', P('link'), ['rc', 'video', 'both'], { opt: 'both (default)' }), num(e, 'TX power', P('txPowerMw'), { min: 0.01, max: 10000, step: 10, unit: 'mW', opt: true, placeholder: 'the pilot\'s radio' }), num(e, 'Antenna gain', P('gainDbi'), { min: -10, max: 30, step: 0.5, unit: 'dBi', opt: true, placeholder: '2' }));
  else if (t === 'detector') out.push(sel(e, 'Sensor', P('sensor'), ['camera', 'radar', 'rf']), num(e, 'Look (yaw)', P('yawDeg'), { step: 5, unit: '°', opt: true, placeholder: '0 = east' }), num(e, 'Look (pitch)', P('pitchDeg'), { min: -90, max: 90, step: 1, unit: '°', opt: true }),
    vec(e, 'Field of view', P('fovDeg'), 2, { min: 1, max: 360, step: 1, unit: '°', opt: true, names: ['horizontal', 'vertical'], def: objs[0].sensor === 'camera' ? [60, 40] : objs[0].sensor === 'radar' ? [90, 30] : [360, 180] }),
    num(e, 'Range', P('rangeM'), { min: 1, max: 20000, step: 10, unit: 'm' }), num(e, '50 % range', P('r50M'), { min: 1, max: 20000, step: 10, unit: 'm', opt: true, placeholder: 'from the range' }),
    num(e, 'Sensitivity', P('sensitivityDbm'), { min: -150, max: 0, step: 1, unit: 'dBm', opt: true, placeholder: '-90' }), num(e, 'Looks per second', P('rateHz'), { min: 0.1, max: 100, step: 1, unit: 'Hz', opt: true, placeholder: '10' }),
    vec(e, 'Confirm (m of n)', P('confirm'), 2, { min: 1, max: 32, step: 1, opt: true, names: ['m', 'n'], def: [2, 3] }));
  else if (t === 'target') {
    out.push(sel(e, 'Shape', P('shape'), TARGET_SHAPES, { opt: 'box (default)' }), vec(e, 'Size', P('size'), 3, { min: 0.01, step: 0.1, unit: 'm', opt: true, def: [2, 2, 2] }), num(e, 'Radius', P('radiusM'), { min: 0.01, max: 1000, step: 0.1, unit: 'm', opt: true, placeholder: '1' }),
      color(e, 'Colour', P('color'), { opt: true, def: '#e8433a' }), free ? chk(e, 'Solid (collides)', P('solid')) : note('Moving targets are not solid.'));
  }
  return out;
}

function pathFields(e: Editor, refs: Path[]): (HTMLElement | null)[] {
  const pis = [...new Set(refs.map((r) => r[1] as number))], one = refs.length === 1 ? refs[0] : null;
  const out: (HTMLElement | null)[] = [vec(e, 'Point', refs, 3, { step: 0.1, unit: 'm' })];
  if (pis.length === 1) {
    const pi = pis[0], p = e.ed.doc.paths![pi], P = (k: string): Path[] => [['paths', pi, k]];
    out.push(el('h3', {}, `Path ${p.id}`), text(e, 'Id', P('id'), { max: 32 }), num(e, 'Speed', P('speedMs'), { min: 0, max: 100, step: 0.5, unit: 'm/s' }), sel(e, 'Mode', P('mode'), ['loop', 'pingpong', 'once'], { opt: 'loop (default)' }), num(e, 'Starts after', P('delayS'), { min: 0, max: 3600, step: 1, unit: 's', opt: true, placeholder: '0' }),
      el('p', { class: 'ed-stat' }, `${p.points.length} points`),
      row(one ? plainBtn('Insert point after', () => { const i = one[3] as number, a = p.points[i], b = p.points[i + 1] ?? a; e.ed.apply('Insert path point', [{ k: 'ins', path: ['paths', pi, 'points'], i: i + 1, v: [0, 1, 2].map((k) => Math.round(((a[k] + b[k]) / 2 + (b === a ? (k === 0 ? 3 : 0) : 0)) * 1000) / 1000) }]); e.select([['paths', pi, 'points', i + 1]]); }) : null,
        plainBtn('Select every point', () => e.select(p.points.map((_, i): Path => ['paths', pi, 'points', i]))),
        plainBtn('Continue drawing', () => e.setTool({ t: 'path', index: pi })),
        plainBtn('Delete path', () => { e.select([]); e.ed.apply('Delete path', [{ k: 'del', path: ['paths'], i: pi }]); })),
      (e.ed.doc.actors ?? []).some((a) => a.path === p.id) ? note(`Used by ${(e.ed.doc.actors ?? []).filter((a) => a.path === p.id).map((a) => a.name ?? a.id).join(', ')}.`) : null);
  }
  return out;
}

/** The selection is exactly one prefab: its parameters, which rebuild it in place. */
function prefabGroup(e: Editor): HTMLElement | null {
  const groups = new Set(e.sel.map((r) => (r.length === 2 ? (e.ed.get(r) as Obj | undefined)?.['x-group'] : undefined)));
  if (groups.size !== 1) return null;
  const g = [...groups][0] as string | undefined, m = g ? e.ed.meta.groups?.[g] : undefined, pf = m ? prefabById(m.prefab) : undefined;
  const members = g ? groupMembers(e.ed.doc, g) : [];
  if (!g) return null;
  const ungroup = plainBtn('Ungroup', () => e.ed.apply('Ungroup', [...members.map((p): Op => ({ k: 'set', path: [...p, 'x-group'], v: undefined })), { k: 'set', path: ['x-builder', 'groups', g], v: undefined }]));
  if (!m || !pf) return sec('Group', note(`${members.length} parts that select and move together.`), ungroup);
  const rebuild = (k: string, v: number | undefined) => {
    const params = { ...m.params }; if (v === undefined) delete params[k]; else params[k] = v;
    const out = placePrefab(pf, { ...prefabDefaults(pf), ...params }, m.pos, m.yawDeg, g);
    const prims = members.filter((p) => p[0] === 'primitives'), lights = members.filter((p) => p[0] === 'lights');
    const nP = (e.ed.doc.primitives?.length ?? 0) - prims.length, nL = (e.ed.doc.lights?.length ?? 0) - lights.length;
    if (nL + out.lights.length > BUDGETS.lights) { e.toast(`At most ${BUDGETS.lights} lights`); return; }
    e.ed.apply(`Edit ${pf.name.toLowerCase()}`, [...e.ed.removeOps(members.filter((p) => p[0] !== 'spawns')), ...out.prims.map((v, i): Op => ({ k: 'ins', path: ['primitives'], i: nP + i, v })), ...out.lights.map((v, i): Op => ({ k: 'ins', path: ['lights'], i: nL + i, v })), { k: 'set', path: ['x-builder', 'groups', g], v: { ...m, params } }]);
    e.select([...out.prims.map((_, i): Path => ['primitives', nP + i]), ...out.lights.map((_, i): Path => ['lights', nL + i])]);
  };
  return sec(pf.name, note(`${pf.blurb}. ${members.length} parts; change a value to rebuild it in place.`),
    ...pf.params.map((p) => labelled(p.label, numIn(m.params[p.key] ?? p.def, false, { min: p.min, max: p.max, step: p.step }, (v) => rebuild(p.key, v)), p.unit)), ungroup);
}

function arrayTool(e: Editor): HTMLElement {
  const st = { n: 4, dx: 5, dy: 0, dz: 0, yaw: 0 };
  return el('details', { class: 'ed-sec ed-array' }, el('summary', {}, 'Array (several copies)'),
    palNum('Copies', st, 'n', { min: 1, max: 100, step: 1 }), palNum('Step east', st, 'dx', { step: 0.5, unit: 'm' }), palNum('Step north', st, 'dy', { step: 0.5, unit: 'm' }), palNum('Step up', st, 'dz', { step: 0.1, unit: 'm' }), palNum('Turn each', st, 'yaw', { step: 5, unit: '°' }),
    plainBtn('Make copies', () => e.copies(Math.round(st.n), [st.dx, st.dy, st.dz], st.yaw)),
    note('Turning copies round the selection\'s centre with no step makes a ring.'));
}

function metaPanel(e: Editor): HTMLElement {
  const doc = e.ed.doc, M = (k: string): Path[] => [['meta', k]];
  const lic = doc.meta.license, licOpts = ALLOWED_LICENSES.includes(lic) ? ALLOWED_LICENSES : [lic, ...ALLOWED_LICENSES];
  const tags = el('input', { type: 'text', value: (doc.meta.tags ?? []).join(', '), placeholder: 'race, freestyle, indoor …', spellcheck: false }) as HTMLInputElement;
  tags.addEventListener('change', () => { const t = tags.value.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 8); e.setProps([['meta', 'tags']], t.length ? t : undefined, 'Set tags'); });
  const prevImg = doc.meta.preview && e.ed.assets.get(doc.meta.preview) ? el('img', { class: 'ed-preview', alt: 'Map preview', src: e.url(doc.meta.preview) }) : null;
  const credits = e.ed.meta.credits ?? [];
  const C = (i: number, k: string): Path[] => [['x-builder', 'credits', i, k]];
  const files = [...e.ed.assets].sort(([a], [b]) => (a < b ? -1 : 1));
  return el('div', {},
    el('div', { class: 'ed-insp-head' }, el('h2', {}, 'Map'), note('Nothing selected: click an object in the view, or pick a tool in the palette.')),
    sec('About',
      text(e, 'Name', M('name'), { max: 64 }), text(e, 'Author', M('author'), { max: 96 }),
      sel(e, 'Licence', M('license'), licOpts),
      NEEDS_TEXT.test(lic) ? note(`${lic} needs its full text in the package: the export adds a LICENSE.txt to fill in.`) : null,
      text(e, 'Version', M('version'), { placeholder: '1.0.0' }),
      text(e, 'Description', M('description'), { opt: true, max: 600, area: true }),
      labelled('Tags', tags),
      text(e, 'Id', M('id'), { max: 24, placeholder: deriveId(doc.meta.name) }),
      note(`Package id (a-z, 0-9, "-"): flown as local-${/^[a-z0-9][a-z0-9-]{1,23}$/.test(doc.meta.id) ? doc.meta.id : deriveId(doc.meta.name)}. Empty: from the name.`),
      text(e, 'Homepage', M('homepage'), { opt: true, max: 200, placeholder: 'https://…' }),
      num(e, 'Half size', [['size']], { min: 5, max: BUDGETS.halfExtentM, step: 5, unit: 'm', placeholder: '100' }), note('The playable area is the square |x|, |y| ≤ this.')),
    sec('Preview', prevImg, row(plainBtn('Capture from the view', () => e.capturePreview()), doc.meta.preview ? plainBtn('Remove', () => e.ed.apply('Remove preview', [{ k: 'set', path: ['meta', 'preview'], v: undefined }, { k: 'asset', path: doc.meta.preview!, v: null }])) : null)),
    sec('Asset credits',
      note('Everything in the package that you did not make yourself: who made it, where it is from and its licence. Goes into ATTRIBUTION.md.'),
      ...credits.map((_, i) => el('div', { class: 'ed-sub' },
        sel(e, 'File', C(i, 'file'), [...new Set([...files.map(([p]) => p), credits[i].file].filter(Boolean))]), text(e, 'Author', C(i, 'author'), { max: 96 }), text(e, 'Source', C(i, 'source'), { max: 200, placeholder: 'URL or "own work"' }), text(e, 'Licence', C(i, 'license'), { max: 64, placeholder: 'CC0-1.0' }),
        plainBtn('Remove', () => e.ed.apply('Remove credit', [{ k: 'del', path: ['x-builder', 'credits'], i }])))),
      plainBtn('Add a credit', () => e.ed.insert(['x-builder', 'credits'], { file: files[0]?.[0] ?? '', author: '', source: '', license: doc.meta.license }, 'Add credit'))),
    sec('Package files',
      el('ul', { class: 'ed-list ed-files' }, el('li', {}, el('span', {}, 'map.json'), el('small', {}, 'generated')), ...(doc.ground?.type === 'heightfield' && e.ed.grid ? [el('li', {}, el('span', {}, doc.ground.image), el('small', {}, `${e.ed.grid.w} x ${e.ed.grid.h} 16-bit`))] : []),
        ...files.map(([p, b]) => el('li', {}, el('span', {}, p), el('small', {}, `${(b.size / 1024).toFixed(0)} KiB`), el('button', { type: 'button', class: 'ed-x', title: `Remove ${p}`, 'aria-label': `Remove ${p}`, onclick: () => e.ed.apply(`Remove ${p}`, [{ k: 'asset', path: p, v: null }]) }, '×'))))));
}

// ---------------------------------------------------------------------------------------------
// Problems and budgets

function meter(label: string, n: number, max: number, unit = ''): HTMLElement {
  const f = Math.min(1, n / max), show = (v: number) => (unit === 'B' ? `${(v / 1048576).toFixed(1)} MiB` : String(v));
  return el('div', { class: `ed-meter${n > max ? ' over' : f > 0.8 ? ' warn' : ''}`, title: `${label}: ${show(n)} of ${show(max)}` },
    el('span', { class: 'lbl' }, label), el('span', { class: 'bar' }, el('i', { style: { width: `${(f * 100).toFixed(1)}%` } })), el('span', { class: 'n' }, `${show(n)} / ${show(max)}`));
}

export function renderProblems(e: Editor): HTMLElement {
  const ps = [...e.problems].sort((a, b) => ['error', 'warning', 'info'].indexOf(a.level) - ['error', 'warning', 'info'].indexOf(b.level));
  const item = (p: { level: string; text: string; ref?: Path; fix?: { label: string; ops: Op[] } }) => el('li', { class: `ed-p ${p.level}` },
    el('span', { class: 'ed-p-ico', 'aria-label': p.level }, p.level === 'error' ? '✕' : p.level === 'warning' ? '!' : 'i'),
    p.ref && e.ed.get(p.ref) !== undefined ? el('button', { type: 'button', class: 'ed-li-main', onclick: () => { e.select([p.ref!]); e.frameSelection(); } }, p.text) : el('span', {}, p.text),
    p.fix ? plainBtn(p.fix.label, () => e.ed.apply(p.fix!.label, structuredClone(p.fix!.ops))) : null);
  const ck = e.check;
  const errs = ps.filter((p) => p.level === 'error').length;
  return el('div', { class: 'ed-foot-in' },
    el('div', { class: 'ed-problems' },
      el('h3', {}, errs ? `${errs} problem${errs === 1 ? '' : 's'}` : 'No problems', ps.length - errs ? el('small', {}, ` · ${ps.length - errs} note${ps.length - errs === 1 ? '' : 's'}`) : null),
      el('ul', {}, ...ps.map(item)),
      ck ? el('div', {}, el('h4', {}, ck.errors.length ? `Package check: ${ck.errors.length} error${ck.errors.length === 1 ? '' : 's'}` : 'Package check passed', ck.stats ? el('small', {}, ` · ${ck.stats.primitives} primitives, ${ck.stats.brushes} brushes, ${((ck.stats.bytes ?? 0) / 1024).toFixed(0)} KiB`) : null),
        el('ul', {}, ...ck.errors.map((t) => item({ level: 'error', text: t })), ...ck.warnings.map((t) => item({ level: 'warning', text: t })))) : null),
    el('div', { class: 'ed-meters', 'aria-label': 'Budgets' }, ...e.meters().filter((m) => m.n > 0 || ['Primitives', 'Gates', 'Lights'].includes(m.label)).map((m) => meter(m.label, m.n, m.max, m.unit))));
}
