// Lap replays: the .fpvreplay format (round trip, precision, size), the relay's check that a replay
// flies the lap it was posted with, the recorder that samples the ring, and playback (the state the
// frame loop renders, the OSD grid, the player's clock).
import { describe, expect, test } from 'vitest';
import { parseSubmission, Submission, TRACKS } from '../server/src/leaderboardCore';
import { passFraction, checkReplay } from '../server/src/replayCheck';
import { COLUMNS, decodeReplay, encodeColumn, encodeReplay, MAX_REPLAY_BYTES, openReplay, OsdFrame, readColumns, REPLAY_VERSION, ReplayHeader } from '../server/src/replayFormat';
import { TRACK_GATES } from '../server/src/trackGates';
import { LapRecorder, RATE } from '../src/app/replayRecorder';
import { OsdPlayback, ReplayClock, ReplayTrack, SPEEDS } from '../src/app/replayTrack';
import { gatePassed } from '../src/maps/gates';
import { createShared, R, REC, RING_N } from '../src/worker/shared';
import { syntheticLap } from './helpers/replayLap';

/** A minute of hard flying at 100 Hz: loops, rolls, punch-outs (a realistic stream to compress). */
function flight(seconds = 60, rate = 100) {
  const n = Math.round(seconds * rate) + 1;
  const c: Record<string, Float64Array> = Object.fromEntries(COLUMNS.map((x) => [x.id, new Float64Array(n)]));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    c.px[i] = 60 * Math.sin(t * 0.4) + 3 * Math.sin(t * 2.3); c.py[i] = 40 * Math.sin(t * 0.8); c.pz[i] = 4 + 3 * Math.sin(t * 1.1) + 0.002 * rnd();
    // attitude: a roll that keeps turning (flips) about a wandering axis
    const a = t * 6 + Math.sin(t), ax = [Math.sin(t * 0.3), Math.cos(t * 0.3), 0.3], m = Math.hypot(...ax);
    c.qw[i] = Math.cos(a / 2); c.qx[i] = (Math.sin(a / 2) * ax[0]) / m; c.qy[i] = (Math.sin(a / 2) * ax[1]) / m; c.qz[i] = (Math.sin(a / 2) * ax[2]) / m;
    for (let k = 0; k < 4; k++) c[`rpm${k}`][i] = 18_000 + 9000 * Math.sin(t * 2 + k) + 300 * rnd();
    c.rc0[i] = Math.round(1500 + 450 * Math.sin(t * 1.7)); c.rc1[i] = Math.round(1500 + 300 * Math.sin(t * 0.9)); c.rc2[i] = Math.round(1550 + 300 * Math.sin(t * 0.5)); c.rc3[i] = Math.round(1500 + 100 * Math.sin(t * 2.9));
    c.vbus[i] = 24.6 - t * 0.03 - 1.5 * Math.max(0, Math.sin(t * 0.5)); c.ibus[i] = 20 + 40 * Math.max(0, Math.sin(t * 0.5)); c.mah[i] = t * 9;
    c.armed[i] = 1; c.modes[i] = 0; c.vrs[i] = Math.max(0, Math.sin(t * 0.2)) * 0.3;
  }
  return c;
}

const header = (n: number, rate = 100, extra: Partial<ReplayHeader> = {}): ReplayHeader => ({
  v: REPLAY_VERSION, app: 'test', date: 1, map: 'field', course: '', cls: 'freestyle5', summary: '5" Freestyle 6S', lapMs: 58_000, splitsMs: [],
  gates: [], rate, n, t0: -1, spec: { name: 'x' }, timeScale: 1, physicsHz: 8000, cols: [...COLUMNS], ...extra,
});

