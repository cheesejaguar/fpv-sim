// Replay permalinks (/?replay=<entry id>[&t=<s>]) and the player's redraw on a view change.
import { describe, expect, test } from 'vitest';
import { parseReplayLink, replayUrl, withoutReplayLink } from '../src/app/replayLink';
import { ReplayClock } from '../src/app/replayTrack';

describe('replay permalinks', () => {
  test('round trip: the entry id, and a start time kept to 0.01 s', () => {
    expect(replayUrl('https://fpv-sim-gamma.vercel.app/', 42)).toBe('https://fpv-sim-gamma.vercel.app/?replay=42');
    const u = new URL(replayUrl('https://fpv-sim-gamma.vercel.app', 42, 12.3456));
    expect(u.search).toBe('?replay=42&t=12.35');
    expect(parseReplayLink(u.search)).toEqual({ id: 42, t: 12.35 });
    expect(parseReplayLink('?replay=7')).toEqual({ id: 7 });
    expect(parseReplayLink('?replay=7&t=-1')).toEqual({ id: 7, t: -1 }); // the approach to gate 0 is recorded too
  });

  test('anything else is not a replay link; a bad start time is dropped, not fatal', () => {
    for (const q of ['', '?room=ABCD', '?replay=', '?replay=0', '?replay=-3', '?replay=abc', '?replay=1e3', `?replay=${'9'.repeat(13)}`]) expect(parseReplayLink(q), q).toBeNull();
    expect(parseReplayLink('?replay=5&t=soon')).toEqual({ id: 5 });
    expect(parseReplayLink('?replay=5&t=99999')).toEqual({ id: 5 });
  });

  test('leaving a replay keeps the rest of the address (an invite link stays)', () => {
    expect(withoutReplayLink('https://x.app/?room=ABCD&replay=3&t=2#s=1')).toBe('/?room=ABCD#s=1');
    expect(withoutReplayLink('https://x.app/?replay=3')).toBe('/');
  });
});

test('a view change while paused draws the playhead again (the camera starts over on seq)', () => {
  const c = new ReplayClock(-1, 30);
  c.pause();
  const s = c.seq;
  c.redraw();
  expect(c.seq).toBe(s + 1);
  expect(c.playing).toBe(false); // still paused, same moment
  expect(c.t).toBe(-1);
  expect(new ReplayClock(-1, 30, 0.01, 12.5).t).toBe(12.5); // a permalink's start time
  expect(new ReplayClock(-1, 30, 0.01, 99).t).toBe(30);
});
