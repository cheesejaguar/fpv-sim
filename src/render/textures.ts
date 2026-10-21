// Procedural surface textures (canvas-generated so the project ships no binary art).
import * as THREE from 'three';
import { seededRandom } from '../maps/world';

function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, s: number, rnd: () => number) => void, seed: number, repeat = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size, seededRandom(seed));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function speckle(ctx: CanvasRenderingContext2D, s: number, rnd: () => number, n: number, colors: string[], rmax: number) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
    const r = rnd() * rmax + 0.5;
    ctx.fillRect(rnd() * s, rnd() * s, r, r * (0.5 + rnd() * 2));
  }
}

export function grassTexture() {
  return canvasTex(512, (ctx, s, rnd) => {
    ctx.fillStyle = '#4f6b2c'; ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, rnd, 26000, ['#5b7a32', '#456127', '#6b8a3a', '#3d5522', '#7a8f45', '#556e2e'], 2.2);
    for (let i = 0; i < 1800; i++) { ctx.strokeStyle = rnd() < 0.5 ? '#6f9440' : '#3f5a24'; ctx.beginPath(); const x = rnd() * s, y = rnd() * s; ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 3, y - 2 - rnd() * 5); ctx.stroke(); }
  }, 11, 1);
}
export function dirtTexture() {
  return canvasTex(512, (ctx, s, rnd) => {
    ctx.fillStyle = '#6e604c'; ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, rnd, 30000, ['#7a6a52', '#5e5241', '#857559', '#4f4536', '#8f8a7e', '#6a6a5e'], 2.5);
    for (let i = 0; i < 200; i++) { ctx.fillStyle = `rgba(60,70,40,${0.2 + rnd() * 0.3})`; ctx.beginPath(); ctx.arc(rnd() * s, rnd() * s, 2 + rnd() * 10, 0, 7); ctx.fill(); }
  }, 12, 1);
}
export function concreteTexture() {
  return canvasTex(512, (ctx, s, rnd) => {
    ctx.fillStyle = '#8d8a84'; ctx.fillRect(0, 0, s, s);
    speckle(ctx, s, rnd, 22000, ['#99968f', '#827f79', '#77746f', '#a3a09a', '#6d6a65'], 1.6);
    for (let i = 0; i < 40; i++) { ctx.fillStyle = `rgba(40,38,35,${rnd() * 0.18})`; ctx.fillRect(rnd() * s, rnd() * s, 10 + rnd() * 80, 4 + rnd() * 60); }
    ctx.strokeStyle = 'rgba(30,30,30,0.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) { ctx.beginPath(); let x = rnd() * s, y = rnd() * s; ctx.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (rnd() - 0.5) * 30; y += (rnd() - 0.3) * 20; ctx.lineTo(x, y); } ctx.stroke(); }
    // graffiti tags
    const tags = ['#d43f3f', '#3f7fd4', '#e0c341', '#47b35a'];
    for (let i = 0; i < 3; i++) { ctx.strokeStyle = tags[i]; ctx.lineWidth = 4; ctx.beginPath(); let x = rnd() * s, y = 200 + rnd() * 200; ctx.moveTo(x, y); for (let k = 0; k < 10; k++) { x += rnd() * 20; y += (rnd() - 0.5) * 40; ctx.lineTo(x, y); } ctx.stroke(); }
  }, 13, 1);
}
export function brickTexture() {
  return canvasTex(512, (ctx, s, rnd) => {
    ctx.fillStyle = '#7a7268'; ctx.fillRect(0, 0, s, s);
    const bw = 64, bh = 24;
    for (let y = 0; y < s; y += bh) for (let x = -((y / bh) % 2) * bw / 2; x < s; x += bw) {
      const r = 120 + rnd() * 40, g = 55 + rnd() * 25, b = 40 + rnd() * 20;
      ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x + 2, y + 2, bw - 4, bh - 4);
    }
    speckle(ctx, s, rnd, 8000, ['rgba(0,0,0,0.15)', 'rgba(255,255,255,0.08)'], 2);
  }, 14, 1);
}
export function metalTexture() {
  return canvasTex(256, (ctx, s, rnd) => {
    ctx.fillStyle = '#7d8388'; ctx.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 16) { ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x, 0, 3, s); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x + 3, 0, 2, s); }
    for (let i = 0; i < 60; i++) { ctx.fillStyle = `rgba(120,60,30,${rnd() * 0.35})`; ctx.beginPath(); ctx.arc(rnd() * s, rnd() * s, 2 + rnd() * 14, 0, 7); ctx.fill(); }
  }, 15, 1);
}
export function woodTexture() {
  return canvasTex(256, (ctx, s, rnd) => {
    ctx.fillStyle = '#9a7a52'; ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 2) { ctx.fillStyle = `rgba(70,45,20,${rnd() * 0.25})`; ctx.fillRect(0, y, s, 1); }
  }, 16, 1);
}
export function padTexture() {
  return canvasTex(256, (ctx, s) => {
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = '#f5f5f5'; ctx.lineWidth = 10; ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.38, 0, 7); ctx.stroke();
    ctx.fillStyle = '#f5f5f5'; ctx.font = 'bold 120px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('H', s / 2, s / 2 + 6);
  }, 17, 1);
}
export function gateTexture(color: string) {
  return canvasTex(128, (ctx, s) => {
    ctx.fillStyle = color; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(0,0,0,0.85)'; for (let i = 0; i < 4; i++) ctx.fillRect(0, i * 32 + 12, s, 6);
  }, 18, 1);
}
/** Safety net: transparent mesh of light cord (10 cm cells at the 0.8 m world-UV texel used for it). */
export function netTexture() {
  return canvasTex(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(235,235,235,0.9)'; ctx.lineWidth = 2;
    for (let i = 0; i < s; i += 16) { ctx.beginPath(); ctx.moveTo(i + 1, 0); ctx.lineTo(i + 1, s); ctx.moveTo(0, i + 1); ctx.lineTo(s, i + 1); ctx.stroke(); }
  }, 19, 1);
}
// ---------------------------------------------------------------------------------------------
// Foliage

