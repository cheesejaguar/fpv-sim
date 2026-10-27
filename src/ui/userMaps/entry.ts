// The "User maps" entry points in the menus (New game's map step, Simulation → World): kept apart
// from the official map tiles, with the "User map · not reviewed" badge. Tiny and static; the
// browser itself (./browser.ts) loads on first use.
import { isUserMapId } from '../../net/protocol';
import { MAP_LIST } from '../../maps/maps';
import { el } from '../dom';

export const USER_BADGE = 'User map · not reviewed';
const badge = () => el('span', { class: 'gm-badge', style: { background: 'rgba(251, 191, 36, 0.16)', color: '#fde68a' } }, USER_BADGE);

export function openBrowser(current: string, onPick: (id: string) => void) {
  void import('./browser').then((b) => b.openUserMapBrowser({ current, onPick }), (e) => console.warn('user maps unavailable', e));
}

/** New game: below the official map tiles. The selected user map (if any) and "Browse user maps". */
export function userMapsBlock(o: { selected: string; onPick(id: string): void }): HTMLElement {
  const sel = isUserMapId(o.selected) ? MAP_LIST[o.selected] : undefined;
  return el('div', { class: 'gm-card', style: { marginTop: '14px' } },
    el('h3', { style: { margin: '0 0 6px' } }, 'User maps'),
    el('p', { class: 'gm-room-sub', style: { margin: '0 0 10px' } }, 'Made by players, not reviewed by fpv-sim, no leaderboards. Kept apart from the official maps above.'),
    sel ? el('button', { class: 'gm-tile', role: 'radio', 'aria-checked': 'true', 'data-key': `map-${o.selected}`, style: { minHeight: '0', marginBottom: '10px', width: '100%' }, onclick: () => o.onPick(o.selected) },
      el('span', { class: 'tt' }, sel.name), el('span', { class: 'ts' }, `by ${sel.community?.author ?? 'unknown'}`), el('span', { class: 'stats' }, badge())) : null,
    el('button', { class: 'gm-btn', 'data-key': 'user-maps', onclick: () => openBrowser(o.selected, o.onPick) }, sel ? 'Pick another user map…' : 'Browse user maps…'));
}

/** Simulation → World: the user map flown now (if any) and "Browse user maps". */
export function userMapsRow(current: string, onPick: (id: string) => void): HTMLElement {
  const sel = isUserMapId(current) ? MAP_LIST[current] : undefined;
  return el('div', { class: 'field' },
    el('span', { class: 'lbl' }, 'User maps'),
    el('div', {},
      sel ? el('p', { class: 'note', style: { margin: '0 0 6px' } }, el('b', {}, sel.name), ` by ${sel.community?.author ?? 'unknown'} `, badge()) : null,
      el('button', { onclick: () => openBrowser(current, onPick) }, 'Browse user maps…'),
      el('p', { class: 'note' }, 'Published by players, not reviewed by fpv-sim, separate from the official maps and their leaderboards.')));
}
