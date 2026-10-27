// The outliner (Unity's Hierarchy, Unreal's Outliner): every object of the map in a tree by kind,
// courses with their gates in lap order, groups with their members, paths with their points. Each
// row selects, frames (double click), hides and locks; a search filters it. outlineTree() is the
// model (no DOM: tested in node); renderOutliner() draws it.
import type { ActorDoc, MapDocV1, PrimDoc } from '../maps/mapDoc';
import { el } from '../ui/dom';
import { icon, type IconName } from './icons';
import type { BuilderMeta, Path } from './editorDoc';
import { prefabById } from './prefabs';
import type { Editor } from './editor';

export interface OutlineNode {
  /** stable id of the row (expanded state, keyboard focus) */
  key: string;
  label: string;
  /** secondary text: the kind, a size */
  sub?: string;
  icon: IconName;
  /** the object this row is */
  ref?: Path;
  /** every object in this row and below it (what select, hide and lock act on) */
  refs: Path[];
  children?: OutlineNode[];
  /** the property a rename sets */
  rename?: Path;
}

type Obj = Record<string, any>;
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ''));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pk = (p: Path) => JSON.stringify(p);

export function primLabel(p: PrimDoc & Obj): { label: string; sub: string; icon: IconName } {
  const look = p.type === 'box' ? p.visual ?? p.material ?? 'concrete' : p.material ?? (p.type === 'cylinder' ? 'metal' : 'concrete');
  const label = p.tag ? `${cap(p.type)} "${p.tag}"` : `${cap(p.type)} · ${look}`;
  const sub = p.type === 'box' ? p.size.map(fmt).join(' × ') + ' m' : p.type === 'cylinder' ? `r ${fmt(p.radius)} · h ${fmt(p.height)} m` : `r ${fmt(p.radius)} m`;
  return { label, sub, icon: p.type === 'box' ? 'box' : p.type === 'cylinder' ? 'cylinder' : 'globe' };
}

export function actorIcon(a: ActorDoc): IconName {
  if (a.type === 'rf-emitter') return 'radio';
  if (a.type === 'ground-station') return 'signal';
  if (a.type === 'detector') return a.sensor === 'camera' ? 'camera' : a.sensor === 'radar' ? 'radar' : 'radio';
  return a.shape === 'person' ? 'personStanding' : a.shape === 'vehicle' ? 'car' : 'target';
}

/** One row per object (no group nesting). */
function objectNode(doc: MapDocV1, ref: Path): OutlineNode | null {
  const [list, i] = ref as [string, number], o = ((doc as unknown as Obj)[list] as Obj[] | undefined)?.[i];
  if (!o) return null;
  const base = { key: pk(ref), ref, refs: [ref] };
  switch (list) {
    case 'primitives': return { ...base, ...primLabel(o as PrimDoc) };
    case 'gates': return { ...base, label: `Gate ${i + 1}`, sub: o.kind, icon: 'focus' };
    case 'trees': return { ...base, label: `${cap(o.type ?? 'pine')} tree`, sub: `${fmt(o.height)} m`, icon: 'treePine' };
    case 'spawns': return { ...base, label: o.name ?? o.id, sub: o.id, icon: 'flag', rename: [...ref, 'name'] };
    case 'lights': return { ...base, label: `Light ${i + 1}`, sub: `${fmt(o.intensity)} · ${fmt(o.range)} m`, icon: 'lightbulb' };
    case 'indoor': return { ...base, label: `Indoor zone ${i + 1}`, sub: `wind × ${fmt(o.windScale ?? 0.1)}`, icon: 'home' };
    case 'wakeZones': return { ...base, label: `Wake zone ${i + 1}`, sub: `r ${fmt(o.radius)} m`, icon: 'wind' };
    case 'actors': return { ...base, label: o.name ?? o.id, sub: `${o.type}${o.path ? ` on ${o.path}` : ''}`, icon: actorIcon(o as ActorDoc), rename: [...ref, 'name'] };
    case 'geometry': return { ...base, label: o.type === 'gltf' ? String(o.src).split('/').pop()! : `${o.type} level`, sub: o.type === 'gltf' ? `collision ${o.collision ?? 'mesh'}` : o.src, icon: 'layers' };
  }
  return null;
}