/**
 * Foliage atlas cells in canvas pixels of the 512² atlas (x, y, w, h; y down). Near trees use the
 * oak leaf cluster / pine needle spray cards, far stand-ins the dense crown silhouettes; the bark
 * cell is opaque (its long axis runs along a trunk), so a whole tree is one material, one draw.
 */
export const ATLAS_SIZE = 512;
export const ATLAS = {
  oak: [0, 0, 256, 256], needles: [256, 0, 256, 256], farOak: [0, 256, 256, 256], farPine: [256, 256, 256, 160], bark: [256, 416, 256, 96],
} as const;
export type AtlasCell = keyof typeof ATLAS;
/** UV rectangle (u0, v0, du, dv) of an atlas cell (CanvasTexture flips y: v up). */
export function atlasUV(cell: AtlasCell): [number, number, number, number] {
  const [x, y, w, h] = ATLAS[cell], S = ATLAS_SIZE;
  return [x / S, 1 - (y + h) / S, w / S, h / S];
}

function leafShape(ctx: CanvasRenderingContext2D, x: number, y: number, len: number, w: number, ang: number, fill: string, vein: string | null) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  ctx.fillStyle = fill; ctx.beginPath();
  // lobed almond: a little wave along the edges reads as an oak leaf at card scale
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(w * 0.9, len * 0.15, w * 1.15, len * 0.55, 0, len);
  ctx.bezierCurveTo(-w * 1.15, len * 0.55, -w * 0.9, len * 0.15, 0, 0);
  ctx.fill();
  if (vein) { ctx.strokeStyle = vein; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, 1); ctx.lineTo(0, len * 0.85); ctx.stroke(); }
  ctx.restore();
}
const shade = (rgb: number[], k: number) => `rgb(${Math.min(255, rgb[0] * k) | 0},${Math.min(255, rgb[1] * k) | 0},${Math.min(255, rgb[2] * k) | 0})`;

