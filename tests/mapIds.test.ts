// Map ids come from other pilots and from storage: inherited object members must never resolve.
import { expect, test } from 'vitest';
import { hasMap, MAP_LIST, MAPS } from '../src/maps/maps';

test('prototype member names are unknown maps', () => {
  for (const bad of ['constructor', '__proto__', 'prototype', 'toString', 'hasOwnProperty']) {
    expect(hasMap(bad), bad).toBe(false);
    expect((MAPS as any)[bad], bad).toBeUndefined();
    expect((MAP_LIST as any)[bad], bad).toBeUndefined();
  }
  expect(hasMap('field')).toBe(true);
  expect(hasMap(42)).toBe(false);
});
