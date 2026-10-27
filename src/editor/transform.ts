// Moving, turning and scaling selected objects in map.json terms (ENU, degrees), whatever they are:
// primitives, gates, trees, spawns, lights, zones, actors, path points, meshes. Pure functions: the
// gizmo's result becomes one undoable command of "set" ops.
import type { MapDocV1, Vec3 } from '../maps/mapDoc';
import { EditorDoc, refKind, type BuilderMeta, type Op, type Path, type RefKind } from './editorDoc';

type Obj = Record<string, any>;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const wrap = (d: number) => { const x = ((d % 360) + 540) % 360 - 180; return r2(x === -180 ? 180 : x); };
export type Terrain = (x: number, y: number) => number;

/** Where an object is (ENU): the point the gizmo sits on and moves. */
export function anchorOf(kind: RefKind, o: Obj, terrain: Terrain, doc?: MapDocV1): Vec3 | null {
  switch (kind) {
    case 'gate': case 'tree': case 'wake': return [o.pos[0], o.pos[1], o.pos[2] ?? terrain(o.pos[0], o.pos[1])];
    case 'indoor': return [0, 1, 2].map((k) => (o.min[k] + o.max[k]) / 2) as Vec3;
    case 'pathPoint': case 'pilot': return [o[0], o[1], o[2]];
    case 'mesh': return o.pos ?? [0, 0, 0];
    case 'actor': {
      if (o.pos) return o.pos;
      const p = doc?.paths?.find((x) => x.id === o.path);
      return p ? p.points[0] : null; // moves along its path: not dragged on its own
    }
    default: return o.pos ?? null;
  }
}

/** Yaw of an object (deg), for the gizmo's local frame: boxes, gates, spawns, meshes, sensors. */
export function yawOf(kind: RefKind, o: Obj): number {
  if (kind === 'prim' && o.type === 'box') return o.yawDeg ?? 0;
  if (kind === 'gate' || kind === 'spawn' || kind === 'mainSpawn' || kind === 'mesh') return o.yawDeg ?? 0;
  if (kind === 'actor') return o.yawDeg ?? o.antenna?.yawDeg ?? 0;
  return 0;
}

export interface Xform {
  /** rotation centre (ENU) */
  pivot: Vec3;
  /** translation (ENU, m) */
  d: Vec3;
  /** turn about the pivot (deg, CCW from above) */
  yawDeg: number;
  /** scale along the pivot frame's axes (x, y, z) */
  s: Vec3;
  /** the pivot frame's yaw (deg): one object scales along its own axes */
  frameYawDeg: number;
}

