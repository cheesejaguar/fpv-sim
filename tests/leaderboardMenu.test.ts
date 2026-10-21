// The leaderboard screen's track list and the board it opens on.
import { expect, test } from 'vitest';
import { boardTracks, DEFAULT_TRACK } from '../src/ui/menu/leaderboard';

test('the board opens on the FPV Grand Prix Stadium, which is a listed track', () => {
  const t = boardTracks().find((x) => x.key === DEFAULT_TRACK);
  expect(t?.label).toBe('FPV Grand Prix Stadium');
  expect(t?.course).toBe('');
});
