// Running the headless environment in Node: the firmware from public/bf (compiled once, a fresh
// instance per episode), the precomputed prop tables from public/bemt, and the map files the
// browser would download from the site served from public/ on disk.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BEMT_DIR, currentBemtManifest } from '../../scripts/lib/bemt-inputs.mjs';
import { Betaflight } from '../bf/bfModule';
import { decodeTable } from '../builder/bemtTables';
import { setPropTableSource } from '../builder/derive';
import { EnvOptions, FpvEnv } from './env';
import { registerMapFromDisk } from './mapFiles';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let installed = false;
/**
 * Serve root-relative URLs ("/maps/bando/map.json", "maps/quake/e1m1.map") from public/ on disk, as
 * the site would; everything else goes to the real fetch. Prop tables come from public/bemt when
 * they match the current physics sources (else the builder computes them).
 */
export function installNodeHost(root = REPO_ROOT): void {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')) {
      const path = decodeURIComponent(url.replace(/[?#].*$/, '').replace(/^\/+/, ''));
      if (path.split('/').includes('..')) return new Response(null, { status: 403 });
      try { return new Response(readFileSync(join(root, 'public', path)), { status: 200 }); } catch { return new Response(null, { status: 404 }); }
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const m = currentBemtManifest(root);
  if (m) setPropTableSource((id) => { const f = m.tables[id]; return f ? decodeTable(readFileSync(join(root, BEMT_DIR, f))) : null; });
}

/**
 * A firmware factory for the environment: the Emscripten glue imported and the .wasm compiled once;
 * each call instantiates a fresh flight controller (milliseconds).
 */
export function nodeFirmware(root = REPO_ROOT): Promise<EnvOptions['firmware']> {
  let f = firmwares.get(root);
  if (!f) {
    f = (async () => {
      const glue = join(root, 'public/bf/betaflight.mjs'), wasmFile = join(root, 'public/bf/betaflight.wasm');
      const mod = await import(/* @vite-ignore */ pathToFileURL(glue).href);
      const wasm = WebAssembly.compile(readFileSync(wasmFile));
      const factory = mod.default ?? mod;
      return () => Betaflight.fromFactory(factory, wasm);
    })();
    f.catch(() => firmwares.delete(root));
    firmwares.set(root, f);
  }
  return f;
}
const firmwares = new Map<string, Promise<EnvOptions['firmware']>>();

export interface NodeEnvOptions {
  /** the repository (public/ is served from here); default: this checkout */
  root?: string;
  /**
   * Map packages on disk to register first: package folders or .zip files (a map builder export).
   * Each is validated and registered under its meta.id, so scenarios can use it as map.id.
   */
  maps?: string[];
  /** called with each map registered from disk */
  onMap?: (m: { id: string; name: string; warnings: string[]; path: string }) => void;
}

/** An environment ready to reset(): Node host installed, firmware loaded, map packages from disk registered. */
export async function createNodeEnv(o: string | NodeEnvOptions = {}): Promise<FpvEnv> {
  const opts = typeof o === 'string' ? { root: o } : o;
  const root = opts.root ?? REPO_ROOT;
  installNodeHost(root);
  for (const path of opts.maps ?? []) opts.onMap?.({ ...(await registerMapFromDisk(path)), path });
  return new FpvEnv({ firmware: await nodeFirmware(root) });
}
