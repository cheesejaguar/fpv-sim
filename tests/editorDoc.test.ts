// Map builder model (src/editor/): undo / redo, drafts -> packages -> the loader, the heightfield's
// 16-bit PNG round trip, the .zip export, prefab expansion and course length.
import { describe, expect, it } from 'vitest';
import { EditorDoc, gridHf } from '../src/editor/editorDoc';
import { autosave, deleteDraft, duplicateDraft, listDrafts, loadDraft, saveDraft, useStore } from '../src/editor/drafts';
import { checkPackage, exportDoc, filesSource, openFiles, packageFiles, zipPackage } from '../src/editor/package';
import { placePrefab, PREFABS, prefabDefaults } from '../src/editor/prefabs';
import { lapLength, racingLine, raceProblems } from '../src/editor/racing';
import { deriveId, TEMPLATES } from '../src/editor/templates';
import { sculpt, toHeightfield } from '../src/editor/terrain';
import { BUDGETS, buildMapDef, decodePngChannel, loadMapPackage, makeTerrain, validateMapDoc, type MapDocV1 } from '../src/maps/mapFormat';
import { MAPS } from '../src/maps/maps';
import { readZip } from '../src/maps/zip';
import { courseLength } from '../src/training/curriculum';
import { MemoryKv } from '../src/worker/kv';

const blank = () => new EditorDoc(TEMPLATES[0].make());
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
/** A draft round trip: package files -> the loader (as Fly and Load map run it). */
async function load(ed: EditorDoc) {
  const files = await packageFiles(ed);
  return { files, m: await loadMapPackage(filesSource(files), { checkAssets: true }) };
}

describe('undo / redo', () => {
  it('undoes and redoes set, insert and remove', () => {
    const ed = blank(), before = structuredClone(ed.doc);
    ed.set(['meta', 'name'], 'Renamed');
    ed.insert(['gates'], { kind: 'square', pos: [0, 10] });
    ed.insert(['gates'], { kind: 'arch', pos: [5, 20], yawDeg: 30 });
    ed.set(['environment', 'wind'], { speed: 3, directionDeg: 90 });
    ed.apply('Delete', ed.removeOps([['gates', 0], ['primitives', 0]]));
    expect(ed.doc.gates).toEqual([{ kind: 'arch', pos: [5, 20], yawDeg: 30 }]);
    expect(ed.doc.primitives).toBeUndefined();
    const after = structuredClone(ed.doc);
    while (ed.canUndo) ed.undo();
    expect(ed.doc).toEqual({ ...before, environment: {} }); // the parent object the wind went into stays (empty)
    while (ed.canRedo) ed.redo();
    expect(ed.doc).toEqual(after);
  });
  it('folds a gesture into one step and keeps edits independent of the caller', () => {
    const ed = blank(), v = [1, 2, 0];
    ed.set(['spawn', 'pos'], v, 'Move', 'drag');
    v[0] = 99; // the document holds its own copy
    ed.set(['spawn', 'pos'], [3, 4, 0], 'Move', 'drag');
    ed.set(['spawn', 'pos'], [5, 6, 0], 'Move', 'drag');
    expect(ed.doc.spawn!.pos).toEqual([5, 6, 0]);
    ed.undo();
    expect(ed.doc.spawn!.pos).toEqual([0, 0, 0]);
    expect(ed.canUndo).toBe(false);
  });
  it('undoes assets, the grid and sculpt strokes', () => {
    const ed = blank();
    const { ground, grid } = toHeightfield(ed.doc.ground, undefined, 50, 33);
    ed.apply('Convert', [{ k: 'set', path: ['ground'], v: ground }, { k: 'grid', v: grid }, { k: 'asset', path: 'tex.png', v: new Blob(['x']) }]);
    const flat = ed.grid!.data.slice();
    const r = sculpt(ed.grid!, ground, { op: 'raise', radius: 10, strength: 4, falloff: 'smooth' }, 0, 0, 0.5)!;
    expect(r).not.toBeNull();
    const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1, before = new Uint16Array(w * h), after = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { before[y * w + x] = flat[(r.y0 + y) * grid.w + r.x0 + x]; after[y * w + x] = ed.grid!.data[(r.y0 + y) * grid.w + r.x0 + x]; }
    expect(after.some((v, i) => v > before[i])).toBe(true);
    ed.record('Sculpt', [{ k: 'rect', x0: r.x0, y0: r.y0, w, h, before, after }]);
    const raised = ed.grid!.data.slice();
    ed.undo();
    expect(ed.grid!.data).toEqual(flat);
    ed.redo();
    expect(ed.grid!.data).toEqual(raised);
    ed.undo(); ed.undo();
    expect(ed.grid).toBeNull();
    expect(ed.assets.has('tex.png')).toBe(false);
    expect(ed.doc.ground).toEqual({ type: 'flat', material: 'grass' });
  });
});

