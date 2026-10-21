// Lap share cards (src/share/): card layout inside Instagram's Story safe area, text fitting for long
// track and drone names, the track-map math, the share / fallback decision, share links, and the QR
// encoder (checked against Project Nayuki's reference generator).
import { describe, expect, test } from 'vitest';
import { shareUi, fileName } from '../src/share/actions';
import { fitCourse, gateBar, spline } from '../src/share/course';
import { bounds, cardItems, ellipsize, fitText, fmtGap, fmtSplit, H, Measure, SAFE, TextStyle, W } from '../src/share/layout';
import { decodeSplits, encodeSplits, parseShareUrl, shareUrl, splitsFor } from '../src/share/link';
import { encodeQr } from '../src/share/qr';
import { available, CARD_STYLES, PALETTES, ShareAssets, ShareLap } from '../src/share/types';

// a monospace-ish stand-in for canvas text metrics: display glyphs are wider than UI ones
const measure: Measure = (t: string, s: TextStyle) => [...t].length * s.size * (s.font === 'display' ? 0.72 : 0.56) + (s.spacing ?? 0) * Math.max(0, [...t].length - 1);

const lap = (extra: Partial<ShareLap> = {}): ShareLap => ({
  map: 'field', course: '', cls: 'freestyle5', track: 'Grand Prix Stadium', className: '5" Freestyle 6S', summary: '5" Freestyle 6S',
  initials: 'ACE', lapMs: 45_123, splitsMs: Array.from({ length: 13 }, (_, i) => Math.round(((i + 1) * 45_123) / 13)), at: Date.UTC(2026, 9, 21), prevMs: 46_000, entryId: 7, ...extra,
});
const entry = (id: number, lapMs: number, initials = 'BOB') => ({ id, initials, lapMs, cls: 'freestyle5', summary: '5" Freestyle 6S', at: 1, replay: false });
const ring = (n: number, r: number) => Array.from({ length: n }, (_, i) => ({ x: Math.cos((i / n) * 2 * Math.PI) * r, y: Math.sin((i / n) * 2 * Math.PI) * r * 0.6, yaw: (i / n) * 2 * Math.PI, width: 3, kind: 'square' }));
const pic = { image: {} as CanvasImageSource, w: 1200, h: 900 };
const allAssets = (rank = 3): ShareAssets => ({
  board: { rank, total: 47, top: [entry(1, 40_000, 'ZED'), entry(2, 41_000), entry(7, 45_123, 'ACE'), entry(4, 46_000), entry(5, 47_000), entry(6, 48_000)] },
  drone: { ...pic, name: '5" Freestyle 6S', chips: ['5"', '642 g', 'T/W 9.8', '2207 1950KV', '6S', 'Analog'] },
  frame: { ...pic, w: 1280, h: 720, view: 'fpv' },
  course: { gates: ring(13, 60), trail: ring(40, 58).map(({ x, y }) => ({ x, y })) },
});

/** Every item but the background stays inside the safe area (1 px of rounding slack). */
function outside(items: ReturnType<typeof cardItems>) {
  return items.filter((i) => !i.bleed).map((i) => ({ i, b: bounds(i) })).filter(({ b }) => b && (b.x < SAFE.x - 1 || b.y < SAFE.y - 1 || b.x + b.w > SAFE.x + SAFE.w + 1 || b.y + b.h > SAFE.y + SAFE.h + 1))
    .map(({ i, b }) => `${i.t}${'text' in i ? ` "${i.text}"` : ''} at ${JSON.stringify(b)}`);
}

