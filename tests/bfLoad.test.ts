// Loading the Betaflight WASM build the way the worker does: the .wasm compiled on its own (fetched
// in parallel with the Emscripten glue, at worker start) and handed to the glue through
// Module.instantiateWasm. Skipped when the firmware hasn't been built.
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { Betaflight } from '../src/bf/bfModule';
import { runCliBatch } from '../src/worker/fwCli';

const FW = new URL('../public/bf/betaflight.mjs', import.meta.url);
const WASM = new URL('../public/bf/betaflight.wasm', import.meta.url);
const have = existsSync(FW) && existsSync(WASM);
const path = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const factory = async () => (await import(/* @vite-ignore */ pathToFileURL(path(FW)).href)).default;

/** Boot, run 0.5 s of firmware time with a level quad at rest, then a CLI batch. */
function exercise(bf: Betaflight) {
  const rc = new Float32Array(16).fill(1500); rc[2] = 1000; rc[4] = 1000;
  let rcAcc = 0;
  const advance = (ms: number) => {
    for (let i = 0; i < ms * 8; i++) { bf.setImu(0, 0, 0, 0, 0, 9.80665); bf.setBattery(16.4, 0.3, 0); if (++rcAcc >= 32) { rcAcc = 0; bf.setRc(rc); } bf.step(125); }
  };
  bf.setBattery(16.4, 0, 0); bf.setImu(0, 0, 0, 0, 0, 9.80665); bf.setRc(rc);
  bf.init();
  advance(500);
  const out = runCliBatch(bf, ['get small_angle', 'set craft_name = HOOK', 'save'], advance);
  return { out, eeprom: bf.eepromGet(), flags: bf.armingDisableFlags() };
}

describe.skipIf(!have)('firmware loading through Module.instantiateWasm', () => {
  test('a separately compiled module boots exactly like the glue\'s own instantiation', async () => {
    const own = exercise(await Betaflight.fromFactory(await factory()));
    const pre = await Betaflight.fromFactory(await factory(), WebAssembly.compile(readFileSync(path(WASM))));
    expect(pre.version).toMatch(/Betaflight/);
    const viaHook = exercise(pre);
    expect(viaHook.out).toMatch(/small_angle = \d+/);
    expect(viaHook.out).toBe(own.out);
    expect(viaHook.flags).toBe(own.flags);
    expect(Buffer.from(viaHook.eeprom).equals(Buffer.from(own.eeprom))).toBe(true);
  }, 60000);

  test('a failed compile rejects instead of hanging', async () => {
    const bad = Promise.reject(new Error('compile failed'));
    bad.catch(() => {});
    await expect(Betaflight.fromFactory(await factory(), bad)).rejects.toThrow(/compile failed/);
  }, 30000);
});
