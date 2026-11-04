// The control API's Node transports (scripts/fpv-api.mjs runs them):
//   serveHeadless  newline-delimited JSON over TCP (one headless simulation per connection) or stdio;
//   serveRelay     the live browser game: the page connects out to a local WebSocket, and programs
//                  talk to it through the same TCP JSON-lines protocol as to a headless simulation.
// Everything binds to the loopback interface unless told otherwise.
import { createServer as createHttpServer, IncomingMessage } from 'node:http';
import { createServer as createTcpServer, Socket } from 'node:net';
import { registerMapFromDisk } from '../headless/mapFiles';
import { createNodeEnv } from '../headless/node';
import { HeadlessBackend } from './headlessBackend';
import { API_MAX_MESSAGE, ApiSession, Clock, fromBase64, parseRequest, toBase64 } from './protocol';
import { attachWebSocket, WsPeer } from './wsServer';

/**
 * Split a socket's text into lines (the socket must be in utf8 mode, so a character split across
 * chunks stays whole). A line over the message limit, or anything that isn't a JSON object, ends the
 * connection: a web page can make a browser POST to a local port, and its body must never be read
 * as commands (an HTTP request line is the first thing such a connection sends).
 */
function lines(socket: Socket, onLine: (l: string) => void, reject: (why: string) => void) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    if (socket.destroyed) return;
    buf += chunk;
    if (buf.length > API_MAX_MESSAGE && !buf.includes('\n')) { buf = ''; reject('message too large'); return; }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0 && !socket.destroyed) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!l) continue;
      if (!l.startsWith('{')) { reject(/^[A-Z]+ \S+ HTTP\/\d/.test(l) ? 'HTTP is not spoken here' : 'not a JSON object'); return; }
      onLine(l);
    }
  });
}

/** Above this much unsent data a client is not reading: events are dropped, then it is disconnected. */
const MAX_BACKLOG = 32 << 20;
function writeTo(s: Socket, text: string, event: boolean) {
  if (s.destroyed) return;
  if (s.writableLength > MAX_BACKLOG) { if (event) return; s.destroy(); return; }
  s.write(text + '\n');
}
const refuse = (s: Socket, why: string) => { if (!s.destroyed) s.end(JSON.stringify({ ok: false, error: `${why}: closing the connection` }) + '\n'); s.destroy(); };

/**
 * A TCP MAVLink endpoint, as ArduPilot SITL's tcp:5760: every client gets ArduPilot's pass-through
 * bytes, and what any client sends goes to it (pymavlink / MAVProxy / QGroundControl / Mission
 * Planner: connect to tcp:127.0.0.1:<port>). Raw bytes both ways: MAVLink is not line-delimited.
 */
