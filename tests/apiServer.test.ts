// The control API: message validation, the headless server over TCP in lock-step and real time,
// and the live relay between programs and a browser page (a WebSocket client stands in for it).
import { existsSync } from 'node:fs';
import { createConnection, Socket } from 'node:net';
import { afterAll, describe, expect, test } from 'vitest';
import { serveHeadless, serveRelay } from '../src/api/nodeServer';
import { ApiSession, checkAction, parseRequest } from '../src/api/protocol';
import { wsFrame } from '../src/api/wsServer';

const have = existsSync(new URL('../public/bf/betaflight.mjs', import.meta.url));

/** A JSON-lines client: call(cmd, params) -> reply; events collected. */
function client(port: number) {
  const s: Socket = createConnection(port, '127.0.0.1');
  let buf = '', id = 0;
  const waiting = new Map<number, (m: any) => void>();
  const events: any[] = [];
  s.on('data', (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const k = m.id ?? ('ok' in m ? -1 : undefined); // (a reply to a message too broken to carry an id has none)
      if (k !== undefined && waiting.has(k)) { waiting.get(k)!(m); waiting.delete(k); } else events.push(m);
    }
  });
  const call = (cmd: string, p: Record<string, unknown> = {}) => new Promise<any>((res) => { const k = ++id; waiting.set(k, res); s.write(JSON.stringify({ id: k, cmd, ...p }) + '\n'); });
  const raw = (line: string) => new Promise<any>((res) => { const k = -1; waiting.set(k, res); s.write(line + '\n'); });
  return { call, raw, events, close: () => s.destroy(), ready: new Promise<void>((r) => s.once('connect', () => r())) };
}

describe('protocol', () => {
  test('requests are validated before any backend sees them', () => {
    expect(parseRequest('{').error).toBe('not JSON');
    expect(parseRequest('[1]').error).toMatch(/object/);
    expect(parseRequest('{"id":3,"cmd":"fly"}')).toMatchObject({ id: 3, error: expect.stringMatching(/unknown command "fly"/) });
    expect(parseRequest('{"cmd":"act","action":{"throttle":"x"}}').error).toMatch(/action.throttle/);
    expect(parseRequest('{"cmd":"act","action":{"warp":1}}').error).toMatch(/action.warp: unknown key/);
    expect(parseRequest('{"cmd":"step","steps":0}').error).toMatch(/steps/);
    expect(parseRequest('{"cmd":"teleport","pos":[1,2]}').error).toMatch(/pos/);
    expect(parseRequest('{"cmd":"cli","lines":"get x"}').error).toMatch(/lines/);
    expect(parseRequest('{"cmd":"reset","seed":-1}').error).toMatch(/seed/);
    expect(parseRequest('{"cmd":"act","action":{"roll":0.2,"arm":true,"mode":"angle","rc":[1500,1500]}}').req).toBeDefined();
    expect(checkAction({ mode: 'sport' })[0]).toMatch(/mode/);
  });

  test('a session answers in order, with the request id, errors included', async () => {
    const out: any[] = [];
    const s = new ApiSession({ handle: async (r) => { if (r.cmd === 'bye') throw new Error('nope'); await new Promise((x) => setTimeout(x, r.cmd === 'hello' ? 20 : 0)); return { cmd: r.cmd }; } }, (t) => out.push(JSON.parse(t)));
    void s.receive('{"id":1,"cmd":"hello"}'); void s.receive('{"id":2,"cmd":"state"}'); await s.receive('{"id":"x","cmd":"bye"}');
    expect(out).toEqual([{ id: 1, ok: true, cmd: 'hello' }, { id: 2, ok: true, cmd: 'state' }, { id: 'x', ok: false, error: 'nope' }]);
  });

  test('WebSocket frames: lengths up to 64 KiB and beyond', () => {
    expect(Array.from(wsFrame(1, new Uint8Array(5)).subarray(0, 2))).toEqual([0x81, 5]);
    expect(Array.from(wsFrame(1, new Uint8Array(300)).subarray(0, 4))).toEqual([0x81, 126, 1, 44]);
    expect(Array.from(wsFrame(1, new Uint8Array(70000)).subarray(0, 10))).toEqual([0x81, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]);
  });
});

