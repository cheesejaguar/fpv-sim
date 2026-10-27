// The banner over the HUD while a user map is flown: what it is, who made it, Report. It shrinks to
// the badge after a few seconds so it doesn't cover the view.
import './userMaps.css';
import { el } from '../dom';
import { BADGE_TEXT, reportDialog } from './dialogs';

export function userMapBanner(m: { id: string; name: string; author: string }): HTMLElement {
  const b = el('div', { class: 'um-banner', role: 'note', 'aria-label': BADGE_TEXT },
    el('span', {}, `⚠ ${BADGE_TEXT}`),
    el('span', { class: 'name more' }, `${m.name} by ${m.author}`),
    el('button', { tabindex: -1, onclick: (e: Event) => { (e.currentTarget as HTMLElement).blur(); void reportDialog(m); } }, 'Report'));
  setTimeout(() => b.classList.add('small'), 8000);
  return b;
}
