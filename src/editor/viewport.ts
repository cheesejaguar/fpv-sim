// The viewport's own UI, modelled on Unity's Scene view and Unreal's level viewport: the toolbar over
// the view (transform tools, world / local, snapping, camera, view and show menus), the axis gizmo
// (click an axis for that side's view, the centre for perspective / orthographic), box selection,
// the right-click menu, the status bar with the mouse and key hints, and the shortcut sheet (?).
import * as THREE from 'three';
import type { Vec3 } from '../maps/mapDoc';
import { el } from '../ui/dom';
import { icon, type IconName } from './icons';
import type { View } from './camera';
import type { Editor, Mode } from './editor';
import type { Path } from './editorDoc';
import { SPEEDS } from './prefs';

// ---------------------------------------------------------------------------------------------
// Box selection

/** Screen rectangle (CSS px, any corner order). */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/**
 * The objects whose anchor (ENU) projects inside the rectangle and lies in front of the camera.
 * view: the canvas's rectangle on the page (the projection maps onto it).
 */
export function inRect(cands: { ref: Path; p: Vec3 }[], cam: THREE.Camera, r: Rect, view: { left: number; top: number; width: number; height: number }): Path[] {
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  const v = new THREE.Vector3(), out: Path[] = [];
  cam.updateMatrixWorld();
  for (const c of cands) {
    v.set(c.p[0], c.p[2], -c.p[1]).project(cam);
    if (v.z < -1 || v.z > 1) continue;
    const sx = view.left + ((v.x + 1) / 2) * view.width, sy = view.top + ((1 - v.y) / 2) * view.height;
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) out.push(c.ref);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Menus (dropdowns from the toolbars, the right-click menu)

export type MenuItem = { label: string; keys?: string; icon?: IconName; run: () => void; disabled?: boolean; on?: boolean } | { sep: true } | { head: string };

let openMenu: { root: HTMLElement; close: () => void } | null = null;

/** Close the open menu, if any. */
export function closeMenu() { openMenu?.close(); }

/** A menu at a screen point (kept inside the window); arrow keys move, Enter runs, Esc closes. */
export function showMenu(host: HTMLElement, x: number, y: number, items: MenuItem[], label = 'Menu') {
  closeMenu();
  const prev = document.activeElement as HTMLElement | null;
  const list = el('div', { class: 'ed-menu', role: 'menu', 'aria-label': label });
  for (const it of items) {
    if ('sep' in it) { list.append(el('div', { class: 'ed-menu-sep', role: 'separator' })); continue; }
    if ('head' in it) { list.append(el('div', { class: 'ed-menu-head' }, it.head)); continue; }
    list.append(el('button', {
      type: 'button', role: it.on === undefined ? 'menuitem' : 'menuitemcheckbox', class: 'ed-menu-item', disabled: it.disabled, ...(it.on !== undefined && { 'aria-checked': String(it.on) }),
      onclick: () => { close(); it.run(); },
    }, el('span', { class: 'ed-menu-ico' }, it.on ? icon('check') : it.icon ? icon(it.icon) : null), el('span', { class: 'ed-menu-label' }, it.label), it.keys ? el('kbd', {}, it.keys) : null));
  }
  host.append(list);
  const W = innerWidth, H = innerHeight, r = list.getBoundingClientRect();
  list.style.left = `${Math.max(4, Math.min(x, W - r.width - 4))}px`;
  list.style.top = `${Math.max(4, Math.min(y, H - r.height - 4))}px`;
  const buttons = () => [...list.querySelectorAll<HTMLButtonElement>('.ed-menu-item:not(:disabled)')];
  buttons()[0]?.focus();
  const onDown = (e: PointerEvent) => { if (!list.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => {
    const b = buttons(), i = b.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); prev?.focus?.(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); b[(i + 1) % b.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); b[(i - 1 + b.length) % b.length]?.focus(); }
    else return;
    e.stopPropagation();
  };
  const close = () => { if (openMenu?.root !== list) return; openMenu = null; list.remove(); removeEventListener('pointerdown', onDown, true); removeEventListener('keydown', onKey, true); removeEventListener('blur', close); };
  addEventListener('pointerdown', onDown, true); addEventListener('keydown', onKey, true); addEventListener('blur', close);
  openMenu = { root: list, close };
}

/** A toolbar button that opens a menu under itself. */
function menuButton(e: Editor, label: string, ic: IconName, items: () => MenuItem[], o: { text?: string; title?: string } = {}) {
  const b = el('button', { type: 'button', class: 'ed-vb', title: o.title ?? label, 'aria-label': label, 'aria-haspopup': 'menu' }, icon(ic), o.text ? el('span', {}, o.text) : null, icon('chevronDown', 'ed-caret'));
  b.addEventListener('click', () => { const r = b.getBoundingClientRect(); showMenu(e.root, r.left, r.bottom + 4, items(), label); });
  return b;
}

// ---------------------------------------------------------------------------------------------
// The viewport toolbar

const MODES: { id: Mode; label: string; key: string; icon: IconName }[] = [
  { id: 'select', label: 'Select', key: 'Q', icon: 'pointer' },
  { id: 'move', label: 'Move', key: 'W', icon: 'move' },
  { id: 'rotate', label: 'Rotate', key: 'E', icon: 'rotate3d' },
  { id: 'scale', label: 'Scale', key: 'R', icon: 'scale3d' },
];
const VIEWS: { v: View; label: string; key?: string }[] = [
  { v: 'top', label: 'Top', key: 'Num 7' }, { v: 'north', label: 'Looking north', key: 'Num 1' }, { v: 'east', label: 'Looking east', key: 'Num 3' },
  { v: 'south', label: 'Looking south' }, { v: 'west', label: 'Looking west' },
];

export function renderViewbar(e: Editor): HTMLElement {
  const P = e.prefs, tool = e.tool.t;
  const seg = el('div', { class: 'ed-vgroup', role: 'radiogroup', 'aria-label': 'Transform tool' }, ...MODES.map((m) => el('button', {
    type: 'button', class: 'ed-vb', role: 'radio', 'aria-checked': String(tool === 'select' && e.mode === m.id), title: `${m.label} (${m.key})`, 'aria-label': m.label,
    onclick: () => { if (tool !== 'select') e.setTool({ t: 'select' }); e.setMode(m.id); },
  }, icon(m.icon))));
  const space = el('button', { type: 'button', class: 'ed-vb', title: 'Gizmo axes: the world\'s, or the object\'s own (X toggles)', 'aria-label': `Axes: ${P.space}`, onclick: () => e.setSpace(P.space === 'world' ? 'local' : 'world') },
    icon(P.space === 'world' ? 'globe' : 'box'), el('span', {}, P.space === 'world' ? 'World' : 'Local'));
  const snapBtn = el('button', { type: 'button', class: 'ed-vb', 'aria-pressed': String(P.snapOn), title: 'Snapping on / off (G)', 'aria-label': 'Snapping', onclick: () => e.toggleSnap() }, icon('magnet'));
  const pick = (label: string, ic: IconName, cur: number, vals: number[], unit: string, set: (v: number) => void) =>
    menuButton(e, label, ic, () => vals.map((v) => ({ label: `${v} ${unit}`, on: v === cur, run: () => set(v) })), { text: `${cur}${unit === '°' ? '°' : ` ${unit}`}`, title: `${label} (snapping ${P.snapOn ? 'on' : 'off'})` });
  const snap = el('div', { class: `ed-vgroup${P.snapOn ? '' : ' off'}` }, snapBtn,
    pick('Grid step', 'grid', P.grid, [0.1, 0.25, 0.5, 1, 2, 5, 10], 'm', (v) => { P.grid = v; P.snapOn = true; e.prefsChanged(); }),
    pick('Angle step', 'rotate', P.angle, [1, 5, 10, 15, 30, 45, 90], '°', (v) => { P.angle = v; P.snapOn = true; e.prefsChanged(); }));
  const cam = menuButton(e, 'Camera', 'camera', () => [
    { head: 'Right-drag in the view' },
    { label: 'Look around, WASD flies (Unity / Unreal)', on: P.rightDrag === 'fly', run: () => { P.rightDrag = 'fly'; e.prefsChanged(); } },
    { label: 'Orbit round the view centre', on: P.rightDrag === 'orbit', run: () => { P.rightDrag = 'orbit'; e.prefsChanged(); } },
    { head: 'Fly speed (the wheel while the right button is held)' },
    ...SPEEDS.map((s) => ({ label: `× ${s}`, on: s === P.speed, run: () => { P.speed = s; e.prefsChanged(); } })),
    { sep: true },
    { label: 'Frame selection', keys: 'F', icon: 'focus', run: () => e.frameSelection() },
    { label: 'Frame the whole map', keys: 'Home', icon: 'expand', run: () => e.frameAll() },
  ], { text: `× ${P.speed}`, title: 'Camera: right-drag, fly speed' });
  const view = menuButton(e, 'View', 'compass', () => [
    { label: 'Perspective', on: !e.cam.orthographic, run: () => e.setOrtho(false), keys: 'Num 5' },
    { label: 'Orthographic', on: e.cam.orthographic, run: () => e.setOrtho(true) },
    { sep: true },
    ...VIEWS.map((v) => ({ label: v.label, keys: v.key, run: () => e.cam.view(v.v) })),
    { label: 'Top, orthographic (plan view)', run: () => e.cam.view('top', true) },
  ], { text: e.cam.orthographic ? 'Orthographic' : 'Perspective', title: 'Projection and axis views' });
  const S = P.show, flag = (k: keyof typeof S, label: string) => ({ label, on: S[k], run: () => { S[k] = !S[k]; e.prefsChanged(true); } });
  const show = menuButton(e, 'Show', 'eye', () => [
    flag('grid', 'Grid'), flag('labels', 'Labels'), flag('gizmos', 'Gizmos (spawns, lights, zones, actors, paths)'), flag('racingLine', 'Racing line'), flag('collision', 'Collision shapes'),
    { sep: true },
    { label: 'Show everything hidden', keys: 'Alt+H', icon: 'eye', run: () => e.showAll(), disabled: !e.hidden.size },
    { label: 'Unlock everything', icon: 'unlock', run: () => e.setLocked(e.allLocked(), false), disabled: !e.locked.size },
  ], { title: 'What the viewport shows' });
  return el('div', { class: 'ed-viewbar' }, seg, space, snap, el('span', { class: 'ed-spacer' }), cam, view, show);
}

// ---------------------------------------------------------------------------------------------
// The axis gizmo

const AXES: { d: [number, number, number]; color: string; label: string; view: View; neg: boolean }[] = [
  // ENU in three: east +x, north -z, up +y. Clicking an axis looks along it from its far side.
  { d: [1, 0, 0], color: '#ef4444', label: 'X', view: 'west', neg: false }, { d: [-1, 0, 0], color: '#ef4444', label: '', view: 'east', neg: true },
  { d: [0, 0, -1], color: '#4ade80', label: 'Y', view: 'south', neg: false }, { d: [0, 0, 1], color: '#4ade80', label: '', view: 'north', neg: true },
  { d: [0, 1, 0], color: '#60a5fa', label: 'Z', view: 'top', neg: false }, { d: [0, -1, 0], color: '#60a5fa', label: '', view: 'bottom', neg: true },
];

/** The orientation gizmo in the viewport's top-right corner: drawn from the camera's rotation every frame. */
export class AxisGizmo {
  readonly canvas = el('canvas', { class: 'ed-axes', role: 'img', 'aria-label': 'View orientation: click an axis to look along it, the centre to switch perspective / orthographic', title: 'Click an axis for that view · centre: perspective / orthographic' }) as HTMLCanvasElement;
  private size = 88;
  private hits: { x: number; y: number; r: number; view: View | null }[] = [];
  private hover = -1;
  private key = '';

  constructor(private e: Editor) {
    this.canvas.addEventListener('pointermove', (ev) => { this.hover = this.hit(ev); this.canvas.style.cursor = this.hover >= 0 ? 'pointer' : ''; this.key = ''; });
    this.canvas.addEventListener('pointerleave', () => { this.hover = -1; this.key = ''; });
    this.canvas.addEventListener('click', (ev) => {
      const i = this.hit(ev);
      if (i < 0) return;
      const v = this.hits[i].view;
      if (v) this.e.cam.view(v); else this.e.setOrtho(!this.e.cam.orthographic);
    });
  }

  private hit(ev: MouseEvent): number {
    const r = this.canvas.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    // the front-most circle under the pointer (hits are stored back to front)
    for (let i = this.hits.length - 1; i >= 0; i--) { const h = this.hits[i]; if (Math.hypot(x - h.x, y - h.y) <= h.r + 2) return i; }
    return -1;
  }

  draw(q: THREE.Quaternion, ortho: boolean) {
    const key = `${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)},${ortho},${this.hover}`;
    if (key === this.key) return;
    this.key = key;
    const dpr = Math.min(2, devicePixelRatio || 1), S = this.size, c = this.canvas;
    if (c.width !== S * dpr) { c.width = c.height = S * dpr; c.style.width = c.style.height = `${S}px`; }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, S, S);
    const inv = q.clone().invert(), v = new THREE.Vector3(), C = S / 2, L = S * 0.33;
    const pts = AXES.map((a, i) => { v.set(...a.d).applyQuaternion(inv); return { a, i, x: C + v.x * L, y: C - v.y * L, z: v.z }; }).sort((p, q2) => p.z - q2.z);
    this.hits = [];
    // centre: projection toggle
    g.beginPath(); g.arc(C, C, 7, 0, Math.PI * 2);
    g.fillStyle = this.hover === 0 ? 'rgba(255,255,255,0.35)' : ortho ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)'; g.fill();
    this.hits.push({ x: C, y: C, r: 7, view: null });
    for (const p of pts) {
      const r = p.a.neg ? 6 : 9, hi = this.hover === this.hits.length;
      if (!p.a.neg) { g.strokeStyle = p.a.color; g.lineWidth = 2; g.beginPath(); g.moveTo(C, C); g.lineTo(p.x, p.y); g.stroke(); }
      g.beginPath(); g.arc(p.x, p.y, r + (hi ? 1.5 : 0), 0, Math.PI * 2);
      g.fillStyle = p.a.neg ? `${p.a.color}66` : p.a.color; g.fill();
      if (hi) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
      if (p.a.label) { g.fillStyle = '#0b0b10'; g.font = '700 10px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(p.a.label, p.x, p.y + 0.5); }
      this.hits.push({ x: p.x, y: p.y, r, view: p.a.view });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Status bar

const kbd = (k: string) => el('kbd', {}, k);
const hint = (keys: string, what: string) => el('span', { class: 'ed-hint' }, kbd(keys), what);

/** Mouse and key hints for what the pointer does now (Blender-style), the cursor position, selection and problems. */
export function renderStatus(e: Editor): HTMLElement {
  const t = e.tool.t, hints: HTMLElement[] = [];
  if (e.cam.flying) hints.push(hint('W A S D', 'Fly'), hint('Q E', 'Down / up'), hint('Shift', 'Faster'), hint('Wheel', `Speed × ${e.prefs.speed}`));
  else if (t === 'select') hints.push(hint('LMB', 'Select · drag: box'), hint('RMB', e.prefs.rightDrag === 'fly' ? 'Look · hold + WASD: fly' : 'Orbit'), hint('MMB', 'Pan'), hint('Alt+LMB', 'Orbit'), hint('F', 'Frame'));
  else if (t === 'place') hints.push(hint('LMB', 'Place'), hint('Esc', 'Stop placing'), hint('RMB', 'Look'));
  else if (t === 'path') hints.push(hint('LMB', 'Add point'), hint('Enter', 'Finish'), hint('Esc', 'Finish'));
  else hints.push(hint('LMB', 'Paint'), hint('RMB', 'Look'), hint('Esc', 'Stop'));
  const errs = e.problems.filter((p) => p.level === 'error').length, warns = e.problems.length - errs;
  return el('div', { class: 'ed-status-in' },
    el('div', { class: 'ed-hints' }, ...hints),
    el('span', { class: 'ed-spacer' }),
    el('span', { class: 'ed-st ed-st-cursor', title: 'The ground under the cursor (east, north, height)' }, ''),
    el('span', { class: 'ed-st' }, e.sel.length ? `${e.sel.length} selected` : 'Nothing selected'),
    e.hidden.size ? el('button', { type: 'button', class: 'ed-st ed-st-btn', title: 'Show everything hidden (Alt+H)', onclick: () => e.showAll() }, icon('eyeOff'), `${e.hidden.size} hidden`) : null,
    el('button', { type: 'button', class: `ed-st ed-st-btn${errs ? ' err' : warns ? ' warn' : ''}`, title: 'Problems (the bottom panel)', onclick: () => e.openBottom('problems') },
      icon(errs ? 'alert' : 'check'), errs ? `${errs} error${errs === 1 ? '' : 's'}` : 'No errors', warns ? el('span', { class: 'ed-st-sub' }, ` · ${warns} note${warns === 1 ? '' : 's'}`) : null),
    el('span', { class: 'ed-st ed-st-fps', title: 'Frames per second' }, ''),
    el('span', { class: 'ed-st', title: 'Drafts save in this browser as you work' }, e.saved));
}

/** The parts of the status bar that change every frame (no re-render). */
export function updateStatusLive(root: HTMLElement, cursor: Vec3 | null, fps: number) {
  const c = root.querySelector('.ed-st-cursor'), f = root.querySelector('.ed-st-fps');
  if (c) c.textContent = cursor ? `E ${cursor[0].toFixed(1)}  N ${cursor[1].toFixed(1)}  ↑ ${cursor[2].toFixed(1)} m` : '';
  if (f) f.textContent = fps ? `${Math.round(fps)} fps` : '';
}

// ---------------------------------------------------------------------------------------------
// Shortcut sheet

export const KEYMAP: { title: string; keys: [string, string][] }[] = [
  { title: 'Tools', keys: [['Q', 'Select'], ['W', 'Move'], ['E', 'Rotate'], ['R', 'Scale'], ['X', 'World / local axes'], ['G', 'Snapping on / off'], ['Esc', 'Stop placing · deselect']] },
  { title: 'Camera', keys: [['RMB drag', 'Look around (or orbit: Camera menu)'], ['RMB + W A S D', 'Fly · Q / E down / up · Shift faster'], ['RMB + wheel', 'Fly speed'], ['Alt + LMB drag', 'Orbit'], ['MMB drag', 'Pan'], ['Wheel', 'Zoom toward the cursor'], ['F', 'Frame selection'], ['Home', 'Frame the whole map'], ['Num 7 / 1 / 3', 'Top / north / east view'], ['Num 5', 'Perspective / orthographic']] },
  { title: 'Selection', keys: [['Click', 'Select (Shift / Ctrl: add or remove)'], ['Drag', 'Box select (Shift adds, Ctrl removes)'], ['Ctrl+A', 'Select all'], ['Double-click', 'Frame it'], ['Alt + click', 'One part of a group']] },
  { title: 'Edit', keys: [['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+C / X / V', 'Copy / cut / paste (at the cursor)'], ['Ctrl+D', 'Duplicate'], ['Delete', 'Delete'], ['Arrows', 'Nudge the selection a grid step (Shift: ×10); nothing selected: move the view'], ['Page Up / Down', 'Nudge (or move the view) up / down'], ['[  ]', 'Turn by the angle step'], ['End', 'Drop to the ground'], ['Ctrl+G', 'Group'], ['Ctrl+Shift+G', 'Ungroup'], ['F2', 'Rename']] },
  { title: 'Visibility', keys: [['H', 'Hide selection'], ['Shift+H', 'Isolate selection'], ['Alt+H', 'Show everything']] },
  { title: 'Map', keys: [['Alt+P', 'Fly the map'], ['Ctrl+S', 'Save now'], ['?', 'This sheet']] },
];

export function showHelp(host: HTMLElement) {
  const prev = document.activeElement as HTMLElement | null;
  const close = () => { root.remove(); removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' || ev.key === '?') { ev.preventDefault(); ev.stopPropagation(); close(); } };
  const closeBtn = el('button', { type: 'button', class: 'ed-vb', 'aria-label': 'Close', onclick: close }, icon('x'));
  const root = el('div', { class: 'ed-help', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard and mouse', onclick: (ev: Event) => { if (ev.target === root) close(); } },
    el('div', { class: 'ed-help-card' },
      el('div', { class: 'ed-help-head' }, icon('keyboard'), el('h2', {}, 'Keyboard and mouse'), el('span', { class: 'ed-spacer' }), closeBtn),
      el('div', { class: 'ed-help-grid' }, ...KEYMAP.map((g) => el('section', {}, el('h3', {}, g.title), el('dl', {}, ...g.keys.flatMap(([k, v]) => [el('dt', {}, ...k.split(' / ').flatMap((x, i) => (i ? [' / ', kbd(x)] : [kbd(x)]))), el('dd', {}, v)])))))));
  host.append(root);
  addEventListener('keydown', onKey, true);
  closeBtn.focus();
}