describe('card layout', () => {
  test('the safe area is the middle 1080 x 1420 of a 1080 x 1920 Story, with side margins', () => {
    expect([W, H]).toEqual([1080, 1920]);
    expect(SAFE.y).toBeGreaterThanOrEqual(250);
    expect(H - (SAFE.y + SAFE.h)).toBeGreaterThanOrEqual(250);
    expect(SAFE.x).toBeGreaterThan(0);
  });

  test.each(CARD_STYLES.map((c) => c.id))('%s: everything inside the safe area, in every palette', (style) => {
    for (const p of PALETTES) for (const rank of [1, 3, 12]) {
      const items = cardItems(style, lap(), allAssets(rank), p, measure);
      expect(items.length).toBeGreaterThan(8);
      expect(outside(items)).toEqual([]);
      // the logo, the site and the lap time on every card
      const texts = items.flatMap((i) => (i.t === 'text' ? [i.text] : []));
      expect(items.some((i) => i.t === 'logo')).toBe(true);
      expect(texts).toContain('fpv-sim-gamma.vercel.app');
      expect(texts.some((t) => t.includes('0:45.123'))).toBe(true);
    }
  });

  test('long track, drone and initials-free laps still fit (shrunk, then cut with …)', () => {
    const long = lap({
      track: 'Practice Field · The Extremely Long Community Course Name That Never Ends', summary: 'Custom · 10" · 2807.5 1300KV · 12S with a very long tail',
      className: 'Custom', entryId: undefined, prevMs: null, splitsMs: [],
    });
    const a = allAssets();
    a.drone!.name = 'My Very Own Super Long Named Freestyle Quad Build Mk II Special Edition';
    a.drone!.chips = Array.from({ length: 12 }, (_, i) => `chip number ${i}`);
    for (const style of available(long, a)) {
      const items = cardItems(style, long, a, PALETTES[0], measure);
      expect(outside(items), style).toEqual([]);
      for (const i of items) if (i.t === 'text') expect(i.w, `${style} "${i.text}"`).toBeLessThanOrEqual(SAFE.w + 0.5);
    }
    const t = cardItems('stats', long, a, PALETTES[0], measure).find((i) => i.t === 'text' && i.text.startsWith('Practice'))!;
    expect(t.t === 'text' && t.text.endsWith('…')).toBe(true);
  });

  test('fitText shrinks first, then ellipsizes at the minimum size', () => {
    const s: TextStyle = { size: 100, font: 'display' };
    expect(fitText(measure, 'SHORT', s, 936)).toEqual({ text: 'SHORT', s });
    const mid = fitText(measure, 'A'.repeat(16), s, 936);
    expect(mid.text).toBe('A'.repeat(16));
    expect(mid.s.size).toBeLessThan(100);
    expect(measure(mid.text, mid.s)).toBeLessThanOrEqual(936);
    const cut = fitText(measure, 'A'.repeat(80), s, 936, 50);
    expect(cut.s.size).toBe(50);
    expect(cut.text.endsWith('…')).toBe(true);
    expect(measure(cut.text, cut.s)).toBeLessThanOrEqual(936);
    expect(ellipsize(measure, 'WWWW', { size: 1000, font: 'ui' }, 10)).toBe('…');
  });

  test('cards need their data: FPV only with a frame, the board only once posted', () => {
    const a = allAssets();
    expect(available(lap(), a)).toEqual(['stats', 'drone', 'fpv', 'map', 'board']);
    expect(available(lap({ entryId: undefined }), a)).not.toContain('board');
    expect(available(lap(), { ...a, frame: null, drone: null })).toEqual(['stats', 'map', 'board']);
    expect(available(lap(), {})).toEqual(['stats']);
  });

  test('the leaderboard card shows the top 5, or the top 4 and the pilot’s row', () => {
    const rowsOf = (rank: number) => cardItems('board', lap(), allAssets(rank), PALETTES[0], measure).filter((i) => i.t === 'text' && /^[A-Z]{3}$/.test(i.text)).map((i) => (i.t === 'text' ? i.text : ''));
    expect(rowsOf(3)).toEqual(['ZED', 'BOB', 'ACE', 'BOB', 'BOB']);
    expect(rowsOf(12)).toEqual(['ZED', 'BOB', 'ACE', 'BOB', 'ACE']); // the 4th row, then "· · ·" and #12
    const texts = cardItems('board', lap(), allAssets(12), PALETTES[0], measure).flatMap((i) => (i.t === 'text' ? [i.text] : []));
    expect(texts).toContain('12');
    expect(texts).toContain('#12 OF 47');
  });

  test('stats headline and gap: record, or the gap to it', () => {
    const texts = (rank: number, l = lap()) => cardItems('stats', l, allAssets(rank), PALETTES[0], measure).flatMap((i) => (i.t === 'text' ? [i.text] : []));
    expect(texts(3)).toContain('PERSONAL BEST');
    expect(texts(3)).toContain('+5.123 s'); // 45.123 vs the record's 40.000
    const rec = lap({ entryId: 1, lapMs: 40_000, splitsMs: [40_000] });
    expect(texts(1, rec)).toContain('BOARD RECORD');
    expect(texts(1, rec)).toContain('−1.000 s'); // ahead of #2
    expect(fmtGap(-1250)).toBe('−1.250 s');
    expect([fmtSplit(3201), fmtSplit(62_345)]).toEqual(['3.201', '1:02.345']);
  });
});

