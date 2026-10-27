// User maps: map packages that players publish to the relay (server/src/mapStore.ts) and that
// anyone can fly or a room host can share. They are kept apart from the official maps: their own
// "User maps" section in the menus, a "User map · not reviewed" badge, never on the official
// leaderboards. A downloaded package is re-hashed against its id (the id is the hash of its
// files), cached in IndexedDB and registered as map "u-…" like a map loaded from disk.
// Loaded on first use (the menus' user-map screens, ?map= links, a room picking a user map).
import { KEYS, load, save, validClientId } from '../app/persist';
import { ZipWriter } from '../app/datasetFiles';
import { checkPackage, MAX_UPLOAD_BYTES, packageId, verifyPackage } from '../../server/src/mapPackage';
import { cleanDisplayName } from '../../server/src/sanitize';
import type { MapMeta } from '../maps/mapDoc';
import { MapFormatError } from '../maps/mapError';
import { PackageInfo, registerPackage } from '../maps/localMaps';
import { hasMap, MAP_LIST } from '../maps/maps';
import { IdbKv, KvStore, MemoryKv } from '../worker/kv';
import { multiplayerUrl } from './config';
import { isUserMapId } from './protocol';

export { isUserMapId };
export type UserMapStatus = 'ok' | 'hidden' | 'removed';
/** A user map as the relay lists it (every field checked: a pilot can point the sim at any relay). */
export interface UserMapSummary {
  id: string; name: string; author: string; license: string; version: string; description: string; tags: string[];
  size: number; created: number; downloads: number; listed: boolean; status: UserMapStatus; preview: boolean;
}
/** A user map in this browser's cache. */
export interface CachedUserMap { id: string; name: string; author: string; license: string; size: number; at: number }

const MAX_CACHED = 30;
const fin = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : 0);

export function parseSummary(x: any): UserMapSummary | null {
  if (!x || typeof x !== 'object' || !isUserMapId(x.id)) return null;
  const name = cleanDisplayName(x.name, 64), author = cleanDisplayName(x.author, 96);
  if (!name || !author) return null;
  return {
    id: x.id, name, author,
    license: typeof x.license === 'string' ? x.license.replace(/[^A-Za-z0-9.+() -]/g, '').slice(0, 120) : '',
    version: typeof x.version === 'string' && /^\d+\.\d+\.\d+$/.test(x.version) ? x.version : '',
    description: cleanDisplayName(x.description, 600),
    tags: Array.isArray(x.tags) ? x.tags.filter((t: unknown): t is string => typeof t === 'string' && /^[a-z0-9-]{1,24}$/.test(t)).slice(0, 8) : [],
    size: fin(x.size, 0, 1 << 30), created: fin(x.created, 0, 1e14), downloads: fin(x.downloads, 0, 1e12),
    listed: x.listed === true, status: x.status === 'hidden' || x.status === 'removed' ? x.status : 'ok', preview: x.preview === true,
  };
}

// ---------------------------------------------------------------------------------------------
// The relay's HTTP API

/** The relay's HTTP origin (the room URL with http(s)), or null when none is configured. */
export function relayHttp(): string | null {
  const ws = multiplayerUrl();
  return ws ? ws.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/$/, '') : null;
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetch = (u, i) => fetch(u, i);
/** Tests: replace the network. */
export function setFetch(f: Fetch | null) { fetcher = f ?? ((u, i) => fetch(u, i)); }

async function call(path: string, init: RequestInit = {}, timeoutMs = 10000): Promise<{ status: number; res: Response } | { error: string }> {
  const base = relayHttp();
  if (!base) return { error: 'No map server is configured for this site.' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher(base + path, { ...init, signal: ctl.signal, mode: 'cors' });
    return { status: res.status, res };
  } catch (e) {
    return { error: (e as Error).name === 'AbortError' ? 'The map server did not answer in time.' : 'Could not reach the map server.' };
  } finally { clearTimeout(timer); }
}
const jsonOf = async (r: Response): Promise<any> => { try { return await r.json(); } catch { return null; } };
const errorText = (status: number, j: any) => (typeof j?.error === 'string' ? j.error.slice(0, 200) : `the server answered ${status}`);

