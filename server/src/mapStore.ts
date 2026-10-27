// User maps: packages that players publish, so others can fly them and rooms can share them.
// Separate from the official maps on purpose: they are not reviewed, they never get a leaderboard
// (leaderboardCore.ts refuses "u-…" ids), and the app labels them "User map · not reviewed".
//
//   POST   /maps                     publish a package (.zip body; allowed origins only)
//            X-Map-Rights: yes        the uploader confirmed they made it / may share every asset in it
//            X-Map-Listed: 1 | 0      listed in the browser, or unlisted (for room shares and links)
//            X-Client: <32 hex>       the browser's random token (stored hashed: the owner)
//   GET    /maps?sort=new|popular&cursor=&q=   listed maps (status ok), newest or most downloaded
//   GET    /maps/u-…                 the map's metadata and file manifest
//   GET    /maps/u-…/package.zip     the package (immutable; 451 while hidden, 410 once removed)
//   GET    /maps/u-…/preview         its preview image
//   POST   /maps/u-…/report          {reason}: hidden automatically after REPORT_HIDE distinct reporters
//   DELETE /maps/u-…                 remove it (Authorization: Bearer ADMIN_TOKEN)
//   POST   /maps/u-…/status          {status: "ok" | "hidden"} (ADMIN_TOKEN): restore or hide
// Packages and previews live in an R2 bucket (USER_MAPS: pkg/<id>.zip, prev/<id>.<ext>), metadata,
// reports and upload quotas in one SQLite Durable Object (MapIndex). DENYLIST "map:<id>" refuses a
// map like a removal. Ids are content hashes (mapPackage.ts): publishing the same files twice gives
// the same id, and clients re-hash what they download.
import { checkPackage, ManifestFile, MAX_UPLOAD_BYTES, unzipPackage, USER_MAP_RE } from './mapPackage';
import { MapFormatError } from '../../src/maps/mapDoc';

export const REPORT_HIDE = 5;        // distinct reporters that hide a map until it is reviewed
export const DAILY_UPLOADS = 20;     // new maps per network (hashed IP) per day
export const PAGE = 24;              // maps per GET /maps page
const MAX_OFFSET = 2400;
const DAY_MS = 86_400_000;
const REASONS = ['copyright', 'offensive', 'broken', 'other'] as const;
const CLIENT_RE = /^[0-9a-f]{32}$/;
const PKG_MIME = 'application/zip';
const PREVIEW_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export type MapStatus = 'ok' | 'hidden' | 'removed';
/** A map as clients see it (no owner or network hashes). */
export interface PublicMap {
  id: string; metaId: string; name: string; author: string; license: string; version: string; description: string; tags: string[];
  size: number; created: number; downloads: number; listed: boolean; status: MapStatus; preview: boolean;
}
export interface MapRecord extends PublicMap { files: ManifestFile[]; previewType: string; owner: string; net: string; reports: number }

/** The minimal SQL surface used (a SQLite-backed Durable Object's `storage.sql`; tests pass node:sqlite). */
export interface Sql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }
/** The bit of an R2 bucket used (tests pass a Map). */
export interface Bucket {
  put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string } } | null>;
  delete(keys: string | string[]): Promise<unknown>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS maps (
    id TEXT PRIMARY KEY, meta_id TEXT NOT NULL, name TEXT NOT NULL, author TEXT NOT NULL, license TEXT NOT NULL, version TEXT NOT NULL,
    description TEXT NOT NULL, tags TEXT NOT NULL, size INTEGER NOT NULL, files TEXT NOT NULL, preview TEXT NOT NULL,
    created INTEGER NOT NULL, owner TEXT NOT NULL, net TEXT NOT NULL, listed INTEGER NOT NULL, status TEXT NOT NULL,
    downloads INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS maps_new ON maps (status, listed, created)',
  'CREATE INDEX IF NOT EXISTS maps_popular ON maps (status, listed, downloads)',
  // one row per distinct reporter (hashed network) per map
  'CREATE TABLE IF NOT EXISTS reports (map_id TEXT NOT NULL, reporter TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (map_id, reporter))',
  // new maps per network in the last day (the upload quota)
  'CREATE TABLE IF NOT EXISTS uploads (net TEXT NOT NULL, at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS uploads_net ON uploads (net, at)',
  // downloads counted once per network per map per day (popularity can't be pumped by one client)
  'CREATE TABLE IF NOT EXISTS downloads (map_id TEXT NOT NULL, who TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY (map_id, who, day))',
];