export function foliageAtlas() {
  return canvasTex(ATLAS_SIZE, (ctx, S, rnd) => {
    ctx.clearRect(0, 0, S, S);
    const oakCols = [[63, 107, 42], [77, 122, 49], [90, 138, 58], [53, 92, 36], [104, 150, 66]];
    // --- oak leaf cluster: a forked twig carrying ~30 leaves, back leaves darker ---
    {
      const [x0, y0] = ATLAS.oak;
      ctx.strokeStyle = '#4a3a2a'; ctx.lineCap = 'round';
      const tw: [number, number, number, number][] = [[128, 252, 128, 140], [128, 190, 70, 120], [128, 170, 190, 105], [128, 140, 110, 60], [128, 140, 160, 70]];
      for (const [a, b, c, d] of tw) { ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x0 + a, y0 + b); ctx.lineTo(x0 + c, y0 + d); ctx.stroke(); }
      for (let i = 0; i < 34; i++) {
        const back = i < 14, t = tw[1 + (i % 4)], f = 0.35 + rnd() * 0.75;
        const px = x0 + t[0] + (t[2] - t[0]) * f + (rnd() - 0.5) * 30, py = y0 + t[1] + (t[3] - t[1]) * f + (rnd() - 0.5) * 30;
        const ang = Math.atan2(px - (x0 + 128), (y0 + 150) - py) + Math.PI + (rnd() - 0.5) * 1.2;
        const c = oakCols[Math.floor(rnd() * oakCols.length)], k = back ? 0.7 + rnd() * 0.15 : 0.9 + rnd() * 0.25;
        leafShape(ctx, px, py, 34 + rnd() * 18, 11 + rnd() * 6, ang, shade(c, k), back ? null : shade(c, k * 0.75));
      }
    }
    // --- pine needle spray: three twigs with needles at ±55° ---
    {
      const [x0, y0] = ATLAS.needles;
      for (const [ax, ay, bx, by] of [[30, 230, 225, 35], [60, 245, 150, 120], [120, 230, 240, 150]]) {
        ctx.strokeStyle = '#3e3022'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x0 + ax, y0 + ay); ctx.lineTo(x0 + bx, y0 + by); ctx.stroke();
        const L = Math.hypot(bx - ax, by - ay), dx = (bx - ax) / L, dy = (by - ay) / L;
        for (let s = 6; s < L; s += 3.2) for (const side of [-1, 1]) {
          const a = side * (0.85 + rnd() * 0.35), nl = 20 + rnd() * 14 - (s / L) * 8;
          const ex = dx * Math.cos(a) - dy * Math.sin(a), ey = dx * Math.sin(a) + dy * Math.cos(a);
          const g = 52 + rnd() * 40;
          ctx.strokeStyle = `rgb(${(g * 0.45) | 0},${g | 0},${(g * 0.55) | 0})`; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x0 + ax + dx * s, y0 + ay + dy * s); ctx.lineTo(x0 + ax + dx * s + ex * nl, y0 + ay + dy * s + ey * nl); ctx.stroke();
        }
      }
    }
    // --- dense oak crown (far stand-in): many small leaves in a ragged disc with holes, shaded below ---
    {
      const [x0, y0] = ATLAS.farOak, cx = x0 + 128, cy = y0 + 128;
      const holes = Array.from({ length: 6 }, () => [cx + (rnd() - 0.5) * 150, cy + (rnd() - 0.5) * 150, 9 + rnd() * 10]);
      for (let i = 0; i < 900; i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * (108 + 10 * Math.sin(a * 5) + 6 * Math.sin(a * 9 + 1));
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.95;
        if (holes.some(([hx, hy, hr]) => Math.hypot(px - hx, py - hy) < hr)) continue;
        const c = oakCols[Math.floor(rnd() * oakCols.length)], k = (1.05 - 0.45 * (py - (cy - 110)) / 220) * (0.85 + rnd() * 0.3);
        leafShape(ctx, px, py, 11 + rnd() * 8, 4 + rnd() * 3, rnd() * 6.3, shade(c, k), null);
      }
    }
    // --- conifer crown (far stand-in): stacked jagged tiers of needle strokes, apex at the top ---
    {
      const [x0, y0, w, h] = ATLAS.farPine, cx = x0 + w / 2;
      for (let i = 0; i < 2600; i++) {
        const v = rnd(), y = y0 + 6 + v * (h - 8); // v: 0 top .. 1 bottom
        const tier = (v * 7) % 1, half = (w / 2 - 6) * Math.pow(v, 0.9) * (0.55 + 0.45 * tier);
        const x = cx + (rnd() * 2 - 1) * half;
        const g = (40 + rnd() * 36) * (1.05 - 0.35 * Math.abs(x - cx) / (w / 2)) * (0.8 + 0.3 * (1 - tier));
        ctx.strokeStyle = `rgb(${(g * 0.45) | 0},${g | 0},${(g * 0.6) | 0})`; ctx.lineWidth = 2;
        const a = (x < cx ? Math.PI : 0) + (rnd() - 0.5) * 1.4 + 0.5;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 6); ctx.stroke();
      }
    }
    // --- bark (opaque): furrows along x (= along the trunk), lichen and grime ---
    {
      const [x0, y0, w, h] = ATLAS.bark;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
      ctx.fillStyle = '#5b4a3a'; ctx.fillRect(x0, y0, w, h);
      for (let i = 0; i < 170; i++) {
        ctx.strokeStyle = rnd() < 0.55 ? `rgba(28,20,13,${0.35 + rnd() * 0.4})` : `rgba(140,120,95,${0.15 + rnd() * 0.25})`;
        ctx.lineWidth = 1 + rnd() * 2.5; ctx.beginPath(); let x = x0 + rnd() * w, y = y0 + rnd() * h; ctx.moveTo(x, y);
        for (let k = 0; k < 5; k++) { x += 8 + rnd() * 18; y += (rnd() - 0.5) * 5; ctx.lineTo(x, y); }
        ctx.stroke();
      }
      for (let i = 0; i < 1500; i++) { ctx.fillStyle = rnd() < 0.5 ? 'rgba(90,110,60,0.35)' : 'rgba(20,15,10,0.3)'; ctx.fillRect(x0 + rnd() * w, y0 + rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2); }
      ctx.restore();
    }
  }, 21, 1);
}

