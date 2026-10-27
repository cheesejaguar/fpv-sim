// Map builder editing tools (no DOM): the undo history panel's model, selections that follow inserts
// and deletes, the outliner's tree, cut / copy / paste, groups, box selection and the builder's
// preferences.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { copyClip, pasteOps } from '../src/editor/clipboard';
import { allRefs, EditorDoc, followShifts, shiftPath, type Path } from '../src/editor/editorDoc';
import { ancestorsOf, groupName, outlineTree, type OutlineNode } from '../src/editor/outliner';
import { DEFAULT_PREFS, sanitize, SPEEDS, stepSpeed } from '../src/editor/prefs';
import { TEMPLATES } from '../src/editor/templates';
import { expandGroups, groupMembers } from '../src/editor/transform';
import { inRect } from '../src/editor/viewport';
import { validateMapDoc } from '../src/maps/mapFormat';

const tpl = (id: string) => new EditorDoc(TEMPLATES.find((t) => t.id === id)!.make());
const flat = () => 0;
const keys = (n: OutlineNode[]): string[] => n.flatMap((x) => [x.key, ...keys(x.children ?? [])]);
const find = (n: OutlineNode[], key: string): OutlineNode | undefined => { for (const x of n) { if (x.key === key) return x; const c = find(x.children ?? [], key); if (c) return c; } return undefined; };

describe('undo history', () => {
  it('lists done and undone steps and jumps to any of them', () => {
    const ed = tpl('blank');
    ed.set(['meta', 'name'], 'A', 'Rename');
    ed.insert(['gates'], { kind: 'square', pos: [0, 10] }, 'Add gate');
    ed.insert(['gates'], { kind: 'arch', pos: [0, 20] }, 'Add gate');
    expect(ed.history().entries.map((e) => e.label)).toEqual(['Rename', 'Add gate', 'Add gate']);
    expect(ed.history().done).toBe(3);
    ed.jumpTo(1);
    expect(ed.history().done).toBe(1);
    expect(ed.history().entries).toHaveLength(3); // the undone steps stay, to be redone
    expect(ed.doc.gates).toBeUndefined();
    expect(ed.doc.meta.name).toBe('A');
    ed.jumpTo(3);
    expect(ed.doc.gates).toHaveLength(2);
    ed.jumpTo(0);
    expect(ed.doc.meta.name).toBe('My map');
  });
  it('folds a scrub ("gesture:" key) into one step however slow it is', () => {
    const ed = tpl('blank');
    ed.set(['spawn', 'pos'], [1, 0, 0], 'Set position', 'gesture:scrub:1');
    // a step after the 2.5 s window for ordinary keys
    (ed as unknown as { undoStack: { at: number }[] }).undoStack[0].at -= 10_000;
    ed.set(['spawn', 'pos'], [2, 0, 0], 'Set position', 'gesture:scrub:1');
    expect(ed.history().entries).toHaveLength(1);
    ed.set(['spawn', 'pos'], [3, 0, 0], 'Nudge', 'nudge');
    (ed as unknown as { undoStack: { at: number }[] }).undoStack[1].at -= 10_000;
    ed.set(['spawn', 'pos'], [4, 0, 0], 'Nudge', 'nudge');
    expect(ed.history().entries).toHaveLength(3);
  });
});

describe('paths follow inserts and deletes', () => {
  it('shifts later elements, drops the removed one, leaves other lists alone', () => {
    expect(shiftPath(['gates', 3], { path: ['gates'], i: 1, d: -1 })).toEqual(['gates', 2]);
    expect(shiftPath(['gates', 1], { path: ['gates'], i: 1, d: -1 })).toBeNull();
    expect(shiftPath(['gates', 0], { path: ['gates'], i: 1, d: -1 })).toEqual(['gates', 0]);
    expect(shiftPath(['gates', 1], { path: ['gates'], i: 1, d: 1 })).toEqual(['gates', 2]);
    expect(shiftPath(['trees', 4], { path: ['gates'], i: 0, d: -1 })).toEqual(['trees', 4]);
    expect(shiftPath(['courses', 2, 'gates', 0], { path: ['courses'], i: 0, d: -1 })).toEqual(['courses', 1, 'gates', 0]);
    expect(shiftPath(['paths', 0, 'points', 3], { path: ['paths', 0, 'points'], i: 1, d: -1 })).toEqual(['paths', 0, 'points', 2]);
  });
  it('reports the shifts of a delete and of its undo', () => {
    const ed = tpl('race'), seen: Path[][] = [];
    let held: Path[] = [['gates', 4], ['gates', 1], ['trees', 2]];
    ed.onChange((c) => { held = followShifts(held, c.shifts); seen.push(held); });
    ed.apply('Delete', ed.removeOps([['gates', 1], ['gates', 2]]));
    expect(held).toEqual([['gates', 2], ['trees', 2]]); // gate 4 is now gate 2; gate 1 went
    ed.undo();
    expect(held).toEqual([['gates', 4], ['trees', 2]]);
    expect(seen).toHaveLength(2);
  });
});