describe('track map', () => {
  test('fits the course into its box with padding, north up', () => {
    const box = { x: 72, y: 548, w: 936, h: 652 };
    const f = fitCourse(ring(8, 50), null, box, 70);
    const pts = ring(8, 50).map((g) => f.px(g));
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(box.x + 69); expect(p.x).toBeLessThanOrEqual(box.x + box.w - 69);
      expect(p.y).toBeGreaterThanOrEqual(box.y + 69); expect(p.y).toBeLessThanOrEqual(box.y + box.h - 69);
    }
    expect(f.px({ x: 0, y: 10 }).y).toBeLessThan(f.px({ x: 0, y: -10 }).y); // north is up
    // a 4 km two-gate course and a 9 m one both fill the box
    for (const r of [2000, 4.5]) {
      const g = [{ x: -r, y: 0, yaw: 0, width: 3, kind: 'square' }, { x: r, y: 0, yaw: Math.PI, width: 3, kind: 'square' }];
      const ff = fitCourse(g, null, box, 70);
      expect(ff.px(g[1]).x - ff.px(g[0]).x).toBeGreaterThan(box.w - 2 * 70 - 2 * 3 * ff.scale - 1);
    }
  });

  test('the closed line passes through every gate; bars run along the opening', () => {
    const pts = ring(6, 10).map(({ x, y }) => ({ x, y }));
    const line = spline(pts, true, 10);
    for (const p of pts) expect(Array.from({ length: line.length / 2 }, (_, k) => Math.hypot(line[2 * k] - p.x, line[2 * k + 1] - p.y)).some((d) => d < 1e-9)).toBe(true);
    expect([line[0], line[1]]).toEqual([line[line.length - 2], line[line.length - 1]]);
    const bar = gateBar({ x: 0, y: 0, yaw: 0, width: 4, kind: 'square' }, (q) => ({ x: q.x * 10, y: -q.y * 10 }), 10);
    expect([Math.abs(bar.a.y), Math.abs(bar.b.y)]).toEqual([0, 0]); // yaw 0: the opening runs east-west
    expect(bar.b.x - bar.a.x).toBe(40);
  });
});

describe('share options', () => {
  const env = (o: Partial<Parameters<typeof shareUi>[0]> = {}) => ({ canShareFiles: false, mobile: false, clipboardImage: false, ...o });
  test('phones with file sharing get Instagram; desktops their share sheet, or none', () => {
    expect(shareUi(env({ canShareFiles: true, mobile: true }), 'ok').primary).toMatchObject({ kind: 'instagram', label: 'Share to Instagram' });
    expect(shareUi(env({ canShareFiles: true }), 'ok').primary).toMatchObject({ kind: 'system', label: 'Share…' });
    expect(shareUi(env({ mobile: true }), 'ok').primary).toBeNull(); // e.g. Firefox on Android: download instead
    expect(shareUi(env(), 'ok').primary).toBeNull();
  });
  test('copy only with image clipboard support; "send to my phone" everywhere but the phone page', () => {
    expect(shareUi(env({ clipboardImage: true }), 'ok').copy).toBe(true);
    expect(shareUi(env(), 'ok').copy).toBe(false);
    expect(shareUi(env(), 'post').phone).toBe('post');
    expect(shareUi(env({ phonePage: true, canShareFiles: true, mobile: true }), 'ok').phone).toBeNull();
  });
  test('file names are plain', () => {
    expect(fileName('Practice Field · Slalom', '0:45.123', 'map')).toBe('fpv-sim-practice-field-slalom-0-45-123-map.png');
  });
});

