import { expect, test } from 'vitest';
import { EXPIRE_MS, LobbyCore } from '../server/src/lobbyCore';
import { RoomCore, Sock } from '../server/src/roomCore';

const sock = (): Sock & { out: string[] } => { const out: string[] = []; return { out, send: (d) => out.push(d), close: () => {} }; };

test('lobby lists valid public rooms, busiest first, and expires stale ones', () => {
  let t = 1000;
  const l = new LobbyCore(() => t);
  expect(l.upsert({ code: 'ABCDE', name: 'Evening race', map: 'field', players: 2, max: 8, host: 'Ann' })).toBe(true);
  expect(l.upsert({ code: 'QWERT', name: '<b>Bando</b>\u0007 jam', map: 'bando', players: 5, max: 8, host: 'Bo' })).toBe(true);
  expect(l.upsert({ code: 'bad!', players: 1, max: 8 })).toBe(false);
  expect(l.upsert({ code: 'ZZZZ', players: 0, max: 8 })).toBe(false);
  const list = l.list();
  expect(list.map((r) => r.code)).toEqual(['QWERT', 'ABCDE']);
  expect(list[0].name).toBe('bBando/b jam'); // markup and control characters stripped
  t += EXPIRE_MS + 1;
  l.upsert({ code: 'ABCDE', name: 'Evening race', map: 'field', players: 3, max: 8, host: 'Ann' });
  expect(l.list().map((r) => r.code)).toEqual(['ABCDE']); // QWERT stopped reporting
});

test('rooms are listed only when the host made them public', () => {
  const pub = new RoomCore(), s1 = sock();
  pub.open(s1);
  pub.message(s1, JSON.stringify({ t: 'hello', name: 'Ann', color: '#ff0000', frame: '5in', map: 'field', room: { name: 'Evening race', public: true } }));
  expect(pub.listing('ABCDE')).toMatchObject({ code: 'ABCDE', name: 'Evening race', map: 'field', players: 1, max: 8, host: 'Ann' });
  // a later joiner cannot rename or hide the room
  const s2 = sock(); pub.open(s2);
  pub.message(s2, JSON.stringify({ t: 'hello', name: 'Bo', color: '#00ff00', frame: '5in', room: { name: 'mine now', public: false } }));
  expect(pub.listing('ABCDE')).toMatchObject({ name: 'Evening race', players: 2 });

  const priv = new RoomCore(), s3 = sock();
  priv.open(s3);
  priv.message(s3, JSON.stringify({ t: 'hello', name: 'Cy', color: '#0000ff', frame: '5in', room: { name: 'secret', public: false } }));
  expect(priv.listing('PRIVT')).toBeNull();
  // rooms joined by code without a description are private by default
  const legacy = new RoomCore(), s4 = sock(); legacy.open(s4);
  legacy.message(s4, JSON.stringify({ t: 'hello', name: 'Di', color: '#0000ff', frame: '5in' }));
  expect(legacy.listing('OLDRM')).toBeNull();
});

test('the directory survives a snapshot / restore (object evicted between heartbeats)', () => {
  let t = 1_000_000;
  const a = new LobbyCore(() => t);
  a.upsert({ code: 'ABCD', name: 'Night race', map: 'field', players: 3, max: 8, host: 'Ann' });
  const saved = JSON.parse(JSON.stringify(a.snapshot()));
  const b = new LobbyCore(() => t);
  b.restore(saved);
  expect(b.list().map((r) => r.code)).toEqual(['ABCD']);
  t += EXPIRE_MS + 1; // a stale snapshot expires instead of resurrecting dead rooms
  const c = new LobbyCore(() => t);
  c.restore(saved);
  expect(c.list()).toEqual([]);
  expect(a.remove('ABCD')).toBe(true);
  expect(a.remove('ABCD')).toBe(false);
});

test('prototype member names are never accepted as map ids (relay + directory)', () => {
  const room = new RoomCore(), s = sock();
  room.open(s);
  room.message(s, JSON.stringify({ t: 'hello', name: 'Eve', color: '#ff0000', frame: '5in', map: 'constructor' }));
  expect(room.map).toBeNull();
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    expect(room.message(s, JSON.stringify({ t: 'map', map: bad }))).toBeNull();
  }
  const l = new LobbyCore(() => 1);
  l.upsert({ code: 'ABCD', name: 'x', map: '__proto__', players: 1, max: 8, host: 'Eve' });
  expect(l.list()[0].map).toBeNull();
});