describe('format', () => {
  test('round trip: every column back within half its step, the header intact', async () => {
    const c = flight();
    const n = c.px.length;
    const osd: OsdFrame[] = [{ ms: 0, cols: 30, rows: 16, idx: Uint16Array.of(0, 5, 64 * 15 + 29), ch: Uint8Array.of(65, 66, 67), attr: Uint8Array.of(0, 0, 0x40) }, { ms: 1234, cols: 53, rows: 20, idx: Uint16Array.of(5), ch: Uint8Array.of(0x20), attr: Uint8Array.of(0) }];
    const bytes = await encodeReplay({ header: header(n), columns: c, osd });
    expect([...bytes.subarray(0, 6)]).toEqual([0x46, 0x50, 0x56, 0x52, REPLAY_VERSION, 1]);
    const d = await decodeReplay(bytes);
    expect(d.header).toMatchObject({ map: 'field', n, rate: 100, t0: -1, spec: { name: 'x' }, osd: true });
    for (const col of COLUMNS) {
      let worst = 0;
      for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(d.columns[col.id][i] - c[col.id][i]));
      expect(worst, col.id).toBeLessThanOrEqual(col.q / 2 + 1e-9);
    }
    expect(d.osd.map((f) => [f.ms, f.cols, f.rows, [...f.idx], [...f.ch], [...f.attr]])).toEqual([[0, 30, 16, [0, 5, 989], [65, 66, 67], [0, 0, 0x40]], [1234, 53, 20, [5], [0x20], [0]]]);
  });

  test('size: a hard minute at 100 Hz is well under 100 KB', async () => {
    const c = flight(60);
    const bytes = await encodeReplay({ header: header(c.px.length), columns: c, osd: [] });
    expect(bytes.length).toBeLessThan(100_000);
    expect(bytes.length).toBeLessThan(MAX_REPLAY_BYTES);
  });

  test('integers survive any size (positions kilometres away, in mm)', () => {
    const c = { id: 'x', q: 0.001, d: 2 as const };
    const v = Float64Array.of(4000, 4000.001, -3999.5, 1e6, -1e6, 0);
    const block = encodeColumn(v, c);
    const o = { header: { ...header(v.length), cols: [c] }, body: new Uint8Array([...varint(block.length), ...block, 0]), at: 0 };
    expect([...readColumns(o, undefined, false).columns.x].map((x) => +x.toFixed(3))).toEqual([...v]);
  });

  test('a reader skips columns it doesn’t need; junk is refused', async () => {
    const c = flight(5);
    const bytes = await encodeReplay({ header: header(c.px.length), columns: c, osd: [] });
    const only = readColumns(await openReplay(bytes), ['pz'], false).columns;
    expect(Object.keys(only)).toEqual(['pz']);
    await expect(openReplay(new Uint8Array(20))).rejects.toThrow(/not an FPV Sim replay/);
    const v2 = bytes.slice(); v2[4] = 99;
    await expect(openReplay(v2)).rejects.toThrow(/version 99/);
    await expect(openReplay(bytes.slice(0, bytes.length / 2))).rejects.toThrow();
    // a gzip bomb stops at the inflate limit
    await expect(openReplay(bytes, 1000)).rejects.toThrow(/too big/);
  });
});

function varint(v: number): number[] { const o: number[] = []; while (v >= 128) { o.push((v % 128) | 128); v = Math.floor(v / 128); } o.push(v); return o; }

// ---------------------------------------------------------------------------------------------

const subOf = (l: Awaited<ReturnType<typeof syntheticLap>>): Submission => {
  const p = parseSubmission({ v: 2, client: '0123456789abcdef0123456789abcdef', map: l.map, course: l.course || undefined, class: l.cls, initials: 'ACE', lapMs: l.lapMs, splitsMs: l.splitsMs, timeScale: 1, summary: '' });
  if (!p.ok) throw new Error(p.error);
  return p.sub;
};