export async function serveMavlinkPort(o: { host?: string; port: number; log?: (t: string) => void }, toAp: (b: Uint8Array) => void, onClient?: () => void) {
  const clients = new Set<Socket>();
  const server = createTcpServer((socket) => {
    clients.add(socket);
    socket.setNoDelay(true);
    o.log?.(`MAVLink client ${socket.remoteAddress}:${socket.remotePort} connected`);
    onClient?.();
    socket.on('data', (chunk: Buffer) => toAp(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(o.port, o.host ?? '127.0.0.1', () => res()); });
  return {
    port: (server.address() as { port: number }).port,
    get clients() { return clients.size; },
    /** ArduPilot's bytes to every client (a client that stops reading is dropped) */
    send(b: Uint8Array) { for (const c of clients) { if (c.writableLength > MAX_BACKLOG) c.destroy(); else c.write(b); } },
    close: () => new Promise<void>((res) => { for (const c of clients) c.destroy(); server.close(() => res()); }),
  };
}

export interface HeadlessServerOptions {
  clock: Clock;
  app: string;
  /** default scenario for the first reset of each connection */
  scenario?: unknown;
  host?: string;
  port?: number;
  log?: (t: string) => void;
  /** map packages on disk (folders or .zip files) registered under their meta.id before serving */
  maps?: string[];
  /** a TCP MAVLink port (ArduPilot builds): attached to the newest simulation */
  mavlinkPort?: number;
}

/** Register the map packages from disk (validated: a broken one stops the server from starting). */
async function registerMaps(o: Pick<HeadlessServerOptions, 'maps' | 'log'>) {
  for (const path of o.maps ?? []) {
    const m = await registerMapFromDisk(path);
    o.log?.(`map "${m.id}" (${m.name}) from ${path}${m.warnings.length ? `: ${m.warnings.length} warning(s): ${m.warnings.join('; ')}` : ''}`);
  }
}

/** One simulation per TCP connection. Resolves once listening, with the port. */
export async function serveHeadless(o: HeadlessServerOptions): Promise<{ port: number; mavlinkPort?: number; close: () => Promise<void> }> {
  const log = o.log ?? (() => {});
  await registerMaps(o);
  const conns = new Set<Socket>();
  // the MAVLink port follows the newest connection's simulation
  let mavTarget: HeadlessBackend | null = null;
  const mav = o.mavlinkPort !== undefined ? await serveMavlinkPort({ host: o.host, port: o.mavlinkPort, log }, (b) => mavTarget?.mavlinkIn(b)) : null;
  const server = createTcpServer((socket) => {
    conns.add(socket);
    socket.setNoDelay(true);
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`client ${peer} connected`);
    let backend: HeadlessBackend | null = null;
    socket.on('close', () => { backend?.close(); if (mavTarget === backend) mavTarget = null; conns.delete(socket); log(`client ${peer} left`); });
    const ready = createNodeEnv().then((env) => {
      if (socket.destroyed) return null;
      const session = new ApiSession({ handle: (r) => b.handle(r) }, (t) => writeTo(socket, t, t.startsWith('{"event"')));
      const b = backend = new HeadlessBackend(env, { clock: o.clock, app: o.app, scenario: o.scenario, emit: (e) => session.event(e) });
      if (mav) { if (mavTarget) mavTarget.onMavlink = null; mavTarget = b; b.onMavlink = (bytes) => mav.send(bytes); }
      return session;
    }, (e) => { refuse(socket, `the simulator could not start (${(e as Error).message})`); return null; });
    lines(socket, (l) => { void ready.then((s) => s?.receive(l)); }, (why) => refuse(socket, why));
    socket.on('error', () => {});
  });
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(o.port ?? 7878, o.host ?? '127.0.0.1', () => res()); });
  const port = (server.address() as { port: number }).port;
  return { port, mavlinkPort: mav?.port, close: async () => { await mav?.close(); await new Promise<void>((res) => { for (const c of conns) c.destroy(); server.close(() => res()); }); } };
}

/** One simulation over stdin / stdout (logs go to stderr). */
export async function serveStdio(o: Omit<HeadlessServerOptions, 'host' | 'port'>): Promise<void> {
  await registerMaps(o);
  const env = await createNodeEnv();
  const out = (t: string) => process.stdout.write(t + '\n');
  const session = new ApiSession({ handle: (r) => backend.handle(r) }, out);
  const backend = new HeadlessBackend(env, { clock: o.clock, app: o.app, scenario: o.scenario, emit: (e) => session.event(e) });
  const mav = o.mavlinkPort !== undefined ? await serveMavlinkPort({ port: o.mavlinkPort, log: o.log }, (b) => backend.mavlinkIn(b)) : null;
  if (mav) backend.onMavlink = (bytes) => mav.send(bytes);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    if (buf.length > API_MAX_MESSAGE && !buf.includes('\n')) process.exit(2);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) void session.receive(l); }
  });
  await new Promise<void>((res) => process.stdin.on('end', () => { backend.close(); res(); }));
  await mav?.close();
}

export interface RelayOptions {
  /** TCP port for programs (default 7878) and WebSocket port for the browser page (default 8765) */
  port?: number;
  wsPort?: number;
  host?: string;
  /** page origins allowed to connect, besides localhost pages and the public site */
  origins?: string[];
  log?: (t: string) => void;
  /** a TCP MAVLink port relayed to the page's ArduPilot (its pass-through port) */
  mavlinkPort?: number;
}

export const DEFAULT_ORIGINS = ['https://fpv-sim-gamma.vercel.app'];
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Relay between programs (TCP) and the live game (one browser tab, WebSocket). Request ids are
 * rewritten so several programs can share the tab; events go to every program.
 */
