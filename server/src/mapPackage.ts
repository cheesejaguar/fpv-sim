// User map packages (published by players, see mapStore.ts): the content id and the checks a
// package must pass before the relay stores it. Platform-independent (Web Crypto, streams), shared
// by the relay and the app: the app runs the same checks before it uploads, and re-hashes every
// downloaded package against its id.
//
// Id: "u-" + the first 20 base32 characters (100 bits) of
//   sha256( sorted lines "<path>\0<sha256 hex of the file's bytes>", joined with "\n" )
// so it names the files, not the zip (any zip of the same files has the same id), passes the room
// protocol's MAP_ID_RE and binds rooms and replays to exact bytes.
import { ASSET_EXT, assetPathError, BUDGETS, DOC_FILE, FORBIDDEN_EXT, imageSize, isObj, MapFormatError, NEEDS_TEXT, validateMapDoc } from '../../src/maps/mapDoc';
import type { MapDocV1 } from '../../src/maps/mapDoc';
import { readZip } from '../../src/maps/zip';
import { USER_MAP_RE } from '../../src/net/protocol';
import { cleanDisplayName } from './sanitize';

export { USER_MAP_RE };
/** A published package: at most the package budget plus room for the zip's own headers. */
export const MAX_UPLOAD_BYTES = 17 << 20;
export const MAX_FILES = 256;
export const ID_CHARS = 20;

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32(b: Uint8Array): string {
  let out = '', bits = 0, acc = 0;
  for (const x of b) {
    acc = (acc << 8) | x; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export async function sha256(b: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>)); }

export interface ManifestFile { path: string; size: number; sha256: string }

/** The content id of a set of files, and its manifest (sorted by path). */
export async function packageId(files: Iterable<[string, Uint8Array]>): Promise<{ id: string; manifest: ManifestFile[] }> {
  const manifest: ManifestFile[] = [];
  for (const [path, bytes] of files) manifest.push({ path, size: bytes.length, sha256: hex(await sha256(bytes)) });
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = manifest.map((f) => `${f.path}\0${f.sha256}`).join('\n');
  return { id: `u-${base32(await sha256(new TextEncoder().encode(text))).slice(0, ID_CHARS)}`, manifest };
}

/** Unzip a package, every entry bounded by its declared size and the budgets (a zip bomb stops early). */
export async function unzipPackage(zip: Uint8Array): Promise<{ files: Map<string, Uint8Array>; errors: string[] }> {
  const files = new Map<string, Uint8Array>(), errors: string[] = [];
  let entries;
  try { entries = readZip(zip); } catch (e) { return { files, errors: [`not a readable zip archive (${(e as Error).message})`] }; }
  if (entries.length > MAX_FILES) return { files, errors: [`the package has ${entries.length} files; at most ${MAX_FILES} are allowed`] };
  let total = 0;
  for (const e of entries) {
    if (files.has(e.path)) { errors.push(`file "${e.path}" is in the archive twice`); continue; }
    if (e.size > BUDGETS.fileBytes) { errors.push(`file "${e.path}": ${(e.size / 1048576).toFixed(1)} MiB exceeds the per-file budget of ${BUDGETS.fileBytes / 1048576} MiB`); continue; }
    total += e.size;
    if (total > BUDGETS.packageBytes) { errors.push(`the package unpacks to more than ${BUDGETS.packageBytes / 1048576} MiB (the budget)`); break; }
    try {
      const b = await e.read(e.size);
      if (b.length !== e.size) { errors.push(`file "${e.path}": its size does not match the archive's directory`); continue; }
      files.set(e.path, b);
    } catch (x) { errors.push(`file "${e.path}": cannot be unpacked (${(x as Error).message})`); }
  }
  return { files, errors };
}

/** What the index keeps of a package's map.json (names cleaned for display). */
export interface PackageMeta { metaId: string; name: string; author: string; license: string; version: string; description: string; tags: string[] }
export interface CheckedPackage { id: string; meta: PackageMeta; manifest: ManifestFile[]; size: number; preview: { path: string; type: string } | null; warnings: string[]; doc: MapDocV1 }

