// Save states of simulation objects (practice points): capture every own field of an object graph
// (numbers, typed arrays, arrays, nested plain objects and class instances) and write it back later
// in place, so every reference other code holds (the quad's motors, its battery, its state object)
// still points at the live object. Objects in the shared set (parameters, prop tables, material
// constants) are kept by reference: never copied, never written into. Functions are left alone.

export type Snapshot = Record<string, unknown>;

/** Every object reachable from the roots (typed arrays included), for capture()'s shared set. */
export function reachable(roots: unknown[], into = new Set<object>()): Set<object> {
  const stack = [...roots];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object' || into.has(v)) continue;
    into.add(v);
    if (ArrayBuffer.isView(v)) continue;
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (x !== null && typeof x === 'object') stack.push(x);
  }
  return into;
}

function copy(v: unknown, shared: Set<object>, memo: Map<object, unknown>): unknown {
  if (v === null || typeof v !== 'object' || shared.has(v)) return v;
  const seen = memo.get(v);
  if (seen !== undefined) return seen;
  if (ArrayBuffer.isView(v)) {
    const c = (v as unknown as { slice(): unknown }).slice();
    memo.set(v, c);
    return c;
  }
  if (Array.isArray(v)) {
    const a: unknown[] = [];
    memo.set(v, a);
    for (let i = 0; i < v.length; i++) a[i] = copy(v[i], shared, memo);
    return a;
  }
  if (v instanceof Map || v instanceof Set) throw new Error('saveState: Map / Set fields are not supported');
  const o = Object.create(Object.getPrototypeOf(v)) as Record<string, unknown>;
  memo.set(v, o);
  for (const [k, x] of Object.entries(v)) if (typeof x !== 'function') o[k] = copy(x, shared, memo);
  return o;
}

/** A deep copy of `obj`'s own fields (shared objects by reference). */
export function capture(obj: object, shared: Set<object>): Snapshot {
  return copy(obj, shared, new Map()) as Snapshot;
}

function put(t: unknown, s: unknown, shared: Set<object>, done: Set<object>): unknown {
  if (s === null || typeof s !== 'object' || shared.has(s)) return s;
  if (ArrayBuffer.isView(s)) {
    const src = s as unknown as { length: number; constructor: unknown; slice(): unknown };
    const dst = t as { length: number; constructor: unknown; set(a: unknown): void } | null;
    if (dst && typeof dst === 'object' && ArrayBuffer.isView(dst) && dst.constructor === src.constructor && dst.length === src.length) { dst.set(src); return dst; }
    return src.slice();
  }
  const live = t !== null && typeof t === 'object' && !shared.has(t) && !ArrayBuffer.isView(t);
  if (Array.isArray(s)) {
    if (!live || !Array.isArray(t)) return copy(s, shared, new Map());
    if (done.has(t)) return t;
    done.add(t);
    t.length = s.length;
    for (let i = 0; i < s.length; i++) t[i] = put(t[i], s[i], shared, done);
    return t;
  }
  if (!live || Array.isArray(t) || Object.getPrototypeOf(t) !== Object.getPrototypeOf(s)) return copy(s, shared, new Map());
  if (done.has(t as object)) return t;
  done.add(t as object);
  const to = t as Record<string, unknown>;
  for (const [k, x] of Object.entries(s as Record<string, unknown>)) to[k] = put(to[k], x, shared, done);
  return t;
}

/**
 * Write a capture() back into `obj` in place. The snapshot itself is not changed (it can be
 * restored again); fields the object gained after the capture are left as they are.
 */
export function restore(obj: object, snap: Snapshot, shared: Set<object>): void {
  // (the top level is written into whatever it is: a snapshot of picked fields is a plain object)
  const to = obj as Record<string, unknown>, done = new Set<object>([obj]);
  for (const [k, x] of Object.entries(snap)) to[k] = put(to[k], x, shared, done);
}
