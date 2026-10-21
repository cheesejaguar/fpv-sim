// "Send to my phone" links: /share.html?e=<leaderboard entry id>&c=<card style>[&t=<colour>]#s=<splits>.
// The phone fetches the public entry (GET /leaderboard/entry/:id) and draws the same cards on its
// own. The gate splits aren't public on the board, so the pilot's own link carries them after the
// "#", which browsers never send to a server; the phone uses them only if they add up to the
// entry's lap time.
import { MAX_LAP_MS } from '../../server/src/leaderboardCore';
import { CardStyle, isCardStyle, paletteOf } from './types';

export interface ShareLink { entry: number; card: CardStyle | null; theme: string | null; splitsMs: number[] | null }

export const SHARE_PAGE = 'share.html';
const MAX_SPLITS = 64;

/** Cumulative splits -> "#s=" value: the gaps between them in base 36, dot-separated. */
export function encodeSplits(splitsMs: number[]): string {
  return splitsMs.map((s, i) => Math.round(s - (i ? splitsMs[i - 1] : 0)).toString(36)).join('.');
}

export function decodeSplits(v: string): number[] | null {
  const parts = v.split('.');
  if (!parts.length || parts.length > MAX_SPLITS || !parts.every((x) => /^[0-9a-z]{1,5}$/.test(x))) return null;
  let t = 0;
  const out: number[] = [];
  for (const x of parts) {
    const d = parseInt(x, 36);
    if (!(d > 0)) return null;
    t += d;
    if (t > MAX_LAP_MS) return null;
    out.push(t);
  }
  return out;
}

export function shareUrl(origin: string, l: ShareLink): string {
  const q = new URLSearchParams({ e: String(l.entry) });
  if (l.card) q.set('c', l.card);
  if (l.theme && paletteOf(l.theme).id === l.theme && l.theme !== 'neon') q.set('t', l.theme);
  const hash = l.splitsMs?.length ? `#s=${encodeSplits(l.splitsMs)}` : '';
  return `${origin.replace(/\/$/, '')}/${SHARE_PAGE}?${q}${hash}`;
}

/** Read a share link (null: not one). Unknown card styles and colours are dropped, not fatal. */
export function parseShareUrl(href: string): ShareLink | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  const e = u.searchParams.get('e') ?? '';
  if (!/^[1-9]\d{0,11}$/.test(e)) return null;
  const c = u.searchParams.get('c'), t = u.searchParams.get('t');
  const s = new URLSearchParams(u.hash.slice(1)).get('s');
  return { entry: Number(e), card: isCardStyle(c) ? c : null, theme: t && paletteOf(t).id === t ? t : null, splitsMs: s ? decodeSplits(s) : null };
}

/** The link's splits, if they belong to this lap (one per gate, ending on the lap time). */
export function splitsFor(l: ShareLink, lapMs: number, gates: number | null): number[] {
  const s = l.splitsMs;
  if (!s || s[s.length - 1] !== lapMs || (gates !== null && s.length !== gates)) return [];
  return s;
}
