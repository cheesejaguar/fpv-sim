import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Content hash of the firmware build: appended to its URLs so browsers never run a stale cached copy
// (public/ files keep fixed names, so they can't be fingerprinted by Vite).
const fwVersion = (() => {
  try {
    const h = createHash('sha256');
    for (const f of ['public/bf/betaflight.mjs', 'public/bf/betaflight.wasm']) h.update(readFileSync(f));
    return h.digest('hex').slice(0, 12);
  } catch { return 'dev'; }
})();

// SharedArrayBuffer requires cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation, port: 5173 },
  preview: { headers: isolation },
  define: { __FW_VERSION__: JSON.stringify(fwVersion) },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
