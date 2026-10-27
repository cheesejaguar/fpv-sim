// Map packages from disk for the headless simulator (Node): a package folder or a .zip (such as a
// map builder export) read through a filesystem PackageSource, validated, and registered in the map
// registry under its meta.id, so scenarios can name it without copying it into public/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMapPackage, PackageSource } from '../maps/mapFormat';
import { MAP_LIST, registerMap } from '../maps/maps';
import { readZip } from '../maps/zip';

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

/** A package folder on disk (paths inside it only). */
export function folderSource(dir: string): PackageSource {
  const root = resolve(dir);
  const inside = (p: string) => {
    const f = resolve(root, p);
    if (f !== root && !f.startsWith(root + sep)) throw new Error(`${p}: outside the package`);
    return f;
  };
  const walk = (d: string, out: { path: string; size: number }[]) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f, out);
      else if (e.isFile()) { const path = relative(root, f).split(sep).join('/'); if (!JUNK.test(path)) out.push({ path, size: statSync(f).size }); }
    }
    return out;
  };
  return {
    read: async (p) => new Uint8Array(readFileSync(inside(p))),
    url: (p) => pathToFileURL(inside(p)).href,
    list: async () => walk(root, []),
  };
}

/** A package .zip on disk, re-rooted at its shallowest map.json. */
export function zipSource(file: string): PackageSource {
  const entries = readZip(new Uint8Array(readFileSync(file))).filter((e) => !JUNK.test(e.path));
  const mj = entries.map((e) => e.path).filter((p) => p === 'map.json' || p.endsWith('/map.json')).sort((a, b) => a.length - b.length)[0];
  if (mj === undefined) throw new Error(`${file}: no map.json in the archive`);
  const prefix = mj.slice(0, -'map.json'.length);
  const files = new Map(entries.filter((e) => e.path.startsWith(prefix)).map((e) => [e.path.slice(prefix.length), e]));
  return {
    read: async (p) => { const e = files.get(p); if (!e) throw new Error('no such file'); return e.read(); },
    url: (p) => `zip:${p}`,
    list: async () => [...files.values()].map((e) => ({ path: e.path.slice(prefix.length), size: e.size })),
  };
}

const fromDisk = new Set<string>();

/**
 * Validate the package at `path` (a folder, or a .zip) and register it under its meta.id; returns
 * the id. Throws MapFormatError listing every problem. A built-in map's id can't be taken.
 */
export async function registerMapFromDisk(path: string): Promise<{ id: string; name: string; warnings: string[] }> {
  const src = statSync(path).isDirectory() ? folderSource(path) : zipSource(path);
  const m = await loadMapPackage(src, { checkAssets: true });
  const id = m.doc.meta.id;
  if (id in MAP_LIST && !fromDisk.has(id)) throw new Error(`${path}: map id "${id}" is taken by a map of the simulator; give the package another meta.id`);
  fromDisk.add(id);
  const meta = m.doc.meta;
  registerMap(id, {
    name: meta.name,
    credit: `Loaded from disk by ${meta.author} (${meta.license})`,
    community: { author: meta.author, license: meta.license, local: true },
    build: () => { throw new Error(`map ${id} not loaded: await preloadMap('${id}') first`); },
    prepare: async () => () => m.build(id),
  });
  return { id, name: meta.name, warnings: m.warnings };
}
