// The menu's Build screen (loaded with the map builder's chunk): new maps from templates, drafts
// (open, duplicate, delete), opening a community map or Bando as a draft, importing a .zip or a
// folder. It also keeps the open editing session, so "Back to editor" after a test flight
// reopens the same draft with the camera where the quad is.
import { filesFromDrop, filesFromList } from '../maps/localMaps';
import { MapFormatError } from '../maps/mapDoc';
import { MAP_LIST } from '../maps/maps';
import { confirmDialog, el, onUnmount } from '../ui/dom';
import { R, sampleRing, newestTime } from '../worker/shared';
import { deleteDraft, duplicateDraft, listDrafts, loadDraft, newDraftId, saveDraft, type DraftInfo } from './drafts';
import { Editor, type Session } from './editor';
import { EditorDoc } from './editorDoc';
import type { EditorHost } from './host';
import { fetchPackage, openFiles } from './package';
import { TEMPLATES } from './templates';

let session: Session | null = null;

/** Is there a draft to go back to (after a test flight)? */
export const hasSession = () => !!session;

function open(host: EditorHost, s: Session) {
  session = s;
  new Editor(host, s);
}

/** Back from a test flight: the same draft, looking at where the quad is. */
export function resumeEditor(host: EditorHost) {
  if (!session) return;
  const rec = new Float64Array(host.ctx.rec.length);
  if (sampleRing(host.ctx.sh, newestTime(host.ctx.sh), rec)) session.lookAt = [rec[R.px], rec[R.py], rec[R.pz]];
  open(host, session);
}

async function openDraft(host: EditorHost, id: string, ed?: EditorDoc, warnings?: string[], baseDef: Session['baseDef'] = null) {
  // the same draft again: keep its undo history, camera, palette and Fly choices
  if (session?.draftId === id && !ed) { open(host, session); return; }
  const doc = ed ?? (await loadDraft(id));
  if (!doc) throw new Error('this draft could not be read');
  // a package with a Quake / Doom base level: decode it again (the draft keeps its files)
  if (!baseDef && doc.doc.geometry?.some((g) => g.type !== 'gltf')) {
    const files = new Map(doc.assets); files.set('map.json', new Blob([JSON.stringify(doc.doc)]));
    try { baseDef = (await openFiles(files)).baseDef; } catch { /* shown as problems in the editor */ }
  }
  open(host, { draftId: id, ed: doc, baseDef, course: -1, fly: { course: '', spawn: '', race: (doc.doc.gates?.length ?? 0) > 0 }, warnings });
}

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};

