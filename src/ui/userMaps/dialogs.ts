// User-map dialogs: the one-time disclaimer (inside the first consent card), consent cards before a
// user map loads (a ?map= link, a room host's pick, the browser), and reporting.
import './userMaps.css';
import { load, save } from '../../app/persist';
import { reportUserMap } from '../../net/userMaps';
import { el, openModal } from '../dom';

const DISCLAIMER_KEY = 'fpv-usermaps-disclaimer';
export const BADGE_TEXT = 'User map · not reviewed';
export const DISCLAIMER = 'User maps are made by players and are not reviewed by fpv-sim. They may be removed at any time and come with no warranty: a map can be broken, inaccurate, or show something you would rather not see. Use Report if a map breaks the rules or uses someone else’s work without permission. User maps never count on the official leaderboards.';

export const disclaimerAccepted = () => load(DISCLAIMER_KEY, (r) => r === true);
export const acceptDisclaimer = () => save(DISCLAIMER_KEY, true);

export const userBadge = () => el('span', { class: 'um-badge' }, BADGE_TEXT);

export interface MapCardInfo { id: string; name: string; author: string; license?: string; description?: string }

function mapFacts(m: MapCardInfo): HTMLElement {
  return el('dl', { class: 'um-kv' },
    el('dt', {}, 'Map'), el('dd', {}, m.name),
    el('dt', {}, 'By'), el('dd', {}, m.author),
    ...(m.license ? [el('dt', {}, 'Licence'), el('dd', {}, m.license)] : []),
    ...(m.description ? [el('dt', {}, 'About'), el('dd', {}, m.description)] : []),
    el('dt', {}, 'Id'), el('dd', {}, m.id));
}

/**
 * Ask before a user map loads. The first time, the card carries the disclaimer and accepting it is
 * the pilot's agreement. Resolves true to load.
 */
export function consentDialog(o: { title: string; lead?: string; map: MapCardInfo; ok?: string; cancel?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const first = !disclaimerAccepted();
    const card = el('div', { class: 'gm-modal-card' });
    const finish = (ok: boolean) => { m.close(); if (ok) acceptDisclaimer(); resolve(ok); };
    const okBtn = el('button', { class: 'gm-btn primary', 'data-autofocus': true, onclick: () => finish(true) }, o.ok ?? (first ? 'I understand, load it' : 'Load'));
    card.append(
      el('h2', {}, o.title),
      userBadge(),
      o.lead ? el('p', { style: { marginTop: '12px' } }, o.lead) : el('div', { style: { height: '12px' } }),
      mapFacts(o.map),
      el('div', { class: 'gm-callout warn' }, el('p', {}, first ? DISCLAIMER : 'Made by a player, not reviewed by fpv-sim, no warranty. You can report it from the user map list.')),
      el('div', { class: 'gm-actions' }, el('button', { class: 'gm-btn ghost', onclick: () => finish(false) }, o.cancel ?? 'Cancel'), okBtn));
    const m = openModal({ label: o.title, card, onCancel: () => finish(false), className: 'um' });
  });
}

/** A message card (OK only). */
export function notice(title: string, body: string | Node): Promise<void> {
  return new Promise((resolve) => {
    const card = el('div', { class: 'gm-modal-card' });
    const done = () => { m.close(); resolve(); };
    card.append(el('h2', {}, title), typeof body === 'string' ? el('p', {}, body) : body,
      el('div', { class: 'gm-actions' }, el('button', { class: 'gm-btn primary', 'data-autofocus': true, onclick: done }, 'OK')));
    const m = openModal({ label: title, card, onCancel: done, className: 'um' });
  });
}

const REASONS = [
  { id: 'copyright', label: 'Uses someone else’s work without permission' },
  { id: 'offensive', label: 'Offensive or inappropriate' },
  { id: 'broken', label: 'Broken or misleading' },
  { id: 'other', label: 'Something else' },
] as const;

/** Report a user map to the relay (hidden after several pilots report it). */
export function reportDialog(m: { id: string; name: string }): Promise<void> {
  return new Promise((resolve) => {
    const card = el('div', { class: 'gm-modal-card' });
    const status = el('p', { class: 'um-status', role: 'status' });
    let reason: (typeof REASONS)[number]['id'] = 'copyright';
    const radios = el('div', { class: 'um-radio', role: 'radiogroup', 'aria-label': 'Reason' }, ...REASONS.map((r, i) => {
      const input = el('input', { type: 'radio', name: 'um-reason', value: r.id, checked: i === 0, onchange: () => { reason = r.id; } });
      return el('label', {}, input, el('span', {}, r.label));
    }));
    const done = () => { modal.close(); resolve(); };
    const send = el('button', { class: 'gm-btn danger', onclick: async () => {
      send.disabled = true; status.textContent = 'Sending…';
      const r = await reportUserMap(m.id, reason);
      if (r.ok) { status.textContent = 'Thanks: the report was sent. Maps that several pilots report are hidden until they are reviewed.'; send.remove(); cancel.textContent = 'Close'; }
      else { status.textContent = `The report was not sent: ${r.error}`; send.disabled = false; }
    } }, 'Send report') as HTMLButtonElement;
    const cancel = el('button', { class: 'gm-btn ghost', 'data-autofocus': true, onclick: done }, 'Cancel');
    card.append(el('h2', {}, `Report “${m.name}”`), el('p', {}, 'Why should this user map be looked at?'), radios, status, el('div', { class: 'gm-actions' }, cancel, send));
    const modal = openModal({ label: 'Report a user map', card, onCancel: done, className: 'um' });
  });
}
