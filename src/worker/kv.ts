// Tiny key/value store on IndexedDB for the worker (Betaflight EEPROM image, defaults bookkeeping).
// One connection is opened lazily and cached. Every step has a timeout: a blocked upgrade, a
// browser with storage disabled (private mode, quota) or a hung open must never stall the boot, so
// the store then reports itself unavailable once and the simulator runs without persistence.

export interface KvStore {
  get(key: string): Promise<unknown>;
  /** resolves false if the value could not be stored */
  set(key: string, v: unknown): Promise<boolean>;
  /** null while unknown / available; the reason once persistence turned out to be unavailable */
  readonly unavailable: string | null;
}

export class IdbKv implements KvStore {
  private db: Promise<IDBDatabase | null> | null = null;
  unavailable: string | null = null;

  constructor(private factory: Pick<IDBFactory, 'open'> | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB,
    private onUnavailable: (why: string) => void = () => {}, private timeoutMs = 3000, private name = 'fpv-sim') {}

  private fail(why: string): null {
    if (!this.unavailable) { this.unavailable = why; this.onUnavailable(why); }
    return null;
  }

  private open(): Promise<IDBDatabase | null> {
    if (this.unavailable) return Promise.resolve(null);
    if (this.db) return this.db;
    this.db = new Promise<IDBDatabase | null>((res) => {
      let done = false;
      const finish = (db: IDBDatabase | null, why?: string) => {
        if (done) { db?.close(); return; } // a late success after the timeout: not used
        done = true; clearTimeout(timer);
        res(db ?? this.fail(why ?? 'unknown error'));
      };
      const timer = setTimeout(() => finish(null, `no answer from IndexedDB within ${this.timeoutMs / 1000} s`), this.timeoutMs);
      try {
        if (!this.factory) { finish(null, 'IndexedDB is not available'); return; }
        const r = this.factory.open(this.name, 1);
        r.onupgradeneeded = () => { try { r.result.createObjectStore('kv'); } catch { /* exists */ } };
        r.onsuccess = () => {
          const db = r.result;
          // another tab upgrading / the browser closing it: reopen on the next access
          db.onversionchange = () => { db.close(); this.db = null; };
          (db as { onclose?: (() => void) | null }).onclose = () => { this.db = null; };
          finish(db);
        };
        r.onerror = () => finish(null, r.error?.message ?? 'open failed');
        r.onblocked = () => finish(null, 'blocked by another open tab');
      } catch (e) { finish(null, (e as Error).message); }
    });
    return this.db;
  }

  /** run one request in its own transaction; undefined/false on any failure or timeout */
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest, fallback: T, onDone: (r: IDBRequest) => T): Promise<T> {
    const db = await this.open();
    if (!db) return fallback;
    return new Promise<T>((res) => {
      let done = false;
      const finish = (v: T) => { if (!done) { done = true; clearTimeout(timer); res(v); } };
      const timer = setTimeout(() => finish(fallback), this.timeoutMs);
      try {
        const t = db.transaction('kv', mode);
        const q = fn(t.objectStore('kv'));
        t.oncomplete = () => finish(onDone(q));
        t.onerror = () => finish(fallback);
        t.onabort = () => finish(fallback);
      } catch { this.db = null; finish(fallback); } // closed connection: reopen next time
    });
  }

  get(key: string): Promise<unknown> { return this.tx('readonly', (s) => s.get(key), undefined, (q) => q.result); }
  set(key: string, v: unknown): Promise<boolean> { return this.tx('readwrite', (s) => s.put(v, key), false, () => true); }
}

/** In-memory store (tests, and a stand-in when there is no IndexedDB). */
export class MemoryKv implements KvStore {
  readonly map = new Map<string, unknown>();
  unavailable: string | null = null;
  async get(key: string) { const v = this.map.get(key); return v instanceof Uint8Array ? v.slice() : v; }
  async set(key: string, v: unknown) { this.map.set(key, v instanceof Uint8Array ? v.slice() : v); return true; }
}
