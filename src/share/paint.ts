// Draws the share cards' display lists (layout.ts) onto a 1080 x 1920 canvas, in the game menu's
// design language: Russo One / Chakra Petch (self-hosted, so the canvas waits for them), deep navy
// with violet and rose glows, scanlines. Also turns a card into a PNG File for sharing.
import { alpha, cardItems, Fill, H, Item, Measure, TextStyle, W } from './layout';
import type { CardStyle, Palette, ShareAssets, ShareLap } from './types';

const FAMILY = { display: '"Russo One", "Chakra Petch", system-ui, sans-serif', ui: '"Chakra Petch", system-ui, -apple-system, "Segoe UI", sans-serif' };
const font = (s: TextStyle) => `${s.font === 'display' ? 400 : s.weight ?? 500} ${s.size}px ${FAMILY[s.font]}`;

/** Load the card fonts (they are self-hosted @font-face files, fetched only once something asks for them). */
export async function cardFonts(): Promise<void> {
  try {
    await Promise.all(['400 64px "Russo One"', '500 32px "Chakra Petch"', '600 32px "Chakra Petch"', '700 32px "Chakra Petch"'].map((f) => document.fonts.load(f)));
    await document.fonts.ready;
  } catch { /* draw with the fallback fonts */ }
}

export function canvasMeasure(ctx: CanvasRenderingContext2D): Measure {
  return (text, s) => {
    ctx.font = font(s);
    if (!s.spacing) return ctx.measureText(text).width;
    const chars = [...text];
    return chars.reduce((w, ch) => w + ctx.measureText(ch).width, 0) + s.spacing * Math.max(0, chars.length - 1);
  };
}