const str = (v: unknown) => String(v ?? '');
function rowToRecord(r: Record<string, unknown>): MapRecord {
  let tags: string[] = [], files: ManifestFile[] = [];
  try { tags = JSON.parse(str(r.tags)); } catch { /* none */ }
  try { files = JSON.parse(str(r.files)); } catch { /* none */ }
  return {
    id: str(r.id), metaId: str(r.meta_id), name: str(r.name), author: str(r.author), license: str(r.license), version: str(r.version),
    description: str(r.description), tags, size: Number(r.size), files, previewType: str(r.preview), preview: !!r.preview,
    created: Number(r.created), owner: str(r.owner), net: str(r.net), listed: Number(r.listed) === 1, status: str(r.status) as MapStatus,
    downloads: Number(r.downloads), reports: Number(r.reports),
  };
}
export function toPublic(m: MapRecord): PublicMap {
  return { id: m.id, metaId: m.metaId, name: m.name, author: m.author, license: m.license, version: m.version, description: m.description, tags: m.tags, size: m.size, created: m.created, downloads: m.downloads, listed: m.listed, status: m.status, preview: m.preview };
}

/** The index's logic over SQL (the MapIndex Durable Object below, or node:sqlite in tests). */
export class MapIndexCore {
  constructor(private sql: Sql) { for (const q of SCHEMA) this.sql.exec(q); }

  get(id: string): MapRecord | null {
    const r = this.sql.exec('SELECT * FROM maps WHERE id = ?', id).toArray()[0];
    return r ? rowToRecord(r) : null;
  }

  /** Before storing a new package: is it known (or removed), and may this network publish another today? */
  admit(id: string, owner: string, net: string, listed: boolean, now: number): { state: 'exists'; map: MapRecord } | { state: 'removed' | 'quota' | 'new' } {
    const m = this.get(id);
    if (m) {
      if (m.status === 'removed') return { state: 'removed' };
      // the owner publishing it again as listed lists it (an unlisted share made public)
      if (listed && !m.listed && owner && m.owner === owner) { this.sql.exec('UPDATE maps SET listed = 1 WHERE id = ?', id); m.listed = true; }
      return { state: 'exists', map: m };
    }
    if (net) {
      this.sql.exec('DELETE FROM uploads WHERE at < ?', now - DAY_MS);
      const n = Number(this.sql.exec('SELECT COUNT(*) AS n FROM uploads WHERE net = ?', net).toArray()[0].n);
      if (n >= DAILY_UPLOADS) return { state: 'quota' };
      this.sql.exec('INSERT INTO uploads (net, at) VALUES (?, ?)', net, now);
    }
    return { state: 'new' };
  }

