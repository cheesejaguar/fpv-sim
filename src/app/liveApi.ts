// The control API over the live game: the same commands as the headless simulator (protocol.ts),
// answered by the running app. The simulation runs in real time in its worker; `act` takes over the
// sticks from the pilot's controller (a banner says so and hands them back with one click), state
// comes from the worker's 1 kHz state ring, and a scenario sets up map, drone, conditions, Betaflight
// and a scored task. Reached through a local relay over WebSocket (scripts/fpv-api.mjs --live) or
// window.fpvSim in the page.
import type { OpsEvent } from '../worker/ops';
import { Action, applyAction, AUX, MODE_US, Observation, obsVector, obsVectorLabels, probeDirections, rot, rotInv } from '../api/types';
import { ApiBackend, ApiEvent, ApiSession, API_PROTOCOL, API_VERSION, COMMANDS, Hello, parseRequest, Request } from '../api/protocol';
import { planDiffImport } from '../bf/diffImport';
import { hasMap } from '../maps/maps';
import { parseScenario, resolveEpisode, Episode } from '../scenario/scenario';
import { TaskRunner } from '../scenario/tasks';
import type { V3 } from '../sim/math';
import { el } from '../ui/dom';
import { newestTime, R, REC, sampleRing, Telemetry } from '../worker/shared';
import { LOCAL_WS, type ApiHost, type LiveDeps } from './apiHost';
import { APP_VERSION } from '../ui/menu/about';

export class LiveBackend implements ApiBackend {
  private ws: WebSocket | null = null;
  private session: ApiSession | null = null;
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  /** the channels the program asked for, and what Betaflight is sent (rc: arming adjusts it) */
  private want = new Float32Array(16).fill(1500);
  private rc = new Float32Array(16).fill(1500);
  private banner: HTMLElement | null = null;
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  private taskTimer: ReturnType<typeof setInterval> | null = null;
  private rec = new Float64Array(REC);
  private episode: Episode | null = null;
  private task: TaskRunner | null = null;
  private t0 = 0;
  private lastTaskT = -1;
  private ended = false;
  private probeDirs: V3[] = [];
  private lastImpactT = -1;
  private url = '';
  /** the program wants the quad armed; armTimer flips the switch the way a pilot would (see armHelper) */
  private armWanted = false;
  private armTimer: ReturnType<typeof setInterval> | null = null;
  private armLowUntil = 0;

  constructor(private host: ApiHost, private deps: LiveDeps) {}

  private get ctx() { return this.deps.ctx; }

  // -------------------------------------------------------------------------------------------
  // transports