const IMG_TYPE: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const extType = (p: string) => (/\.png$/i.test(p) ? 'png' : /\.jpe?g$/i.test(p) ? 'jpeg' : /\.webp$/i.test(p) ? 'webp' : null);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * The checks a user map passes before it is published: file names, types and budgets, map.json
 * (validateMapDoc, an accepted licence, its licence text when the licence requires one), every file
 * map.json references present, image headers (type, pixel size, bytes per role), glb headers, JSON
 * and text files readable, names that are not blank or blocked. Throws MapFormatError listing every
 * problem.
 */
export async function checkPackage(files: Map<string, Uint8Array>): Promise<CheckedPackage> {
  const errors: string[] = [], warnings: string[] = [];
  let total = 0;
  if (files.size > MAX_FILES) errors.push(`the package has ${files.size} files; at most ${MAX_FILES} are allowed`);
  for (const [p, b] of files) {
    total += b.length;
    const e = assetPathError(p);
    if (e) errors.push(`file "${p}": name ${e}`);
    else if (FORBIDDEN_EXT.test(p)) errors.push(`file "${p}": this file type is not allowed in map packages (no game archives, executables or scripts)`);
    else if (!ASSET_EXT.test(p)) errors.push(`file "${p}": unsupported file type (allowed: .json .png .jpg .webp .glb .map .md .txt)`);
    if (b.length > BUDGETS.fileBytes) errors.push(`file "${p}": ${(b.length / 1048576).toFixed(1)} MiB exceeds the per-file budget of ${BUDGETS.fileBytes / 1048576} MiB`);
  }
  if (total > BUDGETS.packageBytes) errors.push(`package is ${(total / 1048576).toFixed(1)} MiB; the budget is ${BUDGETS.packageBytes / 1048576} MiB`);

  const mj = files.get('map.json');
  if (!mj) throw new MapFormatError([...errors, 'no map.json at the top level of the package']);
  if (mj.length > BUDGETS.mapJsonBytes) throw new MapFormatError([...errors, `map.json is ${(mj.length / 1024).toFixed(0)} KiB; the budget is ${BUDGETS.mapJsonBytes / 1024} KiB`]);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(mj)); } catch (e) { throw new MapFormatError([...errors, `map.json: not valid JSON (${(e as Error).message})`]); }
  let doc: MapDocV1;
  try { ({ doc } = validateMapDoc(raw)); } catch (e) { if (e instanceof MapFormatError) throw new MapFormatError([...errors, ...e.errors], e.warnings); throw e; }

  // ---- licence ----
  const names = [...files.keys()];
  if (NEEDS_TEXT.test(doc.meta.license.replace(/[()]/g, '')) && !names.some((n) => /^(LICENSE|COPYING)(\.txt|\.md)?$/i.test(n)))
    errors.push(`${doc.meta.license} requires its full licence text: add LICENSE.txt to the package (or pick CC0-1.0 / CC-BY-4.0, which don't)`);
  if (!names.includes('ATTRIBUTION.md')) warnings.push('ATTRIBUTION.md is missing: state who made the map and every asset in it, their sources and licences');

  // ---- names shown to every player ----
  const name = cleanDisplayName(doc.meta.name, 64), author = cleanDisplayName(doc.meta.author, 96);
  if (!name) errors.push('map.json.meta.name: this name is not allowed');
  if (!author) errors.push('map.json.meta.author: this name is not allowed');
  const description = doc.meta.description ? cleanDisplayName(doc.meta.description, 600) : '';

  // ---- referenced files, by role (pixel and byte budgets) ----
  const need = (p: string | undefined, what: string) => { if (p !== undefined && !files.has(p)) errors.push(`${what}: file "${p}" is not in the package`); };
  const roles = new Map<string, { px: number; bytes: number; what: string }>();
  const role = (p: string | undefined, px: number, bytes: number, what: string) => { if (p) { need(p, what); if (!roles.has(p)) roles.set(p, { px, bytes, what }); } };
  role(doc.meta.preview, 4096, BUDGETS.previewBytes, 'map.json.meta.preview');
  role(doc.ground?.texture, BUDGETS.texturePx, BUDGETS.textureBytes, 'map.json.ground.texture');
  if (doc.ground?.type === 'heightfield') role(doc.ground.image, BUDGETS.heightfieldPx, BUDGETS.fileBytes, 'map.json.ground.image');
  (doc.primitives ?? []).forEach((p, i) => { if (p.type === 'box') role(p.texture, BUDGETS.texturePx, BUDGETS.textureBytes, `map.json.primitives[${i}].texture`); });
  (doc.geometry ?? []).forEach((g, i) => {
    need(g.src, `map.json.geometry[${i}].src`);
    if ((g.type === 'quake' || g.type === 'doom') && g.textures && g.textures !== 'builtin:librequake') need(g.textures, `map.json.geometry[${i}].textures`);
  });
  (doc.scenarios ?? []).forEach((p, i) => need(p, `map.json.scenarios[${i}]`));

  // ---- every file's contents look like its type ----
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  for (const [p, b] of files) {
    if (p === 'map.json' || assetPathError(p) || !ASSET_EXT.test(p)) continue;
    const t = extType(p);
    if (t) {
      const sz = imageSize(b), r = roles.get(p) ?? { px: 4096, bytes: BUDGETS.fileBytes, what: `file "${p}"` };
      if (!sz) errors.push(`${r.what}: "${p}" is not a PNG, JPEG or WebP image`);
      else if (sz.type !== t) errors.push(`${r.what}: "${p}" is a ${sz.type.toUpperCase()} image with the wrong file extension`);
      else if (!(sz.w > 0 && sz.h > 0) || sz.w > r.px || sz.h > r.px) errors.push(`${r.what}: "${p}" is ${sz.w}x${sz.h} px; the budget is ${r.px}x${r.px}`);
      if (b.length > r.bytes) errors.push(`${r.what}: "${p}" is ${(b.length / 1024).toFixed(0)} KiB; the budget is ${r.bytes / 1024} KiB`);
    } else if (/\.glb$/i.test(p)) {
      if (b.length < 20 || u32le(b, 0) !== 0x46546c67 || u32le(b, 4) !== 2 || u32le(b, 8) !== b.length) errors.push(`file "${p}": not a binary glTF 2.0 file (.glb header)`);
    } else {
      let s: string | null = null;
      try { s = utf8.decode(b); } catch { errors.push(`file "${p}": not UTF-8 text`); }
      if (s !== null && s.includes('\0')) errors.push(`file "${p}": not a text file`);
      else if (s !== null && /\.json$/i.test(p)) { try { JSON.parse(s); } catch (e) { errors.push(`file "${p}": not valid JSON (${(e as Error).message})`); } }
    }
  }
  for (const [i, p] of (doc.scenarios ?? []).entries()) {
    const b = files.get(p);
    if (b) try { const j = JSON.parse(new TextDecoder().decode(b)); if (!isObj(j) || j.format !== 'fpvsim-scenario') errors.push(`map.json.scenarios[${i}]: "${p}" is not an fpvsim-scenario file`); } catch { /* reported above */ }
  }
  const referenced = new Set(['map.json', ...roles.keys(), ...(doc.geometry ?? []).flatMap((g) => [g.src, 'textures' in g && g.textures ? g.textures : '']), ...(doc.scenarios ?? [])]);
  for (const p of names) if (!referenced.has(p) && !DOC_FILE.test(p)) warnings.push(`file "${p}" is not referenced by map.json`);

  if (errors.length) throw new MapFormatError(errors, warnings);
  const { id, manifest } = await packageId(files);
  const pv = doc.meta.preview && files.has(doc.meta.preview) ? imageSize(files.get(doc.meta.preview)!) : null;
  return {
    id, manifest, size: total, warnings, doc,
    meta: { metaId: doc.meta.id, name, author, license: doc.meta.license, version: doc.meta.version, description, tags: doc.meta.tags ?? [] },
    preview: pv && doc.meta.preview ? { path: doc.meta.preview, type: IMG_TYPE[pv.type] } : null,
  };
}

/** A downloaded package: unzip it and check that its files hash to `id` (else it was altered). */
export async function verifyPackage(zip: Uint8Array, id: string): Promise<Map<string, Uint8Array>> {
  if (!USER_MAP_RE.test(id)) throw new Error(`"${id}" is not a user map id`);
  const { files, errors } = await unzipPackage(zip);
  if (errors.length) throw new MapFormatError(errors);
  const got = (await packageId(files)).id;
  if (got !== id) throw new Error(`the downloaded package does not match its id (${got} instead of ${id}): it was changed on the way`);
  return files;
}