describe('outliner', () => {
  it('builds courses in lap order, groups, the start and lists by kind', () => {
    const ed = tpl('research'), t = outlineTree(ed.doc, ed.meta);
    expect(t.map((n) => n.key)).toEqual(['cat:start', 'cat:primitives', 'cat:actors', 'cat:paths']);
    const start = find(t, 'cat:start')!;
    expect(start.children!.map((c) => c.label)).toEqual(['Main spawn', 'West pad', 'North pad']);
    expect(find(t, 'cat:actors')!.children!.map((c) => c.label)).toContain('Radar');
    expect(find(t, 'path:0')!.children).toHaveLength(4);
    // every selectable object is in the tree once
    const refs = t.flatMap((n) => n.refs).map((r) => JSON.stringify(r));
    expect(new Set(refs).size).toBe(allRefs(ed.doc).length);
    const race = outlineTree(tpl('race').doc, {});
    expect(find(race, 'course:main')!.children!.map((c) => c.sub)).toEqual(['square', 'arch', 'square', 'dive', 'hurdle', 'flag']);
  });
  it('nests prefab parts under their group, named after the prefab, and renames groups', () => {
    const ed = tpl('freestyle'), t = outlineTree(ed.doc, ed.meta), groups = find(t, 'cat:groups')!;
    expect(groups.children!.map((g) => g.label)).toEqual(expect.arrayContaining(['Shipping container', 'Ramp', 'Water tower']));
    expect(find(t, 'cat:primitives')!.children).toHaveLength(1); // only the start pad is loose
    const g = Object.keys(ed.meta.groups!)[0];
    expect(groupName(ed.doc, { ...ed.meta, names: { [g]: 'Big stack' } }, g)).toBe('Big stack');
    expect(find(t, `group:${g}`)!.rename).toEqual(['x-builder', 'names', g]);
  });
  it('filters by name and kind, and finds the folders round a selection', () => {
    const ed = tpl('race'), t = outlineTree(ed.doc, ed.meta, 'arch');
    expect(keys(t)).toEqual(['cat:courses', 'course:main', JSON.stringify(['gates', 1])]);
    const full = outlineTree(ed.doc, ed.meta);
    expect([...ancestorsOf(full, new Set([JSON.stringify(['trees', 3])]))]).toEqual(['cat:trees']);
    expect([...ancestorsOf(full, new Set([JSON.stringify(['gates', 0])]))]).toEqual(['cat:courses', 'course:main']);
  });
});

