// The control API's Node transports (scripts/fpv-api.mjs runs them):
//   serveHeadless  newline-delimited JSON over TCP (one headless simulation per connection) or stdio;
//   serveRelay     the live browser game: the page connects out to a local WebSocket, and programs
//                  talk to it through the same TCP JSON-lines protocol as to a headless simulation.
// Everything binds to the loopback interface unless told otherwise.
import { createServer as createHttpServer, IncomingMessage } from 'node:http';
import { createServer as createTcpServer, Socket } from 'node:net';
import { createNodeEnv } from '../headless/node';
import { HeadlessBackend } from './headlessBackend';
import { API_MAX_MESSAGE, ApiSession, Clock, parseRequest } from './protocol';
import { attachWebSocket, WsPeer } from './wsServer';

/** Split a byte stream into lines; refuses a line over the message limit. */
function lines(onLine: (l: string) => void, onTooLong: () => void) {
  let buf = '';
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    if (buf.length > API_MAX_MESSAGE && !buf.includes('\n')) { buf = ''; onTooLong(); return; }
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (l) onLine(l);
    }
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
}

/** One simulation per TCP connection. Resolves once listening, with the port. */
export async function serveHeadless(o: HeadlessServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const log = o.log ?? (() => {});
  const conns = new Set<Socket>();
  const server = createTcpServer((socket) => {
    conns.add(socket);
    socket.setNoDelay(true);
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`client ${peer} connected`);
    const ready = createNodeEnv().then((env) => {
      const session = new ApiSession({ handle: (r) => backend.handle(r) }, (t) => { if (!socket.destroyed) socket.write(t + '\n'); });
      const backend = new HeadlessBackend(env, { clock: o.clock, app: o.app, scenario: o.scenario, emit: (e) => session.event(e) });
      socket.on('close', () => backend.close());
      return session;
    });
    socket.on('data', lines((l) => { void ready.then((s) => s.receive(l)); }, () => socket.destroy()));
    socket.on('close', () => { conns.delete(socket); log(`client ${peer} left`); });
    socket.on('error', () => {});
  });
  await new Promise<void>((res, rej) => { server.once('error', rej); server.listen(o.port ?? 7878, o.host ?? '127.0.0.1', () => res()); });
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise((res) => { for (const c of conns) c.destroy(); server.close(() => res()); }) };
}

/** One simulation over stdin / stdout (logs go to stderr). */
export async function serveStdio(o: Omit<HeadlessServerOptions, 'host' | 'port'>): Promise<void> {
  const env = await createNodeEnv();
  const out = (t: string) => process.stdout.write(t + '\n');
  const session = new ApiSession({ handle: (r) => backend.handle(r) }, out);
  const backend = new HeadlessBackend(env, { clock: o.clock, app: o.app, scenario: o.scenario, emit: (e) => session.event(e) });
  process.stdin.on('data', lines((l) => void session.receive(l), () => process.exit(2)));
  await new Promise<void>((res) => process.stdin.on('end', () => { backend.close(); res(); }));
}

export interface RelayOptions {
  /** TCP port for programs (default 7878) and WebSocket port for the browser page (default 8765) */
  port?: number;
  wsPort?: number;
  host?: string;
  /** page origins allowed to connect, besides localhost pages and the public site */
  origins?: string[];
  log?: (t: string) => void;
}

export const DEFAULT_ORIGINS = ['https://fpv-sim-gamma.vercel.app'];
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Relay between programs (TCP) and the live game (one browser tab, WebSocket). Request ids are
 * rewritten so several programs can share the tab; events go to every program.
 */
export async function serveRelay(o: RelayOptions): Promise<{ port: number; wsPort: number; close: () => Promise<void> }> {
  const log = o.log ?? (() => {});
  const host = o.host ?? '127.0.0.1';
  const allowed = new Set([...DEFAULT_ORIGINS, ...(o.origins ?? [])]);
  let page: WsPeer | null = null;
  const clients = new Set<Socket>();
  const pending = new Map<number, { socket: Socket; id: number | string | undefined }>();
  let nextId = 1;
  const toClient = (s: Socket, m: unknown) => { if (!s.destroyed) s.write(JSON.stringify(m) + '\n'); };
  const broadcast = (m: unknown) => { for (const c of clients) toClient(c, m); };

  const http = createHttpServer((_req, res) => { res.writeHead(426, { 'Content-Type': 'text/plain' }); res.end('FPV Sim API relay: the simulator page connects here over WebSocket.\n'); });
  attachWebSocket(http, (peer) => {
    if (page) page.close(4000, 'another simulator tab took over');
    page = peer;
    log(`simulator page connected (${peer.origin || 'no origin'})`);
    broadcast({ event: 'log', text: `simulator page connected (${peer.origin || 'no origin'})` });
    peer.onMessage = (text) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(text); } catch { return; }
      if (typeof m.id === 'number' && pending.has(m.id)) {
        const p = pending.get(m.id)!; pending.delete(m.id);
        toClient(p.socket, { ...m, id: p.id });
      } else if (typeof m.event === 'string') broadcast(m);
    };
    peer.onClose = () => {
      if (page !== peer) return;
      page = null;
      log('simulator page left');
      for (const [id, p] of pending) { toClient(p.socket, { id: p.id, ok: false, error: 'the simulator page closed' }); pending.delete(id); }
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
    socket.on('data', lines((l) => {
      const p = parseRequest(l);
      if (p.error !== undefined) { toClient(socket, { id: p.id, ok: false, error: p.error }); return; }
      if (!page) { toClient(socket, { id: p.req.id, ok: false, error: `no simulator page connected: open the simulator with ?api=ws://127.0.0.1:${wsPort} in the address` }); return; }
      const id = nextId++;
      pending.set(id, { socket, id: p.req.id });
      page.send(JSON.stringify({ ...p.req, id }));
    }, () => socket.destroy()));
    socket.on('close', () => { clients.delete(socket); for (const [id, p] of pending) if (p.socket === socket) pending.delete(id); });
    socket.on('error', () => {});
  });
  await new Promise<void>((res, rej) => { http.once('error', rej); http.listen(o.wsPort ?? 8765, host, () => res()); });
  await new Promise<void>((res, rej) => { tcp.once('error', rej); tcp.listen(o.port ?? 7878, host, () => res()); });
  const wsPort = (http.address() as { port: number }).port, port = (tcp.address() as { port: number }).port;
  return {
    port, wsPort,
    close: async () => {
      page?.close(1001, 'relay stopping');
      for (const c of clients) c.destroy();
      await Promise.all([new Promise((r) => tcp.close(r)), new Promise((r) => { http.closeAllConnections?.(); http.close(r); })]);
    },
  };
}