  insert(m: Omit<MapRecord, 'downloads' | 'reports' | 'preview' | 'status'>): void {
    this.sql.exec(`INSERT OR IGNORE INTO maps (id, meta_id, name, author, license, version, description, tags, size, files, preview, created, owner, net, listed, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
    m.id, m.metaId, m.name, m.author, m.license, m.version, m.description, JSON.stringify(m.tags), m.size, JSON.stringify(m.files), m.previewType, m.created, m.owner, m.net, m.listed ? 1 : 0);
  }

  /** Listed maps that are ok, newest or most downloaded first; q matches the name or the author. */
  list(sort: 'new' | 'popular', offset: number, q: string): { maps: PublicMap[]; next: number | null } {
    const where = ["status = 'ok'", 'listed = 1'], args: unknown[] = [];
    if (q) { const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; where.push("(name LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')"); args.push(like, like); }
    const order = sort === 'popular' ? 'downloads DESC, created DESC, id' : 'created DESC, id';
    const rows = this.sql.exec(`SELECT * FROM maps WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, PAGE + 1, offset).toArray();
    const next = rows.length > PAGE && offset + PAGE <= MAX_OFFSET ? offset + PAGE : null;
    return { maps: rows.slice(0, PAGE).map((r) => toPublic(rowToRecord(r))), next };
  }

  /** A package download: counted once per network and day. Returns the map's status (null: unknown). */
  hit(id: string, who: string, now: number): MapStatus | null {
    const m = this.sql.exec('SELECT status FROM maps WHERE id = ?', id).toArray()[0];
    if (!m) return null;
    const status = str(m.status) as MapStatus;
    if (status === 'ok' && who) {
      const day = Math.floor(now / DAY_MS);
      if (this.sql.exec('INSERT OR IGNORE INTO downloads (map_id, who, day) VALUES (?, ?, ?) RETURNING day', id, who, day).toArray().length) {
        this.sql.exec('UPDATE maps SET downloads = downloads + 1 WHERE id = ?', id);
        if (Math.random() < 0.01) this.sql.exec('DELETE FROM downloads WHERE day < ?', day - 1); // (only today's rows matter)
      }
    }
    return status;
  }

  /** One report per reporter and map; REPORT_HIDE distinct reporters hide it. */
  report(id: string, reporter: string, reason: string, now: number): { reports: number; status: MapStatus } | null {
    if (!this.get(id)) return null;
    this.sql.exec('INSERT OR IGNORE INTO reports (map_id, reporter, at, reason) VALUES (?, ?, ?, ?)', id, reporter, now, reason);
    const n = Number(this.sql.exec('SELECT COUNT(*) AS n FROM reports WHERE map_id = ?', id).toArray()[0].n);
    this.sql.exec(`UPDATE maps SET reports = ?, status = CASE WHEN status = 'ok' AND ? >= ${REPORT_HIDE} THEN 'hidden' ELSE status END WHERE id = ?`, n, n, id);
    return { reports: n, status: this.get(id)!.status };
  }

  /** Moderation: remove (for good: the same files can't be published again), hide, or restore (reports cleared). */
  setStatus(id: string, status: MapStatus): MapRecord | null {
    const m = this.get(id);
    if (!m) return null;
    if (m.status === 'removed' && status !== 'removed') return m; // removed stays removed
    this.sql.exec('UPDATE maps SET status = ? WHERE id = ?', status, id);
    if (status === 'ok') { this.sql.exec('DELETE FROM reports WHERE map_id = ?', id); this.sql.exec('UPDATE maps SET reports = 0 WHERE id = ?', id); }
    return this.get(id);
  }

  /** The Durable Object's internal API (reached only through the Worker, which validates first). */
  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url), now = Date.now();
    const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/get') { const m = this.get(url.searchParams.get('id') ?? ''); return m ? out(m) : out({ error: 'not found' }, 404); }
    if (url.pathname === '/list') {
      const sort = url.searchParams.get('sort') === 'popular' ? 'popular' : 'new';
      const offset = Math.max(0, Math.min(MAX_OFFSET, Math.floor(Number(url.searchParams.get('offset')) || 0)));
      return out(this.list(sort, offset, (url.searchParams.get('q') ?? '').slice(0, 64)));
    }
    if (req.method !== 'POST') return out({ error: 'bad request' }, 400);
    let b: any;
    try { b = await req.json(); } catch { return out({ error: 'bad json' }, 400); }
    const id = typeof b?.id === 'string' && USER_MAP_RE.test(b.id) ? b.id : '';
    if (!id) return out({ error: 'bad id' }, 400);
    switch (url.pathname) {
      case '/admit': return out(this.admit(id, str(b.owner), str(b.net), b.listed === true, now));
      case '/insert': this.insert({ ...b.map, id, created: now }); return out({ ok: true, map: this.get(id) });
      case '/hit': return out({ status: this.hit(id, str(b.who), now) });
      case '/report': { const r = this.report(id, str(b.reporter), str(b.reason), now); return r ? out(r) : out({ error: 'not found' }, 404); }
      case '/status': {
        if (!['ok', 'hidden', 'removed'].includes(b.status)) return out({ error: 'bad status' }, 400);
        const m = this.setStatus(id, b.status);
        return m ? out(m) : out({ error: 'not found' }, 404);
      }
    }
    return out({ error: 'not found' }, 404);
  }
}

