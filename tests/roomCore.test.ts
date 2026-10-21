import { describe, expect, test } from 'vitest';
import { MAX_PLAYERS, originAllowed, RoomCore, sanitizeName, Sock } from '../server/src/roomCore';

class FakeSock implements Sock {
  sent: any[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
  last(t: string) { return [...this.sent].reverse().find((m) => m.t === t); }
}

const hello = (name: string, extra: object = {}) => JSON.stringify({ t: 'hello', name, color: '#ff8800', frame: '5in', ...extra });
const state = (x: number) => JSON.stringify({ t: 's', p: [x, 2, 3], q: [1, 0, 0, 0], r: 12000, a: 1 });

describe('RoomCore', () => {
  test('join, roster, relay state to others only, leave', () => {
    let now = 0;
    const room = new RoomCore(() => now);
    const a = new FakeSock(), b = new FakeSock();
    room.open(a); room.open(b);
    expect(room.message(a, hello('Alice', { map: 'bando' }))).toBe('bando'); // first hello sets the room map
    room.message(b, hello('Bob', { map: 'field' }));
    const wb = b.last('welcome');
    expect(wb.map).toBe('bando');
    expect(wb.players.map((p: any) => p.name)).toEqual(['Alice']);
    expect(a.last('join').player.name).toBe('Bob');
    now = 100;
    room.message(a, state(5));
    expect(b.last('s')).toMatchObject({ id: 1, p: [5, 2, 3], a: 1 });
    expect(a.last('s')).toBeUndefined(); // never echoed back
    room.close(a);
    expect(b.last('leave')).toEqual({ t: 'leave', id: 1 });
  });

  test('rejects malformed, oversized and pre-hello messages', () => {
    const room = new RoomCore(() => 0);
    const a = new FakeSock(), b = new FakeSock();
    room.open(a); room.open(b);
    room.message(a, state(1));
    expect(a.last('error').msg).toContain('hello');
    room.message(a, hello('A')); room.message(b, hello('B'));
    room.message(a, '{not json');
    expect(a.last('error').msg).toBe('bad json');
    room.message(a, JSON.stringify({ t: 's', p: [1, 2], q: [1, 0, 0, 0], r: 0, a: 1 })); // bad vector
    room.message(a, JSON.stringify({ t: 's', p: [1, 2, NaN], q: [1, 0, 0, 0], r: 0, a: 1 }));
    expect(b.last('s')).toBeUndefined();
    room.message(a, 'x'.repeat(2000));
    expect(a.last('error').msg).toBe('message too large');
  });

  test('room capacity is enforced', () => {
    const room = new RoomCore(() => 0);
    const socks = Array.from({ length: MAX_PLAYERS + 1 }, () => new FakeSock());
    const ok = socks.map((s) => room.open(s));
    expect(ok.filter(Boolean).length).toBe(MAX_PLAYERS);
    expect(socks[MAX_PLAYERS].closed?.code).toBe(4001);
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
    expect(room.message(b, JSON.stringify({ t: 'map', map: 'bando' }))).toBe('bando');
    expect(a.last('map')).toMatchObject({ map: 'bando', by: 2 });
    room.message(b, JSON.stringify({ t: 'map', map: '../etc' }));
    expect(room.map).toBe('bando');
    room.message(a, JSON.stringify({ t: 'lap', lap: 3, last: 21.4, best: 20.9 }));
    expect(b.last('lap')).toMatchObject({ id: 1, lap: 3, best: 20.9 });
  });

  test('names are sanitised', () => {
    expect(sanitizeName('  <b>Ace</b>\n pilot  ')).toBe('bAce/b pilot');
    expect(sanitizeName('')).toBe('Pilot');
    expect(sanitizeName('x'.repeat(50)).length).toBe(20);
  });

  test('origin allow-list', () => {
    const allow = ['https://fpv-sim-gamma.vercel.app', 'https://*.vercel.app', 'http://localhost:*'];
    expect(originAllowed('https://fpv-sim-gamma.vercel.app', allow)).toBe(true);
    expect(originAllowed('https://fpv-sim-git-main-x.vercel.app', allow)).toBe(true);
    expect(originAllowed('http://localhost:5175', allow)).toBe(true);
    expect(originAllowed('https://evil.example.com', allow)).toBe(false);
    expect(originAllowed('https://vercel.app.evil.com', allow)).toBe(false);
    expect(originAllowed(null, allow)).toBe(false);
  });
});
