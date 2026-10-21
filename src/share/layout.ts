// Layout of the 1080 x 1920 lap share cards as display lists: plain items (text, boxes, pictures,
// lines) that paint.ts draws on a canvas. Pure (text is measured through a function), so tests can
// check that every card keeps its content inside Instagram's Story safe area and fits long track
// and drone names. Instagram covers the top ~250 px (profile, progress bar) and the bottom ~250 px
// (reply bar) of a Story: only backgrounds bleed into them.
import { CLASSES } from '../../server/src/leaderboardCore';
import { formatLap } from '../net/leaderboard';
import { Box, fitCourse, gateBar, labelSpot, spline } from './course';
import type { CardStyle, Palette, ShareAssets, ShareLap } from './types';

export const W = 1080, H = 1920;
/** Content area: clear of the top and bottom 250 px, 72 px side margins. */
export const SAFE: Box = { x: 72, y: 250, w: 936, h: 1420 };
export const SITE = 'fpv-sim-gamma.vercel.app';
export const TAGLINE = 'REAL BETAFLIGHT · REAL PHYSICS';

export interface TextStyle { size: number; font: 'display' | 'ui'; weight?: number; spacing?: number }
/** Width (px) of a text drawn in a style, letter spacing included. */
export type Measure = (text: string, s: TextStyle) => number;

export interface Grad { x0: number; y0: number; x1: number; y1: number; stops: [number, string][] }
export type Fill = string | Grad;

export type Item = { bleed?: boolean } & (
  | { t: 'bg'; kind: 'brand' | 'frame' }
  | { t: 'text'; x: number; y: number; text: string; s: TextStyle; fill: Fill; align?: 'left' | 'center' | 'right'; glow?: string; w: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; r?: number; fill?: Fill; stroke?: string; lw?: number; glow?: string }
  | { t: 'glow'; x: number; y: number; rx: number; ry: number; color: string }
  | { t: 'img'; key: 'drone' | 'frame'; x: number; y: number; w: number; h: number; fit: 'contain' | 'cover'; r?: number; stroke?: string; glow?: string }
  | { t: 'line'; pts: number[]; stroke: string; lw: number; dash?: number[]; glow?: string }
  | { t: 'dot'; x: number; y: number; r: number; fill: string; stroke?: string; lw?: number }
  | { t: 'logo'; x: number; y: number; size: number }
);

// ---------------------------------------------------------------------------------------------
// Text

const ELLIPSIS = '…';

/** The longest start of `text` (+ "…") that fits maxW. */
export function ellipsize(m: Measure, text: string, s: TextStyle, maxW: number): string {
  if (m(text, s) <= maxW) return text;
  const chars = [...text];
  let lo = 0, hi = chars.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (m(chars.slice(0, mid).join('').trimEnd() + ELLIPSIS, s) <= maxW) lo = mid; else hi = mid - 1; }
  return lo ? chars.slice(0, lo).join('').trimEnd() + ELLIPSIS : ELLIPSIS;
}

/** Shrink the text's size (down to minSize) until it fits maxW, then cut it with "…" if it still doesn't. */
export function fitText(m: Measure, text: string, s: TextStyle, maxW: number, minSize = Math.round(s.size * 0.55)): { text: string; s: TextStyle } {
  const w = m(text, s);
  if (w <= maxW) return { text, s };
  const size = Math.max(minSize, Math.floor(s.size * (maxW / w)));
  let st = { ...s, size, spacing: s.spacing ? (s.spacing * size) / s.size : s.spacing };
  while (st.size > minSize && m(text, st) > maxW) st = { ...st, size: st.size - 1 };
  return { text: ellipsize(m, text, st, maxW), s: st };
}

/** Vertical extent of a text line drawn on baseline y (cap height above it, descenders below). */
export const textTop = (y: number, s: TextStyle) => y - s.size * 0.8;
export const textBottom = (y: number, s: TextStyle) => y + s.size * 0.22;

