// The publish dialog (the map editor's Publish button): what is published under which licence, the
// rights confirmation, listed or unlisted, the user-map disclaimer, progress, and the share link.
import './userMaps.css';
import type { MapMeta } from '../../maps/mapDoc';
import { MapFormatError } from '../../maps/mapError';
import { publishPackage } from '../../net/userMaps';
import { el, openModal } from '../dom';
import { BADGE_TEXT, userBadge } from './dialogs';

const RIGHTS = 'I made this map or have the right to share every asset in it under the licence shown';

/** Resolves { id } once published (the pilot closed the result), or null when cancelled. */
export function publishDialog(files: Map<string, Blob>, meta: MapMeta): Promise<{ id: string } | null> {
  return new Promise((resolve) => {
    let result: { id: string } | null = null, busy = false;
    const card = el('div', { class: 'gm-modal-card' });
    const finish = () => { if (busy) return; modal.close(); resolve(result); };
    const bytes = [...files.values()].reduce((s, b) => s + b.size, 0);
    const rights = el('input', { type: 'checkbox', 'aria-describedby': 'um-rights', onchange: () => { go.disabled = !rights.checked; } }) as HTMLInputElement;
    let listed = false;
    const choice = (value: boolean, title: string, sub: string) => el('label', {},
      el('input', { type: 'radio', name: 'um-listed', checked: value === listed, onchange: () => { listed = value; } }),
      el('span', {}, title, el('small', {}, sub)));
    const status = el('div', { class: 'um-status', role: 'status', 'aria-live': 'polite' });
    const cancel = el('button', { class: 'gm-btn ghost', onclick: finish }, 'Cancel') as HTMLButtonElement;
    const go = el('button', { class: 'gm-btn primary', disabled: true, onclick: () => void publish() }, 'Publish') as HTMLButtonElement;
    const form = el('div', {},
      el('div', { class: 'um-radio', role: 'radiogroup', 'aria-label': 'Visibility' },
        choice(false, 'Unlisted', 'Only people with the link, and rooms you host, can open it.'),
        choice(true, 'Listed', 'Also shown to everyone under User maps.')),
      el('label', { class: 'um-check', id: 'um-rights' }, rights, el('span', {}, `${RIGHTS}: `, el('b', {}, meta.license), '.')));
    card.append(
      el('h2', {}, 'Publish map'), userBadge(),
      el('dl', { class: 'um-kv', style: { marginTop: '12px' } },
        el('dt', {}, 'Map'), el('dd', {}, meta.name),
        el('dt', {}, 'By'), el('dd', {}, meta.author),
        el('dt', {}, 'Licence'), el('dd', {}, meta.license),
        el('dt', {}, 'Version'), el('dd', {}, meta.version),
        el('dt', {}, 'Package'), el('dd', {}, `${files.size} file${files.size === 1 ? '' : 's'}, ${(bytes / 1048576).toFixed(1)} MiB`)),
      el('div', { class: 'gm-callout warn' }, el('p', {}, `Published maps are user maps: they show as “${BADGE_TEXT}”, are kept apart from the official maps and never count on the official leaderboards. fpv-sim does not review them and may remove them; anyone with the link can download the package. Publishing the same files again gives the same link.`)),
      form, status,
      el('div', { class: 'gm-actions' }, cancel, go));

    const publish = async () => {
      if (!rights.checked) return;
      busy = true; go.disabled = cancel.disabled = true;
      form.querySelectorAll('input').forEach((i) => { (i as HTMLInputElement).disabled = true; });
      try {
        const r = await publishPackage(files, { listed, onProgress: (s) => { status.textContent = s; } });
        result = { id: r.id };
        const link = el('input', { class: 'gm-input', readonly: true, value: r.url, 'aria-label': 'Share link', onfocus: (e: Event) => (e.target as HTMLInputElement).select() }) as HTMLInputElement;
        const copyBtn = el('button', { class: 'gm-btn', onclick: async () => { try { await navigator.clipboard.writeText(r.url); copyBtn.textContent = 'Copied'; } catch { link.select(); copyBtn.textContent = 'Press Ctrl+C'; } } }, 'Copy') as HTMLButtonElement;
        status.replaceChildren(
          el('p', {}, r.existing ? 'These exact files were published before: here is their link.' : `Published${r.listed ? ' and listed' : ' (unlisted)'}. Share the link, or pick the map as a room host: pilots in the room are asked before it loads.`),
          el('div', { class: 'um-link' }, link, copyBtn),
          el('p', {}, `Map id: ${r.id}`),
          ...(r.warnings.length ? [el('ul', { class: 'um-errors' }, ...r.warnings.map((w) => el('li', {}, w)))] : []));
        form.remove(); go.remove();
        cancel.textContent = 'Done'; cancel.className = 'gm-btn primary';
      } catch (e) {
        const errs = e instanceof MapFormatError ? e.errors : [String((e as Error)?.message ?? e)];
        status.replaceChildren(el('p', {}, e instanceof MapFormatError ? 'The map can’t be published yet:' : 'Publishing failed:'), el('ul', { class: 'um-errors' }, ...errs.map((x) => el('li', {}, x))));
        form.querySelectorAll('input').forEach((i) => { (i as HTMLInputElement).disabled = false; });
        go.disabled = !rights.checked;
      } finally {
        busy = false; cancel.disabled = false;
      }
    };
    const modal = openModal({ label: 'Publish map', card, onCancel: finish, className: 'um' });
  });
}
