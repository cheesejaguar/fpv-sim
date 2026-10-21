// Multiplayer tab: pilot name / colour, create or join a room by code, invite link, roster, latency.
import { multiplayerUrl, setMultiplayerUrl } from '../net/config';
import { MultiplayerClient, randomRoomCode } from '../net/multiplayer';
import { el, section } from './dom';

export interface PilotPrefs { name: string; color: string }

export function loadPilot(): PilotPrefs {
  try { const s = localStorage.getItem('fpv-pilot'); if (s) return { name: 'Pilot', color: '#ff7a1a', ...JSON.parse(s) }; } catch { /* ignore */ }
  return { name: 'Pilot', color: '#ff7a1a' };
}
export function savePilot(p: PilotPrefs) { try { localStorage.setItem('fpv-pilot', JSON.stringify(p)); } catch { /* ignore */ } }

export function inviteLink(code: string): string {
  const u = new URL(location.href);
  u.search = ''; u.hash = '';
  u.searchParams.set('room', code);
  return u.toString();
}

export function multiplayerPanel(mp: MultiplayerClient, join: (code: string) => void): HTMLElement {
  const root = el('div', { class: 'panel mp' });
  const pilot = loadPilot();

  const render = () => {
    const nameIn = el('input', { value: pilot.name, maxlength: 20, oninput: () => { pilot.name = nameIn.value; savePilot(pilot); } }) as HTMLInputElement;
    const colorIn = el('input', { type: 'color', value: pilot.color, oninput: () => { pilot.color = colorIn.value; savePilot(pilot); } }) as HTMLInputElement;
    const codeIn = el('input', { placeholder: 'ROOM CODE', maxlength: 8, style: { textTransform: 'uppercase', width: '9em' } }) as HTMLInputElement;
    const urlIn = el('input', { value: multiplayerUrl() ?? '', placeholder: 'wss://your-relay.workers.dev' }) as HTMLInputElement;
    const server = multiplayerUrl();
    const statusText = mp.status === 'connected' ? `Connected to room ${mp.room} · ${mp.peers.size + 1} pilot(s) · ping ${mp.latencyMs ? Math.round(mp.latencyMs) + ' ms' : '…'}`
      : mp.status === 'connecting' ? `Connecting to room ${mp.room}…` : mp.error || 'Not in a room.';
    root.replaceChildren(el('div', { class: 'cols' },
      el('div', { class: 'col' },
        section('Pilot',
          el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Name'), nameIn),
          el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Colour'), colorIn),
          el('p', { class: 'note' }, 'Changes apply the next time you join a room.'),
        ),
        section('Room',
          el('p', { class: mp.status === 'error' ? 'warn' : 'status' }, statusText),
          mp.connected
            ? el('div', {},
              el('p', {}, 'Invite link — anyone who opens it joins this room:'),
              el('div', { class: 'actions' },
                el('input', { value: inviteLink(mp.room!), readonly: true, style: { flex: '1' }, onclick: (e: Event) => (e.target as HTMLInputElement).select() }),
                el('button', { onclick: () => void navigator.clipboard?.writeText(inviteLink(mp.room!)) }, 'Copy')),
              el('div', { class: 'actions' }, el('button', { onclick: () => { mp.leave(); render(); } }, 'Leave room')))
            : el('div', {},
              el('div', { class: 'actions' },
                el('button', { class: 'primary', disabled: !server, onclick: () => { join(randomRoomCode()); render(); } }, 'Create room')),
              el('div', { class: 'actions' }, codeIn,
                el('button', { disabled: !server, onclick: () => { const c = codeIn.value.trim().toUpperCase(); if (/^[A-Z0-9]{4,8}$/.test(c)) { join(c); render(); } } }, 'Join'))),
        ),
      ),
      el('div', { class: 'col' },
        section('Pilots in the room',
          mp.connected
            ? el('table', { class: 'kv' },
              el('tr', {}, el('td', {}, `● ${pilot.name} (you)`), el('td', {}, '')),
              ...[...mp.peers.values()].map((p) => el('tr', {},
                el('td', {}, el('span', { style: { color: p.info.color } }, '● '), p.info.name),
                el('td', {}, p.lap ? `lap ${p.lap.lap} · best ${p.lap.best ? p.lap.best.toFixed(2) + ' s' : '--'}` : p.info.frame))))
            : el('p', { class: 'note' }, 'Join a room to see who is flying.'),
        ),
        section('How it works',
          el('ul', {},
            el('li', {}, 'Up to 8 pilots per room. Everyone flies their own quad with their own Betaflight; the room shares positions 30 times a second.'),
            el('li', {}, 'Quads pass through each other (no collisions between pilots).'),
            el('li', {}, 'The room shares one map: joining switches you to it, and changing the map in Simulation switches everyone.'),
            el('li', {}, 'Lap times on the race course are shown live to everyone in the room.'),
          )),
      ),
      el('div', { class: 'col' },
        section('Server',
          el('p', { class: 'note' }, server ? `Relay: ${server}` : 'No multiplayer relay is configured for this site yet. Enter a relay URL (a deployed copy of the server/ worker) to enable rooms.'),
          el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Relay URL'), urlIn),
          el('div', { class: 'actions' },
            el('button', { onclick: () => { const v = urlIn.value.trim(); setMultiplayerUrl(/^wss?:\/\//.test(v) ? v : null); render(); } }, 'Save'),
            el('button', { onclick: () => { setMultiplayerUrl(null); render(); } }, 'Use default')),
        ),
      ),
    ));
  };
  render();
  // re-render on room changes until this panel is removed from the page
  let attached = false;
  mp.listen(() => { if (root.isConnected) { attached = true; render(); return true; } return !attached; });
  return root;
}
