// Live multiplayer client. Every pilot runs their own full simulation (physics + Betaflight); the
// room relay only carries compact pose updates (30 Hz), roster changes, the shared map, and laps.
// Remote quads are rendered ~100 ms in the past and interpolated between received poses, timed by
// when the sender sampled them (see addPose), which hides network jitter. There are no physical
// collisions between pilots (ghost-style flying). A dropped connection is retried with backoff.
import { multiplayerUrl } from './config';
import { isLocalMapId, MAP_ID_RE, parseRelay, PeerInfo, PING, PROTOCOL, RelayMsg, versionNote } from './protocol';

export type { PeerInfo } from './protocol';
/** r: rpm per motor (Betaflight order); h: 1 while that pilot is paused (menu open) */
export interface PeerPose { at: number; p: number[]; q: number[]; r: number[]; a: number; h: number }
interface PeerClock { off: number; min: number; prev: number; win: number }
export interface Peer { info: PeerInfo; poses: PeerPose[]; lap?: { lap: number; last: number; best: number }; clock?: PeerClock }
export type MpStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
/** Why the last join / connection ended (the menu offers Retry). */
export type MpFailure = 'full' | 'busy' | 'unreachable' | 'timeout' | 'lost' | 'config' | null;
export interface JoinInfo { name: string; color: string; frame: string; map: string; room?: { name: string; public: boolean } }

