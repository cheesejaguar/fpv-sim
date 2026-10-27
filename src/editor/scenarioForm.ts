// Scenario authoring: a form over fpvsim-scenario v1 (docs/SCENARIO_FORMAT.md) for a file bundled
// with the map (scenarios/<id>.json, listed in map.json "scenarios"). It also writes the fields the
// actor runtime adds (start.spawn, the reach-target / track-target / detect-avoid tasks,
// randomize.spawn / randomize.actors, observations.actors). Run here starts it in the live sim
// through the same path as Settings → Research → Scenario; Export saves the file on its own.
import { PRESETS } from '../builder/derive';
import { el } from '../ui/dom';
import type { Editor } from './editor';
import { download } from './package';
import type { Op } from './editorDoc';
import { freeId } from './transform';

type Obj = Record<string, any>;
const parsed = new WeakMap<Blob, Obj | Error>();

const getIn = (o: Obj, p: string[]): unknown => p.reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Obj)[k] : undefined), o);
/** Set (undefined: delete) a nested key, dropping objects left empty. */
function setIn(o: Obj, p: string[], v: unknown) {
  const stack: Obj[] = [o];
  let cur = o;
  for (const k of p.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {}; cur = cur[k]; stack.push(cur); }
  const last = p[p.length - 1];
  if (v === undefined) delete cur[last]; else cur[last] = v;
  for (let i = stack.length - 1; i > 0; i--) if (!Object.keys(stack[i]).length) delete stack[i - 1][p[i - 1]];
}

function write(e: Editor, path: string, sc: Obj, label = 'Edit scenario') {
  const b = new Blob([JSON.stringify(sc, null, 2) + '\n'], { type: 'application/json' });
  parsed.set(b, sc);
  e.ed.apply(label, [{ k: 'asset', path, v: b }]);
}