/** Single global index of user maps (SQLite). Re-exported by index.ts (binding MAP_INDEX). */
export class MapIndex {
  private core: MapIndexCore;
  constructor(state: { storage: { sql: unknown } }, _env: unknown) { this.core = new MapIndexCore(state.storage.sql as Sql); }
  fetch(req: Request): Promise<Response> { return this.core.handle(req); }
}

// ---------------------------------------------------------------------------------------------
// Worker routes

/** What the routes need from the Worker (index.ts builds it: bindings, CORS, the denylist, hashing). */
export interface MapDeps {
  bucket?: Bucket;
  index?: { fetch(url: string, init?: RequestInit): Promise<Response> };
  cors: Record<string, string>;
  /** the request's Origin is in ALLOWED_ORIGINS */
  originOk: boolean;
  ip: string;
  adminOk(): Promise<boolean>;
  /** any of these DENYLIST keys present */
  denied(keys: string[]): Promise<boolean>;
  /** RATE_LIMITER: false when over the limit (true without a limiter) */
  limit(key: string): Promise<boolean>;
  /** salted hash (IP_SALT) */
  hash(s: string): Promise<string>;
  readBody(req: Request, max: number): Promise<Uint8Array | null>;
}

const ROUTE = /^\/maps(?:\/(u-[a-z2-7]{20}))?(?:\/(package\.zip|preview|report|status))?$/;
export const isMapsPath = (p: string) => p === '/maps' || p.startsWith('/maps/');
const pkgKey = (id: string) => `pkg/${id}.zip`;
const prevKey = (id: string, type: string) => `prev/${id}.${PREVIEW_EXT[type] ?? 'img'}`;

