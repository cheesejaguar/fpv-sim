import { defineConfig } from 'vite';

// SharedArrayBuffer requires cross-origin isolation.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation, port: 5173 },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
