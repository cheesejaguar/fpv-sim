// Blackbox recorder: ring buffer, segment separators and CSV column alignment.
import { expect, test } from 'vitest';
import { Blackbox } from '../src/ui/blackbox';
import { createShared, R, REC, RING_N } from '../src/worker/shared';

function feed(sh: ReturnType<typeof createShared>, head: { n: number }, count: number, armed: boolean) {
  for (let k = 0; k < count; k++) {
    const o = (head.n % RING_N) * REC;
    sh.ring.fill(0, o, o + REC);
    sh.ring[o + R.t] = head.n / 1000;
    sh.ring[o + R.px] = head.n;
    sh.ring[o + R.wx] = Math.PI; // rad/s -> 180 deg/s in the CSV
    sh.ring[o + R.armed] = armed ? 1 : 0;
    head.n++;
  }
  Atomics.store(sh.ctrl, 1, head.n);
}
const csvLines = (b: Blackbox) => b.csvParts().join('').split('\n').slice(0, -1);

test('records while armed, separates segments, RC columns stay aligned', () => {
  const sh = createShared(), head = { n: 0 }, b = new Blackbox();
  const rc = new Float32Array(16).map((_, i) => i / 10);
  feed(sh, head, 1, false); b.pump(sh, rc); // the first pump only syncs to the ring head
  feed(sh, head, 5, true); b.pump(sh, rc);
  feed(sh, head, 3, false); b.pump(sh, rc);
  rc[0] = 0.9;
  feed(sh, head, 4, true); b.pump(sh, rc);
  expect(b.length).toBe(9);
  const lines = csvLines(b);
  const cols = lines[0].split(',');
  expect(cols).toHaveLength(40);
  expect(lines).toHaveLength(1 + 5 + 1 + 4);
  expect(lines[6]).toBe(''); // separator between the two armed segments
  const row = (i: number) => Object.fromEntries(lines[i].split(',').map((v, k) => [cols[k], Number(v)]));
  expect(row(1).pos_x).toBe(1);
  expect(row(1).rate_roll_dps).toBeCloseTo(180, 3);
  expect(row(5).rc_roll).toBeCloseTo(0, 5);
  expect(row(5).aux4).toBeCloseTo(0.7, 5);
  // after the separator the RC values belong to the same samples (the old recorder shifted them by one row)
  expect(row(7).pos_x).toBe(9);
  expect(row(7).rc_roll).toBeCloseTo(0.9, 5);
  expect(lines.slice(1).every((l) => l === '' || l.split(',').length === 40)).toBe(true);
});

test('keeps the newest window once full, with no separator before the first sample', () => {
  const sh = createShared(), head = { n: 0 }, rc = new Float32Array(16);
  const b = new Blackbox(0.01); // 10 rows
  expect(b.capacity).toBe(10);
  feed(sh, head, 1, false); b.pump(sh, rc);
  feed(sh, head, 6, true); b.pump(sh, rc);
  feed(sh, head, 2, false); b.pump(sh, rc);
  feed(sh, head, 6, true); b.pump(sh, rc); // 6 + separator + 6 = 13 rows: the 3 oldest are dropped
  expect(b.length).toBe(9);
  let lines = csvLines(b);
  expect(lines.slice(1).map((l) => (l ? Number(l.split(',')[1]) : 'sep'))).toEqual([4, 5, 6, 'sep', 9, 10, 11, 12, 13, 14]);
  feed(sh, head, 4, true); b.pump(sh, rc); // the separator becomes the oldest row, then drops out
  lines = csvLines(b);
  expect(lines[1]).not.toBe('');
  expect(b.length).toBe(10);
  b.clear();
  expect(b.length).toBe(0);
  expect(csvLines(b)).toHaveLength(1);
});
