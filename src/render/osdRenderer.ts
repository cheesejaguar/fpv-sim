// Betaflight OSD renderer: parses MAX7456 .mcm font files (256 glyphs, 12x18 px, 2 bpp:
// 00 black, 10 white, x1 transparent) into an atlas and draws Betaflight's displayport character
// grid exactly as the FC wrote it.
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

export class OsdRenderer {
  canvas = document.createElement('canvas');
  texture: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private atlas: HTMLCanvasElement | null = null;
  private lastSeq = -1;
  private blinkOn = true;
  private lastBlink = 0;
  cols = 30; rows = 16;
  hasContent = false;

  constructor() {
    this.canvas.width = 30 * GLYPH_W; this.canvas.height = 16 * GLYPH_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter; this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  async setFont(name: string) { this.atlas = await loadMcmAtlas(`/fonts/${name}.mcm`); this.lastSeq = -1; }

  /** Redraw if Betaflight published a new frame (or blink phase changed). */
  update(sh: Shared, now: number) {
    const seq = Atomics.load(sh.ctrl, 2);
    const blinkPhase = Math.floor(now / 250) % 2 === 0;
    const blinkChanged = blinkPhase !== this.blinkOn && now - this.lastBlink > 200;
    if (seq === this.lastSeq && !blinkChanged) return;
    this.lastSeq = seq;
    if (blinkChanged) { this.blinkOn = blinkPhase; this.lastBlink = now; }
    const cols = Atomics.load(sh.ctrl, 3) || 30, rows = Atomics.load(sh.ctrl, 4) || 16;
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols; this.rows = rows;
      this.canvas.width = cols * GLYPH_W; this.canvas.height = rows * GLYPH_H;
      this.texture.dispose();
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.atlas) return;
    let any = false;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const c = sh.osd[y * OSD_MAX_COLS + x];
      const attr = sh.osd[OSD_MAX_COLS * OSD_MAX_ROWS + y * OSD_MAX_COLS + x];
      if (c === 0 || c === 0x20) continue;
      if ((attr & 0x40) && !this.blinkOn) continue;
      any = true;
      ctx.drawImage(this.atlas, (c % 16) * GLYPH_W, Math.floor(c / 16) * GLYPH_H, GLYPH_W, GLYPH_H, x * GLYPH_W, y * GLYPH_H, GLYPH_W, GLYPH_H);
    }
    this.hasContent = any;
    this.texture.needsUpdate = true;
  }
}
