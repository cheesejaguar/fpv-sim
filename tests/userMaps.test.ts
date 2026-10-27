// User maps: content ids, the relay's package checks, the MapIndex Durable Object (node:sqlite)
// and the Worker's /maps routes (publish, idempotent re-publish, listing, reports, removal), and
// the client side (ids, leaderboard exclusion, verifying a downloaded package).
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { hasTrack } from '../server/src/leaderboardCore';
import { base32, checkPackage, MAX_UPLOAD_BYTES, packageId, unzipPackage, verifyPackage } from '../server/src/mapPackage';
import { DAILY_UPLOADS, MapIndexCore, REPORT_HIDE } from '../server/src/mapStore';
import { ZipWriter } from '../src/app/datasetFiles';
import { onBoard } from '../src/app/leaderboard';
import { MapFormatError } from '../src/maps/mapDoc';
import { isLocalMapId, isUserMapId, MAP_ID_RE } from '../src/net/protocol';
import { downloadUserPackage, parseMapRef, parseSummary, setFetch, zipPackage } from '../src/net/userMaps';

const enc = new TextEncoder();
const mapJson = (meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => JSON.stringify({
  format: 'fpvsim-map', formatVersion: 1,
  meta: { id: 'test-map', name: 'Test Map', author: 'Tester', license: 'CC0-1.0', version: '1.0.0', ...meta },
  size: 50, spawn: { pos: [0, 0, 0] }, gates: [{ kind: 'square', pos: [0, 10] }], ...extra,
});
const pkg = (files: Record<string, string | Uint8Array> = {}, meta?: Record<string, unknown>, extra?: Record<string, unknown>) =>
  new Map<string, Uint8Array>(Object.entries({ 'map.json': mapJson(meta, extra), 'ATTRIBUTION.md': '# Test map\nMade by Tester, CC0.\n', ...files }).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]));
const zipOf = (files: Map<string, Uint8Array>) => { const z = new ZipWriter(); for (const [p, b] of files) z.add(p, b); return z.finish(); };
/** A tiny valid PNG header (only the header is read by the relay). */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return b;
}
const errorsOf = async (p: Promise<unknown>) => { try { await p; return []; } catch (e) { return e instanceof MapFormatError ? e.errors : [String(e)]; } };

describe('content ids', () => {
  test('base32 (RFC 4648, lower case, no padding)', () => {
    expect(base32(enc.encode(''))).toBe('');
    expect(base32(enc.encode('f'))).toBe('my');
    expect(base32(enc.encode('foobar'))).toBe('mzxw6ytboi');
  });

  test('the id names the files, not their order or the zip; it is stable and passes the room protocol', async () => {
    const a = pkg(), b = new Map([...pkg()].reverse());
    const ia = await packageId(a), ib = await packageId(b);
    expect(ia.id).toBe(ib.id);
    expect(ia.id).toMatch(/^u-[a-z2-7]{20}$/);
    expect(isUserMapId(ia.id) && MAP_ID_RE.test(ia.id)).toBe(true);
    expect(ia.manifest.map((f) => f.path)).toEqual(['ATTRIBUTION.md', 'map.json']);
    // pinned: changing the hashing would orphan every published map and room share
    expect((await packageId(new Map([['map.json', enc.encode('{}')]]))).id).toBe('u-lyi66tok2yoop7rti6o5');
    // one byte changes it
    expect((await packageId(pkg({ 'ATTRIBUTION.md': '# Test map\nMade by Tester, CC0!\n' }))).id).not.toBe(ia.id);
    // a path change too
    expect((await packageId(new Map([['map.json', enc.encode('{}')], ['a.txt', enc.encode('x')]]))).id).not.toBe((await packageId(new Map([['map.json', enc.encode('{}')], ['b.txt', enc.encode('x')]]))).id);
  });

  test('ids, prefixes and boards', () => {
    expect(isUserMapId('u-abcdefghijklmnopqrst')).toBe(true);
    expect(isUserMapId('u-boat')).toBe(false);
    expect(isUserMapId('u-ABCDEFGHIJKLMNOPQRST')).toBe(false);
    expect(isUserMapId('local-x')).toBe(false);
    expect(isLocalMapId('u-abcdefghijklmnopqrst')).toBe(false);
    // official boards never take user maps, on the client or the relay
    expect(onBoard('field', '')).toBe(true);
    expect(onBoard('u-abcdefghijklmnopqrst', '')).toBe(false);
    expect(hasTrack('u-abcdefghijklmnopqrst')).toBe(false);
    expect(parseMapRef('https://fpv-sim-gamma.vercel.app/?map=u-abcdefghijklmnopqrst')).toBe('u-abcdefghijklmnopqrst');
    expect(parseMapRef(' u-abcdefghijklmnopqrst ')).toBe('u-abcdefghijklmnopqrst');
    expect(parseMapRef('https://x.example/?map=field')).toBeNull();
  });
});

