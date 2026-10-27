// The "User maps" browser: maps players published (newest, most downloaded, search), the ones on
// this device, opening one by id or link, removing it from this device, reporting it. Opened from
// New game → map step and Simulation → World; never mixed into the official map tiles.
import './userMaps.css';
import { cachedUserMaps, CachedUserMap, fetchUserMap, listUserMaps, parseMapRef, previewUrl, removeCachedUserMap, shareLink, userMapInfo, UserMapSummary } from '../../net/userMaps';
import { el, openModal } from '../dom';
import { consentDialog, disclaimerAccepted, notice, reportDialog, userBadge } from './dialogs';

const kib = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`);

async function copy(text: string, btn: HTMLElement) {
  const was = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = was; }, 1500);
}

/** A small modal while something loads; returns its close(). */
function busy(text: string): () => void {
  const card = el('div', { class: 'gm-modal-card' }, el('h2', {}, 'User map'), el('p', { role: 'status' }, text));
  const m = openModal({ label: text, card, onCancel: () => {}, className: 'um' });
  return m.close;
}

/**
 * Load user map `id` after the pilot agrees: a consent card (with the disclaimer the first time),
 * skipped for a map already on this device once the disclaimer is accepted. Resolves the map id
 * once it is registered, or null (declined, or it failed: the pilot was told why).
 */
export async function confirmAndFetch(id: string, o: { title?: string; lead?: string; known?: UserMapSummary | null } = {}): Promise<string | null> {
  const onDevice = (await cachedUserMaps()).find((m) => m.id === id);
  if (!(onDevice && disclaimerAccepted())) {
    let info: { id: string; name: string; author: string; license?: string; description?: string } | null = o.known ?? onDevice ?? null;
    if (!info) {
      const done = busy('Looking up the map…');
      const r = await userMapInfo(id);
      done();
      if (!r.map) { await notice('User map unavailable', r.error ?? 'The map could not be found.'); return null; }
      if (r.map.status !== 'ok') { await notice('User map unavailable', r.map.status === 'hidden' ? 'This user map is hidden after reports while it is reviewed.' : 'This user map was removed.'); return null; }
      info = r.map;
    }
    if (!(await consentDialog({ title: o.title ?? 'Load a user map?', lead: o.lead, map: info }))) return null;
  }
  const done = busy('Loading the user map…');
  try { await fetchUserMap(id); return id; }
  catch (e) { done(); await notice('The user map could not be loaded', String((e as Error)?.message ?? e)); return null; }
  finally { done(); }
}

type Tab = 'device' | 'new' | 'popular';
let lastTab: Tab = 'new';

/** The browser modal. onPick: a user map was loaded and registered (select it). */
export function openUserMapBrowser(o: { current?: string; onPick(id: string): void }): void {
  const card = el('div', { class: 'gm-modal-card wide' });
  const close = () => modal.close();
  const status = el('p', { class: 'um-status', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'um-list' });
  const more = el('button', { class: 'gm-btn ghost', style: { display: 'none' }, onclick: () => void fill(false) }, 'Load more') as HTMLButtonElement;
  const q = el('input', { class: 'gm-input', placeholder: 'Search by name or author', 'aria-label': 'Search user maps', maxlength: 64 }) as HTMLInputElement;
  const ref = el('input', { class: 'gm-input', placeholder: 'Map id (u-…) or link', 'aria-label': 'User map id or link', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  let tab: Tab = lastTab, cursor: string | null = null, seq = 0;
  const tabs = el('div', { class: 'gm-tabs', role: 'tablist' });
  const drawTabs = () => tabs.replaceChildren(...([['new', 'Newest'], ['popular', 'Most flown'], ['device', 'On this device']] as [Tab, string][]).map(([id, label]) =>
    el('button', { class: 'gm-tab', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = lastTab = id; drawTabs(); void fill(true); } }, label)));

  const pick = async (id: string, known?: UserMapSummary | null) => {
    const got = await confirmAndFetch(id, { known });
    if (got) { close(); o.onPick(got); }
  };
  const mapCard = (m: UserMapSummary | CachedUserMap, cached: boolean) => {
    const s = 'downloads' in m ? m : null;
    const linkBtn = el('button', { class: 'gm-btn sm ghost', onclick: () => void copy(shareLink(m.id), linkBtn) }, 'Copy link');
    return el('div', { class: 'um-card' },
      s?.preview ? el('img', { src: previewUrl(m.id), alt: '', loading: 'lazy', onerror: (e: Event) => (e.target as HTMLElement).remove() }) : null,
      el('span', { class: 'tt' }, m.name),
      el('span', { class: 'ts' }, `by ${m.author} · ${m.license}`),
      el('span', { class: 'ts' }, [kib(m.size), s ? `${s.downloads} download${s.downloads === 1 ? '' : 's'}` : 'on this device', s?.version ? `v${s.version}` : ''].filter(Boolean).join(' · ')),
      s?.description ? el('span', { class: 'ts' }, s.description.length > 140 ? s.description.slice(0, 137) + '…' : s.description) : null,
      userBadge(),
      el('div', { class: 'gm-actions' },
        el('button', { class: 'gm-btn sm primary', onclick: () => void pick(m.id, s) }, o.current === m.id ? 'Selected' : 'Pick'),
        linkBtn,
        el('button', { class: 'gm-btn sm ghost', onclick: () => void reportDialog(m) }, 'Report'),
        cached ? el('button', { class: 'gm-btn sm ghost', onclick: async () => { await removeCachedUserMap(m.id); void fill(true); } }, 'Remove') : null));
  };

  const fill = async (reset: boolean) => {
    const n = ++seq;
    if (reset) { cursor = null; list.replaceChildren(); }
    more.style.display = 'none';
    if (tab === 'device') {
      const term = q.value.trim().toLowerCase();
      const maps = (await cachedUserMaps()).filter((m) => !term || m.name.toLowerCase().includes(term) || m.author.toLowerCase().includes(term));
      if (n !== seq) return;
      list.replaceChildren(...maps.map((m) => mapCard(m, true)));
      status.textContent = maps.length ? `${maps.length} user map${maps.length === 1 ? '' : 's'} kept on this device.` : 'No user maps on this device yet.';
      return;
    }
    status.textContent = 'Loading…';
    const r = await listUserMaps({ sort: tab, cursor, q: q.value.trim() });
    if (n !== seq) return;
    if (r.error) { status.textContent = `Could not load user maps: ${r.error}`; return; }
    list.append(...r.maps.map((m) => mapCard(m, false)));
    cursor = r.next;
    more.style.display = r.next ? '' : 'none';
    status.textContent = list.childElementCount ? '' : q.value.trim() ? 'No user map matches.' : 'No user maps have been published yet.';
  };
  let qTimer: ReturnType<typeof setTimeout> | undefined;
  q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => void fill(true), 300); });
  const openRef = () => {
    const id = parseMapRef(ref.value);
    if (!id) { status.textContent = 'That is not a user map id (u-…) or a link with ?map=u-….'; ref.focus(); return; }
    void pick(id);
  };
  ref.addEventListener('keydown', (e) => { if (e.key === 'Enter') openRef(); });

  card.append(
    el('h2', {}, 'User maps'), userBadge(),
    el('p', { style: { marginTop: '10px' } }, 'Maps published by players. They are not reviewed by fpv-sim and are kept apart from the official maps: they have no leaderboards (your personal bests are kept on this device). Publish your own from the map editor.'),
    el('div', { class: 'um-link' }, ref, el('button', { class: 'gm-btn', onclick: openRef }, 'Open')),
    tabs, el('div', { class: 'um-row' }, q), status, list, more,
    el('div', { class: 'gm-actions' }, el('button', { class: 'gm-btn ghost', 'data-autofocus': true, onclick: close }, 'Close')));
  const modal = openModal({ label: 'User maps', card, onCancel: close, className: 'um' });
  drawTabs();
  void fill(true);
}