export async function serveRelay(o: RelayOptions): Promise<{ port: number; wsPort: number; mavlinkPort?: number; close: () => Promise<void> }> {
  const log = o.log ?? (() => {});
  const host = o.host ?? '127.0.0.1';
  const allowed = new Set([...DEFAULT_ORIGINS, ...(o.origins ?? [])]);
  let page: WsPeer | null = null;
  const clients = new Set<Socket>();
  const pending = new Map<number, { socket: Socket; id: number | string | undefined }>();
  let nextId = 1;
  const toClient = (s: Socket, m: unknown, event = false) => writeTo(s, JSON.stringify(m), event);
  const broadcast = (m: unknown) => { for (const c of clients) toClient(c, m, true); };
  /** requests the page will never answer (it left, or another tab took over) */
  const failPending = (why: string) => { for (const [id, p] of pending) { toClient(p.socket, { id: p.id, ok: false, error: why }); pending.delete(id); } };

  // MAVLink: the page streams ArduPilot's pass-through bytes as events once asked; what the MAVLink
  // clients send goes to it as requests whose answers nobody waits for
  const MAV_ID = -1;
  const mavSubscribe = () => page?.send(JSON.stringify({ id: MAV_ID, cmd: 'subscribe', stream: 'mavlink' }));
  const mav = o.mavlinkPort !== undefined
    ? await serveMavlinkPort({ host, port: o.mavlinkPort, log }, (b) => page?.send(JSON.stringify({ id: MAV_ID, cmd: 'mavlink', data: toBase64(b) })), mavSubscribe)
    : null;

  const http = createHttpServer((_req, res) => { res.writeHead(426, { 'Content-Type': 'text/plain' }); res.end('FPV Sim API relay: the simulator page connects here over WebSocket.\n'); });
  attachWebSocket(http, (peer) => {
    if (page) { page.close(4000, 'another simulator tab took over'); failPending('another simulator tab took over'); }
    page = peer;
    log(`simulator page connected (${peer.origin || 'no origin'})`);
    if (mav?.clients) mavSubscribe();
    broadcast({ event: 'log', text: `simulator page connected (${peer.origin || 'no origin'})` });
    peer.onMessage = (text) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(text); } catch { return; }
      if (m.id === MAV_ID) return;
      if (m.event === 'mavlink') { if (mav && typeof m.data === 'string') mav.send(fromBase64(m.data)); return; }
      if (typeof m.id === 'number' && pending.has(m.id)) {
        const p = pending.get(m.id)!; pending.delete(m.id);
        toClient(p.socket, { ...m, id: p.id });
      } else if (typeof m.event === 'string') broadcast(m);
    };
    peer.onClose = () => {
      if (page !== peer) return;
      page = null;
      log('simulator page left');
      failPending('the simulator page closed');
      broadcast({ event: 'bye', reason: 'the simulator page closed' });
    };
  }, {
    maxMessage: 16 << 20, // captures carry images
    // browsers always send their page's origin: only the simulator's own pages get in (a program on
    // this machine, which sends none, is trusted like the TCP clients)
    accept: (req: IncomingMessage) => { const origin = req.headers.origin; return origin === undefined || LOCAL_ORIGIN.test(origin) || allowed.has(origin); },
  });

  const tcp = createTcpServer((socket) => {
    clients.add(socket);
    socket.setNoDelay(true);
    lines(socket, (l) => {
      const p = parseRequest(l);
      if (p.error !== undefined) { toClient(socket, { id: p.id, ok: false, error: p.error }); return; }
      if (!page) { toClient(socket, { id: p.req.id, ok: false, error: `no simulator page connected: open the simulator with ?api=ws://127.0.0.1:${wsPort} in the address` }); return; }
      const id = nextId++;
      pending.set(id, { socket, id: p.req.id });
      page.send(JSON.stringify({ ...p.req, id }));
    }, (why) => refuse(socket, why));
    socket.on('close', () => { clients.delete(socket); for (const [id, p] of pending) if (p.socket === socket) pending.delete(id); });
    socket.on('error', () => {});
  });
  await new Promise<void>((res, rej) => { http.once('error', rej); http.listen(o.wsPort ?? 8765, host, () => res()); });
  await new Promise<void>((res, rej) => { tcp.once('error', rej); tcp.listen(o.port ?? 7878, host, () => res()); });
  const wsPort = (http.address() as { port: number }).port, port = (tcp.address() as { port: number }).port;
  return {
    port, wsPort, mavlinkPort: mav?.port,
    close: async () => {
      await mav?.close();
      page?.close(1001, 'relay stopping');
      for (const c of clients) c.destroy();
      await Promise.all([new Promise((r) => tcp.close(r)), new Promise((r) => { http.closeAllConnections?.(); http.close(r); })]);
    },
  };
}