/** Bounding box of an item (null: no extent, e.g. the background). */
export function bounds(i: Item): Box | null {
  switch (i.t) {
    case 'bg': return null;
    case 'text': {
      const x = i.align === 'center' ? i.x - i.w / 2 : i.align === 'right' ? i.x - i.w : i.x;
      return { x, y: textTop(i.y, i.s), w: i.w, h: textBottom(i.y, i.s) - textTop(i.y, i.s) };
    }
    case 'glow': return { x: i.x - i.rx, y: i.y - i.ry, w: 2 * i.rx, h: 2 * i.ry };
    case 'line': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < i.pts.length; k += 2) { x0 = Math.min(x0, i.pts[k]); x1 = Math.max(x1, i.pts[k]); y0 = Math.min(y0, i.pts[k + 1]); y1 = Math.max(y1, i.pts[k + 1]); }
      const h = i.lw / 2;
      return { x: x0 - h, y: y0 - h, w: x1 - x0 + 2 * h, h: y1 - y0 + 2 * h };
    }
    case 'dot': return { x: i.x - i.r, y: i.y - i.r, w: 2 * i.r, h: 2 * i.r };
    case 'logo': return { x: i.x, y: i.y, w: i.size, h: i.size };
    default: return { x: i.x, y: i.y, w: i.w, h: i.h };
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting (en-US)

