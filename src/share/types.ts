// Shared types of the lap share cards (9:16 images for Instagram Stories): what a card shows, the
// pictures it can include, the card styles and the colour themes.
import type { BoardEntry } from '../net/leaderboard';

export type CardStyle = 'stats' | 'drone' | 'fpv' | 'map' | 'board';

export const CARD_STYLES: readonly { id: CardStyle; name: string; blurb: string }[] = [
  { id: 'stats', name: 'Stats', blurb: 'Lap time, rank and the gap to the record' },
  { id: 'drone', name: 'Drone', blurb: 'A studio shot of your quad' },
  { id: 'fpv', name: 'FPV moment', blurb: 'Your goggle view as the lap finished' },
  { id: 'map', name: 'Track map', blurb: 'The course from above, with your splits' },
  { id: 'board', name: 'Leaderboard', blurb: 'The board’s top 5, your row highlighted' },
];
export const isCardStyle = (s: unknown): s is CardStyle => CARD_STYLES.some((c) => c.id === s);

/** The lap a card shows. splitsMs: time since the start at each gate after the first, the last = lapMs ([] = unknown). */
export interface ShareLap {
  map: string; course: string; cls: string;
  /** "Grand Prix Stadium", "Practice Field · Slalom" */
  track: string;
  /** the drone class's name ('5" Freestyle 6S', 'Custom') and the build summary shown on the board */
  className: string; summary: string;
  initials: string;
  lapMs: number;
  splitsMs: number[];
  /** when it was flown (ms epoch) */
  at: number;
  /** the personal best it beat, if known */
  prevMs?: number | null;
  /** its leaderboard entry, once posted */
  entryId?: number;
}

/** The lap's board (its track and class): its rank there and the ranked entries (at least the top 5). */
export interface ShareBoard { rank: number | null; total: number; top: BoardEntry[] }

/** A top-down gate: opening centre (ENU m), yaw (the opening runs along cos / sin yaw), width (m). */
export interface GatePlan { x: number; y: number; yaw: number; width: number; kind: string }

export interface Picture { image: CanvasImageSource; w: number; h: number }

/** Everything a card can show besides the lap; missing pieces leave their card out (see available()). */
export interface ShareAssets {
  board?: ShareBoard | null;
  /** studio render of the drone (transparent background), its name and a few numbers */
  drone?: (Picture & { name: string; chips: string[] }) | null;
  /** the pilot's own view as the lap finished: the FPV feed with its OSD, or a chase / line-of-sight view */
  frame?: (Picture & { view: 'fpv' | 'chase' | 'los' }) | null;
  /** the course's gates, and the line actually flown when a replay has it (ENU x / y, m) */
  course?: { gates: GatePlan[]; trail?: { x: number; y: number }[] | null } | null;
}

/** Card colours: the menu's (theme.css) and two accent variants. */
export interface Palette { id: string; name: string; bg: string; card: string; fg: string; muted: string; primary: string; secondary: string; accent: string; border: string }
export const PALETTES: readonly Palette[] = [
  { id: 'neon', name: 'Neon', bg: '#0f0f23', card: '#1e1c35', fg: '#e2e8f0', muted: '#94a3b8', primary: '#7c3aed', secondary: '#a78bfa', accent: '#f43f5e', border: 'rgba(167, 139, 250, 0.28)' },
  { id: 'ember', name: 'Ember', bg: '#1a0f0a', card: '#2a1a12', fg: '#fdf4ec', muted: '#c4a593', primary: '#ea580c', secondary: '#fdba74', accent: '#facc15', border: 'rgba(253, 186, 116, 0.28)' },
  { id: 'ice', name: 'Ice', bg: '#08141c', card: '#10232f', fg: '#e6f6fb', muted: '#8fb3c2', primary: '#0891b2', secondary: '#67e8f9', accent: '#a3e635', border: 'rgba(103, 232, 249, 0.26)' },
];
export const paletteOf = (id: string | null | undefined): Palette => PALETTES.find((p) => p.id === id) ?? PALETTES[0];

/** Which card styles can be drawn with these assets: stats always; the others need their picture or data. */
export function available(lap: ShareLap, a: ShareAssets): CardStyle[] {
  return CARD_STYLES.map((c) => c.id).filter((s) => {
    if (s === 'drone') return !!a.drone;
    if (s === 'fpv') return !!a.frame;
    if (s === 'map') return !!a.course && a.course.gates.length >= 2;
    if (s === 'board') return !!a.board && a.board.rank !== null && lap.entryId !== undefined && a.board.top.length > 0;
    return true;
  });
}