/** The Build screen's body (the menu adds the back bar and the title). */
export function buildScreen(host: EditorHost): HTMLElement {
  const root = el('div', { class: 'gm-build' });
  const status = el('p', { class: 'gm-lead', role: 'status', 'aria-live': 'polite' }, '');
  const busy = async (what: string, f: () => Promise<void>) => {
    status.textContent = `${what}…`;
    try { await f(); status.textContent = ''; }
    catch (e) {
      const errs = e instanceof MapFormatError ? e.errors : [(e as Error)?.message ?? String(e)];
      status.textContent = `${what} failed: ${errs.slice(0, 3).join(' · ')}${errs.length > 3 ? ` (and ${errs.length - 3} more)` : ''}`;
    }
  };
  const fromFiles = (files: Map<string, Blob>) => busy('Opening the package', async () => {
    const o = await openFiles(files), id = newDraftId();
    await saveDraft(id, o.ed);
    await openDraft(host, id, o.ed, o.warnings, o.baseDef);
  });
  const card = (title: string, sub: string, onclick: () => void, extra: Record<string, unknown> = {}) =>
    el('button', { type: 'button', class: 'gm-item', onclick, ...extra }, el('span', {}, el('span', { class: 't' }, title), el('span', { class: 's' }, sub)));

  const cont = session ? el('section', { class: 'gm-card' }, el('h3', {}, 'Continue'),
    card(`Back to ${session.ed.doc.meta.name}`, 'The draft you were editing', () => void busy('Opening', () => openDraft(host, session!.draftId)), { 'data-autofocus': true })) : null;

  const templates = el('section', { class: 'gm-card' }, el('h3', {}, 'New map'),
    el('div', { class: 'gm-build-grid' }, ...TEMPLATES.map((t, i) => card(t.name, t.blurb, () => void busy('Creating the map', async () => {
      const ed = new EditorDoc(t.make()), id = newDraftId();
      await saveDraft(id, ed);
      await openDraft(host, id, ed);
    }), !session && i === 0 ? { 'data-autofocus': true } : {}))));

  const drafts = el('ul', { class: 'gm-build-list' }, el('li', {}, 'Loading your drafts…'));
  const showDrafts = (list: DraftInfo[]) => drafts.replaceChildren(...(list.length ? list.map((d) => el('li', {},
    el('button', { type: 'button', class: 'gm-item', onclick: () => void busy('Opening', () => openDraft(host, d.id)) }, el('span', {}, el('span', { class: 't' }, d.name), el('span', { class: 's' }, `${ago(d.updated)} · ${(d.size / 1024).toFixed(0)} KiB${d.tags.length ? ` · ${d.tags.join(', ')}` : ''}`))),
    el('div', { class: 'gm-build-acts' },
      el('button', { type: 'button', class: 'gm-btn ghost', onclick: () => void busy('Copying', async () => { await duplicateDraft(d.id); showDrafts(await listDrafts()); }) }, 'Duplicate'),
      el('button', { type: 'button', class: 'gm-btn ghost', onclick: () => void confirmDialog({ title: `Delete “${d.name}”?`, body: 'The draft is removed from this browser. Export it first to keep a copy.', ok: 'Delete', danger: true }).then(async (ok) => {
        if (!ok) return;
        await deleteDraft(d.id);
        if (session?.draftId === d.id) session = null;
        showDrafts(await listDrafts());
      }) }, 'Delete')))) : [el('li', { class: 'gm-build-empty' }, 'No drafts yet: start from a template above.')]));
  void listDrafts().then(showDrafts, () => drafts.replaceChildren(el('li', {}, 'Drafts are unavailable: this browser blocks storage (private mode?). You can still build and export.')));

  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  // Bando's package and the community maps (the registry's served packages; not ones loaded from disk)
  const packages = [{ id: 'bando', name: MAP_LIST.bando?.name ?? 'Bando', url: `${base}maps/bando/` },
    ...Object.entries(MAP_LIST).filter(([id, m]) => m.community && !m.community.local && !id.startsWith('local-')).map(([id, m]) => ({ id, name: m.name, url: `${base}maps/community/${id}/` }))];
  const openPkg = el('section', { class: 'gm-card' }, el('h3', {}, 'Open a map'),
    el('p', { class: 'gm-lead' }, 'Map packages open as a new draft: change them, fly them, export them. (The procedural built-in maps are not packages.)'),
    el('div', { class: 'gm-build-grid' }, ...packages.map((p) => card(p.name.split(' — ')[0], p.id === 'bando' ? 'Built-in package' : 'Community map', () => void busy(`Downloading ${p.name}`, async () => fromFiles(await fetchPackage(p.url)))))));

  const zip = el('input', { type: 'file', accept: '.zip,application/zip', class: 'gm-hidden-file', 'aria-label': 'Import a .zip map package' }) as HTMLInputElement;
  const dir = el('input', { type: 'file', class: 'gm-hidden-file', webkitdirectory: true, multiple: true, 'aria-label': 'Import a map folder' }) as HTMLInputElement;
  for (const i of [zip, dir]) i.addEventListener('change', () => { if (i.files?.length) void filesFromList(i.files).then(fromFiles, (e) => { status.textContent = `Import failed: ${(e as Error).message}`; }); i.value = ''; });
  const drop = el('div', { class: 'gm-build-drop' }, 'Or drop a map .zip or folder here');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('on'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('on'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('on'); if (e.dataTransfer) void filesFromDrop(e.dataTransfer).then(fromFiles, (x) => { status.textContent = `Import failed: ${(x as Error).message}`; }); });
  const imp = el('section', { class: 'gm-card' }, el('h3', {}, 'Import'),
    el('div', { class: 'gm-actions' }, el('button', { type: 'button', class: 'gm-btn', onclick: () => zip.click() }, 'Import .zip…'), el('button', { type: 'button', class: 'gm-btn', onclick: () => dir.click() }, 'Import folder…')),
    zip, dir, drop);

  root.append(...[
    el('p', { class: 'gm-lead' }, 'Build race courses, freestyle spots and research ranges, then fly them right away. Drafts are saved in this browser as you work.'),
    status, cont, templates, el('section', { class: 'gm-card' }, el('h3', {}, 'Your drafts'), drafts), openPkg, imp].filter((x): x is HTMLElement => !!x));
  onUnmount(root, () => { status.textContent = ''; });
  return root;
}