export async function listUserMaps(o: { sort: 'new' | 'popular'; cursor?: string | null; q?: string }): Promise<{ maps: UserMapSummary[]; next: string | null; error: string | null }> {
  const qs = new URLSearchParams({ sort: o.sort, ...(o.cursor ? { cursor: o.cursor } : {}), ...(o.q ? { q: o.q.slice(0, 64) } : {}) });
  const r = await call(`/maps?${qs}`);
  if ('error' in r) return { maps: [], next: null, error: r.error };
  const j = await jsonOf(r.res);
  if (r.status !== 200) return { maps: [], next: null, error: errorText(r.status, j) };
  const maps = Array.isArray(j?.maps) ? (j.maps as unknown[]).slice(0, 100).map(parseSummary).filter((m): m is UserMapSummary => !!m) : [];
  return { maps, next: typeof j?.next === 'string' && /^\d{1,6}$/.test(j.next) ? j.next : null, error: null };
}

/** One map's metadata. status 404 / 410: unknown / removed. */
export async function userMapInfo(id: string): Promise<{ map: UserMapSummary | null; status: number; error: string | null }> {
  if (!isUserMapId(id)) return { map: null, status: 400, error: 'not a user map id' };
  const r = await call(`/maps/${id}`);
  if ('error' in r) return { map: null, status: 0, error: r.error };
  const j = await jsonOf(r.res);
  if (r.status !== 200) return { map: null, status: r.status, error: r.status === 404 ? 'There is no user map with this id.' : r.status === 410 ? 'This user map was removed.' : errorText(r.status, j) };
  const map = parseSummary(j);
  return { map, status: map ? 200 : 502, error: map ? null : 'The server sent a map it could not describe.' };
}

export const previewUrl = (id: string) => `${relayHttp() ?? ''}/maps/${id}/preview`;
/** The link that opens a user map in the app. */
export function shareLink(id: string): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${location.origin}${base}?map=${id}`;
}
/** An id typed or pasted by the pilot: a bare id or any link with ?map=. */
export function parseMapRef(s: string): string | null {
  const t = s.trim();
  if (isUserMapId(t)) return t;
  try { const id = new URL(t).searchParams.get('map'); return isUserMapId(id) ? id : null; } catch { return null; }
}

export async function reportUserMap(id: string, reason: 'copyright' | 'offensive' | 'broken' | 'other'): Promise<{ ok: boolean; error: string | null }> {
  const r = await call(`/maps/${id}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, client: clientToken() }) });
  if ('error' in r) return { ok: false, error: r.error };
  const j = await jsonOf(r.res);
  return r.status === 200 ? { ok: true, error: null } : { ok: false, error: errorText(r.status, j) };
}

/** This browser's random token (shared with the leaderboard): the relay stores it hashed as a map's owner. */
function clientToken(): string {
  let c = load(KEYS.lbClient, validClientId);
  if (!c) {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    c = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    save(KEYS.lbClient, c);
  }
  return c;
}

/** Read a response body, refusing more than max bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); throw new Error('the package is larger than any map may be'); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Download a package and check it against its id. Throws with a message for the pilot. */
export async function downloadUserPackage(id: string): Promise<{ zip: Uint8Array; files: Map<string, Uint8Array> }> {
  if (!isUserMapId(id)) throw new Error(`"${id}" is not a user map id`);
  const r = await call(`/maps/${id}/package.zip`, {}, 60000);
  if ('error' in r) throw new Error(r.error);
  if (r.status !== 200) {
    const j = await jsonOf(r.res);
    throw new Error(r.status === 404 ? 'There is no user map with this id.' : r.status === 410 ? 'This user map was removed.' : r.status === 451 ? 'This user map is hidden after reports while it is reviewed.' : errorText(r.status, j));
  }
  const zip = await readCapped(r.res, MAX_UPLOAD_BYTES);
  return { zip, files: await verifyPackage(zip, id) };
}

