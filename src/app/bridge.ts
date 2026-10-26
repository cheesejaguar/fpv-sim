// The sim worker (Betaflight WASM + physics) and the message plumbing to it: plain messages, CLI
// output listeners, request/response CLI batches and blackbox downloads. If the worker dies (an
// uncaught error inside it, a failed script load, an undecodable message) it is restarted once from
// the remembered init + latest spec / settings / local maps, continuing the shared ring's timeline;
// a second failure is surfaced as { type: 'fatal' }.
import { createShared, newestTime, writeStick, type FromWorker, type Shared, type ToWorker } from '../worker/shared';

/** Stops the stick poller; wake() returns it to the full rate at once (see WorkerBridge.pollSticks). */
export type StickPoller = (() => void) & { wake(): void };

export interface BfBridge {
  cliBatch(lines: string[]): Promise<string>;
  cliSend(text: string): void;
  /** Subscribe to CLI output; returns an unsubscribe function. */
  onCliOut(cb: (t: string) => void): () => void;
}

type InitMsg = Extract<ToWorker, { type: 'init' }>;
type MapMsg = Extract<ToWorker, { type: 'registerMap' }>;

// Vite only bundles a worker written exactly as `new Worker(new URL(..., import.meta.url))`, so a
// restart can't add a cache-busting query; the script itself is content-hashed in builds anyway.
const spawnWorker = () => new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });

export class WorkerBridge implements BfBridge {
  worker: Worker;
  private cliListeners = new Set<(t: string) => void>();
  private batchWaiters = new Map<number, (s: string) => void>();
  private bblWaiters = new Map<number, (m: { data: ArrayBuffer; sessions: number }) => void>();
  private runWaiters = new Map<number, (m: { data: ArrayBuffer; seconds: number; reason: string }) => void>();
  private batchId = 1;
  private init: InitMsg | null = null;
  private maps = new Map<string, MapMsg>();
  private restarts = 0;
  private failed = false;
  /** Everything else the worker says (ready, telemetry, gates, spectrum …). */
  onMessage: (m: FromWorker) => void = () => {};

  constructor(private maxRestarts = 1, private spawn: () => Worker = spawnWorker) {
    this.worker = this.attach(spawn());
  }

