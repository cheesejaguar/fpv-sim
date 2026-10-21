// Saved settings: versioned storage, migration of pre-versioning values, and the validators that
// keep a stale or corrupt value from breaking the boot.
import { describe, expect, test } from 'vitest';
import { KEYS, KV, load, OSD_FONTS, parseSpec, readStored, save, STORE_VERSION, validNewGame, validSim, validSpec, validView } from '../src/app/persist';
import { DroneSpec, PRESETS } from '../src/builder/derive';
import { DEFAULT_VIEW } from '../src/ui/settingsPanel';
import { DEFAULT_SETTINGS } from '../src/worker/shared';

const EASY = PRESETS.find((p) => /65 mm/.test(p.name))!;
const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  const writes: string[] = [];
  const kv: KV = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { writes.push(k); m.set(k, v); } };
  return { kv, m, writes };
};

describe('storage envelope', () => {
  test('missing, unreadable and current values', () => {
    const { kv } = mem({ a: '{not json', b: JSON.stringify({ v: 1, data: { x: 1 } }), c: JSON.stringify({ x: 2 }) });
    expect(readStored('none', kv)).toBeUndefined();
    expect(readStored('a', kv)).toBeUndefined();
    expect(readStored('b', kv)).toEqual({ v: 1, data: { x: 1 } });
    expect(readStored('c', kv)).toEqual({ v: 0, data: { x: 2 } }); // pre-versioning bare value
    expect(readStored('x', null)).toBeUndefined();
  });

  test('a pre-versioning value is validated and re-saved in the current format', () => {
    const { kv, m, writes } = mem({ [KEYS.view]: JSON.stringify({ volume: 0.8, view: 'chase', bogus: 1 }) });
    const v = load(KEYS.view, validView, kv);
    expect(v).toEqual({ ...DEFAULT_VIEW, volume: 0.8, view: 'chase' });
    expect(writes).toEqual([KEYS.view]);
    expect(JSON.parse(m.get(KEYS.view)!)).toEqual({ v: STORE_VERSION, data: v });
    // current format: read as is, not rewritten
    expect(load(KEYS.view, validView, kv)).toEqual(v);
    expect(writes).toHaveLength(1);
  });

  test('broken storage never throws', () => {
    const throwing: KV = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(load(KEYS.sim, validSim, throwing)).toEqual(DEFAULT_SETTINGS);
    expect(() => save(KEYS.sim, DEFAULT_SETTINGS, throwing)).not.toThrow();
    expect(load(KEYS.sim, validSim, null)).toEqual(DEFAULT_SETTINGS);
  });

  test('save writes the envelope', () => {
    const { kv, m } = mem();
    save(KEYS.spec, EASY, kv);
    expect(JSON.parse(m.get(KEYS.spec)!)).toEqual({ v: STORE_VERSION, data: EASY });
    expect(load(KEYS.spec, (r) => validSpec(r, EASY), kv)).toEqual(EASY);
  });
});

describe('drone build', () => {
  test('every preset round-trips unchanged (same JSON, so preset matching still works)', () => {
    for (const p of PRESETS) expect(JSON.stringify(parseSpec(JSON.parse(JSON.stringify(p))))).toBe(JSON.stringify(p));
  });

  test('unknown component ids fall back to the 65 mm whoop', () => {
    for (const k of ['frame', 'motor', 'prop', 'battery', 'esc', 'fc', 'video'] as const) {
      const s = validSpec({ ...PRESETS[0], [k]: 'removed-part' }, EASY);
      expect(s, k).toEqual(EASY);
      expect(s).not.toBe(EASY); // a copy: editing it must not change the preset
    }
    expect(validSpec({ ...PRESETS[0], motor: 42 }, EASY)).toEqual(EASY);
    for (const bad of [undefined, null, 'x', 3, [], [PRESETS[0]]]) expect(validSpec(bad, EASY)).toEqual(EASY);
    expect(parseSpec({ frame: 'constructor' })).toBeNull();
  });

  test('numbers are range-checked, wrong types take the default', () => {
    const s = validSpec({ ...PRESETS[0], cameraUptiltDeg: 400, extraMassG: -5, batterySoc: 'full', batteryAge: NaN, motorTiltDeg: null, propDirection: 'sideways', batteryMount: 'side', name: 7 }, EASY)!;
    expect(s.cameraUptiltDeg).toBe(90);
    expect(s.extraMassG).toBe(0);
    expect(s.batterySoc).toBe(PRESETS[0].batterySoc);
    expect(s.batteryAge).toBe(PRESETS[0].batteryAge);
    expect(s.motorTiltDeg).toBe(PRESETS[0].motorTiltDeg);
    expect(s.propDirection).toBe(PRESETS[0].propDirection);
    expect(s.batteryMount).toBe(PRESETS[0].batteryMount);
    expect(s.name).toBe(PRESETS[0].name);
  });

  test('overrides: clamped, junk dropped, newer numeric overrides kept', () => {
    const raw = JSON.parse(JSON.stringify({ ...PRESETS[0], overrides: { kv: 1e9, cells: 4.4, massScale: 'x', rmMohm: null, futureKnob: 2 } }));
    raw.overrides = JSON.parse('{"kv":1e9,"cells":4.4,"massScale":"x","rmMohm":null,"futureKnob":2,"__proto__":{"polluted":true}}');
    const s = validSpec(raw, EASY);
    expect(s.overrides).toEqual({ kv: 100000, cells: 4, futureKnob: 2 });
    expect(Object.getPrototypeOf(s.overrides)).toBe(Object.prototype);
    expect(({} as any).polluted).toBeUndefined();
    expect(validSpec({ ...PRESETS[0], overrides: [1, 2] }, EASY).overrides).toEqual({});
  });

  test('fields this version does not know are dropped', () => {
    const s = validSpec({ ...PRESETS[0], hacked: '<img>' }, EASY) as DroneSpec & { hacked?: string };
    expect(s.hacked).toBeUndefined();
  });
});

