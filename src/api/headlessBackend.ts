// The control API over the headless environment. Lock-step: the client steps the simulation and
// gets each step's result back. Real time: the simulation runs on the wall clock (as the browser's
// worker does), the client's `act` sets the sticks whenever it arrives, and state streams out at the
// rate it subscribes to; a game engine draws the world from it.
import { Action, FpvEnv, obsVector, obsVectorLabels } from '../headless/env';
import { ApiBackend, ApiEvent, API_PROTOCOL, API_VERSION, Clock, COMMANDS, Hello, Request } from './protocol';

export interface HeadlessBackendOptions {
  clock: Clock;
  emit: (e: ApiEvent) => void;
  app: string;
  /** a scenario applied by the first reset that doesn't bring its own */
  scenario?: unknown;
  /** wall clock (ms), for tests */
  now?: () => number;
}

/** Real time: at most this much sim time per tick (s) before the clock is resynchronized (behind). */
const MAX_TICK_S = 0.03;

export class HeadlessBackend implements ApiBackend {
  private action: Action = {};
  private stateHz = 0;
  private stateDue = 0;
  private running = false;
  private paused = false;
  private wallStart = 0; private simAtWallStart = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private resetting = false;
  private episodeReported = false;
  private now: () => number;
  private closed = false;

  constructor(private env: FpvEnv, private opts: HeadlessBackendOptions) {
    this.now = opts.now ?? (() => performance.now());
    env.onLog = (text) => opts.emit({ event: 'log', text });
  }

  private get realtime() { return this.opts.clock === 'realtime'; }

  async handle(req: Request): Promise<Record<string, unknown>> {
    const env = this.env;
    const ready = () => { if (!env.core) throw new Error('no episode yet: send reset first'); };
    switch (req.cmd) {
      case 'hello': {
        const h: Hello = {
          protocol: API_PROTOCOL, version: API_VERSION, backend: 'headless', clock: this.opts.clock, app: this.opts.app,
          firmware: env.core?.bf?.version ?? 'Betaflight 4.5.5 (WASM)',
          commands: COMMANDS.filter((c) => c !== 'capture' && c !== 'record' && c !== 'release' && (this.realtime ? c !== 'step' : c !== 'pause' && c !== 'resume')),
          vectorLabels: env.episode ? obsVectorLabels(env.episode.probes) : undefined,
        };
        return { ...h };
      }
      case 'reset': {
        this.resetting = true;
        try {
          const r = await env.reset({ scenario: req.scenario ?? (env.scenario ? undefined : this.opts.scenario), seed: req.seed });
          this.action = {};
          this.episodeReported = false;
          if (this.realtime) this.startClock();
          return { obs: r.obs, info: r.info, vectorLabels: obsVectorLabels(r.info.episode.probes) };
        } finally { this.resetting = false; }
      }
      case 'step': {
        ready();
        if (this.realtime) throw new Error('step: the simulation runs in real time here: use act, state and subscribe (or start the server without --realtime)');
        let res = env.step(req.action ?? this.action);
        if (req.action) this.action = { ...req.action };
        let reward = res.reward;
        const events = [...res.info.events];
        for (let k = 1; k < (req.steps ?? 1) && !res.terminated && !res.truncated; k++) {
          res = env.step(this.action);
          reward += res.reward; events.push(...res.info.events);
        }
        return { ...res, reward, info: { ...res.info, events }, ...(req.vector ? { vec: obsVector(res.obs) } : {}) };
      }
      case 'act': {
        ready();
        this.action = { ...req.action };
        env.setAction(req.action);
        return {};
      }
      case 'release': throw new Error('release: only the live game has a pilot to hand the sticks back to');
      case 'state': {
        ready();
        const obs = env.observe();
        return { obs, metrics: env.metrics(), ...(req.vector ? { vec: obsVector(obs) } : {}) };
      }
      case 'subscribe': {
        if (!this.realtime) throw new Error('subscribe: in lock-step every step returns the state');
        this.stateHz = req.hz ?? 60; this.stateDue = 0;
        return { hz: this.stateHz };
      }
      case 'unsubscribe': this.stateHz = 0; return {};
      case 'cli': ready(); return { output: env.cli(req.lines) };
      case 'respawn': {
        ready();
        env.core.quad.repair();
        if (req.fullBattery) env.core.buildQuad(); else env.core.respawn();
        this.resync();
        return { obs: env.observe() };
      }
      case 'teleport': {
        ready();
        env.core.placeAt({ x: req.pos[0], y: req.pos[1], z: req.pos[2] }, ((req.yawDeg ?? 0) * Math.PI) / 180);
        this.resync();
        return { obs: env.observe() };
      }
      case 'pause': if (!this.realtime) throw new Error('pause: lock-step only moves when stepped'); this.paused = true; return {};
      case 'resume': if (!this.realtime) throw new Error('resume: lock-step only moves when stepped'); this.paused = false; this.resync(); return {};
      case 'metrics': ready(); return { metrics: env.metrics() };
      case 'capture': case 'record': throw new Error(`${req.cmd}: needs the live game's renderer (headless has no camera)`);
      case 'fault': ready(); env.injectFaults(req.faults); return {};
      case 'drop': ready(); if (!env.release()) throw new Error('drop: no payload on board (scenario ops.payload)'); return {};
      case 'ops': ready(); env.applyOps(req.config ?? null); return { status: env.core.ops ? env.core.ops.status(env.core) : null };
      case 'linkmap': ready(); return { map: env.linkMap(req) };
      case 'bye': this.close(); return {};
    }
    throw new Error(`unknown command ${(req as { cmd: string }).cmd}`);
  }

