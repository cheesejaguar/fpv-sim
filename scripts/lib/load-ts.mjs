// Load the simulator's TypeScript modules from Node scripts through Vite's SSR module loader
// (the same transform the app and the tests use), e.g. the map package loader for the validator.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Import `paths` (repo-relative, e.g. 'src/maps/mapFormat.ts'); call close() when done. */
export async function loadTs(...paths) {
  const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const mods = [];
    for (const p of paths) mods.push(await server.ssrLoadModule('/' + p));
    return { mods, close: () => server.close() };
  } catch (e) { await server.close(); throw e; }
}
