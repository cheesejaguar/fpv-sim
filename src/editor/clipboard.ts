// Cut, copy and paste. The clipboard holds copies of the objects (and the records of the groups they
// belong to), so a paste works after the originals were deleted (cut) and in another draft. Pasting
// at a point moves the whole set there, keeping each object's height above the ground; pasting
// without one puts it back where it was copied from.
import type { Vec3 } from '../maps/mapDoc';
import { EditorDoc, refKind, type BuilderMeta, type Op, type Path } from './editorDoc';
import { anchorOf, insertCopies, type CopyItem, type Terrain } from './transform';

export interface Clip {
  items: CopyItem[];
  groups: NonNullable<BuilderMeta['groups']>;
  names: NonNullable<BuilderMeta['names']>;
  /** the copied set's centre (ENU) and the ground height under it */
  centre: Vec3;
  groundZ: number;
}

/** The selection as a clipboard (null when nothing in it can be copied: the main spawn and the pilot can't). */
export function copyClip(ed: EditorDoc, refs: Path[], terrain: Terrain): Clip | null {
  const items: CopyItem[] = [], c: Vec3 = [0, 0, 0];
  const groups: Clip['groups'] = {}, names: Clip['names'] = {};
  for (const r of refs) {
    const kind = refKind(r), v = ed.get(r) as Record<string, any> | undefined;
    if (!kind || v === undefined || kind === 'mainSpawn' || kind === 'pilot') continue;
    items.push({ ref: [...r], kind, v: structuredClone(v) });
    const a = anchorOf(kind, v, terrain, ed.doc);
    if (a) { c[0] += a[0]; c[1] += a[1]; c[2] += a[2]; }
    const g = v['x-group'];
    if (typeof g === 'string') { const m = ed.meta.groups?.[g], n = ed.meta.names?.[g]; if (m) groups[g] = structuredClone(m); if (n) names[g] = n; }
  }
  if (!items.length) return null;
  const centre: Vec3 = [c[0] / items.length, c[1] / items.length, c[2] / items.length];
  return { items, groups, names, centre, groundZ: terrain(centre[0], centre[1]) };
}

/**
 * Ops inserting the clipboard's objects: at `at` (ENU, a point on the ground: the set's centre goes
 * there and every object keeps its height above the ground) or where they were copied from.
 */
export function pasteOps(ed: EditorDoc, clip: Clip, at: Vec3 | null, terrain: Terrain): { ops: Op[]; added: Path[] } {
  const d: Vec3 = at ? [at[0] - clip.centre[0], at[1] - clip.centre[1], at[2] - clip.groundZ] : [0, 0, 0];
  return insertCopies(ed, clip.items, { pivot: clip.centre, d, yawDeg: 0, s: [1, 1, 1], frameYawDeg: 0 }, terrain, { counts: new Map(), newIds: new Map() }, { groups: clip.groups, names: clip.names }, false);
}
