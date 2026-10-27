// Drafts in and out of fpvsim-map packages: the package files (map.json, assets, the heightfield
// as a 16-bit PNG, ATTRIBUTION.md / LICENSE.txt for an export), the full loader check, the .zip,
// opening a package (zip, folder, a community map from the server) as a draft, and the decoded
// glTF meshes buildMapDef needs on every edit.
import { encodePng, ZipWriter } from '../app/datasetFiles';
import { BUDGETS, decodePngChannel, glbTriangles, loadMapPackage, MapFormatError, NEEDS_TEXT, triangleBrush, validateMapDoc, type MapAssets, type MapDocV1, type MapMeta, type MapStats, type PackageSource } from '../maps/mapFormat';
import type { BoxPrim, Material, MapDef } from '../maps/world';
import { EditorDoc, gridFromHf, gridHf, type BuilderMeta } from './editorDoc';
import { deriveId } from './templates';

const ID = /^[a-z0-9][a-z0-9-]{1,23}$/;
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** The document as it is written: a valid meta.id (from the name when empty). */
export function exportDoc(ed: EditorDoc): MapDocV1 {
  const d = structuredClone(ed.doc);
  if (!ID.test(d.meta.id ?? '')) d.meta.id = deriveId(d.meta.name ?? '');
  return d;
}

/** Package paths map.json refers to (textures, meshes and their texture sets, preview, scenarios). */
export async function referencedPaths(doc: MapDocV1, files: Map<string, Blob>): Promise<Set<string>> {
  const out = new Set<string>(['map.json']);
  if (doc.meta.preview) out.add(doc.meta.preview);
  if (doc.ground?.texture) out.add(doc.ground.texture);
  if (doc.ground?.type === 'heightfield') out.add(doc.ground.image);
  for (const p of doc.primitives ?? []) if (p.type === 'box' && p.texture) out.add(p.texture);
  for (const s of doc.scenarios ?? []) out.add(s);
  for (const g of doc.geometry ?? []) {
    out.add(g.src);
    const t = g.type === 'gltf' ? undefined : g.textures;
    if (!t || t === 'builtin:librequake') continue;
    out.add(t);
    const b = files.get(t), dir = t.includes('/') ? t.slice(0, t.lastIndexOf('/') + 1) : '';
    if (b) try { for (const v of Object.values(JSON.parse(await b.text()) as Record<string, { file: string }>)) out.add(dir + v.file); } catch { /* the loader reports it */ }
  }
  return out;
}

export const isDocFile = (p: string) => /^(ATTRIBUTION\.md|README\.md|LICENSE(\.txt|\.md)?|COPYING(\.txt)?|CREDITS(\.txt|\.md)?)$/i.test(p);

/** ATTRIBUTION.md from the map's meta and the asset credits table (plus the original text of an opened package). */
export function attribution(doc: MapDocV1, credits: BuilderMeta['credits'] = [], original?: string): string {
  const m = doc.meta, esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`# ${m.name}`, '', `Map by ${m.author}, version ${m.version}. Licence: ${m.license} (SPDX identifier).${m.homepage ? ` Homepage: ${m.homepage}` : ''}`, ''];
  if (m.description) lines.push(m.description, '');
  lines.push('Made with the fpv-sim map builder. Unless listed below, every part of this map (map.json, the heightfield and generated files) is by the author above under the licence above.', '');
  const rows = credits.filter((c) => c.file || c.author || c.source);
  if (rows.length) {
    lines.push('## Assets', '', '| File | Author | Source | Licence |', '| --- | --- | --- | --- |');
    for (const c of rows) lines.push(`| ${esc(c.file)} | ${esc(c.author)} | ${esc(c.source)} | ${esc(c.license)} |`);
    lines.push('');
  }
  if (original?.trim()) lines.push('## Original attribution', '', original.trim(), '');
  return lines.join('\n');
}