export async function mapsRoute(req: Request, url: URL, d: MapDeps): Promise<Response> {
  const c = d.cors;
  const json = (body: unknown, status: number, cache = 'no-store') => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...c } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...c, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Map-Rights, X-Map-Listed, X-Client', 'Access-Control-Max-Age': '86400' } });
  const m = ROUTE.exec(url.pathname);
  if (!m) return json({ error: 'not found' }, 404);
  const [, id, sub] = m;
  if (!d.bucket || !d.index) return json({ ok: false, error: 'map sharing is not enabled on this server' }, 503);
  const index = d.index, bucket = d.bucket;
  const call = async (path: string, body?: unknown): Promise<{ status: number; j: any }> => {
    const r = await index.fetch(`https://maps${path}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  const mapDenied = (x: string) => d.denied([`map:${x}`]);

  // ---- the collection ----
  if (!id) {
    if (sub) return json({ error: 'not found' }, 404);
    if (req.method === 'GET') {
      const qs = new URLSearchParams({ sort: url.searchParams.get('sort') === 'popular' ? 'popular' : 'new', offset: String(Math.floor(Number(url.searchParams.get('cursor')) || 0)), q: (url.searchParams.get('q') ?? '').slice(0, 64) });
      const r = await call(`/list?${qs}`).catch(() => null);
      if (!r || r.status !== 200) return json({ maps: [], next: null, error: 'map index unavailable' }, 503);
      return json({ maps: r.j.maps, next: r.j.next === null ? null : String(r.j.next) }, 200, 'public, max-age=30');
    }
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return publish(req, d, call, bucket, json);
  }

  // ---- one map ----
  if (req.method === 'DELETE' && !sub) {
    if (!(await d.adminOk())) return json({ error: 'not found' }, 404);
    const r = await call('/status', { id, status: 'removed' });
    if (r.status !== 200) return json(r.j ?? { error: 'not found' }, r.status);
    await bucket.delete([pkgKey(id), ...(r.j.previewType ? [prevKey(id, r.j.previewType)] : [])]);
    return json({ ok: true, id, status: 'removed' }, 200);
  }
  if (sub === 'status') {
    if (req.method !== 'POST' || !(await d.adminOk())) return json({ error: 'not found' }, 404);
    let b: any; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    if (b?.status !== 'ok' && b?.status !== 'hidden') return json({ error: 'status must be "ok" or "hidden"' }, 400);
    const r = await call('/status', { id, status: b.status });
    return json(r.j, r.status);
  }
  if (sub === 'report') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    if (!d.originOk) return json({ ok: false, error: 'origin not allowed' }, 403);
    if (!(await d.limit(`rp:${d.ip}`))) return json({ ok: false, error: 'too many reports, try again in a minute' }, 429);
    const body = await d.readBody(req, 2048);
    let b: any = {};
    try { b = body && body.length ? JSON.parse(new TextDecoder().decode(body)) : {}; } catch { return json({ ok: false, error: 'bad json' }, 400); }
    const reason = (REASONS as readonly string[]).includes(b?.reason) ? b.reason : 'other';
    // one voice per network (hashed IP); without an address, per browser token
    const reporter = d.ip ? await d.hash(d.ip) : typeof b?.client === 'string' && CLIENT_RE.test(b.client) ? await d.hash(`client|${b.client}`) : '';
    if (!reporter) return json({ ok: false, error: 'cannot tell who is reporting' }, 400);
    const r = await call('/report', { id, reporter, reason });
    return json(r.status === 200 ? { ok: true, ...r.j } : { ok: false, error: 'not found' }, r.status);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
  if (await mapDenied(id)) return json({ error: 'this map was removed' }, 410);
  if (sub === 'package.zip') {
    const r = await call('/hit', { id, who: d.ip ? await d.hash(d.ip) : '' });
    const st = r.j?.status as MapStatus | null | undefined;
    if (r.status !== 200) return json({ error: 'map index unavailable' }, 503);
    if (!st) return json({ error: 'no such map' }, 404);
    if (st === 'removed') return json({ error: 'this map was removed' }, 410);
    if (st === 'hidden') return json({ error: 'this map is hidden after reports while it is reviewed' }, 451);
    const obj = await bucket.get(pkgKey(id));
    if (!obj) return json({ error: 'no such map' }, 404);
    return new Response(req.method === 'HEAD' ? null : obj.body, { headers: {
      'Content-Type': PKG_MIME, 'Content-Disposition': `attachment; filename="${id}.zip"`, 'X-Content-Type-Options': 'nosniff',
      // the id is the hash of the contents: the bytes behind a URL never change
      'Cache-Control': 'public, max-age=31536000, immutable', ...c,
    } });
  }
  const r = await call(`/get?id=${id}`).catch(() => null);
  if (!r || (r.status !== 200 && r.status !== 404)) return json({ error: 'map index unavailable' }, 503);
  const rec = r.status === 200 ? (r.j as MapRecord) : null;
  if (!rec) return json({ error: 'no such map' }, 404, 'public, max-age=60');
  if (rec.status === 'removed') return json({ error: 'this map was removed' }, 410, 'public, max-age=60');
  if (sub === 'preview') {
    if (rec.status !== 'ok' || !rec.previewType) return json({ error: 'no preview' }, 404, 'public, max-age=60');
    const obj = await bucket.get(prevKey(id, rec.previewType));
    if (!obj) return json({ error: 'no preview' }, 404, 'public, max-age=60');
    return new Response(req.method === 'HEAD' ? null : obj.body, { headers: { 'Content-Type': rec.previewType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=86400', ...c } });
  }
  return json({ ...toPublic(rec), files: rec.files }, 200, 'public, max-age=60');
}

async function publish(req: Request, d: MapDeps, call: (path: string, body?: unknown) => Promise<{ status: number; j: any }>, bucket: Bucket,
  json: (body: unknown, status: number) => Response): Promise<Response> {
  if (!d.originOk) return json({ ok: false, error: 'origin not allowed' }, 403);
  if (Number(req.headers.get('Content-Length') ?? 0) > MAX_UPLOAD_BYTES) return json({ ok: false, error: `the package is larger than ${MAX_UPLOAD_BYTES >> 20} MiB` }, 413);
  if (!(await d.limit(`up:${d.ip}`))) return json({ ok: false, error: 'too many uploads, try again in a minute' }, 429);
  if (d.ip && (await d.denied([`ip:${d.ip}`]))) return json({ ok: false, error: 'forbidden' }, 403);
  if (req.headers.get('X-Map-Rights') !== 'yes') return json({ ok: false, error: 'confirm that you made this map or have the right to share every asset in it' }, 400);
  const client = req.headers.get('X-Client') ?? '';
  if (!CLIENT_RE.test(client)) return json({ ok: false, error: 'missing client token' }, 400);
  const listed = req.headers.get('X-Map-Listed') === '1';
  const body = await d.readBody(req, MAX_UPLOAD_BYTES);
  if (!body) return json({ ok: false, error: `the package is larger than ${MAX_UPLOAD_BYTES >> 20} MiB` }, 413);
  const { files, errors } = await unzipPackage(body);
  if (errors.length) return json({ ok: false, error: 'the package has problems', errors: errors.slice(0, 50) }, 422);
  let pkg;
  try { pkg = await checkPackage(files); } catch (e) {
    if (e instanceof MapFormatError) return json({ ok: false, error: 'the package has problems', errors: e.errors.slice(0, 50) }, 422);
    return json({ ok: false, error: 'the package could not be checked' }, 422);
  }
  const id = pkg.id;
  if (await d.denied([`map:${id}`])) return json({ ok: false, error: 'this map was removed and cannot be published again' }, 410);
  const [owner, net] = await Promise.all([d.hash(`client|${client}`), d.ip ? d.hash(d.ip) : Promise.resolve('')]);
  const a = await call('/admit', { id, owner, net, listed });
  if (a.status !== 200 || !a.j) return json({ ok: false, error: 'map index unavailable' }, 503);
  if (a.j.state === 'removed') return json({ ok: false, error: 'this map was removed and cannot be published again' }, 410);
  if (a.j.state === 'quota') return json({ ok: false, error: `at most ${DAILY_UPLOADS} new maps per day from one network; try again tomorrow` }, 429);
  if (a.j.state === 'exists') return json({ ok: true, id, existing: true, listed: !!a.j.map?.listed, status: a.j.map?.status, warnings: pkg.warnings }, 200);
  await bucket.put(pkgKey(id), body, { httpMetadata: { contentType: PKG_MIME } });
  if (pkg.preview) await bucket.put(prevKey(id, pkg.preview.type), files.get(pkg.preview.path)!, { httpMetadata: { contentType: pkg.preview.type } });
  const rec = { ...pkg.meta, files: pkg.manifest, size: pkg.size, previewType: pkg.preview?.type ?? '', owner, net, listed };
  const ins = await call('/insert', { id, map: rec });
  if (ins.status !== 200) return json({ ok: false, error: 'map index unavailable' }, 503);
  return json({ ok: true, id, existing: false, listed, status: 'ok', warnings: pkg.warnings }, 201);
}