describe.skipIf(!have)('headless server over TCP', () => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => { for (const c of closers) await c(); });

  test('lock-step: hello, reset with a scenario, steps, state, CLI and refusals', async () => {
    const srv = await serveHeadless({ clock: 'lockstep', app: 'test', port: 0 });
    closers.push(srv.close);
    const c = client(srv.port); await c.ready;
    const hello = await c.call('hello');
    expect(hello).toMatchObject({ ok: true, protocol: 'fpvsim-api', version: 1, backend: 'headless', clock: 'lockstep' });
    expect(hello.commands).toContain('step');
    expect(hello.commands).not.toContain('capture');
    expect((await c.call('step')).error).toMatch(/reset first/);
    const r = await c.call('reset', { scenario: { format: 'fpvsim-scenario', version: 1, map: { id: 'gym' }, drone: { preset: 'Beginner: 65 mm Tiny Whoop 1S' }, start: { armed: true, mode: 'angle' }, task: { type: 'hover', heightM: 1 } }, seed: 3 });
    expect(r.ok).toBe(true);
    expect(r.obs.armed).toBe(true);
    expect(r.info.seed).toBe(3);
    expect(r.vectorLabels.length).toBeGreaterThan(20);
    let s: any;
    for (let i = 0; i < 100; i++) s = await c.call('step', { action: { throttle: r.info.drone.hoverThrottle + 0.1 } });
    expect(s.obs.agl).toBeGreaterThan(0.3);
    const multi = await c.call('step', { steps: 10, vector: true });
    expect(multi.vec).toHaveLength(r.vectorLabels.length);
    expect(multi.obs.t).toBeCloseTo(s.obs.t + 0.1, 6);
    expect((await c.call('state')).metrics.type).toBe('hover');
    expect((await c.call('cli', { lines: ['get roll_srate'] })).error).toMatch(/disarm/);
    expect((await c.call('subscribe', { stream: 'state' })).error).toMatch(/lock-step/);
    expect((await c.call('capture')).error).toMatch(/renderer/);
    expect((await c.call('release')).error).toMatch(/live game/);
    const tp = await c.call('teleport', { pos: [0, 0, 2], yawDeg: 90 });
    expect(tp.obs.pos[2]).toBeCloseTo(2, 6);
    expect((await c.raw('{"cmd":')).error).toBe('not JSON');
    c.close();
  }, 120000);

  test('real time: the clock runs by itself, act steers, state streams at the subscribed rate', async () => {
    const srv = await serveHeadless({ clock: 'realtime', app: 'test', port: 0 });
    closers.push(srv.close);
    const c = client(srv.port); await c.ready;
    expect((await c.call('hello')).commands).not.toContain('step');
    const r = await c.call('reset', { scenario: { format: 'fpvsim-scenario', version: 1, map: { id: 'gym' }, drone: { preset: 'Beginner: 65 mm Tiny Whoop 1S' }, start: { armed: true, mode: 'angle' } } });
    expect(r.ok).toBe(true);
    expect((await c.call('step')).error).toMatch(/real time/);
    expect((await c.call('subscribe', { stream: 'state', hz: 50 })).hz).toBe(50);
    await c.call('act', { action: { throttle: r.info.drone.hoverThrottle + 0.15 } });
    const t0 = Date.now();
    await new Promise((res) => setTimeout(res, 1500));
    const states = c.events.filter((e) => e.event === 'state');
    // ~50 Hz for 1.5 s of wall time (generous bounds: the machine may be busy)
    expect(states.length).toBeGreaterThan(20);
    expect(states.length).toBeLessThan(110);
    const last = states[states.length - 1].obs;
    expect(last.t).toBeGreaterThan(0.8);
    expect(last.t).toBeLessThan((Date.now() - t0) / 1000 + 0.5);
    expect(last.agl).toBeGreaterThan(0.2); // it climbed
    expect((await c.call('pause')).ok).toBe(true);
    const tp = (await c.call('state')).obs.t;
    await new Promise((res) => setTimeout(res, 300));
    expect((await c.call('state')).obs.t).toBeCloseTo(tp, 3);
    await c.call('resume');
    c.close();
  }, 120000);
});