/** Grass tuft card: blades rising from the bottom edge (alpha). */
export function grassTuftTexture() {
  return canvasTex(128, (ctx, s, rnd) => {
    ctx.clearRect(0, 0, s, s);
    for (let i = 0; i < 34; i++) {
      const x = 14 + rnd() * (s - 28), h = 50 + rnd() * 74, lean = (rnd() - 0.5) * 40, w = 2.5 + rnd() * 3;
      const g = 85 + rnd() * 60, yellow = rnd() < 0.2;
      ctx.fillStyle = yellow ? `rgb(${(g * 1.05) | 0},${(g * 0.95) | 0},${(g * 0.45) | 0})` : `rgb(${(g * 0.55) | 0},${g | 0},${(g * 0.35) | 0})`;
      ctx.beginPath(); ctx.moveTo(x - w, s); ctx.quadraticCurveTo(x + lean * 0.3, s - h * 0.6, x + lean, s - h); ctx.quadraticCurveTo(x + lean * 0.3 + w * 0.3, s - h * 0.6, x + w, s); ctx.fill();
    }
  }, 23, 1);
}

/**
 * Stadium pitch paint (football layout, FIFA dimensions) with mowing stripes, on a w x h metre
 * area centred on the pitch: lines are white with alpha, stripes a faint light / dark overlay.
 */
