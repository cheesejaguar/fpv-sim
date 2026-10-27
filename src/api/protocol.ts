// The FPV Sim control API (protocol "fpvsim-api", version 1): one JSON message set for every way of
// driving the simulator from another program.
//   - headless, lock-step: the program steps the simulation (research, reinforcement learning);
//   - headless, real time: the simulation runs on the wall clock and the program sends sticks and
//     reads state as it goes (a game engine or a custom UI drawing the world);
//   - live: the browser game itself, with its rendering, sound and HUD (real-time gameplay, bots,
//     assisted flying, demos).
// Transports: newline-delimited JSON over TCP or stdio (scripts/fpv-api.mjs), JSON text frames over
// a WebSocket (the browser connects out to the relay), and window.fpvSim inside the page. The
// messages are the same everywhere; docs/API.md is the reference.
//
//   request   { "id": 7, "cmd": "state" }                -> { "id": 7, "ok": true, ... }
//                                                          | { "id": 7, "ok": false, "error": "..." }
//   event     { "event": "gate", ... }                    (no id; after "subscribe", or always for gates)
import type { Action, Observation, StepResult } from '../headless/env';
import type { TaskMetrics } from '../scenario/tasks';
import type { OpsConfig, OpsEvent } from '../worker/ops';
import type { FaultSpec } from '../sim/faults';
import { checkFaults } from '../sim/faults';

export const API_PROTOCOL = 'fpvsim-api';
export const API_VERSION = 1;
/** Largest message a peer may send (bytes): a scenario with a long diff all fits easily. */
export const API_MAX_MESSAGE = 1 << 20;

export type Backend = 'headless' | 'live';
export type Clock = 'lockstep' | 'realtime';

/** Every command, with its parameters. */
export interface Commands {
  /** who is there and what it can do */
  hello: { client?: string };
  /**
   * start an episode / apply a scenario (map, drone, conditions, firmware, start, task); live game
   * with pilot: the pilot flies it (the scenario's switches are not taken over)
   */
  reset: { scenario?: unknown; seed?: number; pilot?: boolean };
  /** lock-step only: apply the action and simulate `steps` control periods (default 1) */
  step: { action?: Action; steps?: number; vector?: boolean };
  /** set the sticks / switches from now on (real time); in the live game this takes over the pilot's controller */
  act: { action: Action };
  /** live game: hand the sticks back to the pilot's controller */
  release: Record<string, never>;
  /** the newest state */
  state: { vector?: boolean };
  /** stream events: "state" at hz (real time), "gate", "impact", "log", "episode" */
  subscribe: { stream: 'state'; hz?: number };
  unsubscribe: { stream: 'state' };
  /** Betaflight CLI lines (disarmed); returns the output */
  cli: { lines: string[] };
  /** back to the start, repaired (fullBattery: a fresh pack too) */
  respawn: { fullBattery?: boolean };
  /** put the quad at rest somewhere (ENU m, yaw in degrees counter-clockwise from east) */
  teleport: { pos: [number, number, number]; yawDeg?: number };
  /** real time: stop / restart the clock (live game: the pause menu) */
  pause: Record<string, never>;
  resume: Record<string, never>;
  /** the task's metrics so far */
  metrics: Record<string, never>;
  /** live game: grab the next camera frame with ground truth and labels (see docs/DATASET.md) */
  capture: { rgb?: boolean; received?: boolean; depth?: boolean; segmentation?: boolean; labels?: boolean };
  /** live game: record frames + ground truth + labels at hz (sim time), one "frame" event per frame; stop says how many */
  record: { action: 'start' | 'stop'; hz?: number; rgb?: boolean; received?: boolean; depth?: boolean; segmentation?: boolean; maxFrames?: number };
  /** inject faults now (each `at` counts from now; docs/OPERATIONS.md) */
  fault: { faults: FaultSpec[] };
  /** release the payload */
  drop: Record<string, never>;
  /** replace the operational environment (links, jammers, spoofers, faults, payload); null removes it */
  ops: { config?: OpsConfig | null };
  /** headless: a planning map of the RC link margin and GNSS satellites over a square around a point, with the current emitters */
  linkmap: { centre?: [number, number]; halfM?: number; n?: number; heightM?: number };
  bye: Record<string, never>;
}