  close() {
    this.closed = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.env.onLog = null;
  }

  // ---------------------------------------------------------------------------------------------
  // real-time clock

  private resync() { this.wallStart = this.now(); this.simAtWallStart = this.env.core?.simT ?? 0; }

  private startClock() {
    if (this.closed) return; // the client left while the reset was still booting
    this.resync();
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      let delay = 1;
      try { delay = this.tick(); } catch (e) { this.opts.emit({ event: 'log', text: `simulation stopped: ${(e as Error).message}` }); this.running = false; return; }
      this.timer = setTimeout(loop, delay);
    };
    this.timer = setTimeout(loop, 0);
  }

  /** Simulate what the wall clock allows; returns the delay until the next tick (ms). */
  tick(): number {
    const env = this.env, core = env.core;
    if (!core || this.paused || this.resetting || this.closed) { this.resync(); return 5; }
    const dt = 1 / core.settings.physicsHz;
    const target = this.simAtWallStart + (this.now() - this.wallStart) / 1000;
    let n = Math.floor((target - core.simT) / dt + 1e-9);
    const max = Math.floor(MAX_TICK_S / dt);
    if (n > max) { n = max; this.resync(); }
    if (n > 0) {
      const res = env.step(this.action, n);
      for (const e of res.info.events) {
        if (e.type === 'gate') this.opts.emit({ event: 'gate', gate: e.gate, t: e.t });
        else if (e.type === 'impact') this.opts.emit({ event: 'impact', speed: e.speed, t: e.t });
        else if (e.type !== 'log') this.opts.emit({ event: 'ops', ...e });
      }
      if ((res.terminated || res.truncated) && !this.episodeReported) {
        this.episodeReported = true;
        this.opts.emit({ event: 'episode', reason: res.info.reason ?? 'end', metrics: res.info.metrics });
      }
      if (this.stateHz > 0) {
        const wall = this.now();
        if (wall >= this.stateDue) {
          this.stateDue = Math.max(this.stateDue + 1000 / this.stateHz, wall - 1000 / this.stateHz);
          this.opts.emit({ event: 'state', obs: res.obs });
        }
      }
    }
    return 1;
  }
}