// ---------------------------------------------------------------------------------------------
// Cache (IndexedDB "fpv-sim-usermaps": "index" -> CachedUserMap[], "pkg:<id>" -> the zip)

let kv: KvStore | null = null;
const store = () => (kv ??= typeof indexedDB !== 'undefined' ? new IdbKv(indexedDB, (why) => console.warn(`user maps are not cached: ${why}`), 3000, 'fpv-sim-usermaps') : new MemoryKv());
/** Tests: replace the cache. */
export function setStore(s: KvStore | null) { kv = s; }

const validIndex = (raw: unknown): CachedUserMap[] => (Array.isArray(raw) ? raw.filter((x): x is CachedUserMap =>
  !!x && typeof x === 'object' && isUserMapId(x.id) && typeof x.name === 'string' && typeof x.author === 'string' && typeof x.license === 'string' && Number.isFinite(x.size) && Number.isFinite(x.at)) : []);

export async function cachedUserMaps(): Promise<CachedUserMap[]> { return validIndex(await store().get('index')).sort((a, b) => b.at - a.at); }

async function cachePut(id: string, zip: Uint8Array, info: PackageInfo): Promise<void> {
  const s = store();
  let list = (await cachedUserMaps()).filter((m) => m.id !== id);
  list.unshift({ id, name: info.name, author: info.author, license: info.license, size: zip.length, at: Date.now() });
  const drop = list.slice(MAX_CACHED);
  list = list.slice(0, MAX_CACHED);
  if (!(await s.set(`pkg:${id}`, zip))) return;
  for (const m of drop) await s.set(`pkg:${m.id}`, null);
  await s.set('index', list);
}

export async function removeCachedUserMap(id: string): Promise<void> {
  const s = store();
  await s.set(`pkg:${id}`, null);
  await s.set('index', (await cachedUserMaps()).filter((m) => m.id !== id));
}

// ---------------------------------------------------------------------------------------------
// Registering a user map (as "u-…": the worker gets it through localMaps' listeners, see main.ts)

const loading = new Map<string, Promise<{ id: string; info: PackageInfo }>>();
const infos = new Map<string, PackageInfo>();

/** The registered user map's names (after fetchUserMap), else what the registry has. */
export function userMapLabel(id: string): PackageInfo | null {
  const i = infos.get(id);
  if (i) return i;
  const e = MAP_LIST[id];
  return e?.community?.user ? { name: e.name, author: e.community.author, license: e.community.license, user: true } : null;
}

/**
 * Make user map `id` flyable: from the cache, else downloaded; re-hashed against its id, validated
 * like a map from disk, cached and registered. Throws with a message for the pilot.
 */
