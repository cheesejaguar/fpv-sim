// Starting points for a new map: blank, a race field, a freestyle lot, an indoor gym and a research
// range. Each is a valid fpvsim-map v1 document (tests/editorDoc.test.ts checks them).
import type { GateDoc, MapDocV1, PrimDoc } from '../maps/mapDoc';
import { placePrefab, prefabById } from './prefabs';

export interface Template { id: string; name: string; blurb: string; make(): MapDocV1 }

/** meta.id from a map name: 2-24 characters of a-z, 0-9 and "-". */
export function deriveId(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  return s.length >= 2 ? s : s ? `${s}-map` : 'my-map';
}

const pad = (x: number, y: number): PrimDoc => ({ type: 'box', pos: [x, y, 0.02], size: [1.2, 1.2, 0.04], visual: 'pad', material: 'concrete' });

function base(name: string, size: number, tags: string[], description: string): MapDocV1 {
  return {
    format: 'fpvsim-map', formatVersion: 1,
    meta: { id: deriveId(name), name, author: 'Anonymous', license: 'CC-BY-4.0', version: '1.0.0', description, tags },
    size, spawn: { pos: [0, 0, 0], yawDeg: 90 },
    ground: { type: 'flat', material: 'grass' },
    primitives: [pad(0, 0)],
  };
}

/** Prefab parts at a spot, as one group (so the template's pieces select like hand-placed ones). */
function prefab(doc: MapDocV1, id: string, at: [number, number, number], yawDeg: number, params: Record<string, number> = {}) {
  const pf = prefabById(id)!, x = doc as unknown as Record<string, any>;
  x['x-builder'] ??= { nextUid: 1 };
  const g = `g${x['x-builder'].nextUid++}`;
  const out = placePrefab(pf, params, at, yawDeg, g);
  (x['x-builder'].groups ??= {})[g] = { prefab: id, params, pos: at, yawDeg };
  doc.primitives = [...(doc.primitives ?? []), ...out.prims];
  if (out.lights.length) doc.lights = [...(doc.lights ?? []), ...out.lights];
}