/** The object after a transform (a new object; the input is unchanged). */
export function transformObj(kind: RefKind, src: Obj, t: Xform, terrain: Terrain, doc?: MapDocV1): Obj {
  const o = structuredClone(src);
  const a = anchorOf(kind, o, terrain, doc);
  if (!a) return o;
  const th = (t.yawDeg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th), fy = (t.frameYawDeg * Math.PI) / 180;
  // offset from the pivot: scaled in the pivot frame, turned, moved
  let ox = a[0] - t.pivot[0], oy = a[1] - t.pivot[1], oz = a[2] - t.pivot[2];
  const lx = Math.cos(-fy) * ox - Math.sin(-fy) * oy, ly = Math.sin(-fy) * ox + Math.cos(-fy) * oy;
  const sx = lx * t.s[0], sy = ly * t.s[1];
  ox = Math.cos(fy) * sx - Math.sin(fy) * sy; oy = Math.sin(fy) * sx + Math.cos(fy) * sy; oz *= t.s[2];
  const p: Vec3 = [r3(t.pivot[0] + c * ox - s * oy + t.d[0]), r3(t.pivot[1] + s * ox + c * oy + t.d[1]), r3(t.pivot[2] + oz + t.d[2])];
  const dzv = p[2] - a[2];
  const turn = (k: string, obj: Obj = o) => { if (t.yawDeg) { const y = wrap((obj[k] ?? 0) + t.yawDeg); if (y || obj[k] !== undefined) obj[k] = y; } };
  const S = t.s, sMax = Math.max(Math.abs(S[0]), Math.abs(S[1])), scaled = S[0] !== 1 || S[1] !== 1 || S[2] !== 1;
  switch (kind) {
    case 'prim':
      o.pos = p;
      if (o.type === 'box') { turn('yawDeg'); if (scaled) o.size = [r3(o.size[0] * Math.abs(S[0])), r3(o.size[1] * Math.abs(S[1])), r3(o.size[2] * Math.abs(S[2]))]; }
      else if (scaled) { o.radius = r3(o.radius * sMax); if (o.type === 'cylinder') o.height = r3(o.height * Math.abs(S[2])); }
      break;
    case 'gate':
      o.pos = o.pos.length === 3 ? [p[0], p[1], r3(o.pos[2] + dzv)] : [p[0], p[1]];
      turn('yawDeg');
      if (scaled) { if (S[0] !== 1) o.width = r3(Math.min(20, (o.width ?? defaultGateSize(o.kind)[0]) * Math.abs(S[0]))); if (S[2] !== 1) o.height = r3(Math.min(20, (o.height ?? defaultGateSize(o.kind)[1]) * Math.abs(S[2]))); }
      break;
    case 'tree': o.pos = [p[0], p[1]]; if (scaled) { o.height = r3(Math.min(60, o.height * Math.abs(S[2]))); o.radius = r3(Math.min(20, o.radius * sMax)); } break;
    case 'wake': o.pos = [p[0], p[1]]; if (scaled) { o.radius = r3(o.radius * sMax); o.height = r3(o.height * Math.abs(S[2])); } break;
    case 'indoor': {
      const half = [0, 1, 2].map((k) => ((o.max[k] - o.min[k]) / 2) * Math.abs(S[k]));
      // a turned box stays axis-aligned (indoor zones are AABBs): a quarter turn swaps its sides
      if (Math.abs(Math.round(t.yawDeg / 90) % 2) === 1) [half[0], half[1]] = [half[1], half[0]];
      o.min = p.map((v, k) => r3(v - half[k])); o.max = p.map((v, k) => r3(v + half[k]));
      break;
    }
    case 'pathPoint': case 'pilot': return p;
    case 'light': o.pos = p; if (scaled) o.range = r3(Math.min(1000, o.range * sMax)); break;
    case 'spawn': case 'mainSpawn':
      if (o.pilot) o.pilot = [r3(o.pilot[0] + p[0] - a[0]), r3(o.pilot[1] + p[1] - a[1]), r3(o.pilot[2] + dzv)];
      o.pos = p; turn('yawDeg');
      break;
    case 'mesh': o.pos = p; turn('yawDeg'); if (scaled) o.scale = r3(Math.min(1000, (o.scale ?? 1) * sMax)); break;
    case 'actor':
      if (!o.pos) return o;
      o.pos = p;
      if (o.type === 'detector') turn('yawDeg'); else if (o.type === 'rf-emitter' && o.antenna) turn('yawDeg', o.antenna);
      if (scaled && o.type === 'target') { if (o.size) o.size = o.size.map((v: number, k: number) => r3(v * Math.abs(S[k]))); if (o.radiusM !== undefined || !o.size) o.radiusM = r3(Math.max(0.05, (o.radiusM ?? 1) * sMax)); }
      if (scaled && o.type === 'detector') o.rangeM = r3(Math.min(20000, o.rangeM * sMax));
      break;
  }
  return o;
}

const GATE_DEF: Record<string, [number, number]> = { square: [1.524, 1.524], arch: [3.0, 2.6], dive: [1.524, 1.524], flag: [1.524, 3.2], hurdle: [3.6, 1.8], ladder: [1.524, 1.524] };
const defaultGateSize = (k: string) => GATE_DEF[k] ?? [1.524, 1.524];