  private attach(w: Worker): Worker {
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      if (w !== this.worker) return; // a replaced worker's last words
      const m = e.data;
      if (m.type === 'cliOut') { for (const l of this.cliListeners) l(m.text); return; }
      if (m.type === 'cliBatchDone') { this.batchWaiters.get(m.id)?.(m.output); this.batchWaiters.delete(m.id); return; }
      if (m.type === 'bbl') { this.bblWaiters.get(m.id)?.({ data: m.data, sessions: m.sessions }); this.bblWaiters.delete(m.id); return; }
      if (m.type === 'run') { this.runWaiters.get(m.id)?.({ data: m.data, seconds: m.seconds, reason: m.reason }); this.runWaiters.delete(m.id); return; }
      if (m.type === 'fatal') { this.died(m.reason); return; }
      this.onMessage(m);
    };
    w.onerror = (e: ErrorEvent) => { e.preventDefault?.(); if (w === this.worker) this.died(e.message || 'the simulator worker failed to load'); };
    w.onmessageerror = () => { if (w === this.worker) this.died('a message from the simulator could not be read'); };
    return w;
  }

  private died(reason: string) {
    if (this.failed) return;
    this.worker.terminate();
    // nobody will answer the old worker's requests
    for (const r of this.batchWaiters.values()) r('');
    for (const r of this.bblWaiters.values()) r({ data: new ArrayBuffer(0), sessions: 0 });
    for (const r of this.runWaiters.values()) r({ data: new ArrayBuffer(0), seconds: 0, reason: 'the simulator stopped' });
    this.batchWaiters.clear(); this.bblWaiters.clear(); this.runWaiters.clear();
    if (this.restarts >= this.maxRestarts || !this.init) {
      this.failed = true;
      this.onMessage({ type: 'fatal', reason });
      return;
    }
    this.restarts++;
    this.onMessage({ type: 'log', text: `The simulator stopped (${reason}); restarting it` });
    this.worker = this.attach(this.spawn());
    const t0 = newestTime(createShared(this.init.sab));
    this.worker.postMessage({ ...this.init, t0: t0 > 0 ? t0 + 0.001 : undefined } satisfies InitMsg);
    for (const m of this.maps.values()) this.worker.postMessage(m);
  }

  send = (m: ToWorker) => {
    // remember what a restarted worker needs to get back to the same state
    if (m.type === 'init') this.init = m;
    else if (this.init && m.type === 'spec') this.init = { ...this.init, spec: m.spec };
    else if (this.init && m.type === 'settings') this.init = { ...this.init, settings: m.settings };
    else if (m.type === 'registerMap') this.maps.set(m.id, m);
    if (!this.failed) this.worker.postMessage(m);
  };
  cliBatch = (lines: string[]) => new Promise<string>((res) => {
    if (this.failed) { res(''); return; }
    const id = this.batchId++; this.batchWaiters.set(id, res); this.send({ type: 'cliBatch', lines, id });
  });
  cliSend = (text: string) => this.send({ type: 'cli', text });
  onCliOut = (cb: (t: string) => void) => { this.cliListeners.add(cb); return () => { this.cliListeners.delete(cb); }; };
  /** Betaflight's native blackbox log (.bbl) recorded so far, one log per armed session. */
  getBbl = () => new Promise<{ data: ArrayBuffer; sessions: number }>((res) => {
    if (this.failed) { res({ data: new ArrayBuffer(0), sessions: 0 }); return; }
    const id = this.batchId++; this.bblWaiters.set(id, res); this.send({ type: 'getBbl', id });
  });
  clearBbl = () => this.send({ type: 'clearBbl' });
  /** Begin a reproducible run (the worker reboots Betaflight and records every RC packet). */
  runStart = (seed: number) => this.send({ type: 'runStart', seed: seed >>> 0 });
  /** Stop the run (or fetch the last one) as a .fpvrun file; empty data: there was none. */
  runStop = () => new Promise<{ data: ArrayBuffer; seconds: number; reason: string }>((res) => {
    if (this.failed) { res({ data: new ArrayBuffer(0), seconds: 0, reason: 'the simulator stopped' }); return; }
    const id = this.batchId++; this.runWaiters.set(id, res); this.send({ type: 'runStop', id });
  });

  /**
   * Poll the sticks at ~0.5-1 kHz and hand every sample to the worker with the time it was taken:
   * the Gamepad's own timestamp when it has one (when the browser received that report), else now.
   * The worker gives each RC packet the newest sample a fixed latency older than the packet, so the
   * FC sees evenly aged stick data instead of a 4 ms poll beating against the 250 Hz link.
   * setTimeout(1) chained to itself is clamped to 4 ms after five levels of nesting; a MessageChannel
   * hop between the timeouts resets the nesting, so this ticks at ~1-2 ms without spinning.
   * (Measured in headless Edge on the running sim: ~500-800 polls/s vs 243 for setInterval(4); a
   * Windows timer can't go finer without spinning, Atomics.waitAsync timeouts included.)
   *
   * opts.slow: while it says so (a menu is open and the simulation paused) the poll runs every
   * opts.slowMs (8 ms, ~125 Hz: menu buttons and the Controller tab's live view) instead of ~1 kHz.
   * The returned stop function carries wake(): call it when the controls are handed back, so the
   * full rate resumes at once instead of after the pending slow tick.
   */
  static pollSticks(sh: Shared, poll: () => Float32Array, pad: () => { timestamp?: number } | null, opts: { slow?: () => boolean; slowMs?: number } = {}): StickPoller {
    const mc = new MessageChannel();
    const slow = opts.slow ?? (() => false), slowMs = opts.slowMs ?? 8;
    let on = true, slowTimer: ReturnType<typeof setTimeout> | undefined;
    const sample = () => {
      const ch = poll();
      sh.rc.set(ch); Atomics.add(sh.ctrl, 0, 1);
      const now = performance.now(), ts = pad()?.timestamp;
      // a pad timestamp is "when its data last changed": never from the future, never older than 100 ms
      const t = ts && ts > now - 100 && ts <= now ? ts : now;
      writeStick(sh, performance.timeOrigin + t, ch);
    };
    const post = () => mc.port2.postMessage(0);
    const fireSlow = () => { slowTimer = undefined; post(); };
    mc.port1.onmessage = () => {
      if (!on) return;
      try { sample(); } finally {
        // a throwing pad must not stop the input
        let s = false;
        try { s = slow(); } catch { /* full rate */ }
        if (s) slowTimer = setTimeout(fireSlow, slowMs); else setTimeout(post, 1);
      }
    };
    post();
    const stop = () => { on = false; clearTimeout(slowTimer); slowTimer = undefined; mc.port1.close(); };
    // only a pending slow tick is cut short (one chain of polls at a time, never two)
    const wake = () => { if (on && slowTimer !== undefined) { clearTimeout(slowTimer); slowTimer = undefined; post(); } };
    return Object.assign(stop, { wake });
  }
}