describe('the relay’s replay check', () => {
  test('the gate test agrees with the sim’s (src/maps/gates.ts), on every track', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [key, gates] of Object.entries(TRACK_GATES)) for (const g of gates) for (let k = 0; k < 300; k++) {
      const c = { x: g.x, y: g.y, z: g.z + (g.kind === 'dive' ? 0 : g.h / 2) };
      const a = { x: c.x + (rnd() - 0.5) * 6, y: c.y + (rnd() - 0.5) * 6, z: c.z + (rnd() - 0.5) * 6 }, b = { x: c.x + (rnd() - 0.5) * 6, y: c.y + (rnd() - 0.5) * 6, z: c.z + (rnd() - 0.5) * 6 };
      const def = { id: g.id, kind: g.kind, c: { x: g.x, y: g.y, z: g.z }, yaw: g.yaw, width: g.w, height: g.h };
      expect(passFraction(g, a.x, a.y, a.z, b.x, b.y, b.z) >= 0, `${key} gate ${g.id}`).toBe(gatePassed(def, a, b));
    }
  });

  test.each(Object.keys(TRACKS))('a lap that flies %s passes', async (track) => {
    const l = await syntheticLap(track);
    const v = await checkReplay(l.replay, subOf(l));
    expect(v.ok ? v.facts.gateErrMs : v.error).toBeLessThan(2);
  });

  test('refused: another lap, gates at other times, a jump, too fast, speeding up too hard', async () => {
    const l = await syntheticLap('field');
    const sub = subOf(l);
    const err = async (bytes: Uint8Array, s = sub) => { const v = await checkReplay(bytes, s); return v.ok ? 'ok' : v.error; };
    expect(await err(l.replay, { ...sub, lapMs: sub.lapMs - 500, splitsMs: [...sub.splitsMs.slice(0, -1), sub.lapMs - 500] })).toMatch(/differ from the posted lap/);
    expect(await err(l.replay, { ...sub, cls: 'race5' })).toMatch(/another track or drone class/);
    expect(await err(l.replay, { ...sub, map: 'quarry-loop' })).toMatch(/another track/);
    // a header that claims other split times than the path flies
    const late = await syntheticLap('field', 'freestyle5', { splitShift: 0.2 });
    expect(await err(late.replay, subOf(late))).toMatch(/doesn’t pass through gate 2/);
    const jump = await syntheticLap('field', 'freestyle5', { jumpAt: 5 });
    expect(await err(jump.replay, subOf(jump))).toMatch(/jumps/);
    // a whoop flying a 5"'s speed (on its own the lap is already too fast for the board: the replay check stands without it)
    const fastWhoop = await syntheticLap('field', 'whoop65', { speed: 30 });
    expect(await err(fastWhoop.replay, { ...sub, cls: 'whoop65', lapMs: fastWhoop.lapMs, splitsMs: fastWhoop.splitsMs })).toMatch(/faster than this drone class/);
    // a whoop's sideways kick to 17 m/s in a tenth of a second (170 m/s², three times what it can)
    const kickAt = (t: number) => (t < 1 ? 0 : t < 1.1 ? 85 * (t - 1) ** 2 : t < 1.4 ? 0.85 + 17 * (t - 1.1) : 5.95);
    const kick = await syntheticLap('gym', 'whoop65', { speed: 3, modify: (c, t) => { for (let i = 0; i < t.length; i++) c.px[i] += kickAt(t[i]); } });
    expect(await err(kick.replay, subOf(kick))).toMatch(/speeds up by 1[67]\.\d m\/s in 0.25 s/);
    expect(await err(new Uint8Array(MAX_REPLAY_BYTES + 1))).toMatch(/too big/);
    expect(await err(Uint8Array.of(1, 2, 3))).toMatch(/not an FPV Sim replay/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('recording', () => {
  /** A fake worker: writes the ring at 1 kHz from f(t). */
  function ringWriter(f: (t: number, r: Float64Array, o: number) => void) {
    const sh = createShared();
    let k = 0;
    return {
      sh,
      until(t: number) {
        for (; k / 1000 <= t; k++) {
          const o = (k % RING_N) * REC;
          sh.ring.fill(0, o, o + REC);
          sh.ring[o + R.t] = k / 1000; sh.ring[o + R.qw] = 1;
          f(k / 1000, sh.ring, o);
          Atomics.store(sh.ctrl, 1, k + 1);
        }
      },
    };
  }

  test('a lap from gate 0 to gate 0, with a second before and after, sampled at 100 Hz', async () => {
    const w = ringWriter((t, r, o) => { r[o + R.px] = t * 10; r[o + R.pz] = 2; r[o + R.rpm0] = 1000 * t; r[o + R.rc2] = 1200; r[o + R.armed] = 1; r[o + R.vbus] = 16; });
    const rec = new LapRecorder();
    rec.osd = false;
    let wall = 0, start = -1, replay: Promise<Uint8Array | null> | null = null;
    // the pilot flies; gate 0 at 3 s starts a lap, gate 0 at 12 s ends it
    for (let t = 0; t <= 14; t += 1 / 60) {
      w.until(t); wall += 1000 / 60;
      if (start < 0 && t >= 3) start = 3;
      if (!replay && t >= 12.02) replay = rec.finishLap({ start: 3, gates: [{ id: 0, t: 0 }, { id: 1, t: 4 }, { id: 0, t: 9 }], meta: { app: 't', date: 0, map: 'field', course: '', cls: 'freestyle5', summary: '', lapMs: 9000, splitsMs: [4000, 9000], spec: {}, timeScale: 1, physicsHz: 8000 } }, wall);
      rec.pump(w.sh, start >= 0 && !replay ? start - 1 : null, 0, wall);
      expect(rec.held).toBeLessThan(13 * RATE); // never more than the lap needs
    }
    const bytes = await replay!;
    expect(bytes).toBeInstanceOf(Uint8Array);
    const d = await decodeReplay(bytes!);
    expect(d.header).toMatchObject({ rate: RATE, lapMs: 9000, gates: [{ id: 0, t: 0 }, { id: 1, t: 4 }, { id: 0, t: 9 }] });
    expect(d.header.t0).toBeCloseTo(-1, 6);
    expect(d.header.t0 + (d.header.n - 1) / RATE).toBeCloseTo(10, 6);
    // the samples are the ring's state at their times
    for (const i of [0, 100, 450, d.header.n - 1]) {
      const t = 3 + d.header.t0 + i / RATE;
      expect(d.columns.px[i]).toBeCloseTo(t * 10, 3);
      expect(d.columns.rpm0[i]).toBeCloseTo(1000 * t, -1);
    }
    expect(rec.last?.lap.meta.lapMs).toBe(9000);
  });

  test('a stall longer than the ring loses the lap (no replay rather than a broken one)', async () => {
    const w = ringWriter((t, r, o) => { r[o + R.px] = t; });
    const rec = new LapRecorder();
    w.until(2); rec.pump(w.sh, 1, 0, 0);
    const replay = rec.finishLap({ start: 2, gates: [{ id: 0, t: 0 }, { id: 0, t: 5 }], meta: {} as any }, 0);
    w.until(10); rec.pump(w.sh, 1, 0, 100); // 8 s in one go: the ring only holds 2
    expect(await replay).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('playback', () => {
  test('the state at a sample is the sample; between samples the path is smooth', async () => {
    const c = flight(10);
    const bytes = await encodeReplay({ header: header(c.px.length, 100, { t0: -1 }), columns: c, osd: [] });
    const tr = new ReplayTrack(await decodeReplay(bytes));
    const out = new Float64Array(REC);
    tr.sample(-1 + 2.5, out);
    expect(out[R.px]).toBeCloseTo(c.px[250], 3);
    expect(Math.hypot(out[R.qw], out[R.qx], out[R.qy], out[R.qz])).toBeCloseTo(1, 9);
    // velocity from the spline matches the motion
    tr.sample(3.005, out);
    const vx = (c.px[402] - c.px[399]) / 0.03;
    expect(out[R.vx]).toBeCloseTo(vx, 0);
    // clamped outside the recording
    tr.sample(-50, out); expect(out[R.px]).toBeCloseTo(c.px[0], 3);
    expect(tr.passed(0)).toBe(0);
  });

  test('the OSD grid at any time, forwards and backwards', () => {
    const f = (ms: number, i: number, ch: number): OsdFrame => ({ ms, cols: 30, rows: 16, idx: Uint16Array.of(i), ch: Uint8Array.of(ch), attr: Uint8Array.of(0) });
    const o = new OsdPlayback([f(0, 3, 65), f(100, 3, 66), f(200, 4, 67)]);
    o.seek(150); expect([o.osd[3], o.osd[4]]).toEqual([66, 0x20]);
    const seq = o.ctrl[2];
    o.seek(160); expect(o.ctrl[2]).toBe(seq); // nothing changed: no redraw
    o.seek(250); expect([o.osd[3], o.osd[4]]).toEqual([66, 67]);
    o.seek(50); expect([o.osd[3], o.osd[4]]).toEqual([65, 0x20]);
  });

  test('clock: play, pause, speed, seek, frame step, restart, loop', () => {
    const c = new ReplayClock(-1, 10, 0.01);
    expect([c.t, c.playing, c.speed]).toEqual([-1, true, 1]);
    c.tick(0.2); expect(c.t).toBeCloseTo(-0.8);
    c.faster(); c.faster(); expect(c.speed).toBe(4);
    c.faster(); expect(c.speed).toBe(SPEEDS[SPEEDS.length - 1]);
    c.tick(0.25); expect(c.t).toBeCloseTo(0.2);
    c.tick(5); expect(c.t).toBeCloseTo(1.2); // a long gap (hidden tab) moves at most 0.25 s of wall time
    c.setSpeed(0); expect(c.speed).toBe(0.1);
    c.slower(); expect(c.speed).toBe(0.1);
    c.toggle(); expect(c.playing).toBe(false);
    c.tick(1); expect(c.t).toBeCloseTo(1.2);
    let seq = c.seq;
    c.seek(99); expect([c.t, c.seq > seq]).toEqual([10, true]);
    c.seek(-99); expect(c.t).toBe(-1);
    c.seek(2.004); c.step(1); expect(c.t).toBeCloseTo(2.01, 6); expect(c.playing).toBe(false);
    c.step(-1); c.step(-1); expect(c.t).toBeCloseTo(1.99, 6);
    // the end: stop there, or with loop on go round
    c.setSpeed(SPEEDS.indexOf(1)); c.seek(9.9); c.play(); c.tick(0.2);
    expect([c.t, c.playing, c.atEnd]).toEqual([10, false, true]);
    c.play(); expect(c.t).toBe(-1); // play at the end starts over
    c.loop = true; c.seek(9.9); seq = c.seq; c.tick(0.2);
    expect(c.t).toBeCloseTo(-0.9); expect(c.playing).toBe(true); expect(c.seq).toBeGreaterThan(seq);
    seq = c.seq; c.restart(); expect([c.t, c.playing, c.seq > seq]).toEqual([-1, true, true]);
  });
});