/** Minimal WebSocket surface (the browser's, or a fake in tests). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export interface MpDeps { url?: () => string | null; socket?: (url: string) => WsLike; now?: () => number }

const SEND_HZ = 30;
const PAUSED_HZ = 2;              // a paused pilot's pose doesn't change: just keep it from going stale
const INTERP_DELAY_MS = 100;
export const JOIN_TIMEOUT_MS = 8000;
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const PING_EVERY_MS = 2000;
const PONG_TIMEOUT_MS = 8000;     // an unanswered ping this old: the connection is dead
const CLOCK_WINDOW_MS = 2000;
const CLOCK_SLEW_MS = 2;          // per pose (30 Hz): playback rate changes by at most 6 %
const MAX_PEERS = 32;
const OPEN = 1;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function randomRoomCode(n = 5): string {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => ALPHABET[x % ALPHABET.length]).join('');
}

export class MultiplayerClient {
  status: MpStatus = 'idle';
  error = '';
  failure: MpFailure = null;
  /** the room joined (kept after a failure, for Retry) */
  room: string | null = null;
  myId = 0;
  map: string | null = null;
  peers = new Map<number, Peer>();
  latencyMs = 0;
  /** reconnect attempt (1..maxAttempts) while status is 'reconnecting' */
  attempt = 0;
  readonly maxAttempts = RECONNECT_DELAYS_MS.length;
  /** the relay's protocol version (from welcome; 1 = a relay from before versions) */
  relayV = 0;
  onMap: ((map: string) => void) | null = null;
  /** Listeners for roster / status / map / lap changes; a listener returning false is removed. */
  private listeners = new Set<() => boolean | void>();
  listen(fn: () => boolean | void) { this.listeners.add(fn); }
  private changed() { for (const fn of [...this.listeners]) if (fn() === false) this.listeners.delete(fn); }
  private ws: WsLike | null = null;
  private live = false;        // the current socket got its welcome
  private welcomed = false;    // this join was welcomed at least once: only then is a drop retried
  private lastSend = 0;
  private pingAt: number | null = null; // when the outstanding ping went out (one at a time: the pong has no id)
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private attemptTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private joined: { code: string; me: JoinInfo } | null = null;
  private deps: Required<MpDeps>;

  constructor(deps: MpDeps = {}) {
    this.deps = { url: deps.url ?? multiplayerUrl, socket: deps.socket ?? ((u) => new WebSocket(u) as unknown as WsLike), now: deps.now ?? (() => performance.now()) };
  }

  get connected() { return this.status === 'connected'; }
  /** in a room or trying to be */
  get active() { return this.status === 'connecting' || this.status === 'connected' || this.status === 'reconnecting'; }

  /** room: optional description, applied only if we are the first pilot in (the host). */
  join(code: string, me: JoinInfo): void {
    this.teardown();
    this.peers.clear();
    this.room = code.toUpperCase();
    this.joined = { code: this.room, me: { ...me } };
    this.welcomed = false; this.attempt = 0; this.myId = 0; this.relayV = 0;
    this.error = ''; this.failure = null;
    if (!this.deps.url()) { this.fail('No multiplayer server is configured for this site.', 'config'); return; }
    this.status = 'connecting';
    this.connect();
    this.changed();
  }

  /** Try the last join again (after a failure). */
  retry(): void { const j = this.joined; if (j) this.join(j.code, j.me); }

  leave(): void {
    this.teardown();
    this.peers.clear();
    this.status = 'idle'; this.room = null; this.myId = 0; this.joined = null;
    this.error = ''; this.failure = null; this.attempt = 0;
    this.changed();
  }

  /** Pilots on another protocol version, for the roster / status ("X uses an older version"). */
  versionNotes(): string[] {
    return [...this.peers.values()].flatMap((p) => { const n = versionNote(p.info.v); return n ? [`${p.info.name} ${n}`] : []; });
  }

  private teardown() {
    clearInterval(this.pingTimer); clearTimeout(this.attemptTimer); clearTimeout(this.retryTimer);
    this.pingTimer = this.attemptTimer = this.retryTimer = undefined;
    const ws = this.ws;
    this.ws = null; this.live = false; this.pingAt = null;
    if (ws) try { ws.close(1000, 'leave'); } catch { /* ignore */ }
  }

  private fail(msg: string, kind: MpFailure) {
    this.teardown();
    this.peers.clear();
    this.status = 'error'; this.error = msg; this.failure = kind;
    this.changed();
  }

  private connect() {
    const base = this.deps.url();
    if (!base || !this.room) { this.fail('No multiplayer server is configured for this site.', 'config'); return; }
    let ws: WsLike;
    try { ws = this.deps.socket(`${base.replace(/\/$/, '')}/room/${encodeURIComponent(this.room)}`); }
    catch { this.dropped(1006, false); return; }
    this.ws = ws; this.live = false;
    ws.onopen = () => { if (this.ws === ws) ws.send(JSON.stringify(this.hello())); };
    ws.onmessage = (ev) => { if (this.ws === ws) this.handle(ev.data); };
    ws.onclose = (ev) => { if (this.ws === ws) { this.ws = null; this.dropped(ev.code, false); } };
    ws.onerror = () => { /* a close event follows */ };
    // no welcome in time (a hung connect, or a relay that never answers): give up on this socket
    this.attemptTimer = setTimeout(() => {
      if (this.ws !== ws || this.live) return;
      this.ws = null;
      try { ws.close(); } catch { /* ignore */ }
      this.dropped(0, true);
    }, JOIN_TIMEOUT_MS);
  }

  private hello() {
    const me = this.joined!.me;
    // a pilot's own from-disk maps ("local-…") are never shared with a room
    const map = me.map && !isLocalMapId(me.map) && MAP_ID_RE.test(me.map) ? me.map : undefined;
    return { t: 'hello', v: PROTOCOL, name: me.name, color: me.color, frame: me.frame, ...(map ? { map } : {}), ...(me.room ? { room: me.room } : {}) };
  }

  /** The socket closed (or timed out). Retry with backoff only if this join had been welcomed. */
  private dropped(code: number, timedOut: boolean) {
    clearInterval(this.pingTimer); clearTimeout(this.attemptTimer);
    this.pingTimer = this.attemptTimer = undefined;
    this.live = false; this.pingAt = null;
    this.peers.clear();
    if (code === 4001) return this.fail('That room is full (8 pilots).', 'full');
    if (!this.welcomed) {
      if (code === 1013) return this.fail('That room is busy right now. Try again in a few seconds.', 'busy');
      return timedOut ? this.fail('The room server did not answer in time.', 'timeout') : this.fail('Could not reach the room server.', 'unreachable');
    }
    if (this.attempt >= RECONNECT_DELAYS_MS.length) return this.fail(`Disconnected from room ${this.room}.`, 'lost');
    const d = RECONNECT_DELAYS_MS[this.attempt++];
    this.status = 'reconnecting';
    this.error = `Connection to room ${this.room} lost. Reconnecting (attempt ${this.attempt} of ${RECONNECT_DELAYS_MS.length})…`;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; if (this.status === 'reconnecting') this.connect(); }, d);
    this.changed();
  }

  private ping() {
    const now = this.deps.now();
    if (this.pingAt !== null && now - this.pingAt > PONG_TIMEOUT_MS) {
      // the relay stopped answering: the connection is dead even if the browser hasn't noticed
      const ws = this.ws;
      this.ws = null;
      try { ws?.close(); } catch { /* ignore */ }
      this.dropped(1006, false);
      return;
    }
    if (this.pingAt !== null) return;
    this.pingAt = now;
    // v2 relays answer the fixed ping in the runtime; v1 relays need the client clock in it
    this.sendRaw(this.relayV >= 2 ? PING : JSON.stringify({ t: 'ping', c: now }));
  }

  private addPeer(p: PeerInfo) {
    if (p.id === this.myId || (this.peers.size >= MAX_PEERS && !this.peers.has(p.id))) return;
    this.peers.set(p.id, { info: p, poses: [] });
  }

  private handle(raw: unknown) {
    const m = parseRelay(raw);
    if (!m) return; // malformed, or a type we don't know
    const now = this.deps.now();
    switch (m.t) {
      case 'welcome': {
        // a fresh roster every time: after a reconnect we have a new id and old peers may be gone
        clearTimeout(this.attemptTimer); clearInterval(this.pingTimer);
        this.attemptTimer = this.pingTimer = undefined;
        this.peers.clear();
        this.live = true; this.welcomed = true; this.attempt = 0;
        this.myId = m.id; this.relayV = m.v; this.status = 'connected'; this.error = ''; this.failure = null;
        for (const p of m.players) this.addPeer(p);
        this.map = m.map;
        const me = this.joined?.me;
        if (m.map && me && m.map !== me.map) { me.map = m.map; this.onMap?.(m.map); }
        this.pingAt = null;
        this.ping();
        this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
        this.changed();
        break;
      }
      case 'join': this.addPeer(m.player); this.changed(); break;
      case 'leave': if (this.peers.delete(m.id)) this.changed(); break;
      case 's': { const peer = this.peers.get(m.id); if (peer) this.addPose(peer, m, now); break; }
      case 'map':
        this.map = m.map;
        if (this.joined) this.joined.me.map = m.map;
        this.onMap?.(m.map);
        this.changed();
        break;
      case 'lap': { const peer = this.peers.get(m.id); if (peer) { peer.lap = { lap: m.lap, last: m.last, best: m.best }; this.changed(); } break; }
      case 'pong': {
        const sent = m.c ?? this.pingAt;
        this.pingAt = null;
        if (sent !== null && now - sent >= 0 && now - sent < 30_000) this.latencyMs = this.latencyMs ? this.latencyMs * 0.7 + (now - sent) * 0.3 : now - sent;
        break;
      }
      case 'error': this.error = m.msg; this.changed(); break;
    }
  }

  /** Time a pose by when the sender sampled it, mapped onto our clock: off = the sender-to-us clock
   *  offset plus the fastest recent trip (min of arrival - sender time over a sliding 2-4 s window).
   *  Network jitter then only delays arrival (absorbed by the 100 ms playback delay) instead of moving
   *  the pose in time, so remote quads don't speed up and slow down with it. The estimate slews so
   *  playback never jumps; it snaps only when far off (the sender's clock restarted). Poses from v1
   *  pilots (no sender clock) are timed by arrival, as before. */
  private addPose(peer: Peer, m: Extract<RelayMsg, { t: 's' }>, now: number) {
    const ps = peer.poses;
    let at = now;
    if (m.c !== undefined) {
      const d = now - m.c;
      const k = (peer.clock ??= { off: d, min: d, prev: d, win: now });
      if (now - k.win > CLOCK_WINDOW_MS) { k.prev = k.min; k.min = d; k.win = now; } else k.min = Math.min(k.min, d);
      const err = Math.min(k.min, k.prev) - k.off;
      if (Math.abs(err) > 500) { k.off += err; ps.length = 0; } else k.off += Math.max(-CLOCK_SLEW_MS, Math.min(CLOCK_SLEW_MS, err));
      at = m.c + k.off;
    }
    const last = ps[ps.length - 1];
    if (last && at <= last.at) { if (m.c !== undefined) return; at = last.at + 1; } // repeated sample
    ps.push({ at, p: m.p, q: m.q, r: m.r, a: m.a, h: m.h });
    if (ps.length > 30) ps.splice(0, ps.length - 30);
  }

  private sendRaw(s: string) { if (this.ws && this.ws.readyState === OPEN) try { this.ws.send(s); } catch { /* closing */ } }
  private send(o: object) { this.sendRaw(JSON.stringify(o)); }

  /** Send our pose (ENU position m, body->world quaternion w,x,y,z, rpm per motor or one mean, armed,
   *  paused = menu open); throttled to 30 Hz, 2 Hz while paused. */
  sendPose(now: number, p: number[], q: number[], rpm: number | number[], armed: boolean, paused = false) {
    if (!this.connected || now - this.lastSend < 1000 / (paused ? PAUSED_HZ : SEND_HZ)) return;
    const rs = (Array.isArray(rpm) ? rpm : [rpm, rpm, rpm, rpm]).slice(0, 4).map((v) => Math.round(Math.abs(v)));
    if (rs.length !== 4 || ![...p, ...q, ...rs].every(Number.isFinite)) return; // the relay would drop it anyway
    this.lastSend = now;
    const base = { t: 's', p: p.map((v) => Math.round(v * 1000) / 1000), q: q.map((v) => Math.round(v * 10000) / 10000), a: armed ? 1 : 0 };
    // v1 relays relay one mean rpm and drop unknown fields
    this.send(this.relayV >= 2 ? { ...base, r: rs, c: Math.round(now), h: paused ? 1 : 0 } : { ...base, r: Math.round(rs.reduce((s, x) => s + x, 0) / 4) });
  }

  sendMap(map: string) {
    if (this.joined) this.joined.me.map = map;
    if (isLocalMapId(map) || !MAP_ID_RE.test(map)) return; // a pilot's from-disk maps stay theirs
    this.map = map;
    this.send({ t: 'map', map });
  }
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
        return { at: t, p: a.p.map((v, k) => v + (b.p[k] - v) * u), q: q.map((v) => v / n), r: a.r.map((v, k) => v + (b.r[k] - v) * u), a: b.a, h: b.h };
      }
    }
    return ps[ps.length - 1];
  }
}