export function pitchTexture(areaW: number, areaH: number) {
  const pxm = 16, W = Math.min(2048, Math.round(areaW * pxm)), H = Math.min(2048, Math.round(areaH * pxm));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const sx = W / areaW, sy = H / areaH, X = (m: number) => W / 2 + m * sx, Y = (m: number) => H / 2 - m * sy;
  // mowing stripes across the long axis, 5.25 m wide (the 105 m pitch in 20 bands)
  for (let i = -12; i < 12; i++) { ctx.fillStyle = i % 2 ? 'rgba(255,255,230,0.07)' : 'rgba(0,10,0,0.07)'; ctx.fillRect(X(i * 5.25), 0, 5.25 * sx + 1, H); }
  ctx.strokeStyle = 'rgba(245,245,240,0.92)'; ctx.fillStyle = 'rgba(245,245,240,0.92)'; ctx.lineWidth = 0.12 * sx;
  const L = 52.5, Wd = 34;
  const rect = (x0: number, y0: number, x1: number, y1: number) => ctx.strokeRect(X(x0), Y(y1), (x1 - x0) * sx, (y1 - y0) * sy);
  const arc = (x: number, y: number, r: number, a0: number, a1: number) => { ctx.beginPath(); ctx.ellipse(X(x), Y(y), r * sx, r * sy, 0, a0, a1); ctx.stroke(); };
  const spot = (x: number, y: number) => { ctx.beginPath(); ctx.ellipse(X(x), Y(y), 0.2 * sx, 0.2 * sy, 0, 0, 7); ctx.fill(); };
  rect(-L, -Wd, L, Wd);
  ctx.beginPath(); ctx.moveTo(X(0), Y(Wd)); ctx.lineTo(X(0), Y(-Wd)); ctx.stroke();
  arc(0, 0, 9.15, 0, Math.PI * 2); spot(0, 0);
  for (const s of [-1, 1]) {
    rect(s < 0 ? -L : L - 16.5, -20.16, s < 0 ? -L + 16.5 : L, 20.16);
    rect(s < 0 ? -L : L - 5.5, -9.16, s < 0 ? -L + 5.5 : L, 9.16);
    spot(s * (L - 11), 0);
    // penalty arc: the part of the 9.15 m circle round the spot outside the area
    const a = Math.acos(5.5 / 9.15);
    if (s < 0) arc(-L + 11, 0, 9.15, -a, a); else arc(L - 11, 0, 9.15, Math.PI - a, Math.PI + a);
    for (const t of [-1, 1]) arc(s * L, t * Wd, 1, 0, Math.PI * 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

/**
 * Tiling large-scale variation (no canvas, so it builds in tests too): R = brightness, G = dry /
 * lush tint, from periodic value noise. Sampled every ~60 m and ~23 m under the detail texture.
 */
export function macroNoiseTexture(size = 128) {
  const rnd = seededRandom(31), data = new Uint8Array(size * size * 4);
  const grids = [4, 8, 16, 32].map((n) => ({ n, v: Float32Array.from({ length: n * n * 2 }, () => rnd()) }));
  const sm = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = [0, 0];
    let amp = 0.55;
    for (const { n, v } of grids) {
      const fx = (x / size) * n, fy = (y / size) * n, ix = Math.floor(fx), iy = Math.floor(fy), u = sm(fx - ix), w = sm(fy - iy);
      for (let ch = 0; ch < 2; ch++) {
        const g = (i: number, j: number) => v[((((j % n) + n) % n) * n + (((i % n) + n) % n)) * 2 + ch];
        const a = g(ix, iy), b = g(ix + 1, iy), c = g(ix, iy + 1), d = g(ix + 1, iy + 1);
        o[ch] += amp * (a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w - 0.5);
      }
      amp *= 0.5;
    }
    const i = (y * size + x) * 4;
    data[i] = Math.max(0, Math.min(255, 128 + o[0] * 260)); data[i + 1] = Math.max(0, Math.min(255, 128 + o[1] * 300)); data[i + 2] = 128; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Printed advertising board / video screen: '|' separates lines. Width:height follows the board. */
export function textTexture(text: string, bg: number, aspect: number, screen: boolean) {
  const w = 1024, h = Math.max(64, Math.min(1024, Math.round(w / Math.max(aspect, 0.25))));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const hex = '#' + bg.toString(16).padStart(6, '0');
  ctx.fillStyle = hex; ctx.fillRect(0, 0, w, h);
  const lines = text.split('|');
  if (screen) {
    // LED video wall: glowing frame and scanlines behind bright text
    const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#0d2a5c'); g.addColorStop(1, '#3a0d4f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#38e1ff'; ctx.lineWidth = Math.max(4, h * 0.03); ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(0, 0, w, h * 0.12); ctx.fillRect(0, h * 0.88, w, h * 0.12);
  }
  const size = Math.min((h * 0.8) / lines.length, (w * 1.6) / Math.max(...lines.map((l) => l.length)));
  ctx.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lines.forEach((l, i) => {
    const y = h / 2 + (i - (lines.length - 1) / 2) * size * 1.05;
    if (screen) { ctx.shadowColor = '#7ff3ff'; ctx.shadowBlur = size * 0.2; ctx.fillStyle = i === 0 ? '#ffffff' : '#ffd84a'; }
    else ctx.fillStyle = '#ffffff';
    ctx.fillText(l, w / 2, y, w * 0.94);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