describe('package checks', () => {
  test('a valid package passes, with cleaned names', async () => {
    const r = await checkPackage(pkg({ 'preview.png': png(640, 360) }, { preview: 'preview.png', description: 'A small​ test' }));
    expect(r.meta).toMatchObject({ metaId: 'test-map', name: 'Test Map', author: 'Tester', license: 'CC0-1.0', description: 'A small test' });
    expect(r.preview).toEqual({ path: 'preview.png', type: 'image/png' });
    expect(r.id).toBe((await packageId(pkg({ 'preview.png': png(640, 360) }, { preview: 'preview.png', description: 'A small​ test' }))).id);
  });

  test('refuses bad licences, missing licence texts, forbidden and oversize files, bad map.json, bad headers', async () => {
    expect((await errorsOf(checkPackage(pkg({}, { license: 'CC-BY-NC-4.0' })))).join('\n')).toMatch(/NonCommercial/);
    expect((await errorsOf(checkPackage(pkg({}, { license: 'MIT' })))).join('\n')).toMatch(/LICENSE\.txt/);
    expect(await errorsOf(checkPackage(pkg({ 'LICENSE.txt': 'MIT License' }, { license: 'MIT' })))).toEqual([]);
    expect((await errorsOf(checkPackage(pkg({ 'doom.wad': 'IWAD' })))).join('\n')).toMatch(/doom\.wad.*not allowed/);
    expect((await errorsOf(checkPackage(pkg({ 'big.txt': new Uint8Array((8 << 20) + 1) })))).join('\n')).toMatch(/per-file budget/);
    expect((await errorsOf(checkPackage(new Map([['map.json', enc.encode('{"format":"fpvsim-map"')]])))).join('\n')).toMatch(/not valid JSON/);
    expect((await errorsOf(checkPackage(new Map([['map.json', enc.encode(JSON.stringify({ format: 'fpvsim-map', formatVersion: 1 }))]])))).join('\n')).toMatch(/meta: is required/);
    expect((await errorsOf(checkPackage(new Map([['x.json', enc.encode('{}')]])))).join('\n')).toMatch(/no map\.json/);
    expect((await errorsOf(checkPackage(pkg({ 'tex.png': enc.encode('not a png') })))).join('\n')).toMatch(/not a PNG/);
    expect((await errorsOf(checkPackage(pkg({ 'tex.png': png(2048, 2048) }, {}, { ground: { type: 'flat', texture: 'tex.png' } })))).join('\n')).toMatch(/2048x2048 px; the budget is 1024x1024/);
    expect((await errorsOf(checkPackage(pkg({}, {}, { ground: { type: 'flat', texture: 'missing.png' } })))).join('\n')).toMatch(/missing\.png" is not in the package/);
    expect((await errorsOf(checkPackage(pkg({ 'arch.glb': enc.encode('glTF but not really') }, {}, { geometry: [{ type: 'gltf', src: 'arch.glb' }] })))).join('\n')).toMatch(/binary glTF/);
    expect((await errorsOf(checkPackage(pkg({}, { name: 'fuck this' })))).join('\n')).toMatch(/name: this name is not allowed/);
  });

  test('unzipping is bounded by the declared sizes and the budgets', async () => {
    const zip = zipOf(pkg());
    expect((await unzipPackage(zip)).errors).toEqual([]);
    // a central directory that understates an entry's size
    const bad = zip.slice();
    const dv = new DataView(bad.buffer);
    const eocd = bad.length - 22, cd = dv.getUint32(eocd + 16, true);
    dv.setUint32(cd + 24, 3, true);
    expect((await unzipPackage(bad)).errors.join('\n')).toMatch(/cannot be unpacked|does not match/);
    expect((await unzipPackage(enc.encode('PK not a zip'))).errors.join('\n')).toMatch(/not a readable zip/);
  });

  test('a downloaded package must hash to its id', async () => {
    const files = pkg(), { id } = await packageId(files);
    const zip = await zipPackage(files);
    expect([...(await verifyPackage(zip, id)).keys()].sort()).toEqual(['ATTRIBUTION.md', 'map.json']);
    const other = await zipPackage(pkg({ 'ATTRIBUTION.md': 'changed' }));
    await expect(verifyPackage(other, id)).rejects.toThrow(/does not match its id/);
    // through the client's download path (the relay is a fake answering with the tampered package)
    vi.stubGlobal('location', new URL('https://fpv-sim-gamma.vercel.app/'));
    setFetch(async () => new Response(other as Uint8Array<ArrayBuffer>, { status: 200 }));
    try {
      await expect(downloadUserPackage(id)).rejects.toThrow(/does not match its id/);
      setFetch(async () => new Response(zip as Uint8Array<ArrayBuffer>, { status: 200 }));
      expect((await downloadUserPackage(id)).zip).toEqual(zip);
      setFetch(async () => new Response('{"error":"removed"}', { status: 410 }));
      await expect(downloadUserPackage(id)).rejects.toThrow(/removed/);
    } finally { setFetch(null); vi.unstubAllGlobals(); }
  });

  test('summaries from a relay are checked', () => {
    expect(parseSummary({ id: 'u-abcdefghijklmnopqrst', name: 'Nice‮ map', author: 'Me', license: 'CC0-1.0<script>', version: '1.0.0', size: 10, downloads: -5, listed: true, status: 'weird', preview: 1 }))
      .toMatchObject({ name: 'Nice map', license: 'CC0-1.0script', downloads: 0, status: 'ok', preview: false });
    expect(parseSummary({ id: 'field', name: 'x', author: 'y' })).toBeNull();
    expect(parseSummary({ id: 'u-abcdefghijklmnopqrst', name: '', author: 'y' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The index (SQLite) and the Worker routes

let sqlite: any = null;
try { sqlite = await import('node:sqlite'); } catch { /* Node without node:sqlite: these tests are skipped */ }
let mod: any;
const INDEX = '../server/src/index';
beforeAll(async () => {
  (globalThis as any).WebSocketRequestResponsePair ??= class { constructor(public request: string, public response: string) {} };
  mod = await import(/* @vite-ignore */ INDEX);
});
function sqlStorage() {
  const db = new sqlite.DatabaseSync(':memory:');
  return { db, sql: { exec: (q: string, ...b: unknown[]) => { const rows = db.prepare(q).all(...b.map((x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x))); return { toArray: () => rows }; } } };
}

describe.skipIf(!sqlite)('MapIndex', () => {
  const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id, metaId: 'm', name: 'Map', author: 'A', license: 'CC0-1.0', version: '1.0.0', description: '', tags: [], size: 1, files: [], previewType: '', created: 1, owner: 'o', net: 'n', listed: true, ...extra });
  test('quota, listing, reports and status', () => {
    const core = new MapIndexCore(sqlStorage().sql);
    for (let i = 0; i < DAILY_UPLOADS; i++) expect(core.admit(`u-${'a'.repeat(19)}${'abcdefghijklmnopqrstuvwxyz'[i]}`, 'o', 'net1', true, 1000).state).toBe('new');
    expect(core.admit('u-bbbbbbbbbbbbbbbbbbbb', 'o', 'net1', true, 1000).state).toBe('quota');
    expect(core.admit('u-bbbbbbbbbbbbbbbbbbbb', 'o', 'net1', true, 1000 + 86_400_001).state).toBe('new'); // a day later
    core.insert(rec('u-aaaaaaaaaaaaaaaaaaaa', { created: 10 }));
    core.insert(rec('u-bbbbbbbbbbbbbbbbbbbb', { created: 20, name: 'Second' }));
    core.insert(rec('u-cccccccccccccccccccc', { created: 30, listed: false }));
    expect(core.list('new', 0, '').maps.map((m) => m.id)).toEqual(['u-bbbbbbbbbbbbbbbbbbbb', 'u-aaaaaaaaaaaaaaaaaaaa']);
    expect(core.list('new', 0, 'sec').maps.map((m) => m.id)).toEqual(['u-bbbbbbbbbbbbbbbbbbbb']);
    expect(core.list('new', 0, '%').maps).toEqual([]); // LIKE wildcards are matched literally
    expect(core.hit('u-aaaaaaaaaaaaaaaaaaaa', 'w1', 5)).toBe('ok');
    expect(core.hit('u-aaaaaaaaaaaaaaaaaaaa', 'w1', 6)).toBe('ok'); // the same network again the same day: counted once
    expect(core.hit('u-aaaaaaaaaaaaaaaaaaaa', 'w2', 7)).toBe('ok');
    expect(core.list('popular', 0, '').maps[0]).toMatchObject({ id: 'u-aaaaaaaaaaaaaaaaaaaa', downloads: 2 });
    expect(JSON.stringify(core.list('new', 0, ''))).not.toMatch(/"owner"|"net"/);
    // reports: distinct reporters only; REPORT_HIDE hide it
    for (let i = 0; i < REPORT_HIDE - 1; i++) core.report('u-aaaaaaaaaaaaaaaaaaaa', `r${i}`, 'other', 1);
    expect(core.report('u-aaaaaaaaaaaaaaaaaaaa', 'r0', 'other', 1)).toEqual({ reports: REPORT_HIDE - 1, status: 'ok' });
    expect(core.report('u-aaaaaaaaaaaaaaaaaaaa', 'rlast', 'copyright', 1)).toEqual({ reports: REPORT_HIDE, status: 'hidden' });
    expect(core.list('new', 0, '').maps.map((m) => m.id)).toEqual(['u-bbbbbbbbbbbbbbbbbbbb']);
    expect(core.setStatus('u-aaaaaaaaaaaaaaaaaaaa', 'ok')).toMatchObject({ status: 'ok', reports: 0 });
    expect(core.setStatus('u-aaaaaaaaaaaaaaaaaaaa', 'removed')).toMatchObject({ status: 'removed' });
    expect(core.setStatus('u-aaaaaaaaaaaaaaaaaaaa', 'ok')).toMatchObject({ status: 'removed' }); // for good
    expect(core.admit('u-aaaaaaaaaaaaaaaaaaaa', 'o', 'net2', true, 1).state).toBe('removed');
    // the owner re-publishing an unlisted map as listed lists it; someone else can't
    expect(core.admit('u-cccccccccccccccccccc', 'other', 'net2', true, 1)).toMatchObject({ state: 'exists', map: { listed: false } });
    expect(core.admit('u-cccccccccccccccccccc', 'o', 'net2', true, 1)).toMatchObject({ state: 'exists', map: { listed: true } });
  });
});

describe.skipIf(!sqlite)('Worker /maps', () => {
  const ORIGIN = 'https://fpv-sim-gamma.vercel.app', CLIENT = '0123456789abcdef0123456789abcdef';
  function env(extra: Record<string, unknown> = {}) {
    const s = sqlStorage();
    const obj = new mod.MapIndex({ storage: { sql: s.sql } }, {});
    const objects = new Map<string, { bytes: Uint8Array; type?: string }>();
    const bucket = {
      put: async (k: string, v: Uint8Array, o?: { httpMetadata?: { contentType?: string } }) => { objects.set(k, { bytes: v.slice(), type: o?.httpMetadata?.contentType }); },
      get: async (k: string) => { const o = objects.get(k); return o ? { body: new Response(o.bytes as Uint8Array<ArrayBuffer>).body, httpMetadata: { contentType: o.type } } : null; },
      delete: async (k: string | string[]) => { for (const x of Array.isArray(k) ? k : [k]) objects.delete(x); },
    };
    const stub = { fetch: (url: string, init?: RequestInit) => obj.fetch(new Request(url, init)) };
    return { db: s.db, objects, env: { MAP_INDEX: { idFromName: () => 'global', get: () => stub }, USER_MAPS: bucket, ALLOWED_ORIGINS: `${ORIGIN},app://fpv-sim`, IP_SALT: 'salt', ADMIN_TOKEN: 'sekrit', ...extra } as any };
  }
  const req = (e: any, path: string, init: RequestInit & { headers?: Record<string, string> } = {}, ip = '203.0.113.7') =>
    mod.default.fetch(new Request(`https://relay.example${path}`, { ...init, headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, ...init.headers } }), e);
  const publish = (e: any, zip: Uint8Array, headers: Record<string, string> = {}) =>
    req(e, '/maps', { method: 'POST', body: zip as Uint8Array<ArrayBuffer>, headers: { 'Content-Type': 'application/zip', 'X-Map-Rights': 'yes', 'X-Map-Listed': '1', 'X-Client': CLIENT, ...headers } });

  test('publish, idempotent re-publish, metadata, package, listing', async () => {
    const e = env();
    const files = pkg({ 'preview.png': png(640, 360) }, { preview: 'preview.png' }), zip = zipOf(files);
    const { id } = await packageId(files);
    const r = await publish(e.env, zip);
    expect(r.status).toBe(201);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await r.json()).toMatchObject({ ok: true, id, existing: false, listed: true });
    expect(e.objects.has(`pkg/${id}.zip`) && e.objects.get(`prev/${id}.png`)?.type).toBe('image/png');
    // the same files again (another zip of them): the same id, nothing stored twice
    const again = await publish(e.env, await zipPackage(files));
    expect([again.status, (await again.json()).id]).toEqual([200, id]);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM maps').get().n).toBe(1);
    const meta = await (await req(e.env, `/maps/${id}`)).json();
    expect(meta).toMatchObject({ id, name: 'Test Map', author: 'Tester', license: 'CC0-1.0', status: 'ok', preview: true });
    expect(meta.files.map((f: any) => f.path)).toEqual(['ATTRIBUTION.md', 'map.json', 'preview.png']);
    expect(JSON.stringify(meta)).not.toMatch(/owner|net|203\.0\.113/);
    const dl = await req(e.env, `/maps/${id}/package.zip`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(dl.headers.get('Cache-Control')).toMatch(/immutable/);
    expect(dl.headers.get('Content-Disposition')).toMatch(/attachment/);
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(zip);
    expect((await req(e.env, `/maps/${id}/preview`)).headers.get('Content-Type')).toBe('image/png');
    const list = await (await req(e.env, '/maps?sort=popular')).json();
    expect(list.maps.map((m: any) => [m.id, m.downloads])).toEqual([[id, 1]]);
    expect((await req(e.env, '/maps/u-zzzzzzzzzzzzzzzzzzzz')).status).toBe(404);
    expect((await req(e.env, '/maps/u-zzzzzzzzzzzzzzzzzzzz/package.zip')).status).toBe(404);
    const pre = await req(e.env, '/maps', { method: 'OPTIONS' });
    expect(pre.headers.get('Access-Control-Allow-Headers')).toMatch(/X-Map-Rights/);
  });

  test('unlisted maps are not listed; uploads need the origin, the rights confirmation and a valid package', async () => {
    const e = env();
    const files = pkg(), zip = zipOf(files), { id } = await packageId(files);
    expect((await publish(e.env, zip, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await publish(e.env, zip, { 'X-Map-Rights': 'no' })).status).toBe(400);
    expect((await publish(e.env, zip, { 'X-Client': 'x' })).status).toBe(400);
    expect((await publish(e.env, zip, { 'Content-Length': String(MAX_UPLOAD_BYTES + 1) })).status).toBe(413);
    const bad = await publish(e.env, zipOf(pkg({}, { license: 'CC-BY-NC-4.0' })));
    expect(bad.status).toBe(422);
    expect((await bad.json()).errors.join('\n')).toMatch(/NonCommercial/);
    expect((await publish(e.env, zipOf(pkg({ 'maps/e1m1.wad': 'x' })))).status).toBe(422);
    expect((await publish(e.env, zip, { 'X-Map-Listed': '0' })).status).toBe(201);
    expect((await (await req(e.env, '/maps')).json()).maps).toEqual([]);
    expect((await req(e.env, `/maps/${id}/package.zip`)).status).toBe(200); // the link still works
    const limited = { ...e.env, RATE_LIMITER: { limit: async ({ key }: { key: string }) => ({ success: key !== 'up:203.0.113.7' }) } };
    expect((await publish(limited, zip)).status).toBe(429);
    const noR2 = { ...e.env, USER_MAPS: undefined };
    expect((await publish(noR2, zip)).status).toBe(503);
  });

  test('reports hide a map after REPORT_HIDE distinct networks; admin delete removes it (410), for good', async () => {
    const e = env();
    const files = pkg(), zip = zipOf(files), { id } = await packageId(files);
    await publish(e.env, zip);
    const report = (ip: string) => req(e.env, `/maps/${id}/report`, { method: 'POST', body: JSON.stringify({ reason: 'copyright' }), headers: { 'Content-Type': 'application/json' } }, ip);
    for (let i = 0; i < REPORT_HIDE - 1; i++) expect((await (await report(`198.51.100.${i}`)).json()).status).toBe('ok');
    expect((await (await report('198.51.100.0')).json()).reports).toBe(REPORT_HIDE - 1); // the same network twice
    expect(await (await report('198.51.100.99')).json()).toMatchObject({ ok: true, reports: REPORT_HIDE, status: 'hidden' });
    expect((await (await req(e.env, '/maps')).json()).maps).toEqual([]);
    expect((await req(e.env, `/maps/${id}/package.zip`)).status).toBe(451);
    expect((await (await req(e.env, `/maps/${id}`)).json()).status).toBe('hidden');
    // the admin restores it
    expect((await req(e.env, `/maps/${id}/status`, { method: 'POST', body: '{"status":"ok"}', headers: { Authorization: 'Bearer sekrit' } })).status).toBe(200);
    expect((await req(e.env, `/maps/${id}/package.zip`)).status).toBe(200);
    // ... and removes it
    expect((await req(e.env, `/maps/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer wrong' } })).status).toBe(404);
    expect((await req(e.env, `/maps/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer sekrit' } })).status).toBe(200);
    expect(e.objects.has(`pkg/${id}.zip`)).toBe(false);
    expect((await req(e.env, `/maps/${id}/package.zip`)).status).toBe(410);
    expect((await req(e.env, `/maps/${id}`)).status).toBe(410);
    expect((await publish(e.env, zip)).status).toBe(410);
    // the denylist refuses a map like a removal
    const other = pkg({ 'ATTRIBUTION.md': 'other' }), oid = (await packageId(other)).id;
    await publish(e.env, zipOf(other));
    const deny = { ...e.env, DENYLIST: { get: async (k: string) => (k === `map:${oid}` ? '1' : null) } };
    expect((await req(deny, `/maps/${oid}/package.zip`)).status).toBe(410);
  });
});