describe('templates', () => {
  for (const t of TEMPLATES) it(`${t.name} is a valid map that loads`, async () => {
    const ed = new EditorDoc(t.make());
    expect(() => validateMapDoc(ed.doc)).not.toThrow();
    const { m } = await load(ed);
    expect(m.doc).toEqual(exportDoc(ed));
  });
  it('derives a valid id from a name', () => {
    expect(deriveId('Quarry Loop — Night!')).toBe('quarry-loop-night');
    expect(deriveId('')).toBe('my-map');
    expect(/^[a-z0-9][a-z0-9-]{1,23}$/.test(deriveId('A very long map name that goes on and on'))).toBe(true);
  });
});

describe('packages', () => {
  it('a draft serializes, loads back as the same document and reopens', async () => {
    const ed = new EditorDoc(TEMPLATES.find((t) => t.id === 'research')!.make());
    ed.set(['meta', 'id'], ''); // derived from the name on export
    ed.insert(['courses'], { id: 'back', name: 'Back loop', gates: [{ kind: 'square', pos: [10, 10] }], spawn: 'north' });
    const { files, m } = await load(ed);
    expect(m.doc.meta.id).toBe('my-research-range');
    expect(m.doc).toEqual(JSON.parse(await files.get('map.json')!.text()));
    const o = await openFiles(files);
    expect(o.ed.doc).toEqual(m.doc);
  });
  it('the height grid survives the 16-bit PNG bit for bit', async () => {
    const ed = blank();
    const { ground, grid } = toHeightfield({ type: 'noise', layers: [{ scale: 30, amplitude: 9, seed: 3 }] }, undefined, 100, 129);
    for (let i = 0; i < grid.data.length; i += 7) grid.data[i] = (i * 2654435761) & 0xffff; // every bit pattern counts
    ed.apply('Convert', [{ k: 'set', path: ['ground'], v: ground }, { k: 'grid', v: grid }]);
    const { files, m } = await load(ed);
    const png = await decodePngChannel(await bytes(files.get('heightfield.png')!));
    const mine = gridHf(ed.grid!);
    expect(png.w).toBe(129); expect(png.h).toBe(129);
    expect(png.data).toEqual(mine.data);
    // the loader's terrain (worker and renderer) is the editor's preview terrain, exactly
    const loaded = m.build().terrain, preview = buildMapDef(ed.doc, { hf: mine, baseDef: null, meshes: [] }, (p) => p).terrain;
    for (const [x, y] of [[0, 0], [13.3, -71.2], [99, 99], [-100, 42.42]]) expect(loaded(x, y)).toBe(preview(x, y));
    // and reopening gives the grid back unchanged
    expect((await openFiles(files)).ed.grid!.data).toEqual(ed.grid!.data);
  });
  it('converting to a heightfield keeps the terrain', () => {
    const g = { type: 'noise' as const, layers: [{ scale: 40, amplitude: 5, seed: 2 }] };
    const { ground, grid } = toHeightfield(g, undefined, 64, 129);
    const a = makeTerrain(g), b = makeTerrain(ground, gridHf(grid));
    for (let i = 0; i <= 128; i += 16) for (let j = 0; j <= 128; j += 16) {
      const x = -64 + i, y = 64 - j;
      expect(Math.abs(a(x, y) - b(x, y))).toBeLessThan(0.002); // 16-bit steps over the range
    }
  });
  it('exports a .zip that is a valid package under the repository rules', async () => {
    const ed = new EditorDoc(TEMPLATES.find((t) => t.id === 'freestyle')!.make());
    ed.set(['meta', 'license'], 'MIT');
    ed.set(['x-builder', 'credits'], [{ file: 'map.json', author: 'Me', source: 'own work', license: 'MIT' }]);
    const files = await packageFiles(ed, { docs: true });
    expect([...files.keys()].sort()).toEqual(['ATTRIBUTION.md', 'LICENSE.txt', 'map.json']);
    expect(await files.get('ATTRIBUTION.md')!.text()).toContain('| map.json | Me | own work | MIT |');
    expect((await checkPackage(files, true)).errors).toEqual([]);
    const entries = readZip(await zipPackage(files));
    const src = { list: async () => entries.map((e) => ({ path: e.path, size: e.size })), url: (p: string) => p, read: async (p: string) => entries.find((e) => e.path === p)!.read() };
    const m = await loadMapPackage(src, { strict: true, checkAssets: true });
    expect(m.doc).toEqual(exportDoc(ed));
  });
});

