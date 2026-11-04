#!/usr/bin/env node
// Builds the "Cascadia Coast" map package (public/maps/community/cascadia/) from open data: a
// 1.6 km square of the southern Oregon coast in the Samuel H. Boardman State Scenic Corridor, around
// Thomas Point and the Thomas Creek Bridge (US 101).
//
//   node scripts/build-cascadia-map.mjs [--cache DIR] [--offline]
//
// Sources (all fetched over HTTPS, cached in --cache, default node_modules/.cache/cascadia/):
//   - terrain: USGS 3D Elevation Program (3DEP) bare-earth DEM, from 1 m lidar (public domain),
//     resampled by the USGS image service into a local transverse Mercator grid centred on the map;
//   - ground drape and forest / rock classification: USDA NAIP aerial imagery, 0.6 m, 4 bands
//     (public domain), via the USGS National Map image service;
//   - coastline, sea stacks (mapped as islands), roads and the bridge's line: OpenStreetMap
//     (© OpenStreetMap contributors, ODbL 1.0). About 50 features: an insubstantial extract under
//     the OSMF's Substantial Guideline, credited in ATTRIBUTION.md (the package is CC-BY-4.0).
//
// What is derived here rather than measured:
//   - the sea floor: the lidar stops at the water, so under the sea the ground is made to shelve
//     away from the shore (about 3.5 cm per metre, down to 14 m);
//   - sea stacks the lidar dropped: their footprints are OSM's islands and the rock the photo
//     shows; their heights follow their size (taller for wider, 4..30 m), with steep sides;
//   - trees: placed on the forest the photo shows (NDVI and canopy darkness), about every 8.5 m,
//     tall Sitka spruce / Douglas fir inland (crowns over the top ~45 %), wind-stunted near the
//     cliffs (no canopy-height data);
//   - the bridge: a steel Warren deck truss on two steel towers, 291 m long with a 113 m main span,
//     on the line OSM maps, its deck at the road's height where the road meets each end.
//
// The script is deterministic for given downloads (seeded randomness only).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'public/maps/community/cascadia');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CACHE = arg('--cache', join(ROOT, 'node_modules/.cache/cascadia'));
const OFFLINE = process.argv.includes('--offline');

// ---- the area ----
const LAT0 = 42.17, LON0 = -124.3625;   // x = y = 0
const E = 800;                          // half extent (m): the heightfield covers 1600 m square
const N = 1025, D = (2 * E) / (N - 1);  // heightfield samples per side, spacing (1.5625 m)
const NAIP_N = 1024;                    // analysis image (same square, pixel edges on its border)
const DRAPE_N = 2048;                   // the drape (0.78 m per pixel)
const SIZE = 720;                       // playable half extent: the terrain mesh (2.2 x size) stays on the data
const WATER = 0.5;                      // sea level in the DEM's datum (NAVD88; mean sea level is ~1 m above 0 here, the lidar's water is ~0)
const Z_MIN = -15;

// WGS84 radii at LAT0 (the projection is a transverse Mercator on LON0, scale 1: within 1 km these are exact to cm)
const A = 6378137, E2 = 0.00669437999014, sl = Math.sin((LAT0 * Math.PI) / 180);
const R_M = (A * (1 - E2)) / Math.pow(1 - E2 * sl * sl, 1.5), R_N = A / Math.sqrt(1 - E2 * sl * sl);
const toXY = (lat, lon) => [((lon - LON0) * Math.PI) / 180 * R_N * Math.cos((LAT0 * Math.PI) / 180), ((lat - LAT0) * Math.PI) / 180 * R_M];

// ---------------------------------------------------------------------------------------------
// Downloads

const WKT = `PROJCS["local_tm",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${LON0}],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",${LAT0}],UNIT["Meter",1.0]]`;
const SR = JSON.stringify({ wkt: WKT });
const DEM_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const NAIP_URL = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
const OSM_URL = 'https://api.openstreetmap.org/api/0.6/map';