/** "set" ops transforming every selected object (and the prefab groups that move whole). */
export function transformOps(ed: EditorDoc, refs: Path[], t: Xform, terrain: Terrain): Op[] {
  const ops: Op[] = [];
  for (const r of refs) {
    const k = refKind(r), o = ed.get(r) as Obj | undefined;
    if (!k || o === undefined) continue;
    ops.push({ k: 'set', path: r, v: transformObj(k, o, t, terrain, ed.doc) });
  }
  // a prefab moved as a whole: its anchor and heading move with it (re-parameterising rebuilds it there)
  const groups = ed.meta.groups ?? {};
  for (const [g, m] of Object.entries(groups)) {
    const members = groupMembers(ed.doc, g);
    if (!members.length || !members.every((p) => refs.some((r) => r.length === p.length && r.every((x, i) => x === p[i])))) continue;
    const pos = transformObj('pathPoint', m.pos as unknown as Obj, t, terrain) as unknown as Vec3;
    ops.push({ k: 'set', path: ['x-builder', 'groups', g], v: { ...m, pos, yawDeg: wrap(m.yawDeg + t.yawDeg) } });
  }
  return ops;
}

/** The map.json lists whose objects can be grouped ("x-group"): prefabs, spawn pads and the groups made with Ctrl+G. */
export const GROUPABLE = ['primitives', 'gates', 'trees', 'spawns', 'lights', 'indoor', 'wakeZones', 'actors', 'geometry'] as const;

/** Paths of every member of a group (a prefab, a spawn pad, or a group made with Ctrl+G). */
export function groupMembers(doc: MapDocV1, g: string): Path[] {
  const out: Path[] = [];
  for (const key of GROUPABLE) (doc[key] as Obj[] | undefined)?.forEach((o, i) => { if (o?.['x-group'] === g) out.push([key, i]); });
  return out;
}

/** Selection grown to whole groups (clicking one part of a prefab selects the prefab). */
export function expandGroups(doc: MapDocV1, refs: Path[]): Path[] {
  const out: Path[] = [], seen = new Set<string>();
  const add = (p: Path) => { const k = JSON.stringify(p); if (!seen.has(k)) { seen.add(k); out.push(p); } };
  for (const r of refs) {
    const o = (r.length === 2 ? (doc as unknown as Obj)[r[0]]?.[r[1]] : undefined) as Obj | undefined;
    const g = o?.['x-group'];
    if (typeof g === 'string') groupMembers(doc, g).forEach(add); else add(r);
  }
  return out;
}

/** Put objects on the ground (or the terrain under them): boxes and spheres rest on it, gates and trees follow it. */
export function groundOps(ed: EditorDoc, refs: Path[], terrain: Terrain): Op[] {
  const ops: Op[] = [];
  for (const r of refs) {
    const k = refKind(r), o = structuredClone(ed.get(r)) as Obj | undefined;
    if (!k || !o) continue;
    const z = (x: number, y: number) => r3(terrain(x, y));
    if (k === 'prim') {
      const h = o.type === 'box' ? o.size[2] / 2 * Math.abs(Math.cos(((o.pitchDeg ?? 0) * Math.PI) / 180)) + o.size[0] / 2 * Math.abs(Math.sin(((o.pitchDeg ?? 0) * Math.PI) / 180)) : o.type === 'sphere' ? o.radius : 0;
      o.pos = [o.pos[0], o.pos[1], r3(z(o.pos[0], o.pos[1]) + h)];
    } else if (k === 'gate') { if (o.kind === 'dive') o.pos = [o.pos[0], o.pos[1], r3(z(o.pos[0], o.pos[1]) + 2)]; else { o.pos = [o.pos[0], o.pos[1]]; delete o.onTop; } }
    else if (k === 'spawn' || k === 'mainSpawn' || k === 'light' || k === 'mesh' || (k === 'actor' && o.pos)) {
      const lift = k === 'light' ? 3 : 0;
      o.pos = [o.pos[0], o.pos[1], r3(z(o.pos[0], o.pos[1]) + lift)];
    } else if (k === 'pathPoint') { ops.push({ k: 'set', path: r, v: [o[0], o[1], r3(z(o[0], o[1]) + 1)] }); continue; }
    else if (k === 'indoor') { const h = o.max[2] - o.min[2], g = z((o.min[0] + o.max[0]) / 2, (o.min[1] + o.max[1]) / 2); o.min[2] = g; o.max[2] = r3(g + h); }
    else continue;
    ops.push({ k: 'set', path: r, v: o });
  }
  return ops;
}

/** New ids for copies: "jammer-1" -> "jammer-2" (the first free one). */
export function freeId(taken: Iterable<string>, base: string): string {
  const set = new Set(taken), stem = base.replace(/-\d+$/, '').slice(0, 26) || 'item';
  for (let i = 1; ; i++) { const id = `${stem}-${i}`; if (!set.has(id)) return id; }
}

