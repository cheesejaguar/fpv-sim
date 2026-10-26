// The control API's foothold in the page: the sticks an API client flies with, the events main.ts
// forwards, window.fpvSim, and connecting to a local relay (?api=ws://127.0.0.1:8765). The live
// backend itself (src/app/liveApi.ts) loads the first time any of it is used.
import type { DroneSpec } from '../builder/derive';
import type { V3 } from '../sim/math';
import type { SimSettings, Telemetry } from '../worker/shared';
import type { AppCtx } from './context';
import type { LiveBackend } from './liveApi';

/** What the live backend may do to the app (main.ts provides it). */
export interface LiveDeps {
  ctx: AppCtx;
  applySim(s: SimSettings): void;
  applySpec(s: DroneSpec): void;
  /** respawn at the start, repaired (fullBattery: a fresh pack) */
  respawn(fullBattery: boolean): void;
  teleport(pos: V3, yawDeg: number): void;
  cliBatch(lines: string[]): Promise<string>;
  /** the simulator's own hardware lines for after an imported diff (simHardwareCli) */
  hardwareCli(keepOsdLayout: boolean, propsOut: boolean | null): Promise<string[]>;
  /** close the menu into flight / open the pause menu */
  fly(): void;
  pause(): void;
}

/** Only relays on this computer: a page link must not send the sim's controls anywhere else. */
export const LOCAL_WS = /^ws:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/[^\s]*)?$/;

export class ApiHost {
  /** RC channels (µs) an API client is flying with; null: the pilot's own controller flies */
  get rc(): Float32Array | null { return this.deps.ctx.rcOverride; }
  set rc(v: Float32Array | null) { this.deps.ctx.rcOverride = v; }
  private live: Promise<LiveBackend> | null = null;
  private loaded: LiveBackend | null = null;

  constructor(private deps: LiveDeps) {}

  /** The live backend (loads its chunk the first time). */
  backend(): Promise<LiveBackend> {
    this.live ??= import('./liveApi').then((m) => (this.loaded = new m.LiveBackend(this, this.deps)), (e) => { this.live = null; throw e; });
    return this.live;
  }

  // events from the app (only forwarded once the backend is in use)
  onGate(gate: number, t: number) { this.loaded?.onGate(gate, t); }
  onTelemetry(tel: Telemetry) { this.loaded?.onTelemetry(tel); }
  onLog(text: string) { this.loaded?.onLog(text); }
  /** the pilot respawned / changed map: an API episode in progress starts over */
  onRespawn() { this.loaded?.onRespawn(); }
  /** the live task in progress (training drills), if the backend is loaded */
  taskStatus() { return this.loaded?.taskStatus() ?? null; }

  /** window.fpvSim: the API inside the page (devtools, userscripts, Playwright). */
  installWindowApi() {
    const call = async (cmd: string, params: Record<string, unknown> = {}) => (await this.backend()).call(cmd, params);
    const api = {
      call,
      hello: () => call('hello'),
      reset: (scenario?: unknown, seed?: number) => call('reset', { scenario, seed }),
      act: (action: Record<string, unknown>) => call('act', { action }),
      release: () => call('release'),
      state: () => call('state'),
      cli: (lines: string[] | string) => call('cli', { lines: typeof lines === 'string' ? lines.split('\n') : lines }),
      respawn: (fullBattery = false) => call('respawn', { fullBattery }),
      teleport: (pos: [number, number, number], yawDeg = 0) => call('teleport', { pos, yawDeg }),
      metrics: () => call('metrics'),
      capture: (opts: Record<string, unknown> = {}) => call('capture', opts),
      record: (action: 'start' | 'stop', opts: Record<string, unknown> = {}) => call('record', { action, ...opts }),
      /** listen to events ('state' needs subscribe(hz) first); returns an unsubscribe function */
      on: async (event: string, cb: (e: unknown) => void) => (await this.backend()).listen(event, cb),
      subscribe: (hz = 60) => call('subscribe', { stream: 'state', hz }),
      unsubscribe: () => call('unsubscribe', { stream: 'state' }),
      /** connect to a local relay (npm run api -- --live) */
      connect: async (url = 'ws://127.0.0.1:8765') => (await this.backend()).connect(url),
      disconnect: async () => (await this.backend()).disconnect(),
    };
    (window as unknown as { fpvSim: typeof api }).fpvSim = api;
  }

  /** ?api=ws://127.0.0.1:8765 in the address: ask, then connect to that relay. */
  async connectFromUrl(search = location.search): Promise<void> {
    const url = new URLSearchParams(search).get('api');
    if (!url) return;
    if (!LOCAL_WS.test(url)) { this.deps.ctx.log(`Control API: ${url} is not on this computer (only ws://localhost and ws://127.0.0.1 relays can connect)`); return; }
    const { confirmDialog } = await import('../ui/dom');
    const ok = await confirmDialog({
      title: 'Let a program fly the simulator?',
      body: `A program on this computer (${url}) asks to control FPV Sim through its API: read the flight state, move the sticks, change the map, drone and Betaflight settings. You can take the controls back at any time.`,
      ok: 'Allow', cancel: 'Not now',
    });
    if (ok) await (await this.backend()).connect(url);
  }
}