export function fetchUserMap(id: string): Promise<{ id: string; info: PackageInfo }> {
  if (hasMap(id) && infos.has(id)) return Promise.resolve({ id, info: infos.get(id)! });
  let p = loading.get(id);
  if (!p) {
    p = (async () => {
      let files: Map<string, Uint8Array> | null = null, zip: Uint8Array | null = null;
      const hit = await store().get(`pkg:${id}`);
      if (hit instanceof Uint8Array) {
        try { files = await verifyPackage(hit, id); zip = hit; } catch { await removeCachedUserMap(id); } // damaged: fetch it again
      }
      if (!files || !zip) ({ zip, files } = await downloadUserPackage(id));
      const blobs = new Map<string, Blob>();
      for (const [path, b] of files) blobs.set(path, new Blob([b as Uint8Array<ArrayBuffer>]));
      const r = await registerPackage(blobs, (doc) => ({ id, info: {
        name: cleanDisplayName(doc.meta.name, 64) || 'Untitled user map', author: cleanDisplayName(doc.meta.author, 96) || 'unknown', license: doc.meta.license, user: true,
      } }));
      infos.set(id, r.info);
      await cachePut(id, zip, r.info); // (a cache hit moves to the front)
      return { id, info: r.info };
    })().finally(() => loading.delete(id));
    loading.set(id, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Publishing

/** Zip a package's files (stored entries: images and meshes are compressed already). */
export async function zipPackage(files: Map<string, Uint8Array>): Promise<Uint8Array> {
  const z = new ZipWriter();
  for (const [p, b] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) z.add(p, b);
  return z.finish();
}

export interface PublishResult { id: string; url: string; existing: boolean; listed: boolean; warnings: string[] }

/**
 * Publish a package: the full local validation first (the loader, then the relay's own checks),
 * then the upload; the id the relay answers must be the one computed here. Throws MapFormatError
 * (problems to fix) or Error (network / server) with a message for the pilot.
 */
export async function publishPackage(files: Map<string, Blob>, opts: { listed: boolean; onProgress?: (step: string) => void }): Promise<PublishResult> {
  const step = opts.onProgress ?? (() => {});
  step('Checking the map…');
  const bytes = new Map<string, Uint8Array>();
  for (const [p, b] of files) bytes.set(p, new Uint8Array(await b.arrayBuffer()));
  const { loadMapPackage } = await import('../maps/mapFormat');
  await loadMapPackage({
    read: async (p) => { const b = bytes.get(p); if (!b) throw new Error('no such file'); return b; },
    url: () => '',
    list: async () => [...bytes].map(([path, b]) => ({ path, size: b.length })),
  }, { checkAssets: true });
  const checked = await checkPackage(bytes); // the relay's rules (licence text, names, headers)
  const { id } = await packageId(bytes);
  const zip = await zipPackage(bytes);
  if (zip.length > MAX_UPLOAD_BYTES) throw new MapFormatError([`the package is ${(zip.length / 1048576).toFixed(1)} MiB; at most ${MAX_UPLOAD_BYTES >> 20} MiB can be published`]);
  step('Uploading…');
  const r = await call('/maps', {
    method: 'POST', body: zip as Uint8Array<ArrayBuffer>,
    headers: { 'Content-Type': 'application/zip', 'X-Map-Rights': 'yes', 'X-Map-Listed': opts.listed ? '1' : '0', 'X-Client': clientToken() },
  }, 120000);
  if ('error' in r) throw new Error(r.error);
  const j = await jsonOf(r.res);
  if (r.status === 422 && Array.isArray(j?.errors)) throw new MapFormatError(j.errors.filter((e: unknown) => typeof e === 'string').slice(0, 50));
  if (r.status !== 200 && r.status !== 201) throw new Error(`Publishing failed: ${errorText(r.status, j)}`);
  if (j?.id !== id) throw new Error(`The server stored the map under another id (${String(j?.id).slice(0, 40)} instead of ${id}); it was not published as checked here.`);
  // keep our own copy: opening the link here needs no download
  try {
    const blobs = new Map<string, Blob>();
    for (const [p, b] of bytes) blobs.set(p, new Blob([b as Uint8Array<ArrayBuffer>]));
    const info: PackageInfo = { name: checked.meta.name, author: checked.meta.author, license: checked.meta.license, user: true };
    await cachePut(id, zip, info);
  } catch { /* the cache is a convenience */ }
  return { id, url: shareLink(id), existing: j.existing === true, listed: j.listed === true, warnings: [...checked.warnings] };
}

/** The editor's Publish button: the publish dialog (src/ui/userMaps/publish.ts, loaded on first use). */
export async function publishDialog(files: Map<string, Blob>, meta: MapMeta): Promise<{ id: string } | null> {
  return (await import('../ui/userMaps/publish')).publishDialog(files, meta);
}
