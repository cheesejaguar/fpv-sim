// The stick poller's paused mode: a slow tick while a menu is open, the full rate back at once on wake().
import { expect, test } from 'vitest';
import { WorkerBridge } from '../src/app/bridge';
import { createShared } from '../src/worker/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('slow mode polls at the slow interval; wake() polls at once and the full rate resumes', async () => {
  const sh = createShared();
  let n = 0, slow = true;
  const ch = new Float32Array(16).fill(1500);
  const stop = WorkerBridge.pollSticks(sh, () => { n++; return ch; }, () => null, { slow: () => slow, slowMs: 1000 });
  try {
    await sleep(150);
    expect(n).toBe(1); // the first poll, then a 1 s slow tick pending
    slow = false;
    stop.wake(); // controls handed back: no waiting for the pending slow tick
    await sleep(150);
    expect(n).toBeGreaterThan(10); // ~1 ms ticks again
    expect(Atomics.load(sh.ctrl, 8)).toBe(n); // every poll wrote one stick sample
  } finally { stop(); }
  const after = n;
  await sleep(30);
  expect(n).toBe(after); // stopped
});

test('wake() while polling at full rate starts no second chain', async () => {
  const sh = createShared();
  let n = 0;
  const ch = new Float32Array(16).fill(1500);
  const stop = WorkerBridge.pollSticks(sh, () => { n++; return ch; }, () => null);
  await sleep(50);
  for (let i = 0; i < 50; i++) stop.wake();
  const a = n;
  await sleep(50);
  const rate = n - a;
  stop();
  // one chain: about as many polls in the second 50 ms as there are ~1 ms ticks, not 50 extra chains
  expect(rate).toBeLessThan(200);
});