describe('simulation settings', () => {
  test('defaults when missing', () => {
    const s = validSim(undefined);
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.wind).not.toBe(DEFAULT_SETTINGS.wind);
  });

  test('map id must be a map this build has', () => {
    expect(validSim({ mapId: 'bando' }).mapId).toBe('bando');
    for (const bad of ['no-such-map', '__proto__', 'constructor', 'local-mine', 5]) expect(validSim({ mapId: bad }).mapId, String(bad)).toBe(DEFAULT_SETTINGS.mapId);
  });

  test('wind is merged field by field', () => {
    const s = validSim({ wind: { speed: 6, direction: -90, gusts: 'many' } });
    expect(s.wind).toEqual({ ...DEFAULT_SETTINGS.wind, speed: 6, direction: 270 });
    expect(validSim({ wind: 'calm' }).wind).toEqual(DEFAULT_SETTINGS.wind);
    expect(validSim({ wind: { speed: 1e6 } }).wind.speed).toBe(40);
  });

  test('ranges and enums', () => {
    const s = validSim({ physicsHz: 3000, timeScale: 0, rcLinkHz: 0, rcTxPowerMw: Infinity, ambientC: -300, propwash: 2, damage: 'yes', paused: true });
    expect(s.physicsHz).toBe(8000);
    expect(s.timeScale).toBe(0.05);
    expect(s.rcLinkHz).toBe(25); // never 0: the worker divides by it
    expect(s.rcTxPowerMw).toBe(DEFAULT_SETTINGS.rcTxPowerMw);
    expect(s.ambientC).toBe(-40);
    expect(s.propwash).toBe(2);
    expect(s.damage).toBe(true);
    expect(s.paused).toBe(false);
    expect(validSim({ physicsHz: 4000 }).physicsHz).toBe(4000);
  });
});

describe('view settings', () => {
  test('defaults, enums and ranges', () => {
    expect(validView(null)).toEqual(DEFAULT_VIEW);
    const v = validView({ osdFont: '../../evil', volume: 7, view: 'top', cubeSize: '768', renderScale: 0.1, audio: 0, latencyOverrideMs: 20 });
    expect(v.osdFont).toBe('betaflight');
    expect(v.volume).toBe(1);
    expect(v.view).toBe('fpv');
    expect(v.cubeSize).toBe(DEFAULT_VIEW.cubeSize);
    expect(v.renderScale).toBe(0.25);
    expect(v.audio).toBe(DEFAULT_VIEW.audio);
    expect(v.latencyOverrideMs).toBe(20);
    for (const f of OSD_FONTS) expect(validView({ osdFont: f }).osdFont).toBe(f);
  });
});

describe('new game choices', () => {
  const MODES = ['free', 'race', 'drill'] as const;
  test('mode and preset', () => {
    expect(validNewGame({ mode: 'race', preset: 2 }, MODES)).toEqual({ mode: 'race', preset: 2 });
    expect(validNewGame({ mode: 'race', preset: -2 }, MODES)).toEqual({ mode: 'race', preset: -2 });
    expect(validNewGame({ mode: 'deathmatch', preset: PRESETS.length }, MODES)).toEqual({ mode: 'free', preset: -1 });
    expect(validNewGame({ preset: 1.5 }, MODES)).toEqual({ mode: 'free', preset: -1 });
    expect(validNewGame('junk', MODES)).toEqual({ mode: 'free', preset: -1 });
  });
});
