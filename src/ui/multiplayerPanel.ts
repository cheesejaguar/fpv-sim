// Multiplayer tab: pilot name / colour, create or join a room by code, invite link, roster, latency.
// Built once; room events only update the status line, the room box (when the connection state
// changes) and the roster rows in place, so whatever is being typed survives laps and joins.
import { multiplayerUrl, setMultiplayerUrl } from '../net/config';
import { MultiplayerClient, Peer, randomRoomCode } from '../net/multiplayer';
import { PROTOCOL, versionNote } from '../net/protocol';
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

/** One-line connection status (shared with the menu). */
export function mpStatusText(mp: MultiplayerClient): string {
  switch (mp.status) {
    case 'connected': return `Connected to room ${mp.room} · ${mp.peers.size + 1} pilot(s) · ping ${mp.latencyMs ? Math.round(mp.latencyMs) + ' ms' : '…'}`;
    case 'connecting': return `Connecting to room ${mp.room}…`;
    case 'reconnecting': return mp.error || `Reconnecting to room ${mp.room}…`;
    case 'error': return mp.error || 'Could not join the room.';
    default: return 'Not in a room.';
  }
}

export function multiplayerPanel(mp: MultiplayerClient, join: (code: string) => void): HTMLElement {
  const root = el('div', { class: 'panel mp' });
  const pilot = loadPilot();
  const nameIn = el('input', { value: pilot.name, maxlength: 20, oninput: () => { pilot.name = nameIn.value; savePilot(pilot); } }) as HTMLInputElement;
  const colorIn = el('input', { type: 'color', value: pilot.color, oninput: () => { pilot.color = colorIn.value; savePilot(pilot); } }) as HTMLInputElement;
  const codeIn = el('input', { placeholder: 'ROOM CODE', maxlength: 8, style: { textTransform: 'uppercase', width: '9em' } }) as HTMLInputElement;
  const urlIn = el('input', { value: multiplayerUrl() ?? '', placeholder: 'wss://your-relay.workers.dev' }) as HTMLInputElement;
  const status = el('p', { class: 'status', role: 'status' });
  const relayNote = el('p', { class: 'note' });
  const roomBox = el('div');
  const roster = el('tbody');
  const rosterBox = el('div');
  const serverNote = el('p', { class: 'note' });

  const joinCode = () => { const c = codeIn.value.trim().toUpperCase(); if (/^[A-Z0-9]{4,8}$/.test(c)) join(c); };
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinCode(); });
  const createBtn = el('button', { class: 'primary', onclick: () => join(randomRoomCode()) }, 'Create room') as HTMLButtonElement;
  const joinBtn = el('button', { onclick: joinCode }, 'Join') as HTMLButtonElement;
  const outBox = el('div', {},
    el('div', { class: 'actions' }, createBtn),
    el('div', { class: 'actions' }, codeIn, joinBtn));

  // the room box only changes shape with the connection state (in a room / failed / not in one)
  let shape = '';
  const drawRoom = () => {
    const inRoom = mp.status === 'connected' || mp.status === 'reconnecting';
    const s = inRoom ? `in:${mp.room}` : mp.status === 'error' && mp.room ? `err:${mp.room}` : mp.status === 'connecting' ? 'busy' : 'out';
    const server = multiplayerUrl();
    createBtn.disabled = joinBtn.disabled = !server || mp.status === 'connecting';
    if (s === shape) return;
    shape = s;
    const leave = el('button', { onclick: () => mp.leave() }, 'Leave room');
    if (inRoom) {
      const link = inviteLink(mp.room!);
      roomBox.replaceChildren(
        el('p', {}, 'Invite link — anyone who opens it joins this room:'),
        el('div', { class: 'actions' },
          el('input', { value: link, readonly: true, style: { flex: '1' }, onclick: (e: Event) => (e.target as HTMLInputElement).select() }),
          el('button', { onclick: () => void navigator.clipboard?.writeText(link) }, 'Copy')),
        el('div', { class: 'actions' }, leave));
    } else if (s.startsWith('err:')) {
      roomBox.replaceChildren(el('div', { class: 'actions' }, el('button', { class: 'primary', onclick: () => mp.retry() }, 'Retry'), leave), outBox);
    } else roomBox.replaceChildren(outBox);
  };

  const rows = new Map<number, { tr: HTMLTableRowElement; info: HTMLElement }>();
  const peerText = (p: Peer) => {
    const lap = p.lap ? `lap ${p.lap.lap} · best ${p.lap.best ? p.lap.best.toFixed(2) + ' s' : '--'}` : p.info.frame;
    const v = versionNote(p.info.v);
    return v ? `${lap} · ${v}` : lap;
  };
  const me = el('td');
  let tableShown: boolean | null = null;
  const drawRoster = () => {
    const inRoom = mp.status === 'connected' || mp.status === 'reconnecting';
    if (inRoom !== tableShown) {
      tableShown = inRoom; rows.clear();
      roster.replaceChildren(el('tr', {}, me, el('td', {}, '')));
      rosterBox.replaceChildren(inRoom ? el('table', { class: 'kv' }, roster) : el('p', { class: 'note' }, 'Join a room to see who is flying.'));
    }
    if (!inRoom) return;
    me.textContent = `● ${pilot.name} (you)`;
    for (const [id, r] of rows) if (!mp.peers.has(id)) { r.tr.remove(); rows.delete(id); }
    for (const [id, p] of mp.peers) {
      let r = rows.get(id);
      if (!r) {
        const info = el('td');
        r = { tr: el('tr', {}, el('td', {}, el('span', { style: { color: p.info.color } }, '● '), p.info.name), info), info };
        rows.set(id, r); roster.append(r.tr);
      }
      const t = peerText(p);
      if (r.info.textContent !== t) r.info.textContent = t;
    }
  };

  const refresh = () => {
    status.textContent = mpStatusText(mp);
    status.className = mp.status === 'error' || mp.status === 'reconnecting' ? 'warn' : 'status';
    relayNote.textContent = mp.connected && mp.relayV && mp.relayV < PROTOCOL ? 'This room server runs an older version: other pilots’ props show average RPM only.' : '';
    drawRoom(); drawRoster();
  };
  const drawServer = () => {
    const server = multiplayerUrl();
    serverNote.textContent = server ? `Relay: ${server}` : 'No multiplayer relay is configured for this site yet. Enter a relay URL (a deployed copy of the server/ worker) to enable rooms.';
    urlIn.value = server ?? '';
    refresh();
  };

  root.append(el('div', { class: 'cols' },
    el('div', { class: 'col' },
      section('Pilot',
        el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Name'), nameIn),
        el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Colour'), colorIn),
        el('p', { class: 'note' }, 'Changes apply the next time you join a room.'),
      ),
      section('Room', status, relayNote, roomBox),
    ),
    el('div', { class: 'col' },
      section('Pilots in the room', rosterBox),
      section('How it works',
        el('ul', {},
          el('li', {}, 'Up to 8 pilots per room. Everyone flies their own quad with their own Betaflight; the room shares positions 30 times a second.'),
          el('li', {}, 'Quads pass through each other (no collisions between pilots).'),
          el('li', {}, 'The room shares one map: joining switches you to it, and changing the map in Simulation switches everyone. Maps loaded from disk are never shared.'),
          el('li', {}, 'Lap times on the race course are shown live to everyone in the room.'),
          el('li', {}, 'If the connection drops, the sim reconnects on its own (5 tries).'),
        )),
    ),
    el('div', { class: 'col' },
      section('Server',
        serverNote,
        el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Relay URL'), urlIn),
        el('div', { class: 'actions' },
          el('button', { onclick: () => { const v = urlIn.value.trim(); setMultiplayerUrl(/^wss?:\/\//.test(v) ? v : null); drawServer(); } }, 'Save'),
          el('button', { onclick: () => { setMultiplayerUrl(null); drawServer(); } }, 'Use default')),
      ),
    ),
  ));
  drawServer();
  // update on room changes (and the ping readout once a second) until this panel leaves the page
  let attached = false, waited = 0;
  const live = () => { if (root.isConnected) { attached = true; refresh(); return true; } return !attached; };
  mp.listen(live);
  const tick = setInterval(() => { if (!live() || (!attached && ++waited > 10)) clearInterval(tick); }, 1000);
  return root;
}