function paintOf(ctx: CanvasRenderingContext2D, f: Fill): string | CanvasGradient {
  if (typeof f === 'string') return f;
  const g = ctx.createLinearGradient(f.x0, f.y0, f.x1, f.y1);
  for (const [o, c] of f.stops) g.addColorStop(o, c);
  return g;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 0) {
  ctx.beginPath();
  if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function glowOn(ctx: CanvasRenderingContext2D, color?: string, blur = 40) {
  ctx.shadowColor = color ?? 'transparent'; ctx.shadowBlur = color ? blur : 0;
}

/** Source rectangle of an image drawn into a w x h box: all of it (contain) or a centred crop (cover). */
function fitRect(iw: number, ih: number, w: number, h: number, fit: 'contain' | 'cover') {
  const s = fit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
  return { dw: iw * s, dh: ih * s };
}

function background(ctx: CanvasRenderingContext2D, p: Palette, kind: 'brand' | 'frame', a: ShareAssets) {
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  const f = a.frame;
  if (kind === 'frame' && f) {
    // the frame itself, blurred: drawn tiny, then scaled up smoothly (canvas filters aren't everywhere)
    const small = document.createElement('canvas');
    small.width = 27; small.height = 48;
    const sc = small.getContext('2d')!, { dw, dh } = fitRect(f.w, f.h, 27, 48, 'cover');
    sc.drawImage(f.image, (27 - dw) / 2, (48 - dh) / 2, dw, dh);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, W, H);
    ctx.fillStyle = alpha(p.bg, 0.7);
    ctx.fillRect(0, 0, W, H);
  }
  const glow = (x: number, y: number, r: number, c: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, c); g.addColorStop(1, alpha(p.bg, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  };
  glow(160, 300, 1250, alpha(p.primary, 0.42));
  glow(1000, 1780, 1050, alpha(p.accent, 0.24));
  // scanlines + vignette, as over the menu's 3D backdrop
  ctx.fillStyle = 'rgba(255, 255, 255, 0.022)';
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
  const v = ctx.createRadialGradient(W / 2, H * 0.42, H * 0.32, W / 2, H * 0.42, H * 0.78);
  v.addColorStop(0, 'rgba(0, 0, 0, 0)'); v.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
}

/** The FPV Sim mark (icons.ts logo()): a top-down quad inside a gate, drawn in its 48-unit box. */
function logo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, p: Palette) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(size / 48, size / 48);
  const g = ctx.createLinearGradient(0, 0, 48, 48);
  g.addColorStop(0, p.secondary); g.addColorStop(1, p.accent);
  rounded(ctx, 3, 3, 42, 42, 11);
  ctx.fillStyle = p.card; ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = g; ctx.stroke();
  ctx.lineCap = 'round'; ctx.lineWidth = 2.4; ctx.strokeStyle = '#e2e8f0';
  ctx.beginPath(); ctx.moveTo(15, 15); ctx.lineTo(33, 33); ctx.moveTo(33, 15); ctx.lineTo(15, 33); ctx.stroke();
  ctx.strokeStyle = g;
  for (const [cx, cy] of [[15, 15], [33, 15], [15, 33], [33, 33]]) { ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.stroke(); }
  rounded(ctx, 20, 20, 8, 8, 2);
  ctx.fillStyle = p.accent; ctx.fill();
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, it: Item, a: ShareAssets, p: Palette, m: Measure) {
  ctx.save();
  switch (it.t) {
    case 'bg': background(ctx, p, it.kind, a); break;
    case 'logo': logo(ctx, it.x, it.y, it.size, p); break;
    case 'text': {
      ctx.font = font(it.s);
      ctx.fillStyle = paintOf(ctx, it.fill);
      ctx.textBaseline = 'alphabetic';
      glowOn(ctx, it.glow, Math.max(24, it.s.size * 0.25));
      const x0 = it.align === 'center' ? it.x - it.w / 2 : it.align === 'right' ? it.x - it.w : it.x;
      if (!it.s.spacing) { ctx.textAlign = 'left'; ctx.fillText(it.text, x0, it.y); break; }
      let x = x0;
      for (const ch of it.text) { ctx.fillText(ch, x, it.y); x += m(ch, { ...it.s, spacing: 0 }) + it.s.spacing; }
      break;
    }
    case 'rect': {
      rounded(ctx, it.x, it.y, it.w, it.h, it.r);
      glowOn(ctx, it.glow);
      if (it.fill) { ctx.fillStyle = paintOf(ctx, it.fill); ctx.fill(); }
      glowOn(ctx);
      if (it.stroke) { ctx.lineWidth = it.lw ?? 2; ctx.strokeStyle = it.stroke; ctx.stroke(); }
      break;
    }
    case 'glow': {
      ctx.translate(it.x, it.y); ctx.scale(it.rx, it.ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, it.color); g.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2);
      break;
    }
    case 'img': {
      const pic = it.key === 'drone' ? a.drone : a.frame;
      if (!pic) break;
      const { dw, dh } = fitRect(pic.w, pic.h, it.w, it.h, it.fit);
      if (it.glow || it.stroke) { rounded(ctx, it.x, it.y, it.w, it.h, it.r); glowOn(ctx, it.glow, 60); ctx.fillStyle = p.bg; ctx.fill(); glowOn(ctx); }
      ctx.save();
      rounded(ctx, it.x, it.y, it.w, it.h, it.r); ctx.clip();
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(pic.image, it.x + (it.w - dw) / 2, it.y + (it.h - dh) / 2, dw, dh);
      ctx.restore();
      if (it.stroke) { rounded(ctx, it.x, it.y, it.w, it.h, it.r); ctx.lineWidth = 3; ctx.strokeStyle = it.stroke; ctx.stroke(); }
      break;
    }
    case 'line': {
      if (it.pts.length < 4) break;
      ctx.beginPath(); ctx.moveTo(it.pts[0], it.pts[1]);
      for (let k = 2; k < it.pts.length; k += 2) ctx.lineTo(it.pts[k], it.pts[k + 1]);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = it.lw; ctx.strokeStyle = it.stroke;
      if (it.dash) ctx.setLineDash(it.dash);
      glowOn(ctx, it.glow, 28);
      ctx.stroke();
      break;
    }
    case 'dot': {
      ctx.beginPath(); ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
      ctx.fillStyle = it.fill; ctx.fill();
      if (it.stroke) { ctx.lineWidth = it.lw ?? 2; ctx.strokeStyle = it.stroke; ctx.stroke(); }
      break;
    }
  }
  ctx.restore();
}

/** Draw one card (call cardFonts() first). */
export function renderCard(style: CardStyle, lap: ShareLap, a: ShareAssets, p: Palette, canvas = document.createElement('canvas')): HTMLCanvasElement {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const m = canvasMeasure(ctx);
  for (const it of cardItems(style, lap, a, p, m)) draw(ctx, it, a, p, m);
  return canvas;
}

/** A card as a PNG file, for the share sheet, a download or the clipboard. */
export function cardFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(new File([b], name, { type: 'image/png', lastModified: Date.now() })) : fail(new Error('The card could not be encoded as PNG.'))), 'image/png'));
}
