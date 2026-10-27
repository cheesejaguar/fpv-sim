// Map builder drafts in IndexedDB (a database of their own, beside the worker's "fpv-sim"): the
// document, its asset files as Blobs and the height grid. An index entry per draft lists them on
// the Build screen without loading every map.
import type { MapDocV1 } from '../maps/mapDoc';
import { IdbKv, type KvStore, MemoryKv } from '../worker/kv';
import { EditorDoc, type Grid } from './editorDoc';

export interface DraftInfo { id: string; name: string; updated: number; size: number; tags: string[] }
interface Stored { doc: MapDocV1; assets: [string, Blob][]; grid: Grid | null }

let kv: KvStore | null = null;
const store = () => (kv ??= typeof indexedDB === 'undefined' ? new MemoryKv() : new IdbKv(indexedDB, undefined, 4000, 'fpv-sim-drafts'));
/** Tests: an in-memory store. */
export function useStore(s: KvStore) { kv = s; }

export const newDraftId = () => `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export async function listDrafts(): Promise<DraftInfo[]> {
  const v = await store().get('index');
  return Array.isArray(v) ? (v as DraftInfo[]).slice().sort((a, b) => b.updated - a.updated) : [];
}

async function writeIndex(f: (l: DraftInfo[]) => DraftInfo[]) {
  const l = await listDrafts();
  await store().set('index', f(l));
}

export async function saveDraft(id: string, ed: EditorDoc): Promise<boolean> {
  const s: Stored = { doc: ed.doc, assets: [...ed.assets], grid: ed.grid };
  const ok = await store().set(`d:${id}`, s);
  if (!ok) return false;
  const size = [...ed.assets.values()].reduce((a, b) => a + b.size, 0) + (ed.grid ? ed.grid.data.byteLength : 0);
  await writeIndex((l) => [{ id, name: ed.doc.meta.name, updated: Date.now(), size, tags: ed.doc.meta.tags ?? [] }, ...l.filter((d) => d.id !== id)]);
  return true;
}

export async function loadDraft(id: string): Promise<EditorDoc | null> {
  const s = (await store().get(`d:${id}`)) as Stored | null | undefined;
  if (!s?.doc) return null;
  return new EditorDoc(s.doc, new Map(s.assets ?? []), s.grid ?? null);
}

export async function deleteDraft(id: string) {
  await store().set(`d:${id}`, null);
  await writeIndex((l) => l.filter((d) => d.id !== id));
}

export async function duplicateDraft(id: string): Promise<string | null> {
  const ed = await loadDraft(id);
  if (!ed) return null;
  ed.doc.meta.name = `${ed.doc.meta.name} (copy)`.slice(0, 64);
  const n = newDraftId();
  await saveDraft(n, ed);
  return n;
}

/** Write `ed` a moment after the last change (and at once with flush()). */
export function autosave(id: string, ed: EditorDoc, onSaved: (ok: boolean) => void, delayMs = 1200) {
  let timer: ReturnType<typeof setTimeout> | undefined, savedRev = ed.rev, busy: Promise<void> = Promise.resolve();
  const run = () => { clearTimeout(timer); timer = undefined; if (ed.rev === savedRev) return busy; const rev = ed.rev; busy = busy.then(() => saveDraft(id, ed)).then((ok) => { if (ok) savedRev = rev; onSaved(ok); }); return busy; };
  const off = ed.onChange(() => { clearTimeout(timer); timer = setTimeout(run, delayMs); });
  return { flush: () => run(), stop: () => { off(); return run(); }, get dirty() { return ed.rev !== savedRev; } };
}
