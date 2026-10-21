// Multiplayer client: relay message validation, reconnect backoff, welcome / ping handling, local
// maps, protocol versions and sender-timed poses, with a fake WebSocket and fake timers.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseListing } from '../src/net/lobby';
import { JOIN_TIMEOUT_MS, MultiplayerClient, RECONNECT_DELAYS_MS, WsLike } from '../src/net/multiplayer';
import { cleanName, parseRelay, PING, PROTOCOL } from '../src/net/protocol';

describe('relay message validation', () => {
  const pose = { t: 's', id: 2, p: [1, 2, 3], q: [1, 0, 0, 0], r: [100, 200, 300, 400], a: 1, c: 1234, h: 1 };
  test('well-formed messages pass, normalised', () => {
    expect(parseRelay(JSON.stringify(pose))).toEqual(pose);
    expect(parseRelay(JSON.stringify({ ...pose, r: 5000, c: undefined, h: undefined }))).toMatchObject({ r: [5000, 5000, 5000, 5000], h: 0 }); // v1 sender
    expect(parseRelay(JSON.stringify({ ...pose, q: [2, 0, 0, 0] }))).toMatchObject({ q: [1, 0, 0, 0] });
    const w = parseRelay(JSON.stringify({ t: 'welcome', id: 3, v: 2, map: 'field', players: [{ id: 1, name: 'Ann', color: '#FF0000', frame: 'whoop', v: 2 }, { id: 2, name: 'Old', color: 'red', frame: '<x>' }] }));
    expect(w).toEqual({ t: 'welcome', id: 3, v: 2, map: 'field', players: [{ id: 1, name: 'Ann', color: '#ff0000', frame: 'whoop', v: 2 }, { id: 2, name: 'Old', color: '#39b6ff', frame: '5in', v: 1 }] });
    expect(parseRelay(JSON.stringify({ t: 'welcome', id: 3, players: [] }))).toMatchObject({ v: 1, map: null }); // old relay
    expect(parseRelay('{"t":"pong"}')).toEqual({ t: 'pong' });
  });
  test('malformed messages are dropped', () => {
    const bad: unknown[] = [
      '{"t":"s","id":2,"p":[1,2,1e400],"q":[1,0,0,0],"r":0,"a":1}', // Infinity
      { ...pose, p: [1, 2] }, { ...pose, q: [0, 0, 0, 0] }, { ...pose, r: [1, 2, 3] }, { ...pose, r: '9' }, { ...pose, a: 2 }, { ...pose, id: 0 }, { ...pose, id: 1.5 },
      { ...pose, p: [1e9, 0, 0] },
      { t: 'welcome', id: 'x', players: [] }, { t: 'welcome', id: 1, players: {} }, { t: 'welcome', id: 1, players: new Array(100).fill({ id: 2, name: 'a' }) },
      { t: 'join', player: { id: 2, name: '' } }, { t: 'join', player: { id: 2, name: 'x'.repeat(300) } }, { t: 'join' },
      { t: 'map', map: '__proto__' }, { t: 'map', map: '../etc' }, { t: 'map', map: 7 },
      { t: 'lap', id: 2, lap: -1, last: 1, best: 1 }, { t: 'lap', id: 2, lap: 1, last: 'x', best: 1 },
      { t: 'hax' }, { t: 'leave', id: -1 }, [1, 2], null, 42,
    ];
    for (const b of bad) expect(parseRelay(typeof b === 'string' ? b : JSON.stringify(b)), JSON.stringify(b)).toBeNull();
    expect(parseRelay('{oops')).toBeNull();
    expect(parseRelay('x'.repeat(40_000))).toBeNull();
    expect(parseRelay(12 as unknown)).toBeNull();
  });
  test('names: control / format characters stripped, length capped, unknown map ids cleared', () => {
    expect(cleanName('Ann\u202e\u200b\nB')).toBe('Ann B');
    expect(cleanName('\u0000\u0001')).toBeNull();
    expect(Array.from(cleanName('🚁'.repeat(40))!).length).toBe(20);
    expect(parseRelay(JSON.stringify({ t: 'join', player: { id: 4, name: 'x'.repeat(100), color: '#123456' } }))).toMatchObject({ player: { name: 'x'.repeat(20) } });
    expect(parseRelay(JSON.stringify({ t: 'welcome', id: 1, map: 'constructor', players: [] }))).toMatchObject({ map: null });
    expect(parseRelay(JSON.stringify({ t: 'error', msg: { evil: 1 } }))).toEqual({ t: 'error', msg: 'server error' });
    expect(parseListing({ code: 'ABCDE', name: '<b>x</b>', players: 2, max: 8, host: 'H', map: 'prototype' })).toMatchObject({ name: 'bx/b', map: null });
    expect(parseListing({ code: 'abc', players: 2, max: 8 })).toBeNull();
    expect(parseListing({ code: 'ABCD', players: 1.5, max: 8 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0; sent: string[] = []; closedWith: number | null = null;
  onopen: WsLike['onopen'] = null; onmessage: WsLike['onmessage'] = null; onclose: WsLike['onclose'] = null; onerror: WsLike['onerror'] = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close(code = 1000) { this.closedWith = code; this.readyState = 3; }
  // server side of the fake
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(o: unknown) { this.onmessage?.({ data: typeof o === 'string' ? o : JSON.stringify(o) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
  msgs() { return this.sent.map((s) => JSON.parse(s)); }
}
const ME = { name: 'Ann', color: '#ff7a1a', frame: '5in', map: 'field' };
const welcome = (id: number, players: object[] = [], extra: object = {}) => ({ t: 'welcome', id, v: PROTOCOL, map: 'field', players, ...extra });
const last = () => FakeWs.all[FakeWs.all.length - 1];

describe('MultiplayerClient', () => {
  let mp: MultiplayerClient;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    FakeWs.all = [];
    mp = new MultiplayerClient({ url: () => 'ws://relay.test', socket: (u) => new FakeWs(u), now: () => Date.now() });
  });
  afterEach(() => { mp.leave(); vi.useRealTimers(); });

  test('hello carries the protocol version and never a local map id', () => {
    mp.join('abcde', { ...ME, map: 'local-mine', room: { name: 'r', public: false } });
    expect(last().url).toBe('ws://relay.test/room/ABCDE');
    last().open();
    const h = last().msgs()[0];
    expect(h).toMatchObject({ t: 'hello', v: PROTOCOL, name: 'Ann', room: { name: 'r', public: false } });
    expect('map' in h).toBe(false);
    last().recv(welcome(1));
    last().sent = [];
    mp.sendMap('local-other');
    expect(last().sent).toEqual([]);
    mp.sendMap('bando');
    expect(last().msgs()).toEqual([{ t: 'map', map: 'bando' }]);
  });

  test('reconnects with 1, 2, 4, 8, 16 s backoff, then gives up', () => {
    const statuses: string[] = [];
    mp.listen(() => { statuses.push(mp.status); });
    mp.join('ABCDE', ME);
    last().open(); last().recv(welcome(1));
    expect(mp.status).toBe('connected');
    last().drop(1006);
    const created: number[] = [];
    for (let i = 0; i < RECONNECT_DELAYS_MS.length; i++) {
      expect(mp.status).toBe('reconnecting');
      expect(mp.attempt).toBe(i + 1);
      const n = FakeWs.all.length, t0 = Date.now();
      vi.advanceTimersByTime(RECONNECT_DELAYS_MS[i] - 1);
      expect(FakeWs.all.length).toBe(n);
      vi.advanceTimersByTime(1);
      expect(FakeWs.all.length).toBe(n + 1);
      created.push(Date.now() - t0);
      last().drop(1006); // the relay is still down
    }
    expect(created).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(mp.status).toBe('error');
    expect(mp.failure).toBe('lost');
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all.length).toBe(1 + RECONNECT_DELAYS_MS.length);
    expect(statuses).toContain('reconnecting');
  });

  test('a successful reconnect resets the backoff and the roster', () => {
    mp.join('ABCDE', ME);
    last().open(); last().recv(welcome(1, [{ id: 2, name: 'Bo' }, { id: 3, name: 'Cy' }]));
    expect([...mp.peers.keys()]).toEqual([2, 3]);
    last().drop(1001);
    vi.advanceTimersByTime(1000);
    last().open();
    expect(last().msgs()[0].t).toBe('hello'); // says hello again
    last().recv(welcome(4, [{ id: 3, name: 'Cy' }]));
    expect(mp.status).toBe('connected');
    expect(mp.attempt).toBe(0);
    expect(mp.myId).toBe(4);
    expect([...mp.peers.keys()]).toEqual([3]); // Bo left meanwhile: no ghost
  });

  test('no reconnect after leaving, on "room full", or when the first connection never got in', () => {
    mp.join('ABCDE', ME);
    last().open(); last().recv(welcome(1));
    mp.leave();
    last().drop(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all.length).toBe(1);
    expect(mp.status).toBe('idle');

    mp.join('FULLR', ME);
    last().open(); last().drop(4001);
    expect(mp.status).toBe('error'); expect(mp.failure).toBe('full'); expect(mp.error).toContain('full');
    mp.join('FULLR', ME);
    last().open(); last().recv({ t: 'bye', code: 4001, msg: 'room full' }); // the relay says so before closing
    expect(mp.failure).toBe('full');                                        // at once, not at onclose
    expect(last().closedWith).not.toBeNull();
    mp.join('FULLR', ME);
    last().open(); last().recv(welcome(1)); last().drop(4001); // full after a reconnect race: also final
    vi.advanceTimersByTime(60_000);
    expect(mp.failure).toBe('full');

    const n = FakeWs.all.length;
    mp.join('NOWAY', ME);
    last().drop(1006); // relay unreachable
    expect(mp.status).toBe('error'); expect(mp.failure).toBe('unreachable');
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all.length).toBe(n + 1);
    expect(mp.room).toBe('NOWAY'); // kept for Retry
    mp.retry();
    expect(FakeWs.all.length).toBe(n + 2);
    expect(mp.status).toBe('connecting');
  });

  test('a join that gets no welcome times out after 8 s', () => {
    mp.join('SLOWW', ME);
    last().open();
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS - 1);
    expect(mp.status).toBe('connecting');
    vi.advanceTimersByTime(1);
    expect(mp.status).toBe('error');
    expect(mp.failure).toBe('timeout');
    expect(last().closedWith).not.toBeNull();
  });

  test('welcome clears the previous ping timer; pongs are timed; a silent relay counts as a drop', () => {
    mp.join('ABCDE', ME);
    const ws = last();
    ws.open(); ws.recv(welcome(1));
    ws.recv(welcome(1)); // a second welcome on the same connection must not stack timers
    const pings = () => ws.sent.filter((s) => s === PING).length;
    expect(pings()).toBe(2); // each welcome measures right away
    vi.advanceTimersByTime(40);
    ws.recv('{"t":"pong"}');
    expect(mp.latencyMs).toBe(40);
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(2000); ws.recv('{"t":"pong"}'); }
    expect(pings()).toBe(7); // then every 2 s, not twice as often
    vi.advanceTimersByTime(2000); // ping out, never answered
    vi.advanceTimersByTime(8000);
    expect(mp.status).toBe('connected');
    vi.advanceTimersByTime(2000); // > 8 s without a pong: dead, even if the browser hasn't noticed
    expect(mp.status).toBe('reconnecting');
  });

  test('an old (v1) relay gets v1 pings and v1 poses', () => {
    mp.join('ABCDE', ME);
    const ws = last();
    ws.open(); ws.recv({ t: 'welcome', id: 1, map: null, players: [] });
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toMatchObject({ t: 'ping', c: expect.any(Number) });
    ws.sent = [];
    mp.sendPose(1000, [1, 2, 3], [1, 0, 0, 0], [1000, 2000, 3000, 4000], true, false);
    expect(ws.msgs()).toEqual([{ t: 's', p: [1, 2, 3], q: [1, 0, 0, 0], a: 1, r: 2500 }]);
  });

  test('v2 poses: per-motor rpm, sender clock, paused flag (2 Hz while paused)', () => {
    mp.join('ABCDE', ME);
    const ws = last();
    ws.open(); ws.recv(welcome(1));
    ws.sent = [];
    mp.sendPose(1000.4, [1, 2, 3], [1, 0, 0, 0], [-1000, 2000, -3000, 4000], true);
    expect(ws.msgs()).toEqual([{ t: 's', p: [1, 2, 3], q: [1, 0, 0, 0], a: 1, r: [1000, 2000, 3000, 4000], c: 1000, h: 0 }]);
    mp.sendPose(1040, [1, 2, NaN], [1, 0, 0, 0], 0, true); // never sends NaN
    expect(ws.sent.length).toBe(1);
    for (let t = 1100; t < 3200; t += 33) mp.sendPose(t, [1, 2, 3], [1, 0, 0, 0], 0, false, true);
    const paused = ws.msgs().slice(1);
    expect(paused.length).toBe(4); // ~2 s of 30 Hz frames at 2 Hz
    expect(paused.every((m) => m.h === 1)).toBe(true);
  });

  test('peers on another protocol version are named in the status notes', () => {
    mp.join('ABCDE', ME);
    last().open();
    last().recv(welcome(1, [{ id: 2, name: 'Bo', v: 1 }, { id: 3, name: 'Cy', v: PROTOCOL }]));
    expect(mp.versionNotes()).toEqual(['Bo uses an older version']);
    last().recv({ t: 'join', player: { id: 4, name: 'Di', v: PROTOCOL + 1 } });
    expect(mp.versionNotes()).toEqual(['Bo uses an older version', 'Di uses a newer version (reload to update)']);
  });

  test('poses are timed by sender clock: network jitter does not wobble the playback', () => {
    mp.join('ABCDE', ME);
    last().open(); last().recv(welcome(1, [{ id: 2, name: 'Bo' }]));
    // the sender samples every 33 ms on its own clock (offset 50 s from ours); the network adds
    // 20-120 ms of jitter. x moves at 1 m per 33 ms, so position errors show timing errors directly.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const peer = mp.peers.get(2)!;
    let sendT = 50_000, x = 0;
    const errs: number[] = [];
    for (let i = 0; i < 300; i++) {
      sendT += 33; x += 1;
      const arrive = sendT - 50_000 + 20 + rnd() * 100;
      vi.setSystemTime(Math.round(arrive));
      last().recv({ t: 's', id: 2, p: [x, 0, 0], q: [1, 0, 0, 0], r: [0, 0, 0, 0], a: 1, c: sendT, h: 0 });
      if (i > 120) {
        // render at a smooth 60 Hz-ish moment: speed between two frames 16 ms apart should be 1 m / 33 ms
        const now = Date.now(), a = mp.poseOf(peer, now)!, b = mp.poseOf(peer, now + 16)!;
        errs.push((b.p[0] - a.p[0]) / (b.at - a.at) * 33 - 1);
      }
    }
    const worst = Math.max(...errs.map(Math.abs));
    expect(worst).toBeLessThan(0.15); // < 15 % speed wobble (arrival-timed playback is ~100 %)
    // and the latest samples are mapped onto our clock with a stable offset
    const ps = peer.poses, gaps = ps.slice(1).map((p, i) => p.at - ps[i].at);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(5);
  });
});
