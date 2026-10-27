// Map packages loaded from the user's disk (zip, folder or loose files), for trying a map before
// contributing it. Files become blob: URLs that both the renderer and the physics worker can read;
// the map is registered as "local-<id>" (never sent to multiplayer rooms) until the page reloads.
// Downloaded user maps (src/net/userMaps.ts) are registered the same way, as "u-<content hash>".
import { MapFormatError } from './mapError';
import type { MapDocV1 } from './mapDoc';
import type { MapStats, PackageSource } from './mapFormat';
import { registerMap } from './maps';

export interface LocalMapInfo { name: string; author: string; license: string }
/** Every map registered here (from disk, or a downloaded user map), with what the menus show of it. */
export interface PackageInfo extends LocalMapInfo { user?: boolean }
type Listener = (id: string, info: LocalMapInfo, urls: Record<string, string>) => void;
const listeners: Listener[] = [];
const loaded = new Map<string, string[]>(); // id -> blob URLs (revoked when the map is reloaded)

/** Called whenever a local map is (re)registered: main.ts forwards it to the worker. */
export function onLocalMap(f: Listener) { listeners.push(f); }

export const isLocalMap = (id: string) => id.startsWith('local-');

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

/** Re-root a set of files at the folder holding the shallowest map.json. */
function rootAt(files: Map<string, Blob>): Map<string, Blob> {
  const mj = [...files.keys()].filter((p) => p === 'map.json' || p.endsWith('/map.json')).sort((a, b) => a.length - b.length)[0];
  if (mj === undefined) throw new MapFormatError(['no map.json found: the package needs a map.json at its top level']);
  const prefix = mj.slice(0, -'map.json'.length), out = new Map<string, Blob>();
  for (const [p, b] of files) if (p.startsWith(prefix) && !JUNK.test(p)) out.set(p.slice(prefix.length), b);
  return out;
}

/** Files from a file picker: one .zip, or a folder (webkitdirectory), or loose files. */
export async function filesFromList(list: FileList | File[]): Promise<Map<string, Blob>> {
  const arr = [...list];
  if (arr.length === 1 && /\.zip$/i.test(arr[0].name)) return filesFromZip(arr[0]);
  const m = new Map<string, Blob>();
  for (const f of arr) m.set((f.webkitRelativePath || f.name).replace(/\\/g, '/'), f);
  return rootAt(m);
}

export async function filesFromZip(f: Blob): Promise<Map<string, Blob>> {
  const { readZip } = await import('./zip');
  const m = new Map<string, Blob>();
  for (const e of readZip(new Uint8Array(await f.arrayBuffer()))) m.set(e.path, new Blob([(await e.read()) as BlobPart]));
  return rootAt(m);
}

/** Files from a drag-and-drop: a .zip, a folder, or loose files. */
export async function filesFromDrop(dt: DataTransfer): Promise<Map<string, Blob>> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return filesFromList(dt.files);
  if (entries.length === 1 && entries[0].isFile && /\.zip$/i.test(entries[0].name)) return filesFromZip(dt.files[0]);
  const m = new Map<string, Blob>();
  const walk = async (e: FileSystemEntry, path: string): Promise<void> => {
    if (e.isFile) { m.set(path, await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej))); return; }
    const r = (e as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej));
      if (!batch.length) break;
      for (const c of batch) await walk(c, `${path}/${c.name}`);
    }
  };
  for (const e of entries) await walk(e, e.name);
  return rootAt(m);
}

/** Validate a package from disk and register it. Throws MapFormatError with every problem found. */
export async function loadLocalMap(files: Map<string, Blob>): Promise<{ id: string; name: string; warnings: string[]; stats: MapStats }> {
  const r = await registerPackage(files, (doc) => ({ id: `local-${doc.meta.id}`, info: { name: doc.meta.name, author: doc.meta.author, license: doc.meta.license } }));
  return { id: r.id, name: r.info.name, warnings: r.warnings, stats: r.stats };
}

/**
 * Validate a package (blob: URLs for the renderer and the worker) and register it under the id
 * `name` picks (a user map: its "u-…" id, info.user set). Listeners (main.ts) forward it to the
 * worker. Throws MapFormatError with every problem found.
 */
export async function registerPackage(files: Map<string, Blob>, name: (doc: MapDocV1) => { id: string; info: PackageInfo }): Promise<{ id: string; info: PackageInfo; warnings: string[]; stats: MapStats }> {
  const { loadMapPackage, packageEntry, urlTableSource } = await import('./mapFormat'); // loaded on first use
  const urls: Record<string, string> = {};
  for (const [p, b] of files) urls[p] = URL.createObjectURL(b);
  const src: PackageSource = { ...urlTableSource(urls), list: async () => [...files].map(([path, b]) => ({ path, size: b.size })) };
  let m, id: string, info: PackageInfo;
  try { m = await loadMapPackage(src, { checkAssets: true }); ({ id, info } = name(m.doc)); }
  catch (e) { for (const u of Object.values(urls)) URL.revokeObjectURL(u); throw e; }
  const old = loaded.get(id);
  // the previous version may still be on screen (its textures are already decoded): revoke a bit later
  if (old) setTimeout(() => old.forEach((u) => URL.revokeObjectURL(u)), 30000);
  loaded.set(id, Object.values(urls));
  registerMap(id, packageEntry(id, { ...info, local: !info.user }, () => urlTableSource(urls)));
  const plain = { name: info.name, author: info.author, license: info.license };
  for (const f of listeners) f(id, plain, urls);
  return { id, info, warnings: m.warnings, stats: m.stats };
}
