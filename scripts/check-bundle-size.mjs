#!/usr/bin/env node
// Bundle-size budget (CI): the JavaScript a first visit downloads before the menu can open, i.e.
// the entry chunk plus every chunk dist/index.html modulepreloads, gzipped. Run after `npm run build`.
//   node scripts/check-bundle-size.mjs [--budget-kb 350]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const i = process.argv.indexOf('--budget-kb');
const budgetKb = i > 0 ? Number(process.argv[i + 1]) : 350;

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*src="\/([^"]+\.js)"/g), ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/([^"]+\.js)"/g)].map((m) => m[1]);
if (!scripts.length) { console.error('bundle size: no module scripts found in dist/index.html'); process.exit(1); }

let total = 0;
for (const s of scripts) {
  const gz = gzipSync(readFileSync(join(DIST, s)), { level: 9 }).length;
  total += gz;
  console.log(`${(gz / 1000).toFixed(1).padStart(8)} kB gzip  ${s}`);
}
console.log(`${(total / 1000).toFixed(1).padStart(8)} kB gzip  initial JavaScript (budget ${budgetKb} kB)`);
if (total > budgetKb * 1000) { console.error(`bundle size: initial JavaScript is over the ${budgetKb} kB gzip budget`); process.exit(1); }
