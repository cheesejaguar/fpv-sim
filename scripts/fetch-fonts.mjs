// Downloads Betaflight's MAX7456 OSD fonts (GPL-3.0, betaflight-configurator) into public/fonts.
// Pinned to a configurator commit and checked against the SHA-256 of the copies this repo ships, so a
// re-fetch can never silently change (or swap out) the fonts. To move to a newer commit, update
// COMMIT, run with --update to accept the new files, and review the diff.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const COMMIT = 'fac7d21d0746614fde43b580450bdbb3c932c2a2'; // betaflight-configurator, 2026-09-25
const BASE = `https://raw.githubusercontent.com/betaflight/betaflight-configurator/${COMMIT}/resources/osd/2/`;
const FONTS = {
  default: 'd3b122c5da7fe83fc10f70ee49817b9d4f4251fc2529146b8294424782b442f6',
  betaflight: '0f0efce4301c1670b9d62db97099a24de5494550b407b75ca66b40eda0a8fe6f',
  bold: 'fa2291ade88ef76912ae7f2bdf0eb23223b8d9c78b4b586501fe5ec779058614',
  clarity: '0aa7b52c948cec4c73cfb4fa46e066cfdcb2418b7e3bcfc2e498a60b9ba5644c',
  digital: '274a1ef294e3133615a6ff0555fa19d8de96d3f479777e15cd00c4c55c6d260d',
  impact: '5394b0052d1e2e7365e6b286cb1930101e9e0411fb36450adc8f409eefb51474',
  large: '4530b7415bb5890c40d27dce87fed5539a640533ebdb58ec2ac3559a8dc39cb8',
  vision: 'd22b4fc3607d8c238df0340af1ea0cad28bc0b9ab8929ef1a3aa0d0e938b04be',
};
const update = process.argv.includes('--update');

await mkdir(new URL('../public/fonts/', import.meta.url), { recursive: true });
let failed = false;
for (const [f, want] of Object.entries(FONTS)) {
  const res = await fetch(`${BASE}${f}.mcm`);
  if (!res.ok) { console.warn(`skip ${f}: HTTP ${res.status}`); failed = true; continue; }
  const txt = await res.text();
  if (!txt.startsWith('MAX7456')) { console.warn(`skip ${f}: not an MCM file`); failed = true; continue; }
  const got = createHash('sha256').update(txt).digest('hex');
  if (got !== want && !update) { console.warn(`skip ${f}: SHA-256 ${got} does not match the pinned ${want}`); failed = true; continue; }
  await writeFile(new URL(`../public/fonts/${f}.mcm`, import.meta.url), txt);
  console.log(`fetched ${f}.mcm (${txt.length} bytes)${got !== want ? ` NEW SHA-256 ${got}` : ''}`);
}
if (failed) process.exitCode = 1;
