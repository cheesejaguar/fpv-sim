// In-flight instruments drawn on canvases: the stick positions and the gyro noise spectrum (raw IMU
// vs Betaflight-filtered gyro, FFT'd in the worker at ~10 Hz).
import { el } from '../ui/dom';
import type { GyroSpectrum } from '../worker/shared';

export class SticksView {
  readonly canvas = el('canvas', { width: 220, height: 100 }) as HTMLCanvasElement;
  draw(ch: Float32Array) {
    const c = this.canvas.getContext('2d')!;
    c.clearRect(0, 0, 220, 100);
    const frame = (cx: number, cy: number) => { c.strokeStyle = 'rgba(255,255,255,.5)'; c.strokeRect(cx - 40, cy - 40, 80, 80); };
    frame(50, 50); frame(170, 50);
    const dot = (cx: number, cy: number, x: number, y: number) => { c.fillStyle = '#4cf'; c.beginPath(); c.arc(cx + x * 40, cy - y * 40, 5, 0, 7); c.fill(); };
    dot(50, 50, (ch[3] - 1500) / 500, (ch[2] - 1500) / 500);
    dot(170, 50, (ch[0] - 1500) / 500, (ch[1] - 1500) / 500);
  }
}

const SPEC_W = 380, SPEC_ROW = 92;

export class SpectrumView {
  readonly canvas = el('canvas', { width: SPEC_W, height: SPEC_ROW * 3 + 22 }) as HTMLCanvasElement;
  shown = false;
  private view: GyroSpectrum | null = null;
  get data() { return this.view; }

  /** Returns the new state so the caller can tell the worker to start / stop computing it. */
  toggle(): boolean {
    this.shown = !this.shown; this.view = null;
    if (this.shown) this.draw();
    return this.shown;
  }

  onSpectrum(sp: GyroSpectrum) {
    if (!this.shown) return;
    // light smoothing between frames so the traces are readable (like a blackbox analyser's averaging)
    const prev = this.view;
    if (prev && prev.bins === sp.bins) {
      for (let i = 0; i < sp.raw.length; i++) { sp.raw[i] = prev.raw[i] * 0.5 + sp.raw[i] * 0.5; sp.filtered[i] = prev.filtered[i] * 0.5 + sp.filtered[i] * 0.5; }
    }
    this.view = sp;
    this.draw();
  }

  private draw() {
    const c = this.canvas.getContext('2d')!, W = SPEC_W, sp = this.view;
    const L = 30, Rm = 6, plotW = W - L - Rm, maxHz = 1000, dbTop = 30, dbBot = -60;
    c.clearRect(0, 0, W, this.canvas.height);
    c.font = '10px ui-monospace, Consolas, monospace';
    const xOf = (hz: number) => L + (hz / maxHz) * plotW;
    ['roll', 'pitch', 'yaw'].forEach((name, a) => {
      const top = a * SPEC_ROW + 4, h = SPEC_ROW - 8;
      const yOf = (db: number) => top + ((dbTop - Math.max(dbBot, Math.min(dbTop, db))) / (dbTop - dbBot)) * h;
      c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1;
      for (let db = dbBot; db <= dbTop; db += 10) { c.beginPath(); c.moveTo(L, yOf(db) + 0.5); c.lineTo(W - Rm, yOf(db) + 0.5); c.stroke(); }
      for (let hz = 0; hz <= maxHz; hz += 200) { c.beginPath(); c.moveTo(xOf(hz) + 0.5, top); c.lineTo(xOf(hz) + 0.5, top + h); c.stroke(); }
      c.fillStyle = 'rgba(255,255,255,.55)';
      c.fillText(name, L + 4, top + 10);
      c.fillText(`${dbTop}`, 4, yOf(dbTop) + 8); c.fillText(`${dbBot}`, 4, yOf(dbBot));
      if (!sp) return;
      // below this the filtered trace is Betaflight's integer °/s debug resolution, not real signal
      if (sp.hasFiltered) { c.fillStyle = 'rgba(57,182,255,.16)'; c.fillRect(L, yOf(sp.filteredFloorDb), plotW, top + h - yOf(sp.filteredFloorDb)); }
      // motor harmonics: band spans the 4 motors, line at their mean
      const lo = Math.min(...sp.motorHz), hi = Math.max(...sp.motorHz), mean = sp.motorHz.reduce((x, y) => x + y, 0) / 4;
      if (mean > 5) for (let hm = 1; hm <= 3; hm++) {
        c.fillStyle = 'rgba(255,220,80,.12)'; c.fillRect(xOf(lo * hm), top, Math.max(1, xOf(hi * hm) - xOf(lo * hm)), h);
        c.strokeStyle = 'rgba(255,220,80,.6)'; c.setLineDash([3, 3]);
        c.beginPath(); c.moveTo(xOf(mean * hm) + 0.5, top); c.lineTo(xOf(mean * hm) + 0.5, top + h); c.stroke(); c.setLineDash([]);
        if (a === 0 && mean * hm < maxHz - 20) { c.fillStyle = 'rgba(255,220,80,.85)'; c.fillText(`${hm}×`, xOf(mean * hm) + 2, top + 20); }
      }
      const trace = (arr: Float32Array, color: string) => {
        c.strokeStyle = color; c.lineWidth = 1.2; c.beginPath();
        for (let k = 1; k < sp.bins; k++) { const x = xOf(k * sp.binHz), y = yOf(arr[a * sp.bins + k]); if (k === 1) c.moveTo(x, y); else c.lineTo(x, y); }
        c.stroke();
      };
      trace(sp.raw, '#ff7a1a');
      if (sp.hasFiltered) trace(sp.filtered, '#39b6ff');
    });
    const by = SPEC_ROW * 3 + 14;
    c.fillStyle = 'rgba(255,255,255,.55)';
    for (let hz = 0; hz <= maxHz; hz += 200) c.fillText(`${hz}`, Math.min(xOf(hz) - 6, W - 30), by - 4);
    c.fillStyle = '#ff7a1a'; c.fillText('raw', L, by + 6);
    c.fillStyle = '#39b6ff'; c.fillText(sp && !sp.hasFiltered ? 'filtered: no signal yet (debug_mode GYRO_FILTERED?)' : 'BF filtered (shade: 1 °/s LSB)', L + 28, by + 6);
    c.fillStyle = 'rgba(255,220,80,.85)'; c.fillText(sp ? `motor ${(sp.motorHz.reduce((x, y) => x + y, 0) / 4).toFixed(0)} Hz · dB °/s` : 'collecting…', W - 118, by + 6);
  }
}
