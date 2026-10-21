// Live multiplayer client. Every pilot runs their own full simulation (physics + Betaflight); the
// room relay only carries compact pose updates (30 Hz), roster changes, the shared map, and laps.
// Remote quads are rendered ~100 ms in the past and interpolated between received poses, which hides
// network jitter. There are no physical collisions between pilots (ghost-style flying).
import { multiplayerUrl } from './config';

export interface PeerInfo { id: number; name: string; color: string; frame: string }
export interface PeerPose { at: number; p: number[]; q: number[]; r: number; a: number }
export interface Peer { info: PeerInfo; poses: PeerPose[]; lap?: { lap: number; last: number; best: number } }
export type MpStatus = 'idle' | 'connecting' | 'connected' | 'error';

const SEND_HZ = 30;
const INTERP_DELAY_MS = 100;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function randomRoomCode(n = 5): string {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

export class MultiplayerClient {
  status: MpStatus = 'idle';
  error = '';
  room: string | null = null;
  myId = 0;
  map: string | null = null;
  peers = new Map<number, Peer>();
  latencyMs = 0;
  onMap: ((map: string) => void) | null = null;
  /** Listeners for roster / status / map / lap changes; a listener returning false is removed. */
  private listeners = new Set<() => boolean | void>();
  listen(fn: () => boolean | void) { this.listeners.add(fn); }
  private changed() { for (const fn of [...this.listeners]) if (fn() === false) this.listeners.delete(fn); }
  private ws: WebSocket | null = null;
  private lastSend = 0;
  private pingTimer: number | undefined;
  private me: { name: string; color: string; frame: string; map: string } | null = null;

  get connected() { return this.status === 'connected'; }

  /** room: optional description, applied only if we are the first pilot in (the host). */
  join(code: string, me: { name: string; color: string; frame: string; map: string; room?: { name: string; public: boolean } }): void {
    this.leave();
    const base = multiplayerUrl();
    if (!base) { this.status = 'error'; this.error = 'No multiplayer server configured for this site.'; this.changed(); return; }
    this.room = code.toUpperCase();
    this.me = me;
    this.status = 'connecting'; this.error = '';
    this.changed();
    let ws: WebSocket;
    try { ws = new WebSocket(`${base.replace(/\/$/, '')}/room/${encodeURIComponent(this.room)}`); }
    catch (e) { this.status = 'error'; this.error = (e as Error).message; this.changed(); return; }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', ...me }));
    ws.onmessage = (ev) => this.handle(typeof ev.data === 'string' ? ev.data : '');
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.peers.clear();
      this.status = ev.code === 1000 ? 'idle' : 'error';
      this.error = ev.code === 4001 ? 'That room is full (8 pilots).' : ev.code === 1000 ? '' : `Disconnected (${ev.code}${ev.reason ? ': ' + ev.reason : ''}).`;
      this.changed();
    };
    ws.onerror = () => { this.error = 'Could not reach the multiplayer server.'; };
  }

  leave(): void {
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.close(1000, 'leave'); } catch { /* ignore */ }
    this.peers.clear();
    this.status = 'idle'; this.room = null; this.myId = 0;
    this.changed();
  }

  private handle(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const now = performance.now();
    switch (m.t) {
      case 'welcome':
        this.myId = m.id; this.status = 'connected';
        for (const p of m.players ?? []) this.peers.set(p.id, { info: p, poses: [] });
        if (m.map) { this.map = m.map; if (this.me && m.map !== this.me.map) this.onMap?.(m.map); }
        this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
        this.changed();
        break;
      case 'join': this.peers.set(m.player.id, { info: m.player, poses: [] }); this.changed(); break;
      case 'leave': this.peers.delete(m.id); this.changed(); break;
      case 's': {
        const peer = this.peers.get(m.id);
        if (!peer) return;
        peer.poses.push({ at: now, p: m.p, q: m.q, r: m.r, a: m.a });
        if (peer.poses.length > 30) peer.poses.splice(0, peer.poses.length - 30);
        break;
      }
      case 'map': this.map = m.map; if (this.me) this.me.map = m.map; this.onMap?.(m.map); this.changed(); break;
      case 'lap': { const peer = this.peers.get(m.id); if (peer) { peer.lap = { lap: m.lap, last: m.last, best: m.best }; this.changed(); } break; }
      case 'pong': this.latencyMs = this.latencyMs ? this.latencyMs * 0.7 + (now - m.c) * 0.3 : now - m.c; break;
      case 'error': this.error = String(m.msg ?? 'server error'); this.changed(); break;
    }
  }

  private send(o: object) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }

  /** Send our pose (ENU position m, body->world quaternion w,x,y,z, mean rpm, armed); throttled to 30 Hz. */
  sendPose(now: number, p: number[], q: number[], rpm: number, armed: boolean) {
    if (!this.connected || now - this.lastSend < 1000 / SEND_HZ) return;
    this.lastSend = now;
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    this.send({ t: 's', p: p.map(r3), q: q.map((v) => Math.round(v * 10000) / 10000), r: Math.round(rpm), a: armed ? 1 : 0 });
  }

  sendMap(map: string) { if (this.me) this.me.map = map; this.map = map; this.send({ t: 'map', map }); }
  sendLap(lap: number, last: number, best: number) { this.send({ t: 'lap', lap, last, best: Number.isFinite(best) ? best : 0 }); }

  /** Interpolated pose of a peer at (now - delay); null if nothing received recently. */
  poseOf(peer: Peer, now: number): PeerPose | null {
    const ps = peer.poses;
    if (!ps.length || now - ps[ps.length - 1].at > 3000) return null;
    const t = now - INTERP_DELAY_MS;
    if (t <= ps[0].at) return ps[0];
    for (let i = ps.length - 1; i > 0; i--) {
      const a = ps[i - 1], b = ps[i];
      if (t >= a.at) {
        if (t >= b.at) return b; // no newer sample yet: hold
        const u = (t - a.at) / Math.max(1, b.at - a.at);
        // shortest-path nlerp for the quaternion
        const d = a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3];
        const s = d < 0 ? -1 : 1;
        const q = a.q.map((v, k) => v + (s * b.q[k] - v) * u);
        const n = Math.hypot(...q) || 1;
        return { at: t, p: a.p.map((v, k) => v + (b.p[k] - v) * u), q: q.map((v) => v / n), r: a.r + (b.r - a.r) * u, a: b.a };
      }
    }
    return ps[ps.length - 1];
  }
}