describe('live relay', () => {
  test('programs reach the page through it; ids are kept; events go to every program; no page, no service', async () => {
    const relay = await serveRelay({ port: 0, wsPort: 0 });
    try {
      const a = client(relay.port), b = client(relay.port);
      await Promise.all([a.ready, b.ready]);
      expect((await a.call('hello')).error).toMatch(/no simulator page connected/);
      // a stand-in for the browser page: answers every request, sends an event
      const page = new WebSocket(`ws://127.0.0.1:${relay.wsPort}`);
      await new Promise((res, rej) => { page.onopen = res; page.onerror = rej; });
      page.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        page.send(JSON.stringify({ id: m.id, ok: true, echo: m.cmd, n: m.lines?.length }));
        if (m.cmd === 'act') page.send(JSON.stringify({ event: 'control', by: 'api' }));
      };
      await new Promise((res) => setTimeout(res, 50));
      const [ra, rb] = await Promise.all([a.call('hello'), b.call('cli', { lines: ['a', 'b'] })]);
      expect(ra).toMatchObject({ id: 2, ok: true, echo: 'hello' }); // (a's first call was refused above)
      expect(rb).toMatchObject({ id: 1, ok: true, echo: 'cli', n: 2 });
      await a.call('act', { action: { throttle: 0.5 } });
      await new Promise((res) => setTimeout(res, 50));
      expect(b.events.some((e) => e.event === 'control')).toBe(true);
      expect(a.events.some((e) => e.event === 'control')).toBe(true);
      // invalid requests never reach the page
      expect((await a.call('act', { action: { throttle: 'max' } })).error).toMatch(/throttle/);
      page.close();
      await new Promise((res) => setTimeout(res, 100));
      expect(a.events.some((e) => e.event === 'bye')).toBe(true);
      a.close(); b.close();
    } finally { await relay.close(); }
  });

  test('a browser POST to the TCP port never runs as commands; a tab taking over fails what the old one owed', async () => {
    const relay = await serveRelay({ port: 0, wsPort: 0 });
    try {
      const seen: string[] = [];
      const page = new WebSocket(`ws://127.0.0.1:${relay.wsPort}`);
      await new Promise((res, rej) => { page.onopen = res; page.onerror = rej; });
      page.onmessage = (ev) => { seen.push(JSON.parse(String(ev.data)).cmd); };
      // what fetch('http://127.0.0.1:7878/', { method: 'POST', mode: 'no-cors', body }) sends
      const reply = await new Promise<string>((res) => {
        const s = createConnection(relay.port, '127.0.0.1', () => {
          s.write('POST / HTTP/1.1\r\nHost: 127.0.0.1:7878\r\nContent-Type: text/plain\r\n\r\n\n{"cmd":"cli","lines":["defaults"]}\n');
        });
        let out = ''; s.on('data', (d) => { out += d; }); s.on('close', () => res(out));
      });
      expect(reply).toMatch(/HTTP is not spoken here/);
      await new Promise((res) => setTimeout(res, 100));
      expect(seen).toEqual([]);
      // a request owed by a tab that is replaced fails at once instead of hanging
      const c = client(relay.port); await c.ready;
      page.onmessage = () => { /* this tab never answers */ };
      const owed = c.call('state');
      await new Promise((res) => setTimeout(res, 50));
      const page2 = new WebSocket(`ws://127.0.0.1:${relay.wsPort}`);
      await new Promise((res, rej) => { page2.onopen = res; page2.onerror = rej; });
      expect((await owed).error).toMatch(/another simulator tab took over/);
      page2.close(); c.close();
    } finally { await relay.close(); }
  });

  test('pages from other sites are refused', async () => {
    const relay = await serveRelay({ port: 0, wsPort: 0 });
    try {
      const status = await new Promise<string>((res) => {
        const s = createConnection(relay.wsPort, '127.0.0.1', () => {
          s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://evil.example\r\n\r\n`);
        });
        s.once('data', (d) => { res(d.toString().split('\r\n')[0]); s.destroy(); });
      });
      expect(status).toMatch(/403/);
    } finally { await relay.close(); }
  });
});