export type Command = keyof Commands;
/** A request: the command and its parameters, discriminated by `cmd`. */
export type Request = { [C in Command]: { id?: number | string; cmd: C } & Commands[C] }[Command];

export interface Hello {
  protocol: typeof API_PROTOCOL; version: typeof API_VERSION;
  backend: Backend; clock: Clock;
  app: string; firmware: string;
  commands: Command[];
  /** the obsVector layout (labels in order) for the current episode */
  vectorLabels?: string[];
}

export interface StateReply { obs: Observation; vec?: number[]; metrics?: TaskMetrics }
export type StepReply = StepResult & { vec?: number[] };

export type ApiEvent =
  | { event: 'state'; obs: Observation }
  | { event: 'gate'; gate: number; t: number }
  | { event: 'impact'; speed: number; t: number }
  | { event: 'log'; text: string; t?: number }
  | { event: 'episode'; reason: string; metrics: TaskMetrics }
  /** a detector of the map's actors began (on) or stopped holding a detection of the quad */
  | { event: 'detect'; detector: string; on: boolean; t: number }
  /** live game: who flies the quad now */
  | { event: 'control'; by: 'api' | 'pilot' }
  /** live game, recording: one recorded frame (labels; PNGs as base64) */
  | { event: 'frame'; labels: unknown; classes: readonly string[]; rgb?: string; received?: string; depth?: string; segmentation?: string; instance?: string }
  /** the operational layer: a fault on / off, the payload released / landed, the fibre broke, the GNSS state changed */
  | ({ event: 'ops' } & OpsEvent)
  | { event: 'bye'; reason?: string };

export const COMMANDS: readonly Command[] = ['hello', 'reset', 'step', 'act', 'release', 'state', 'subscribe', 'unsubscribe', 'cli', 'respawn', 'teleport', 'pause', 'resume', 'metrics', 'capture', 'record', 'fault', 'drop', 'ops', 'linkmap', 'bye'];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x);

/** An action's problems (empty: fine). */
export function checkAction(a: unknown): string[] {
  if (!isObj(a)) return ['action: expected an object'];
  const out: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (['roll', 'pitch', 'yaw', 'throttle'].includes(k)) { if (!finite(v)) out.push(`action.${k}: expected a number`); }
    else if (k === 'rc') { if (!(Array.isArray(v) && v.length <= 16 && v.every(finite))) out.push('action.rc: up to 16 channel values (µs)'); }
    else if (['arm', 'turtle', 'beeper'].includes(k)) { if (typeof v !== 'boolean') out.push(`action.${k}: expected true or false`); }
    else if (k === 'mode') { if (!['acro', 'horizon', 'angle'].includes(v as string)) out.push('action.mode: acro, horizon or angle'); }
    else out.push(`action.${k}: unknown key`);
  }
  return out;
}

