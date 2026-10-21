import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// paths relative to this file, not the working directory (scripts load the config from elsewhere)
const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Content hash of the firmware build: appended to its URLs so browsers never run a stale cached copy
// (public/ files keep fixed names, so they can't be fingerprinted by Vite).
const fwVersion = (() => {
  try {
    const h = createHash('sha256');
    for (const f of ['public/bf/betaflight.mjs', 'public/bf/betaflight.wasm']) h.update(readFileSync(root(f)));
    return h.digest('hex').slice(0, 12);
  } catch { return 'dev'; }
})();

// App version for the menu / bug reports: package.json version + short commit ("0.1.0+1a2b3c4").
// Vercel builds have no .git, but tell us the commit in VERCEL_GIT_COMMIT_SHA.
const commit = (() => {
  const v = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (v && /^[0-9a-f]{7,40}$/i.test(v)) return v.toLowerCase();
  try { return execSync('git rev-parse HEAD', { cwd: root('.'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
})();
const pkgVersion = (JSON.parse(readFileSync(root('package.json'), 'utf8')) as { version: string }).version;
const appVersion = commit ? `${pkgVersion}+${commit.slice(0, 7)}` : pkgVersion;

// SharedArrayBuffer requires cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Vite's `server.headers` are missing from its 304 Not Modified replies. WebKit then refuses a
// worker's import of a module the page already has cached ("blocked by Cross-Origin-Embedder-
// Policy"), so set the headers on every dev response, revalidations included.
const isolateAll = {
  name: 'isolate-all-responses',
  configureServer(server: { middlewares: { use(fn: (req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => void): void } }) {
    server.middlewares.use((_req, res, next) => { for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v); next(); });
  },
};

export default defineConfig({
  plugins: [isolateAll],
  // agent worktrees live under .claude/: their edits must not reload this checkout's dev server
  server: { headers: isolation, port: 5173, watch: { ignored: ['**/.claude/**'] } },
  preview: { headers: isolation },
  define: {
    __FW_VERSION__: JSON.stringify(fwVersion),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    'import.meta.env.VITE_APP_COMMIT': JSON.stringify(commit),
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // .map files are emitted (for debugging a production stack trace) but not referenced by the bundles
    sourcemap: 'hidden',
    // never inline fonts as data: URIs: the Content-Security-Policy (vercel.json) allows font-src 'self' only
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
    rolldownOptions: {
      output: {
        // three.js core changes far less often than the app: its own long-cached chunk
        codeSplitting: { groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]build[\\/]/ }] },
      },
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