/** A new scenario file for this map, opened in the form. */
export function newScenario(e: Editor) {
  const doc = e.ed.doc, list = doc.scenarios ?? [];
  if (list.length >= 16) { e.toast('At most 16 scenarios per map'); return; }
  const id = freeId(list.map((p) => p.replace(/^scenarios\//, '').replace(/\.json$/, '')), 'scenario'), path = `scenarios/${id}.json`;
  const sc: Obj = {
    format: 'fpvsim-scenario', version: 1,
    meta: { id, name: `${doc.meta.name}: ${id}`.slice(0, 64), author: doc.meta.author, license: 'CC0-1.0' },
    seed: 1, map: { id: doc.meta.id }, drone: { preset: PRESETS[0].name },
    start: { mode: 'angle' }, task: { type: (doc.gates?.length ?? 0) > 0 ? 'gates' : 'free' }, episode: { maxSeconds: 60 },
  };
  const b = new Blob([JSON.stringify(sc, null, 2) + '\n'], { type: 'application/json' });
  parsed.set(b, sc);
  e.ed.apply('New scenario', [{ k: 'asset', path, v: b }, { k: 'set', path: ['scenarios'], v: [...list, path] }]);
  e.pal.scenario = path;
  e.select([]);
}

const TASKS = ['free', 'hover', 'gates', 'waypoints', 'reach-target', 'track-target', 'detect-avoid'] as const;
const TASK_DEFAULTS: Record<string, Obj> = {
  free: { type: 'free' }, hover: { type: 'hover', heightM: 3, radiusM: 1.5, holdS: 10 }, gates: { type: 'gates', laps: 1 }, waypoints: { type: 'waypoints', points: [], radiusM: 1 },
  'reach-target': { type: 'reach-target', radiusM: 3 }, 'track-target': { type: 'track-target', rangeM: 30, fovDeg: 60, holdS: 10 }, 'detect-avoid': { type: 'detect-avoid', radiusM: 3, maxDetectedS: 0 },
};

export function renderScenarioForm(e: Editor, path: string): HTMLElement {
  const blob = e.ed.assets.get(path), doc = e.ed.doc;
  const close = el('button', { type: 'button', class: 'ed-btn ed-small', onclick: () => { e.pal.scenario = null; e.renderBox('inspector', true); e.renderBox('palette'); } }, 'Close');
  const head = (t: string) => el('div', { class: 'ed-insp-head' }, el('h2', {}, t), el('div', { class: 'ed-row' }, close));
  const removeOps = (): Op[] => [{ k: 'set', path: ['scenarios'], v: (doc.scenarios ?? []).filter((p) => p !== path) }, { k: 'asset', path, v: null }];
  if (!blob) return el('div', {}, head('Scenario'), el('p', { class: 'ed-note' }, `${path} is listed but not in the package.`), el('button', { type: 'button', class: 'ed-btn ed-small', onclick: () => e.ed.apply('Remove scenario', removeOps()) }, 'Remove it from the list'));
  const got = parsed.get(blob);
  if (!got) {
    void blob.text().then((t) => { try { parsed.set(blob, JSON.parse(t)); } catch (x) { parsed.set(blob, x as Error); } e.renderBox('inspector', true); });
    return el('div', {}, head('Scenario'), el('p', { class: 'ed-note' }, 'Loading…'));
  }
  if (got instanceof Error) return el('div', {}, head('Scenario'), el('p', { class: 'ed-note' }, `${path} is not valid JSON: ${got.message}`));
  const sc = got;
  const commit = (p: string[], v: unknown, label?: string) => { const n = structuredClone(sc); setIn(n, p, v); write(e, path, n, label); };

  // ---- field helpers over the scenario object ----
  const lbl = (t: string, input: HTMLElement, unit?: string) => el('label', { class: 'ed-field' }, el('span', { class: 'lbl' }, t), input, unit ? el('span', { class: 'unit' }, unit) : null);
  const num = (t: string, p: string[], o: { min?: number; max?: number; step?: number; unit?: string; placeholder?: string } = {}) => {
    const v = getIn(sc, p), i = el('input', { type: 'number', step: o.step ?? 'any', min: o.min, max: o.max, value: typeof v === 'number' ? String(v) : '', placeholder: o.placeholder ?? 'default' }) as HTMLInputElement;
    i.addEventListener('change', () => commit(p, i.value.trim() === '' ? undefined : Number(i.value)));
    return lbl(t, i, o.unit);
  };
  const txt = (t: string, p: string[], placeholder = '') => {
    const v = getIn(sc, p), i = el('input', { type: 'text', value: typeof v === 'string' ? v : '', placeholder, spellcheck: false }) as HTMLInputElement;
    i.addEventListener('change', () => commit(p, i.value.trim() || undefined));
    return lbl(t, i);
  };
  const pick = (t: string, p: string[], opts: { value: string; label: string }[], def: string) => {
    const v = getIn(sc, p) as string | undefined;
    const s = el('select', { onchange: () => commit(p, s.value || undefined) }, el('option', { value: '' }, def), ...opts.map((o) => el('option', { value: o.value, selected: v === o.value }, o.label))) as HTMLSelectElement;
    return lbl(t, s);
  };
  const check = (t: string, p: string[], def = false) => {
    const v = getIn(sc, p) as boolean | undefined, i = el('input', { type: 'checkbox', checked: v ?? def }) as HTMLInputElement;
    i.addEventListener('change', () => commit(p, i.checked === def ? undefined : i.checked));
    return el('label', { class: 'ed-check' }, i, el('span', {}, t));
  };
  /** A uniform range [a, b] (or a spread ±j around 0). */
  const range = (t: string, p: string[], o: { unit?: string; sym?: boolean; step?: number } = {}) => {
    const d = getIn(sc, p) as { uniform?: [number, number] } | number | undefined, u = typeof d === 'object' && d?.uniform ? d.uniform : typeof d === 'number' ? [d, d] : null;
    if (o.sym) {
      const i = el('input', { type: 'number', min: 0, step: o.step ?? 'any', value: u ? String(Math.abs(u[1])) : '', placeholder: 'off' }) as HTMLInputElement;
      i.addEventListener('change', () => { const j = Number(i.value); commit(p, i.value.trim() === '' || !j ? undefined : { uniform: [-j, j] }); });
      return lbl(`${t} ±`, i, o.unit);
    }
    const a = el('input', { type: 'number', step: o.step ?? 'any', value: u ? String(u[0]) : '', placeholder: 'from', 'aria-label': `${t} from` }) as HTMLInputElement;
    const b = el('input', { type: 'number', step: o.step ?? 'any', value: u ? String(u[1]) : '', placeholder: 'to', 'aria-label': `${t} to` }) as HTMLInputElement;
    const set = () => { if (a.value.trim() === '' && b.value.trim() === '') { commit(p, undefined); return; } const x = Number(a.value || b.value), y = Number(b.value || a.value); commit(p, { uniform: [Math.min(x, y), Math.max(x, y)] }); };
    a.addEventListener('change', set); b.addEventListener('change', set);
    return el('div', { class: 'ed-field' }, el('span', { class: 'lbl' }, t), el('span', { class: 'ed-vec' }, a, b), o.unit ? el('span', { class: 'unit' }, o.unit) : null);
  };
  const sec = (t: string, ...kids: (Node | null)[]) => el('section', { class: 'ed-sec' }, el('h3', {}, t), ...kids);

  const spawns = (doc.spawns ?? []).map((s) => ({ value: s.id, label: s.name ?? s.id }));
  const targets = (doc.actors ?? []).filter((a) => a.type === 'target').map((a) => ({ value: a.id, label: a.name ?? a.id }));
  const paths = doc.paths ?? [];
  const task = (sc.task ?? { type: 'free' }) as Obj, tt = task.type as string;
  const pointsFromPath = (k: string[]) => el('label', { class: 'ed-field' }, el('span', { class: 'lbl' }, 'Points'),
    el('select', { onchange: (ev: Event) => { const id = (ev.target as HTMLSelectElement).value; const p = paths.find((x) => x.id === id); commit(k, p ? structuredClone(p.points) : undefined); } },
      el('option', { value: '' }, Array.isArray(getIn(sc, k)) && (getIn(sc, k) as unknown[]).length ? `${(getIn(sc, k) as unknown[]).length} points` : 'none'), ...paths.map((p) => el('option', { value: p.id }, `copy from path ${p.id}`))));
  const taskFields: (HTMLElement | null)[] = [];
  if (tt === 'hover') taskFields.push(num('Height', ['task', 'heightM'], { min: 0, step: 0.5, unit: 'm above the pad' }), num('Radius', ['task', 'radiusM'], { min: 0.1, step: 0.1, unit: 'm' }), num('Hold', ['task', 'holdS'], { min: 0, step: 1, unit: 's' }));
  if (tt === 'gates') taskFields.push(num('Laps', ['task', 'laps'], { min: 1, step: 1 }));
  if (tt === 'waypoints') taskFields.push(pointsFromPath(['task', 'points']), num('Radius', ['task', 'radiusM'], { min: 0.1, step: 0.1, unit: 'm' }));
  if (tt === 'reach-target') taskFields.push(pick('Target', ['task', 'target'], targets, 'pick a target actor'), num('Radius', ['task', 'radiusM'], { min: 0.1, step: 0.5, unit: 'm' }), num('Hold', ['task', 'holdS'], { min: 0, step: 1, unit: 's' }));
  if (tt === 'track-target') taskFields.push(pick('Target', ['task', 'target'], targets, 'pick a target actor'), num('Range', ['task', 'rangeM'], { min: 1, step: 1, unit: 'm' }), num('Camera FOV', ['task', 'fovDeg'], { min: 1, max: 180, step: 1, unit: '°' }), num('Hold', ['task', 'holdS'], { min: 0, step: 1, unit: 's' }));
  if (tt === 'detect-avoid') taskFields.push(pointsFromPath(['task', 'points']), pick('Or reach target', ['task', 'target'], targets, 'none'), num('Radius', ['task', 'radiusM'], { min: 0.1, step: 0.5, unit: 'm' }), num('Max time detected', ['task', 'maxDetectedS'], { min: 0, step: 0.5, unit: 's' }));
  if (tt.endsWith('target') && !targets.length) taskFields.push(el('p', { class: 'ed-note' }, 'Add a target actor first (Simulation → Actors).'));

  const rs = getIn(sc, ['randomize', 'spawn']) as string | string[] | undefined;
  const spawnRand = el('div', {},
    lbl('Random spawn', el('select', { onchange: (ev: Event) => { const v = (ev.target as HTMLSelectElement).value; commit(['randomize', 'spawn'], v === '' ? undefined : v === 'any' ? 'any' : spawns.map((s) => s.value)); } },
      el('option', { value: '' }, 'off'), el('option', { value: 'any', selected: rs === 'any' }, 'any spawn'), el('option', { value: 'list', selected: Array.isArray(rs) }, 'one of these…'))),
    Array.isArray(rs) ? el('div', { class: 'ed-sub' }, ...spawns.map((s) => el('label', { class: 'ed-check' }, el('input', { type: 'checkbox', checked: rs.includes(s.value), onchange: (ev: Event) => { const on = (ev.target as HTMLInputElement).checked; const l = on ? [...rs, s.value] : rs.filter((x) => x !== s.value); commit(['randomize', 'spawn'], l.length ? l : undefined); } }), el('span', {}, s.label)))) : null);

  const json = el('pre', { class: 'ed-json' }, JSON.stringify(sc, null, 2));
  const id = (sc.meta?.id as string) ?? path;
  return el('div', {},
    head('Scenario'),
    el('p', { class: 'ed-stat' }, path),
    el('div', { class: 'ed-row' },
      el('button', { type: 'button', class: 'ed-btn primary ed-small', onclick: () => void e.runScenario(sc) }, 'Run here'),
      el('button', { type: 'button', class: 'ed-btn ed-small', onclick: () => download(JSON.stringify(sc, null, 2) + '\n', `${id}.json`, 'application/json') }, 'Export .json'),
      el('button', { type: 'button', class: 'ed-btn ed-small', onclick: () => { e.pal.scenario = null; e.ed.apply('Delete scenario', removeOps()); } }, 'Delete')),
    sec('About', txt('Name', ['meta', 'name']), txt('Id', ['meta', 'id']), txt('Description', ['meta', 'description']), num('Seed', ['seed'], { min: 0, step: 1 }),
      el('p', { class: 'ed-note' }, `map.id is "${sc.map?.id ?? doc.meta.id}" in the file; Run here flies this draft.`)),
    sec('Setup',
      pick('Course', ['map', 'course'], (doc.courses ?? []).map((c) => ({ value: c.id, label: c.name })), 'main course'),
      pick('Drone', ['drone', 'preset'], PRESETS.map((p) => ({ value: p.name, label: p.name })), 'default 5" freestyle'),
      num('Wind', ['sim', 'wind', 'speed'], { min: 0, max: 30, step: 0.5, unit: 'm/s' }), num('Wind from', ['sim', 'wind', 'direction'], { min: 0, max: 360, step: 5, unit: '°' }),
      num('Turbulence', ['sim', 'wind', 'turbulence'], { min: 0, max: 3, step: 0.1 }), num('Gusts', ['sim', 'wind', 'gusts'], { min: 0, max: 20, step: 0.5, unit: '/min' })),
    sec('Start',
      pick('Spawn', ['start', 'spawn'], spawns, 'the map\'s (or course\'s) spawn'),
      pick('Flight mode', ['start', 'mode'], ['acro', 'horizon', 'angle'].map((v) => ({ value: v, label: v })), 'acro'),
      check('Armed at the start', ['start', 'armed'])),
    sec('Task',
      lbl('Type', el('select', { onchange: (ev: Event) => commit(['task'], structuredClone(TASK_DEFAULTS[(ev.target as HTMLSelectElement).value]), 'Set task') }, ...TASKS.map((t) => el('option', { value: t, selected: t === tt }, t)))),
      ...taskFields),
    sec('Episode', num('Length', ['episode', 'maxSeconds'], { min: 1, step: 5, unit: 's', placeholder: '30' }), check('End on a crash', ['episode', 'endOnCrash'], true), num('Crash speed', ['episode', 'crashSpeedMs'], { min: 0.5, step: 0.5, unit: 'm/s', placeholder: '4' }), check('End out of bounds', ['episode', 'endOutOfBounds'], true)),
    sec('Observations', num('Proximity probes', ['observations', 'probes'], { min: 0, max: 256, step: 1, placeholder: '0' }), num('Probe range', ['observations', 'probeRangeM'], { min: 1, step: 1, unit: 'm', placeholder: '20' }), check('Actors (targets, detections, RC margin)', ['observations', 'actors'])),
    sec('Randomize',
      range('Wind speed', ['randomize', 'sim', 'windSpeed'], { unit: 'm/s', step: 0.5 }), range('Wind from', ['randomize', 'sim', 'windDirection'], { unit: '°', step: 5 }),
      range('Start east', ['randomize', 'start', 'dx'], { sym: true, unit: 'm' }), range('Start north', ['randomize', 'start', 'dy'], { sym: true, unit: 'm' }), range('Start up', ['randomize', 'start', 'dz'], { sym: true, unit: 'm' }), range('Heading', ['randomize', 'start', 'yawDeg'], { sym: true, unit: '°' }),
      spawnRand,
      num('Actor jitter', ['randomize', 'actors', 'jitterM'], { min: 0, step: 0.5, unit: 'm', placeholder: 'off' }), range('Actor speed ×', ['randomize', 'actors', 'speedScale'], { step: 0.05 })),
    el('details', { class: 'ed-sec' }, el('summary', {}, 'JSON'), json));
}