describe('clipboard', () => {
  it('pastes after the originals were cut, at a point, keeping heights above the ground', () => {
    const ed = tpl('blank');
    ed.insert(['primitives'], { type: 'box', pos: [10, 10, 3], size: [2, 2, 2], material: 'concrete' });
    ed.insert(['gates'], { kind: 'square', pos: [12, 10] });
    const sel: Path[] = [['primitives', 1], ['gates', 0]], clip = copyClip(ed, sel, flat)!;
    ed.apply('Cut', ed.removeOps(sel));
    const hill = (x: number) => (x > 50 ? 5 : 0);
    const { ops, added } = pasteOps(ed, clip, [100, 0, 5], (x) => hill(x));
    ed.apply('Paste', ops);
    expect(added).toEqual([['primitives', 1], ['gates', 0]]);
    // the centre (11, 10) moved to (100, 0); the box keeps its 3 m over the ground (now 5 m high)
    expect((ed.doc.primitives![1] as { pos: number[] }).pos).toEqual([99, 0, 8]);
    expect(ed.doc.gates![0].pos).toEqual([101, 0]);
    expect(validateMapDoc(ed.doc).warnings).toBeDefined();
  });
  it('gives pasted groups, spawns and actors fresh ids and puts orphaned course gates on the main course', () => {
    const ed = tpl('research');
    const sel: Path[] = [['spawns', 0], ['actors', 2]], clip = copyClip(ed, sel, flat)!;
    ed.apply('Paste', pasteOps(ed, clip, null, flat).ops);
    expect(ed.doc.spawns!.map((s) => s.id)).toEqual(['west', 'north', 'west-1']);
    expect(ed.doc.actors!.map((a) => a.id)).toContain('jammer-2');
    expect(() => validateMapDoc(ed.doc)).not.toThrow();

    const fs = tpl('freestyle'), g = Object.keys(fs.meta.groups!)[0], members = groupMembers(fs.doc, g);
    const c2 = copyClip(fs, members, flat)!, before = Object.keys(fs.meta.groups!).length;
    const r = pasteOps(fs, c2, [0, 40, 0], flat);
    fs.apply('Paste', r.ops);
    expect(Object.keys(fs.meta.groups!)).toHaveLength(before + 1);
    const g2 = (fs.get(r.added[0]) as { 'x-group': string })['x-group'];
    expect(g2).not.toBe(g);
    expect(groupMembers(fs.doc, g2)).toHaveLength(members.length);

    const rc = tpl('blank');
    rc.insert(['courses'], { id: 'c', name: 'C', gates: [{ kind: 'square', pos: [0, 5] }] });
    const c3 = copyClip(rc, [['courses', 0, 'gates', 0]], flat)!;
    rc.apply('Delete course', [{ k: 'del', path: ['courses'], i: 0 }]);
    rc.apply('Paste', pasteOps(rc, c3, null, flat).ops);
    expect(rc.doc.gates).toEqual([{ kind: 'square', pos: [0, 5] }]);
  });
  it('can not copy the main spawn or the pilot', () => {
    const ed = tpl('blank');
    expect(copyClip(ed, [['spawn']], flat)).toBeNull();
  });
});

describe('groups made with Ctrl+G', () => {
  it('select and expand across every kind of object', () => {
    const ed = tpl('race');
    ed.apply('Group', [['gates', 0], ['trees', 1], ['primitives', 0]].map((p) => ({ k: 'set', path: [...p, 'x-group'], v: 'g9' })));
    expect(groupMembers(ed.doc, 'g9')).toEqual([['primitives', 0], ['gates', 0], ['trees', 1]]);
    expect(expandGroups(ed.doc, [['trees', 1]])).toHaveLength(3);
    expect(() => validateMapDoc(ed.doc)).not.toThrow(); // "x-" keys are allowed on any object
    expect(groupName(ed.doc, ed.meta, 'g9')).toBe('Group 9');
  });
});

describe('box selection', () => {
  it('picks the objects whose anchor projects inside the rectangle and lies in front', () => {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    cam.position.set(0, 50, 0.001); cam.lookAt(0, 0, 0); // straight down, north up
    const view = { left: 0, top: 0, width: 1000, height: 1000 };
    const cands = [{ ref: ['a'], p: [0, 0, 0] as [number, number, number] }, { ref: ['b'], p: [20, 0, 0] as [number, number, number] }, { ref: ['c'], p: [0, 0, 80] as [number, number, number] }];
    // the left half of the screen: west of the camera, so a (centre) at the edge and b (east) out
    expect(inRect(cands, cam, { x0: 0, y0: 0, x1: 510, y1: 1000 }, view)).toEqual([['a']]);
    expect(inRect(cands, cam, { x1: 0, y1: 0, x0: 1000, y0: 1000 }, view)).toEqual([['a'], ['b']]); // any corner order; c is behind the camera
  });
});

describe('preferences', () => {
  it('fall back to the defaults for anything unreadable or out of range', () => {
    expect(sanitize(null)).toEqual(DEFAULT_PREFS);
    const p = sanitize({ left: 9999, right: 'x', bottomTab: 'nope', show: { grid: false }, speed: 99, closed: ['Transform', 3], rightDrag: 'orbit' });
    expect(p.left).toBe(520);
    expect(p.right).toBe(DEFAULT_PREFS.right);
    expect(p.bottomTab).toBe('problems');
    expect(p.show).toEqual({ ...DEFAULT_PREFS.show, grid: false });
    expect(p.speed).toBe(SPEEDS[SPEEDS.length - 1]);
    expect(p.closed).toEqual(['Transform']);
    expect(p.rightDrag).toBe('orbit');
  });
  it('steps the fly speed through its scale', () => {
    expect(stepSpeed(1, 1)).toBe(2);
    expect(stepSpeed(1, -1)).toBe(0.5);
    expect(stepSpeed(16, 1)).toBe(16);
    expect(stepSpeed(0.125, -1)).toBe(0.125);
    expect(stepSpeed(3, 1)).toBe(4);
  });
});
