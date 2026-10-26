// A minimal WebSocket server (RFC 6455) on a Node http server: text messages, fragmentation,
// ping / pong and close. Enough for the browser game to connect out to the local API relay without
// adding a dependency. Server frames are never masked; client frames must be.
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsPeer {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage: (text: string) => void;
  onClose: () => void;
  /** the page's origin (Origin header) */
  readonly origin: string;
}

/** Encode one unmasked server frame. */
export function wsFrame(opcode: number, payload: Uint8Array): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0]), Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]);
  return Buffer.concat([head, payload]);
}

/**
 * Accept WebSocket upgrades on `server`. `accept(req)` decides from the request (origin, path)
 * whether to let the peer in; maxMessage caps one message's size (bytes).
 */
export function attachWebSocket(server: Server, onPeer: (p: WsPeer) => void, opts: { accept?: (req: IncomingMessage) => boolean; maxMessage?: number } = {}): void {
  const maxMessage = opts.maxMessage ?? 1 << 20;
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || (opts.accept && !opts.accept(req))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    let frag: Buffer[] = [], fragLen = 0, closed = false;
    const peer: WsPeer = {
      origin: String(req.headers.origin ?? ''),
      send: (text) => { if (!closed) socket.write(wsFrame(1, Buffer.from(text, 'utf8'))); },
      close: (code = 1000, reason = '') => {
        if (closed) return;
        closed = true;
        const r = Buffer.from(reason, 'utf8');
        socket.end(wsFrame(8, Buffer.concat([Buffer.from([code >> 8, code & 255]), r])));
      },
      onMessage: () => {},
      onClose: () => {},
    };
    const fail = (code: number) => { peer.close(code); socket.destroy(); };
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; const hi = buf.readUInt32BE(2); len = buf.readUInt32BE(6); if (hi) { fail(1009); return; } off = 10; }
        if (!masked) { fail(1002); return; } // RFC 6455 5.1: a client must mask
        if (len > maxMessage || fragLen + len > maxMessage) { fail(1009); return; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { peer.close(); return; }
        if (op === 9) { if (!closed) socket.write(wsFrame(10, data)); continue; }
        if (op === 10) continue;
        if (op === 1 || op === 0) {
          frag.push(data); fragLen += data.length;
          if (fin) { const text = Buffer.concat(frag).toString('utf8'); frag = []; fragLen = 0; peer.onMessage(text); }
          continue;
        }
        if (op === 2) { fail(1003); return; } // binary: not part of this protocol
      }
    });
    socket.on('close', () => { closed = true; peer.onClose(); });
    socket.on('error', () => { closed = true; });
    onPeer(peer);
  });
}