/** LICENSE.txt stand-in for a licence whose terms require shipping its text: the author pastes the text in. */
export function licensePlaceholder(spdx: string): string {
  return `This map is licensed under ${spdx}.\n\nThat licence requires its full text to ship with the files. Replace this note with the complete text of ${spdx} from https://spdx.org/licenses/${spdx.split(/\s+/)[0].replace(/[()]/g, '')}.html before you publish or contribute the map.\n`;
}

/**
 * The package's files. docs: also ATTRIBUTION.md (generated) and LICENSE.txt (a placeholder when the
 * licence needs its text and the package has none), as an export or contribution wants them.
 */
export async function packageFiles(ed: EditorDoc, o: { docs?: boolean } = {}): Promise<Map<string, Blob>> {
  const doc = exportDoc(ed), out = new Map<string, Blob>();
  out.set('map.json', new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' }));
  const g = doc.ground;
  if (g?.type === 'heightfield' && ed.grid) out.set(g.image, new Blob([(await encodePng(ed.grid.w, ed.grid.h, ed.grid.data, 'gray16')) as BlobPart], { type: 'image/png' }));
  const refs = await referencedPaths(doc, ed.assets);
  for (const [p, b] of ed.assets) if (!out.has(p) && (refs.has(p) || (o.docs && isDocFile(p) && !/^ATTRIBUTION\.md$/i.test(p)))) out.set(p, b);
  if (o.docs) {
    const orig = ed.assets.get('ATTRIBUTION.md');
    const prev = orig ? await orig.text() : undefined;
    // re-exporting our own export: don't nest the old generated text in the new one
    out.set('ATTRIBUTION.md', new Blob([attribution(doc, ed.meta.credits, prev && !prev.includes('Made with the fpv-sim map builder') ? prev : undefined)], { type: 'text/markdown' }));
    if (NEEDS_TEXT.test(doc.meta.license.replace(/[()]/g, '')) && ![...out.keys()].some((n) => /^(LICENSE|COPYING)(\.txt|\.md)?$/i.test(n)))
      out.set('LICENSE.txt', new Blob([licensePlaceholder(doc.meta.license)], { type: 'text/plain' }));
  }
  return out;
}

/** A package source over in-memory files (check, open). */
export function filesSource(files: Map<string, Blob>, url: (p: string) => string = (p) => p): PackageSource {
  return {
    url,
    read: async (p) => { const b = files.get(p); if (!b) throw new Error('no such file'); return bytesOf(b); },
    list: async () => [...files].map(([path, b]) => ({ path, size: b.size })),
  };
}

export interface CheckResult { errors: string[]; warnings: string[]; stats?: MapStats }
/** The full loader check (npm run map:validate --local): structure, budgets, every asset. */
export async function checkPackage(files: Map<string, Blob>, strict = false): Promise<CheckResult> {
  try {
    const m = await loadMapPackage(filesSource(files), { strict, checkAssets: true });
    return { errors: [], warnings: m.warnings, stats: m.stats };
  } catch (e) {
    if (e instanceof MapFormatError) return { errors: e.errors, warnings: e.warnings };
    return { errors: [(e as Error).message ?? String(e)], warnings: [] };
  }
}

/** The .zip a contributor submits (stored entries; PNG and glb are compressed already). */
export async function zipPackage(files: Map<string, Blob>): Promise<Uint8Array> {
  const z = new ZipWriter();
  for (const [p, b] of [...files].sort(([a], [b]) => (a === 'map.json' ? -1 : b === 'map.json' ? 1 : a < b ? -1 : 1))) z.add(p, await bytesOf(b));
  return z.finish();
}

// ---------------------------------------------------------------------------------------------
// glTF meshes for buildMapDef (the loader's own placement, without re-reading the package)

const tris = new WeakMap<Blob, ReturnType<typeof glbTriangles> | Error>();
export async function glbInfo(b: Blob): Promise<ReturnType<typeof glbTriangles> | Error> {
  let t = tris.get(b);
  if (!t) { try { t = glbTriangles(await bytesOf(b)); } catch (e) { t = e as Error; } tris.set(b, t); }
  return t;
}
const deg = Math.PI / 180;

/** MapAssets.meshes for the document's glTF entries (as loadMapPackage builds them). */
export async function meshAssets(doc: MapDocV1, assets: Map<string, Blob>, url: (p: string) => string): Promise<{ meshes: MapAssets['meshes']; errors: string[]; triangles: number; collision: number }> {
  const meshes: MapAssets['meshes'] = [], errors: string[] = [];
  let triangles = 0, collision = 0;
  for (const [gi, g] of (doc.geometry ?? []).entries()) {
    if (g.type !== 'gltf') continue;
    const b = assets.get(g.src);
    if (!b) { errors.push(`geometry[${gi}]: "${g.src}" is not in the package`); continue; }
    const tri = await glbInfo(b);
    if (tri instanceof Error) { errors.push(`geometry[${gi}]: ${tri.message}`); continue; }
    triangles += tri.triangles;
    const s = g.scale ?? 1, yaw = (g.yawDeg ?? 0) * deg, [px, py, pz] = g.pos ?? [0, 0, 0], co = Math.cos(yaw), si = Math.sin(yaw);
    const P3 = tri.positions, place = (i: number) => { const x = P3[i] * s, y = P3[i + 1] * s; return [px + co * x - si * y, py + si * x + co * y, pz + P3[i + 2] * s]; };
    const entry: MapAssets['meshes'][number] = { inst: { url: url(g.src), pos: { x: px, y: py, z: pz }, yaw, scale: s }, brushes: [] };
    const mat: Material = g.material ?? 'concrete', coll = g.collision ?? 'mesh';
    if (coll === 'mesh') {
      collision += tri.triangles;
      for (let i = 0; i + 8 < P3.length; i += 9) { const br = triangleBrush(place(i), place(i + 3), place(i + 6), mat, `mesh${gi}`); if (br) entry.brushes.push(br); }
    } else if (coll === 'box' && P3.length) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P3.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P3[i + k] * s); hi[k] = Math.max(hi[k], P3[i + k] * s); }
      const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
      entry.box = { kind: 'box', c: { x: px + co * cx - si * cy, y: py + si * cx + co * cy, z: pz + (lo[2] + hi[2]) / 2 }, half: { x: (hi[0] - lo[0]) / 2, y: (hi[1] - lo[1]) / 2, z: (hi[2] - lo[2]) / 2 }, yaw, mat, tag: `mesh${gi}` } as BoxPrim;
    }
    meshes.push(entry);
  }
  return { meshes, errors, triangles, collision };
}