export const TEMPLATES: Template[] = [
  { id: 'blank', name: 'Blank', blurb: 'Flat grass, a start pad, nothing else', make: () => base('My map', 100, [], 'A new map.') },
  { id: 'race', name: 'Race field', blurb: 'Grass field with a six-gate loop and a start pad', make: () => {
    const d = base('My race field', 120, ['race'], 'A race course.');
    const gates: GateDoc[] = [
      { kind: 'square', pos: [0, 14], yawDeg: 0 }, { kind: 'arch', pos: [12, 30], yawDeg: -55 }, { kind: 'square', pos: [30, 34], yawDeg: -110 },
      { kind: 'dive', pos: [44, 18, 3], yawDeg: 180 }, { kind: 'hurdle', pos: [30, 0], yawDeg: 125 }, { kind: 'flag', pos: [14, -4], yawDeg: 135 },
    ];
    d.gates = gates;
    d.trees = [[-20, 30], [-24, 10], [60, 40], [62, 0], [20, 50]].map(([x, y], i) => ({ pos: [x, y] as [number, number], height: 9 + (i % 3) * 2, radius: 3, type: i % 2 ? 'oak' : 'pine' }));
    return d;
  } },
  { id: 'freestyle', name: 'Freestyle lot', blurb: 'Concrete lot with containers, ramps, rails and a bando wall', make: () => {
    const d = base('My freestyle spot', 100, ['freestyle'], 'A freestyle spot.');
    d.ground = { type: 'flat', material: 'concrete' };
    prefab(d, 'container', [10, 6, 0], 0, { length: 6.06, stack: 2 });
    prefab(d, 'container', [10, -4, 0], 10, { length: 6.06, stack: 1 });
    prefab(d, 'ramp', [-12, 4, 0], 0);
    prefab(d, 'rail', [-6, -10, 0], 90);
    prefab(d, 'pallets', [4, 14, 0], 30, { count: 7 });
    prefab(d, 'bando-wall', [20, 18, 0], 180, { length: 14, height: 7, floors: 2, windows: 4 });
    prefab(d, 'water-tower', [-25, 25, 0], 0);
    return d;
  } },
  { id: 'gym', name: 'Indoor gym', blurb: 'Walled hall with no wind, four lights and small gates', make: () => {
    const d = base('My indoor gym', 40, ['indoor', 'race'], 'An indoor track.');
    d.ground = { type: 'flat', material: 'concrete' };
    d.environment = { sky: 'overcast', windScale: 0.05 };
    const W = 30, D = 20, H = 8, t = 0.3, wall = { material: 'concrete' as const, visual: 'brick' as const };
    d.primitives!.push(
      { type: 'box', pos: [0, D / 2 + t / 2, H / 2], size: [W + 2 * t, t, H], ...wall }, { type: 'box', pos: [0, -D / 2 - t / 2, H / 2], size: [W + 2 * t, t, H], ...wall },
      { type: 'box', pos: [W / 2 + t / 2, 0, H / 2], size: [t, D, H], ...wall }, { type: 'box', pos: [-W / 2 - t / 2, 0, H / 2], size: [t, D, H], ...wall });
    d.spawn = { pos: [-12, -7, 0], yawDeg: 0 };
    d.primitives![0] = pad(-12, -7);
    d.indoor = [{ min: [-W / 2, -D / 2, 0], max: [W / 2, D / 2, H], windScale: 0.02 }];
    d.lights = [[-8, -5], [8, -5], [-8, 5], [8, 5]].map(([x, y]) => ({ pos: [x, y, H - 0.5] as [number, number, number], color: '#fff1dc', intensity: 120, range: 25 }));
    d.gates = [
      { kind: 'square', pos: [-12, 0], yawDeg: 0 }, { kind: 'square', pos: [0, 6], yawDeg: -90 }, { kind: 'ladder', pos: [11, 0], yawDeg: 180, stack: 2 }, { kind: 'square', pos: [0, -6], yawDeg: 90 },
    ];
    return d;
  } },
  { id: 'research', name: 'Research range', blurb: 'Rolling terrain, two spawns, a moving target, a jammer, a radar and a relay', make: () => {
    const d = base('My research range', 400, ['research'], 'A test range for detection, RF and tracking experiments.');
    d.ground = { type: 'noise', material: 'grass', base: 0, layers: [{ scale: 120, amplitude: 6, octaves: 4, seed: 7, mask: { shape: 'circle', from: 60, to: 140 } }] };
    d.environment = { wind: { speed: 4, directionDeg: 240, turbulence: 1, gusts: 2 } };
    d.spawns = [{ id: 'west', name: 'West pad', pos: [0, 0, 0], yawDeg: 0 }, { id: 'north', name: 'North pad', pos: [0, 50, 0], yawDeg: -90, pilot: [-3, 48, 1.6] }];
    d.primitives!.push(pad(0, 50));
    d.paths = [{ id: 'patrol', points: [[60, -40, 1], [140, -40, 1], [140, 60, 1], [60, 60, 1]], speedMs: 4, mode: 'loop' }];
    d.actors = [
      { type: 'target', id: 'truck', name: 'Moving truck', path: 'patrol', shape: 'vehicle', color: '#c8b04a' },
      { type: 'target', id: 'crate', name: 'Supply crate', pos: [80, 120, 0], shape: 'box', radiusM: 1, solid: true },
      { type: 'rf-emitter', id: 'jammer-1', name: 'Jammer', pos: [180, 20, 3], freqMHz: 2440, eirpDbm: 36, bwMHz: 80 },
      { type: 'detector', id: 'radar-1', name: 'Radar', pos: [100, 160, 4], sensor: 'radar', yawDeg: -90, pitchDeg: 5, fovDeg: [90, 30], rangeM: 800 },
      { type: 'ground-station', id: 'relay-1', name: 'Relay mast', pos: [40, 60, 6], link: 'both' },
    ];
    return d;
  } },
];