export const fmtLap = formatLap;
/** Seconds with a sign: "+0.412 s", "−1.250 s". */
export const fmtGap = (ms: number) => `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toFixed(3)} s`;
/** A split: "12.345" under a minute, else "1:02.345". */
export const fmtSplit = (ms: number) => (ms < 60_000 ? (ms / 1000).toFixed(3) : formatLap(ms));
export const fmtDate = (at: number) => (at > 0 ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
export const rankText = (rank: number, total: number) => (total > 1 ? `#${rank} of ${total}` : `#${rank}`);

export const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/** The hero gradient (white -> secondary -> accent, as the menu's .gm-hero) across a box. */
const hero = (p: Palette, x0: number, x1: number, y: number): Grad => ({ x0, y0: y, x1, y1: y, stops: [[0.1, '#ffffff'], [0.55, p.secondary], [1, p.accent]] });

// ---------------------------------------------------------------------------------------------
// Cards

interface Ctx { lap: ShareLap; a: ShareAssets; p: Palette; m: Measure; out: Item[] }

/** One line of text, fitted to maxW, aligned at x. */
function text(c: Ctx, x: number, y: number, str: string, s: TextStyle, fill: Fill | 'hero', o: { align?: 'left' | 'center' | 'right'; maxW?: number; minSize?: number; glow?: string } = {}): Item & { t: 'text' } {
  const f = fitText(c.m, str, s, o.maxW ?? SAFE.w, o.minSize);
  const w = c.m(f.text, f.s), align = o.align ?? 'left';
  const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const it = { t: 'text' as const, x, y, text: f.text, s: f.s, fill: fill === 'hero' ? hero(c.p, x0, x0 + w, y) : fill, align, glow: o.glow, w };
  c.out.push(it);
  return it;
}

function frameAndHeader(c: Ctx, kind: 'brand' | 'frame' = 'brand') {
  const { p, out } = c;
  out.push({ t: 'bg', kind, bleed: true });
  out.push({ t: 'logo', x: SAFE.x, y: 268, size: 96 });
  text(c, 190, 328, 'FPV SIM', { size: 60, font: 'display', spacing: 3 }, p.fg);
  text(c, 192, 362, TAGLINE, { size: 22, font: 'ui', weight: 600, spacing: 5 }, p.secondary, { maxW: SAFE.x + SAFE.w - 192 });
}

function footer(c: Ctx) {
  const { p, out } = c;
  out.push({ t: 'rect', x: SAFE.x, y: 1586, w: SAFE.w, h: 2, fill: p.border });
  const site = text(c, SAFE.x, 1642, SITE, { size: 32, font: 'ui', weight: 700, spacing: 1 }, p.fg, { maxW: 560 });
  text(c, SAFE.x + SAFE.w, 1642, 'FREE · IN YOUR BROWSER', { size: 22, font: 'ui', weight: 600, spacing: 4 }, p.muted, { align: 'right', maxW: SAFE.w - site.w - 40 });
}

/** Small caps line above a card's main content (accent colour). */
const kicker = (c: Ctx, y: number, str: string, align: 'left' | 'center' = 'center') =>
  text(c, align === 'center' ? W / 2 : SAFE.x, y, str.toUpperCase(), { size: 28, font: 'ui', weight: 700, spacing: 8 }, c.p.accent, { align });

/** Rank on the board ("#3 of 47"), or null when the lap isn't on it. */
const rankOf = (c: Ctx) => (c.lap.entryId !== undefined && c.a.board?.rank ? rankText(c.a.board.rank, c.a.board.total) : null);
/** The board's fastest lap, when known. */
const recordOf = (c: Ctx) => c.a.board?.top[0] ?? null;
/** Is the lap the board's record (posted, and first)? */
const isRecord = (c: Ctx) => c.lap.entryId !== undefined && recordOf(c)?.id === c.lap.entryId;
/** "BOARD RECORD" / "PERSONAL BEST": the headline of a card. */
const headline = (c: Ctx) => (isRecord(c) ? 'Board record' : 'Personal best');
const gatesLabel = (n: number) => `${n} gate${n === 1 ? '' : 's'}`;

/** The quickest gate-to-gate stretch: its time and "G2–3" (the last one ends at the start gate, "S"). */
export function fastestSector(splitsMs: number[]): { ms: number; label: string } | null {
  if (splitsMs.length < 2) return null;
  let best = 0;
  const d = splitsMs.map((s, i) => s - (i ? splitsMs[i - 1] : 0));
  d.forEach((x, i) => { if (x < d[best]) best = i; });
  const to = best === d.length - 1 ? 'S' : String(best + 1);
  return { ms: d[best], label: `${best === 0 ? 'S' : `G${best}`}–${to}` };
}

function statsCard(c: Ctx) {
  const { lap, p } = c;
  frameAndHeader(c);
  kicker(c, 470, headline(c));
  text(c, W / 2, 704, fmtLap(lap.lapMs), { size: 250, font: 'display' }, 'hero', { align: 'center', glow: alpha(p.primary, 0.55), minSize: 120 });
  text(c, W / 2, 792, `Lap time${lap.splitsMs.length ? ` · ${gatesLabel(lap.splitsMs.length)}` : ''}`.toUpperCase(), { size: 26, font: 'ui', weight: 600, spacing: 6 }, p.muted, { align: 'center' });
  // arcade initials
  const sw = 132, gap = 24, x0 = W / 2 - (3 * sw + 2 * gap) / 2;
  [...(lap.initials || '???').slice(0, 3)].forEach((ch, i) => {
    const x = x0 + i * (sw + gap);
    c.out.push({ t: 'rect', x, y: 846, w: sw, h: 164, r: 18, fill: alpha(p.card, 0.92), stroke: i === 0 ? p.accent : p.border, lw: 3, glow: i === 0 ? alpha(p.accent, 0.5) : undefined });
    text(c, x + sw / 2, 970, ch, { size: 112, font: 'display' }, p.fg, { align: 'center', maxW: sw - 16 });
  });
  text(c, W / 2, 1104, lap.track, { size: 58, font: 'display' }, p.fg, { align: 'center', minSize: 34 });
  text(c, W / 2, 1164, lap.summary, { size: 34, font: 'ui', weight: 600 }, p.secondary, { align: 'center', minSize: 24 });
  // four tiles, the most interesting first
  const tiles: [string, string][] = [];
  const rank = rankOf(c), rec = recordOf(c);
  if (rank) tiles.push(['Leaderboard', rank]);
  const second = c.a.board?.top[1];
  if (rec && !isRecord(c)) tiles.push(['Gap to record', fmtGap(lap.lapMs - rec.lapMs)]);
  else if (second) tiles.push(['Ahead of #2', fmtGap(lap.lapMs - second.lapMs)]);
  if (lap.prevMs && lap.prevMs > lap.lapMs) tiles.push(['Improved by', fmtGap(lap.lapMs - lap.prevMs)]);
  tiles.push(['Date', fmtDate(lap.at)]);
  const sector = fastestSector(lap.splitsMs);
  if (sector) tiles.push([`Fastest sector · ${sector.label}`, `${(sector.ms / 1000).toFixed(3)} s`]);
  if (lap.splitsMs.length > 1) tiles.push(['Average sector', `${(lap.lapMs / lap.splitsMs.length / 1000).toFixed(3)} s`]);
  tiles.push(['Drone class', lap.className]);
  tiles.slice(0, 4).forEach(([label, value], i) => {
    const tw = (SAFE.w - 24) / 2, th = 160, x = SAFE.x + (i % 2) * (tw + 24), y = 1216 + Math.floor(i / 2) * (th + 24);
    c.out.push({ t: 'rect', x, y, w: tw, h: th, r: 18, fill: alpha(p.card, 0.86), stroke: p.border, lw: 2 });
    text(c, x + 28, y + 54, label.toUpperCase(), { size: 22, font: 'ui', weight: 600, spacing: 4 }, p.muted, { maxW: tw - 56 });
    text(c, x + 28, y + 128, value, { size: 56, font: 'display' }, p.fg, { maxW: tw - 56, minSize: 30 });
  });
  footer(c);
}

function droneCard(c: Ctx) {
  const { lap, p, a } = c, d = a.drone!;
  frameAndHeader(c);
  kicker(c, 446, lap.track);
  c.out.push({ t: 'glow', x: W / 2, y: 820, rx: 460, ry: 330, color: alpha(p.primary, 0.5) });
  c.out.push({ t: 'glow', x: W / 2, y: 1118, rx: 360, ry: 40, color: 'rgba(0, 0, 0, 0.6)' });
  c.out.push({ t: 'img', key: 'drone', x: SAFE.x, y: 476, w: SAFE.w, h: 680, fit: 'contain' });
  text(c, W / 2, 1238, d.name, { size: 64, font: 'display' }, p.fg, { align: 'center', minSize: 36 });
  // chips, as many as fit on one line
  const cs: TextStyle = { size: 26, font: 'ui', weight: 600, spacing: 1 }, pad = 22, gap = 14;
  const chips: { label: string; w: number }[] = [];
  let total = 0;
  for (const label of d.chips) {
    const w = c.m(label, cs) + 2 * pad;
    if (total + w + (chips.length ? gap : 0) > SAFE.w) break;
    total += w + (chips.length ? gap : 0);
    chips.push({ label, w });
  }
  let x = W / 2 - total / 2;
  for (const ch of chips) {
    c.out.push({ t: 'rect', x, y: 1276, w: ch.w, h: 54, r: 27, fill: alpha(p.primary, 0.22), stroke: p.border, lw: 2 });
    text(c, x + ch.w / 2, 1313, ch.label, cs, p.secondary, { align: 'center' });
    x += ch.w + gap;
  }
  text(c, W / 2, 1482, fmtLap(lap.lapMs), { size: 160, font: 'display' }, 'hero', { align: 'center', glow: alpha(p.primary, 0.5), minSize: 90 });
  text(c, W / 2, 1550, [lap.initials, rankOf(c) ?? headline(c)].filter(Boolean).join(' · ').toUpperCase(), { size: 30, font: 'ui', weight: 600, spacing: 4 }, p.muted, { align: 'center' });
  footer(c);
}

function fpvCard(c: Ctx) {
  const { lap, p, a } = c, f = a.frame!;
  frameAndHeader(c, 'frame');
  kicker(c, 448, f.view === 'fpv' ? 'Straight from the goggles' : f.view === 'chase' ? 'Chase cam' : 'Line of sight');
  text(c, W / 2, 640, fmtLap(lap.lapMs), { size: 190, font: 'display' }, 'hero', { align: 'center', glow: alpha(p.primary, 0.55), minSize: 100 });
  text(c, W / 2, 712, [lap.initials, rankOf(c), lap.track].filter(Boolean).join(' · '), { size: 32, font: 'ui', weight: 600 }, p.fg, { align: 'center', minSize: 22 });
  const fw = SAFE.w, fh = Math.min(760, Math.round((fw * f.h) / Math.max(1, f.w)));
  c.out.push({ t: 'img', key: 'frame', x: SAFE.x, y: 762, w: fw, h: fh, fit: 'cover', r: 22, stroke: p.secondary, glow: alpha(p.primary, 0.6) });
  text(c, W / 2, 762 + fh + 70, [lap.summary, fmtDate(lap.at)].filter(Boolean).join(' · '), { size: 28, font: 'ui', weight: 600, spacing: 1 }, p.muted, { align: 'center', minSize: 20 });
  footer(c);
}

function mapCard(c: Ctx) {
  const { lap, p, a } = c, course = a.course!;
  frameAndHeader(c);
  const n = course.gates.length;
  kicker(c, 446, `Course · ${gatesLabel(n)}`);
  text(c, W / 2, 512, lap.track, { size: 56, font: 'display' }, p.fg, { align: 'center', minSize: 32 });
  const splits = lap.splitsMs.slice(0, 15);
  const box: Box = { x: SAFE.x, y: 548, w: SAFE.w, h: splits.length ? 616 : 840 };
  c.out.push({ t: 'rect', ...box, r: 24, fill: alpha(p.card, 0.55), stroke: p.border, lw: 2 });
  const fit = fitCourse(course.gates, course.trail, box, 70);
  const centres = course.gates.map((g) => fit.px(g));
  const line = spline(centres, true);
  c.out.push({ t: 'line', pts: line, stroke: alpha(p.secondary, course.trail?.length ? 0.45 : 0.9), lw: course.trail?.length ? 6 : 10, dash: course.trail?.length ? [18, 16] : undefined, glow: alpha(p.primary, 0.8) });
  if (course.trail && course.trail.length > 1) c.out.push({ t: 'line', pts: course.trail.flatMap((q) => { const r = fit.px(q); return [r.x, r.y]; }), stroke: p.accent, lw: 6, glow: alpha(p.accent, 0.7) });
  const mid = { x: centres.reduce((s, q) => s + q.x, 0) / n, y: centres.reduce((s, q) => s + q.y, 0) / n };
  course.gates.forEach((g, i) => {
    const bar = gateBar(g, fit.px, fit.scale, 34);
    c.out.push({ t: 'line', pts: [bar.a.x, bar.a.y, bar.b.x, bar.b.y], stroke: i === 0 ? p.accent : '#ffffff', lw: 12 });
    const at = labelSpot(bar, mid, 44, box, 26);
    c.out.push({ t: 'dot', x: at.x, y: at.y, r: 22, fill: i === 0 ? p.accent : p.card, stroke: i === 0 ? p.accent : p.secondary, lw: 3 });
    text(c, at.x, at.y + 9, i === 0 ? 'S' : String(i), { size: 24, font: 'ui', weight: 700 }, i === 0 ? '#ffffff' : p.fg, { align: 'center', maxW: 40 });
  });
  const y = box.y + box.h + 120;
  text(c, SAFE.x, y, fmtLap(lap.lapMs), { size: 104, font: 'display' }, 'hero', { maxW: 600, glow: alpha(p.primary, 0.5) });
  text(c, SAFE.x + SAFE.w, y - 40, lap.initials, { size: 56, font: 'display' }, p.fg, { align: 'right', maxW: 300 });
  text(c, SAFE.x + SAFE.w, y, (rankOf(c) ?? headline(c)).toUpperCase(), { size: 24, font: 'ui', weight: 600, spacing: 3 }, p.muted, { align: 'right', maxW: 300 });
  // splits: time since the start at each gate ("S" = the finish, back at the start gate)
  const cw = SAFE.w / 3;
  splits.forEach((ms, i) => {
    const x = SAFE.x + (i % 3) * cw, yy = y + 62 + Math.floor(i / 3) * 46;
    const last = i === lap.splitsMs.length - 1;
    text(c, x, yy, last ? 'S' : String(i + 1), { size: 24, font: 'ui', weight: 700 }, last ? p.accent : p.secondary, { maxW: 40 });
    text(c, x + 44, yy, fmtSplit(ms), { size: 30, font: 'ui', weight: 600 }, p.fg, { maxW: cw - 56 });
  });
  footer(c);
}

function boardCard(c: Ctx) {
  const { lap, p, a } = c, b = a.board!;
  frameAndHeader(c);
  kicker(c, 446, 'Leaderboard');
  text(c, W / 2, 512, lap.track, { size: 56, font: 'display' }, p.fg, { align: 'center', minSize: 32 });
  text(c, W / 2, 562, lap.className, { size: 30, font: 'ui', weight: 600 }, p.secondary, { align: 'center', minSize: 22 });
  const rank = b.rank ?? 0;
  const mine = { id: lap.entryId ?? -1, initials: lap.initials, lapMs: lap.lapMs, cls: lap.cls, summary: lap.summary, at: lap.at };
  // the top 5, or the top 4, a gap and the pilot's own row
  const rows: { e: typeof b.top[number]; r: number }[] = b.top.slice(0, rank > 5 ? 4 : 5).map((e, i) => ({ e, r: i + 1 }));
  const RH = 122, G = 14;
  let y = 602;
  const row = (e: typeof b.top[number], r: number, me: boolean) => {
    c.out.push({ t: 'rect', x: SAFE.x, y, w: SAFE.w, h: RH, r: 20, fill: me ? { x0: SAFE.x, y0: y, x1: SAFE.x + SAFE.w, y1: y, stops: [[0, alpha(p.primary, 0.75)], [1, alpha(p.accent, 0.55)]] } : alpha(p.card, 0.88), stroke: me ? p.accent : p.border, lw: me ? 3 : 2, glow: me ? alpha(p.accent, 0.55) : undefined });
    const medal = ['#fbbf24', '#e2e8f0', '#d97706'][r - 1];
    text(c, SAFE.x + 62, y + 80, String(r), { size: r > 99 ? 40 : 54, font: 'display' }, medal ?? p.muted, { align: 'center', maxW: 100 });
    // a class board's rows all say the class: only custom builds' own summaries are worth a line
    const sub = e.summary && e.summary !== lap.className ? e.summary : '';
    text(c, SAFE.x + 132, y + (sub ? 66 : 82), e.initials, { size: 58, font: 'display' }, '#ffffff', { maxW: 200 });
    if (sub) text(c, SAFE.x + 132, y + 102, sub, { size: 22, font: 'ui', weight: 500 }, me ? '#ffffff' : p.muted, { maxW: 430 });
    text(c, SAFE.x + SAFE.w - 28, y + 80, fmtLap(e.lapMs), { size: 54, font: 'display' }, '#ffffff', { align: 'right', maxW: 330 });
    y += RH + G;
  };
  for (const x of rows) row(x.e, x.r, x.e.id === lap.entryId);
  if (rank > 5) {
    text(c, W / 2, y + 12, '· · ·', { size: 40, font: 'display' }, p.muted, { align: 'center' });
    y += 36;
    row(mine, rank, true);
  }
  text(c, W / 2, 1436, rank ? rankText(rank, b.total).toUpperCase() : headline(c).toUpperCase(), { size: 96, font: 'display' }, 'hero', { align: 'center', glow: alpha(p.primary, 0.5) });
  text(c, W / 2, 1504, 'Fastest laps worldwide · one per pilot'.toUpperCase(), { size: 24, font: 'ui', weight: 600, spacing: 3 }, p.muted, { align: 'center' });
  footer(c);
}

/** The display list of one card. */
export function cardItems(style: CardStyle, lap: ShareLap, a: ShareAssets, p: Palette, m: Measure): Item[] {
  const c: Ctx = { lap, a, p, m, out: [] };
  ({ stats: statsCard, drone: droneCard, fpv: fpvCard, map: mapCard, board: boardCard })[style](c);
  return c.out;
}

/** Class name for a board class id ('Custom' for custom builds). */
export const classLabel = (cls: string) => CLASSES[cls]?.name ?? 'Custom';
