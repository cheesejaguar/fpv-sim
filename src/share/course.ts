// Top-down track map math for the share cards: fit a course (gate openings and an optional flown
// line, ENU metres) into a box on the card, the smooth gate-to-gate line, gate bars and where each
// gate's number goes. Pure, so tests can check it without a canvas.
import type { GatePlan } from './types';

export interface Box { x: number; y: number; w: number; h: number }
export type Pt = { x: number; y: number };

/** ENU (x east, y north) -> card pixels (y down), scaled to fit the box with `pad` px all round, centred. */
export function fitCourse(gates: GatePlan[], trail: Pt[] | null | undefined, box: Box, pad: number): { px: (p: Pt) => Pt; scale: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (const g of gates) {
    const hx = (Math.cos(g.yaw) * g.width) / 2, hy = (Math.sin(g.yaw) * g.width) / 2;
    add(g.x - hx, g.y - hy); add(g.x + hx, g.y + hy);
  }
  for (const p of trail ?? []) add(p.x, p.y);
  if (!Number.isFinite(x0)) { x0 = y0 = -1; x1 = y1 = 1; }
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const scale = Math.min((box.w - 2 * pad) / bw, (box.h - 2 * pad) / bh);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return { scale, px: (p) => ({ x: cx + (p.x - mx) * scale, y: cy - (p.y - my) * scale }) };
}

/** Closed (or open) Catmull-Rom curve through the points: `steps` samples per segment, flat [x, y, x, y …]. */
export function spline(pts: Pt[], closed = true, steps = 14): number[] {
  const n = pts.length, out: number[] = [];
  if (n < 3) { for (const p of pts) out.push(p.x, p.y); if (closed && n === 2) out.push(pts[0].x, pts[0].y); return out; }
  const at = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y));
    }
  }
  const last = closed ? pts[0] : pts[n - 1];
  out.push(last.x, last.y);
  return out;
}

/** A gate drawn as a bar across its opening (card px): ends a, b; at least minLen long. */
export function gateBar(g: GatePlan, px: (p: Pt) => Pt, scale: number, minLen = 30): { a: Pt; b: Pt; c: Pt } {
  const c = px(g), len = Math.max(minLen, g.width * scale);
  // the opening runs along (cos yaw, sin yaw) in ENU, i.e. (cos, -sin) on the card
  const ux = Math.cos(g.yaw), uy = -Math.sin(g.yaw);
  return { c, a: { x: c.x - (ux * len) / 2, y: c.y - (uy * len) / 2 }, b: { x: c.x + (ux * len) / 2, y: c.y + (uy * len) / 2 } };
}

/** Where a gate's number goes: off the bar on its normal, on the side away from the course's middle, kept in the box. */
export function labelSpot(bar: { c: Pt; a: Pt; b: Pt }, middle: Pt, dist: number, box: Box, margin: number): Pt {
  const dx = bar.b.x - bar.a.x, dy = bar.b.y - bar.a.y, l = Math.hypot(dx, dy) || 1;
  let nx = -dy / l, ny = dx / l;
  if ((bar.c.x - middle.x) * nx + (bar.c.y - middle.y) * ny < 0) { nx = -nx; ny = -ny; }
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return { x: clamp(bar.c.x + nx * dist, box.x + margin, box.x + box.w - margin), y: clamp(bar.c.y + ny * dist, box.y + margin, box.y + box.h - margin) };
}