/** The name a group is shown with: its own (Ctrl+G, renamed), its prefab's, or the spawn on a pad. */
export function groupName(doc: MapDocV1, meta: BuilderMeta, g: string): string {
  const own = meta.names?.[g];
  if (own) return own;
  const pf = meta.groups?.[g] ? prefabById(meta.groups[g].prefab) : undefined;
  if (pf) return pf.name;
  const spawn = doc.spawns?.find((s) => (s as Obj)['x-group'] === g);
  if (spawn) return `Spawn pad · ${spawn.name ?? spawn.id}`;
  return `Group ${g.replace(/^g/, '')}`;
}

const LISTS: { list: string; label: string; icon: IconName }[] = [
  { list: 'primitives', label: 'Primitives', icon: 'box' },
  { list: 'trees', label: 'Trees', icon: 'treePine' },
  { list: 'lights', label: 'Lights', icon: 'lightbulb' },
  { list: 'indoor', label: 'Indoor zones', icon: 'home' },
  { list: 'wakeZones', label: 'Wake zones', icon: 'wind' },
  { list: 'actors', label: 'Actors', icon: 'radar' },
  { list: 'geometry', label: 'Meshes and levels', icon: 'layers' },
];

/** The whole tree, filtered by a search (case-insensitive, on names and kinds; a matching folder keeps all it holds). */
export function outlineTree(doc: MapDocV1, meta: BuilderMeta, query = ''): OutlineNode[] {
  const D = doc as unknown as Obj, out: OutlineNode[] = [];
  const folder = (key: string, label: string, ic: IconName, children: OutlineNode[], extra: Partial<OutlineNode> = {}): OutlineNode =>
    ({ key, label, icon: ic, children, refs: children.flatMap((c) => c.refs), sub: String(children.length), ...extra });

  // courses: the main one and the named ones, gates in lap order
  const courses: OutlineNode[] = [];
  if (doc.gates?.length) courses.push(folder('course:main', 'Main course', 'route', doc.gates.map((_, i) => objectNode(doc, ['gates', i])!)));
  doc.courses?.forEach((c, ci) => courses.push(folder(`course:${ci}`, c.name, 'route', c.gates.map((g, i): OutlineNode => {
    const ref: Path = ['courses', ci, 'gates', i];
    return { key: pk(ref), ref, refs: [ref], label: `Gate ${i + 1}`, sub: g.kind, icon: 'focus' };
  }), { rename: ['courses', ci, 'name'] })));
  if (courses.length) out.push(folder('cat:courses', 'Courses', 'flag', courses, { sub: String(courses.length) }));

  // the start: main spawn, the pilot, named spawns that are not on a pad
  const start: OutlineNode[] = [];
  if (doc.spawn) start.push({ key: pk(['spawn']), ref: ['spawn'], refs: [['spawn']], label: 'Main spawn', sub: 'default start', icon: 'flag' });
  if (doc.pilot) start.push({ key: pk(['pilot']), ref: ['pilot'], refs: [['pilot']], label: 'Pilot position', icon: 'personStanding' });

  // groups: members of every list that carries x-group (course gates excepted: they stay in lap order)
  const groups = new Map<string, OutlineNode[]>(), grouped = new Set<string>();
  for (const l of ['primitives', 'gates', 'trees', 'spawns', 'lights', 'indoor', 'wakeZones', 'actors', 'geometry']) {
    (D[l] as Obj[] | undefined)?.forEach((o, i) => {
      const g = o?.['x-group'];
      if (typeof g !== 'string') return;
      const n = objectNode(doc, [l, i]);
      if (!n) return;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(n);
      if (l !== 'gates') grouped.add(pk([l, i]));
    });
  }
  doc.spawns?.forEach((_, i) => { if (!grouped.has(pk(['spawns', i]))) start.push(objectNode(doc, ['spawns', i])!); });
  if (start.length) out.push(folder('cat:start', 'Start', 'flag', start));
  if (groups.size) out.push(folder('cat:groups', 'Groups', 'folder', [...groups].map(([g, members]) => folder(`group:${g}`, groupName(doc, meta, g), 'folder', members, { rename: ['x-builder', 'names', g] }))));

  for (const L of LISTS) {
    const rows = ((D[L.list] as Obj[] | undefined) ?? []).flatMap((_, i) => (grouped.has(pk([L.list, i])) ? [] : [objectNode(doc, [L.list, i])!]));
    if (rows.length) out.push(folder(`cat:${L.list}`, L.label, L.icon, rows));
  }
  if (doc.paths?.length) out.push(folder('cat:paths', 'Paths', 'route', doc.paths.map((p, pi) => folder(`path:${pi}`, p.id, 'route',
    p.points.map((_, i): OutlineNode => { const ref: Path = ['paths', pi, 'points', i]; return { key: pk(ref), ref, refs: [ref], label: `Point ${i + 1}`, icon: 'target' }; }),
    { sub: `${p.points.length} points`, rename: ['paths', pi, 'id'] }))));

  const q = query.trim().toLowerCase();
  return q ? filterTree(out, q) : out;
}

