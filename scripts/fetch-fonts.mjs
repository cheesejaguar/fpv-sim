// Downloads Betaflight's MAX7456 OSD fonts (GPL-3.0, betaflight-configurator) into public/fonts.
import { mkdir, writeFile } from 'node:fs/promises';
const BASE = 'https://raw.githubusercontent.com/betaflight/betaflight-configurator/master/resources/osd/2/';
const FONTS = ['default', 'betaflight', 'bold', 'clarity', 'digital', 'impact', 'large', 'vision'];
await mkdir(new URL('../public/fonts/', import.meta.url), { recursive: true });
for (const f of FONTS) {
  const res = await fetch(`${BASE}${f}.mcm`);
  if (!res.ok) { console.warn(`skip ${f}: HTTP ${res.status}`); continue; }
  const txt = await res.text();
  if (!txt.startsWith('MAX7456')) { console.warn(`skip ${f}: not an MCM file`); continue; }
  await writeFile(new URL(`../public/fonts/${f}.mcm`, import.meta.url), txt);
  console.log(`fetched ${f}.mcm (${txt.length} bytes)`);
}