/** Local bounds (ENU, before placement, unscaled) of a glb, for its pick box. */
export function glbBounds(t: ReturnType<typeof glbTriangles>): { lo: number[]; hi: number[] } {
  const P3 = t.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P3.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P3[i + k]); hi[k] = Math.max(hi[k], P3[i + k]); }
  return P3.length ? { lo, hi } : { lo: [-1, -1, 0], hi: [1, 1, 2] };
}

// ---------------------------------------------------------------------------------------------
// Opening packages

export interface Opened { ed: EditorDoc; baseDef: MapAssets['baseDef']; warnings: string[]; urls: Record<string, string> }

/** Open a package's files as a draft: validated, its heightfield decoded into the grid. Throws MapFormatError when map.json is not valid. */
export async function openFiles(files: Map<string, Blob>): Promise<Opened> {
  const mj = files.get('map.json');
  if (!mj) throw new MapFormatError(['no map.json found: the package needs a map.json at its top level']);
  let raw: unknown;
  try { raw = JSON.parse(await mj.text()); } catch (e) { throw new MapFormatError([`map.json: not valid JSON (${(e as Error).message})`]); }
  const { doc } = validateMapDoc(raw);
  const urls: Record<string, string> = {};
  if (typeof URL.createObjectURL === 'function') for (const [p, b] of files) urls[p] = URL.createObjectURL(b);
  const assets = new Map([...files].filter(([p]) => p !== 'map.json'));
  let warnings: string[] = [], baseDef: MapAssets['baseDef'] = null, hf: MapAssets['hf'];
  try {
    const m = await loadMapPackage(filesSource(files, (p) => urls[p] ?? p), { checkAssets: false });
    warnings = m.warnings; baseDef = m.assets.baseDef; hf = m.assets.hf;
  } catch (e) {
    // a package with problems still opens (they are what the author came to fix): what the loader found is shown
    warnings = e instanceof MapFormatError ? [...e.errors, ...e.warnings] : [String(e)];
    if (doc.ground?.type === 'heightfield' && files.has(doc.ground.image)) {
      try { hf = await decodePngChannel(await bytesOf(files.get(doc.ground.image)!)); } catch { /* reported above */ }
    }
  }
  const grid = doc.ground?.type === 'heightfield' && hf ? gridFromHf(hf) : null;
  if (grid && doc.ground?.type === 'heightfield') assets.delete(doc.ground.image); // the grid is the truth now; written back as 16-bit PNG
  return { ed: new EditorDoc(doc, assets, grid), baseDef, warnings, urls };
}