  /** Connect to a relay (scripts/fpv-api.mjs --live). Resolves once connected. */
  connect(url: string): Promise<{ url: string }> {
    // the sim's controls and state never leave this computer (the relay runs here)
    if (!LOCAL_WS.test(url)) return Promise.reject(new Error(`${url}: only relays on this computer can connect (ws://127.0.0.1:<port> or ws://localhost:<port>)`));
    this.disconnect();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws; this.url = url;
      const session = new ApiSession(this, (t) => { if (ws.readyState === WebSocket.OPEN) ws.send(t); });
      ws.onopen = () => {
        this.session = session;
        this.ctx.log(`Control API connected: ${url}`);
        this.showBanner();
        resolve({ url });
      };
      ws.onmessage = (ev) => { if (typeof ev.data === 'string') void session.receive(ev.data); };
      ws.onerror = () => reject(new Error(`could not connect to ${url}: is the relay running (npm run api -- --live)?`));
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null; this.session = null;
        this.ctx.log(`Control API disconnected (${url})`);
        this.releaseSticks();
        this.stopState();
        this.showBanner();
      };
    });
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null; this.session = null;
    ws?.close();
    this.releaseSticks();
    this.stopState();
    this.showBanner();
  }

  /** In-page calls (window.fpvSim): the same validation and answers as over a connection. */
  async call(cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = parseRequest(JSON.stringify({ ...params, cmd }));
    if (p.error !== undefined) throw new Error(p.error);
    return this.handle(p.req);
  }

  /** In-page event listener; returns an unsubscribe function. */
  listen(event: string, cb: (e: unknown) => void): () => void {
    let s = this.listeners.get(event);
    if (!s) { s = new Set(); this.listeners.set(event, s); }
    s.add(cb);
    return () => { s!.delete(cb); };
  }

  private emit(e: ApiEvent) {
    this.session?.event(e);
    for (const k of [e.event, '*']) for (const cb of this.listeners.get(k) ?? []) { try { cb(e); } catch (err) { console.error(err); } }
  }

  // -------------------------------------------------------------------------------------------
  // events from the app

  onGate(gate: number, t: number) {
    this.emit({ event: 'gate', gate, t: t - this.t0 });
    if (this.task && !this.ended) this.task.onGate(gate, t - this.t0);
  }

  onTelemetry(tel: Telemetry) {
    const imp = tel.impact;
    if (imp && imp.t >= 0 && imp.t !== this.lastImpactT) {
      this.lastImpactT = imp.t;
      this.emit({ event: 'impact', speed: imp.speed, t: imp.t - this.t0 });
      const ep = this.episode;
      if (ep && this.task && !this.ended && ep.endOnCrash && imp.speed >= ep.crashSpeedMs && imp.t >= this.t0) this.endEpisode('crash');
    }
  }

  onLog(text: string) { if (this.session || this.listeners.size) this.emit({ event: 'log', text }); }

  onOps(e: OpsEvent) {
    this.emit({ event: 'ops', ...e });
    if (e.type === 'payload_impact' && this.task && !this.ended) {
      this.task.onPayload(e.pos, e.speed);
      const m = this.task.metrics();
      if (m.success) this.endEpisode('success'); else if (m.missM !== undefined) this.endEpisode('failure');
    }
  }

  onRespawn() { if (this.task && !this.ended) this.endEpisode('respawn'); }

  // -------------------------------------------------------------------------------------------
  // commands

  async handle(req: Request): Promise<Record<string, unknown>> {
    const ctx = this.ctx;
    switch (req.cmd) {
      case 'hello': {
        const h: Hello = {
          protocol: API_PROTOCOL, version: API_VERSION, backend: 'live', clock: 'realtime', app: `fpv-sim ${APP_VERSION}`,
          firmware: ctx.tel?.fw ?? 'loading', commands: COMMANDS.filter((c) => c !== 'step'),
          vectorLabels: obsVectorLabels(this.probeDirs.length),
        };
        return { ...h };
      }
      case 'reset': return this.reset(req.scenario, req.seed, !!req.pilot);
      case 'step': throw new Error('step: the live game runs in real time: use act, state and subscribe (lock-step needs the headless simulator: npm run api)');
      case 'act': this.takeSticks(req.action); return {};
      case 'release': this.releaseSticks(); return {};
      case 'state': { const obs = this.observe(); return { obs, ...(this.task ? { metrics: this.task.metrics() } : {}), ...(req.vector ? { vec: obsVector(obs) } : {}) }; }
      case 'subscribe': {
        const hz = Math.min(req.hz ?? 60, 250);
        this.stopState();
        this.stateTimer = setInterval(() => this.emit({ event: 'state', obs: this.observe() }), 1000 / hz);
        return { hz };
      }
      case 'unsubscribe': this.stopState(); return {};
      case 'cli': {
        if (Atomics.load(ctx.sh.ctrl, 5)) throw new Error('Betaflight ignores the CLI while armed: disarm first');
        return { output: await this.deps.cliBatch(req.lines) };
      }
      case 'respawn': this.deps.respawn(!!req.fullBattery); return {};
      case 'teleport': this.deps.teleport({ x: req.pos[0], y: req.pos[1], z: req.pos[2] }, req.yawDeg ?? 0); return {};
      case 'pause': this.deps.pause(); return {};
      case 'resume': this.deps.fly(); return {};
      case 'metrics': if (!this.task) throw new Error('metrics: no task: reset with a scenario that has one'); return { metrics: this.task.metrics() };
      case 'capture': return (await import('./dataset')).capture(ctx, req);
      case 'record': {
        const ds = await import('./dataset');
        // over the API frames always stream as events (a recording would not fit one message)
        return req.action === 'start' ? ds.startRecording(ctx, { ...req, stream: true }, (e) => this.emit(e as ApiEvent)) : ds.stopRecording(ctx);
      }
      case 'fault': this.deps.injectFaults(req.faults); return {};
      case 'drop': this.deps.dropPayload(); return {};
      case 'ops': this.deps.setOps(req.config ?? null); await this.deps.sync(); return {};
      case 'linkmap': throw new Error('linkmap: a planning tool of the headless simulator (npm run api)');
      case 'bye': setTimeout(() => this.disconnect(), 0); return {};
    }
    throw new Error(`unknown command ${(req as { cmd: string }).cmd}`);
  }

  /** Apply a scenario to the running game, then start its task. */
  private async reset(raw: unknown, seed?: number, pilot = false): Promise<Record<string, unknown>> {
    const ctx = this.ctx;
    let ep: Episode | null = null;
    if (raw !== undefined) {
      const { scenario, errors } = parseScenario(raw, hasMap);
      if (!scenario) throw new Error(`invalid scenario:\n  ${errors.join('\n  ')}`);
      ep = resolveEpisode(scenario, seed);
      // map, course and conditions (the time scale and pause stay the app's), then the drone
      const plan = ep.cli.length ? planDiffImport(ep.cli.join('\n')) : null;
      const spec = plan?.propsOut != null ? { ...ep.spec, propDirection: plan.propsOut ? 'props-out' as const : 'props-in' as const } : ep.spec;
      ep = { ...ep, spec };
      this.deps.applySim({ ...ep.settings, timeScale: ctx.sim.timeScale, paused: false });
      if (JSON.stringify(spec) !== JSON.stringify(ctx.spec)) this.deps.applySpec(spec);
      if (plan) {
        const keepOsd = plan.apply.some((l) => /^set osd_\w+_pos\b/.test(l));
        await this.deps.cliBatch([...plan.apply, ...(await this.deps.hardwareCli(keepOsd, plan.propsOut)), 'save']);
      }
      // the worker has the new drone (its firmware setup and reboot included) before the respawn below
      await this.deps.sync();
      // the renderer follows the map once it has loaded
      const t0 = performance.now();
      while (ctx.map.id !== ep.mapId && performance.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50));
      if (ctx.map.id !== ep.mapId) throw new Error(`map ${ep.mapId} did not load`);
      this.episode = ep;
      this.probeDirs = probeDirections(ep.probes);
    }
    ep ??= this.episode;
    this.deps.fly();
    this.deps.respawn(true);
    // the scenario's operational environment (or none), its clock starting with the episode
    if (raw !== undefined) this.deps.setOps(ep?.ops ?? null);
    if (ep) {
      const st = ep.start, sp = ctx.map.spawn, off = st.offset;
      if (st.pos || off.some((x) => x !== 0) || st.yawOffsetDeg !== 0 || st.yawDeg !== null) {
        const base = st.pos ?? [sp.pos.x, sp.pos.y, sp.pos.z];
        const yaw = (st.yawDeg ?? (sp.yaw * 180) / Math.PI) + st.yawOffsetDeg;
        this.deps.teleport({ x: base[0] + off[0], y: base[1] + off[1], z: Math.max(base[2] + off[2], ctx.map.terrain(base[0] + off[0], base[1] + off[1]) + 0.1) }, yaw);
      }
      // the scenario's switches; arming takes over the sticks (throttle down) until released
      if (!pilot && (st.armed || st.mode !== 'acro')) this.takeSticks({ throttle: 0, roll: 0, pitch: 0, yaw: 0, mode: st.mode, arm: st.armed });
    }
    // the worker has taken the respawn (and the placement): every state from here on is the new episode's
    await this.deps.sync();
    if (ep) {
      this.task = new TaskRunner(ep.task, ctx.map);
      this.t0 = newestTime(ctx.sh);
      this.lastTaskT = -1; this.ended = false;
      if (!this.taskTimer) this.taskTimer = setInterval(() => this.feedTask(), 10);
    }
    return { obs: this.observe(), info: { seed: ep?.seed ?? null, episode: ep, reproducible: false }, vectorLabels: obsVectorLabels(this.probeDirs.length) };
  }

  /** Feed the task the newest state (100 Hz), end the episode on success / timeout / leaving the map. */
  private feedTask() {
    const task = this.task, ep = this.episode, ctx = this.ctx;
    if (!task || !ep || this.ended) return;
    const t = newestTime(ctx.sh);
    if (t <= this.lastTaskT || t <= this.t0 || !sampleRing(ctx.sh, t, this.rec)) return;
    this.lastTaskT = t;
    const r = this.rec;
    const st = task.step({ t: t - this.t0, pos: { x: r[R.px], y: r[R.py], z: r[R.pz] }, vel: { x: r[R.vx], y: r[R.vy], z: r[R.vz] }, w: { x: r[R.wx], y: r[R.wy], z: r[R.wz] }, armed: r[R.armed] > 0.5 });
    const m = ctx.map;
    if (st.success) this.endEpisode('success');
    else if (ep.endOutOfBounds && (Math.abs(r[R.px]) > m.size || Math.abs(r[R.py]) > m.size)) this.endEpisode('out_of_bounds');
    else if (t - this.t0 >= ep.maxSeconds) this.endEpisode('timeout');
  }

  private endEpisode(reason: string) {
    if (!this.task || this.ended) return;
    this.ended = true;
    if (this.taskTimer) clearInterval(this.taskTimer);
    this.taskTimer = null;
    this.emit({ event: 'episode', reason, metrics: this.task.metrics() });
  }

  /** The task in progress (training drills read it for the HUD): metrics, and whether it ended. */
  taskStatus(): { metrics: ReturnType<TaskRunner['metrics']>; ended: boolean; goal: V3 | null } | null {
    return this.task ? { metrics: this.task.metrics(), ended: this.ended, goal: this.task.goal() } : null;
  }

  // -------------------------------------------------------------------------------------------
  // sticks

  private takeSticks(a: Action) {
    const was = !!this.host.rc;
    if (!was) {
      // start from where the pilot's sticks are, switches included
      this.want.set(this.ctx.input.channels.subarray(0, 16));
      const armed = !!Atomics.load(this.ctx.sh.ctrl, 5);
      this.want[AUX.arm] = armed ? 1900 : 1000;
      this.armWanted = armed;
      if (this.want[AUX.mode] < 900) this.want[AUX.mode] = MODE_US.acro;
    }
    if (a.arm !== undefined) this.armWanted = a.arm;
    applyAction(this.want, a);
    this.host.rc = this.rc;
    this.armHelper();
    this.armTimer ??= setInterval(() => this.armHelper(), 50);
    if (!was) { this.emit({ event: 'control', by: 'api' }); this.showBanner(); }
  }

  /**
   * Arming for a program: Betaflight only arms on a switch that goes from off to on while nothing
   * blocks it. After a reboot (a new drone, a saved setting), a switch already on when the boot
   * grace ended latches ARM_SWITCH; a pilot flicks it off and on again, and so does this: while
   * other flags block arming the switch stays off, then it goes on.
   */
  private armHelper() {
    if (!this.host.rc) { if (this.armTimer) clearInterval(this.armTimer); this.armTimer = null; return; }
    const rc = this.rc;
    rc.set(this.want);
    const armed = !!Atomics.load(this.ctx.sh.ctrl, 5);
    if (!this.armWanted || armed) return;
    // arming: throttle down (Betaflight refuses to arm above idle), the switch off while anything
    // else blocks arming, then on
    rc[2] = 1000;
    const flags = (this.ctx.tel?.armingFlagNames ?? []).filter((f) => f !== 'THROTTLE');
    const now = performance.now();
    if (flags.length) { rc[AUX.arm] = 1000; this.armLowUntil = now + 150; return; }
    rc[AUX.arm] = now >= this.armLowUntil ? 1900 : 1000;
  }

  /** The pilot's controller flies again (the arm switch is the pilot's: the quad disarms unless it is on). */
  releaseSticks() {
    this.armWanted = false;
    if (!this.host.rc) return;
    this.host.rc = null;
    this.emit({ event: 'control', by: 'pilot' });
    this.showBanner();
  }

  private stopState() { if (this.stateTimer) clearInterval(this.stateTimer); this.stateTimer = null; }

  // -------------------------------------------------------------------------------------------
  // state

  observe(): Observation {
    const ctx = this.ctx, r = this.rec, tel = ctx.tel;
    sampleRing(ctx.sh, newestTime(ctx.sh), r);
    const q = { w: r[R.qw], x: r[R.qx], y: r[R.qy], z: r[R.qz] };
    const pos = { x: r[R.px], y: r[R.py], z: r[R.pz] };
    const roll = Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
    const pitch = -Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.y - q.z * q.x))));
    const yaw = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
    const goal = this.task && !this.ended ? this.task.goal() : null;
    let goalBody: [number, number, number] | null = null;
    if (goal) { const b = rotInv(q, { x: goal.x - pos.x, y: goal.y - pos.y, z: goal.z - pos.z }); goalBody = [b.x, b.y, b.z]; }
    const range = this.episode?.probeRangeM ?? 20;
    const probes = this.probeDirs.map((d) => Math.min(range, ctx.world.raycast(pos, rot(q, d), range)));
    const cells = Math.max(1, Math.round(r[R.vbus] / Math.max(0.1, r[R.cellV])));
    // the newest impact, while it is recent (every observer sees it: nothing is consumed)
    const imp = tel?.impact, impact = imp && imp.t >= 0 && r[R.t] - imp.t < 0.25 ? imp.speed : 0;
    return {
      t: r[R.t] - this.t0,
      pos: [pos.x, pos.y, pos.z], vel: [r[R.vx], r[R.vy], r[R.vz]],
      quat: [q.w, q.x, q.y, q.z], euler: [roll, pitch, yaw],
      rates: [r[R.wx], r[R.wy], r[R.wz]], gyro: [r[R.gx], r[R.gy], r[R.gz]], acc: null,
      motorRpm: [r[R.rpm0], r[R.rpm1], r[R.rpm2], r[R.rpm3]], motorCmd: [r[R.m0], r[R.m1], r[R.m2], r[R.m3]],
      rc: [r[R.rc0], r[R.rc1], r[R.rc2], r[R.rc3]],
      battery: { v: r[R.vbus], i: r[R.ibus], soc: r[R.soc], mah: r[R.mah], cellV: r[R.vbus] / cells },
      armed: r[R.armed] > 0.5, armingFlags: tel?.armingFlagNames ?? [],
      agl: pos.z - ctx.map.terrain(pos.x, pos.y),
      goal: goal ? [goal.x, goal.y, goal.z] : null, goalBody, probes,
      gate: { next: ctx.race.nextGate, total: ctx.map.gates.length },
      impact, damage: r[R.damage],
    };
  }

  // -------------------------------------------------------------------------------------------
  // banner: who flies, and the way back

  private showBanner() {
    const connected = !!this.session, flying = !!this.host.rc;
    if (!connected && !flying) { this.banner?.remove(); this.banner = null; return; }
    if (!this.banner) {
      this.banner = el('div', { class: 'api-banner', role: 'status', 'aria-live': 'polite' });
      document.body.append(this.banner);
    }
    const take = el('button', { type: 'button', onclick: () => this.releaseSticks() }, 'Take the controls back');
    const close = el('button', { type: 'button', onclick: () => this.disconnect() }, 'Disconnect');
    this.banner.replaceChildren(...[
      el('span', { class: 'api-dot' + (flying ? ' api-flying' : '') }),
      el('span', {}, flying ? 'A program is flying (control API)' : `Control API connected${this.url ? ` · ${this.url}` : ''}`),
      flying ? take : null,
      connected ? close : null,
    ].filter((x): x is HTMLElement => !!x));
  }
}