/** Insert ops for copies of the selection, moved by d and turned by yawDeg about the pivot (duplicate, array). */
export interface CopyState { counts: Map<string, number>; newIds: Map<string, string[]> }
/** An object to copy: where it was (its list decides where the copy goes), what it is, its value. */
export interface CopyItem { ref: Path; kind: RefKind; v: Obj }
type GroupMeta = NonNullable<BuilderMeta['groups']>[string];

/** state: shared by the copies of one command (an array), so their indices and ids follow on. */
export function copyOps(ed: EditorDoc, refs: Path[], t: Xform, terrain: Terrain, state: CopyState = { counts: new Map(), newIds: new Map() }): { ops: Op[]; added: Path[] } {
  const items: CopyItem[] = [];
  for (const r of refs) { const k = refKind(r), v = ed.get(r) as Obj | undefined; if (k && v !== undefined) items.push({ ref: r, kind: k, v }); }
  return insertCopies(ed, items, t, terrain, state, { groups: ed.meta.groups, names: ed.meta.names });
}

/**
 * Insert copies of objects (from the document or a clipboard): each goes to the end of its original
 * list (path points: right after the original when it is still there and `after` is set). Course gates
 * whose course is gone go to the main course; path points whose path is gone are skipped. Groups get
 * fresh ids (a prefab's record and a group's name come along); spawns and actors fresh ids.
 */
export function insertCopies(ed: EditorDoc, items: CopyItem[], t: Xform, terrain: Terrain, state: CopyState, meta: { groups?: BuilderMeta['groups']; names?: BuilderMeta['names'] } = {}, after = true): { ops: Op[]; added: Path[] } {
  const ops: Op[] = [], added: Path[] = [], doc = ed.doc as unknown as Obj;
  const { counts, newIds } = state, regroup = new Map<string, string>();
  const ids = (k: string) => ((doc[k] as Obj[] | undefined) ?? []).map((o) => o.id as string);
  for (const { ref: r, kind: k, v } of items) {
    if (k === 'mainSpawn' || k === 'pilot') continue;
    const o = transformObj(k, v, t, terrain, ed.doc);
    let list: Path = r.length === 2 ? [r[0] as string] : r.slice(0, 3);
    if (k === 'gate' && r.length === 4 && ed.get(r.slice(0, 2)) === undefined) list = ['gates'];
    if (k === 'pathPoint') {
      if (ed.get(r.slice(0, 2)) === undefined) continue;
      const key = JSON.stringify(list), n = (ed.get(list) as unknown[]).length + (counts.get(key) ?? 0);
      const at = after ? (r[3] as number) + 1 : n;
      if (!after) counts.set(key, (counts.get(key) ?? 0) + 1);
      ops.push({ k: 'ins', path: list, i: at, v: o }); added.push([...list, at]);
      continue;
    }
    if (typeof o['x-group'] === 'string') { if (!regroup.has(o['x-group'])) regroup.set(o['x-group'], ed.uid('g')); o['x-group'] = regroup.get(o['x-group']); }
    const key = JSON.stringify(list);
    if ('id' in o && (k === 'spawn' || k === 'actor')) {
      const taken = [...ids(list[0] as string), ...(newIds.get(key) ?? [])];
      o.id = freeId(taken, o.id); newIds.set(key, [...(newIds.get(key) ?? []), o.id]);
    }
    const arr = ed.get(list) as unknown[] | undefined, n = (arr?.length ?? 0) + (counts.get(key) ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    ops.push({ k: 'ins', path: list, i: n, v: o }); added.push([...list, n]);
  }
  for (const [from, to] of regroup) {
    const m: GroupMeta | undefined = meta.groups?.[from];
    if (m) ops.push({ k: 'set', path: ['x-builder', 'groups', to], v: { ...m, pos: transformObj('pathPoint', m.pos as unknown as Obj, t, terrain), yawDeg: wrap(m.yawDeg + t.yawDeg) } });
    const name = meta.names?.[from];
    if (name) ops.push({ k: 'set', path: ['x-builder', 'names', to], v: name });
  }
  return { ops, added };
}