describe('share links', () => {
  const splits = [3201, 6100, 9433, 45_123];
  test('round trip: entry, card, colours, splits after the #', () => {
    const url = shareUrl('https://fpv-sim-gamma.vercel.app/', { entry: 123, card: 'map', theme: 'ember', splitsMs: splits });
    expect(url).toBe(`https://fpv-sim-gamma.vercel.app/share.html?e=123&c=map&t=ember#s=${encodeSplits(splits)}`);
    expect(parseShareUrl(url)).toEqual({ entry: 123, card: 'map', theme: 'ember', splitsMs: splits });
    // the default colours and no splits keep the link short
    expect(shareUrl('https://x.example', { entry: 9, card: 'stats', theme: 'neon', splitsMs: null })).toBe('https://x.example/share.html?e=9&c=stats');
  });
  test('broken or hostile links: rejected, or the bad part dropped', () => {
    expect(parseShareUrl('https://x.example/share.html')).toBeNull();
    expect(parseShareUrl('https://x.example/share.html?e=0')).toBeNull();
    expect(parseShareUrl('https://x.example/share.html?e=12abc')).toBeNull();
    expect(parseShareUrl('not a url')).toBeNull();
    expect(parseShareUrl('https://x.example/share.html?e=5&c=<script>&t=pink#s=zz.-1')).toEqual({ entry: 5, card: null, theme: null, splitsMs: null });
    expect(decodeSplits('1.2.3')).toEqual([1, 3, 6]);
    expect(decodeSplits('0.5')).toBeNull();
    expect(decodeSplits('zzzzz.zzzzz.zzzzz')).toBeNull(); // past the longest lap
    expect(decodeSplits(Array(65).fill('1').join('.'))).toBeNull();
  });
  test('splits are used only if they belong to the entry’s lap', () => {
    const l = parseShareUrl(shareUrl('https://x.example', { entry: 1, card: null, theme: null, splitsMs: splits }))!;
    expect(splitsFor(l, 45_123, 4)).toEqual(splits);
    expect(splitsFor(l, 45_124, 4)).toEqual([]); // another lap (the entry was improved since)
    expect(splitsFor(l, 45_123, 13)).toEqual([]); // not one per gate of the track
  });
});

describe('QR codes', () => {
  // module matrices hashed (FNV-1a over rows of 0 / 1), from Project Nayuki's QR Code generator
  // (via uqr 0.1.2, MIT) for the same text, error correction level and automatic mask
  const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16).padStart(8, '0'); };
  const hash = (m: boolean[][]) => fnv(m.map((r) => r.map((v) => (v ? '1' : '0')).join('')).join('\n'));
  test.each([
    ['https://fpv-sim-gamma.vercel.app/share.html?e=1&c=stats', 'M', 4, 2, 'd4d4e9de'],
    ['https://fpv-sim-gamma.vercel.app/share.html?e=123456&c=map#s=2h3.4k1.6p0.8x2.b13.d9a.g0c.i8e.kq1.n2f.pa0.rr3.u1h', 'M', 7, 2, 'da8c6859'],
    ['hello é ✓', 'H', 2, 2, 'afd1d249'],
    ['x'.repeat(400), 'L', 13, 0, '49b007c9'],
  ] as const)('%s (%s)', (text, ecc, version, mask, h) => {
    const q = encodeQr(text, ecc);
    expect([q.version, q.mask, q.size]).toEqual([version, mask, version * 4 + 17]);
    expect(hash(q.modules)).toBe(h);
  });
  test('a full share link fits a small code', () => {
    const url = shareUrl('https://fpv-sim-gamma.vercel.app', { entry: 123456, card: 'board', theme: 'ember', splitsMs: Array.from({ length: 13 }, (_, i) => (i + 1) * 3471) });
    expect(encodeQr(url, 'M').version).toBeLessThanOrEqual(8);
    expect(() => encodeQr('x'.repeat(3000), 'H')).toThrow();
  });
});