/** Parse one incoming message: a request, or the reason it isn't one. */
export function parseRequest(text: string): { req: Request; error?: undefined } | { req?: undefined; error: string; id?: number | string } {
  if (text.length > API_MAX_MESSAGE) return { error: `message too large (over ${API_MAX_MESSAGE} bytes)` };
  let m: unknown;
  try { m = JSON.parse(text); } catch { return { error: 'not JSON' }; }
  if (!isObj(m)) return { error: 'expected a JSON object' };
  const id = typeof m.id === 'number' || typeof m.id === 'string' ? m.id : undefined;
  if (typeof m.cmd !== 'string' || !COMMANDS.includes(m.cmd as Command)) return { error: `unknown command ${JSON.stringify(m.cmd)} (${COMMANDS.join(', ')})`, id };
  const bad = (e: string) => ({ error: e, id });
  switch (m.cmd as Command) {
    case 'step': {
      if (m.action !== undefined) { const e = checkAction(m.action); if (e.length) return bad(e.join('; ')); }
      if (m.steps !== undefined && !(Number.isInteger(m.steps) && (m.steps as number) >= 1 && (m.steps as number) <= 100000)) return bad('steps: 1 .. 100000');
      break;
    }
    case 'act': { const e = checkAction(m.action); if (e.length) return bad(e.join('; ')); break; }
    case 'subscribe': case 'unsubscribe':
      if (m.stream !== 'state') return bad('stream: "state"');
      if (m.hz !== undefined && !(finite(m.hz) && (m.hz as number) > 0 && (m.hz as number) <= 1000)) return bad('hz: 0 .. 1000');
      break;
    case 'cli': if (!(Array.isArray(m.lines) && m.lines.length <= 2000 && m.lines.every((l) => typeof l === 'string' && l.length < 400))) return bad('lines: a list of CLI lines'); break;
    case 'teleport':
      if (!(Array.isArray(m.pos) && m.pos.length === 3 && m.pos.every(finite))) return bad('pos: [x, y, z]');
      if (m.yawDeg !== undefined && !finite(m.yawDeg)) return bad('yawDeg: a number');
      break;
    case 'reset': if (m.seed !== undefined && !(Number.isInteger(m.seed) && (m.seed as number) >= 0 && (m.seed as number) < 2 ** 32)) return bad('seed: an integer 0 .. 2^32-1'); break;
    case 'record':
      if (m.action !== 'start' && m.action !== 'stop') return bad('action: "start" or "stop"');
      if (m.hz !== undefined && !(finite(m.hz) && (m.hz as number) > 0 && (m.hz as number) <= 60)) return bad('hz: 0 .. 60');
      if (m.maxFrames !== undefined && !(Number.isInteger(m.maxFrames) && (m.maxFrames as number) >= 1)) return bad('maxFrames: a positive integer');
      break;
    case 'fault': { const e = checkFaults(m.faults); if (e.length) return bad(e.join('; ')); break; }
    case 'ops': if (m.config !== undefined && m.config !== null && !isObj(m.config)) return bad('config: an ops configuration or null'); break;
    case 'linkmap':
      if (m.n !== undefined && !(Number.isInteger(m.n) && (m.n as number) >= 2 && (m.n as number) <= 101)) return bad('n: 2 .. 101');
      if (m.halfM !== undefined && !(finite(m.halfM) && (m.halfM as number) > 0)) return bad('halfM: metres > 0');
      break;
  }
  return { req: m as unknown as Request };
}

/** What the backends implement: answer one request (throw an Error to fail it). */
export interface ApiBackend {
  handle(req: Request): Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * One peer's session: parses its messages, runs them one at a time through the backend, answers
 * with the request's id. `send` writes a message (a JSON string) to the peer.
 */
export class ApiSession {
  private queue: Promise<void> = Promise.resolve();
  constructor(private backend: ApiBackend, private send: (text: string) => void) {}

  /** A message (one JSON document) from the peer. */
  receive(text: string): Promise<void> {
    const p = parseRequest(text);
    if (p.error !== undefined) { this.reply({ id: p.id, ok: false, error: p.error }); return this.queue; }
    const req = p.req;
    this.queue = this.queue.then(async () => {
      try {
        const r = await this.backend.handle(req);
        this.reply({ id: req.id, ok: true, ...r });
      } catch (e) {
        this.reply({ id: req.id, ok: false, error: (e as Error)?.message ?? String(e) });
      }
    });
    return this.queue;
  }

  event(e: ApiEvent) { this.send(JSON.stringify(e)); }

  private reply(m: Record<string, unknown>) {
    if (m.id === undefined) delete m.id;
    this.send(JSON.stringify(m));
  }
}