function filterTree(nodes: OutlineNode[], q: string): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const n of nodes) {
    const hit = n.label.toLowerCase().includes(q) || (!n.children && !!n.sub?.toLowerCase().includes(q));
    if (hit) { out.push(n); continue; }
    if (!n.children) continue;
    const kids = filterTree(n.children, q);
    if (kids.length) out.push({ ...n, children: kids, refs: kids.flatMap((c) => c.refs) });
  }
  return out;
}

/** Keys of the folders that hold any of these objects (opened to reveal a selection). */
export function ancestorsOf(nodes: OutlineNode[], refs: Set<string>, path: string[] = [], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (!n.children) continue;
    if (n.refs.some((r) => refs.has(pk(r)))) { for (const p of path) out.add(p); out.add(n.key); }
    ancestorsOf(n.children, refs, [...path, n.key], out);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// DOM

/** Rows drawn per folder at most (a search finds the rest). */
const MAX_ROWS = 400;

/** The outliner's head: its title, the object count and the search box (drawn once: typing keeps its focus). */
export function outlinerHead(e: Editor): HTMLElement {
  const search = el('input', {
    type: 'search', class: 'ed-search', placeholder: 'Search the map', spellcheck: false, 'aria-label': 'Search the outliner',
    oninput: (ev: Event) => { e.outlinerQuery = (ev.target as HTMLInputElement).value; e.renderBox('outliner', true); },
    onkeydown: (ev: KeyboardEvent) => { if (ev.key === 'Escape' && e.outlinerQuery) { ev.stopPropagation(); (ev.target as HTMLInputElement).value = ''; e.outlinerQuery = ''; e.renderBox('outliner', true); } },
  });
  return el('div', { class: 'ed-panel-head-wrap' }, el('div', { class: 'ed-panel-head' }, icon('listTree'), el('h2', {}, 'Outliner'), el('span', { class: 'ed-head-sub' }, '')), search);
}

/** The outliner's rows (under its head). */
export function renderOutliner(e: Editor): HTMLElement {
  const tree = outlineTree(e.ed.doc, e.ed.meta, e.outlinerQuery), q = e.outlinerQuery.trim() !== '';
  const sel = new Set(e.sel.map(pk));
  const open = (k: string) => q || e.s.open!.has(k);
  const list = el('ul', { class: 'ed-tree', role: 'tree', 'aria-label': 'Objects in the map', 'aria-multiselectable': 'true' });
  const walk = (nodes: OutlineNode[], depth: number) => {
    let leaves = 0;
    for (const n of nodes) {
      // a folder with very many objects (trees): the first MAX_ROWS of them, then a note
      if (!n.children && ++leaves > MAX_ROWS) { if (leaves === MAX_ROWS + 1) list.append(el('li', { class: 'ed-tree-more', style: { paddingLeft: `${22 + depth * 14}px` } }, `${nodes.length - MAX_ROWS} more: search to find them`)); continue; }
      list.append(row(e, n, depth, sel, open(n.key)));
      if (n.children && open(n.key)) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  const total = allCount(tree), sub = e.docks.outliner.querySelector('.ed-head-sub');
  if (sub) sub.textContent = q ? `${total} found` : `${total} object${total === 1 ? '' : 's'}`;
  return tree.length ? list : el('p', { class: 'ed-empty' }, q ? 'Nothing matches.' : 'The map is empty: place something from the left panel.');
}

function allCount(nodes: OutlineNode[]): number { return new Set(nodes.flatMap((n) => n.refs.map(pk))).size; }

function row(e: Editor, n: OutlineNode, depth: number, sel: Set<string>, isOpen: boolean): HTMLElement {
  const refs = n.refs, keys = refs.map(pk);
  const selected = n.ref ? sel.has(pk(n.ref)) : refs.length > 0 && keys.every((k) => sel.has(k));
  const hidden = keys.length > 0 && keys.every((k) => e.hidden.has(k)), someHidden = !hidden && keys.some((k) => e.hidden.has(k));
  const locked = keys.length > 0 && keys.every((k) => e.locked.has(k));
  const toggle = n.children ? el('button', { type: 'button', class: 'ed-tw', 'aria-label': isOpen ? 'Collapse' : 'Expand', tabindex: -1, onclick: (ev: Event) => { ev.stopPropagation(); if (isOpen) e.s.open!.delete(n.key); else e.s.open!.add(n.key); e.renderBox('outliner', true); } }, icon(isOpen ? 'chevronDown' : 'chevron')) : el('span', { class: 'ed-tw' });
  const li = el('li', {
    role: 'treeitem', class: `ed-row-o${selected ? ' on' : ''}${hidden || someHidden ? ' hid' : ''}${locked ? ' locked' : ''}${n.children ? ' folder' : ''}`, 'aria-selected': String(selected), ...(n.children && { 'aria-expanded': String(isOpen) }),
    tabindex: selected ? 0 : -1, 'data-key': n.key, title: n.sub ? `${n.label} · ${n.sub}` : n.label,
    style: { paddingLeft: `${4 + depth * 14}px` },
    // (locked objects can't be picked in the view, but the outliner still selects them, as in Unity)
    onclick: (ev: MouseEvent) => {
      if (!refs.length) return;
      const mod = ev.shiftKey || ev.ctrlKey || ev.metaKey;
      e.select(refs, mod ? (n.ref ? 'toggle' : 'add') : 'set');
    },
    ondblclick: () => { if (refs.length) { e.select(refs); e.frameSelection(); } },
    oncontextmenu: (ev: MouseEvent) => { ev.preventDefault(); if (refs.length && !selected) e.select(refs); e.contextMenu(ev.clientX, ev.clientY, null); },
    onkeydown: (ev: KeyboardEvent) => outlinerKey(e, ev, n),
  },
  toggle, icon(n.icon, 'ed-oi'),
  el('span', { class: 'ed-o-label' }, n.label), n.sub ? el('span', { class: 'ed-o-sub' }, n.sub) : null,
  refs.length ? el('button', { type: 'button', class: `ed-o-btn${hidden || someHidden ? ' active' : ''}`, tabindex: -1, title: hidden ? 'Show (H toggles)' : 'Hide (H)', 'aria-label': `${hidden ? 'Show' : 'Hide'} ${n.label}`, onclick: (ev: Event) => { ev.stopPropagation(); e.setHidden(refs, !hidden); } }, icon(hidden || someHidden ? 'eyeOff' : 'eye')) : null,
  refs.length ? el('button', { type: 'button', class: `ed-o-btn${locked ? ' active' : ''}`, tabindex: -1, title: locked ? 'Unlock: it can be picked in the view again' : 'Lock: it can not be picked in the view', 'aria-label': `${locked ? 'Unlock' : 'Lock'} ${n.label}`, onclick: (ev: Event) => { ev.stopPropagation(); e.setLocked(refs, !locked); } }, icon(locked ? 'lock' : 'unlock')) : null);
  return li;
}

/** Arrow keys walk the rows, Left / Right fold, Enter frames, F2 renames, Delete deletes. */
function outlinerKey(e: Editor, ev: KeyboardEvent, n: OutlineNode) {
  const li = ev.currentTarget as HTMLElement, all = [...li.parentElement!.querySelectorAll<HTMLElement>('li[role="treeitem"]')], i = all.indexOf(li);
  const go = (j: number) => { const t = all[Math.max(0, Math.min(all.length - 1, j))]; if (t) { t.focus(); t.click(); } };
  switch (ev.key) {
    case 'ArrowDown': ev.preventDefault(); go(i + 1); break;
    case 'ArrowUp': ev.preventDefault(); go(i - 1); break;
    case 'ArrowRight': if (n.children && !e.s.open!.has(n.key)) { ev.preventDefault(); e.s.open!.add(n.key); e.renderBox('outliner', true); e.focusOutliner(n.key); } break;
    case 'ArrowLeft': if (n.children && e.s.open!.has(n.key)) { ev.preventDefault(); e.s.open!.delete(n.key); e.renderBox('outliner', true); e.focusOutliner(n.key); } break;
    case 'Enter': ev.preventDefault(); e.frameSelection(); break;
    case 'F2': if (n.rename) { ev.preventDefault(); e.rename(n); } break;
    default: return;
  }
  ev.stopPropagation();
}
