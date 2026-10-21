import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { HELLO_TIMEOUT_MS, MAP_COOLDOWN_MS, MAX_PLAYERS, MAX_SOCKETS, originAllowed, originPattern, PING, PONG, PROTOCOL, RoomCore, sanitizeName, sanitizeRoomName, Sock } from '../server/src/roomCore';
import { blocked } from '../server/src/sanitize';

class FakeSock implements Sock {
  sent: any[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code?: number, reason?: string) { this.closed ??= { code, reason }; }
  last(t: string) { return [...this.sent].reverse().find((m) => m.t === t); }
  all(t: string) { return this.sent.filter((m) => m.t === t); }
}

const hello = (name: string, extra: object = {}) => JSON.stringify({ t: 'hello', name, color: '#ff8800', frame: '5in', ...extra });
const state = (x: number, extra: object = {}) => JSON.stringify({ t: 's', p: [x, 2, 3], q: [1, 0, 0, 0], r: 12000, a: 1, ...extra });

describe('RoomCore', () => {
  test('join, roster, relay state to others only, leave', () => {
    let now = 0;
    const room = new RoomCore(() => now);
    const a = new FakeSock(), b = new FakeSock();
    room.open(a); room.open(b);
    const r = room.message(a, hello('Alice', { map: 'bando' }));
    expect(r.mapChanged).toBe('bando'); // first hello sets the room map
    expect(r.joined).toMatchObject({ id: 1, name: 'Alice' });
    room.message(b, hello('Bob', { map: 'field' }));
    const wb = b.last('welcome');
    expect(wb.map).toBe('bando');
    expect(wb.v).toBe(PROTOCOL);
    expect(wb.players.map((p: any) => p.name)).toEqual(['Alice']);
    expect(a.last('join').player.name).toBe('Bob');
    now = 100;
    room.message(a, state(5));
    expect(b.last('s')).toMatchObject({ id: 1, p: [5, 2, 3], a: 1 });
    expect(a.last('s')).toBeUndefined(); // never echoed back
    expect(room.close(a)).toMatchObject({ id: 1 });
    expect(b.last('leave')).toEqual({ t: 'leave', id: 1 });
    expect(room.close(a)).toBeNull(); // idempotent
  });

  test('rejects malformed and pre-hello messages; oversized ones end the connection (1009, no reply)', () => {
    const room = new RoomCore(() => 0);
    const a = new FakeSock(), b = new FakeSock();
    room.open(a); room.open(b);
    room.message(a, state(1));
    expect(a.last('error').msg).toContain('hello');
    room.message(a, hello('A')); room.message(b, hello('B'));
    room.message(a, '{not json');
    expect(a.last('error').msg).toBe('bad json');
    room.message(a, JSON.stringify({ t: 's', p: [1, 2], q: [1, 0, 0, 0], r: 0, a: 1 })); // bad vector
    room.message(a, '{"t":"s","p":[1,2,1e400],"q":[1,0,0,0],"r":0,"a":1}'); // Infinity
    room.message(a, JSON.stringify({ t: 's', p: [1, 2, 3], q: [1, 0, 0, 0], r: [1, 2, 3], a: 1 })); // 3 rpm values
    expect(b.last('s')).toBeUndefined();
    const before = a.sent.length;
    const r = room.message(a, JSON.stringify({ t: 'lap', pad: 'x'.repeat(2000) }));
    expect(a.closed?.code).toBe(1009);
    expect(a.sent.length).toBe(before); // not answered
    expect(r.left).toMatchObject({ id: 1 });
    expect(b.last('leave')).toEqual({ t: 'leave', id: 1 });
    expect(room.size).toBe(1);
  });

  test('only pilots who said hello count toward the 8-pilot cap; raw sockets are capped too', () => {
    const room = new RoomCore(() => 0);
    const socks = Array.from({ length: MAX_SOCKETS + 1 }, () => new FakeSock());
    const ok = socks.map((s) => room.open(s));
    expect(ok.filter(Boolean).length).toBe(MAX_SOCKETS);
    expect(socks[MAX_SOCKETS].closed?.code).toBe(1013); // busy: try again (half-open sockets are swept)
    expect(socks[MAX_SOCKETS].sent).toEqual([{ t: 'bye', code: 1013, msg: 'room busy' }]); // told first
    socks.slice(0, MAX_PLAYERS).forEach((s, i) => room.message(s, hello(`P${i}`)));
    expect(room.players().length).toBe(MAX_PLAYERS);
    room.message(socks[MAX_PLAYERS], hello('Late'));
    expect(socks[MAX_PLAYERS].closed?.code).toBe(4001);
    expect(socks[MAX_PLAYERS].last('bye')).toEqual({ t: 'bye', code: 4001, msg: 'room full' });
    expect(room.players().length).toBe(MAX_PLAYERS);
    const extra = new FakeSock();
    expect(room.open(extra)).toBe(false);
    expect(extra.closed?.code).toBe(4001);
  });

  test('sockets that never say hello are closed after 10 s', () => {
    let now = 0;
    const room = new RoomCore(() => now);
    const quiet = new FakeSock(), pilot = new FakeSock();
    room.open(quiet, 0); room.open(pilot, 0);
    room.message(pilot, hello('P'));
    expect(room.helloDeadline()).toBe(HELLO_TIMEOUT_MS);
    expect(room.sweep(HELLO_TIMEOUT_MS - 1)).toBe(0);
    now = HELLO_TIMEOUT_MS;
    expect(room.sweep()).toBe(1);
    expect(quiet.closed?.code).toBe(4008);
    expect(quiet.sent).toEqual([{ t: 'bye', code: 4008, msg: 'hello timeout' }]);
    expect(pilot.closed).toBeNull();
    expect(room.helloDeadline()).toBeNull();
    expect(room.size).toBe(1);
  });

  test('hello flood: a repeated hello changes nothing (no new id, welcome, join or result)', () => {
    const room = new RoomCore(() => 0);
    const a = new FakeSock(), b = new FakeSock();
    room.open(a); room.open(b);
    room.message(a, hello('A', { room: { name: 'x', public: true } }));
    room.message(b, hello('B'));
    for (let i = 0; i < 30; i++) {
      const r = room.message(b, hello(`B${i}`, { map: 'bando', room: { name: 'mine', public: false } }));
      expect(r).toEqual({ joined: null, left: null, mapChanged: null, metaChanged: false });
    }
    expect(b.all('welcome').length).toBe(1);
    expect(a.all('join').length).toBe(1);
    expect(room.players().map((p) => p.name)).toEqual(['A', 'B']);
    expect(room.meta).toMatchObject({ name: 'x', public: true });
  });

  test('rate limit drops floods', () => {
    const now = 0;
    const room = new RoomCore(() => now);
    const a = new FakeSock(), b = new FakeSock();
    room.open(a); room.open(b);
    room.message(a, hello('A')); room.message(b, hello('B'));
    for (let i = 0; i < 200; i++) room.message(a, state(i));
    expect(b.sent.filter((m) => m.t === 's').length).toBeLessThanOrEqual(40);
  });

  test('map change broadcasts to everyone, laps relay', () => {
    const room = new RoomCore(() => 0);
    const a = new FakeSock(), b = new FakeSock();
    room.open(a); room.open(b);
    room.message(a, hello('A', { map: 'field' })); room.message(b, hello('B'));
    expect(room.message(b, JSON.stringify({ t: 'map', map: 'bando' })).mapChanged).toBe('bando');
    expect(a.last('map')).toMatchObject({ map: 'bando', by: 2 });
    room.message(b, JSON.stringify({ t: 'map', map: '../etc' }));
    expect(room.map).toBe('bando');
    room.message(a, JSON.stringify({ t: 'lap', lap: 3, last: 21.4, best: 20.9 }));
    expect(b.last('lap')).toMatchObject({ id: 1, lap: 3, best: 20.9 });
  });

  test('map changes are throttled to one per room per 5 s; the refused sender is told the room map', () => {
    let now = 0;
    const room = new RoomCore(() => now);
    const a = new FakeSock(), b = new FakeSock();
    room.open(a); room.open(b);
    room.message(a, hello('A', { map: 'field' })); room.message(b, hello('B'));
    now = 100;
    expect(room.message(a, JSON.stringify({ t: 'map', map: 'bando' })).mapChanged).toBe('bando');
    now = 200;
    expect(room.message(a, JSON.stringify({ t: 'map', map: 'bando' })).mapChanged).toBeNull(); // same map: no-op
    const spam = ['quake1', 'freedoom1', 'field', 'quake2'];
    for (const m of spam) { now += 500; expect(room.message(b, JSON.stringify({ t: 'map', map: m })).mapChanged).toBeNull(); }
    expect(room.map).toBe('bando');
    expect(b.last('map')).toEqual({ t: 'map', map: 'bando', by: 0 });
    expect(b.last('error').msg).toContain('5 s');
    expect(a.all('map').length).toBe(1); // only the accepted change reached the others
    now = 100 + MAP_COOLDOWN_MS;
    expect(room.message(b, JSON.stringify({ t: 'map', map: 'field' })).mapChanged).toBe('field');
    // a pilot's own from-disk maps are never adopted
    now += MAP_COOLDOWN_MS;
    expect(room.message(b, JSON.stringify({ t: 'map', map: 'local-mine' })).mapChanged).toBeNull();
    const c = new RoomCore(() => 0), s = new FakeSock();
    c.open(s); c.message(s, hello('C', { map: 'local-mine' }));
    expect(c.map).toBeNull();
  });

  test('names are sanitised: invisible / control characters, NFKC, whitespace, combining marks, length, blocklist', () => {
    expect(sanitizeName('  <b>Ace</b>\n pilot  ')).toBe('bAce/b pilot');
    expect(sanitizeName('')).toBe('Pilot');
    expect(sanitizeName('x'.repeat(50)).length).toBe(20);
    expect(sanitizeName('Ev\u202eil\u200b Twin')).toBe('Evil Twin');           // bidi override, zero-width space
    expect(sanitizeName('\uff21\uff43\uff45')).toBe('Ace');                     // fullwidth folds to ASCII
    expect(sanitizeName('a\u3164\u2800b\tc')).toBe('ab c');                     // "blank" letters, tab
    expect(sanitizeName('q\u0301\u0302\u0303\u0304\u0305x')).toBe('q\u0301\u0302x');         // Zalgo: 2 marks kept
    expect(sanitizeName('\ue000\ue001')).toBe('Pilot');                          // private use only
    expect(Array.from(sanitizeName('🚁'.repeat(30))).length).toBe(20);          // cut by code point
    expect(Array.from(sanitizeName('🚁'.repeat(30))).every((ch) => ch === '🚁')).toBe(true); // no half surrogate pair
    for (const bad of ['F.U.C.K', 'fuuuck you', 'Adm1n', 'n1gg3r', 'HITLER', '\uff2e\uff41\uff5a\uff49']) expect(sanitizeName(bad)).toBe('Pilot');
    for (const ok of ['Niger Delta', 'grape', 'Badminton', 'Scott', 'Staff Sgt', 'Moderate']) expect(blocked(ok)).toBe(false);
    expect(sanitizeRoomName('shit room')).toBe('');
  });

  test('hibernation restore: same ids, nobody is told anything, no ghost pilots', () => {
    const now = 0;
    const r1 = new RoomCore(() => now);
    const a = new FakeSock(), b = new FakeSock(), c = new FakeSock(), quiet = new FakeSock();
    for (const s of [a, b, c, quiet]) r1.open(s, 0);
    r1.message(a, hello('A', { v: 2 })); r1.message(b, hello('B', { v: 2 })); r1.message(c, hello('C'));
    r1.close(c); // id 3 left before the room slept: its id must not come back
    const att = new Map([a, b, quiet].map((s) => [s, JSON.parse(JSON.stringify(r1.state(s)))]));
    for (const s of [a, b, quiet]) s.sent = [];
    // the object is rebuilt after hibernation from the sockets' attachments
    const r2 = new RoomCore(() => 5000);
    for (const [s, st] of att) r2.restore(s, st);
    expect(a.sent).toEqual([]); expect(b.sent).toEqual([]); // no welcome, no join
    expect(r2.players().map((p) => [p.id, p.name, p.v])).toEqual([[1, 'A', 2], [2, 'B', 2]]);
    r2.message(a, state(7, { c: 123 }));
    expect(b.last('s')).toMatchObject({ id: 1, p: [7, 2, 3] });
    const d = new FakeSock();
    r2.open(d);
    r2.message(d, hello('D'));
    expect(d.last('welcome').id).toBe(4);
    expect(d.last('welcome').players.map((p: any) => p.id)).toEqual([1, 2]);
    expect(a.all('join').map((m) => m.player.id)).toEqual([4]);
    // the half-open socket keeps its original open time and is swept on schedule
    expect(r2.sweep(HELLO_TIMEOUT_MS)).toBe(1);
    expect(quiet.closed?.code).toBe(4008);
  });

  test('protocol versions: echoed in welcome / join; poses go out in each receiver\'s version', () => {
    const room = new RoomCore(() => 0);
    const v2 = new FakeSock(), v1 = new FakeSock(), sender = new FakeSock();
    for (const s of [v2, v1, sender]) room.open(s);
    room.message(v2, hello('New', { v: 2 }));
    room.message(v1, hello('Old'));
    room.message(sender, hello('S', { v: 2 }));
    expect(sender.last('welcome').players.map((p: any) => [p.name, p.v])).toEqual([['New', 2], ['Old', 1]]);
    expect(v1.last('join').player).toMatchObject({ name: 'S', v: 2 });
    room.message(sender, JSON.stringify({ t: 's', p: [1, 2, 3], q: [1, 0, 0, 0], r: [1000, -2000, 3000, 4000], a: 1, c: 98765, h: 1 }));
    expect(v2.last('s')).toEqual({ t: 's', id: 3, p: [1, 2, 3], q: [1, 0, 0, 0], r: [1000, -2000, 3000, 4000], a: 1, c: 98765, h: 1 });
    expect(v1.last('s')).toEqual({ t: 's', id: 3, p: [1, 2, 3], q: [1, 0, 0, 0], r: 2500, a: 1 }); // mean rpm only
    // a v1 sender's single rpm is relayed as is
    room.message(v1, state(4));
    expect(v2.last('s')).toMatchObject({ id: 2, r: 12000, h: 0 });
  });

  test('pings: v1 clients get their clock back; the fixed v2 ping is answered when the runtime does not', () => {
    const room = new RoomCore(() => 0);
    const a = new FakeSock();
    room.open(a); room.message(a, hello('A'));
    room.message(a, JSON.stringify({ t: 'ping', c: 1234.5 }));
    expect(a.last('pong')).toEqual({ t: 'pong', c: 1234.5 });
    room.message(a, PING);
    expect(a.sent[a.sent.length - 1]).toEqual(JSON.parse(PONG));
  });

  test('the deployed allow-list (server/wrangler.toml) admits production, real preview URLs and the desktop build only', () => {
    const toml = readFileSync(new URL('../server/wrangler.toml', import.meta.url), 'utf8');
    const prod = /^ALLOWED_ORIGINS = "([^"]+)"/m.exec(toml)![1].split(',');
    const yes = ['https://fpv-sim-gamma.vercel.app', 'https://fpv-kqd0hqcnc-cheesejaguar-2353s-projects.vercel.app', // a real deployment URL
      'https://fpv-sim-git-main-cheesejaguar-2353s-projects.vercel.app', 'app://fpv-sim'];
    const no = ['http://localhost:5173', 'http://127.0.0.1:5173', 'https://evil.vercel.app', 'https://fpv-x-other-scope.vercel.app',
      'https://fpv-x-cheesejaguar-2353s-projects.vercel.app.evil.com', 'https://evil-fpv-x-cheesejaguar-2353s-projects.vercel.app'];
    for (const o of yes) expect(originAllowed(o, prod), o).toBe(true);
    for (const o of no) expect(originAllowed(o, prod), o).toBe(false);
  });

  test('origin allow-list: exact origins, this project\'s preview patterns, never a whole-label wildcard', () => {
    const allow = [
      'https://fpv-sim-gamma.vercel.app',
      'https://fpv-sim-*-cheesejaguar-2353s-projects.vercel.app',
      'https://fpv-sim-git-*-cheesejaguar-2353s-projects.vercel.app',
      'app://fpv-sim',
      'http://localhost:*',
    ];
    const yes = ['https://fpv-sim-gamma.vercel.app', 'https://FPV-SIM-GAMMA.vercel.app', 'https://fpv-sim-k3x9q2m1a-cheesejaguar-2353s-projects.vercel.app',
      'https://fpv-sim-git-feature-x-cheesejaguar-2353s-projects.vercel.app', 'app://fpv-sim', 'http://localhost:5175'];
    const no = ['https://evil.example.com', 'https://vercel.app.evil.com', 'https://fpv-sim-git-main-x.vercel.app', 'https://other-cheesejaguar-2353s-projects.vercel.app',
      'https://fpv-sim--cheesejaguar-2353s-projects.vercel.app', 'https://fpv-sim-a.b-cheesejaguar-2353s-projects.vercel.app',
      'https://fpv-sim-x-cheesejaguar-2353s-projects.vercel.app.evil.com', 'http://fpv-sim-gamma.vercel.app', 'https://fpv-sim-gamma.vercel.app:8443',
      'app://fpv-sim-evil', 'app://fpv-sim.evil', 'https://app://fpv-sim', 'http://localhost', 'http://localhost.evil.com:80', 'null'];
    for (const o of yes) expect(originAllowed(o, allow), o).toBe(true);
    for (const o of no) expect(originAllowed(o, allow), o).toBe(false);
    expect(originAllowed(null, allow)).toBe(false);
    // unsafe patterns are refused outright
    for (const bad of ['https://*.vercel.app', 'https://*', 'https://x.*.app', 'https://fpv.vercel.*', 'app://*', 'https://**.vercel.app']) {
      expect(originPattern(bad), bad).toBeNull();
      expect(originAllowed('https://anything.vercel.app', [bad])).toBe(false);
    }
  });
});