async function cached(name, url) {
  mkdirSync(CACHE, { recursive: true });
  const f = join(CACHE, name);
  if (existsSync(f)) return new Uint8Array(readFileSync(f));
  if (OFFLINE) throw new Error(`${name} is not cached (and --offline)`);
  console.log(`fetch ${name}`);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'fpv-sim map builder (scripts/build-cascadia-map.mjs)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = new Uint8Array(await res.arrayBuffer());
      writeFileSync(f, b);
      return b;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${name}: ${e.message} (${url.slice(0, 120)}...)`);
      await new Promise((r) => setTimeout(r, 2000 << attempt));
    }
  }
}
const exportUrl = (base, q) => `${base}?${new URLSearchParams({ bboxSR: SR, imageSR: SR, f: 'image', ...q })}`;

// ---------------------------------------------------------------------------------------------
// Raster helpers (row 0 = north, column 0 = west)

/** Pixel (i, j) of the heightfield -> local x, y (pixel centres on the extent's edges). */
const hx = (i) => -E + i * D, hy = (j) => E - j * D;

/** Bilinear sample of a w x w grid laid on the square with pixel centres at offset o (0: on the edges, 0.5: inset). */
function sampler(g, w, o) {
  const s = (w - 1 + 2 * o) / (2 * E);
  return (x, y) => {
    const u = Math.min(w - 1, Math.max(0, (x + E) * s - o)), v = Math.min(w - 1, Math.max(0, (E - y) * s - o));
    const i = Math.min(w - 2, Math.floor(u)), j = Math.min(w - 2, Math.floor(v)), fu = u - i, fv = v - j;
    const a = g[j * w + i], b = g[j * w + i + 1], c = g[(j + 1) * w + i], d = g[(j + 1) * w + i + 1];
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
  };
}

/** Even-odd scanline fill of polygons (local x, y) into an N x N mask of the heightfield grid. */
function fillPolygons(polys) {
  const m = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    const y = hy(j), xs = [];
    for (const p of polys) for (let k = 0; k < p.length; k++) {
      const [x1, y1] = p[k], [x2, y2] = p[(k + 1) % p.length];
      if ((y1 <= y) !== (y2 <= y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] + E) / D)), i1 = Math.min(N - 1, Math.floor((xs[k + 1] + E) / D));
      for (let i = i0; i <= i1; i++) m[j * N + i] = 1;
    }
  }
  return m;
}

/** Chamfer (3-4) distance in metres from every cell to the nearest cell where src is set. */
function distance(src) {
  const INF = 1e9, d = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) d[k] = src[k] ? 0 : INF;
  const a = D, b = D * Math.SQRT2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + a);
    if (j > 0) { v = Math.min(v, d[k - N] + a); if (i > 0) v = Math.min(v, d[k - N - 1] + b); if (i < N - 1) v = Math.min(v, d[k - N + 1] + b); }
    d[k] = v;
  }
  for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
    const k = j * N + i; let v = d[k];
    if (i < N - 1) v = Math.min(v, d[k + 1] + a);
    if (j < N - 1) { v = Math.min(v, d[k + N] + a); if (i < N - 1) v = Math.min(v, d[k + N + 1] + b); if (i > 0) v = Math.min(v, d[k + N - 1] + b); }
    d[k] = v;
  }
  return d;
}

/** Connected components (4-neighbour) of a mask: arrays of cell indices. */
function components(mask) {
  const seen = new Uint8Array(N * N), out = [];
  for (let s = 0; s < N * N; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp = [s]; seen[s] = 1;
    for (let q = 0; q < comp.length; q++) {
      const k = comp[q], i = k % N;
      for (const n of [i > 0 ? k - 1 : -1, i < N - 1 ? k + 1 : -1, k - N, k + N]) if (n >= 0 && n < N * N && mask[n] && !seen[n]) { seen[n] = 1; comp.push(n); }
    }
    out.push(comp);
  }
  return out;
}

/** Seeded random (mulberry32). */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

/** A 16-bit greyscale PNG (filter "up" on every row). */
function png16(w, h, values) {
  const raw = Buffer.alloc(h * (w * 2 + 1));
  const row = Buffer.alloc(w * 2), prev = Buffer.alloc(w * 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row.writeUInt16BE(values[y * w + x], x * 2);
    const o = y * (w * 2 + 1);
    raw[o] = 2;
    for (let k = 0; k < w * 2; k++) raw[o + 1 + k] = (row[k] - prev[k]) & 0xff;
    row.copy(prev);
  }
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 16; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Nodes and ways of an OSM API XML document. */
function parseOsm(xml) {
  const nodes = new Map(), ways = [];
  for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"/g)) nodes.set(m[1], [Number(m[2]), Number(m[3])]);
  for (const m of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
    const refs = [...m[2].matchAll(/<nd ref="(\d+)"/g)].map((r) => r[1]);
    const tags = Object.fromEntries([...m[2].matchAll(/<tag k="([^"]+)" v="([^"]*)"/g)].map((t) => [t[1], t[2]]));
    ways.push({ id: m[1], tags, pts: refs.map((r) => nodes.get(r)).filter(Boolean).map(([la, lo]) => toXY(la, lo)) });
  }
  return { nodes, ways };
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const half = D / 2;
  const [demB, naipB, drape, osmB] = await Promise.all([
    cached('dem.bsq', exportUrl(DEM_URL, { bbox: `${-E - half},${-E - half},${E + half},${E + half}`, size: `${N},${N}`, format: 'bsq', pixelType: 'F32', interpolation: 'RSP_BilinearInterpolation' })),
    cached('naip4.bsq', exportUrl(NAIP_URL, { bbox: `${-E},${-E},${E},${E}`, size: `${NAIP_N},${NAIP_N}`, format: 'bsq', pixelType: 'U8', bandIds: '0,1,2,3' })),
    cached('drape.jpg', exportUrl(NAIP_URL, { bbox: `${-E},${-E},${E},${E}`, size: `${DRAPE_N},${DRAPE_N}`, format: 'jpg', compressionQuality: '80', bandIds: '0,1,2' })),
    cached('osm.xml', `${OSM_URL}?bbox=-124.385,42.158,-124.340,42.182`),
  ]);
  const dem = new Float32Array(demB.buffer.slice(demB.byteOffset, demB.byteOffset + N * N * 4));
  const nb = (k) => naipB.subarray(k * NAIP_N * NAIP_N, (k + 1) * NAIP_N * NAIP_N);
  const [R, G, B, NIR] = [0, 1, 2, 3].map(nb);
  const osm = parseOsm(new TextDecoder().decode(osmB));
  for (let k = 0; k < N * N; k++) if (!(dem[k] > -100 && dem[k] < 3000)) dem[k] = 0; // no data: sea

  // photo classes, sampled at heightfield cells (nearest NAIP pixel)
  const naipAt = (i, j) => { const u = Math.min(NAIP_N - 1, Math.max(0, Math.round(((hx(i) + E) / (2 * E)) * NAIP_N - 0.5))), v = Math.min(NAIP_N - 1, Math.max(0, Math.round(((E - hy(j)) / (2 * E)) * NAIP_N - 0.5))); return v * NAIP_N + u; };
  const lumAt = (p) => (R[p] + G[p] + B[p]) / 3;
  const isRock = (p) => R[p] > B[p] + 4 && lumAt(p) < 120 && R[p] > G[p] - 12;
  const isSand = (p) => R[p] > B[p] + 8 && lumAt(p) >= 95;

  // ---- land and sea: OSM's coastline (land to its left) closed far to the east, and its islands ----
  const coast = osm.ways.filter((w) => w.tags.natural === 'coastline');
  const main = coast.reduce((a, b) => (b.pts.length > a.pts.length ? b : a));
  const mainPoly = [...main.pts, [5000, main.pts[main.pts.length - 1][1]], [5000, main.pts[0][1]]];
  const islands = coast.filter((w) => w !== main && w.pts.length > 3);
  const mainland = fillPolygons([mainPoly]), islandMask = fillPolygons(islands.map((w) => w.pts));
  const distMain = distance(mainland);

  // ---- sea stacks: OSM islands plus rock the photo shows offshore (not the beach), as one mask ----
  const stackMask = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (mainland[k]) continue;
    if (islandMask[k] || (distMain[k] > 25 && isRock(naipAt(i, j)))) stackMask[k] = 1;
  }
    // photographed rock counts as a stack when it is a compact blob (not a shard of wet sand along the surf)
  const compact = (c) => {
    let i0 = N, i1 = 0, j0 = N, j1 = 0;
    for (const k of c) { const i = k % N, j = Math.floor(k / N); i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
    const w = i1 - i0 + 1, h = j1 - j0 + 1;
    return c.length >= 10 && Math.max(w, h) / Math.min(w, h) < 2.5 && c.length > 0.4 * w * h;
  };
  const stacks = components(stackMask).filter((c) => c.some((k) => islandMask[k]) || compact(c));
  const stackCell = new Uint8Array(N * N);
  for (const c of stacks) for (const k of c) stackCell[k] = 1;
  const inStack = distance(stackCell.map((v) => 1 - v)); // inside a stack: distance to its edge
  const z = new Float32Array(N * N);
  // how sandy the photo is around each cell (11 m window): dry beach shelves gently, the rest drops away
  const sandy = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (mainland[k] || distMain[k] > 120) continue;
    let n = 0, c = 0;
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < N && jj < N) { n++; if (isSand(naipAt(ii, jj))) c++; } }
    sandy[k] = c / n;
  }
  const distLand = distance(Uint8Array.from(mainland, (v, k) => v || stackCell[k]));
  const rs = rng(7);
  // off the mainland: a beach shelving from 2.5 m at the coastline (gently where the photo shows
  // sand, so it stays dry), then the sea floor shelving to 14 m, with a little relief. (The lidar's
  // heights here are wave returns and wet-sand noise.)
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (mainland[k]) { z[k] = dem[k]; continue; }
    const rough = 0.6 * Math.sin(hx(i) * 0.031 + Math.sin(hy(j) * 0.017) * 2) + 0.4 * Math.sin(hy(j) * 0.043 - hx(i) * 0.011);
    const shelf = 2.5 - (0.12 - 0.095 * Math.min(1, sandy[k] * 1.6)) * distMain[k];
    const coastBlend = Math.min(1, distMain[k] / 8); // meet the lidar's ground at the coastline
    z[k] = Math.max(-14, -(1.2 + 0.035 * distLand[k]) + rough, shelf * coastBlend + Math.min(dem[k], 6) * (1 - coastBlend));
  }
  // stacks the lidar dropped get a height from their size; stacks it caught keep its heights
  const stackInfo = [];
  for (const c of stacks) {
    const area = c.length * D * D, r = Math.sqrt(area / Math.PI);
    const demMax = Math.max(...c.map((k) => dem[k]));
    const H = demMax > 8 ? demMax : Math.min(30, Math.max(4, 1.3 * r + 3 + rs() * 3));
    let cx = 0, cy = 0;
    for (const k of c) { cx += hx(k % N); cy += hy(Math.floor(k / N)); }
    cx /= c.length; cy /= c.length;
    for (const k of c) {
      if (demMax > 8 && dem[k] > 1) { z[k] = dem[k]; continue; } // (part of a stack can fall outside the lidar's coverage)
      // steep sides, a rounded top, gentle relief
      const x = hx(k % N), y = hy(Math.floor(k / N)), t = Math.min(1, inStack[k] / Math.max(D, 0.4 * r));
      const relief = 1 + 0.05 * Math.sin(x * 0.13 + y * 0.07 + H) + 0.04 * Math.sin(y * 0.17 - x * 0.09);
      z[k] = Math.max(z[k], H * (1 - Math.pow(1 - t, 3)) * relief);
    }
    stackInfo.push({ x: cx, y: cy, h: H, r, cells: c.length });
  }
  stackInfo.sort((a, b) => b.cells - a.cells);
  console.log(`land ${(mainland.reduce((s, v) => s + v, 0) * D * D / 1e6).toFixed(2)} km2, ${stacks.length} sea stacks (${islands.length} from OSM), largest ${stackInfo[0]?.r.toFixed(1)} m radius, ${stackInfo[0]?.h.toFixed(1)} m high`);

  let zTop = -Infinity; for (const v of z) if (v > zTop) zTop = v;
  const zMax = Math.ceil(zTop + 1);
  const terr = sampler(z, N, 0);
  const at = (x, y) => terr(x, y);

  // ---- the bridge ----
  const bw = osm.ways.find((w) => w.tags.bridge === 'yes' && /^(trunk|primary)$/.test(w.tags.highway ?? ''));
  if (!bw) throw new Error('OSM: the US 101 bridge over Thomas Creek is not in the data');
  const [pN, pS] = bw.pts[0][1] > bw.pts[bw.pts.length - 1][1] ? [bw.pts[0], bw.pts[bw.pts.length - 1]] : [bw.pts[bw.pts.length - 1], bw.pts[0]];
  const ax = pS[0] - pN[0], ay = pS[1] - pN[1], osmLen = Math.hypot(ax, ay), ux = ax / osmLen, uy = ay / osmLen;
  const LEN = 291.4, mid = [(pN[0] + pS[0]) / 2, (pN[1] + pS[1]) / 2];
  const b0 = [mid[0] - (ux * LEN) / 2, mid[1] - (uy * LEN) / 2], b1 = [mid[0] + (ux * LEN) / 2, mid[1] + (uy * LEN) / 2];
  // the deck meets the road: the ground just beyond each end (the median of a few samples)
  const groundBeyond = (p, dir) => { const v = [6, 9, 12, 15].map((s) => at(p[0] + dir * ux * s, p[1] + dir * uy * s)).sort((a, b) => a - b); return (v[1] + v[2]) / 2; };
  const deck0 = groundBeyond(b0, -1), deck1 = groundBeyond(b1, 1);
  const prims = [], bridge = bridgePrims(b0, b1, deck0, deck1, at, prims);
  console.log(`bridge: ${osmLen.toFixed(0)} m on OSM, drawn ${LEN} m, deck ${deck0.toFixed(1)} .. ${deck1.toFixed(1)} m, ${(bridge.deckAt(0.5) - Math.min(...[0.4, 0.5, 0.6].map((f) => at(b0[0] + ux * LEN * f, b0[1] + uy * LEN * f)))).toFixed(0)} m above the creek, ${prims.length} primitives`);

  // ---- spawns ----
  const tp = toXY(42.1692786, -124.3637136); // OSM: Thomas Point (natural=cliff)
  const best = (cx, cy, rad, score) => { let bp = null, bs = -Infinity; for (let y = cy - rad; y <= cy + rad; y += 1) for (let x = cx - rad; x <= cx + rad; x += 1) { const s = score(x, y); if (s > bs) { bs = s; bp = [x, y]; } } return bp; };
  const slope = (x, y) => Math.hypot(at(x + 1, y) - at(x - 1, y), at(x, y + 1) - at(x, y - 1)) / 2;
  // clifftop: the flat ground nearest a long drop to the west
  // (a spawn must be level enough to arm on: under ~5 degrees over the quad's footprint)
  const flat = (x, y) => Math.max(slope(x, y), slope(x + 1.5, y), slope(x - 1.5, y), slope(x, y + 1.5), slope(x, y - 1.5));
  const cliffScore = (x, y) => { const g = at(x, y); let drop = 0; for (const s of [15, 25, 35]) drop = Math.max(drop, g - at(x - s, y)); return drop - 60 * Math.max(0, flat(x, y) - 0.3) - 0.05 * Math.hypot(x - tp[0], y - tp[1]); };
  const point = best(tp[0], tp[1], 70, cliffScore);
  const north = bridge.along(-22, 7), beachPt = toXY(42.16545, -124.36165);
  const beachSpot = best(beachPt[0], beachPt[1], 30, (x, y) => (at(x, y) > WATER + 0.6 && at(x, y) < WATER + 4 ? 10 : -100) - 60 * Math.max(0, flat(x, y) - 0.2) - 0.05 * Math.hypot(x - beachPt[0], y - beachPt[1]));
  const st = stackInfo.filter((s) => s.h >= 10 && s.r > 6)[0] ?? stackInfo[0];
  const stackTop = best(st.x, st.y, Math.ceil(st.r), (x, y) => at(x, y) - 60 * Math.max(0, flat(x, y) - 0.4));
  const meadowPt = toXY(42.1694, -124.3621);
  const meadow = best(meadowPt[0], meadowPt[1], 40, (x, y) => -60 * Math.max(0, flat(x, y) - 0.1) + 0.1 * at(x, y) - 0.03 * Math.hypot(x - meadowPt[0], y - meadowPt[1]));
  // each spawn stands on a level 1.2 m launch pad set into the slope (the lidar ground is rarely level enough to arm on)
  const spawnAt = (p, yawDeg, id, name, pilot) => {
    const x = r1(p[0]), y = r1(p[1]);
    let top = -Infinity;
    for (const dx of [-0.6, 0, 0.6]) for (const dy of [-0.6, 0, 0.6]) top = Math.max(top, at(x + dx, y + dy));
    top = r2(top + 0.05);
    const low = Math.min(...[-0.6, 0.6].flatMap((dx) => [-0.6, 0.6].map((dy) => at(x + dx, y + dy)))), hgt = r2(top - low + 0.3);
    prims.push({ type: 'box', pos: [x, y, r2(top - hgt / 2)], size: [1.2, 1.2, hgt], material: 'wood', visual: 'pad', tag: 'pad' });
    return { id, name, pos: [x, y, r2(top + 0.25)], yawDeg, groundZ: top, ...(pilot && { pilot }) };
  };
  const brgYaw = (Math.atan2(uy, ux) * 180) / Math.PI;
  const spawns = [
    spawnAt(point, 180, 'point', 'Thomas Point clifftop: dive the stacks'),
    spawnAt(north, Math.round(brgYaw), 'bridge', 'Thomas Creek Bridge: north end'),
    spawnAt(beachSpot, Math.round(Math.atan2(bridge.along(LEN / 2, 0)[1] - beachSpot[1], bridge.along(LEN / 2, 0)[0] - beachSpot[0]) * 180 / Math.PI), 'beach', 'Thomas Creek beach: under the bridge'),
    spawnAt(stackTop, 0, 'stack', 'Sea stack summit'),
    spawnAt(meadow, 200, 'meadow', 'Headland meadow: plane launch'),
  ];
  for (const s of spawns) console.log(`spawn ${s.id.padEnd(7)} ${s.pos.join(', ')}  slope ${flat(s.pos[0], s.pos[1]).toFixed(2)}`);

  // ---- trees: on the photo's forest, kept off roads, the bridge, cliffs and spawns ----
  const ndviAt = (p) => (NIR[p] - R[p]) / (NIR[p] + R[p] + 1e-6);
  const forestAt = (x, y) => {
    // 7 x 7 photo pixels (11 m): mean NDVI and brightness of the canopy
    const u0 = Math.round(((x + E) / (2 * E)) * NAIP_N - 0.5), v0 = Math.round(((E - y) / (2 * E)) * NAIP_N - 0.5);
    let n = 0, s = 0, l = 0;
    for (let v = v0 - 3; v <= v0 + 3; v++) for (let u = u0 - 3; u <= u0 + 3; u++) {
      if (u < 0 || v < 0 || u >= NAIP_N || v >= NAIP_N) continue;
      const p = v * NAIP_N + u; s += ndviAt(p); l += lumAt(p); n++;
    }
    return n > 0 && s / n > 0.3 && l / n < 95;
  };
  const roads = osm.ways.filter((w) => w.tags.highway && !/^(path|footway|steps)$/.test(w.tags.highway)).map((w) => ({ pts: w.pts, clear: /^(trunk|primary|secondary)$/.test(w.tags.highway) ? 8 : 4 }));
  const segDist = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
  const nearRoad = (x, y) => roads.some((r) => r.pts.some((p, k) => k > 0 && segDist(x, y, r.pts[k - 1], p) < r.clear));
  const seaDist = sampler(Float32Array.from(distance(mainland.map((v) => 1 - v))), N, 0);
  const rt = rng(20261104), S = 9.5, trees = [];
  for (let y = -SIZE * 1.08; y <= SIZE * 1.08; y += S) for (let x = -SIZE * 1.08; x <= SIZE * 1.08; x += S) {
    const px = x + (rt() - 0.5) * S * 0.8, py = y + (rt() - 0.5) * S * 0.8, a = rt(), b = rt();
    const g = at(px, py), ds = seaDist(px, py);
    if (g < 3 || ds < 6 || slope(px, py) > 1.2 || !forestAt(px, py) || nearRoad(px, py)) continue;
    if (spawns.some((s) => Math.hypot(px - s.pos[0], py - s.pos[1]) < 16)) continue;
    // wind-stunted at the cliff edge, tall in the shelter inland
    const top = (14 + 28 * smooth(10, 200, ds)) * (0.85 + 0.3 * a) * (1 - 0.25 * smooth(0.6, 1.2, slope(px, py)));
    const rad = top * (0.17 + 0.06 * b), h = Math.min(60, (top - rad * 0.97) / 0.62);
    if (bridge.blocks(px, py, g + top + 2, rad + 2)) continue;
    trees.push({ pos: [r1(px), r1(py)], height: r1(h), radius: r1(rad), type: 'pine' });
  }
  console.log(`${trees.length} trees`);

  // ---- mission for ArduPilot planes: out over the stacks, up the coast, back over the bridge ----
  const mp = [[-150, -120, 90], [-330, 120, 90], [-280, 520, 100], [80, 640, 120], [300, 200, 170], [bridge.along(LEN / 2, 0)[0], bridge.along(LEN / 2, 0)[1], 175], [200, -650, 150], [-250, -500, 100]].map(([x, y, zz]) => [r1(x), r1(y), zz]);
  // every leg at least 60 m over the ground under it (trees reach ~45 m)
  for (let k = 0; k < mp.length; k++) {
    const p = mp[k], q = mp[(k + 1) % mp.length];
    let top = -Infinity;
    for (let t = 0; t <= 1; t += 0.01) top = Math.max(top, at(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t));
    p[2] = Math.max(p[2], Math.ceil(top + 60)); q[2] = Math.max(q[2], Math.ceil(top + 60));
  }

  // ---- write the package ----
  mkdirSync(OUT, { recursive: true });
  const q = new Uint16Array(N * N);
  for (let k = 0; k < N * N; k++) q[k] = Math.round(((Math.min(zMax, Math.max(Z_MIN, z[k])) - Z_MIN) / (zMax - Z_MIN)) * 65535);
  writeFileSync(join(OUT, 'heightfield.png'), png16(N, N, q));
  writeFileSync(join(OUT, 'drape.jpg'), drape);
  const doc = {
    $schema: '../../../../schemas/map.v1.schema.json',
    format: 'fpvsim-map', formatVersion: 1,
    meta: {
      id: 'cascadia', name: 'Cascadia Coast: Thomas Creek', author: 'fpv-sim contributors (data: USGS, USDA, OpenStreetMap contributors)', license: 'CC-BY-4.0', version: '1.0.0',
      description: 'The southern Oregon coast at Thomas Point, Samuel H. Boardman State Scenic Corridor: 1 m lidar terrain under a 0.8 m aerial photo, 60 m headland cliffs and sea stacks to dive, Sitka spruce forest, and the Thomas Creek Bridge (291 m long, 105 m over the creek) to fly under.',
      ...(existsSync(join(OUT, 'preview.jpg')) && { preview: 'preview.jpg' }),
      tags: ['freestyle', 'long-range', 'coast', 'real-world'],
      homepage: 'https://github.com/cheesejaguar/fpv-sim',
    },
    units: 'm', frame: 'ENU', size: SIZE, elevationM: 0,
    geo: { lat: LAT0, lon: LON0 },
    spawn: { pos: spawns[0].pos, yawDeg: spawns[0].yawDeg, groundZ: spawns[0].groundZ },
    environment: { sky: 'clear', sun: { azimuthDeg: 250, elevationDeg: 30 }, fog: { color: '#b9c8d2', density: 0.0011 }, wind: { speed: 6, directionDeg: 320, turbulence: 1.2, gusts: 3 } },
    ground: { type: 'heightfield', image: 'heightfield.png', extent: [2 * E, 2 * E], zMin: Z_MIN, zMax, material: 'dirt', drape: { image: 'drape.jpg', detail: 0.55 } },
    water: { level: WATER, color: '#0d3a45' },
    spawns,
    primitives: prims,
    trees,
    paths: [{ id: 'coast-tour', points: mp, speedMs: 16, mode: 'loop' }],
    mission: { path: 'coast-tour', end: 'rtl', takeoffAltM: 40, speedMs: 16 },
  };
  // one primitive / tree per line keeps the file diffable
  const json = JSON.stringify(doc, null, 2).replace(/\{\s+"(type|pos)":[^{}]*?\}/g, (m) => m.replace(/\s*\n\s*/g, ' ')).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)(?:,\s+(-?[\d.]+))?\s+\]/g, (_, a, b, c) => `[${a}, ${b}${c !== undefined ? `, ${c}` : ''}]`);
  writeFileSync(join(OUT, 'map.json'), json + '\n');
  writeFileSync(join(OUT, 'ATTRIBUTION.md'), attribution(stacks.length, islands.length, trees.length, coast.length + roads.length + 1));
  console.log(`wrote ${OUT}: map.json ${(json.length / 1024).toFixed(0)} KiB, drape ${(drape.length / 1024).toFixed(0)} KiB, zMax ${zMax} m`);
}

// ---------------------------------------------------------------------------------------------
// Thomas Creek Bridge (1961): a steel Warren deck truss with verticals, 291 m (956 ft) long and
// 9.1 m (30 ft) wide, 105 m (345 ft) above the creek; main span 113 m (371 ft) between two steel
// towers, so the side spans are 89 m. The truss is drawn 7 m deep in 11.2 m panels, the towers as
// four battered legs with struts and X-bracing every ~16 m, on concrete footings.

function bridgePrims(b0, b1, z0, z1, ground, out) {
  const L = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]), ux = (b1[0] - b0[0]) / L, uy = (b1[1] - b0[1]) / L, vx = -uy, vy = ux;
  const yaw = Math.atan2(uy, ux), deg = 180 / Math.PI;
  const along = (s, off) => [b0[0] + ux * s + vx * off, b0[1] + uy * s + vy * off];
  const deckAt = (f) => z0 + (z1 - z0) * f;
  const STEEL = '#7d8a84', CONC = '#a7a49b', TRUSS_D = 7, HALF_W = 4.55, PLANE = 3.6;
  const P = (v) => [r2(v[0]), r2(v[1]), r2(v[2])];
  const box = (c, size, yawR, pitchR, material, color, visual, tag = 'bridge') => out.push({ type: 'box', pos: P(c), size: size.map(r2), yawDeg: r2(yawR * deg), ...(pitchR ? { pitchDeg: r2(pitchR * deg) } : {}), material, color, ...(visual && { visual }), tag });
  /** A member from a to b ([x, y, z]), square section t. */
  const member = (a, b, t, material = 'metal', color = STEEL) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], hl = Math.hypot(dx, dy), len = Math.hypot(hl, dz);
    const yw = hl < 1e-6 ? yaw : Math.atan2(dy, dx), pitch = -Math.atan2(dz, hl);
    box([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], [len, t, t], yw, pitch, material, color, 'metal');
  };
  const PANELS = 26, pl = L / PANELS, grade = Math.atan2(z1 - z0, L);
  // deck, kerbs and rails, one piece per panel (keeps each in a few collision cells)
  for (let k = 0; k < PANELS; k++) {
    const s = (k + 0.5) * pl, f = s / L, zt = deckAt(f), c = along(s, 0);
    box([c[0], c[1], zt - 0.3], [pl + 0.02, 2 * HALF_W, 0.6], yaw, -grade, 'concrete', '#55534f', 'concrete');
    for (const side of [-1, 1]) {
      const r = along(s, side * (HALF_W - 0.2));
      box([r[0], r[1], zt + 0.45], [pl + 0.02, 0.35, 0.9], yaw, -grade, 'concrete', CONC, 'concrete');
    }
  }
  // the two truss planes
  for (const side of [-1, 1]) for (let k = 0; k <= PANELS; k++) {
    const s = k * pl, f = s / L, top = deckAt(f) - 0.7, bot = top - TRUSS_D, p = along(s, side * PLANE);
    if (k < PANELS) {
      const s2 = (k + 1) * pl, f2 = s2 / L, top2 = deckAt(f2) - 0.7, q = along(s2, side * PLANE);
      member([p[0], p[1], top], [q[0], q[1], top2], 0.7);          // top chord
      member([p[0], p[1], bot], [q[0], q[1], top2 - TRUSS_D], 0.8); // bottom chord
      // Warren diagonals, alternating
      if (k % 2 === 0) member([p[0], p[1], bot], [q[0], q[1], top2], 0.45);
      else member([p[0], p[1], top], [q[0], q[1], top2 - TRUSS_D], 0.45);
    }
    member([p[0], p[1], bot], [p[0], p[1], top], 0.4);             // vertical
  }
  // lateral bracing between the bottom chords
  for (let k = 0; k < PANELS; k++) {
    const s = k * pl, s2 = s + pl, a = along(s, -PLANE), b = along(s2, PLANE);
    member([a[0], a[1], deckAt(s / L) - 0.7 - TRUSS_D], [b[0], b[1], deckAt(s2 / L) - 0.7 - TRUSS_D], 0.3);
  }
  // towers at the ends of the main span
  const towerS = [(L - 113) / 2, (L + 113) / 2];
  for (const ts of towerS) {
    const topZ = deckAt(ts / L) - 0.7 - TRUSS_D;
    const legs = [];
    for (const lo of [-1, 1]) for (const tr of [-1, 1]) {
      const topP = along(ts + lo * 4, tr * PLANE);
      // battered: the foot spreads 1 m per 10 m of height, outwards both ways
      let foot = along(ts + lo * 4, tr * PLANE), gz = ground(foot[0], foot[1]);
      for (let it = 0; it < 3; it++) { const sp = 0.1 * (topZ - gz); foot = along(ts + lo * (4 + sp * 0.6), tr * (PLANE + sp)); gz = ground(foot[0], foot[1]); }
      legs.push({ top: [topP[0], topP[1], topZ], foot: [foot[0], foot[1], gz - 1], lo, tr });
      box([foot[0], foot[1], gz + 0.5], [4, 4, 3], yaw, 0, 'concrete', CONC, 'concrete', 'bridge-footing');
    }
    for (const l of legs) member(l.foot, l.top, 1.0);
    const lowZ = Math.max(...legs.map((l) => l.foot[2])) + 2;
    const levels = Math.max(1, Math.round((topZ - lowZ) / 16));
    const legAt = (l, zz) => { const t = (zz - l.foot[2]) / (l.top[2] - l.foot[2]); return [l.foot[0] + (l.top[0] - l.foot[0]) * t, l.foot[1] + (l.top[1] - l.foot[1]) * t, zz]; };
    const faces = [[0, 1], [2, 3], [0, 2], [1, 3]]; // legs: (lo, tr) = (-,-), (-,+), (+,-), (+,+)
    for (let lv = 0; lv <= levels; lv++) {
      const zz = lowZ + ((topZ - lowZ) * lv) / levels;
      for (const [a, b] of faces) {
        const la = legs[a], lb = legs[b];
        if (zz < Math.max(la.foot[2], lb.foot[2]) + 1) continue;
        member(legAt(la, zz), legAt(lb, zz), 0.45); // strut
        if (lv < levels) {
          const z2 = lowZ + ((topZ - lowZ) * (lv + 1)) / levels;
          member(legAt(la, zz), legAt(lb, z2), 0.3);
          member(legAt(lb, zz), legAt(la, z2), 0.3);
        }
      }
    }
  }
  // abutments
  for (const [s, zz] of [[0, z0], [L, z1]]) {
    const c = along(s, 0);
    box([c[0], c[1], zz - 5], [6, 2 * HALF_W + 2, 10], yaw, 0, 'concrete', CONC, 'concrete', 'bridge-abutment');
  }
  return {
    deckAt,
    /** A point s m along the deck (from the north end), off m to its left. */
    along: (s, off) => along(s, off),
    /** Whether something at (x, y) reaching up to top (m) with radius r would cut into the bridge. */
    blocks(x, y, top, r) {
      const dx = x - b0[0], dy = y - b0[1], s = dx * ux + dy * uy, o = Math.abs(dx * vx + dy * vy);
      if (s < -r || s > L + r || o > HALF_W + 12 + r) return false;
      const f = Math.max(0, Math.min(1, s / L));
      return top > deckAt(f) - 0.7 - TRUSS_D - 3 || towerS.some((ts) => Math.abs(s - ts) < 16 + r);
    },
  };
}

function attribution(nStacks, nIslands, nTrees, nOsm) {
  return `# Cascadia Coast: Thomas Creek (map "cascadia")

A 1.6 km square of the southern Oregon coast in the Samuel H. Boardman State Scenic Corridor,
Curry County, Oregon, USA, centred on 42.1700 N, 124.3625 W: Thomas Point, its sea stacks and the
Thomas Creek Bridge on US 101. Built by \`scripts/build-cascadia-map.mjs\` (run it again to rebuild;
the downloads are cached).

## Data and licences

The package is licensed under **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/):
credit "fpv-sim contributors; USGS 3DEP; USDA NAIP; © OpenStreetMap contributors". The USGS and
USDA data are in the US public domain. The OpenStreetMap data (${nOsm} features: the coastline,
the islands, roads and the bridge's line) is © OpenStreetMap contributors under the ODbL 1.0; it
is an insubstantial extract under the OpenStreetMap Foundation's Substantial Guideline
(https://osmfoundation.org/wiki/Licence/Community_Guidelines/Substantial_-_Guideline), used here
to make this map (a Produced Work), and is credited as the ODbL asks.

| Data | Used for | Source | Licence |
|---|---|---|---|
| \`heightfield.png\` | terrain | USGS 3D Elevation Program (3DEP) bare-earth DEM from 1 m lidar, via the USGS National Map elevation service | public domain (US Government work) |
| \`drape.jpg\`, forest and rock classification | ground photo, where trees and rocks are | USDA Farm Service Agency, National Agriculture Imagery Program (NAIP), 0.6 m 4-band, via the USGS National Map imagery service | public domain (US Government work) |
| coastline, ${nIslands} mapped sea stacks, roads, the bridge's line | land and sea, stack footprints, keeping trees off roads, placing the bridge | © OpenStreetMap contributors, https://www.openstreetmap.org/copyright | ODbL 1.0 (insubstantial extract, credited) |

The map layout, the bridge model, the sea floor, the derived stack heights and the tree placement
are by the fpv-sim contributors.

## What is real and what is modelled

- **Real:** the land's shape (1 m lidar, sampled every 1.56 m), the coastline, the photo, where
  the forest grows, the bridge's position, length, height and spans.
- **Modelled:** the sea floor (the lidar stops at the water; here the bottom shelves about 3.5 cm
  per metre from the shore, to 14 m). Sea stacks the lidar did not keep (${nStacks} stacks in all)
  are raised from their mapped or photographed footprint, 4 to 30 m high by size. The ${nTrees}
  trees are procedural conifers on the photo's forest, taller inland (to ~42 m) and wind-stunted
  at the cliffs; their heights are not measured. The bridge is a simplified steel Warren deck truss
  on two towers: its member sizes, panel length and tower layout are approximations.
- The water level is 0.5 m above the lidar's datum (NAVD88). Heights in the map are metres above
  that datum.

Not affiliated with or endorsed by the USGS, the USDA, Oregon Parks and Recreation or the
OpenStreetMap Foundation. Respect local rules if you fly the real place: Oregon State Parks
restricts drone take-off and landing in many parks.
`;
}

main().catch((e) => { console.error(e); process.exit(1); });