/** Every file of a package served over HTTP (a community map, Bando): map.json, what it references, its docs. */
export async function fetchPackage(baseUrl: string): Promise<Map<string, Blob>> {
  const get = async (p: string) => { const r = await fetch(baseUrl + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.blob(); };
  const files = new Map<string, Blob>([['map.json', await get('map.json')]]);
  const doc = JSON.parse(await files.get('map.json')!.text()) as MapDocV1;
  // texture sets list their own files: fetch those manifests first
  for (const g of doc.geometry ?? []) if (g.type !== 'gltf' && g.textures && g.textures !== 'builtin:librequake') files.set(g.textures, await get(g.textures));
  const refs = await referencedPaths(doc, files);
  await Promise.all([...refs].filter((p) => !files.has(p)).map(async (p) => files.set(p, await get(p))));
  for (const p of ['ATTRIBUTION.md', 'LICENSE.txt', 'LICENSE.md', 'LICENSE']) try { files.set(p, await get(p)); } catch { /* optional */ }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Budgets

export interface Meter { label: string; n: number; max: number; unit?: string }
/** Live counts against BUDGETS (the generated gate parts count as primitives, as the loader counts them). */
export function budgetMeters(doc: MapDocV1, def: MapDef | null, extra: { bytes?: number; triangles?: number; collision?: number } = {}): Meter[] {
  const n = (a?: unknown[]) => a?.length ?? 0;
  const prims = def ? def.prims.filter((p) => p.kind !== 'brush').length : n(doc.primitives);
  return [
    { label: 'Primitives', n: prims, max: BUDGETS.primitives },
    { label: 'Gates', n: n(doc.gates), max: BUDGETS.gates },
    { label: 'Trees', n: n(doc.trees), max: BUDGETS.trees },
    { label: 'Lights', n: n(doc.lights), max: BUDGETS.lights },
    { label: 'Indoor zones', n: n(doc.indoor), max: BUDGETS.indoor },
    { label: 'Wake zones', n: n(doc.wakeZones), max: BUDGETS.wakeZones },
    { label: 'Spawns', n: n(doc.spawns), max: BUDGETS.spawns },
    { label: 'Courses', n: n(doc.courses), max: BUDGETS.courses },
    { label: 'Paths', n: n(doc.paths), max: BUDGETS.paths },
    { label: 'Actors', n: n(doc.actors), max: BUDGETS.actors },
    { label: 'Geometry', n: n(doc.geometry), max: BUDGETS.geometry },
    { label: 'Mesh triangles', n: extra.triangles ?? 0, max: BUDGETS.meshTriangles },
    { label: 'Collision triangles', n: extra.collision ?? 0, max: BUDGETS.collisionTriangles },
    ...(extra.bytes !== undefined ? [{ label: 'Package size', n: extra.bytes, max: BUDGETS.packageBytes, unit: 'B' }] : []),
  ];
}

/** Save bytes as a file (browser). */
export function download(data: BlobPart, name: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export const metaOf = (doc: MapDocV1): MapMeta => structuredClone(doc.meta);
export { gridHf };
