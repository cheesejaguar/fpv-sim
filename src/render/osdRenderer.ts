// Betaflight OSD renderer: parses MAX7456 .mcm font files (256 glyphs, 12x18 px, 2 bpp:
// 00 black, 10 white, x1 transparent) into an atlas and draws Betaflight's displayport character
// grid exactly as the FC wrote it. Digital systems draw their HD OSD at 24x36 per glyph: the same
// (GPL-3.0, betaflight-configurator) font scaled up edge-aware, since no HD Betaflight font with a
// clear open licence exists (the goggle fonts are SNEAKY_FPV's, used by permission only).
// Also the goggles' own overlay (signal, bitrate, latency, recording) for each video system.
import * as THREE from 'three';
import { OSD_MAX_COLS, OSD_MAX_ROWS, Shared } from '../worker/shared';

export const GLYPH_W = 12, GLYPH_H = 18;

export async function loadMcmAtlas(url: string): Promise<HTMLCanvasElement> {
  const txt = await (await fetch(url)).text();
  const lines = txt.split(/\r?\n/);
  if (!lines[0].startsWith('MAX7456')) throw new Error('not an MCM font');
  const cv = document.createElement('canvas');
  cv.width = 16 * GLYPH_W; cv.height = 16 * GLYPH_H;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(cv.width, cv.height);
  for (let ch = 0; ch < 256; ch++) {
    const gx = (ch % 16) * GLYPH_W, gy = Math.floor(ch / 16) * GLYPH_H;
    for (let b = 0; b < 54; b++) {
      const line = lines[1 + ch * 64 + b];
      if (!line) continue;
      for (let k = 0; k < 4; k++) {
        const bits = line.substr(k * 2, 2);
        const pix = b * 4 + k;
        const x = gx + (pix % GLYPH_W), y = gy + Math.floor(pix / GLYPH_W);
        const o = (y * cv.width + x) * 4;
        if (bits === '00') { img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 255; }
        else if (bits === '10') { img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255; img.data[o + 3] = 255; }
        else img.data[o + 3] = 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Scale2x / EPX: doubles a pixel-art image, filling each output pixel from a neighbour when two
 * neighbours agree along an edge. Diagonal strokes come out as clean 45° steps instead of fat
 * blocks, with no blur and no new colours. cw / ch: cell size; neighbours never cross a cell (glyph)
 * boundary, so atlas glyphs don't bleed into each other.
 */
export function scale2x(src: Uint32Array, w: number, h: number, cw = w, ch = h): Uint32Array {
  const out = new Uint32Array(w * h * 4), W2 = w * 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cx0 = x - (x % cw), cy0 = y - (y % ch);
    const P = src[y * w + x];
    const A = y > cy0 ? src[(y - 1) * w + x] : P;               // up
    const D = y < cy0 + ch - 1 ? src[(y + 1) * w + x] : P;      // down
    const C = x > cx0 ? src[y * w + x - 1] : P;                 // left
    const B = x < cx0 + cw - 1 ? src[y * w + x + 1] : P;        // right
    const o = 2 * y * W2 + 2 * x;
    out[o] = C === A && C !== D && A !== B ? A : P;
    out[o + 1] = A === B && A !== C && B !== D ? B : P;
    out[o + W2] = D === C && D !== B && C !== A ? C : P;
    out[o + W2 + 1] = B === D && B !== A && D !== C ? D : P;
  }
  return out;
}

/** 24x36 HD glyph atlas from a 12x18 MCM atlas. */
export function hdAtlas(sd: HTMLCanvasElement): HTMLCanvasElement {
  const w = sd.width, h = sd.height;
  const src = new Uint32Array(sd.getContext('2d')!.getImageData(0, 0, w, h).data.buffer.slice(0));
  const px = scale2x(src, w, h, GLYPH_W, GLYPH_H);
  const cv = document.createElement('canvas');
  cv.width = w * 2; cv.height = h * 2;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(w * 2, h * 2);
  img.data.set(new Uint8Array(px.buffer));
  g.putImageData(img, 0, 0);
  return cv;
}

function canvasTexture(cv: HTMLCanvasElement, colorSpace: THREE.ColorSpace) {
  // one level, linear: the OSD is redrawn often and is never minified much, so mipmaps would only be
  // regenerated on every upload for nothing
  const t = new THREE.CanvasTexture(cv);
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.colorSpace = colorSpace;
  return t;
}

export class OsdRenderer {
  canvas = document.createElement('canvas');
  texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private atlas: HTMLCanvasElement | null = null;
  private atlasHd: HTMLCanvasElement | null = null;
  private hd = false;
  private lastSeq = -1;
  private blinkOn = true;
  private lastBlink = 0;
  cols = 30; rows = 16;
  hasContent = false;
  /** Cells Betaflight has drawn (blinking ones count while hidden), row-major cols×rows: the
   *  in-flight HUD lays itself out around them so it never covers the OSD. */
  occupied = new Uint8Array(30 * 16);

  constructor() {
    this.canvas.width = 30 * GLYPH_W; this.canvas.height = 16 * GLYPH_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = canvasTexture(this.canvas, THREE.SRGBColorSpace);
  }

  async setFont(name: string) {
    this.atlas = await loadMcmAtlas(`/fonts/${name}.mcm`);
    this.atlasHd = hdAtlas(this.atlas);
    this.lastSeq = -1;
  }

  /** HD glyphs (digital systems: the goggles draw the OSD at the video's resolution). */
  setHd(on: boolean) { if (on !== this.hd) { this.hd = on; this.lastSeq = -1; } }

  /** Redraw if Betaflight published a new frame (or blink phase changed). Returns true if redrawn. */
  update(sh: Shared, now: number): boolean {
    const seq = Atomics.load(sh.ctrl, 2);
    const blinkPhase = Math.floor(now / 250) % 2 === 0;
    const blinkChanged = blinkPhase !== this.blinkOn && now - this.lastBlink > 200;
    if (seq === this.lastSeq && !blinkChanged) return false;
    this.lastSeq = seq;
    if (blinkChanged) { this.blinkOn = blinkPhase; this.lastBlink = now; }
    const cols = Atomics.load(sh.ctrl, 3) || 30, rows = Atomics.load(sh.ctrl, 4) || 16;
    const s = this.hd ? 2 : 1, gw = GLYPH_W * s, gh = GLYPH_H * s;
    if (cols !== this.cols || rows !== this.rows || this.canvas.width !== cols * gw || this.canvas.height !== rows * gh) {
      this.cols = cols; this.rows = rows;
      this.canvas.width = cols * gw; this.canvas.height = rows * gh;
      this.texture.dispose();
      this.texture = canvasTexture(this.canvas, THREE.SRGBColorSpace);
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const atlas = this.hd ? this.atlasHd : this.atlas;
    if (!atlas) return true;
    let any = false;
    if (this.occupied.length !== cols * rows) this.occupied = new Uint8Array(cols * rows); else this.occupied.fill(0);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const c = sh.osd[y * OSD_MAX_COLS + x];
      const attr = sh.osd[OSD_MAX_COLS * OSD_MAX_ROWS + y * OSD_MAX_COLS + x];
      if (c === 0 || c === 0x20) continue;
      this.occupied[y * cols + x] = 1;
      if ((attr & 0x40) && !this.blinkOn) continue;
      any = true;
      ctx.drawImage(atlas, (c % 16) * gw, Math.floor(c / 16) * gh, gw, gh, x * gw, y * gh, gw, gh);
    }
    this.hasContent = any;
    this.texture.needsUpdate = true;
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Goggle overlay: what the goggles / VRX draw over the received picture, independent of the FC OSD.

/** Top strip of the frame the goggle overlay draws in (fraction of the frame height). */
export const GOGGLE_BAND = 0.065;

export interface GoggleInfo {
  system: string; kind: 'analog' | 'digital';
  cnr: number; margin: number; bitrateMbps: number; latencyMs: number; lost: boolean;
  recording: boolean; recMs: number;
}

/** Signal bars 0..5: digital from the link margin, analog from the carrier-to-noise ratio. */
export function signalBars(i: Pick<GoggleInfo, 'kind' | 'cnr' | 'margin' | 'lost'>): number {
  if (i.lost) return 0;
  const v = i.kind === 'analog' ? (i.cnr - 4) / 5 : (i.margin + 4) / 4;
  return Math.max(0, Math.min(5, Math.round(v)));
}

/** RSSI % as analog receivers display it (~0 % at the noise floor, 100 % at a strong carrier). */
export function rssiPercent(cnr: number): number { return Math.max(0, Math.min(99, Math.round(((cnr - 2) / 30) * 100))); }

const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/** Text items of the overlay for a system: [left, right] strings (exported for tests). */
export function goggleItems(i: GoggleInfo): { left: string[]; right: string[]; bars: number } {
  const bars = signalBars(i), rec = i.recording ? `● ${mmss(i.recMs)}` : '';
  switch (i.system) {
    case 'dji-o3': case 'dji-o4':
      // DJI goggles: link quality, bitrate and latency top-left, the recording timer top-right
      return { bars, left: [i.lost ? '0.0Mbps' : `${i.bitrateMbps.toFixed(1)}Mbps`, `${Math.round(i.latencyMs)}ms`], right: rec ? [rec] : [] };
    case 'walksnail':
      return { bars, left: ['CH1', i.lost ? '0Mbps' : `${Math.round(i.bitrateMbps)}Mbps`, `${Math.round(i.latencyMs)}ms`], right: rec ? [rec] : [] };
    case 'hdzero':
      // HDZero goggles: channel and link quality; DVR state
      return { bars, left: ['F4'], right: [rec || 'DVR'] };
    default:
      // analog receiver / goggle module: channel, RSSI, DVR state
      return { bars, left: ['F4 5800', `RSSI ${rssiPercent(i.cnr)}%`], right: [rec ? `REC ${rec.slice(2)}` : 'DVR'] };
  }
}

export class GoggleOverlay {
  canvas = document.createElement('canvas');
  texture: THREE.CanvasTexture;
  private key = '';
  private at = -1e9;

  constructor() {
    this.canvas.width = 640; this.canvas.height = 480;
    // drawn in display values (the goggle UI is not part of the camera's linear signal)
    this.texture = canvasTexture(this.canvas, THREE.NoColorSpace);
  }

  /** Redraw at most ~4 Hz (goggle status bars update about that often) when something changed. */
  update(i: GoggleInfo, w: number, h: number, now: number): boolean {
    const sized = this.canvas.width === w && this.canvas.height === h;
    if (sized && now - this.at < 250) return false;
    const it = goggleItems(i);
    const key = JSON.stringify(it) + (i.recording ? Math.floor(now / 500) % 2 : '');
    if (sized && key === this.key) return false;
    this.key = key; this.at = now;
    if (!sized) {
      this.canvas.width = w; this.canvas.height = h;
      this.texture.dispose(); this.texture = canvasTexture(this.canvas, THREE.NoColorSpace);
    }
    const g = this.canvas.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    const fs = Math.round(h * 0.03), pad = Math.round(h * 0.025), y = Math.round(h * (GOGGLE_BAND - 0.016));
    g.font = `600 ${fs}px "Chakra Petch", system-ui, sans-serif`;
    g.textBaseline = 'alphabetic';
    g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = fs * 0.25; g.shadowOffsetY = fs * 0.06;
    // signal bars
    let x = pad;
    const bw = Math.max(2, Math.round(fs * 0.18)), gap = Math.max(1, Math.round(bw * 0.6));
    for (let b = 0; b < 5; b++) {
      const bh = Math.round(fs * (0.3 + 0.17 * b));
      g.fillStyle = b < it.bars ? (it.bars <= 1 ? '#ff453a' : it.bars <= 2 ? '#ffd60a' : '#ffffff') : 'rgba(255,255,255,0.3)';
      g.fillRect(x, y - bh, bw, bh);
      x += bw + gap;
    }
    x += fs * 0.5;
    g.fillStyle = '#ffffff';
    for (const s of it.left) { g.fillText(s, x, y); x += g.measureText(s).width + fs * 0.7; }
    let xr = w - pad;
    for (const s of [...it.right].reverse()) {
      const tw = g.measureText(s).width;
      xr -= tw;
      const live = s.includes('●') || s.startsWith('REC');
      g.fillStyle = live ? '#ff453a' : 'rgba(255,255,255,0.75)';
      // the red dot blinks while recording
      if (!(live && Math.floor(now / 500) % 2 && s.startsWith('●'))) g.fillText(s, xr, y);
      else g.fillText(s.replace('●', ' '), xr, y);
      xr -= fs * 0.7;
    }
    this.texture.needsUpdate = true;
    return true;
  }
}
