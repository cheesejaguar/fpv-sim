// Display-name hygiene shared by the relay (pilot / room names) and the directory (server browser).
// Names reach every pilot's screen and the public room list, so: fold look-alike forms (NFKC), drop
// invisible and control characters (bidi overrides, zero-width joiners, private-use glyphs, the
// "blank" Hangul / Braille letters), cap stacked combining marks (Zalgo), collapse whitespace, cut to
// length by code point (never half a surrogate pair), and refuse a small blocklist.

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u115f\u1160\u3164\uffa0\u2800<>]/gu;
const STACKED_MARKS = /(\p{M}{2})\p{M}+/gu;

// Matched against a "skeleton" (lower case, accents and leetspeak folded), with letter runs squeezed
// to one and to two ("fuuuck", "niggggr"), so the entries themselves stay spelled normally and real
// words that merely look close ("Niger", "grape", "badminton") pass. Kept short on purpose.
const LEET: Record<string, string> = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i' };
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[0-9@$!|]/g, (c) => LEET[c] ?? c);
const BLOCK_SUBSTR = ['nigger', 'nigga', 'faggot', 'fuck', 'cunt', 'hitler', 'retard', 'whitepower'];
const BLOCK_WORD = new Set(['fag', 'kike', 'chink', 'spic', 'nazi', 'heil', 'rape', 'shit', 'tranny', 'admin', 'moderator']);

export function blocked(s: string): boolean {
  const k = fold(s);
  for (const v of [k.replace(/(.)\1+/g, '$1'), k.replace(/(.)\1\1+/g, '$1$1')]) {
    const letters = v.replace(/[^\p{L}]/gu, '');
    if (BLOCK_SUBSTR.some((w) => letters.includes(w)) || v.split(/[^\p{L}]+/u).some((w) => BLOCK_WORD.has(w))) return true;
  }
  return false;
}

/** Cleaned display name ('' if nothing printable is left or it is on the blocklist). */
export function cleanDisplayName(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  const t = s.slice(0, 512).normalize('NFKC').replace(/[\t\n\v\f\r\u2028\u2029]/g, ' ').replace(INVISIBLE, '')
    .replace(STACKED_MARKS, '$1').replace(/\s+/gu, ' ').trim();
  const cut = Array.from(t).slice(0, max).join('').trim();
  return cut && !blocked(cut) ? cut : '';
}