describe('prefabs', () => {
  for (const pf of PREFABS) it(`${pf.name} expands to a valid group within budgets`, () => {
    for (const params of [prefabDefaults(pf), Object.fromEntries(pf.params.map((p) => [p.key, p.max])), Object.fromEntries(pf.params.map((p) => [p.key, p.min]))]) {
      const out = placePrefab(pf, params, [3, -4, 1], 37, 'g1');
      expect(out.prims.length).toBeGreaterThan(0);
      expect(out.prims.length).toBeLessThanOrEqual(500);
      expect(out.prims.every((p) => p['x-group'] === 'g1')).toBe(true);
      const doc: MapDocV1 = { ...TEMPLATES[0].make(), primitives: out.prims, ...(out.lights.length && { lights: out.lights }) };
      expect(() => validateMapDoc(doc)).not.toThrow();
      const def = buildMapDef(doc, { baseDef: null, meshes: [] }, (p) => p);
      expect(def.prims.length).toBeLessThanOrEqual(BUDGETS.primitives);
    }
  });
});

describe('racing', () => {
  it('lap length matches the curriculum course length', () => {
    for (const id of ['practice', 'field', 'gym']) expect(lapLength(MAPS[id]().gates)).toBeCloseTo(courseLength(id), 9);
  });
  it('the racing line runs from the spawn round the course', () => {
    const doc = TEMPLATES.find((t) => t.id === 'race')!.make(), def = buildMapDef(doc, { baseDef: null, meshes: [] }, (p) => p);
    const line = racingLine(def.spawn.pos, def.gates);
    expect(line.points[0]).toEqual({ x: 0, y: 0, z: 1 });
    expect(line.length).toBeGreaterThan(lapLength(def.gates)); // plus the run-up from the pad, and curves
    expect(raceProblems(doc, def).filter((p) => p.level === 'warning')).toEqual([]);
    // a gate turned round is reported, with the fix
    const bad = structuredClone(doc); bad.gates![2].yawDeg = 70;
    const ps = raceProblems(bad, buildMapDef(bad, { baseDef: null, meshes: [] }, (p) => p));
    expect(ps.find((p) => p.text.includes('gate 3 faces away'))?.fix?.ops).toEqual([{ k: 'set', path: ['gates', 2, 'yawDeg'], v: 250 }]);
  });
});

describe('drafts', () => {
  it('saves, lists, duplicates, autosaves and deletes', async () => {
    useStore(new MemoryKv());
    const ed = blank();
    ed.set(['meta', 'name'], 'Draft A');
    await saveDraft('a', ed);
    const copy = await duplicateDraft('a');
    expect((await listDrafts()).map((d) => d.name).sort()).toEqual(['Draft A', 'Draft A (copy)']);
    const s = autosave('a', ed, () => {}, 10);
    ed.set(['meta', 'name'], 'Draft B');
    await s.flush();
    expect((await loadDraft('a'))!.doc.meta.name).toBe('Draft B');
    await deleteDraft(copy!);
    expect((await listDrafts()).map((d) => d.id)).toEqual(['a']);
    s.stop();
  });
});
